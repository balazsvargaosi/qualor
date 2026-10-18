import { pkceS256, type McpScope } from '../src/oauth/tokens';
import { nextIp, type Session, type TestContext } from './app';

export const TEST_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
export const TEST_REDIRECT = 'http://127.0.0.1/callback';

/** Registers a public client through DCR; returns its client id. */
export async function registerClient(
  ctx: TestContext,
  redirectUri = TEST_REDIRECT,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/oauth/register',
    remoteAddress: nextIp(),
    payload: { client_name: 'Test agent', redirect_uris: [redirectUri] },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { client_id: string }).client_id;
}

/** Drives authorize and the consent API as `session`; returns the code and what redeems it. */
export async function authorizeAndApprove(
  ctx: TestContext,
  session: Session,
  clientId: string,
  scopes: McpScope[] = ['mcp:read', 'mcp:write'],
): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: TEST_REDIRECT,
    state: 's',
    scope: scopes.join(' '),
    code_challenge: pkceS256(TEST_VERIFIER),
    code_challenge_method: 'S256',
  });
  const auth = await ctx.app.inject({
    method: 'GET',
    url: `/oauth/authorize?${q}`,
    remoteAddress: nextIp(),
  });
  const id = new URL(auth.headers.location as string, 'https://x').searchParams.get('request');
  if (!id) throw new Error(`authorize failed: ${auth.statusCode} ${auth.body}`);
  // Reading binds the request to this user.
  await ctx.app.inject({
    method: 'GET',
    url: `/api/v0/oauth/requests/${id}`,
    headers: session.headers,
  });
  const decision = await ctx.app.inject({
    method: 'POST',
    url: `/api/v0/oauth/requests/${id}/decision`,
    headers: session.headers,
    payload: { decision: 'approve', scopes },
  });
  const code = new URL((decision.json() as { redirectTo: string }).redirectTo).searchParams.get(
    'code',
  );
  if (!code) throw new Error(`decision failed: ${decision.statusCode} ${decision.body}`);
  return { code, verifier: TEST_VERIFIER, redirectUri: TEST_REDIRECT };
}

export function tokenRequest(
  ctx: TestContext,
  form: Record<string, string>,
): Promise<Awaited<ReturnType<TestContext['app']['inject']>>> {
  return ctx.app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });
}

/** Runs the whole flow for a fresh client; returns its first access and refresh tokens. */
export async function oauthTokens(
  ctx: TestContext,
  session: Session,
  scopes: McpScope[] = ['mcp:read', 'mcp:write'],
): Promise<{ clientId: string; accessToken: string; refreshToken: string }> {
  const clientId = await registerClient(ctx);
  const { code, verifier, redirectUri } = await authorizeAndApprove(ctx, session, clientId, scopes);
  const res = await tokenRequest(ctx, {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (res.statusCode !== 200) throw new Error(`token failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { access_token: string; refresh_token: string };
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}
