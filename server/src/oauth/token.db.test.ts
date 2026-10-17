import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createTestContext,
  createUser,
  login,
  type Session,
  type TestContext,
} from '../../test/app';
import { authorizeAndApprove, oauthTokens, registerClient, tokenRequest } from '../../test/oauth';
import { rbacContext } from '../../test/rbac';
import { auditEvents, oauthGrants, users } from '../db/schema';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('POST /oauth/token and /oauth/revoke', () => {
  let ctx: TestContext;
  let alice: Session;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const a = await createUser(ctx, { username: 'alice' });
    alice = await login(ctx, a.username, a.password);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const revoke = (form: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: FORM,
      payload: new URLSearchParams(form).toString(),
    });

  it('exchanges a code for tokens, once', async () => {
    const clientId = await registerClient(ctx);
    const { code, verifier, redirectUri } = await authorizeAndApprove(ctx, alice, clientId);
    const form = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    };
    const res = await tokenRequest(ctx, form);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      access_token: expect.stringMatching(/^qlr_oat_/),
      refresh_token: expect.stringMatching(/^qlr_ort_/),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:read mcp:write',
    });
    const replay = await tokenRequest(ctx, form);
    expect([replay.statusCode, replay.json().error]).toEqual([400, 'invalid_grant']);
    // Ruling R6: the replay revoked the grant, so the first refresh token is dead too.
    const refreshed = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: res.json().refresh_token,
      client_id: clientId,
    });
    expect(refreshed.json().error).toBe('invalid_grant');
  });

  it.each([
    ['a wrong verifier', { code_verifier: 'x'.repeat(43) }],
    ['another client', { client_id: 'qlr_cli_other' }],
    ['another redirect URI', { redirect_uri: 'http://127.0.0.1/other' }],
  ])('refuses %s with invalid_grant', async (_name, over) => {
    const clientId = await registerClient(ctx);
    const { code, verifier, redirectUri } = await authorizeAndApprove(ctx, alice, clientId);
    const res = await tokenRequest(ctx, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      ...over,
    });
    expect([res.statusCode, res.json().error]).toEqual([400, 'invalid_grant']);
  });

  it('refuses a wrong resource, an unknown grant type and a repeated parameter', async () => {
    const clientId = await registerClient(ctx);
    const { code, verifier, redirectUri } = await authorizeAndApprove(ctx, alice, clientId);
    const target = await tokenRequest(ctx, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: 'https://other.example/mcp',
    });
    expect(target.json().error).toBe('invalid_target');
    expect((await tokenRequest(ctx, { grant_type: 'password' })).json().error).toBe(
      'unsupported_grant_type',
    );
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: 'grant_type=authorization_code&code=a&code=b',
    });
    expect(dup.json().error).toBe('invalid_request');
  });

  it('expires a code after 60 seconds', async () => {
    const clientId = await registerClient(ctx);
    const { code, verifier, redirectUri } = await authorizeAndApprove(ctx, alice, clientId);
    await ctx.db.execute(
      sql`UPDATE oauth_requests SET expires_at = now() - interval '1 second' WHERE status = 'code_issued'`,
    );
    const res = await tokenRequest(ctx, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(res.json().error).toBe('invalid_grant');
  });

  it('rotates refresh tokens and revokes the grant when a replaced one comes back', async () => {
    const t = await oauthTokens(ctx, alice);
    const first = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(first.statusCode).toBe(200);
    const next = first.json().refresh_token as string;
    expect(next).not.toBe(t.refreshToken);
    const reuse = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(reuse.json().error).toBe('invalid_grant');
    const after = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: next,
      client_id: t.clientId,
    });
    expect(after.json().error).toBe('invalid_grant');
  });

  it('narrows the scope on refresh, never widens it', async () => {
    const t = await oauthTokens(ctx, alice, ['mcp:read']);
    const wider = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
      scope: 'mcp:read mcp:write',
    });
    expect(wider.json().error).toBe('invalid_scope');
    const same = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
      scope: 'mcp:read',
    });
    expect([same.statusCode, same.json().scope]).toEqual([200, 'mcp:read']);
  });

  it('stops refreshing for a deactivated user (Review Focus 5)', async () => {
    const b = await createUser(ctx, { username: 'bob' });
    const bob = await login(ctx, b.username, b.password);
    const t = await oauthTokens(ctx, bob);
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, b.id));
    const res = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(res.json().error).toBe('invalid_grant');
  });

  it('expires a grant unused for 90 days', async () => {
    const c = await createUser(ctx, { username: 'carol' });
    const carol = await login(ctx, c.username, c.password);
    const t = await oauthTokens(ctx, carol);
    const old = new Date(Date.now() - 91 * 86_400_000);
    await ctx.db
      .update(oauthGrants)
      .set({ lastUsedAt: old, createdAt: old })
      .where(eq(oauthGrants.userId, c.id));
    const res = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(res.json().error).toBe('invalid_grant');
  });

  it('revokes a refresh token (and so its grant), always answering 200', async () => {
    const t = await oauthTokens(ctx, alice);
    const res = await revoke({ token: t.refreshToken, client_id: t.clientId });
    expect(res.statusCode).toBe(200);
    const after = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(after.json().error).toBe('invalid_grant');
    expect((await revoke({ token: 'qlr_ort_nope', client_id: 'x' })).statusCode).toBe(200);
  });

  it('ignores a revocation from another client', async () => {
    const t = await oauthTokens(ctx, alice);
    const other = await registerClient(ctx);
    expect((await revoke({ token: t.refreshToken, client_id: other })).statusCode).toBe(200);
    const still = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(still.statusCode).toBe(200);
  });

  it('revokes only an access token when that is what is presented', async () => {
    const t = await oauthTokens(ctx, alice);
    expect((await revoke({ token: t.accessToken, client_id: t.clientId })).statusCode).toBe(200);
    const still = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    });
    expect(still.statusCode).toBe(200);
  });

  it('answers two simultaneous refreshes of one token with at most one pair, and revokes the grant', async () => {
    const t = await oauthTokens(ctx, alice);
    const form = {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: t.clientId,
    };
    const [a, b] = await Promise.all([tokenRequest(ctx, form), tokenRequest(ctx, form)]);
    const ok = [a, b].filter((r) => r.statusCode === 200);
    expect(ok.length).toBeLessThanOrEqual(1);
    // The loser saw the winner's rotation: reuse, so the grant (and the winner's pair) is dead.
    for (const r of ok) {
      const next = await tokenRequest(ctx, {
        ...form,
        refresh_token: r.json().refresh_token as string,
      });
      expect(next.json().error).toBe('invalid_grant');
    }
    expect([a, b].filter((r) => r.statusCode === 400)).toHaveLength(2 - ok.length);
  });

  it('answers two simultaneous exchanges of one code with at most one pair', async () => {
    const clientId = await registerClient(ctx);
    const { code, verifier, redirectUri } = await authorizeAndApprove(ctx, alice, clientId);
    const form = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    };
    const [a, b] = await Promise.all([tokenRequest(ctx, form), tokenRequest(ctx, form)]);
    expect([a, b].filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(1);
    // The loser's replay revoked the grant the winner just got: its refresh token is dead.
    const winner = [a, b].find((r) => r.statusCode === 200);
    if (winner) {
      const next = await tokenRequest(ctx, {
        grant_type: 'refresh_token',
        refresh_token: winner.json().refresh_token as string,
        client_id: clientId,
      });
      expect(next.json().error).toBe('invalid_grant');
    }
  });
});

describe('OAuth grant revocation audit', () => {
  it('records oauth.grant_revoked on refresh reuse, code reuse and a client revoke', async () => {
    const ctx = await rbacContext({
      now: () => new Date('2027-01-01T00:00:00Z'),
      config: { publicUrl: 'https://q.example' },
    });
    try {
      const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
      const latest = async () => {
        const [event] = await ctx.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'oauth.grant_revoked'))
          .orderBy(desc(auditEvents.seq))
          .limit(1);
        return event;
      };

      const t = await oauthTokens(ctx, admin);
      const form = {
        grant_type: 'refresh_token',
        refresh_token: t.refreshToken,
        client_id: t.clientId,
      };
      expect((await tokenRequest(ctx, form)).statusCode).toBe(200);
      expect((await tokenRequest(ctx, form)).statusCode).toBe(400);
      const reuse = await latest();
      expect(reuse?.actorType).toBe('system');
      expect(reuse?.targetType).toBe('oauth_grant');
      expect(reuse?.details).toMatchObject({ clientId: t.clientId, reason: 'refresh_reuse' });

      const clientId = await registerClient(ctx);
      const { code, verifier, redirectUri } = await authorizeAndApprove(ctx, admin, clientId);
      const exchange = {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      };
      expect((await tokenRequest(ctx, exchange)).statusCode).toBe(200);
      expect((await tokenRequest(ctx, exchange)).statusCode).toBe(400);
      expect((await latest())?.details).toMatchObject({ clientId, reason: 'code_reuse' });

      const u = await oauthTokens(ctx, admin);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/oauth/revoke',
        headers: FORM,
        payload: new URLSearchParams({ token: u.refreshToken, client_id: u.clientId }).toString(),
      });
      expect(res.statusCode).toBe(200);
      expect((await latest())?.details).toMatchObject({ clientId: u.clientId, reason: 'user' });
    } finally {
      await ctx.close();
    }
  });
});
