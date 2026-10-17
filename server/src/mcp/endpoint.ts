import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteDeps } from '../app';
import type { OAuthPrincipal } from '../auth/principal';
import { ProblemError } from '../http/problem';
import { corsPreflight, installCors } from '../oauth/http';
import { resolveAccessToken } from '../oauth/grants';
import type { McpScope } from '../oauth/tokens';
import type { McpUrls } from '../oauth/urls';
import { callerFor } from './inject';
import { requiredScope, ToolError, type McpTool } from './tool';

declare module 'fastify' {
  interface FastifyRequest {
    mcpPrincipal?: Omit<OAuthPrincipal, 'scopes'>;
  }
}

type McpPrincipal = Omit<OAuthPrincipal, 'scopes'>;

const INSTRUCTIONS =
  'Qualor is a code quality and security server. Use qualor_gate_status to see what blocks a branch or merge request, ' +
  'qualor_issues and qualor_issue to read findings, fix the code, push, wait for CI to analyse the commit, then call ' +
  'qualor_gate_status again with the pushed commit SHA. Mark an issue false positive only with a reason a reviewer would accept.';

/** What an agent reads when a tool breaks for a reason that is not its own (the log has the rest). */
const UNEXPECTED = 'The tool failed unexpectedly. Try again later.';

/** Not forwarded to the SDK: credentials (it never verifies them) and framing of the raw body. */
const DROPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'content-length',
  'transfer-encoding',
  'connection',
  'host',
]);

/** A JSON-RPC error with no request id: the request never reached the protocol layer. */
function rpcError(reply: FastifyReply, status: number, code: number, message: string) {
  return reply
    .code(status)
    .type('application/json')
    .send({ jsonrpc: '2.0', id: null, error: { code, message } });
}

/**
 * The scope a `tools/call` in `body` needs and `granted` lacks, or null. Both eras carry the call
 * as a JSON-RPC request whose `params.name` names the tool (the 2026-07-28 envelope only adds
 * `params._meta`); a 2025-era batch is checked request by request. Anything else is left to the
 * SDK, which answers it in JSON-RPC.
 */
export function missingScope(
  body: unknown,
  toolScopes: ReadonlyMap<string, McpScope>,
  granted: readonly McpScope[],
): McpScope | null {
  for (const message of Array.isArray(body) ? (body as unknown[]) : [body]) {
    if (typeof message !== 'object' || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== 'tools/call' || typeof params !== 'object' || params === null) continue;
    const name = (params as { name?: unknown }).name;
    const needed = typeof name === 'string' ? toolScopes.get(name) : undefined;
    if (needed && !granted.includes(needed)) return needed;
  }
  return null;
}

/**
 * Spec §4.2: `POST /mcp`, stateless, one JSON response per request, for both protocol eras. The
 * bearer must be a live `qlr_oat_` (spec §4.3); a PAT, a session or nothing answers 401 with the
 * RFC 9728 challenge. A tools/call the token's scopes do not cover answers 403 insufficient_scope
 * before the SDK runs, so the client can step up its grant (spec §5).
 *
 * The SDK's 2025-era stateless fallback always streams (SSE); to keep JSON responses, 2025 traffic
 * is routed here with `isLegacyRequest` to a stateless transport with `enableJsonResponse`, and
 * the modern handler (`legacy: 'reject'`) serves 2026-07-28 traffic. One factory backs both, so the
 * eras cannot drift apart. The modern handler runs in `responseMode: 'auto'`: a single JSON body
 * unless a tool emits a message before its result, which none does (`'json'` would drop such
 * messages, and the SDK warns about it on the console at every handler creation).
 */
export const mcpEndpoint: FastifyPluginAsync<{
  deps: RouteDeps;
  urls: McpUrls;
  tools: readonly McpTool[];
  /** The `fix_quality_gate` prompt arrives in Task 12. */
  prompts: readonly unknown[];
  version: string;
}> = async (app, { deps, urls, tools, version }) => {
  // Framework failures (bad JSON, media type, size, rate limit) answer in JSON-RPC, the shape an
  // MCP client reads, never problem+json; the details stay in the log.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error instanceof ProblemError ? error.status : (error.statusCode ?? 500);
    if (status === 429) return rpcError(reply, 429, -32000, 'Too many requests; retry later');
    if (status === 400) return rpcError(reply, 400, -32700, 'Parse error');
    if (status >= 400 && status < 500) {
      return rpcError(reply, status, -32600, 'Invalid Request');
    }
    request.log.error({ err: error }, 'unhandled error');
    return rpcError(reply, 500, -32603, 'Internal error');
  });
  installCors(app, (path) => path === '/mcp');

  const challenge = (reply: FastifyReply, presented: boolean) =>
    reply
      .code(401)
      .header('cache-control', 'no-store')
      .header(
        'www-authenticate',
        presented
          ? `Bearer error="invalid_token", resource_metadata="${urls.resourceMetadata}"`
          : `Bearer resource_metadata="${urls.resourceMetadata}"`,
      )
      .send({ error: 'invalid_token', error_description: 'A valid access token is required' });

  const insufficientScope = (reply: FastifyReply, scope: McpScope) =>
    reply
      .code(403)
      .header('cache-control', 'no-store')
      .header(
        'www-authenticate',
        `Bearer error="insufficient_scope", scope="mcp:read mcp:write", resource_metadata="${urls.resourceMetadata}"`,
      )
      .send({ error: 'insufficient_scope', error_description: `This tool needs ${scope}` });

  const factory = (ctx: McpRequestContext): McpServer => {
    const extra = ctx.authInfo?.extra as { principal: McpPrincipal; request: FastifyRequest };
    const { principal, request } = extra;
    const server = new McpServer(
      { name: 'qualor', title: 'Qualor', version },
      { instructions: INSTRUCTIONS },
    );
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        },
        async (input: unknown) => {
          try {
            const call = callerFor(
              app,
              principal,
              tool.access,
              request.ip,
              `qualor-mcp (${principal.clientName})`,
            );
            const out = await tool.run(input as never, { call, principal });
            return {
              content: [{ type: 'text' as const, text: out.text }],
              structuredContent: out.structured,
            };
          } catch (err) {
            if (err instanceof ToolError) {
              return {
                isError: true,
                content: [{ type: 'text' as const, text: `${err.message} (${err.code})` }],
              };
            }
            request.log.error({ err, tool: tool.name }, 'MCP tool failed');
            return { isError: true, content: [{ type: 'text' as const, text: UNEXPECTED }] };
          }
        },
      );
    }
    return server;
  };

  const onerror = (err: Error) => app.log.warn({ err }, 'MCP request failed');
  const modern = createMcpHandler(factory, { legacy: 'reject', responseMode: 'auto', onerror });
  const legacy = async (
    webRequest: Request,
    authInfo: AuthInfo,
    parsedBody: unknown,
  ): Promise<Response> => {
    const server = factory({ era: 'legacy', authInfo, requestInfo: webRequest });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transport.onerror = onerror;
    await server.connect(transport);
    try {
      return await transport.handleRequest(webRequest, { authInfo, parsedBody });
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
  app.addHook('onClose', async () => {
    await modern.close();
  });

  const toolScopes = new Map(tools.map((t) => [t.name, requiredScope(t.access)]));

  app.options('/mcp', { config: { public: true } }, async (_request, reply) =>
    corsPreflight(reply),
  );

  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    config: { public: true },
    handler: async (_request, reply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Method not allowed.' },
        }),
  });

  app.post(
    '/mcp',
    {
      config: {
        public: true,
        // Spec §5: per grant; preHandler runs after the bearer check below set the principal.
        rateLimit: {
          max: 600,
          timeWindow: '1 minute',
          hook: 'preHandler',
          keyGenerator: (request: FastifyRequest) => request.mcpPrincipal?.grantId ?? request.ip,
        },
      },
      onRequest: async (request, reply) => {
        const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
        const principal = match?.[1] ? await resolveAccessToken(deps.db, match[1]) : null;
        if (!principal) return challenge(reply, request.headers.authorization !== undefined);
        request.mcpPrincipal = principal;
      },
    },
    async (request, reply) => {
      const principal = request.mcpPrincipal;
      if (!principal) return challenge(reply, false);
      const lacking = missingScope(request.body, toolScopes, principal.mcpScopes);
      if (lacking) return insufficientScope(reply, lacking);

      const headers = new Headers();
      for (const [k, v] of Object.entries(request.headers)) {
        if (DROPPED_HEADERS.has(k)) continue;
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const webRequest = new Request(urls.resource, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body ?? null),
      });
      const authInfo: AuthInfo = {
        token: 'redacted',
        clientId: principal.clientId,
        scopes: [...principal.mcpScopes],
        resource: new URL(urls.resource),
        extra: { principal, request },
      };
      const response = (await isLegacyRequest(webRequest, request.body))
        ? await legacy(webRequest, authInfo, request.body)
        : await modern.fetch(webRequest, { authInfo, parsedBody: request.body });
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'content-length') void reply.header(key, value);
      });
      const payload = Buffer.from(await response.arrayBuffer());
      return payload.length ? reply.send(payload) : reply.send();
    },
  );
};
