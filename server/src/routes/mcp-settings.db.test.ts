import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createTestContext,
  createUser,
  login,
  type Session,
  type TestContext,
} from '../../test/app';

describe('GET/PUT /api/v0/system/mcp', () => {
  let ctx: TestContext;
  let admin: Session;
  let user: Session;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const u = await createUser(ctx, { username: 'u1' });
    user = await login(ctx, u.username, u.password);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('shows the defaults and the endpoint URL', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/system/mcp',
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: true,
      reason: null,
      url: 'https://q.example/mcp',
      policy: { dcr: true, cimd: true, allowedClients: [] },
    });
  });

  it('saves a policy and refuses a malformed allow-list entry', async () => {
    const ok = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/system/mcp',
      headers: admin.headers,
      payload: { dcr: false, cimd: true, allowedClients: ['https://claude.ai/'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().policy).toEqual({
      dcr: false,
      cimd: true,
      allowedClients: ['https://claude.ai/'],
    });
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/system/mcp',
      headers: admin.headers,
      payload: { dcr: true, cimd: true, allowedClients: ['has space'] },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('is for instance administrators only', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/system/mcp',
      headers: user.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('reports PUBLIC_URL_MISSING without a public URL', async () => {
    const bare = await createTestContext();
    try {
      const a = await login(bare, 'admin', ADMIN_PASSWORD);
      const res = await bare.app.inject({
        method: 'GET',
        url: '/api/v0/system/mcp',
        headers: a.headers,
      });
      expect(res.json()).toMatchObject({ enabled: false, reason: 'PUBLIC_URL_MISSING', url: null });
    } finally {
      await bare.close();
    }
  });
});
