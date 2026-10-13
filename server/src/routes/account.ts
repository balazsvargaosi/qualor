import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { anonymousActor } from '../audit/recorder';
import { issueAccountToken, PASSWORD_RESET_TTL_MINUTES } from '../auth/account-tokens';
import { mayResetPassword, RESET_ANSWER_FLOOR_MS, waitForFloor } from '../auth/password-reset';
import { LoginThrottle } from '../auth/throttle';
import { users } from '../db/schema';
import { text } from '../http/schemas';
import { accountLink, accountMailState, RESET_PATH } from '../mail/account';
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
};
