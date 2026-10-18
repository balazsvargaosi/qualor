import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, login, type TestContext } from '../../test/app';
import { oauthTokens as runOAuth, registerClient } from '../../test/oauth';
import { oauthClients } from '../db/schema';
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

  it('runs as a housekeeping stage and reports its counts', async () => {
    const result = await runHousekeeping(ctx.db);
    expect(result).toMatchObject({ oauthRequests: 0, oauthTokens: 0, oauthClients: 0 });
  });
});
