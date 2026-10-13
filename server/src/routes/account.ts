import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { anonymousActor, userActor } from '../audit/recorder';
import {
  deleteAccountTokens,
  issueAccountToken,
  PASSWORD_RESET_TTL_MINUTES,
  plausibleAccountToken,
  takeAccountToken,
} from '../auth/account-tokens';
import { hashPassword, newPasswordField } from '../auth/password';
import { mayResetPassword, RESET_ANSWER_FLOOR_MS, waitForFloor } from '../auth/password-reset';
import { deleteUserSessions } from '../auth/sessions';
import { LoginThrottle } from '../auth/throttle';
import { users } from '../db/schema';
import { ProblemError } from '../http/problem';
import { text } from '../http/schemas';
import {
  accountLink,
  accountMailState,
  queuePasswordChangedNotice,
  RESET_PATH,
} from '../mail/account';
import { mailDeps, queueMail } from '../mail/outbox';
import { renderPasswordResetMail } from '../mail/templates/account-password-reset';
import { instanceHost } from '../mail/templates/text';
import { readSignInSettings } from '../sso/sign-in-policy';

/** Mail E2: requests per minute and address; messages per login in 15 minutes. */
export const PASSWORD_RESET_REQUESTS_PER_MINUTE = 5;
const RESETS_PER_LOGIN = { max: 3, windowMs: 15 * 60_000 };

/**
 * queueMail skipped the message after the check (mail turned off, or the address is not one plain
 * address): the transaction rolls back, nothing stays.
 */
class MailTurnedOff extends Error {}

/** A link's secret in a JSON body: bounded here, its form checked without a query (A1). */
export const tokenField = z.string().max(1024);
const TOKEN_INVALID_TEXT = 'This link has expired or was already used. Ask for a new one.';
export const TOKEN_INVALID_DESCRIPTION =
  'TOKEN_INVALID: the link has expired, was already used, or its account can no longer set a password this way';

export function tokenInvalid(): ProblemError {
  return new ProblemError(400, 'TOKEN_INVALID', TOKEN_INVALID_TEXT);
}

/**
 * Mail E2: the public account routes. A reset link or an invitation never signs anyone in (A5);
 * their secrets come in JSON bodies only and are never logged.
 */
export const accountRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (app, { deps }) => {
  const perLogin = new LoginThrottle(RESETS_PER_LOGIN);
  const policyFacts = () => ({
    sso: deps.edition.isFeatureActive('sso'),
    forced: deps.config.forcePasswordSignIn,
  });

  app.post(
    '/auth/password-reset',
    {
      config: {
        public: true,
        rateLimit: { max: PASSWORD_RESET_REQUESTS_PER_MINUTE, timeWindow: 60_000 },
        openapi: { problems: [429] },
      },
      schema: {
        tags: ['auth'],
        summary:
          'Ask for a password reset link by username or email; always 202, whether or not an account matches',
        security: [],
        body: z.strictObject({ login: text(320) }),
        response: { 202: z.object({}) },
      },
    },
    async (request, reply) => {
      const started = Date.now();
      const login = request.body.login.trim();
      try {
        // A3: every check ends quietly; only a qualifying account gets a link.
        if (login !== '' && perLogin.hit(login.toLowerCase())) {
          const [user] = await deps.db
            .select()
            .from(users)
            .where(login.includes('@') ? eq(users.email, login) : eq(users.username, login));
          const mail = user ? await accountMailState(deps.db, deps.config) : null;
          const stored = await readSignInSettings(deps.db, request.log);
          const policy = { demoUser: deps.config.demoUser, stored, facts: policyFacts() };
          if (user && mail?.ready === true && mayResetPassword(user, policy)) {
            const address = user.email;
            const publicUrl = mail.publicUrl;
            await deps.db.transaction(async (tx) => {
              const { token } = await issueAccountToken(tx, {
                userId: user.id,
                kind: 'password_reset',
                createdBy: null,
                ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
              });
              const queued = await queueMail(tx, mailDeps(deps.config), {
                kind: 'account.password-reset',
                to: { address, userId: user.id },
                render: () =>
                  renderPasswordResetMail({
                    username: user.username,
                    host: instanceHost(deps.config.publicUrl),
                    url: accountLink(publicUrl, RESET_PATH, token),
                  }),
              });
              if (queued.status === 'skipped') throw new MailTurnedOff();
              // The requester is unknown: anonymous, never the name or address typed.
              await deps.audit.record(tx, anonymousActor(request, null), [
                {
                  action: 'auth.password_reset_requested',
                  target: { type: 'user', id: user.id, label: user.username },
                  details: {},
                },
              ]);
            });
          }
        }
      } catch (err) {
        // Still 202: the answer never tells anything. The logger's serializer keeps SQL and its
        // parameters out of the line (http/logger.ts); the token is in no error.
        if (!(err instanceof MailTurnedOff)) {
          request.log.error(
            { err, component: 'password-reset' },
            'a password reset request failed',
          );
        }
      }
      await waitForFloor(started, RESET_ANSWER_FLOOR_MS);
      return reply.code(202).send({});
    },
  );

  app.post(
    '/auth/password-reset/complete',
    {
      config: {
        public: true,
        rateLimit: { max: 10, timeWindow: 60_000 },
        openapi: { problems: [400, 429], problemDescriptions: { 400: TOKEN_INVALID_DESCRIPTION } },
      },
      schema: {
        tags: ['auth'],
        summary:
          'Set a new password with a reset link; ends the account’s sessions and does not sign in',
        security: [],
        body: z.strictObject({ token: tokenField, newPassword: newPasswordField }),
        response: { 200: z.object({ username: z.string() }) },
      },
    },
    async (request) => {
      const { token, newPassword } = request.body;
      if (!plausibleAccountToken(token)) throw tokenInvalid();
      // Hash first: a slow hash never holds the token's row or a pooled connection.
      const passwordHash = await hashPassword(newPassword);
      const stored = await readSignInSettings(deps.db, request.log);
      const policy = { demoUser: deps.config.demoUser, stored, facts: policyFacts() };
      const username = await deps.db.transaction(async (tx) => {
        const taken = await takeAccountToken(tx, token, 'password_reset');
        if (!taken) return null;
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, taken.userId))
          .for('update');
        // Re-checked now (A3): a refusal commits too, so the link is used up either way.
        if (!user || !mayResetPassword(user, policy)) return null;
        await tx
          .update(users)
          .set({ passwordHash, passwordChangeRequired: false })
          .where(eq(users.id, user.id));
        // A6: every session ends; personal tokens stay (an admin reset revokes them).
        await deleteUserSessions(tx, user.id);
        await deleteAccountTokens(tx, user.id, 'password_reset');
        await deps.audit.record(tx, userActor(request, user), [
          {
            action: 'auth.password_reset',
            target: { type: 'user', id: user.id, label: user.username },
            details: {},
          },
        ]);
        await queuePasswordChangedNotice(tx, mailDeps(deps.config), {
          user,
          variant: 'reset',
          ip: request.ip || null,
        });
        return user.username;
      });
      if (username === null) throw tokenInvalid();
      return { username };
    },
  );
};
