import { describe, expect, it } from 'vitest';
import { json, problem, useTestServers } from '../../test/http';
import { createLogger } from '../log';
import { fetchReviewContext, type ReviewContext } from './context';

const serve = useTestServers();
const TOKEN = 'qlr_prj_review_context_token';
const MiB = 1024 * 1024;
const LIMITS = {
  maxCompressedBytes: 50 * MiB,
  maxDecompressedBytes: 500 * MiB,
  maxFileBytes: MiB,
  maxFiles: 50_000,
};
const ON = { review: true, reason: null, lastReviewedCommit: null, limits: LIMITS };

const ep = (url: string) => ({ url, token: TOKEN, timeoutMs: 5_000 });

/** `fetchReviewContext` against a server answering with `answer`, and what it logged. */
async function ask(
  answer: Parameters<typeof serve>[0],
): Promise<{ context: ReviewContext | null; lines: string[]; url: string; auth: unknown }> {
  const { url, requests } = await serve(answer);
  const out: string[] = [];
  const log = createLogger('debug', (text) => out.push(text));
  const context = await fetchReviewContext(
    ep(url),
    { projectKey: 'acme/app', mergeRequest: '7' },
    log,
  );
  const lines = out.join('').split('\n').filter(Boolean);
  return {
    context,
    lines,
    url: requests[0]?.url ?? '',
    auth: requests[0]?.headers.authorization,
  };
}

const warnings = (lines: string[]) => lines.filter((l) => l.startsWith('warn: '));

describe('fetchReviewContext (GET /projects/review-context, 6I-2)', () => {
  it('asks for the project and the merge request, with the token as Bearer, and reads a 200', async () => {
    const sha = 'a'.repeat(40);
    const r = await ask((_req, res) => json(res, 200, { ...ON, lastReviewedCommit: sha }));
    expect(r.url).toBe('/api/v0/projects/review-context?projectKey=acme%2Fapp&mergeRequest=7');
    expect(r.auth).toBe(`Bearer ${TOKEN}`);
    expect(r.context).toEqual({
      review: true,
      reason: null,
      lastReviewedCommit: sha,
      limits: LIMITS,
    });
    expect(r.lines).toEqual([]);
  });

  it('reads review off, with its reason', async () => {
    const r = await ask((_req, res) =>
      json(res, 200, { ...ON, review: false, reason: 'consent_outdated' }),
    );
    expect(r.context).toMatchObject({ review: false, reason: 'consent_outdated' });
  });

  it('keeps a reason this scanner does not know, and ignores fields it does not read', async () => {
    const r = await ask((_req, res) =>
      json(res, 200, { ...ON, review: false, reason: 'some_new_reason', extra: { a: 1 } }),
    );
    expect(r.context).toMatchObject({ review: false, reason: 'some_new_reason' });
  });

  it('takes a last reviewed commit that is not a commit id for none', async () => {
    const r = await ask((_req, res) => json(res, 200, { ...ON, lastReviewedCommit: 'HEAD~1' }));
    expect(r.context?.lastReviewedCommit).toBeNull();
  });

  it('never builds more than a server may accept inflated (500 MiB)', async () => {
    const r = await ask((_req, res) =>
      json(res, 200, { ...ON, limits: { ...LIMITS, maxDecompressedBytes: 8 * 1024 * MiB } }),
    );
    expect(r.context?.limits).toEqual(LIMITS);
  });

  it.each([
    ['404 NOT_FOUND', (res: Parameters<typeof json>[0]) => problem(res, 404, 'NOT_FOUND')],
    [
      '404 without a problem body',
      (res: Parameters<typeof json>[0]) => {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>not here</html>');
      },
    ],
    [
      // A server that reads the path as GET /projects/:id with `review-context` for the id.
      '422 VALIDATION_FAILED on params.id',
      (res: Parameters<typeof json>[0]) =>
        json(res, 422, {
          status: 422,
          code: 'VALIDATION_FAILED',
          errors: [{ path: 'params.id', message: 'Invalid UUID' }],
        }),
    ],
  ])(
    'an older server without the route (%s): null, said at debug level only',
    async (_name, answer) => {
      const r = await ask((_req, res) => answer(res));
      expect(r.context).toBeNull();
      expect(warnings(r.lines)).toEqual([]);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatch(/^debug: AI review: /);
    },
  );

  it.each([
    [500, 'INTERNAL_ERROR'],
    [404, 'PROJECT_NOT_FOUND'],
    [403, 'TOKEN_NOT_ALLOWED'],
    [422, 'VALIDATION_FAILED'],
  ])('a %i %s: null, with one warning naming it', async (status, code) => {
    const r = await ask((_req, res) => problem(res, status, code, `echo ${TOKEN}`));
    expect(r.context).toBeNull();
    expect(r.lines).toHaveLength(1);
    expect(warnings(r.lines)[0]).toContain(`${status} ${code}`);
    expect(r.lines.join('\n')).not.toContain(TOKEN);
  });

  it.each([
    ['not JSON', 'not json'],
    ['no limits', JSON.stringify({ review: true, reason: null, lastReviewedCommit: null })],
    ['a limit of 0', JSON.stringify({ ...ON, limits: { ...LIMITS, maxFiles: 0 } })],
    ['review not a boolean', JSON.stringify({ ...ON, review: 'yes' })],
  ])('an answer that is not a review context (%s): null, with one warning', async (_n, body) => {
    const r = await ask((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    expect(r.context).toBeNull();
    expect(r.lines).toHaveLength(1);
    expect(warnings(r.lines)[0]).toContain('AI review: ');
  });

  it('a server that cannot be reached: null, with one warning', async () => {
    const { url, server } = await serve((_req, res) => json(res, 200, ON));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const out: string[] = [];
    const context = await fetchReviewContext(
      ep(url),
      { projectKey: 'acme/app', mergeRequest: '7' },
      createLogger('debug', (text) => out.push(text)),
    );
    expect(context).toBeNull();
    const lines = out.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^warn: AI review: .*cannot reach/);
    expect(lines[0]).not.toContain(TOKEN);
  });
});
