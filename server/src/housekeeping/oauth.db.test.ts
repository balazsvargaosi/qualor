import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, login, type TestContext } from '../../test/app';
import { oauthTokens as runOAuth, registerClient } from '../../test/oauth';
import { oauthClients, oauthGrants, oauthRequests } from '../db/schema';
import { cleanOAuth, runHousekeeping } from './run';

describe('OAuth housekeeping', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const cimd = (name: string) =>
    ctx.db.insert(oauthClients).values({
      clientId: `https://${name}.example/client.json`,
      source: 'cimd',
      name,
      redirectUris: ['http://127.0.0.1/callback'],
      metadata: {},
    });

  it('drops expired requests and tokens, and clients without a live grant for 30 days', async () => {
    const a = await createUser(ctx, { username: 'alice' });
    const alice = await login(ctx, a.username, a.password);
    await runOAuth(ctx, alice, ['mcp:read']);
    await registerClient(ctx);
    // CIMD: one whose cache expired 31 days ago, one only 10 days ago.
    await cimd('old');
    await cimd('recent');
    await ctx.db.execute(
      sql`UPDATE oauth_clients SET expires_at = now() - interval '31 days' WHERE name = 'old'`,
    );
    await ctx.db.execute(
      sql`UPDATE oauth_clients SET expires_at = now() - interval '10 days' WHERE name = 'recent'`,
    );
    await ctx.db.execute(sql`UPDATE oauth_tokens SET expires_at = now() - interval '1 day'`);
    await ctx.db.execute(sql`UPDATE oauth_requests SET expires_at = now() - interval '1 day'`);
    await ctx.db.execute(
      sql`UPDATE oauth_clients SET created_at = now() - interval '31 days' WHERE source = 'dcr'`,
    );
    const result = await cleanOAuth(ctx.db, new Date());
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.requests).toBeGreaterThan(0);
    // The DCR client with a live grant stays; the bare DCR and the long-expired CIMD one go.
    expect(result.clients).toBe(2);
    const left = await ctx.db.select({ name: oauthClients.name }).from(oauthClients);
    expect(left.map((c) => c.name).sort()).toEqual(['Test agent', 'recent']);
  });

  it('keeps a DCR client disconnected recently though registered long ago, and prunes it once stale', async () => {
    const b = await createUser(ctx, { username: 'bob' });
    const bob = await login(ctx, b.username, b.password);
    const { clientId } = await runOAuth(ctx, bob, ['mcp:read']);
    const [row] = await ctx.db
      .select({ lastUsedAt: oauthClients.lastUsedAt })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId));
    // Approval and the token exchange recorded the client's use.
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
    const [grant] = await ctx.db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(eq(oauthGrants.userId, b.id));
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/me/oauth-grants/${grant?.id}`,
      headers: bob.headers,
    });
    expect(del.statusCode).toBe(204);
    await ctx.db.execute(
      sql`UPDATE oauth_clients SET created_at = now() - interval '60 days' WHERE client_id = ${clientId}`,
    );
    await ctx.db.execute(sql`DELETE FROM oauth_requests`);
    expect((await cleanOAuth(ctx.db, new Date())).clients).toBe(0);
    // Only the revocation is recent now: still kept.
    await ctx.db.execute(
      sql`UPDATE oauth_clients SET last_used_at = now() - interval '45 days' WHERE client_id = ${clientId}`,
    );
    await ctx.db.execute(
      sql`UPDATE oauth_grants SET created_at = now() - interval '50 days' WHERE user_id = ${b.id}`,
    );
    expect((await cleanOAuth(ctx.db, new Date())).clients).toBe(0);
    await ctx.db.execute(
      sql`UPDATE oauth_grants SET revoked_at = now() - interval '31 days' WHERE user_id = ${b.id}`,
    );
    expect((await cleanOAuth(ctx.db, new Date())).clients).toBe(1);
    const left = await ctx.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId));
    expect(left).toEqual([]);
  });

  it('keeps a stale client while a request for it is pending, and skips one another transaction holds', async () => {
    const clientId = await registerClient(ctx);
    await ctx.db.execute(
      sql`UPDATE oauth_clients SET created_at = now() - interval '60 days' WHERE client_id = ${clientId}`,
    );
    const [client] = await ctx.db
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId));
    if (!client) throw new Error('no client');
    await ctx.db.insert(oauthRequests).values({
      clientRowId: client.id,
      redirectUri: 'http://127.0.0.1/callback',
      scopes: ['mcp:read'],
      codeChallenge: 'x'.repeat(43),
      resource: 'https://q.example/mcp',
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect((await cleanOAuth(ctx.db, new Date())).clients).toBe(0);
    await ctx.db.execute(sql`DELETE FROM oauth_requests`);
    // An approval in flight holds the client row (its grant insert or last_used_at write).
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM oauth_clients WHERE id = ${client.id} FOR KEY SHARE`);
      locked();
      await held;
    });
    await isLocked;
    try {
      expect((await cleanOAuth(ctx.db, new Date())).clients).toBe(0);
    } finally {
      release();
      await holder;
    }
    expect((await cleanOAuth(ctx.db, new Date())).clients).toBe(1);
  });

  it('runs as a housekeeping stage and reports its counts', async () => {
    const result = await runHousekeeping(ctx.db);
    expect(result).toMatchObject({ oauthRequests: 0, oauthTokens: 0, oauthClients: 0 });
  });
});
