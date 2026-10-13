import { describe, expect, it } from 'vitest';
import type { Executor } from '../db/client';
import {
  ACCOUNT_TOKEN_LENGTH,
  accountTokenKey,
  peekAccountToken,
  plausibleAccountToken,
  takeAccountToken,
} from './account-tokens';

/** Any property access throws: proves a function returned before touching the database. */
const NO_DB = new Proxy(
  {},
  {
    get: () => {
      throw new Error('no query expected');
    },
  },
) as unknown as Executor;

describe('account token input checks (mail E2 A1)', () => {
  it.each([
    '',
    'a'.repeat(101),
    'abc-def',
    'abc def',
    'äbc',
    'abc\u0000',
    '../x',
    42,
    null,
    undefined,
  ])('refuses %j without a query', async (raw) => {
    expect(plausibleAccountToken(raw)).toBe(false);
    expect(await peekAccountToken(NO_DB, raw, 'password_reset')).toBeNull();
    expect(await takeAccountToken(NO_DB, raw, 'invitation')).toBeNull();
  });

  it('accepts base62 up to 100 characters', () => {
    expect(plausibleAccountToken('A'.repeat(ACCOUNT_TOKEN_LENGTH))).toBe(true);
    expect(plausibleAccountToken('z9'.repeat(50))).toBe(true);
  });

  it('keys a token by its SHA-256 in lowercase hex', () => {
    expect(accountTokenKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
