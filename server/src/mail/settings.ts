import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { isStorableText } from '../audit/canonical';
import { SMTP_SECURITIES, type Config } from '../config';
import { decryptSecret, encryptionKey, encryptSecret } from '../crypto/secrets';
import type { Executor } from '../db/client';
import { LOCKS } from '../db/locks';
import { instanceSettings } from '../db/schema';
import { SURROGATE_MESSAGE } from '../http/schemas';
import { instanceSetting } from '../settings';
import { emailAddress, isHostName, isOneLine, ONE_LINE_MESSAGE } from './address';
import type { MailServer } from './transport';

export const MAIL_SETTINGS_KEY = 'mail';
/** E1 spec: the stored password's envelope decrypts only under this AAD. */
export const MAIL_PASSWORD_AAD = 'instance_settings.mail.password';
export const UNREADABLE_PASSWORD_TEXT = "The SMTP password can't be decrypted: enter it again";

const encrypted = z.strictObject({
  v: z.literal(1),
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
});

/**
 * A non-empty single-line string of at most `max` characters (it ends up in a mail header), that
 * the jsonb row can store (no lone surrogate).
 */
export const mailLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(isOneLine, ONE_LINE_MESSAGE)
    .refine((s) => !isOneLine(s) || isStorableText(s), SURROGATE_MESSAGE);

export const storedMailServerSchema = z.strictObject({
  host: z.string().min(1).max(253).refine(isHostName, 'A host name or an IP address'),
  port: z.number().int().min(1).max(65_535),
  security: z.enum(SMTP_SECURITIES),
  username: mailLine(256).nullable(),
  passwordEnc: encrypted.nullable(),
  fromName: mailLine(100),
  fromAddress: emailAddress,
  replyTo: emailAddress.nullable(),
});
export type StoredMailServer = z.infer<typeof storedMailServerSchema>;

export const mailAlertsSchema = z.strictObject({
  licenseExpiry: z.boolean(),
  webhookFailures: z.boolean(),
});
export type MailAlerts = z.infer<typeof mailAlertsSchema>;

export const storedMailSettingsSchema = z.strictObject({
  server: storedMailServerSchema.nullable(),
  alerts: mailAlertsSchema,
});
export type StoredMailSettings = z.infer<typeof storedMailSettingsSchema>;

export const DEFAULT_MAIL_SETTINGS: StoredMailSettings = {
  server: null,
  alerts: { licenseExpiry: true, webhookFailures: true },
};

/** A row that is missing or does not parse reads as the defaults (no server, both alerts on). */
export function readMailSettings(db: Executor): Promise<StoredMailSettings> {
  return instanceSetting(db, MAIL_SETTINGS_KEY, storedMailSettingsSchema, DEFAULT_MAIL_SETTINGS);
}

/** The server part of a write: `password` a string sets it, null removes it, absent keeps it. */
export interface MailServerInput {
  host: string;
  port: number;
  security: StoredMailServer['security'];
  username: string | null;
  password?: string | null;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
}

export interface MailSettingsPatch {
  /** Absent: kept; null: removed with its password. */
  server?: MailServerInput | null;
  alerts?: Partial<MailAlerts>;
}

/**
 * Applies `patch` to the row under LOCKS.mailSettings (one writer at a time) and returns the row
 * before and after, for the audit's field names. The caller validated the patch (routes/mail-settings.ts).
 */
export async function writeMailSettings(
  tx: Executor,
  patch: MailSettingsPatch,
  secretKey: string,
): Promise<{ before: StoredMailSettings; after: StoredMailSettings }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCKS.mailSettings})`);
  const before = await readMailSettings(tx);
  let server = before.server;
  if (patch.server === null) {
    server = null;
  } else if (patch.server !== undefined) {
    const { password, ...rest } = patch.server;
    const passwordEnc =
      password === undefined
        ? (before.server?.passwordEnc ?? null)
        : password === null
          ? null
          : encryptSecret(encryptionKey(secretKey), password, MAIL_PASSWORD_AAD);
    server = { ...rest, host: rest.host.toLowerCase(), passwordEnc };
  }
  const alerts: MailAlerts = { ...before.alerts };
  if (patch.alerts?.licenseExpiry !== undefined) alerts.licenseExpiry = patch.alerts.licenseExpiry;
  if (patch.alerts?.webhookFailures !== undefined) {
    alerts.webhookFailures = patch.alerts.webhookFailures;
  }
  const after: StoredMailSettings = { server, alerts };
  await tx
    .insert(instanceSettings)
    .values({ key: MAIL_SETTINGS_KEY, value: after })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: after, updatedAt: sql`now()` },
    });
  return { before, after };
}

export interface EffectiveMail {
  /** Where `server` comes from: QUALOR_SMTP_URL wins over the settings row. */
  source: 'environment' | 'settings';
  /** The server messages go through, its password in clear; null: email is off. */
  server: MailServer | null;
  /** False when the stored password no longer decrypts: sending fails with UNREADABLE_PASSWORD_TEXT. */
  passwordReadable: boolean;
  /** Always from the settings row. */
  alerts: MailAlerts;
}

/** E1 spec: the server to send through right now, and the alert switches. */
export async function effectiveMail(
  db: Executor,
  config: Pick<Config, 'smtp'>,
  secretKey: string,
): Promise<EffectiveMail> {
  const stored = await readMailSettings(db);
  if (config.smtp !== null) {
    return {
      source: 'environment',
      server: { ...config.smtp },
      passwordReadable: true,
      alerts: stored.alerts,
    };
  }
  if (stored.server === null) {
    return { source: 'settings', server: null, passwordReadable: true, alerts: stored.alerts };
  }
  const { passwordEnc, ...rest } = stored.server;
  const password =
    passwordEnc === null
      ? null
      : decryptSecret(encryptionKey(secretKey), passwordEnc, MAIL_PASSWORD_AAD);
  return {
    source: 'settings',
    server: { ...rest, password },
    passwordReadable: passwordEnc === null || password !== null,
    alerts: stored.alerts,
  };
}

/** Whether a server is configured (environment or row), without decrypting anything. */
export async function mailConfigured(db: Executor, config: Pick<Config, 'smtp'>): Promise<boolean> {
  return config.smtp !== null || (await readMailSettings(db)).server !== null;
}
