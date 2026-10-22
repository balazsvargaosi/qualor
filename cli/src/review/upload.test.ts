import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { REVIEW_SNAPSHOT_CONTENT_TYPE } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { json, problem, useTestServers } from '../../test/http';
import { useTempDirs } from '../../test/tmp';
import { createLogger, silentLogger } from '../log';
import { MAX_UPLOAD_ATTEMPTS } from '../server/upload';
import { uploadReviewSnapshot } from './upload';

const tmp = useTempDirs();
const serve = useTestServers();
const ID = '0192a4c6-1c2e-7a3b-9f00-0000000000bb';
const SNAPSHOT_ID = '0192a4c6-1c2e-7a3b-9f00-0000000000cc';
const TOKEN = 'qlr_prj_review_upload_token';

const ep = (url: string) => ({ url, token: TOKEN, timeoutMs: 5_000 });

function snapshotFile(): { file: string; size: number; bytes: Buffer } {
  const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: 'header' })}\n`.repeat(2_000)));
  const file = path.join(tmp(), 'review-snapshot.jsonl.gz');
  writeFileSync(file, bytes);
  return { file, size: bytes.length, bytes };
}

/** An incompressible file, large enough that socket buffers cannot swallow it at once. */
function bigFile(bytes: number): { file: string; size: number } {
  const file = path.join(tmp(), 'big.jsonl.gz');
  writeFileSync(file, randomBytes(bytes));
  return { file, size: bytes };
}

const uploaded = { snapshotId: SNAPSHOT_ID, status: 'uploaded' };

function capture(): { log: ReturnType<typeof createLogger>; lines: () => string[] } {
  const out: string[] = [];
  return {
    log: createLogger('info', (text) => out.push(text)),
    lines: () => out.join('').split('\n').filter(Boolean),
  };
}

describe('uploadReviewSnapshot (POST /analyses/{id}/review-snapshot, 6I-2)', () => {
  it("streams the gzip'd snapshot to the analysis's route with its content type and encoding", async () => {
    const { file, size, bytes } = snapshotFile();
    const { url, requests } = await serve((_req, res) => json(res, 202, uploaded));
    expect(
      await uploadReviewSnapshot(
        ep(url),
        { analysisId: ID, projectKey: 'acme/app', file, size },
        { log: silentLogger },
      ),
    ).toBe('uploaded');
    const r = requests[0];
    expect(r?.method).toBe('POST');
    expect(r?.url).toBe(`/api/v0/analyses/${ID}/review-snapshot?projectKey=acme%2Fapp`);
    expect(r?.headers).toMatchObject({
      'content-type': REVIEW_SNAPSHOT_CONTENT_TYPE,
      'content-encoding': 'gzip',
      'content-length': String(size),
      // As the report: every check runs before a byte of the body is sent.
      expect: '100-continue',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(Buffer.compare(r?.body ?? Buffer.alloc(0), bytes)).toBe(0);
  });

  it('retries 503 UPLOADS_BUSY like the report upload, then succeeds', async () => {
    const { file, size } = snapshotFile();
    let calls = 0;
    const { url } = await serve(
      (_req, res) => {
        calls += 1;
        if (calls < 3) {
          problem(res, 503, 'UPLOADS_BUSY');
          return;
        }
        res.writeContinue();
        json(res, 202, uploaded);
      },
      { readBody: false },
    );
    const waits: number[] = [];
    const { log, lines } = capture();
    const outcome = await uploadReviewSnapshot(
      ep(url),
      { analysisId: ID, projectKey: 'acme/app', file, size },
      {
        log,
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(outcome).toBe('uploaded');
    expect(waits).toEqual([2_000, 2_000]);
    expect(calls).toBe(3);
    expect(lines().filter((l) => l.startsWith('warn: '))).toEqual([]);
  });

  it('gives up after as many attempts as the report upload: refused', async () => {
    const { file, size } = snapshotFile();
    const { url, requests } = await serve((_req, res) => problem(res, 503, 'UPLOADS_BUSY'), {
      readBody: false,
    });
    const { log, lines } = capture();
    const outcome = await uploadReviewSnapshot(
      ep(url),
      { analysisId: ID, projectKey: 'acme/app', file, size },
      { log, wait: () => Promise.resolve() },
    );
    expect(outcome).toBe('refused');
    expect(requests).toHaveLength(MAX_UPLOAD_ATTEMPTS);
    expect(lines().filter((l) => l.startsWith('warn: '))).toEqual([
      expect.stringContaining('503 UPLOADS_BUSY'),
    ]);
  });

  it.each([
    [409, 'AI_REVIEW_OFF'],
    [409, 'SNAPSHOT_EXISTS'],
    [413, 'SNAPSHOT_TOO_LARGE'],
    [422, 'SNAPSHOT_INVALID'],
    [404, 'ANALYSIS_NOT_FOUND'],
    [403, 'TOKEN_NOT_ALLOWED'],
    [503, 'MAINTENANCE'],
  ])(
    'a %i %s is refused: one warning names it, and no byte of the body is sent',
    async (status, code) => {
      let received = 0;
      const { url, requests } = await serve(
        (req, res) => {
          req.on('data', (c: Buffer) => (received += c.length));
          problem(res, status, code, `detail with ${TOKEN}`);
        },
        { readBody: false },
      );
      const { file, size } = bigFile(2 * 1024 * 1024);
      const { log, lines } = capture();
      const outcome = await uploadReviewSnapshot(
        ep(url),
        { analysisId: ID, projectKey: 'acme/app', file, size },
        { log, wait: () => Promise.resolve() },
      );
      expect(outcome).toBe('refused');
      expect(requests).toHaveLength(1);
      expect(lines()).toEqual([expect.stringMatching(/^warn: AI review: /)]);
      expect(lines()[0]).toContain(`${status} ${code}`);
      expect(lines().join('\n')).not.toContain(TOKEN);
      await new Promise((r) => setTimeout(r, 200));
      expect(received).toBe(0);
    },
  );

  it('throws, without the token, when the connection fails; the file is released', async () => {
    const { file, size } = bigFile(4 * 1024 * 1024);
    const { url } = await serve(
      (req) => {
        req.socket.destroy();
      },
      { readBody: false },
    );
    const err: unknown = await uploadReviewSnapshot(
      ep(url),
      { analysisId: ID, projectKey: 'acme/app', file, size },
      { log: silentLogger },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/cannot reach/);
    expect((err as Error).message).not.toContain(TOKEN);
    // The read stream is closed: on Windows an open handle would make this fail with EBUSY.
    rmSync(file);
  });
});
