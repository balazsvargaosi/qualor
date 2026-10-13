import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * mail E3 N5: the token of an email's "Stop watching this project" link and of its
 * `List-Unsubscribe` header: base64url(`<userId>:<projectId>`) `.` base64url(HMAC-SHA256), keyed
 * like the CSRF token (auth/sessions.ts) by HKDF of QUALOR_SECRET_KEY under its own label. Nothing
 * is stored; a new secret key makes every earlier link invalid.
 */

/** base64url of `<uuid>:<uuid>` is 98 characters and the tag 43: anything longer is not a token. */
export const MAX_TOKEN_LENGTH = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYLOAD = /^[A-Za-z0-9_-]+$/;
const TAG = /^[A-Za-z0-9_-]{43}$/;

function tag(secretKey: string, payload: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', secretKey, 'qualor', 'unsubscribe v1', 32));
  return createHmac('sha256', key).update(payload).digest();
}

export function unsubscribeToken(secretKey: string, userId: string, projectId: string): string {
  const payload = Buffer.from(`${userId}:${projectId}`, 'utf8').toString('base64url');
  return `${payload}.${tag(secretKey, payload).toString('base64url')}`;
}

/** The user and project of a token this server made, or null for anything else. */
export function verifyUnsubscribeToken(
  secretKey: string,
  token: string,
): { userId: string; projectId: string } | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, given] = parts as [string, string];
  if (!PAYLOAD.test(payload) || !TAG.test(given)) return null;
  const expected = tag(secretKey, payload);
  const actual = Buffer.from(given, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const ids = Buffer.from(payload, 'base64url').toString('utf8').split(':');
  if (ids.length !== 2) return null;
  const [userId, projectId] = ids as [string, string];
  return UUID.test(userId) && UUID.test(projectId) ? { userId, projectId } : null;
}

export type UnsubscribeHeaders = { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string };

/** RFC 8058 one-click headers; none without QUALOR_PUBLIC_URL (there is nothing to point at). */
export function unsubscribeHeaders(
  publicUrl: string | null,
  token: string,
): UnsubscribeHeaders | undefined {
  // A header value stays one line and one `<URL>` (the config already validates the URL).
  if (publicUrl === null || /[\s<>]/.test(publicUrl)) return undefined;
  return {
    'List-Unsubscribe': `<${publicUrl}/api/v0/notifications/unsubscribe?t=${encodeURIComponent(token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
