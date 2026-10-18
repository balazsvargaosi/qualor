import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createTestContext,
  createUser,
  login,
  type Session,
  type TestContext,
} from '../../test/app';
import { mcpCall } from '../../test/mcp';
import { oauthTokens as runOAuth, tokenRequest } from '../../test/oauth';
import { rbacContext } from '../../test/rbac';
import { auditEvents, oauthGrants } from '../db/schema';

describe('connected apps', () => {
  let ctx: TestContext;
  let alice: Session;
  let aliceId: string;
  let admin: Session;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const a = await createUser(ctx, { username: 'alice' });
    aliceId = a.id;
    alice = await login(ctx, a.username, a.password);
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const mine = async () =>
    (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/v0/me/oauth-grants',
        headers: alice.headers,
      })
    ).json().items as { id: string; client: { name: string; source: string }; scopes: string[] }[];

  it('lists the user grants and revokes one, which stops its tokens', async () => {
    const t = await runOAuth(ctx, alice, ['mcp:read']);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/me/oauth-grants',
      headers: alice.headers,
    });
    expect(list.statusCode).toBe(200);
    const [grant] = list.json().items;
    expect(grant).toMatchObject({
      client: { name: 'Test agent', source: 'dcr' },
      scopes: ['mcp:read'],
    });
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/me/oauth-grants/${grant.id}`,
      headers: alice.headers,
    });
    expect(del.statusCode).toBe(204);
    expect((await mcpCall(ctx, t.accessToken, 'tools/list')).status).toBe(401);
    // The refresh token dies with the grant, so the app cannot mint a new access token either.
    const refresh = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await mine()).toEqual([]);
    // Already revoked: gone.
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/me/oauth-grants/${grant.id}`,
      headers: alice.headers,
    });
    expect(again.statusCode).toBe(404);
  });

  it('lets the instance admin list and revoke any grant, and nobody else', async () => {
    await runOAuth(ctx, alice, ['mcp:read']);
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v0/users/${aliceId}/oauth-grants`,
      headers: admin.headers,
    });
    const [grant] = list.json().items;
    const notAdmin = await ctx.app.inject({
      method: 'GET',
      url: `/api/v0/users/${aliceId}/oauth-grants`,
      headers: alice.headers,
    });
    expect(notAdmin.statusCode).toBe(403);
    const notAdminDel = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/users/${aliceId}/oauth-grants/${grant.id}`,
      headers: alice.headers,
    });
    expect(notAdminDel.statusCode).toBe(403);
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/users/${aliceId}/oauth-grants/${grant.id}`,
      headers: admin.headers,
    });
    expect(del.statusCode).toBe(204);
    const [row] = await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.id, grant.id));
    expect(row?.revokedBy).not.toBeNull();
  });

  it('answers 404 for another user grant id on /me', async () => {
    const b = await createUser(ctx, { username: 'bob' });
    const bob = await login(ctx, b.username, b.password);
    await runOAuth(ctx, alice, ['mcp:read']);
    const [grant] = await mine();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/me/oauth-grants/${grant?.id}`,
      headers: bob.headers,
    });
    expect(res.statusCode).toBe(404);
    // The admin route does not match a grant of another user either.
    const wrong = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/users/${b.id}/oauth-grants/${grant?.id}`,
      headers: admin.headers,
    });
    expect(wrong.statusCode).toBe(404);
  });

  it('does not list a grant unused for 90 days, nor revoke it by id', async () => {
    await runOAuth(ctx, alice, ['mcp:read']);
    const [grant] = await mine();
    await ctx.db.execute(
      sql`UPDATE oauth_grants SET last_used_at = now() - interval '91 days' WHERE id = ${grant?.id}`,
    );
    expect((await mine()).find((g) => g.id === grant?.id)).toBeUndefined();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/me/oauth-grants/${grant?.id}`,
      headers: alice.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('connected apps audit', () => {
  it('records oauth.grant_revoked with the reason while audit-log is active', async () => {
    const ctx = await rbacContext({
      now: () => new Date('2027-01-01T00:00:00Z'),
      config: { publicUrl: 'https://q.example' },
    });
    try {
      const a = await createUser(ctx, { username: 'carol' });
      const carol = await login(ctx, a.username, a.password);
      const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
      await runOAuth(ctx, carol, ['mcp:read']);
      const items = async () =>
        (
          await ctx.app.inject({
            method: 'GET',
            url: '/api/v0/me/oauth-grants',
            headers: carol.headers,
          })
        ).json().items as { id: string }[];
      const [first] = await items();
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v0/me/oauth-grants/${first?.id}`,
        headers: carol.headers,
      });
      await runOAuth(ctx, carol, ['mcp:read']);
      const [second] = await items();
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v0/users/${a.id}/oauth-grants/${second?.id}`,
        headers: admin.headers,
      });
      const events = await ctx.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'oauth.grant_revoked'))
        .orderBy(auditEvents.seq);
      expect(events.map((e) => e.details)).toMatchObject([
        { reason: 'user', clientId: expect.any(String) },
        { reason: 'admin', clientId: expect.any(String) },
      ]);
      expect(events.map((e) => e.targetId)).toEqual([first?.id, second?.id]);
    } finally {
      await ctx.close();
    }
  });
});
