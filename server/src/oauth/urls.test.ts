import { describe, expect, it } from 'vitest';
import { mcpUrls } from './urls';

describe('mcpUrls', () => {
  it('is null without a public URL', () => {
    expect(mcpUrls(null)).toBeNull();
  });

  it('derives every URL from the public URL, also under a path', () => {
    expect(mcpUrls('https://q.example.com/qualor')).toEqual({
      issuer: 'https://q.example.com/qualor',
      resource: 'https://q.example.com/qualor/mcp',
      resourceMetadata: 'https://q.example.com/.well-known/oauth-protected-resource/qualor/mcp',
      authorizationServerMetadata:
        'https://q.example.com/.well-known/oauth-authorization-server/qualor',
      authorize: 'https://q.example.com/qualor/oauth/authorize',
      token: 'https://q.example.com/qualor/oauth/token',
      revoke: 'https://q.example.com/qualor/oauth/revoke',
      register: 'https://q.example.com/qualor/oauth/register',
    });
  });

  it('puts .well-known at the root for a root public URL', () => {
    const urls = mcpUrls('https://review.qualor.dev')!;
    expect(urls.resourceMetadata).toBe(
      'https://review.qualor.dev/.well-known/oauth-protected-resource/mcp',
    );
    expect(urls.authorizationServerMetadata).toBe(
      'https://review.qualor.dev/.well-known/oauth-authorization-server',
    );
  });
});
