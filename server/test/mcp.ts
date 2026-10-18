import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import type { TestContext } from './app';

let rpcId = 0;

/**
 * One JSON-RPC request to `POST /mcp`, the way a 2025-era Streamable HTTP client sends it.
 *
 * Protocol finding (Task 9, SDK 2.0.0): the endpoint is stateless, so `tools/list` and
 * `tools/call` need no `initialize` first. Each request gets a fresh server instance, and the
 * stateless transport (no session id generator) skips the session and initialisation checks. The
 * transport does insist on `Accept` naming both `application/json` and `text/event-stream` (406
 * otherwise), even though the answer is always one JSON body.
 */
export async function mcpCall(
  ctx: TestContext,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  protocolVersion = '2025-11-25',
) {
  rpcId += 1;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: { jsonrpc: '2.0', id: rpcId, method, params },
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body ? res.json() : null,
  };
}

/** `tools/call`: the result's text blocks joined, its structured content and its error flag. */
export async function callTool(
  ctx: TestContext,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = await mcpCall(ctx, token, 'tools/call', { name, arguments: args });
  const result = res.body?.result as
    | {
        content: { type: string; text: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }
    | undefined;
  return {
    status: res.status,
    headers: res.headers,
    result,
    isError: result?.isError ?? false,
    text: result?.content.map((c) => c.text).join('\n') ?? '',
    structured: result?.structuredContent ?? null,
    error: (res.body?.error ?? null) as { code: number; message: string } | null,
  };
}

/** The SDK's own client over `app.inject`: `legacy` speaks 2025-11-25, the pin 2026-07-28. */
export async function sdkClient(
  app: FastifyInstance,
  token: string,
  mode: 'legacy' | { pin: '2026-07-28' },
): Promise<{ client: Client; statuses: number[] }> {
  const statuses: number[] = [];
  const fetchLike = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
      url: new URL(String(url)).pathname,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        authorization: `Bearer ${token}`,
      },
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    statuses.push(res.statusCode);
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
    return new Response(res.body === '' ? null : res.body, { status: res.statusCode, headers });
  };
  const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://q.example/mcp'), { fetch: fetchLike }),
  );
  return { client, statuses };
}
