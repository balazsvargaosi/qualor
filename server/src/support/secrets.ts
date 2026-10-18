import { readFile, stat } from 'node:fs/promises';
import { AUDIT_STREAM_SECRET_AAD } from '../audit/settings';
import type { Config } from '../config';
import { decryptSecret, encryptionKey } from '../crypto/secrets';
import type { Executor } from '../db/client';
import {
  instanceSettings,
  scmConnections,
  ssoConnections,
  webhookSubscriptions,
} from '../db/schema';
import { decodeLicenseText, LICENSE_SETTING_KEY, MAX_LICENSE_FILE_BYTES } from '../license/source';
import { normaliseKey } from '../license/token';
import { LLM_API_KEY_AAD } from '../llm/settings';
import { MAIL_PASSWORD_AAD } from '../mail/settings';
import { SCM_TOKEN_AAD } from '../scm/connections';
import { WEBHOOK_SECRET_AAD as SCM_WEBHOOK_SECRET_AAD } from '../scm/github/credentials';
import { SECRET_AAD as SSO_SECRET_AAD, SP_KEY_AAD } from '../sso/connection-config';
import { WEBHOOK_SECRET_AAD, WEBHOOK_URL_AAD } from '../webhooks/deliveries';

export const REDACTED = '[redacted]';
/**
 * Shorter values are not searched for: replacing every occurrence of two or three characters
 * would destroy the text, and such a value is no credential worth the name.
 */
export const MIN_SECRET_LENGTH = 4;
/** 4E-3b §1: error texts in the bundle are cut to this many characters. */
export const MAX_ERROR_TEXT = 500;

/** A PEM's base64 lines (each a long run of the key) and their concatenation, besides the PEM. */
function pemParts(text: string): string[] {
  if (!text.includes('-----BEGIN')) return [];
  const body = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('-----'));
  return [...body.filter((line) => line.length >= 16), body.join('')];
}

/** A licence key as written and whitespace-free, with its payload and signature segments. */
function licenseParts(text: string): string[] {
  const key = normaliseKey(text);
  return [text.trim(), key, ...key.split('.').filter((segment) => segment.length >= 16)];
}

async function licenseFileText(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_LICENSE_FILE_BYTES) return null;
    return decodeLicenseText(await readFile(file), 'QUALOR_LICENSE_FILE');
  } catch {
    return null;
  }
}

/** The AADs of the envelopes `instance_settings` rows hold (data-model.md §2). */
const SETTINGS_AADS = [LLM_API_KEY_AAD, AUDIT_STREAM_SECRET_AAD, MAIL_PASSWORD_AAD] as const;

/** Every `{ v, iv, ct, tag }` object in a JSON value, at any depth. */
function envelopes(value: unknown, depth = 0): unknown[] {
  if (typeof value !== 'object' || value === null || depth > 16) return [];
  if (Array.isArray(value)) return value.flatMap((item) => envelopes(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.v === 1 && typeof record.ct === 'string' && typeof record.iv === 'string') {
    return [value];
  }
  return Object.values(record).flatMap((item) => envelopes(item, depth + 1));
}

function databasePassword(url: string | null): string[] {
  if (url === null) return [];
  try {
    const parsed = new URL(url);
    if (parsed.password === '') return [];
    return [parsed.password, decodeURIComponent(parsed.password)];
  } catch {
    return [];
  }
}

/** The secret values of the configuration itself, the licence file's key included. */
async function configSecrets(config: Config): Promise<string[]> {
  const found: string[] = [config.secretKey, ...databasePassword(config.databaseUrl)];
  if (config.bootstrapAdmin.password !== undefined) found.push(config.bootstrapAdmin.password);
  // E1: QUALOR_SMTP_URL's password; the one saved in Settings → Email is a settings envelope.
  if (config.smtp?.password) found.push(config.smtp.password);
  if (config.license.text !== null) found.push(...licenseParts(config.license.text));
  if (config.license.file !== null) {
    const text = await licenseFileText(config.license.file);
    if (text !== null) found.push(...licenseParts(text));
  }
  return found;
}

/** An envelope's plain text and its PEM parts; nothing when it is absent or does not decrypt. */
function opened(key: Buffer, value: unknown, aad: string): string[] {
  if (value === null || value === undefined) return [];
  const plain = decryptSecret(key, value as never, aad);
  return plain === null ? [] : [plain, ...pemParts(plain)];
}

/** The licence key of an `instance_settings` row and every envelope in it that decrypts. */
function settingsRowSecrets(key: Buffer, row: { key: string; value: unknown }): string[] {
  const found: string[] = [];
  if (row.key === LICENSE_SETTING_KEY) {
    const text = (row.value as { key?: unknown } | null)?.key;
    if (typeof text === 'string') found.push(...licenseParts(text));
  }
  for (const envelope of envelopes(row.value)) {
    for (const aad of SETTINGS_AADS) found.push(...opened(key, envelope, aad));
  }
  return found;
}

/**
 * 4E-3b §2: every secret value this server is configured with, decrypted where it is stored
 * encrypted, so the bundle can search its texts for them. Held in memory for one bundle only.
 * Covers QUALOR_SECRET_KEY, the database password, the bootstrap password, the licence key text
 * (variable, file or upload), the LLM API key, the audit stream secret, webhook secrets and chat
 * webhook URLs, SSO
 * client secrets and SP keys, SCM tokens, GitHub App private keys and webhook secrets, and the
 * SMTP password of QUALOR_SMTP_URL and of Settings → Email.
 */
export async function configuredSecrets(db: Executor, config: Config): Promise<string[]> {
  const key = encryptionKey(config.secretKey);
  const found = await configSecrets(config);
  const decrypt = (value: unknown, aad: string): void => {
    found.push(...opened(key, value, aad));
  };
  // The rows as stored, not as their readers parse them: a row an operator edited out of shape
  // still holds its secrets. Every envelope in them is tried under the settings' AADs.
  for (const row of await db
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings)) {
    found.push(...settingsRowSecrets(key, row));
  }

  for (const row of await db
    .select({ secretEnc: webhookSubscriptions.secretEnc, urlEnc: webhookSubscriptions.urlEnc })
    .from(webhookSubscriptions)) {
    decrypt(row.secretEnc, WEBHOOK_SECRET_AAD);
    // 6G: a Slack or Teams URL is itself the secret.
    decrypt(row.urlEnc, WEBHOOK_URL_AAD);
  }
  for (const row of await db
    .select({ secretEnc: ssoConnections.secretEnc, spKeyEnc: ssoConnections.spKeyEnc })
    .from(ssoConnections)) {
    decrypt(row.secretEnc, SSO_SECRET_AAD);
    decrypt(row.spKeyEnc, SP_KEY_AAD);
  }
  for (const row of await db
    .select({
      tokenEnc: scmConnections.tokenEnc,
      webhookSecretEnc: scmConnections.webhookSecretEnc,
    })
    .from(scmConnections)) {
    decrypt(row.tokenEnc, SCM_TOKEN_AAD);
    decrypt(row.webhookSecretEnc, SCM_WEBHOOK_SECRET_AAD);
  }
  return [...new Set(found)].filter((value) => value.length >= MIN_SECRET_LENGTH);
}

/** The spellings a value may take in a text: as it is, JSON-escaped, URL-encoded and base64. */
function spellings(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
  ];
}

/**
 * A function that replaces every spelling of every value in `secrets` with `[redacted]`, the
 * longest first, so a value inside a longer one never leaves the rest behind.
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const needles = [
    ...new Set(
      secrets
        .filter((s) => s.length >= MIN_SECRET_LENGTH)
        .flatMap(spellings)
        .filter((s) => s.length >= MIN_SECRET_LENGTH),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const needle of needles) if (out.includes(needle)) out = out.split(needle).join(REDACTED);
    return out;
  };
}

/** 4E-3b §2: `text` with every configured secret value replaced by `[redacted]`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return createRedactor(secrets)(text);
}

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi;
/**
 * An HTTP credential written out: `Bearer`, `Basic` or `token` (GitHub's `Authorization: token`)
 * and a run of at least 16 token characters.
 */
const AUTH_SCHEME = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Free text with configured secrets redacted and URL and HTTP credentials dropped. */
function cleanText(text: string, redact: (text: string) => string): string {
  return redact(text)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`);
}

/**
 * An error text for the bundle (4E-3b §1, §2): configured secrets redacted, URL credentials and
 * `Bearer`/`Basic`/`token` credentials dropped, control characters removed, then cut to 500
 * characters.
 */
export function cleanErrorText(text: string, redact: (text: string) => string): string {
  const cleaned = cleanText(text, redact).replace(CONTROL, '');
  return [...cleaned].slice(0, MAX_ERROR_TEXT).join('');
}

/**
 * A JSON value with `redact` applied to every string and every object key, and nothing else: a
 * number or a literal is never touched, so the value still serialises to valid JSON (a secret
 * `2026` must not turn `120260000` into `1[redacted]0000`).
 */
export function redactTree(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactTree(item, redact));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactTree(item, redact)]),
    );
  }
  return value;
}

/**
 * A log line for the bundle. A JSON line (pino writes nothing else) is cleaned inside its strings
 * and keys only, so it stays valid JSON; any other line is cleaned as text.
 */
export function cleanLogLine(line: string, redact: (text: string) => string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return cleanText(line, redact);
  }
  // A bare number or literal on a line is no pino line: text, so a numeric secret still goes.
  if (typeof parsed !== 'object' || parsed === null) return cleanText(line, redact);
  return JSON.stringify(redactTree(parsed, (text) => cleanText(text, redact)));
}
