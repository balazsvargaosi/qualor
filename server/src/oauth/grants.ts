import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import { first } from '../db/rows';
import { oauthClients, oauthGrants, oauthRequests } from '../db/schema';
import { redirectTargetLabel } from './redirect';
import { clientAllowed } from './clients';
import { readMcpPolicy } from './policy';
import {
  CODE_TTL_SECONDS,
  generateOAuthSecret,
  GRANT_IDLE_DAYS,
  MCP_SCOPES,
  PENDING_TTL_SECONDS,
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

/**
 * Approve (a grant and a 60 s code) or deny a pending request of this user (spec §6 step 6).
 * `onGrantChange` runs inside the transaction when a grant was created or its scopes changed, so
 * the audit event commits or rolls back with the grant.
 */
export async function decide(
  db: Db,
  requestId: string,
  userId: string,
  decision: { approve: true; scopes: McpScope[] } | { approve: false },
  issuer: string,
  onGrantChange: (tx: Executor, grant: GrantChange) => Promise<void>,
  now = new Date(),
): Promise<DecisionResult> {
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
    const scopes: McpScope[] = decision.scopes.includes('mcp:write')
      ? ['mcp:read', 'mcp:write']
      : ['mcp:read'];
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
    if (
      !clientAllowed(policy, client.clientId) ||
      (client.source === 'dcr' ? !policy.dcr : !policy.cimd)
    ) {
      return { ok: false, reason: 'client_not_allowed' };
    }
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
      await tx.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, live.id));
      live = undefined;
    }
    let grantId: string;
    let granted: McpScope[] = scopes;
    let created = false;
    if (!live) {
      // A concurrent approval of the same user and client may win the unique live-grant index.
      const [inserted] = await tx
        .insert(oauthGrants)
        .values({ userId, clientRowId: request.clientRowId, scopes })
        .onConflictDoNothing()
        .returning({ id: oauthGrants.id });
      if (inserted) {
        grantId = inserted.id;
        created = true;
      } else {
        live = await lockLive();
        if (!live) return { ok: false, reason: 'not_found' };
        grantId = live.id;
      }
    } else {
      grantId = live.id;
    }
    if (live) {
      // Never narrow a live grant (an auto-approved read-only request keeps mcp:write).
      const union: McpScope[] =
        scopes.includes('mcp:write') || live.scopes.includes('mcp:write')
          ? ['mcp:read', 'mcp:write']
          : ['mcp:read'];
      granted = union;
      if (union.length !== live.scopes.length) {
        await tx.update(oauthGrants).set({ scopes: union }).where(eq(oauthGrants.id, live.id));
        created = true;
      }
    }
    const grant: GrantChange = {
      id: grantId,
      scopes: granted,
      clientId: client.clientId,
      clientName: client.name,
    };
    if (created) await onGrantChange(tx, grant);
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
      grant: { ...grant, created },
    };
  });
}
