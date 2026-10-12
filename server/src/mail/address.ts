import { isIP } from 'node:net';
import { z } from 'zod';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/** E1 spec: a DNS host name (1–253 characters, labels of letters, digits and hyphens) or an IP literal. */
export function isHostName(host: string): boolean {
  if (isIP(host) !== 0) return true;
  if (host.length < 1 || host.length > 253) return false;
  return host
    .replace(/\.$/, '')
    .split('.')
    .every((label) => LABEL.test(label));
}

/** An email address, as users.email takes it (routes/users.ts). */
export const emailAddress = z.email().max(320);

export function isEmailAddress(value: string): boolean {
  return emailAddress.safeParse(value).success;
}

export const ONE_LINE_MESSAGE = 'Must be one line';

/** No CR, LF or NUL: a value that goes into a mail header never takes a second line. */
export function isOneLine(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- the NUL check is the point
  return !/[\r\n\u0000]/.test(value);
}

const NAMED = /^(?:"([^"]{1,100})"|([^"<>]{1,100}?))\s*<([^<>\s]+)>$/;

/**
 * `Name <address>` or a bare `address` (QUALOR_SMTP_FROM): the name (`fallbackName` for a bare
 * address) and the address, or null when it is neither, or holds a line break.
 */
export function parseMailbox(
  value: string,
  fallbackName = 'Qualor',
): { name: string; address: string } | null {
  const text = value.trim();
  if (!isOneLine(text)) return null;
  const named = NAMED.exec(text);
  const name = named ? (named[1] ?? named[2] ?? '').trim() : fallbackName;
  const address = named ? (named[3] ?? '') : text;
  if (name === '' || name.length > 100 || !isEmailAddress(address)) return null;
  return { name, address };
}
