import { describe, expect, it } from 'vitest';
import { redirectTargetLabel, redirectUriAllowed, redirectUriMatches } from './redirect';

describe('redirectUriAllowed (spec §7, ruling R5)', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:53682/callback',
    'http://localhost:3000/cb',
    'http://[::1]:8080/cb',
    'cursor://anysphere.cursor-retrieval/oauth/callback',
    'vscode://vscode.github-authentication/did-authenticate',
  ])('allows %s', (uri) => {
    expect(redirectUriAllowed(uri)).toBe(true);
  });

  it.each([
    'http://example.com/cb',
    'http://192.168.1.10/cb',
    'https://example.com/cb#frag',
    'https://user:pw@example.com/cb',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'not a url',
    'ftp://example.com/cb',
    'ws://127.0.0.1/cb',
    'wss://example.com/cb',
    'view-source:https://a.example/',
    'intent://x#Intent;end',
    'https://a.example/\ncb',
    'https://a.example/\tcb',
    'https://' + 'a'.repeat(2050) + '.com/',
  ])('refuses %s', (uri) => {
    expect(redirectUriAllowed(uri)).toBe(false);
  });
});

describe('redirectUriMatches', () => {
  it('matches exactly', () => {
    expect(redirectUriMatches(['https://a.example/cb'], 'https://a.example/cb')).toBe(true);
    expect(redirectUriMatches(['https://a.example/cb'], 'https://a.example/cb/')).toBe(false);
    expect(redirectUriMatches(['https://a.example/cb'], 'https://a.example/cb?x=1')).toBe(false);
  });

  it('ignores the port of a loopback URI only (RFC 8252 §7.3)', () => {
    expect(redirectUriMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:61234/cb')).toBe(true);
    expect(redirectUriMatches(['http://localhost:1/cb'], 'http://localhost:2/cb')).toBe(true);
    expect(redirectUriMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:61234/other')).toBe(false);
    expect(redirectUriMatches(['https://a.example:1/cb'], 'https://a.example:2/cb')).toBe(false);
    expect(redirectUriMatches(['http://127.0.0.1/cb'], 'http://localhost/cb')).toBe(false);
  });
});

describe('redirectUriMatches (presented URI must itself be allowed)', () => {
  it('refuses user info or a fragment on loopback', () => {
    expect(redirectUriMatches(['http://127.0.0.1/cb'], 'http://u:p@127.0.0.1:5/cb')).toBe(false);
    expect(redirectUriMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:5/cb#x')).toBe(false);
    expect(redirectUriMatches(['javascript:alert(1)'], 'javascript:alert(1)')).toBe(false);
  });
});

describe('redirectTargetLabel', () => {
  it('names the host of https and the whole URI otherwise', () => {
    expect(redirectTargetLabel('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai');
    expect(redirectTargetLabel('http://127.0.0.1:5000/cb')).toBe('this computer (127.0.0.1)');
    expect(redirectTargetLabel('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(
      'cursor://anysphere.cursor-retrieval/oauth/callback',
    );
  });
});
