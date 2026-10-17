import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addMember,
  bearer,
  createProject,
  createTestContext,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { callTool, mcpCall } from '../../test/mcp';
import { oauthTokens as runOAuth } from '../../test/oauth';
import type { RouteDeps } from '../app';
import { users } from '../db/schema';
import { VERSION } from '../index';
import { mcpUrls } from '../oauth/urls';
import { mcpEndpoint } from './endpoint';
import { InternalCalls } from './internal';
import type { McpTool } from './tool';

const RESOURCE_METADATA = 'https://q.example/.well-known/oauth-protected-resource/mcp';

/** The SDK's own client over `app.inject`: `legacy` speaks 2025-11-25, the pin 2026-07-28. */
async function sdkClient(
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

describe('POST /mcp', () => {
  let ctx: TestContext;
  let alice: Session;
  let readToken: string;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const admin = await login(ctx, 'admin', 'correct horse battery staple');
    const a = await createUser(ctx, { username: 'alice' });
    alice = await login(ctx, a.username, a.password);
    const org = await organizationId(ctx, 'default');
    await addMember(ctx, org, a.id, 'member');
    await createProject(ctx, admin, { organizationId: org, key: 'shop', name: 'Shop' });
    await createProject(ctx, admin, { organizationId: org, key: 'blog', name: 'Blog' });
    readToken = (await runOAuth(ctx, alice, ['mcp:read'])).accessToken;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('answers 401 with the resource metadata challenge without a token', async () => {
    const res = await mcpCall(ctx, null, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`);
    expect(res.body).toMatchObject({ error: 'invalid_token' });
    const garbage = await mcpCall(ctx, 'qlr_oat_nonsense', 'tools/list');
    expect(garbage.status).toBe(401);
  });

  it('refuses a PAT and a session cookie', async () => {
    const pat = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/tokens',
      headers: alice.headers,
      payload: { name: 'p', scopes: ['admin'] },
    });
    expect(pat.statusCode).toBe(201);
    expect((await mcpCall(ctx, pat.json().token, 'tools/list')).status).toBe(401);
    const cookie = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...alice.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(cookie.statusCode).toBe(401);
  });

  it('answers the 2025 initialize handshake with the server version and instructions', async () => {
    const res = await mcpCall(ctx, readToken, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.result).toMatchObject({
      serverInfo: { name: 'qualor', version: VERSION },
      instructions: expect.stringContaining('qualor_gate_status'),
    });
  });

  it('lists the tools with their read-only hints', async () => {
    const res = await mcpCall(ctx, readToken, 'tools/list');
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as { name: string; annotations?: unknown }[];
    expect(tools.find((t) => t.name === 'qualor_projects')).toMatchObject({
      annotations: { readOnlyHint: true },
    });
  });

  it('lists the projects the user can see', async () => {
    const r = await callTool(ctx, readToken, 'qualor_projects', {});
    expect(r.status).toBe(200);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('shop');
    expect(r.structured).toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ key: 'shop', name: 'Shop' })]),
    });
  });

  it('filters the projects by part of a key or name', async () => {
    const r = await callTool(ctx, readToken, 'qualor_projects', { query: 'blo' });
    expect(r.structured).toEqual({
      projects: [{ id: expect.any(String), key: 'blog', name: 'Blog' }],
      truncated: false,
    });
    const none = await callTool(ctx, readToken, 'qualor_projects', { query: 'zzz' });
    expect(none.text).toBe('No projects you can see match.');
  });

  it('refuses arguments outside the input schema', async () => {
    const r = await callTool(ctx, readToken, 'qualor_projects', { query: '' });
    expect(r.status).toBe(200);
    expect(r.isError || r.error !== null).toBe(true);
  });

  it('answers 405 to GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await ctx.app.inject({ method, url: '/mcp', headers: bearer(readToken) });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  for (const mode of ['legacy', { pin: '2026-07-28' }] as const) {
    it(`serves the SDK client in the ${typeof mode === 'string' ? '2025' : mode.pin} era`, async () => {
      const { client } = await sdkClient(ctx.app, readToken, mode);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain('qualor_projects');
        const r = await client.callTool({ name: 'qualor_projects', arguments: { query: 'shop' } });
        expect(r.structuredContent).toMatchObject({ projects: [{ key: 'shop' }] });
      } finally {
        await client.close();
      }
    });
  }

  it('answers malformed bodies in JSON-RPC, never problem+json', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...bearer(readToken), 'content-type': 'application/json' },
      payload: '{"jsonrpc":',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/json');
    expect(bad.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    const form = await ctx.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...bearer(readToken), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    });
    expect(form.statusCode).toBe(415);
    expect(form.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
  });

  it('stops a deactivated user at once (Review Focus 5)', async () => {
    const b = await createUser(ctx, { username: 'bob' });
    const bob = await login(ctx, b.username, b.password);
    const t = (await runOAuth(ctx, bob, ['mcp:read'])).accessToken;
    expect((await mcpCall(ctx, t, 'tools/list')).status).toBe(200);
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, b.id));
    expect((await mcpCall(ctx, t, 'tools/list')).status).toBe(401);
  });

  it('allows CORS for browser clients', async () => {
    const res = await mcpCall(ctx, readToken, 'tools/list');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-expose-headers']).toContain('www-authenticate');
    const denied = await mcpCall(ctx, null, 'tools/list');
    expect(denied.headers['access-control-allow-origin']).toBe('*');
    const preflight = await ctx.app.inject({ method: 'OPTIONS', url: '/mcp' });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
  });
});

describe('POST /mcp without QUALOR_PUBLIC_URL', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: null } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('is not there at all', async () => {
    expect((await mcpCall(ctx, null, 'tools/list')).status).toBe(404);
  });
});

/**
 * The scope check and the route restriction need tools the catalogue does not have yet (a write
 * tool, a tool that misbehaves), so they run on a bare app with only the endpoint, over the same
 * database the OAuth flow wrote its tokens to.
 */
describe('POST /mcp scope and route checks', () => {
  let ctx: TestContext;
  let bare: FastifyInstance;
  let readToken: string;
  let writeToken: string;
  const ran: string[] = [];
  const empty = z.object({});
  const tools: McpTool[] = [
    {
      name: 'test_write',
      title: 'Write',
      description: 'Needs mcp:write',
      access: 'write',
      inputSchema: empty,
      async run() {
        ran.push('test_write');
        return { text: 'wrote', structured: {} };
      },
    },
    {
      name: 'test_sneaky',
      title: 'Sneaky',
      description: 'A read tool that POSTs',
      access: 'read',
      inputSchema: empty,
      async run(_input, { call }) {
        await call.post('/api/v0/tokens', { name: 'x', scopes: ['admin'] });
        return { text: 'unreachable', structured: {} };
      },
    },
  ];

  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const a = await createUser(ctx, { username: 'carol' });
    const carol = await login(ctx, a.username, a.password);
    readToken = (await runOAuth(ctx, carol, ['mcp:read'])).accessToken;
    writeToken = (await runOAuth(ctx, carol, ['mcp:read', 'mcp:write'])).accessToken;
    bare = Fastify();
    bare.decorate('internalCalls', new InternalCalls());
    const urls = mcpUrls('https://q.example');
    if (!urls) throw new Error('no urls');
    await bare.register(mcpEndpoint, {
      deps: { db: ctx.db } as RouteDeps,
      urls,
      tools,
      prompts: [],
      version: VERSION,
    });
    await bare.ready();
  });
  afterAll(async () => {
    await bare.close();
    await ctx.close();
  });

  const call = (token: string, name: string) =>
    mcpCall({ ...ctx, app: bare }, token, 'tools/call', { name, arguments: {} });

  it('answers a write tool on an mcp:read token with 403 insufficient_scope', async () => {
    const res = await call(readToken, 'test_write');
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer error="insufficient_scope", scope="mcp:read mcp:write", resource_metadata="${RESOURCE_METADATA}"`,
    );
    expect(res.body).toMatchObject({ error: 'insufficient_scope' });
    expect(ran).toEqual([]);
  });

  it('runs the write tool on an mcp:write token', async () => {
    const res = await call(writeToken, 'test_write');
    expect(res.status).toBe(200);
    expect(res.body.result.content).toEqual([{ type: 'text', text: 'wrote' }]);
    expect(ran).toEqual(['test_write']);
  });

  it('checks the scope in the 2026-07-28 era too', async () => {
    const { client, statuses } = await sdkClient(bare, readToken, { pin: '2026-07-28' });
    try {
      await expect(client.callTool({ name: 'test_write', arguments: {} })).rejects.toThrow();
      expect(statuses.at(-1)).toBe(403);
      expect(ran).toEqual(['test_write']);
    } finally {
      await client.close();
    }
  });

  it('turns a call to an undeclared route into an opaque tool error', async () => {
    const res = await call(writeToken, 'test_sneaky');
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The tool failed unexpectedly. Try again later.' }],
    });
    expect(bare.internalCalls.size()).toBe(0);
  });
});
