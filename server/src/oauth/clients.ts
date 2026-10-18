import { eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { first } from '../db/rows';
import { oauthClients } from '../db/schema';
import type { Resolver } from '../http/outbound';
import { fetchCimd, isCimdClientId, type CimdResult } from './cimd';
import type { McpPolicy } from './policy';
import { generateClientId } from './tokens';

export type ClientRow = typeof oauthClients.$inferSelect;
export type ClientResolution =
  | { ok: true; client: ClientRow }
  | {
      ok: false;
      error:
        | 'unknown_client'
        | 'client_not_allowed'
        | 'cimd_disabled'
        | 'cimd_invalid'
        | 'cimd_rate_limited';
      reason?: string;
    };

export interface DcrInput {
  name: string;
  redirectUris: string[];
  logoUri: string | null;
  clientUri: string | null;
  metadata: Record<string, unknown>;
}

export interface ClientDeps {
  db: Executor;
  policy: McpPolicy;
  resolve?: Resolver;
  /** Tests substitute the CIMD fetch. */
  fetchDocument?: (url: string) => Promise<CimdResult>;
  /** Asked before each CIMD fetch (a cache miss); false refuses it as `cimd_rate_limited`. */
  allowFetch?: () => boolean;
  now?: () => Date;
}

const CLIENT_NAME_MAX = 64;
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A client name safe to show and log. It is chosen by whoever registered the client, so control,
 * format (zero-width, bidi) and line or paragraph separator characters (header and log injection)
 * are dropped and the length is capped at CLIENT_NAME_MAX code points, never splitting a pair.
 * Applied when a name is stored (DCR, CIMD), so every surface shows the clean name.
 */
export function cleanClientName(clientName: string): string {
  const clean = clientName.replace(UNSAFE_CHARS, '').trim();
  return Array.from(clean).slice(0, CLIENT_NAME_MAX).join('').trim();
}

/** An empty list allows every client; else an exact client id, or a URL prefix ending in `/`. */
export function clientAllowed(policy: McpPolicy, clientId: string): boolean {
  if (policy.allowedClients.length === 0) return true;
  return policy.allowedClients.some((entry) =>
    entry.endsWith('/') ? clientId.startsWith(entry) : clientId === entry,
  );
}

/** Spec §4.1: a CIMD URL (fetched, cached) or a stored DCR client, within the instance policy. */
export async function resolveClient(deps: ClientDeps, clientId: string): Promise<ClientResolution> {
  if (!clientAllowed(deps.policy, clientId)) return { ok: false, error: 'client_not_allowed' };
  const now = deps.now?.() ?? new Date();
  const [row] = await deps.db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  if (!isCimdClientId(clientId)) {
    if (!row || row.source !== 'dcr') return { ok: false, error: 'unknown_client' };
    if (!deps.policy.dcr) return { ok: false, error: 'client_not_allowed' };
    return { ok: true, client: row };
  }
  if (!deps.policy.cimd) return { ok: false, error: 'cimd_disabled' };
  if (row && row.expiresAt && row.expiresAt.getTime() > now.getTime()) {
    return { ok: true, client: row };
  }
  if (deps.allowFetch && !deps.allowFetch()) return { ok: false, error: 'cimd_rate_limited' };
  const fetchDocument =
    deps.fetchDocument ??
    ((url: string) => fetchCimd(url, deps.resolve ? { resolve: deps.resolve } : {}));
  const fetched = await fetchDocument(clientId);
  if (!fetched.ok) return { ok: false, error: 'cimd_invalid', reason: fetched.reason };
  const { document } = fetched;
  const values = {
    clientId,
    source: 'cimd' as const,
    name: cleanClientName(document.client_name ?? '') || new URL(clientId).hostname,
    redirectUris: document.redirect_uris,
    logoUri: document.logo_uri ?? null,
    clientUri: document.client_uri ?? null,
    metadata: document as Record<string, unknown>,
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + fetched.maxAgeSeconds * 1000),
  };
  const client = first(
    await deps.db
      .insert(oauthClients)
      .values(values)
      .onConflictDoUpdate({ target: oauthClients.clientId, set: values })
      .returning(),
  );
  return { ok: true, client };
}

export async function registerDcrClient(db: Executor, input: DcrInput): Promise<ClientRow> {
  return first(
    await db
      .insert(oauthClients)
      .values({ clientId: generateClientId(), source: 'dcr', ...input })
      .returning(),
  );
}
