import { describe, expect, it } from 'vitest';
import {
  generateClientId,
  generateOAuthSecret,
  isCodeChallenge,
  isCodeVerifier,
  parseOAuthSecret,
  pkceMatches,
  pkceS256,
} from './tokens';

describe('OAuth secrets', () => {
  it.each([
    ['access', /^qlr_oat_[0-9A-Za-z]{32}$/],
    ['refresh', /^qlr_ort_[0-9A-Za-z]{32}$/],
    ['code', /^qlr_oac_[0-9A-Za-z]{32}$/],
  ] as const)('generates a %s secret with its prefix and hash', (kind, pattern) => {
    const s = generateOAuthSecret(kind);
    expect(s.token).toMatch(pattern);
    expect(s.prefix).toBe(s.token.slice(0, 12));
    expect(parseOAuthSecret(s.token)).toEqual({ kind, prefix: s.prefix });
    expect(s.secretHash).toHaveLength(32);
  });

  it('parses nothing else (PATs, project tokens, truncated, padded)', () => {
    for (const t of [
      'qlr_pat_' + 'a'.repeat(32),
      'qlr_prj_' + 'a'.repeat(32),
      'qlr_oat_' + 'a'.repeat(31),
      'qlr_oat_' + 'a'.repeat(33),
      ' qlr_oat_' + 'a'.repeat(32),
    ]) {
      expect(parseOAuthSecret(t)).toBeNull();
    }
  });

  it('generates DCR client ids', () => {
    expect(generateClientId()).toMatch(/^qlr_cli_[0-9A-Za-z]{24}$/);
  });
});

describe('PKCE S256 (RFC 7636)', () => {
  // RFC 7636 appendix B.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('computes the appendix B challenge', () => {
    expect(pkceS256(verifier)).toBe(challenge);
    expect(pkceMatches(verifier, challenge)).toBe(true);
  });

  it('refuses a different verifier and a malformed one', () => {
    expect(pkceMatches(verifier.replace('d', 'e'), challenge)).toBe(false);
    expect(pkceMatches('short', challenge)).toBe(false);
  });

  it('validates verifier and challenge syntax', () => {
    expect(isCodeVerifier(verifier)).toBe(true);
    expect(isCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isCodeVerifier('a'.repeat(42) + '!')).toBe(false);
    expect(isCodeChallenge(challenge)).toBe(true);
    expect(isCodeChallenge(challenge + '=')).toBe(false);
  });
});
