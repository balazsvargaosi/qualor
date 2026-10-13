import { sql } from 'drizzle-orm';
import type { Config, SmtpConfig } from '../src/config';
import { decryptSecret, encryptionKey } from '../src/crypto/secrets';
import type { EncryptedValue } from '../src/db/schema';
import { mailPayloadAad } from '../src/mail/outbox';
import { mailPayloadSchema } from '../src/mail/payload';
import type { TestContext } from './app';
import { testSmtp } from './mail';
import { SSO_PUBLIC_URL, ssoContext } from './sso';

export const ACCOUNT_PUBLIC_URL = SSO_PUBLIC_URL;

/**
 * E1's test SMTP config pointed at port 9, where nothing listens: queueMail only needs mail to be
 * configured, and no test of this kind delivers (Task 7 uses E1's startFakeSmtp instead).
 */
export const UNDELIVERED_SMTP: SmtpConfig = testSmtp(9);

/**
 * A server with mail and QUALOR_PUBLIC_URL (self-service on), the `guest` demo user name, and the
 * licensed features `sso` (so the break-glass policy can apply) and `audit-log` (so events are kept).
 */
export function accountContext(config: Partial<Config> = {}): Promise<TestContext> {
  return ssoContext({
    config: { smtp: UNDELIVERED_SMTP, publicUrl: ACCOUNT_PUBLIC_URL, demoUser: 'guest', ...config },
  });
}

export interface QueuedMail {
  id: string;
  subject: string;
  status: string;
  /** The decrypted body while the message is pending (E1 nulls it after delivery). */
  html: string | null;
  text: string | null;
}

/** The messages to `address` (of `kind`), oldest first, bodies decrypted with the server's key. */
export async function mailsTo(
  ctx: TestContext,
  address: string,
  kind?: string,
): Promise<QueuedMail[]> {
  const result = await ctx.db.execute<{
    id: string;
    subject: string;
    status: string;
    payload_enc: EncryptedValue | null;
  }>(sql`
    SELECT id, subject, status, payload_enc FROM mail_messages
     WHERE to_address = ${address} ${kind === undefined ? sql`` : sql`AND kind = ${kind}`}
     ORDER BY id`);
  const key = encryptionKey(ctx.config.secretKey);
  return result.rows.map((row) => {
    const plain = row.payload_enc
      ? decryptSecret(key, row.payload_enc, mailPayloadAad(row.id))
      : null;
    const body = plain === null ? null : mailPayloadSchema.parse(JSON.parse(plain));
    return {
      id: row.id,
      subject: row.subject,
      status: row.status,
      html: body?.html ?? null,
      text: body?.text ?? null,
    };
  });
}

/** The raw secret of the message's link to `path`. */
export function linkToken(html: string | null, path: '/reset-password' | '/accept-invite'): string {
  const match = new RegExp(`${path}#token=([0-9A-Za-z]{43})`).exec(html ?? '');
  if (!match?.[1]) throw new Error(`no ${path} link in the message`);
  return match[1];
}

export async function countRows(
  ctx: TestContext,
  table: 'mail_messages' | 'account_tokens',
): Promise<number> {
  const result = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
  );
  return result.rows[0]?.n ?? 0;
}
