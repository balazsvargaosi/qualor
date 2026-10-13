import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { decryptSecret, encryptionKey } from '../crypto/secrets';
import type { Db } from '../db/client';
import { mailMessages, type MailMessageRow } from '../db/schema';
import { enqueue } from '../queue/queue';
import type { JobHandlers } from '../queue/worker';
import { MAIL_JOB_MAX_ATTEMPTS, MAIL_QUEUE, mailPayloadAad, type MailDeps } from './outbox';
import { mailPayloadSchema, type MailPayload } from './payload';
import { effectiveMail, UNREADABLE_PASSWORD_TEXT } from './settings';
import { clipUtf8 } from './text';
import {
  ehloName,
  MailSendError,
  MAX_SMTP_TEXT_BYTES,
  sendMail,
  toMailSendError,
} from './transport';

/** E1 spec: the first attempt and up to 6 retries. */
export const MAIL_MAX_ATTEMPTS = 7;
/** Messages in flight at once; their own worker (main.ts), apart from analyses and webhooks. */
export const MAIL_WORKER_CONCURRENCY = 2;
/** An attempt takes well under a minute (10 s + 10 s + 30 s of silence at most). */
export const MAIL_LEASE_MS = 90_000;
export const NOT_CONFIGURED_TEXT = 'Email is not configured';
export const UNDECRYPTABLE_TEXT = "The message can't be decrypted";

/** 1 min after the first failed attempt, doubling to 32 min after the sixth (as webhooks). */
export function mailRetryDelaySeconds(failedAttempts: number): number {
  return 60 * 2 ** (failedAttempts - 1);
}

export interface MailDeliveryDeps extends MailDeps {
  db: Db;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn'> | undefined;
}

export type MailDeliveryResult = 'gone' | 'settled' | 'sent' | 'retrying' | 'failed';

type Outcome = { ok: true; response: string } | { ok: false; error: MailSendError };

function readPayload(row: MailMessageRow, secretKey: string): MailPayload | null {
  if (row.payloadEnc === null) return null;
  const plain = decryptSecret(encryptionKey(secretKey), row.payloadEnc, mailPayloadAad(row.id));
  if (plain === null) return null;
  try {
    const parsed = mailPayloadSchema.safeParse(JSON.parse(plain));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Records one attempt, fenced on `status = 'pending' AND attempts = previous` (a duplicate run of
 * the same attempt records nothing), and enqueues the retry in the same transaction. The body is
 * dropped once the message is sent or has failed for good (M5).
 */
async function recordAttempt(
  deps: MailDeliveryDeps,
  row: MailMessageRow,
  outcome: Outcome,
): Promise<MailDeliveryResult> {
  const attempts = row.attempts + 1;
  const retry = !outcome.ok && outcome.error.transient && attempts < MAIL_MAX_ATTEMPTS;
  const status = outcome.ok ? 'sent' : retry ? 'pending' : 'failed';
  const result: MailDeliveryResult = outcome.ok ? 'sent' : retry ? 'retrying' : 'failed';
  return deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(mailMessages)
      .set({
        status,
        attempts,
        smtpResponse: outcome.ok ? outcome.response : null,
        lastError: outcome.ok ? null : clipUtf8(outcome.error.message, MAX_SMTP_TEXT_BYTES),
        payloadEnc: retry ? row.payloadEnc : null,
        sentAt: outcome.ok ? sql`now()` : null,
        nextAttemptAt: retry
          ? sql`now() + make_interval(secs => ${mailRetryDelaySeconds(attempts)})`
          : null,
      })
      .where(
        and(
          eq(mailMessages.id, row.id),
          eq(mailMessages.status, 'pending'),
          eq(mailMessages.attempts, row.attempts),
        ),
      )
      .returning({ nextAttemptAt: mailMessages.nextAttemptAt });
    if (!updated) return 'settled';
    if (retry && updated.nextAttemptAt) {
      await enqueue(tx, {
        queue: MAIL_QUEUE,
        payload: { messageId: row.id, attempts },
        runAt: updated.nextAttemptAt,
        maxAttempts: MAIL_JOB_MAX_ATTEMPTS,
      });
    }
    // Never the address, the subject or the body above debug.
    deps.logger?.info(
      {
        messageId: row.id,
        kind: row.kind,
        attempts,
        status,
        smtpCode: outcome.ok ? null : outcome.error.smtpCode,
      },
      'mail delivery attempt',
    );
    return result;
  });
}

/**
 * E1 spec: one attempt of one message. A message that is gone, no longer pending, or whose attempt
 * is already recorded (`expectedAttempts` differs) is left alone. The configuration is read at send
 * time: no server, a password that no longer decrypts, or a body that no longer decrypts fails the
 * message at once. The SMTP conversation holds no transaction.
 */
export async function deliverMail(
  deps: MailDeliveryDeps,
  messageId: string,
  expectedAttempts: number,
): Promise<MailDeliveryResult> {
  const [row] = await deps.db.select().from(mailMessages).where(eq(mailMessages.id, messageId));
  if (!row) return 'gone';
  if (row.status !== 'pending' || row.attempts !== expectedAttempts) return 'settled';
  const refuse = (message: string) =>
    recordAttempt(deps, row, {
      ok: false,
      error: new MailSendError('config', message, { transient: false }),
    });
  const mail = await effectiveMail(deps.db, deps.config, deps.config.secretKey);
  if (mail.server === null) return refuse(NOT_CONFIGURED_TEXT);
  if (!mail.passwordReadable) return refuse(UNREADABLE_PASSWORD_TEXT);
  const payload = readPayload(row, deps.config.secretKey);
  if (payload === null) return refuse(UNDECRYPTABLE_TEXT);
  let outcome: Outcome;
  try {
    const sent = await sendMail(
      mail.server,
      {
        to: row.toAddress,
        subject: row.subject,
        html: payload.html,
        text: payload.text,
        ...(payload.headers ? { headers: payload.headers } : {}),
      },
      { ehloName: ehloName(deps.config.publicUrl), ...deps.send },
    );
    outcome = { ok: true, response: sent.response };
  } catch (err) {
    outcome = { ok: false, error: toMailSendError(err) };
  }
  return recordAttempt(deps, row, outcome);
}

const jobPayload = z.object({ messageId: z.uuid(), attempts: z.number().int().min(0) });

/** The `mail` queue's handler; its own worker runs it (main.ts). */
export function mailHandlers(deps: MailDeliveryDeps): JobHandlers {
  return {
    [MAIL_QUEUE]: async (job) => {
      const parsed = jobPayload.safeParse(job.payload);
      if (!parsed.success) {
        deps.logger?.warn(
          { jobId: job.id },
          'malformed mail job payload; completing without retry',
        );
        return;
      }
      await deliverMail(deps, parsed.data.messageId, parsed.data.attempts);
    },
  };
}
