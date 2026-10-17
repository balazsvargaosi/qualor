import { createHash } from 'node:crypto';
import { hashesEqual, hashToken, randomBase62, TOKEN_PREFIX_LENGTH } from '../auth/tokens';

export type OAuthSecretKind = 'access' | 'refresh' | 'code';

const PREFIX: Record<OAuthSecretKind, string> = {
  access: 'qlr_oat_',
  refresh: 'qlr_ort_',
  code: 'qlr_oac_',
};
const SECRET_PATTERN = /^qlr_(oat|ort|oac)_[0-9A-Za-z]{32}$/;
const KIND_OF: Partial<Record<string, OAuthSecretKind>> = { oat: 'access', ort: 'refresh', oac: 'code' };

export const MCP_SCOPES = ['mcp:read', 'mcp:write'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_DAYS = 30;
export const GRANT_IDLE_DAYS = 90;
export const CODE_TTL_SECONDS = 60;
export const PENDING_TTL_SECONDS = 600;

/** An OAuth access token, refresh token or authorization code: shown once, stored as a hash. */
export function generateOAuthSecret(kind: OAuthSecretKind): {
  token: string;
  prefix: string;
  secretHash: Buffer;
} {
  const token = PREFIX[kind] + randomBase62(32);
  return { token, prefix: token.slice(0, TOKEN_PREFIX_LENGTH), secretHash: hashToken(token) };
}

export function parseOAuthSecret(token: string): { kind: OAuthSecretKind; prefix: string } | null {
  const match = SECRET_PATTERN.exec(token);
  if (!match) return null;
  const kind = KIND_OF[match[1] ?? ''];
  if (kind === undefined) return null;
  return { kind, prefix: token.slice(0, TOKEN_PREFIX_LENGTH) };
}

/** A DCR client's id (RFC 7591 §3.2.1); public, so no secret goes with it. */
export function generateClientId(): string {
  return 'qlr_cli_' + randomBase62(24);
}

/** RFC 7636 §4.1: 43–128 unreserved characters. */
export function isCodeVerifier(v: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

/** An S256 challenge: base64url of a SHA-256, no padding (43 characters). */
export function isCodeChallenge(c: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(c);
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) return false;
  return hashesEqual(Buffer.from(pkceS256(verifier)), Buffer.from(challenge));
}
