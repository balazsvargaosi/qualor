import type { FastifyError, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { ProblemError } from '../http/problem';
import { anonymousActor } from '../audit/recorder';
import { LoginThrottle } from '../auth/throttle';
import { registerDcrClient, resolveClient } from './clients';
import {
  authorizationRedirect,
  createPendingRequest,
  exchangeCode,
  parseScopes,
  refresh,
  revokeToken,
  type OnGrantRevoked,
  type TokenResult,
} from './grants';
import {
  corsPreflight,
  errorPage,
  hasDuplicate,
  installCors,
  installFormParser,
  oauthError,
  param,
} from './http';
import { readMcpPolicy } from './policy';
import { redirectUriAllowed, redirectUriMatches } from './redirect';
import { isCodeChallenge, MCP_SCOPES } from './tokens';
import type { McpUrls } from './urls';

/** `/mcp` has its own CORS in the MCP plugin (mcp/endpoint.ts). */
const CORS_PATHS = new Set(['/oauth/register', '/oauth/token', '/oauth/revoke']);

/** Authorize calls one address may make per minute; each inserts a pending request. */
const AUTHORIZE_PER_MINUTE = 60;
/** Of those, the ones that fetch a client's metadata document (a CIMD cache miss). */
const CIMD_FETCHES = { max: 10, windowMs: 60_000 };

const TOO_MANY = 'Too many connection attempts from this address. Try again in a minute.';

const registrationSchema = z.looseObject({
  redirect_uris: z.array(z.string().max(2048)).max(20),
  client_name: z.string().min(1).max(200).optional(),
  client_uri: z.string().max(2048).optional(),
  logo_uri: z.string().max(2048).optional(),
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: z.array(z.string().max(64)).max(10).optional(),
  response_types: z.array(z.string().max(64)).max(10).optional(),
});

function clientErrorText(
  error: 'unknown_client' | 'client_not_allowed' | 'cimd_disabled' | 'cimd_invalid',
): string {
  switch (error) {
    case 'unknown_client':
      return 'This client is not registered with this Qualor server.';
    case 'client_not_allowed':
      return 'The administrator of this Qualor server does not allow this client.';
    case 'cimd_disabled':
      return 'This Qualor server does not accept clients identified by a metadata URL.';
    default:
      return 'The client’s metadata could not be read or is not valid.';
  }
}

const httpsOrNull = (uri: string | undefined): string | null =>
  uri?.startsWith('https://') ? uri : null;

/** Spec §4.1: the authorization server's endpoints, outside /api/v0, all public. */
export const oauthRoutes: FastifyPluginAsync<{ deps: RouteDeps; urls: McpUrls }> = async (
  app,
  { deps, urls },
) => {
  // Spec §4.1: framework-level failures (rate limit, bad JSON, size, media type) answer in OAuth
  // JSON here too. Encapsulated in this plugin; /api/v0 keeps problem+json.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error instanceof ProblemError ? error.status : (error.statusCode ?? 500);
    // The browser endpoint answers in pages, never a redirect to a client not yet trusted.
    if (status === 429 && request.routeOptions.url === '/oauth/authorize') {
      return errorPage(reply, 429, 'Cannot connect', TOO_MANY);
    }
    if (status === 429) {
      return oauthError(reply, 429, 'temporarily_unavailable', 'Too many requests; retry later');
    }
    if (status >= 400 && status < 500) {
      return oauthError(reply, status, 'invalid_request', 'The request could not be understood');
    }
    request.log.error({ err: error }, 'unhandled error');
    return oauthError(reply, 500, 'server_error', 'Internal server error');
  });
  installFormParser(app);
  installCors(app, (path) => CORS_PATHS.has(path) || path.startsWith('/.well-known/'));
  const wellKnownAs = new URL(urls.authorizationServerMetadata).pathname;
  const wellKnownPr = new URL(urls.resourceMetadata).pathname;
  for (const path of [...CORS_PATHS, wellKnownAs, wellKnownPr]) {
    app.options(path, { config: { public: true } }, async (_request, reply) =>
      corsPreflight(reply),
    );
  }

  app.get(wellKnownAs, { config: { public: true } }, async () => {
    const policy = await readMcpPolicy(deps.db);
    return {
      issuer: urls.issuer,
      authorization_endpoint: urls.authorize,
      token_endpoint: urls.token,
      revocation_endpoint: urls.revoke,
      ...(policy.dcr ? { registration_endpoint: urls.register } : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...MCP_SCOPES],
      client_id_metadata_document_supported: policy.cimd,
      authorization_response_iss_parameter_supported: true,
    };
  });

  app.get(wellKnownPr, { config: { public: true } }, async () => ({
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Qualor',
  }));

  // Each address's CIMD fetches (outbound requests, then a client upsert) are counted on their own.
  const cimdFetches = new LoginThrottle(CIMD_FETCHES);

  // Spec §6 steps 1-3: validate, then hand the browser to the consent screen. Until the client and
  // its redirect URI are trusted, errors are pages that never redirect (RFC 6749 §4.1.2.1).
  // Unauthenticated and each call writes a row, so it is limited per address.
  app.get(
    '/oauth/authorize',
    { config: { public: true, rateLimit: { max: AUTHORIZE_PER_MINUTE, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const str = (k: string) => (typeof q[k] === 'string' ? q[k] : null);
      // Present but not a single string (a repeated parameter): never fall back to a default.
      const malformed = (k: string) => k in q && typeof q[k] !== 'string';
      if (malformed('client_id') || malformed('redirect_uri')) {
        return errorPage(reply, 400, 'Cannot connect', 'The request is malformed.');
      }
      const clientIdParam = str('client_id');
      if (!clientIdParam)
        return errorPage(reply, 400, 'Cannot connect', 'The request names no client.');
      const policy = await readMcpPolicy(deps.db);
      const resolved = await resolveClient(
        { db: deps.db, policy, allowFetch: () => cimdFetches.hit(request.ip) },
        clientIdParam,
      );
      if (!resolved.ok) {
        const { error } = resolved;
        if (error === 'cimd_rate_limited') {
          return errorPage(reply.header('retry-after', '60'), 429, 'Cannot connect', TOO_MANY);
        }
        return errorPage(reply, 400, 'Cannot connect', clientErrorText(error));
      }
      const client = resolved.client;
      const presented = str('redirect_uri');
      const redirectUri =
        presented ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
      if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
        return errorPage(
          reply,
          400,
          'Cannot connect',
          'The redirect URI is not registered for this client.',
        );
      }
      const state = str('state');
      if (state !== null && state.length > 2048) {
        return errorPage(reply, 400, 'Cannot connect', 'The state parameter is too long.');
      }
      const fail = (error: string, description: string) =>
        reply.header('cache-control', 'no-store').redirect(
          authorizationRedirect(redirectUri, {
            error,
            error_description: description,
            state,
            iss: urls.issuer,
          }),
          302,
        );
      const REST = [
        'response_type',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method',
        'resource',
      ];
      if (REST.some(malformed)) return fail('invalid_request', 'A parameter is repeated');
      if (str('response_type') !== 'code')
        return fail('unsupported_response_type', 'Only code is supported');
      const challenge = str('code_challenge');
      if (!challenge || !isCodeChallenge(challenge) || str('code_challenge_method') !== 'S256') {
        return fail('invalid_request', 'PKCE with S256 is required');
      }
      const scopes = parseScopes(str('scope'));
      if (!scopes) return fail('invalid_scope', 'Only mcp:read and mcp:write exist');
      const resource = str('resource') ?? urls.resource;
      if (resource !== urls.resource)
        return fail('invalid_target', `The only resource is ${urls.resource}`);
      const pending = await createPendingRequest(deps.db, {
        clientRowId: client.id,
        redirectUri,
        state,
        scopes,
        codeChallenge: challenge,
        resource,
      });
      // The UI lives next to the API under the public URL's path (the proxy strips it before us).
      const basePath = new URL(urls.issuer).pathname.replace(/\/+$/, '');
      return reply
        .header('cache-control', 'no-store')
        .redirect(`${basePath}/oauth/consent?request=${pending.id}`, 302);
    },
  );

  app.post(
    '/oauth/register',
    { config: { public: true, rateLimit: { max: 20, timeWindow: 3_600_000 } } },
    async (request, reply) => {
      const policy = await readMcpPolicy(deps.db);
      if (!policy.dcr) {
        return oauthError(reply, 403, 'access_denied', 'Dynamic client registration is turned off');
      }
      const parsed = registrationSchema.safeParse(request.body);
      if (!parsed.success) {
        return oauthError(reply, 400, 'invalid_client_metadata', 'Malformed metadata');
      }
      const body = parsed.data;
      if (body.redirect_uris.length === 0 || !body.redirect_uris.every(redirectUriAllowed)) {
        return oauthError(
          reply,
          400,
          'invalid_redirect_uri',
          'A redirect URI is missing or not allowed',
        );
      }
      if ((body.token_endpoint_auth_method ?? 'none') !== 'none') {
        return oauthError(
          reply,
          400,
          'invalid_client_metadata',
          'Only public clients (none) are supported',
        );
      }
      const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
      if (!grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
        return oauthError(reply, 400, 'invalid_client_metadata', 'Unsupported grant type');
      }
      if (!(body.response_types ?? ['code']).every((r) => r === 'code')) {
        return oauthError(reply, 400, 'invalid_client_metadata', 'Unsupported response type');
      }
      const name = body.client_name ?? 'Unnamed MCP client';
      const client = await deps.db.transaction(async (tx) => {
        const created = await registerDcrClient(tx, {
          name,
          redirectUris: body.redirect_uris,
          logoUri: httpsOrNull(body.logo_uri),
          clientUri: httpsOrNull(body.client_uri),
          metadata: {
            redirect_uris: body.redirect_uris,
            client_name: body.client_name,
            client_uri: body.client_uri,
            logo_uri: body.logo_uri,
            token_endpoint_auth_method: body.token_endpoint_auth_method,
            grant_types: body.grant_types,
            response_types: body.response_types,
          },
        });
        await deps.audit.record(tx, anonymousActor(request, null), [
          {
            action: 'oauth.client_registered',
            target: { type: 'oauth_client', id: created.id, label: name },
            details: { clientId: created.clientId, name, source: 'dcr' },
          },
        ]);
        return created;
      });
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .send({
          client_id: client.clientId,
          client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
          client_name: name,
          redirect_uris: client.redirectUris,
          grant_types: grants,
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
    },
  );

  // No signed-in user acts here (a reuse is detected, a revocation comes from the client); the
  // caller's address and user agent are kept, and the event commits with the revocation.
  const onRevoked =
    (request: FastifyRequest): OnGrantRevoked =>
    (tx, grant) =>
      deps.audit.recordOrSkipWhenAnchorMalformed(tx, anonymousActor(request, null), [
        {
          action: 'oauth.grant_revoked',
          target: { type: 'oauth_grant', id: grant.id, label: null },
          details: { clientId: grant.clientId, reason: grant.reason },
        },
      ]);

  // Spec §6 steps 7-8: public clients, so no client authentication; PKCE and the code bind the call.
  app.post(
    '/oauth/token',
    { config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body;
      if (hasDuplicate(body)) {
        return oauthError(reply, 400, 'invalid_request', 'A parameter was repeated');
      }
      const grantType = param(body, 'grant_type');
      const clientId = param(body, 'client_id');
      const resource = param(body, 'resource');
      const answer = (result: TokenResult) => {
        if (!result.ok) return oauthError(reply, 400, result.error, 'The grant is not valid');
        return reply
          .header('cache-control', 'no-store')
          .header('pragma', 'no-cache')
          .send({
            access_token: result.accessToken,
            token_type: 'Bearer',
            expires_in: result.expiresIn,
            refresh_token: result.refreshToken,
            scope: result.scopes.join(' '),
          });
      };
      if (grantType === 'authorization_code') {
        const code = param(body, 'code');
        const verifier = param(body, 'code_verifier');
        if (!code || !verifier || !clientId) {
          return oauthError(
            reply,
            400,
            'invalid_request',
            'code, code_verifier and client_id are required',
          );
        }
        return answer(
          await exchangeCode(
            deps.db,
            {
              code,
              clientId,
              verifier,
              redirectUri: param(body, 'redirect_uri'),
              resource,
              resourceExpected: urls.resource,
            },
            new Date(),
            onRevoked(request),
          ),
        );
      }
      if (grantType === 'refresh_token') {
        const token = param(body, 'refresh_token');
        if (!token || !clientId) {
          return oauthError(
            reply,
            400,
            'invalid_request',
            'refresh_token and client_id are required',
          );
        }
        const scopeParam = param(body, 'scope');
        const scopes = scopeParam === null ? null : parseScopes(scopeParam);
        if (scopeParam !== null && !scopes) {
          return oauthError(reply, 400, 'invalid_scope', 'Unknown scope');
        }
        return answer(
          await refresh(
            deps.db,
            { refreshToken: token, clientId, scopes, resource, resourceExpected: urls.resource },
            new Date(),
            onRevoked(request),
          ),
        );
      }
      return oauthError(
        reply,
        400,
        'unsupported_grant_type',
        'authorization_code or refresh_token',
      );
    },
  );

  // RFC 7009: always 200, whatever the token was.
  app.post(
    '/oauth/revoke',
    { config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (hasDuplicate(request.body)) {
        return oauthError(reply, 400, 'invalid_request', 'A parameter was repeated');
      }
      const token = param(request.body, 'token');
      const clientId = param(request.body, 'client_id');
      if (token && clientId) {
        await revokeToken(deps.db, { token, clientId }, new Date(), onRevoked(request));
      }
      return reply.code(200).header('cache-control', 'no-store').send();
    },
  );
};
