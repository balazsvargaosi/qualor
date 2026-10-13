import { asc, eq } from 'drizzle-orm';
import type { Config } from '../src/config';
import { decryptSecret, encryptionKey } from '../src/crypto/secrets';
import type { Executor } from '../src/db/client';
import { mailMessages, projectWatches, type EncryptedValue } from '../src/db/schema';
import { mailPayloadAad } from '../src/mail/outbox';
import { mailPayloadSchema, type MailPayload } from '../src/mail/payload';
import { UNDELIVERED_SMTP } from './account-mail';

export const PUBLIC_URL = 'https://qualor.example.com';

/**
 * Mail on through the environment (E1: `Config.smtp` wins over the settings row; E2's SMTP config
 * nothing listens on), with a public URL for links. Nothing is sent: no test here runs the mail
 * worker, so messages stay pending.
 */
export const MAIL_ON: Partial<Config> = {
  publicUrl: PUBLIC_URL,
  smtp: UNDELIVERED_SMTP,
};

export type OutboxRow = typeof mailMessages.$inferSelect;

/** The outbox, by recipient address then age; one kind only when given. */
export function queued(db: Executor, kind?: string): Promise<OutboxRow[]> {
  return db
    .select()
    .from(mailMessages)
    .where(kind === undefined ? undefined : eq(mailMessages.kind, kind))
    .orderBy(asc(mailMessages.toAddress), asc(mailMessages.id));
}

/** A pending message's rendered body and headers (E1: encrypted until it is sent). */
export function payloadOf(row: OutboxRow, secretKey: string): MailPayload {
  const plain =
    row.payloadEnc === null
      ? null
      : decryptSecret(
          encryptionKey(secretKey),
          row.payloadEnc as EncryptedValue,
          mailPayloadAad(row.id),
        );
  if (plain === null) throw new Error(`message ${row.id} has no readable payload`);
  return mailPayloadSchema.parse(JSON.parse(plain));
}

export async function watch(
  db: Executor,
  userId: string,
  projectId: string,
  values: Partial<typeof projectWatches.$inferInsert> = {},
): Promise<void> {
  await db.insert(projectWatches).values({ userId, projectId, ...values });
}
