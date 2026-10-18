import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import { first } from '../db/rows';
import { TOUCH_INTERVAL_MS, type OAuthPrincipal } from '../auth/principal';
import { hashesEqual, hashToken } from '../auth/tokens';
import { oauthClients, oauthGrants, oauthRequests, oauthTokens, users } from '../db/schema';
import { redirectTargetLabel } from './redirect';
import { clientAllowed } from './clients';
import { readMcpPolicy } from './policy';
import {
  ACCESS_TTL_SECONDS,
  CODE_TTL_SECONDS,
  generateOAuthSecret,
  GRANT_IDLE_DAYS,
  MCP_SCOPES,
  parseOAuthSecret,
  PENDING_TTL_SECONDS,
  pkceMatches,
  REFRESH_TTL_DAYS,
  type McpScope,
} from './tokens';

/** Spec §6 step 1: a missing scope is `mcp:read`; `mcp:write` brings `mcp:read`; unknown is null. */
export function parseScopes(raw: string | null): McpScope[] | null {
  if (raw === null || raw.trim() === '') return ['mcp:read'];
  const asked = raw.trim().split(/ +/);
  if (!asked.every((s) => (MCP_SCOPES as readonly string[]).includes(s))) return null;
  return asked.includes('mcp:write') ? ['mcp:read', 'mcp:write'] : ['mcp:read'];
}

/** Spec §4.5: a grant unused for GRANT_IDLE_DAYS (since its creation, if never used) has expired. */
export function isGrantIdle(
  grant: { lastUsedAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  const last = grant.lastUsedAt ?? grant.createdAt;
  return now.getTime() - last.getTime() > GRANT_IDLE_DAYS * 86_400_000;
}

/** The client's redirect URI with the response parameters added; null parameters are left out. */
export function authorizationRedirect(
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

export async function createPendingRequest(
  db: Executor,
  input: {
    clientRowId: string;
    redirectUri: string;
    state: string | null;
    scopes: McpScope[];
    codeChallenge: string;
    resource: string;
  },
  now = new Date(),
): Promise<{ id: string }> {
  return first(
    await db
      .insert(oauthRequests)
      .values({ ...input, expiresAt: new Date(now.getTime() + PENDING_TTL_SECONDS * 1000) })
      .returning({ id: oauthRequests.id }),
  );
}

export interface PendingView {
  id: string;
  client: {
    clientId: string;
    name: string;
    source: 'cimd' | 'dcr';
    logoUri: string | null;
    clientUri: string | null;
    redirectTarget: string;
    redirectUri: string;
  };
  scopes: McpScope[];
  expiresAt: Date;
  /** A live grant for this client already covers every scope asked: the UI approves at once. */
  coveredByGrant: boolean;
}

/** The pending request, bound to the first user who opens it; null when gone, expired or someone else's. */
export async function pendingRequestFor(
  db: Executor,
  requestId: string,
  userId: string,
  now = new Date(),
): Promise<PendingView | null> {
  const bound = await db
    .update(oauthRequests)
    .set({ userId: sql`coalesce(${oauthRequests.userId}, ${userId}::uuid)` })
    .where(
      and(
        eq(oauthRequests.id, requestId),
        eq(oauthRequests.status, 'pending'),
        gt(oauthRequests.expiresAt, now),
        sql`(${oauthRequests.userId} IS NULL OR ${oauthRequests.userId} = ${userId}::uuid)`,
      ),
    )
    .returning();
  const request = bound[0];
  if (!request) return null;
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, request.clientRowId));
  if (!client) return null;
  const [grant] = await db
    .select({
      scopes: oauthGrants.scopes,
      lastUsedAt: oauthGrants.lastUsedAt,
      createdAt: oauthGrants.createdAt,
    })
    .from(oauthGrants)
    .where(
      and(
        eq(oauthGrants.userId, userId),
        eq(oauthGrants.clientRowId, client.id),
        isNull(oauthGrants.revokedAt),
      ),
    );
  const scopes = request.scopes as McpScope[];
  return {
    id: request.id,
    client: {
      clientId: client.clientId,
      name: client.name,
      source: client.source,
      logoUri: client.logoUri,
      clientUri: client.clientUri,
      redirectTarget: redirectTargetLabel(request.redirectUri),
      redirectUri: request.redirectUri,
    },
    scopes,
    expiresAt: request.expiresAt,
    coveredByGrant:
      !!grant && !isGrantIdle(grant, now) && scopes.every((s) => grant.scopes.includes(s)),
  };
}

export interface GrantChange {
  id: string;
  scopes: McpScope[];
  clientId: string;
  clientName: string;
}

export type DecisionResult =
  | { ok: true; redirectTo: string; grant: (GrantChange & { created: boolean }) | null }
  | { ok: false; reason: 'not_found' | 'scope_not_requested' | 'client_not_allowed' };

/** What `decide` runs inside its transaction, so the audit events commit or roll back with the grant. */
export interface DecisionHooks {
  /** A grant was created or its scopes changed. */
  onGrantChange: (tx: Executor, grant: GrantChange) => Promise<void>;
  /** An idle grant was revoked to be replaced. */
  onIdleRevoked?: (tx: Executor, grant: Omit<GrantChange, 'scopes'>) => Promise<void>;
}

type RequestRow = typeof oauthRequests.$inferSelect;
type ClientRow = typeof oauthClients.$inferSelect;

/** Read-only, or read and write: a write grant always carries read. */
const scopeSet = (write: boolean): McpScope[] => (write ? ['mcp:read', 'mcp:write'] : ['mcp:read']);

/**
 * The live grant of this user and client after an approval of `scopes`: an idle one is replaced,
 * a live one is never narrowed (an auto-approved read-only request keeps mcp:write). `changed`
 * says whether a grant was created or its scopes widened.
 */
async function upsertGrant(
  tx: Executor,
  ctx: { request: RequestRow; client: ClientRow; userId: string; scopes: McpScope[]; now: Date },
  onIdleRevoked: DecisionHooks['onIdleRevoked'],
): Promise<{ id: string; scopes: McpScope[]; changed: boolean } | null> {
  const { request, client, userId, scopes, now } = ctx;
  const lockLive = async () =>
    (
      await tx
        .select()
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.userId, userId),
            eq(oauthGrants.clientRowId, request.clientRowId),
            isNull(oauthGrants.revokedAt),
          ),
        )
        .for('update')
    )[0];
  let live = await lockLive();
  if (live && isGrantIdle(live, now)) {
    // Expired: replace it, or the client would loop into invalid_grant on it for ever.
    if (await revokeGrant(tx, live.id, null, now)) {
      await onIdleRevoked?.(tx, {
        id: live.id,
        clientId: client.clientId,
        clientName: client.name,
      });
    }
    live = undefined;
  }
  if (!live) {
    // A concurrent approval of the same user and client may win the unique live-grant index.
    const [inserted] = await tx
      .insert(oauthGrants)
      .values({ userId, clientRowId: request.clientRowId, scopes })
      .onConflictDoNothing()
      .returning({ id: oauthGrants.id });
    if (inserted) return { id: inserted.id, scopes, changed: true };
    live = await lockLive();
    if (!live) return null;
  }
  const union = scopeSet(scopes.includes('mcp:write') || live.scopes.includes('mcp:write'));
  if (union.length === live.scopes.length) return { id: live.id, scopes: union, changed: false };
  await tx.update(oauthGrants).set({ scopes: union }).where(eq(oauthGrants.id, live.id));
  return { id: live.id, scopes: union, changed: true };
}

/**
 * Approve (a grant and a 60 s code) or deny a pending request of this user (spec §6 step 6).
 * `hooks.onGrantChange` runs inside the transaction when a grant was created or its scopes changed,
 * and `hooks.onIdleRevoked` when an idle grant was revoked to be replaced, so the audit events
 * commit or roll back with the grant.
 */
export async function decide(
  db: Db,
  input: {
    requestId: string;
    userId: string;
    decision: { approve: true; scopes: McpScope[] } | { approve: false };
    issuer: string;
    now?: Date;
  },
  hooks: DecisionHooks,
): Promise<DecisionResult> {
  const { requestId, userId, decision, issuer, now = new Date() } = input;
  return db.transaction(async (tx): Promise<DecisionResult> => {
    const [request] = await tx
      .select()
      .from(oauthRequests)
      .where(
        and(
          eq(oauthRequests.id, requestId),
          eq(oauthRequests.userId, userId),
          eq(oauthRequests.status, 'pending'),
          gt(oauthRequests.expiresAt, now),
        ),
      )
      .for('update');
    if (!request) return { ok: false, reason: 'not_found' };
    const base = { state: request.state, iss: issuer };
    if (!decision.approve) {
      await tx
        .update(oauthRequests)
        .set({ status: 'denied' })
        .where(eq(oauthRequests.id, request.id));
      return {
        ok: true,
        redirectTo: authorizationRedirect(request.redirectUri, {
          error: 'access_denied',
          error_description: 'The user denied the request',
          ...base,
        }),
        grant: null,
      };
    }
    const scopes = scopeSet(decision.scopes.includes('mcp:write'));
    if (!scopes.every((s) => request.scopes.includes(s))) {
      return { ok: false, reason: 'scope_not_requested' };
    }
    const [client] = await tx
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, request.clientRowId));
    if (!client) return { ok: false, reason: 'not_found' };
    // The administrator may have changed the client policy since the request was made.
    const policy = await readMcpPolicy(tx);
    const sourceOn = client.source === 'dcr' ? policy.dcr : policy.cimd;
    if (!clientAllowed(policy, client.clientId) || !sourceOn) {
      return { ok: false, reason: 'client_not_allowed' };
    }
    const upserted = await upsertGrant(
      tx,
      { request, client, userId, scopes, now },
      hooks.onIdleRevoked,
    );
    if (!upserted) return { ok: false, reason: 'not_found' };
    const grantId = upserted.id;
    const grant: GrantChange = {
      id: grantId,
      scopes: upserted.scopes,
      clientId: client.clientId,
      clientName: client.name,
    };
    if (upserted.changed) await hooks.onGrantChange(tx, grant);
    // Housekeeping keeps a client used within 30 days (spec §4.5); the grant row is locked already.
    await tx
      .update(oauthClients)
      .set({ lastUsedAt: now })
      .where(eq(oauthClients.id, request.clientRowId));
    const code = generateOAuthSecret('code');
    await tx
      .update(oauthRequests)
      .set({
        status: 'code_issued',
        grantId,
        scopes,
        codePrefix: code.prefix,
        codeHash: code.secretHash,
        expiresAt: new Date(now.getTime() + CODE_TTL_SECONDS * 1000),
      })
      .where(eq(oauthRequests.id, request.id));
    return {
      ok: true,
      redirectTo: authorizationRedirect(request.redirectUri, { code: code.token, ...base }),
      grant: { ...grant, created: upserted.changed },
    };
  });
}

export type RevokeReason = 'code_reuse' | 'refresh_reuse';

export type TokenResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      scopes: McpScope[];
      grantId: string;
    }
  | {
      ok: false;
      error: 'invalid_grant' | 'invalid_target' | 'invalid_scope';
      revokedGrant?: { id: string; clientId: string; reason: RevokeReason };
    };

/** Runs inside the transaction that revoked a grant, so its audit event commits with it. */
export type OnGrantRevoked = (
  tx: Executor,
  grant: { id: string; clientId: string; reason: RevokeReason | 'user' },
) => Promise<void>;

const INVALID = { ok: false, error: 'invalid_grant' } as const;
const DAY_MS = 86_400_000;

/** Called with the grant row locked; the client row comes after it (lock order, see exchangeCode). */
async function issuePair(tx: Executor, grant: { id: string; clientRowId: string }, now: Date) {
  const grantId = grant.id;
  const access = generateOAuthSecret('access');
  const refreshSecret = generateOAuthSecret('refresh');
  await tx.insert(oauthTokens).values({
    grantId,
    kind: 'access',
    prefix: access.prefix,
    secretHash: access.secretHash,
    expiresAt: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000),
  });
  const refreshRow = first(
    await tx
      .insert(oauthTokens)
      .values({
        grantId,
        kind: 'refresh',
        prefix: refreshSecret.prefix,
        secretHash: refreshSecret.secretHash,
        expiresAt: new Date(now.getTime() + REFRESH_TTL_DAYS * DAY_MS),
      })
      .returning({ id: oauthTokens.id }),
  );
  await tx.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, grantId));
  // Housekeeping keeps a client used within 30 days (spec §4.5).
  await tx
    .update(oauthClients)
    .set({ lastUsedAt: now })
    .where(eq(oauthClients.id, grant.clientRowId));
  return { accessToken: access.token, refreshToken: refreshSecret.token, refreshId: refreshRow.id };
}

/** A grant that may still issue tokens: live, used within 90 days, its user active. */
async function liveGrant(tx: Executor, grantId: string, now: Date) {
  const [row] = await tx
    .select({ grant: oauthGrants, active: users.active })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(eq(oauthGrants.id, grantId));
  if (!row || row.grant.revokedAt || !row.active || isGrantIdle(row.grant, now)) return null;
  return row.grant;
}

export interface GrantView {
  id: string;
  client: {
    clientId: string;
    name: string;
    source: 'cimd' | 'dcr';
    logoUri: string | null;
    clientUri: string | null;
  };
  scopes: McpScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The user's live grants for the Connected apps page; an idle grant no longer works, so it is left out. */
export async function listGrants(
  db: Executor,
  userId: string,
  now = new Date(),
): Promise<GrantView[]> {
  const rows = await db
    .select({ grant: oauthGrants, client: oauthClients })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientRowId))
    .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
    .orderBy(oauthGrants.createdAt);
  return rows
    .filter(({ grant }) => !isGrantIdle(grant, now))
    .map(({ grant, client }) => ({
      id: grant.id,
      client: {
        clientId: client.clientId,
        name: client.name,
        source: client.source,
        logoUri: client.logoUri,
        clientUri: client.clientUri,
      },
      scopes: grant.scopes as McpScope[],
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
    }));
}

export interface RevokedGrant {
  id: string;
  clientId: string;
  name: string;
}

/**
 * The grant if it is this user's, live and not idle (an idle grant is not listed, so it is not
 * revocable by id either), its row locked (grant first, as the token paths do) inside a transaction.
 */
export async function userGrant(
  db: Executor,
  userId: string,
  grantId: string,
  now = new Date(),
): Promise<RevokedGrant | null> {
  const [row] = await db
    .select({
      id: oauthGrants.id,
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      lastUsedAt: oauthGrants.lastUsedAt,
      createdAt: oauthGrants.createdAt,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientRowId))
    .where(
      and(
        eq(oauthGrants.id, grantId),
        eq(oauthGrants.userId, userId),
        isNull(oauthGrants.revokedAt),
      ),
    )
    .for('update', { of: oauthGrants });
  if (!row || isGrantIdle(row, now)) return null;
  return { id: row.id, clientId: row.clientId, name: row.name };
}

/** Revokes a grant and every token of it; false when it was already revoked. */
export async function revokeGrant(
  db: Executor,
  grantId: string,
  by: string | null,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(oauthGrants)
    .set({ revokedAt: now, revokedBy: by })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
    .returning({ id: oauthGrants.id });
  await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
  return rows.length > 0;
}

/** A used code presented again: the grant it opened is revoked (R6). */
async function revokeReusedCode(
  tx: Executor,
  ctx: { request: RequestRow; client: ClientRow; now: Date },
  onRevoked: OnGrantRevoked | undefined,
): Promise<TokenResult> {
  const { request, client, now } = ctx;
  if (!request.grantId || !(await revokeGrant(tx, request.grantId, null, now))) return INVALID;
  await onRevoked?.(tx, { id: request.grantId, clientId: client.clientId, reason: 'code_reuse' });
  return {
    ...INVALID,
    revokedGrant: { id: request.grantId, clientId: client.clientId, reason: 'code_reuse' },
  };
}

/** An issued, unexpired code of this client, its redirect URI (when given) and its PKCE verifier. */
function codeRedeemable(
  found: { request: RequestRow; client: ClientRow },
  input: { clientId: string; redirectUri: string | null; verifier: string },
  now: Date,
): boolean {
  const { request, client } = found;
  if (request.status !== 'code_issued' || request.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  if (client.clientId !== input.clientId) return false;
  if (input.redirectUri !== null && input.redirectUri !== request.redirectUri) return false;
  return pkceMatches(input.verifier, request.codeChallenge);
}

/** Spec §6 step 7: the code is single-use; presenting it again revokes the grant it opened (R6). */
export async function exchangeCode(
  db: Db,
  input: {
    code: string;
    clientId: string;
    redirectUri: string | null;
    verifier: string;
    resource: string | null;
    resourceExpected: string;
  },
  now = new Date(),
  onRevoked?: OnGrantRevoked,
): Promise<TokenResult> {
  if (input.resource !== null && input.resource !== input.resourceExpected) {
    return { ok: false, error: 'invalid_target' };
  }
  const parsed = parseOAuthSecret(input.code);
  if (!parsed || parsed.kind !== 'code') return INVALID;
  return db.transaction(async (tx): Promise<TokenResult> => {
    // Lock order: the grant row first, then its request/token rows and last its client row
    // (revokeGrant takes the grant first too), so a reuse race cannot deadlock. The one exception
    // is decide(), which locks its pending request and then the grant (then the client); that is
    // safe because a pending request is not among the rows the grant-first paths lock (they lock
    // only code_issued/used ones). Housekeeping deletes a client only with no live grant and no
    // request, skipping a locked client row (cleanOAuth). Find the match unlocked, lock, re-read.
    const candidates = await tx
      .select({ request: oauthRequests, client: oauthClients })
      .from(oauthRequests)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthRequests.clientRowId))
      .where(eq(oauthRequests.codePrefix, parsed.prefix));
    const presented = hashToken(input.code);
    let match: (typeof candidates)[number] | undefined;
    for (const c of candidates) {
      if (c.request.codeHash && hashesEqual(c.request.codeHash, presented)) match = c;
    }
    if (!match?.request.grantId) return INVALID;
    const { client } = match;
    await tx
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(eq(oauthGrants.id, match.request.grantId))
      .for('update');
    const [request] = await tx
      .select()
      .from(oauthRequests)
      .where(eq(oauthRequests.id, match.request.id))
      .for('update');
    if (!request) return INVALID;
    if (request.status === 'used') return revokeReusedCode(tx, { request, client, now }, onRevoked);
    if (!request.grantId || !codeRedeemable({ request, client }, input, now)) return INVALID;
    await tx.update(oauthRequests).set({ status: 'used' }).where(eq(oauthRequests.id, request.id));
    const grant = await liveGrant(tx, request.grantId, now);
    if (!grant) return INVALID;
    const pair = await issuePair(tx, grant, now);
    return {
      ok: true,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      scopes: grant.scopes as McpScope[],
      grantId: grant.id,
    };
  });
}

/**
 * Spec §6 step 8: rotates the refresh token. A replaced token coming back means it leaked: the
 * grant is revoked. Ruling P2: a wider `scope` is refused, an equal or narrower one accepted, and
 * the answer carries the grant's scopes (nothing is stored per token).
 */
export async function refresh(
  db: Db,
  input: {
    refreshToken: string;
    clientId: string;
    scopes: McpScope[] | null;
    resource: string | null;
    resourceExpected: string;
  },
  now = new Date(),
  onRevoked?: OnGrantRevoked,
): Promise<TokenResult> {
  if (input.resource !== null && input.resource !== input.resourceExpected) {
    return { ok: false, error: 'invalid_target' };
  }
  const parsed = parseOAuthSecret(input.refreshToken);
  if (!parsed || parsed.kind !== 'refresh') return INVALID;
  return db.transaction(async (tx): Promise<TokenResult> => {
    // Lock order: grant first, then the token row (see exchangeCode, which also states decide()'s
    // request-then-grant exception). Two simultaneous presentations of one token serialise on the
    // grant; the loser re-reads the token as replaced, which is reuse, so the grant is revoked (the
    // safe outcome).
    const candidates = await tx
      .select({ token: oauthTokens, clientId: oauthClients.clientId, source: oauthClients.source })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientRowId))
      .where(and(eq(oauthTokens.prefix, parsed.prefix), eq(oauthTokens.kind, 'refresh')));
    const presented = hashToken(input.refreshToken);
    let match: (typeof candidates)[number] | undefined;
    for (const c of candidates) if (hashesEqual(c.token.secretHash, presented)) match = c;
    if (!match) return INVALID;
    const { clientId, source } = match;
    if (clientId !== input.clientId) return INVALID;
    await tx
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(eq(oauthGrants.id, match.token.grantId))
      .for('update');
    const [token] = await tx
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.id, match.token.id))
      .for('update');
    if (!token) return INVALID;
    if (token.replacedBy !== null) {
      if (await revokeGrant(tx, token.grantId, null, now)) {
        await onRevoked?.(tx, { id: token.grantId, clientId, reason: 'refresh_reuse' });
        return {
          ...INVALID,
          revokedGrant: { id: token.grantId, clientId, reason: 'refresh_reuse' },
        };
      }
      return INVALID;
    }
    if (token.revokedAt || token.expiresAt.getTime() <= now.getTime()) return INVALID;
    const grant = await liveGrant(tx, token.grantId, now);
    if (!grant) return INVALID;
    // The administrator may have blocked the client since (as decide() re-checks); the grant stays.
    const policy = await readMcpPolicy(tx);
    if (!clientAllowed(policy, clientId) || !(source === 'dcr' ? policy.dcr : policy.cimd)) {
      return INVALID;
    }
    const granted = grant.scopes as McpScope[];
    if (input.scopes && !input.scopes.every((s) => granted.includes(s))) {
      return { ok: false, error: 'invalid_scope' };
    }
    const pair = await issuePair(tx, grant, now);
    await tx
      .update(oauthTokens)
      .set({ replacedBy: pair.refreshId })
      .where(eq(oauthTokens.id, token.id));
    return {
      ok: true,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      scopes: granted,
      grantId: grant.id,
    };
  });
}

/**
 * RFC 7009: a refresh token revokes its grant, an access token only itself. Never tells the
 * caller which; the grant is returned (when one was revoked) for the audit event.
 */
export async function revokeToken(
  db: Db,
  input: { token: string; clientId: string },
  now = new Date(),
  onRevoked?: OnGrantRevoked,
): Promise<{ grantId: string; clientId: string } | null> {
  const parsed = parseOAuthSecret(input.token);
  if (!parsed || parsed.kind === 'code') return null;
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ token: oauthTokens, clientId: oauthClients.clientId })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientRowId))
      .where(eq(oauthTokens.prefix, parsed.prefix));
    const presented = hashToken(input.token);
    let match: (typeof candidates)[number] | undefined;
    for (const c of candidates) if (hashesEqual(c.token.secretHash, presented)) match = c;
    if (!match || match.clientId !== input.clientId) return null;
    if (match.token.kind === 'refresh') {
      if (!(await revokeGrant(tx, match.token.grantId, null, now))) return null;
      await onRevoked?.(tx, { id: match.token.grantId, clientId: match.clientId, reason: 'user' });
      return { grantId: match.token.grantId, clientId: match.clientId };
    }
    await tx.update(oauthTokens).set({ revokedAt: now }).where(eq(oauthTokens.id, match.token.id));
    return null;
  });
}

/** Spec §4.3: a live `qlr_oat_` of a live grant whose user is active; else null. */
export async function resolveAccessToken(
  db: Executor,
  token: string,
  now = new Date(),
): Promise<Omit<OAuthPrincipal, 'scopes'> | null> {
  return (await lookupAccessToken(db, token, now)).principal;
}

/**
 * resolveAccessToken, and whether the token is one Qualor issued (`known`) even when it no longer
 * works (expired, revoked, idle grant, inactive user): /mcp counts only unknown ones as failures.
 */
export async function lookupAccessToken(
  db: Executor,
  token: string,
  now = new Date(),
): Promise<{ principal: Omit<OAuthPrincipal, 'scopes'> | null; known: boolean }> {
  const parsed = parseOAuthSecret(token);
  if (!parsed || parsed.kind !== 'access') return { principal: null, known: false };
  const candidates = await db
    .select({ token: oauthTokens, grant: oauthGrants, client: oauthClients, user: users })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientRowId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthTokens.prefix, parsed.prefix), eq(oauthTokens.kind, 'access')));
  const presented = hashToken(token);
  let match: (typeof candidates)[number] | undefined;
  for (const c of candidates) if (hashesEqual(c.token.secretHash, presented)) match = c;
  if (!match) return { principal: null, known: false };
  const { token: row, grant, client, user } = match;
  if (
    row.revokedAt ||
    row.expiresAt.getTime() <= now.getTime() ||
    grant.revokedAt ||
    isGrantIdle(grant, now) ||
    !user.active
  ) {
    return { principal: null, known: true };
  }
  if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    await db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, grant.id));
  }
  return {
    principal: {
      kind: 'oauth',
      user,
      grantId: grant.id,
      clientId: client.clientId,
      clientName: client.name,
      mcpScopes: grant.scopes as McpScope[],
    },
    known: true,
  };
}
