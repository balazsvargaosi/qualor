import { describe, expect, it } from 'vitest';
import type { OutboundResult } from '../http/outbound';
import { fetchCimd, isCimdClientId } from './cimd';

const URL_ = 'https://cursor.example/oauth/client.json';
const answer =
  (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  async (): Promise<OutboundResult> => ({
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });
const doc = {
  client_id: URL_,
  client_name: 'Cursor',
  redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback'],
  token_endpoint_auth_method: 'none',
};

describe('isCimdClientId', () => {
  it('needs https with a path, no fragment, no user info', () => {
    expect(isCimdClientId(URL_)).toBe(true);
    expect(isCimdClientId('https://cursor.example/')).toBe(false);
    expect(isCimdClientId('http://cursor.example/c.json')).toBe(false);
    expect(isCimdClientId('https://u@cursor.example/c.json')).toBe(false);
    expect(isCimdClientId('qlr_cli_abc')).toBe(false);
    expect(isCimdClientId('https://c.example/a#b')).toBe(false);
    expect(isCimdClientId('https://c.example/a#')).toBe(false);
    expect(isCimdClientId('https://c.example/a/../b.json')).toBe(false);
    expect(isCimdClientId('https://c.example/a/./b.json')).toBe(false);
    expect(isCimdClientId('https://c.example/a/..')).toBe(false);
    expect(isCimdClientId('https://c.example/a/.')).toBe(false);
    expect(isCimdClientId('https://c.example/a/b.json')).toBe(true);
  });
});

describe('fetchCimd', () => {
  it('accepts a valid document and reads max-age within 300–86 400 s', async () => {
    const r = await fetchCimd(URL_, { request: answer(doc, { 'cache-control': 'max-age=60' }) });
    expect(r).toMatchObject({ ok: true, maxAgeSeconds: 300, document: { client_name: 'Cursor' } });
    const long = await fetchCimd(URL_, {
      request: answer(doc, { 'cache-control': 'public, max-age=999999' }),
    });
    expect(long).toMatchObject({ ok: true, maxAgeSeconds: 86_400 });
    const none = await fetchCimd(URL_, { request: answer(doc) });
    expect(none).toMatchObject({ ok: true, maxAgeSeconds: 3_600 });
  });

  it.each([
    ['a different client_id', { ...doc, client_id: 'https://evil.example/c.json' }],
    ['no redirect URIs', { ...doc, redirect_uris: [] }],
    ['a forbidden redirect URI', { ...doc, redirect_uris: ['http://example.com/cb'] }],
    ['a client secret method', { ...doc, token_endpoint_auth_method: 'client_secret_basic' }],
    ['a javascript: client_uri', { ...doc, client_uri: 'javascript:alert(1)' }],
    ['a data: logo_uri', { ...doc, logo_uri: 'data:image/png;base64,xx' }],
    ['not JSON', 'nope'],
  ])('refuses %s', async (_name, body) => {
    expect((await fetchCimd(URL_, { request: answer(body) })).ok).toBe(false);
  });

  it('refuses a non-200 answer and a failed request', async () => {
    expect((await fetchCimd(URL_, { request: answer(doc, {}, 404) })).ok).toBe(false);
    const failed = async (): Promise<OutboundResult> => ({
      kind: 'failed',
      reason: 'timed out',
      unreachable: true,
      cause: 'timeout',
      code: null,
    });
    expect(await fetchCimd(URL_, { request: failed })).toEqual({
      ok: false,
      reason: 'timed out',
    });
  });

  it('never connects to a private address (real outbound request)', async () => {
    const r = await fetchCimd('https://internal.example/c.json', {
      resolve: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    expect(r).toEqual({
      ok: false,
      reason:
        'The client metadata host resolves to a private, loopback or otherwise non-public address',
    });
  });
});
