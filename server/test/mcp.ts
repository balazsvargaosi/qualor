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
