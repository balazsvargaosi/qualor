import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  ADMIN_PASSWORD,
  bearer,
  createTestContext,
  createUser,
  login,
  nextIp,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { rbacContext } from '../../test/rbac';
import { SESSION_COOKIE } from '../auth/sessions';
import { auditEvents, oauthClients, oauthGrants, oauthRequests } from '../db/schema';
import { decide } from './grants';
import { pkceS256 } from './tokens';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const REDIRECT = 'http://127.0.0.1:5555/callback';

type Ctx = Pick<TestContext, 'app'>;

async function registerClient(ctx: Ctx): Promise<string> {
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/oauth/register',
    remoteAddress: nextIp(),
    payload: { client_name: 'Test agent', redirect_uris: ['http://127.0.0.1/callback'] },
  });
  return reg.json().client_id;
}

const authorizeWith =
  (ctx: Ctx, clientId: string, issuer: string) =>
  (over: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams();
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 'st-1',
      scope: 'mcp:read mcp:write',
      code_challenge: pkceS256(VERIFIER),
      code_challenge_method: 'S256',
      resource: `${issuer}/mcp`,
      ...over,
    };
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
    return ctx.app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, remoteAddress: nextIp() });
  };

/** The request id out of the consent redirect an authorize call answered with. */
function consentRequestId(location: unknown): string {
  const id = new URL(String(location), 'https://q.example').searchParams.get('request');
  if (!id) throw new Error('no request id in the redirect');
  return id;
}

describe('GET /oauth/authorize and the consent API', () => {
  let ctx: TestContext;
  let alice: Session;
  let bob: Session;
  let authorize: ReturnType<typeof authorizeWith>;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const a = await createUser(ctx, { username: 'alice' });
    const b = await createUser(ctx, { username: 'bob' });
    alice = await login(ctx, a.username, a.password);
    bob = await login(ctx, b.username, b.password);
    authorize = authorizeWith(ctx, await registerClient(ctx), 'https://q.example');
  });
  afterAll(async () => {
    await ctx.close();
  });

  const view = (id: string, session: Session) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v0/oauth/requests/${id}`,
      headers: session.headers,
    });
  const decision = (id: string, session: Session, payload: object) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v0/oauth/requests/${id}/decision`,
      headers: session.headers,
      payload,
    });
  const requestId = async (over: Record<string, string | undefined> = {}) =>
    consentRequestId((await authorize(over)).headers.location);

  it('sends a valid request to the consent screen', async () => {
    const res = await authorize();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/oauth\/consent\?request=[0-9a-f-]{36}$/);
  });

  it.each([
    ['an unknown client', { client_id: 'qlr_cli_unknown' }],
    ['no client', { client_id: undefined }],
    ['an unregistered redirect URI', { redirect_uri: 'http://127.0.0.1:5555/elsewhere' }],
  ])('shows an error page and never redirects for %s', async (_name, over) => {
    const res = await authorize(over);
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toContain('text/html');
  });

  it.each([
    ['unsupported_response_type', { response_type: 'token' }],
    ['invalid_request', { code_challenge: undefined }],
    ['invalid_request', { code_challenge_method: 'plain' }],
    ['invalid_scope', { scope: 'mcp:read admin' }],
    ['invalid_target', { resource: 'https://other.example/mcp' }],
  ])('redirects with %s', async (error, over) => {
    const res = await authorize(over);
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe(error);
    expect(location.searchParams.get('state')).toBe('st-1');
    expect(location.searchParams.get('iss')).toBe('https://q.example');
  });

  it('shows the request to the user who opens it first, and to nobody else', async () => {
    const id = await requestId();
    const mine = await view(id, alice);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      client: { name: 'Test agent', source: 'dcr', redirectTarget: 'this computer (127.0.0.1)' },
      scopes: ['mcp:read', 'mcp:write'],
      coveredByGrant: false,
    });
    expect((await view(id, bob)).statusCode).toBe(404);
    expect((await decision(id, bob, { decision: 'deny' })).statusCode).toBe(404);
  });

  it('approves with a narrower scope and redirects with a code, state and iss', async () => {
    const id = await requestId();
    await view(id, alice);
    const res = await decision(id, alice, { decision: 'approve', scopes: ['mcp:read'] });
    expect(res.statusCode).toBe(200);
    const to = new URL(res.json().redirectTo);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get('code')).toMatch(/^qlr_oac_/);
    expect(to.searchParams.get('state')).toBe('st-1');
    expect(to.searchParams.get('iss')).toBe('https://q.example');
    const again = await decision(id, alice, { decision: 'approve', scopes: ['mcp:read'] });
    expect(again.statusCode).toBe(404);
  });

  it('marks a later request covered by the live grant', async () => {
    const id = await requestId({ scope: 'mcp:read' });
    expect((await view(id, alice)).json().coveredByGrant).toBe(true);
  });

  it('denies with access_denied', async () => {
    const id = await requestId();
    await view(id, bob);
    const res = await decision(id, bob, { decision: 'deny' });
    expect(new URL(res.json().redirectTo).searchParams.get('error')).toBe('access_denied');
  });

  it('refuses scopes that were not asked for', async () => {
    const id = await requestId({ scope: 'mcp:read' });
    await view(id, alice);
    const wider = await decision(id, alice, {
      decision: 'approve',
      scopes: ['mcp:read', 'mcp:write'],
    });
    expect(wider.statusCode).toBe(422);
  });

  it('expires a pending request after ten minutes', async () => {
    const id = await requestId();
    await ctx.db.execute(
      sql`UPDATE oauth_requests SET expires_at = now() - interval '1 second' WHERE id = ${id}`,
    );
    expect((await view(id, alice)).statusCode).toBe(404);
  });
});

describe('the consent redirect under a public URL with a path', () => {
  it('keeps the path in front of /oauth/consent', async () => {
    const ctx = await createTestContext({ config: { publicUrl: 'https://q.example/qualor' } });
    try {
      const authorize = authorizeWith(ctx, await registerClient(ctx), 'https://q.example/qualor');
      const res = await authorize();
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/qualor\/oauth\/consent\?request=[0-9a-f-]{36}$/);
    } finally {
      await ctx.close();
    }
  });
});

describe('the consent API for the demo account', () => {
  it('refuses a decision with 403 DEMO_READ_ONLY', async () => {
    const ctx = await createTestContext({
      config: { publicUrl: 'https://q.example', demoUser: 'guest' },
    });
    try {
      const guest = await createUser(ctx, { username: 'guest' });
      await addMember(ctx, await organizationId(ctx, 'default'), guest.id, 'viewer');
      const signIn = await ctx.app.inject({
        method: 'POST',
        url: '/api/v0/auth/demo',
        remoteAddress: nextIp(),
      });
      expect(signIn.statusCode).toBe(204);
      const cookie = signIn.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/v0/auth/me',
        cookies: { [SESSION_COOKIE]: cookie },
      });
      const headers = {
        cookie: `${SESSION_COOKIE}=${cookie}`,
        'x-qualor-csrf': (me.json() as { csrfToken: string }).csrfToken,
      };
      const authorize = authorizeWith(ctx, await registerClient(ctx), 'https://q.example');
      const id = consentRequestId((await authorize()).headers.location);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v0/oauth/requests/${id}/decision`,
        headers,
        payload: { decision: 'approve', scopes: ['mcp:read'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'DEMO_READ_ONLY' });
    } finally {
      await ctx.close();
    }
  });
});

describe('POST /oauth/requests/:id/decision audit', () => {
  it('records oauth.grant_created while audit-log is active, once per change', async () => {
    const ctx = await rbacContext({
      now: () => new Date('2027-01-01T00:00:00Z'),
      config: { publicUrl: 'https://q.example' },
    });
    try {
      const user = await createUser(ctx, { username: 'carol' });
      const carol = await login(ctx, user.username, user.password);
      const clientId = await registerClient(ctx);
      const authorize = authorizeWith(ctx, clientId, 'https://q.example');
      const approve = async (scope: string, scopes: string[]) => {
        const id = consentRequestId((await authorize({ scope })).headers.location);
        await ctx.app.inject({
          method: 'GET',
          url: `/api/v0/oauth/requests/${id}`,
          headers: carol.headers,
        });
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v0/oauth/requests/${id}/decision`,
          headers: carol.headers,
          payload: { decision: 'approve', scopes },
        });
        expect(res.statusCode).toBe(200);
      };
      const events = () =>
        ctx.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'oauth.grant_created'))
          .orderBy(desc(auditEvents.seq));
      await approve('mcp:read', ['mcp:read']);
      await approve('mcp:read', ['mcp:read']); // same scopes: no new event
      expect(await events()).toHaveLength(1);
      await approve('mcp:read mcp:write', ['mcp:read', 'mcp:write']); // wider: recorded again
      const recorded = await events();
      expect(recorded).toHaveLength(2);
      expect(recorded[0]?.targetType).toBe('oauth_grant');
      expect(recorded[0]?.actorType).toBe('user');
      expect(recorded[0]?.details).toMatchObject({
        clientId,
        clientName: 'Test agent',
        scopes: ['mcp:read', 'mcp:write'],
      });
    } finally {
      await ctx.close();
    }
  });
});

describe('grants, policy and request hygiene', () => {
  let ctx: TestContext;
  let dave: Session;
  let daveId: string;
  let clientId: string;
  let authorize: ReturnType<typeof authorizeWith>;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const u = await createUser(ctx, { username: 'dave' });
    daveId = u.id;
    dave = await login(ctx, u.username, u.password);
    clientId = await registerClient(ctx);
    authorize = authorizeWith(ctx, clientId, 'https://q.example');
  });
  afterAll(async () => {
    await ctx.close();
  });

  const open = async (over: Record<string, string | undefined> = {}) => {
    const id = consentRequestId((await authorize(over)).headers.location);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v0/oauth/requests/${id}`,
      headers: dave.headers,
    });
    return { id, view: res.json() };
  };
  const approve = (id: string, scopes: string[], headers: Record<string, string> = dave.headers) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v0/oauth/requests/${id}/decision`,
      headers,
      payload: { decision: 'approve', scopes },
    });
  const grants = () => ctx.db.select().from(oauthGrants).where(eq(oauthGrants.userId, daveId));

  it('never narrows a live grant, and a covered read-only request is no new grant', async () => {
    const wide = await open();
    expect((await approve(wide.id, ['mcp:read', 'mcp:write'])).statusCode).toBe(200);
    const narrow = await open({ scope: 'mcp:read' });
    expect(narrow.view.coveredByGrant).toBe(true);
    expect((await approve(narrow.id, ['mcp:read'])).statusCode).toBe(200);
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scopes).toEqual(['mcp:read', 'mcp:write']);
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it('replaces a grant that has been idle for 90 days', async () => {
    const [old] = await grants();
    await ctx.db.execute(
      sql`UPDATE oauth_grants SET created_at = now() - interval '100 days', last_used_at = now() - interval '91 days' WHERE id = ${old?.id}`,
    );
    const { id, view } = await open({ scope: 'mcp:read' });
    expect(view.coveredByGrant).toBe(false);
    expect((await approve(id, ['mcp:read'])).statusCode).toBe(200);
    const rows = await grants();
    const live = rows.filter((g) => g.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(old?.id);
    expect(live[0]?.scopes).toEqual(['mcp:read']);
    expect(rows.find((g) => g.id === old?.id)?.revokedAt).not.toBeNull();
  });

  it('serves two concurrent approvals of a new grant with one grant', async () => {
    const eve = await createUser(ctx, { username: 'eve' });
    const eveSession = await login(ctx, eve.username, eve.password);
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const id = consentRequestId((await authorize({ scope: 'mcp:read' })).headers.location);
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v0/oauth/requests/${id}`,
        headers: eveSession.headers,
      });
      ids.push(id);
    }
    const results = await Promise.all(
      ids.map((id) =>
        decide(
          ctx.db,
          id,
          eve.id,
          { approve: true, scopes: ['mcp:read'] },
          'https://q.example',
          () => Promise.resolve(),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.userId, eve.id));
    expect(rows).toHaveLength(1);
  });

  it('answers a repeated parameter with an error, never with a default', async () => {
    const redirect = encodeURIComponent(REDIRECT);
    const q = (extra: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/oauth/authorize?client_id=${clientId}&redirect_uri=${redirect}&response_type=code&code_challenge=${pkceS256(VERIFIER)}&code_challenge_method=S256&state=s${extra}`,
      });
    for (const extra of ['&client_id=x', `&redirect_uri=${redirect}`]) {
      const res = await q(extra);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    for (const extra of [
      '&scope=mcp:read&scope=mcp:write',
      '&response_type=code',
      '&resource=a&resource=b',
    ]) {
      const res = await q(extra);
      expect(res.statusCode).toBe(302);
      expect(new URL(res.headers.location as string).searchParams.get('error')).toBe(
        'invalid_request',
      );
    }
  });

  it('refuses a client the administrator has disallowed since, with 403 CLIENT_NOT_ALLOWED', async () => {
    const { id } = await open({ scope: 'mcp:read' });
    const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const put = (allowedClients: string[]) =>
      ctx.app.inject({
        method: 'PUT',
        url: '/api/v0/system/mcp',
        headers: admin.headers,
        payload: { dcr: true, cimd: true, allowedClients },
      });
    await put(['https://other.example/']);
    const res = await approve(id, ['mcp:read']);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'CLIENT_NOT_ALLOWED' });
    await put([]);
    expect((await approve(id, ['mcp:read'])).statusCode).toBe(200);
  });

  it('needs the CSRF header and a session, and stores only the code hash', async () => {
    const { id } = await open({ scope: 'mcp:read' });
    const noCsrf = await approve(id, ['mcp:read'], { cookie: dave.headers.cookie ?? '' });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ code: 'CSRF_FAILED' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/tokens',
      headers: dave.headers,
      payload: { name: 'pat', scopes: ['read'] },
    });
    expect(created.statusCode).toBe(201);
    const viaToken = await approve(id, ['mcp:read'], bearer(created.json().token));
    expect(viaToken.statusCode).toBe(403);
    expect(viaToken.json()).toMatchObject({ code: 'SESSION_REQUIRED' });

    const before = Date.now();
    const res = await approve(id, ['mcp:read']);
    const code = new URL(res.json().redirectTo).searchParams.get('code') ?? '';
    const [row] = await ctx.db.select().from(oauthRequests).where(eq(oauthRequests.id, id));
    expect(row?.status).toBe('code_issued');
    expect(row?.codePrefix).toBe(code.slice(0, 12));
    expect(row?.codeHash?.length).toBe(32);
    expect(JSON.stringify(row)).not.toContain(code);
    const ttl = (row?.expiresAt.getTime() ?? 0) - before;
    expect(ttl).toBeGreaterThan(50_000);
    expect(ttl).toBeLessThan(70_000);
  });
});

describe('GET /oauth/authorize rate limits', () => {
  let ctx: TestContext;
  let clientId: string;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    clientId = await registerClient(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const call = (id: string, ip: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: id,
        redirect_uri: 'http://127.0.0.1/callback',
        code_challenge: pkceS256(VERIFIER),
        code_challenge_method: 'S256',
      })}`,
      remoteAddress: ip,
    });

  it('answers the 61st call a minute from one address with a 429 page, never a redirect', async () => {
    const ip = nextIp();
    for (let i = 0; i < 60; i += 1) expect((await call(clientId, ip)).statusCode).toBe(302);
    const limited = await call(clientId, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers.location).toBeUndefined();
    expect(limited.headers['content-type']).toContain('text/html');
    expect(limited.body).toContain('Too many connection attempts');
    // Another address is not affected.
    expect((await call(clientId, nextIp())).statusCode).toBe(302);
  });

  it('allows one address 10 CIMD fetches a minute; cached documents and DCR clients are not counted', async () => {
    const ip = nextIp();
    // A public-address check refuses the fetch at once: each call is a cache miss that fetched.
    const uncached = 'https://127.0.0.1/client.json';
    for (let i = 0; i < 10; i += 1) expect((await call(uncached, ip)).statusCode).toBe(400);
    const limited = await call(uncached, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.headers.location).toBeUndefined();
    expect(limited.body).toContain('Too many connection attempts');
    await ctx.db.insert(oauthClients).values({
      clientId: 'https://cached.example/client.json',
      source: 'cimd',
      name: 'Cached',
      redirectUris: ['http://127.0.0.1/callback'],
      metadata: {},
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await call('https://cached.example/client.json', ip)).statusCode).toBe(302);
    expect((await call(clientId, ip)).statusCode).toBe(302);
  });
});
