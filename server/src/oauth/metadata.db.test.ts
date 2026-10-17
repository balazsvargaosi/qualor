import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/app';

describe('OAuth metadata (RFC 8414, RFC 9728)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('publishes the authorization server metadata', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.json()).toEqual({
      issuer: 'https://q.example',
      authorization_endpoint: 'https://q.example/oauth/authorize',
      token_endpoint: 'https://q.example/oauth/token',
      revocation_endpoint: 'https://q.example/oauth/revoke',
      registration_endpoint: 'https://q.example/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:read', 'mcp:write'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('publishes the protected resource metadata for /mcp', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp',
    });
    expect(res.json()).toEqual({
      resource: 'https://q.example/mcp',
      authorization_servers: ['https://q.example'],
      scopes_supported: ['mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Qualor',
    });
  });

  it('answers a CORS preflight', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/oauth/token',
      headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('does not exist without a public URL', async () => {
    const bare = await createTestContext();
    try {
      const res = await bare.app.inject({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
