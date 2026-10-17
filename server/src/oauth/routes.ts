import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { ProblemError } from '../http/problem';
import { anonymousActor } from '../audit/recorder';
import { registerDcrClient } from './clients';
import { corsPreflight, installCors, installFormParser, oauthError } from './http';
import { readMcpPolicy } from './policy';
import { redirectUriAllowed } from './redirect';
import { MCP_SCOPES } from './tokens';
import type { McpUrls } from './urls';

const CORS_PATHS = new Set(['/oauth/register', '/oauth/token', '/oauth/revoke', '/mcp']);

const registrationSchema = z.looseObject({
  redirect_uris: z.array(z.string().max(2048)).max(20),
  client_name: z.string().min(1).max(200).optional(),
  client_uri: z.string().max(2048).optional(),
  logo_uri: z.string().max(2048).optional(),
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: z.array(z.string().max(64)).max(10).optional(),
  response_types: z.array(z.string().max(64)).max(10).optional(),
});

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
};
