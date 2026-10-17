import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestContext,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { authorizeAndApprove, oauthTokens as runOAuth, registerClient } from '../../test/oauth';
import { oauthGrants, oauthTokens, users, type TokenScope } from '../db/schema';
import { resolveAccessToken } from '../oauth/grants';
import { INTERNAL_HEADER } from '../mcp/internal';

describe('OAuth tokens and the REST API (Review Focus 1, 2)', () => {
  let ctx: TestContext;
  let alice: Session;
  let access: string;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const a = await createUser(ctx, { username: 'alice' });
    alice = await login(ctx, a.username, a.password);
    access = (await runOAuth(ctx, alice)).accessToken;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('refuses an OAuth access token on every /api/v0 route', async () => {
    for (const [method, url] of [
      ['GET', '/api/v0/auth/me'],
      ['GET', '/api/v0/projects'],
      ['POST', '/api/v0/issues/00000000-0000-0000-0000-000000000000/transition'],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: bearer(access),
        payload: method === 'POST' ? {} : undefined,
      });
      expect([url, res.statusCode]).toEqual([url, 401]);
    }
  });

  it('refuses a forged internal header, random or replayed', async () => {
    const forged = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/auth/me',
      headers: { [INTERNAL_HEADER]: 'A'.repeat(43) },
    });
    expect(forged.statusCode).toBe(401);
    const key = ctx.app.internalCalls.issue({
      kind: 'oauth',
      user: (
        await ctx.app.inject({ method: 'GET', url: '/api/v0/auth/me', headers: alice.headers })
      ).json().user,
    } as never);
    ctx.app.internalCalls.take(key);
    const replayed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/auth/me',
      headers: { [INTERNAL_HEADER]: key },
    });
    expect(replayed.statusCode).toBe(401);
  });

  it('accepts a valid internal key as the OAuth principal, without CSRF', async () => {
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/auth/me',
      headers: alice.headers,
    });
    const [user] = await ctx.db.select().from(users).where(eq(users.id, me.json().user.id));
    if (!user) throw new Error('alice missing');
    const key = ctx.app.internalCalls.issue({
      kind: 'oauth',
      user,
      grantId: 'g',
      clientId: 'c',
      clientName: 'Test agent',
      mcpScopes: ['mcp:read'],
      scopes: ['read'],
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/auth/me',
      headers: { [INTERNAL_HEADER]: key },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: 'alice' }, csrfToken: null });
  });

  async function internalKey(username: string, scopes: TokenScope[]): Promise<string> {
    const [user] = await ctx.db.select().from(users).where(eq(users.username, username));
    if (!user) throw new Error(`${username} missing`);
    return ctx.app.internalCalls.issue({
      kind: 'oauth',
      user,
      grantId: 'g',
      clientId: 'c',
      clientName: 'Test agent',
      mcpScopes: ['mcp:read', 'mcp:write'],
      scopes,
    });
  }

  it('lets an internal key mutate without X-Qualor-CSRF', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/auth/logout',
      headers: { [INTERNAL_HEADER]: await internalKey('alice', ['write']) },
    });
    expect(res.statusCode).toBe(204);
  });

  it('holds an internal key to the password change its user still owes', async () => {
    await createUser(ctx, { username: 'must-change', passwordChangeRequired: true });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/projects',
      headers: { [INTERNAL_HEADER]: await internalKey('must-change', ['read']) },
    });
    expect([res.statusCode, res.json().code]).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
  });

  it('holds an internal key to its REST scopes', async () => {
    const org = await organizationId(ctx, 'default');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/projects',
      headers: { [INTERNAL_HEADER]: await internalKey('admin', ['read']) },
      payload: { organizationId: org, key: 'nope', name: 'Nope' },
    });
    expect([res.statusCode, res.json().code]).toEqual([403, 'INSUFFICIENT_SCOPE']);
  });

  it('keeps a PAT and a session working as before', async () => {
    const pat = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/tokens',
      headers: alice.headers,
      payload: { name: 'p', scopes: ['read'] },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/auth/me',
      headers: bearer(pat.json().token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('resolveAccessToken (spec §4.3)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  async function fresh(name: string, scopes: Parameters<typeof runOAuth>[2] = undefined) {
    const u = await createUser(ctx, { username: name });
    const session = await login(ctx, u.username, u.password);
    const t = await runOAuth(ctx, session, scopes);
    return { ...t, userId: u.id };
  }

  it('resolves a live token to the grant, client and granted scopes', async () => {
    const t = await fresh('rv-live', ['mcp:read']);
    const p = await resolveAccessToken(ctx.db, t.accessToken);
    expect(p).toMatchObject({
      kind: 'oauth',
      clientId: t.clientId,
      clientName: 'Test agent',
      mcpScopes: ['mcp:read'],
      user: { username: 'rv-live' },
    });
    expect(p?.grantId).toEqual(expect.any(String));
  });

  it('refuses garbage, a refresh token and a wrong secret with a real prefix', async () => {
    const t = await fresh('rv-bad');
    expect(await resolveAccessToken(ctx.db, 'nonsense')).toBeNull();
    expect(await resolveAccessToken(ctx.db, t.refreshToken)).toBeNull();
    const wrong = t.accessToken.slice(0, -1) + (t.accessToken.endsWith('a') ? 'b' : 'a');
    expect(await resolveAccessToken(ctx.db, wrong)).toBeNull();
  });

  it('refuses revoked, expired, revoked-grant, idle-grant and inactive-user cases', async () => {
    const revoked = await fresh('rv-revoked');
    await ctx.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.prefix, revoked.accessToken.slice(0, 12)));
    expect(await resolveAccessToken(ctx.db, revoked.accessToken)).toBeNull();

    const live = await fresh('rv-expired');
    expect(await resolveAccessToken(ctx.db, live.accessToken)).not.toBeNull();
    expect(
      await resolveAccessToken(ctx.db, live.accessToken, new Date(Date.now() + 3601_000)),
    ).toBeNull();

    const grantRevoked = await fresh('rv-grant');
    await ctx.db
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(eq(oauthGrants.userId, grantRevoked.userId));
    expect(await resolveAccessToken(ctx.db, grantRevoked.accessToken)).toBeNull();

    const idle = await fresh('rv-idle');
    await ctx.db
      .update(oauthGrants)
      .set({ lastUsedAt: new Date(Date.now() - 91 * 86_400_000) })
      .where(eq(oauthGrants.userId, idle.userId));
    // A lastUsedAt 91 days back with the present clock: the grant is idle while its access token
    // is still unexpired, so only the idle check can refuse it.
    expect(await resolveAccessToken(ctx.db, idle.accessToken)).toBeNull();

    const gone = await fresh('rv-inactive');
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, gone.userId));
    expect(await resolveAccessToken(ctx.db, gone.accessToken)).toBeNull();
  });

  it('records use on the grant at most once a minute', async () => {
    const t = await fresh('rv-touch');
    const read = async () =>
      (await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.userId, t.userId)))[0]
        ?.lastUsedAt;
    const t0 = new Date(Date.now() + 120_000);
    await resolveAccessToken(ctx.db, t.accessToken, t0);
    expect((await read())?.getTime()).toBe(t0.getTime());
    await resolveAccessToken(ctx.db, t.accessToken, new Date(t0.getTime() + 10_000));
    expect((await read())?.getTime()).toBe(t0.getTime());
  });
});

describe('approving over an idle grant (Task 7 carry-over)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('revokes the old grant together with its tokens when it replaces it', async () => {
    const u = await createUser(ctx, { username: 'idle-user' });
    const session = await login(ctx, u.username, u.password);
    const clientId = await registerClient(ctx);
    const first = await authorizeAndApprove(ctx, session, clientId);
    const exchange = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: first.code,
        client_id: clientId,
        redirect_uri: first.redirectUri,
        code_verifier: first.verifier,
      }).toString(),
    });
    expect(exchange.statusCode).toBe(200);
    const [old] = await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.userId, u.id));
    if (!old) throw new Error('grant missing');
    await ctx.db
      .update(oauthGrants)
      .set({ lastUsedAt: new Date(Date.now() - 91 * 86_400_000) })
      .where(eq(oauthGrants.id, old.id));

    await authorizeAndApprove(ctx, session, clientId);

    const grants = await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.userId, u.id));
    expect(grants).toHaveLength(2);
    expect(grants.find((g) => g.id === old.id)?.revokedAt).not.toBeNull();
    const tokens = await ctx.db.select().from(oauthTokens).where(eq(oauthTokens.grantId, old.id));
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t.revokedAt).not.toBeNull();
  });
});
