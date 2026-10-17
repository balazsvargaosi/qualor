import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, createTestContext, login, nextIp, type TestContext } from '../../test/app';
import { rbacContext } from '../../test/rbac';
import { auditEvents, oauthClients } from '../db/schema';

describe('POST /oauth/register (RFC 7591)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const register = (payload: object, ip = nextIp()) =>
    ctx.app.inject({ method: 'POST', url: '/oauth/register', payload, remoteAddress: ip });

  it('registers a public client', async () => {
    const res = await register({
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:54123/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      client_id: expect.stringMatching(/^qlr_cli_/),
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:54123/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(res.json()).not.toHaveProperty('client_secret');
  });

  it('keeps logo_uri and client_uri only when they are https', async () => {
    const res = await register({
      client_name: 'Logos',
      redirect_uris: ['https://a.example/cb'],
      logo_uri: 'http://a.example/logo.png',
      client_uri: 'https://a.example/',
    });
    expect(res.statusCode).toBe(201);
    const [row] = await ctx.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, res.json().client_id));
    expect(row?.logoUri).toBeNull();
    expect(row?.clientUri).toBe('https://a.example/');
  });

  it.each([
    [{ redirect_uris: [] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['http://example.com/cb'] }, 'invalid_redirect_uri'],
    [
      { redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'client_secret_post' },
      'invalid_client_metadata',
    ],
    [
      { redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials'] },
      'invalid_client_metadata',
    ],
    [
      { redirect_uris: Array.from({ length: 21 }, (_, i) => `https://a.example/cb${i}`) },
      'invalid_client_metadata',
    ],
    [{ redirect_uris: ['https://a.example/' + 'x'.repeat(2048)] }, 'invalid_client_metadata'],
  ])('refuses %j with %s', async (payload, error) => {
    const res = await register(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is off when the administrator turned DCR off', async () => {
    const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/system/mcp',
      headers: admin.headers,
      payload: { dcr: false, cimd: true, allowedClients: [] },
    });
    const res = await register({ redirect_uris: ['https://a.example/cb'] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('access_denied');
    const meta = await ctx.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(meta.json()).not.toHaveProperty('registration_endpoint');
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/system/mcp',
      headers: admin.headers,
      payload: { dcr: true, cimd: true, allowedClients: [] },
    });
  });

  it('limits registrations per address, answering in OAuth JSON', async () => {
    const ip = nextIp();
    let last = await register({ redirect_uris: ['https://a.example/cb'] }, ip);
    for (let i = 1; i < 21; i += 1) {
      last = await register({ redirect_uris: ['https://a.example/cb'] }, ip);
    }
    expect(last.statusCode).toBe(429);
    expect(last.headers['content-type']).toContain('application/json');
    expect(last.headers['content-type']).not.toContain('problem');
    expect(last.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: expect.any(String),
    });
  });

  it('answers malformed JSON in OAuth JSON', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).not.toContain('problem');
    expect(res.json().error).toBe('invalid_request');
  });

  it('stores only the validated metadata fields', async () => {
    const res = await register({
      client_name: 'Lean',
      redirect_uris: ['https://a.example/cb'],
      junk: 'x'.repeat(5000),
      contacts: ['a@b.example'],
    });
    expect(res.statusCode).toBe(201);
    const [row] = await ctx.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, res.json().client_id));
    expect(row?.metadata).not.toHaveProperty('junk');
    expect(row?.metadata).not.toHaveProperty('contacts');
    expect(row?.metadata).toMatchObject({ client_name: 'Lean' });
  });
});

describe('POST /oauth/register audit', () => {
  it('records oauth.client_registered while audit-log is active', async () => {
    const ctx = await rbacContext({
      now: () => new Date('2027-01-01T00:00:00Z'),
      config: { publicUrl: 'https://q.example' },
    });
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/oauth/register',
        payload: { client_name: 'Audited', redirect_uris: ['https://a.example/cb'] },
        remoteAddress: nextIp(),
      });
      expect(res.statusCode).toBe(201);
      const [event] = await ctx.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'oauth.client_registered'))
        .orderBy(desc(auditEvents.seq))
        .limit(1);
      expect(event).toBeDefined();
      expect(event?.actorType).toBe('anonymous');
      expect(event?.targetType).toBe('oauth_client');
      expect(event?.details).toMatchObject({
        clientId: res.json().client_id,
        name: 'Audited',
        source: 'dcr',
      });
    } finally {
      await ctx.close();
    }
  });
});
