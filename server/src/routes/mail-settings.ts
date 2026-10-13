import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import type { MailSettingsChangedField } from '../audit/catalogue';
import { actorOf } from '../audit/recorder';
import { requireInstanceAdmin } from '../auth/access';
import { SMTP_SECURITIES } from '../config';
import { uuidv7 } from '../db/ids';
import { MAIL_STATUSES, mailMessages, users, type MailMessageRow } from '../db/schema';
import { decodeKeyset, encodeKeyset } from '../http/keyset';
import { pageSchema } from '../http/pagination';
import { conflict, ProblemError } from '../http/problem';
import { iso, isoOrNull } from '../http/schemas';
import { IssueChangeLimiter } from '../issues/rate-limit';
import { emailAddress } from '../mail/address';
import {
  effectiveMail,
  mailLine,
  readMailSettings,
  storedMailServerSchema,
  UNREADABLE_PASSWORD_TEXT,
  writeMailSettings,
  type StoredMailSettings,
} from '../mail/settings';
import { renderTestMail } from '../mail/templates/test';
import { clipUtf8 } from '../mail/text';
import {
  ehloName,
  MailSendError,
  MAX_SMTP_TEXT_BYTES,
  sendMail,
  toMailSendError,
} from '../mail/transport';

/** E1 spec: at most this many test messages per admin and minute. */
const TESTS_PER_MINUTE = 10;

/** The stored server's own checks (mail/settings.ts), the password in clear and write-only. */
const serverBody = storedMailServerSchema.omit({ passwordEnc: true }).extend({
  password: mailLine(1_024).nullable().optional().meta({
    description: 'Write-only. A string sets the password, null removes it, absent keeps it',
  }),
});

const settingsBody = z.strictObject({
  server: serverBody.nullable().optional().meta({
    description:
      'Absent keeps the server; null removes it and its password. 409 while QUALOR_SMTP_URL is set',
  }),
  alerts: z
    .strictObject({
      licenseExpiry: z.boolean().optional(),
      webhookFailures: z.boolean().optional(),
    })
    .optional(),
});

const settingsDto = z.object({
  source: z.enum(['environment', 'settings']),
  server: z
    .object({
      host: z.string(),
      port: z.number().int(),
      security: z.enum(SMTP_SECURITIES),
      username: z.string().nullable(),
      /** A password is stored (never the password itself). */
      passwordSet: z.boolean(),
      /** False when the stored password no longer decrypts (QUALOR_SECRET_KEY changed). */
      passwordReadable: z.boolean(),
      fromName: z.string(),
      fromAddress: z.string(),
      replyTo: z.string().nullable(),
    })
    .nullable(),
  alerts: z.object({ licenseExpiry: z.boolean(), webhookFailures: z.boolean() }),
  /** QUALOR_PUBLIC_URL is set: messages carry links. */
  publicUrlSet: z.boolean(),
  /** The active instance administrators, and how many of them alerts cannot reach. */
  administrators: z.object({ total: z.number().int(), withoutEmail: z.number().int() }),
  /** The newest message that was sent or failed. */
  lastMessage: z.object({ status: z.enum(['sent', 'failed']), at: z.string() }).nullable(),
});
type SettingsDto = z.infer<typeof settingsDto>;

/** One plain address (no name, no list): nodemailer would read a list as several recipients. */
const testBody = z.strictObject({ to: emailAddress });
const testResult = z.object({ response: z.string(), ms: z.number().int() });

const messageSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  toAddress: z.string(),
  subject: z.string(),
  status: z.enum(MAIL_STATUSES),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  smtpResponse: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
});
const messagesQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

/**
 * The log's keyset (created_at DESC, id DESC, as mail_messages_log_idx): the last row's created_at
 * in whole microseconds since the epoch (exact, unlike a JS Date) and its id.
 */
const messagesCursor = z.strictObject({ t: z.string().regex(/^\d{1,17}$/), id: z.uuid() });
const createdMicros = sql<string>`(extract(epoch FROM ${mailMessages.createdAt}) * 1000000)::bigint::text`;

function messageDto(row: MailMessageRow): z.infer<typeof messageSchema> {
  return {
    id: row.id,
    kind: row.kind,
    toAddress: row.toAddress,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    smtpResponse: row.smtpResponse,
    createdAt: iso(row.createdAt),
    sentAt: isoOrNull(row.sentAt),
    nextAttemptAt: isoOrNull(row.nextAttemptAt),
  };
}

/** The names of the fields a write changed (never a value), for the audit event and the log. */
function changedFields(
  before: StoredMailSettings,
  after: StoredMailSettings,
  passwordSent: boolean,
): MailSettingsChangedField[] {
  const fields: MailSettingsChangedField[] = [];
  if (before.server === null || after.server === null) {
    if (before.server !== after.server) fields.push('server');
  } else {
    for (const k of [
      'host',
      'port',
      'security',
      'username',
      'fromName',
      'fromAddress',
      'replyTo',
    ] as const) {
      if (before.server[k] !== after.server[k]) fields.push(`server.${k}`);
    }
    if (passwordSent) fields.push('server.password');
  }
  for (const k of ['licenseExpiry', 'webhookFailures'] as const) {
    if (before.alerts[k] !== after.alerts[k]) fields.push(`alerts.${k}`);
  }
  return fields;
}

export const mailSettingsRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (
  app,
  { deps },
) => {
  const tests = new IssueChangeLimiter({ perMinute: TESTS_PER_MINUTE, burst: TESTS_PER_MINUTE });
  /** One test in flight per admin: a slow SMTP server must not pile up requests. */
  const testing = new Set<string>();

  const readDto = async (): Promise<SettingsDto> => {
    const stored = await readMailSettings(deps.db);
    const env = deps.config.smtp;
    let server: SettingsDto['server'] = null;
    if (env !== null) {
      server = {
        host: env.host,
        port: env.port,
        security: env.security,
        username: env.username,
        passwordSet: env.password !== null,
        passwordReadable: true,
        fromName: env.fromName,
        fromAddress: env.fromAddress,
        replyTo: env.replyTo,
      };
    } else if (stored.server !== null) {
      const { passwordEnc, ...rest } = stored.server;
      server = {
        ...rest,
        passwordSet: passwordEnc !== null,
        passwordReadable:
          passwordEnc === null ||
          (await effectiveMail(deps.db, deps.config, deps.config.secretKey)).passwordReadable,
      };
    }
    const [admins] = await deps.db
      .select({
        total: sql<number>`count(*)::int`,
        withoutEmail: sql<number>`(count(*) FILTER (WHERE ${users.email} IS NULL))::int`,
      })
      .from(users)
      .where(and(eq(users.isInstanceAdmin, true), eq(users.active, true)));
    const [last] = await deps.db
      .select({
        status: mailMessages.status,
        sentAt: mailMessages.sentAt,
        updatedAt: mailMessages.updatedAt,
      })
      .from(mailMessages)
      .where(inArray(mailMessages.status, ['sent', 'failed']))
      .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
      .limit(1);
    return {
      source: env !== null ? 'environment' : 'settings',
      server,
      alerts: stored.alerts,
      publicUrlSet: deps.config.publicUrl !== null,
      administrators: { total: admins?.total ?? 0, withoutEmail: admins?.withoutEmail ?? 0 },
      lastMessage:
        last === undefined || last.status === 'pending'
          ? null
          : { status: last.status, at: iso(last.sentAt ?? last.updatedAt) },
    };
  };

  app.get(
    '/system/mail',
    {
      schema: {
        tags: ['mail'],
        summary: 'The email settings (instance admins); never the SMTP password',
        response: { 200: settingsDto },
      },
    },
    async (request) => {
      requireInstanceAdmin(request);
      return readDto();
    },
  );

  app.put(
    '/system/mail',
    {
      config: {
        openapi: {
          problems: [409],
          problemDescriptions: {
            409: 'MAIL_SET_BY_ENVIRONMENT: the SMTP server is set by QUALOR_SMTP_URL (only `alerts` may change)',
          },
        },
      },
      schema: {
        tags: ['mail'],
        summary:
          'Change the email settings (instance admins); the SMTP password is write-only: a string sets it, null removes it, absent keeps it',
        body: settingsBody,
        response: { 200: settingsDto },
      },
    },
    async (request) => {
      const principal = requireInstanceAdmin(request);
      const body = request.body;
      if (body.server !== undefined && deps.config.smtp !== null) {
        throw conflict('MAIL_SET_BY_ENVIRONMENT', 'The SMTP server is set by QUALOR_SMTP_URL');
      }
      const passwordSent = body.server?.password !== undefined;
      const changed = await deps.db.transaction(async (tx) => {
        const { before, after } = await writeMailSettings(
          tx,
          {
            ...(body.server === undefined ? {} : { server: body.server }),
            ...(body.alerts === undefined ? {} : { alerts: body.alerts }),
          },
          deps.config.secretKey,
        );
        const fields = changedFields(before, after, passwordSent);
        await deps.audit.record(tx, actorOf(request), [
          {
            action: 'mail.settings_updated',
            target: { type: 'mail_settings', id: 'mail' },
            details: { changed: fields },
          },
        ]);
        return fields;
      });
      request.log.info({ userId: principal.user.id, fields: changed }, 'mail settings changed');
      return readDto();
    },
  );

  app.post(
    '/system/mail/test',
    {
      config: {
        openapi: {
          problems: [409, 429, 502],
          problemDescriptions: {
            409: 'MAIL_NOT_CONFIGURED: no SMTP server is configured',
            429: 'More than 10 tests a minute by this user, or one of theirs still running (RATE_LIMITED); see Retry-After',
            502: 'MAIL_SEND_FAILED: the SMTP server refused the message or could not be reached; `detail` is its reply or the reason, `reason` one of connection, auth, rejected, timeout, config',
          },
        },
      },
      schema: {
        tags: ['mail'],
        summary:
          'Send a test message at once through the effective SMTP server (instance admins); logged as a sent or failed message without its body',
        body: testBody,
        response: { 200: testResult },
      },
    },
    async (request) => {
      const principal = requireInstanceAdmin(request);
      const user = principal.user;
      if (testing.has(user.id)) {
        throw new ProblemError(429, 'RATE_LIMITED', 'A test message is already being sent', {
          headers: { 'retry-after': '5' },
        });
      }
      const wait = tests.take(user.id, 1);
      if (wait !== null) {
        throw new ProblemError(429, 'RATE_LIMITED', `Too many tests; retry in ${wait} s`, {
          headers: { 'retry-after': String(wait) },
        });
      }
      testing.add(user.id);
      try {
        const to = request.body.to;
        const mail = await effectiveMail(deps.db, deps.config, deps.config.secretKey);
        if (mail.server === null) throw conflict('MAIL_NOT_CONFIGURED', 'Email is not configured');
        const rendered = renderTestMail({
          server: mail.server,
          sentBy: user.displayName ?? user.username,
          at: new Date(),
          publicUrl: deps.config.publicUrl,
        });
        let sent: { response: string; ms: number } | null = null;
        let failure: MailSendError | null = null;
        if (!mail.passwordReadable) {
          failure = new MailSendError('config', UNREADABLE_PASSWORD_TEXT, { transient: false });
        } else {
          try {
            sent = await sendMail(
              mail.server,
              { to, ...rendered },
              { ehloName: ehloName(deps.config.publicUrl) },
            );
          } catch (err) {
            failure = toMailSendError(err);
          }
        }
        // E1 spec: the test is logged as sent or failed, never with its body (no payload).
        const id = uuidv7();
        await deps.db.transaction(async (tx) => {
          await tx.insert(mailMessages).values({
            id,
            kind: 'test',
            toAddress: to,
            subject: rendered.subject,
            status: sent ? 'sent' : 'failed',
            attempts: 1,
            smtpResponse: sent?.response ?? null,
            lastError: failure ? clipUtf8(failure.message, MAX_SMTP_TEXT_BYTES) : null,
            sentAt: sent ? sql`now()` : null,
          });
          await deps.audit.record(tx, actorOf(request), [
            {
              action: 'mail.test_sent',
              outcome: sent ? 'success' : 'failure',
              target: { type: 'mail_settings', id: 'mail' },
              details: { messageId: id, delivered: sent !== null },
            },
          ]);
        });
        request.log.info(
          { messageId: id, delivered: sent !== null, smtpCode: failure?.smtpCode ?? null },
          'mail test message',
        );
        if (sent) return sent;
        throw new ProblemError(502, 'MAIL_SEND_FAILED', 'The test message was not sent', {
          detail: failure?.message ?? 'Sending failed',
          extensions: { reason: failure?.code ?? 'connection' },
        });
      } finally {
        testing.delete(user.id);
      }
    },
  );

  app.get(
    '/system/mail/messages',
    {
      schema: {
        tags: ['mail'],
        summary:
          'Recent email messages, newest first (instance admins; kept 30 days); never a body',
        querystring: messagesQuery,
        response: { 200: pageSchema(messageSchema) },
      },
    },
    async (request) => {
      requireInstanceAdmin(request);
      const { limit } = request.query;
      const after = decodeKeyset(request.query.cursor, messagesCursor);
      const rows = await deps.db
        .select({ row: mailMessages, t: createdMicros })
        .from(mailMessages)
        .where(
          after
            ? sql`(${mailMessages.createdAt}, ${mailMessages.id}) < (timestamptz 'epoch' + ${after.t}::bigint * interval '1 microsecond', ${after.id}::uuid)`
            : undefined,
        )
        .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((r) => messageDto(r.row)),
        nextCursor:
          rows.length > limit && last ? encodeKeyset({ t: last.t, id: last.row.id }) : null,
      };
    },
  );
};
