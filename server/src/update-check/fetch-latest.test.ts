import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchLatestVersion } from './fetch-latest';

let server: Server | undefined;

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/tags`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A Docker Hub tag page, image lists left empty. */
const tags = (...names: string[]) =>
  JSON.stringify({ count: names.length, results: names.map((name) => ({ name, images: [] })) });

describe('fetchLatestVersion', () => {
  it('returns the highest stable tag and sends a versionless user agent', async () => {
    let agent: string | undefined;
    const url = await listen((req, res) => {
      agent = req.headers['user-agent'];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(tags('0.7', '0.8.0', 'staging-0.9.0', '0.7.1'));
    });
    expect(await fetchLatestVersion(url)).toEqual({ ok: true, latest: '0.8.0' });
    expect(agent).toBe('qualor-server');
  });

  it('is ok with latest null when no tag is stable', async () => {
    const url = await listen((_req, res) => res.writeHead(200).end(tags('latest', '0.7')));
    expect(await fetchLatestVersion(url)).toEqual({ ok: true, latest: null });
  });

  it.each([
    ['HTTP 429', (res: ServerResponse) => res.writeHead(429).end('slow down')],
    ['invalid', (res: ServerResponse) => res.writeHead(200).end('<html>')],
    ['invalid', (res: ServerResponse) => res.writeHead(200).end('{"results":"x"}')],
  ])('fails with %s', async (reason, answer) => {
    const url = await listen((_req, res) => answer(res));
    expect(await fetchLatestVersion(url)).toEqual({ ok: false, reason });
  });

  it('refuses a redirect', async () => {
    const url = await listen((_req, res) =>
      res.writeHead(302, { location: 'http://127.0.0.1:9/' }).end(),
    );
    expect((await fetchLatestVersion(url)).ok).toBe(false);
  });

  it('fails on a body over the limit', async () => {
    const url = await listen((_req, res) => res.writeHead(200).end('x'.repeat(2048)));
    expect(await fetchLatestVersion(url, { maxBytes: 1024 })).toEqual({
      ok: false,
      reason: 'too large',
    });
  });

  it('fails on a timeout', async () => {
    const url = await listen((_req, res) => {
      setTimeout(() => res.writeHead(200).end(tags('0.8.0')), 500);
    });
    expect((await fetchLatestVersion(url, { timeoutMs: 50 })).ok).toBe(false);
  });

  it('fails when nothing listens', async () => {
    expect((await fetchLatestVersion('http://127.0.0.1:9/v2/tags')).ok).toBe(false);
  });
});
