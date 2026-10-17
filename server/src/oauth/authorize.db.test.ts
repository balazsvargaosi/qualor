import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
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
import { auditEvents } from '../db/schema';
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
    return ctx.app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
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
