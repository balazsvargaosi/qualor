import { describe, expect, it } from 'vitest';
import { missingScope } from './endpoint';

describe('missingScope (the tools/call check before the SDK runs)', () => {
  const scopes = new Map([
    ['qualor_projects', 'mcp:read' as const],
    ['qualor_transition', 'mcp:write' as const],
  ]);
  const call = (name: string, extra: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: {}, ...extra },
  });

  it('names the scope a write tool needs that the token lacks', () => {
    expect(missingScope(call('qualor_transition'), scopes, ['mcp:read'])).toBe('mcp:write');
    expect(missingScope(call('qualor_transition'), scopes, ['mcp:read', 'mcp:write'])).toBeNull();
    expect(missingScope(call('qualor_projects'), scopes, ['mcp:read'])).toBeNull();
  });

  it('checks every request of a 2025-era batch', () => {
    const batch = [call('qualor_projects'), call('qualor_transition')];
    expect(missingScope(batch, scopes, ['mcp:read'])).toBe('mcp:write');
  });

  it('checks a 2026-07-28 request, whose envelope rides in params._meta', () => {
    const modern = call('qualor_transition', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    expect(missingScope(modern, scopes, ['mcp:read'])).toBe('mcp:write');
  });

  it('leaves other methods, unknown tools and junk to the SDK', () => {
    expect(missingScope({ method: 'tools/list' }, scopes, [])).toBeNull();
    expect(missingScope(call('nope'), scopes, [])).toBeNull();
    expect(missingScope('junk', scopes, [])).toBeNull();
    expect(missingScope(null, scopes, [])).toBeNull();
    expect(missingScope({ method: 'tools/call', params: { name: 7 } }, scopes, [])).toBeNull();
  });
});
