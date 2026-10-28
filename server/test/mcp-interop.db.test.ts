import { createServer } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthTokens } from '../src/db/schema';
import {
  addMember,
  createProject,
  createTestContext,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from './app';

const REDIRECT = 'http://127.0.0.1/callback';

/** A port nobody listens on right now, so the public URL can name it before the app listens. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/**
 * What a desktop agent keeps between runs: everything lives in memory here. `tokens()` without a
 * context returns the latest set, as the SDK's per-request read requires.
 */
function memoryProvider() {
  const store: {
    client?: Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
    tokens?: Parameters<OAuthClientProvider['saveTokens']>[0];
    verifier?: string;
    discovery?: Parameters<NonNullable<OAuthClientProvider['saveDiscoveryState']>>[0];
    authorizationUrl?: URL;
    savedTokens: number;
  } = { savedTokens: 0 };
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return {
        client_name: 'SDK interop',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      };
    },
    clientInformation: () => store.client,
    saveClientInformation: (info) => {
      store.client = info;
    },
    tokens: () => store.tokens,
    saveTokens: (tokens) => {
      store.tokens = tokens;
      store.savedTokens += 1;
    },
    redirectToAuthorization: (url) => {
      store.authorizationUrl = url;
    },
    saveCodeVerifier: (verifier) => {
      store.verifier = verifier;
    },
    codeVerifier: () => {
      if (!store.verifier) throw new Error('no code verifier saved');
      return store.verifier;
    },
    saveDiscoveryState: (state) => {
      store.discovery = state;
    },
    discoveryState: () => store.discovery,
  };
  return { provider, store };
}

describe('MCP SDK client against Qualor (spec §10 interoperability)', () => {
  let ctx: TestContext;
  let base: string;
  let alice: Session;
  beforeAll(async () => {
    // The public URL must be the listening address, so the metadata URLs resolve for the client:
    // pick a free port, build the app with it, then listen on it. The SDK exempts loopback hosts
    // from its https-only token endpoint rule (SEP-2207), so plain http works here.
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    ctx = await createTestContext({ config: { publicUrl: base } });
    await ctx.app.listen({ port, host: '127.0.0.1' });
    const admin = await login(ctx, 'admin', 'correct horse battery staple');
    const a = await createUser(ctx, { username: 'alice' });
    alice = await login(ctx, a.username, a.password);
    const org = await organizationId(ctx, 'default');
    await addMember(ctx, org, a.id, 'member');
    await createProject(ctx, admin, { organizationId: org, key: 'shop', name: 'Shop' });
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** The browser's part: follow the authorization URL to the consent request and approve it. */
  async function approveInBrowser(authorizationUrl: URL): Promise<URLSearchParams> {
    const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const consent = new URL(authorize.headers.get('location') ?? '', base);
    const requestId = consent.searchParams.get('request');
    expect(requestId).toBeTruthy();
    const headers = { cookie: alice.headers.cookie ?? '', 'x-qualor-csrf': alice.csrf };
    // Reading binds the request to the signed-in user (spec §6 step 4).
    const read = await fetch(`${base}/api/v0/oauth/requests/${requestId}`, { headers });
    expect(read.status).toBe(200);
    const decision = await fetch(`${base}/api/v0/oauth/requests/${requestId}/decision`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scopes: ['mcp:read'] }),
    });
    expect(decision.status).toBe(200);
    const { redirectTo } = (await decision.json()) as { redirectTo: string };
    expect(redirectTo.startsWith(`${REDIRECT}?`)).toBe(true);
    return new URL(redirectTo).searchParams;
  }

  for (const [mode, version] of [
    ['legacy', '2025-11-25'],
    [{ pin: '2026-07-28' }, '2026-07-28'],
  ] as const) {
    const era = mode === 'legacy' ? `${version} (the SDK default)` : version;
    it(`discovers, registers, authorizes with PKCE, calls a tool and refreshes (${era})`, async () => {
      const { provider, store } = memoryProvider();
      const calls: string[] = [];
      const recording = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const res = await fetch(url, init);
        calls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname} ${res.status}`);
        return res;
      };
      const transportFor = () =>
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          authProvider: provider,
          fetch: recording,
        });
      const client = new Client(
        { name: 'interop', version: '1.0.0' },
        { versionNegotiation: { mode } },
      );

      // 1. No token yet: 401 → resource metadata → AS metadata → DCR → redirect to authorize.
      const first = transportFor();
      await expect(client.connect(first)).rejects.toSatisfy((e) => UnauthorizedError.isInstance(e));
      expect(calls).toEqual([
        'POST /mcp 401',
        'GET /.well-known/oauth-protected-resource/mcp 200',
        'GET /.well-known/oauth-authorization-server 200',
        'POST /oauth/register 201',
      ]);
      expect(store.client?.client_id).toMatch(/^qlr_cli_/);
      const authorizationUrl = store.authorizationUrl;
      if (!authorizationUrl) throw new Error('the provider got no authorization URL');
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${base}/oauth/authorize`);
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorizationUrl.searchParams.get('resource')).toBe(`${base}/mcp`);

      // 2. The browser approves; the callback goes back to the SDK, which redeems the code.
      const callback = await approveInBrowser(authorizationUrl);
      expect(callback.get('iss')).toBe(base);
      await first.finishAuth(callback);
      expect(store.tokens?.access_token).toMatch(/^qlr_oat_/);
      expect(store.tokens?.refresh_token).toMatch(/^qlr_ort_/);
      const firstAccess = store.tokens?.access_token;

      // 3. Connected: the tools are there and one answers.
      await client.connect(transportFor());
      expect(client.getNegotiatedProtocolVersion()).toBe(version);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['qualor_projects', 'qualor_gate_status']),
      );
      const projects = await client.callTool({ name: 'qualor_projects', arguments: {} });
      expect(projects.isError ?? false).toBe(false);
      expect(JSON.stringify(projects.content)).toContain('shop');

      // 4. The access token expires; the next call refreshes on the 401 and succeeds. It expired
      // seconds ago: the server reads its own clock, and a database clock ahead of it (a Docker VM
      // drifts by hundreds of milliseconds) would keep a token that expires at the database's now.
      await ctx.db
        .update(oauthTokens)
        .set({ expiresAt: sql`now() - interval '5 seconds'` })
        .where(eq(oauthTokens.kind, 'access'));
      calls.length = 0;
      const again = await client.callTool({ name: 'qualor_projects', arguments: {} });
      expect(again.isError ?? false).toBe(false);
      // The provider keeps the discovery state, so the refresh goes straight to the token endpoint.
      expect(calls).toEqual(['POST /mcp 401', 'POST /oauth/token 200', 'POST /mcp 200']);
      expect(store.tokens?.access_token).toMatch(/^qlr_oat_/);
      expect(store.tokens?.access_token).not.toBe(firstAccess);
      expect(store.savedTokens).toBe(2);
      await client.close();
    });
  }
});
