// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@qualor/server/plugin-contract';
import { supportRoutes } from './support-routes';

const FILE = 'qualor-support-20261014-101500.zip';
const ZIP = Buffer.from('PK-fake-archive');

const problem = (status: number, code: string, title: string) =>
  Object.assign(new Error(title), { statusCode: status, code });

type Bundle = { fileName: string; stream: Readable };

/** The routes over a fake `ctx.support` that answers `bundle` as given. */
function harness(bundle: () => Promise<Bundle>) {
  const support = { bundle: vi.fn(bundle) };
  const ctx = { support, access: { problem } } as unknown as PluginContext;
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  void app.register(supportRoutes(ctx));
  return { app, support };
}

const done = (): Promise<Bundle> =>
  Promise.resolve({ fileName: FILE, stream: Readable.from([ZIP]) });

/** A promise a test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/** A GET on a real socket that the client drops after `ms`. */
function dropAfter(url: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false });
    req.on('error', () => undefined);
    setTimeout(() => {
      req.destroy();
      resolve();
    }, ms);
  });
}

/** The status of a GET on a real socket, its body read to the end. */
function statusOf(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

async function listening(server: FastifyInstance): Promise<string> {
  await server.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /support/bundle (4E-3b §4)', () => {
  it('streams the archive as a no-store attachment named by core', async () => {
    const h = harness(done);
    app = h.app;
    const res = await app.inject({ url: '/support/bundle' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${FILE}"`);
    expect(res.rawPayload.equals(ZIP)).toBe(true);
    expect(h.support.bundle).toHaveBeenCalledTimes(1);
  });

  it("passes core's refusals through (403) and frees the slot", async () => {
    const h = harness(done);
    h.support.bundle.mockRejectedValueOnce(
      problem(403, 'FEATURE_NOT_LICENSED', 'The support bundle is not licensed'),
    );
    h.support.bundle.mockRejectedValueOnce(
      problem(403, 'FORBIDDEN', 'Instance administrators only'),
    );
    app = h.app;
    const first = await app.inject({ url: '/support/bundle' });
    expect(first.statusCode).toBe(403);
    expect(first.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
    const second = await app.inject({ url: '/support/bundle' });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await app.inject({ url: '/support/bundle' })).statusCode).toBe(200);
  });

  it('allows one bundle in flight (429 RATE_LIMITED) and frees the slot when it ends', async () => {
    const held = gate();
    const h = harness(done);
    h.support.bundle.mockImplementationOnce(async () => {
      await held.promise;
      return { fileName: FILE, stream: Readable.from([ZIP]) };
    });
    app = h.app;
    const running = app.inject({ url: '/support/bundle' });
    await vi.waitFor(() => expect(h.support.bundle).toHaveBeenCalledTimes(1));
    const second = await app.inject({ url: '/support/bundle' });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.support.bundle).toHaveBeenCalledTimes(1);
    held.open();
    expect((await running).statusCode).toBe(200);
    expect((await app.inject({ url: '/support/bundle' })).statusCode).toBe(200);
  });

  it('frees the slot when the client goes away while the bundle is collected (a real socket)', async () => {
    const collected = gate();
    const h = harness(done);
    h.support.bundle.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 300));
      collected.open();
      return { fileName: FILE, stream: Readable.from([ZIP]) };
    });
    app = h.app;
    const url = `${await listening(app)}/support/bundle`;
    await dropAfter(url, 100);
    await collected.promise;
    await new Promise((r) => setTimeout(r, 50));
    expect(await statusOf(url)).toBe(200);
    expect(h.support.bundle).toHaveBeenCalledTimes(2);
  });

  it('frees the slot, and destroys the stream, when the client drops mid-download (a real socket)', async () => {
    const stream = new PassThrough();
    stream.write(Buffer.alloc(64 * 1024, 1));
    const h = harness(done);
    h.support.bundle.mockImplementationOnce(() => Promise.resolve({ fileName: FILE, stream }));
    app = h.app;
    const url = `${await listening(app)}/support/bundle`;
    // The headers and some bytes have come; the body is still open, so the slot is held.
    await new Promise<void>((resolve, reject) => {
      const req = http.get(url, { agent: false }, (res) => {
        res.once('data', () => {
          expect(res.statusCode).toBe(200);
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('no data')), 5_000);
    });
    await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    await vi.waitFor(async () => expect(await statusOf(url)).toBe(200));
  });

  it('keeps the slot while a dropped download is still being collected, then frees it', async () => {
    const held = gate();
    const h = harness(done);
    h.support.bundle.mockImplementationOnce(async () => {
      await held.promise;
      return { fileName: FILE, stream: Readable.from([ZIP]) };
    });
    app = h.app;
    const url = `${await listening(app)}/support/bundle`;
    await dropAfter(url, 100);
    await new Promise((r) => setTimeout(r, 50));
    expect(await statusOf(url)).toBe(429);
    held.open();
    await vi.waitFor(async () => expect(await statusOf(url)).toBe(200));
  });
});
