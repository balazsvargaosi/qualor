import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isStorableText } from '../audit/canonical';
import { SMTP_SECURITIES, type Config } from '../config';
import { decryptSecret, encryptionKey, encryptSecret } from '../crypto/secrets';
import type { Executor } from '../db/client';
import { LOCKS } from '../db/locks';
import { instanceSettings } from '../db/schema';
import { SURROGATE_MESSAGE } from '../http/schemas';
import { emailAddress, isHostName, isOneLine, ONE_LINE_MESSAGE } from './address';
import type { MailServer } from './transport';

export const MAIL_SETTINGS_KEY = 'mail';
/** E1 spec: the stored password's envelope decrypts only under this AAD. */
export const MAIL_PASSWORD_AAD = 'instance_settings.mail.password';
export const UNREADABLE_PASSWORD_TEXT = "The SMTP password can't be decrypted: enter it again";

const encrypted = z.object({
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

export interface StoredMailSettings {
  server: StoredMailServer | null;
  alerts: MailAlerts;
}

export const DEFAULT_MAIL_SETTINGS: StoredMailSettings = {
  server: null,
  alerts: { licenseExpiry: true, webhookFailures: true },
};

/*
 * Reading is lenient, part by part, so that a row written by another version (an extra key, a
 * missing switch, a tightened check) never turns into the defaults that the next write would store
 * over the real server: unknown keys are dropped, each alert switch defaults to on on its own, and
 * a server that does not parse reads as none but is kept as stored by writes that leave it alone.
 */
const serverOnRead = z.object(storedMailServerSchema.shape).nullable();
const alertsOnRead = z
  .object({
    licenseExpiry: z.boolean().catch(DEFAULT_MAIL_SETTINGS.alerts.licenseExpiry),
    webhookFailures: z.boolean().catch(DEFAULT_MAIL_SETTINGS.alerts.webhookFailures),
  })
  .catch({ ...DEFAULT_MAIL_SETTINGS.alerts });

interface StoredRow {
  settings: StoredMailSettings;
  /** The row's `server` exactly as stored when it is present but does not parse, else undefined. */
  unreadableServer: unknown;
}

async function readStoredRow(db: Executor): Promise<StoredRow> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, MAIL_SETTINGS_KEY));
  const value: Record<string, unknown> =
    typeof row?.value === 'object' && row.value !== null && !Array.isArray(row.value)
      ? (row.value as Record<string, unknown>)
      : {};
  const alerts = alertsOnRead.parse(value.alerts ?? {});
  const server = serverOnRead.safeParse(value.server ?? null);
  return server.success
    ? { settings: { server: server.data, alerts }, unreadableServer: undefined }
    : { settings: { server: null, alerts }, unreadableServer: value.server };
}

/**
 * The row, part by part: missing reads as the defaults (no server, both alerts on); a server that
 * does not parse reads as none (email off) and a missing or invalid alert switch as on.
 */
export async function readMailSettings(db: Executor): Promise<StoredMailSettings> {
  return (await readStoredRow(db)).settings;
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
  const { settings: before, unreadableServer } = await readStoredRow(tx);
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
  // A stored server that does not parse is never wiped as a side effect of an alerts-only write.
  const value =
    patch.server === undefined && unreadableServer !== undefined
      ? { server: unreadableServer, alerts }
      : after;
  await tx
    .insert(instanceSettings)
    .values({ key: MAIL_SETTINGS_KEY, value })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value, updatedAt: sql`now()` },
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
