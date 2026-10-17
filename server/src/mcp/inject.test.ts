import { describe, expect, it } from 'vitest';
import { mcpUserAgent, routeAllowed } from './inject';

const ISSUE = '/api/v0/issues/0b6c5b9e-0000-4000-8000-000000000001';

describe('routeAllowed (spec §4.4, ruling R1)', () => {
  it('lets every tool GET under /api/v0', () => {
    for (const access of ['read', 'ai', 'write'] as const) {
      expect(routeAllowed(access, 'GET', '/api/v0/projects')).toBe(true);
    }
  });

  it('lets read tools POST nothing', () => {
    expect(routeAllowed('read', 'POST', `${ISSUE}/ai/explain`)).toBe(false);
    expect(routeAllowed('read', 'POST', `${ISSUE}/transition`)).toBe(false);
  });

  it('lets AI tools POST only explain and fix', () => {
    expect(routeAllowed('ai', 'POST', `${ISSUE}/ai/explain`)).toBe(true);
    expect(routeAllowed('ai', 'POST', `${ISSUE}/ai/fix`)).toBe(true);
    expect(routeAllowed('ai', 'POST', `${ISSUE}/ai/triage`)).toBe(false);
    expect(routeAllowed('ai', 'POST', `${ISSUE}/transition`)).toBe(false);
    expect(routeAllowed('ai', 'POST', '/api/v0/ai-requests/x/post')).toBe(false);
  });

  it('lets the write tool POST only a single-issue transition', () => {
    expect(routeAllowed('write', 'POST', `${ISSUE}/transition`)).toBe(true);
    expect(routeAllowed('write', 'POST', '/api/v0/issues/bulk-transition')).toBe(false);
    expect(routeAllowed('write', 'POST', '/api/v0/tokens')).toBe(false);
  });

  it('refuses paths outside /api/v0 and path tricks', () => {
    expect(routeAllowed('read', 'GET', '/mcp')).toBe(false);
    expect(routeAllowed('write', 'POST', `${ISSUE}/transition/../../tokens`)).toBe(false);
    expect(routeAllowed('read', 'GET', '/api/v0/../oauth/token')).toBe(false);
    expect(routeAllowed('read', 'GET', '/api/v0//projects')).toBe(false);
    expect(routeAllowed('read', 'GET', '/api/v0/projects?x=1')).toBe(false);
    expect(routeAllowed('read', 'GET', '/api/v0/%2e%2e/oauth/token')).toBe(false);
  });
});

describe('mcpUserAgent', () => {
  it('names the client', () => {
    expect(mcpUserAgent('Claude Code')).toBe('qualor-mcp (Claude Code)');
  });

  it('drops control characters and caps the length', () => {
    expect(mcpUserAgent('evil\r\nX-Injected: 1\u0000\u007f\u0085')).toBe(
      'qualor-mcp (evilX-Injected: 1)',
    );
    expect(mcpUserAgent('a'.repeat(500))).toBe(`qualor-mcp (${'a'.repeat(64)})`);
  });
});
