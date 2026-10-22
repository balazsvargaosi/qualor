import { readdirSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  REDACTED,
  reportSchema,
  REVIEW_SNAPSHOT_CONTENT_TYPE,
  type Language,
  type Report,
  type SnapshotChangeLine,
  type SnapshotFileLine,
  type SnapshotHeaderLine,
  type SnapshotLine,
} from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { commitAll, gitSync, initRepo, SCAN_TEST_ENV } from '../../test/git';
import { json, problem, useTestServers } from '../../test/http';
import { captureIO } from '../../test/io';
import { snapshotLinesOf } from '../../test/review-snapshot';
import { fakeSecret, fakeSecretEngine } from '../../test/secret-engine';
import { useTempDirs, writeTree } from '../../test/tmp';
import type { Analyzer } from '../analyzers/types';
import { CliError } from '../errors';
import { parseCommandLine, type ScanFlags } from '../args';
import { VERSION } from '../index';
import { createLogger } from '../log';
import { runScan, type ScanDeps } from './run';

const tmp = useTempDirs();
const serve = useTestServers();
const ID = '0192a4c6-1c2e-7a3b-9f00-0000000000aa';
const SNAPSHOT_ID = '0192a4c6-1c2e-7a3b-9f00-0000000000bb';
const TOKEN = 'qlr_prj_upload_flow_token';

function repo(qualorYml = 'version: 1\n'): string {
  const root = path.join(tmp(), 'repo');
  writeTree(root, { 'qualor.yml': qualorYml, 'src/a.ts': 'export const a = 1;\n' });
  initRepo(root);
  commitAll(root, 'init');
  return root;
}

function flags(argv: string[] = []): ScanFlags {
  const c = parseCommandLine(['scan', '--project-key', 'acme/app', ...argv]);
  if (c.name !== 'scan') throw new Error('not a scan');
  return c.flags;
}

interface Fake {
  url: string;
  uploaded: Report[];
  /** The uploaded reports' JSON as sent, before any schema strips a field. */
  reportTexts: string[];
  paths: string[];
  /** The query strings of `GET /projects/review-context`. */
  contextQueries: string[];
  /** The review snapshots uploaded: their URL, headers and gzip'd body as sent. */
  snapshots: { url: string; headers: IncomingHttpHeaders; body: Buffer }[];
}

/** AI review on the server double (6I-2). */
interface FakeReview {
  /** The 200 answer of `GET /projects/review-context`; without one, 404 (an older server). */
  context?: unknown;
  /** Answers the snapshot upload, once its body is read; 202 without it. */
  snapshot?: (req: IncomingMessage, res: ServerResponse) => void;
}

/** A Qualor server double: the baseline, the upload and a scripted analysis status. */
async function fakeServer(
  statuses: unknown[],
  upload?: (res: Parameters<typeof json>[0]) => void,
  review: FakeReview = {},
): Promise<Fake> {
  const uploaded: Report[] = [];
  const reportTexts: string[] = [];
  const paths: string[] = [];
  const contextQueries: string[] = [];
  const snapshots: Fake['snapshots'] = [];
  const { url } = await serve((req, res, recorded) => {
    const u = new URL(req.url ?? '/', 'http://x');
    paths.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/api/v0/system/version') {
      json(res, 200, { version: VERSION });
    } else if (u.pathname === '/api/v0/projects/new-code-baseline') {
      json(res, 200, { revision: null, warnings: [] });
    } else if (u.pathname === '/api/v0/analyses' && req.method === 'POST') {
      if (upload !== undefined) {
        upload(res);
        return;
      }
      const text = gunzipSync(recorded.body).toString('utf8');
      reportTexts.push(text);
      uploaded.push(reportSchema.parse(JSON.parse(text)));
      json(res, 202, { analysisId: ID, status: 'queued', statusUrl: `/api/v0/analyses/${ID}` });
    } else if (u.pathname === `/api/v0/analyses/${ID}`) {
      json(
        res,
        200,
        statuses.shift() ?? { id: ID, status: 'queued', gateStatus: null, error: null },
      );
    } else if (u.pathname === '/api/v0/projects/review-context' && review.context !== undefined) {
      contextQueries.push(u.search.slice(1));
      json(res, 200, review.context);
    } else if (u.pathname === `/api/v0/analyses/${ID}/review-snapshot` && req.method === 'POST') {
      snapshots.push({ url: req.url ?? '', headers: req.headers, body: recorded.body });
      if (review.snapshot !== undefined) {
        review.snapshot(req, res);
        return;
      }
      json(res, 202, { snapshotId: SNAPSHOT_ID, status: 'uploaded' });
    } else {
      problem(res, 404, 'NOT_FOUND');
    }
  });
  return { url, uploaded, reportTexts, paths, contextQueries, snapshots };
}

const done = (gateStatus: string | null, status = 'succeeded') => ({
  id: ID,
  status,
  gateStatus,
  gateResult: null,
  error: status === 'failed' ? { code: 'PROCESSING_ERROR', message: 'boom' } : null,
});

async function scan(
  root: string,
  server: Fake,
  argv: string[] = [],
  deps: ScanDeps = {},
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const c = captureIO({
    cwd: root,
    env: { ...SCAN_TEST_ENV, QUALOR_URL: server.url, QUALOR_TOKEN: TOKEN, ...env },
  });
  const log = createLogger('info', c.io.stderr);
  // As `main` does: a CliError becomes its exit code and its message on stderr.
  const code = await runScan(flags(argv), c.io, log, {
    analyzers: [],
    wait: () => Promise.resolve(),
    ...deps,
  }).catch((err: unknown) => {
    if (!(err instanceof CliError)) throw err;
    log.error(err.message);
    return err.exitCode;
  });
  return { code, stderr: c.stderr() };
}

describe('qualor scan: upload, gate polling and exit codes (config.md §7)', () => {
  it(
    'uploads the report, waits for the gate and exits 0 when it passed',
    { timeout: 60_000 },
    async () => {
      const server = await fakeServer([done(null, 'queued'), done('passed')]);
      const { code, stderr } = await scan(repo(), server);
      expect(code, stderr).toBe(0);
      expect(server.paths).toEqual([
        'GET /api/v0/system/version',
        'GET /api/v0/projects/new-code-baseline',
        'POST /api/v0/analyses',
        `GET /api/v0/analyses/${ID}`,
        `GET /api/v0/analyses/${ID}`,
      ]);
      expect(server.uploaded[0]?.project.key).toBe('acme/app');
      expect(server.uploaded[0]?.scm.baseline.status).toBe('first_analysis');
      expect(stderr).toContain('quality gate: passed');
      expect(stderr).toContain(`qualor ${VERSION} (`);
      expect(stderr).toContain(`runs Qualor ${VERSION}`);
      expect(stderr).not.toContain(TOKEN);
    },
  );

  it.each([
    ['failed', 'succeeded', 'version: 1\n', 1],
    ['error', 'succeeded', 'version: 1\n', 1],
    ['error', 'succeeded', 'version: 1\ngate:\n  failOnError: false\n', 0],
    [null, 'failed', 'version: 1\n', 1],
    ['none', 'succeeded', 'version: 1\n', 0],
  ])(
    'gate %s of a %s analysis with %j exits %i',
    { timeout: 60_000 },
    async (gate, status, yml, exit) => {
      const server = await fakeServer([done(gate, status)]);
      expect((await scan(repo(yml), server)).code).toBe(exit);
    },
  );

  it('does not wait with --no-wait', { timeout: 60_000 }, async () => {
    const server = await fakeServer([]);
    const { code } = await scan(repo(), server, ['--no-wait']);
    expect(code).toBe(0);
    expect(server.paths).not.toContain(`GET /api/v0/analyses/${ID}`);
  });

  it(
    'exits 4 when the gate does not arrive within gate.timeoutSeconds',
    { timeout: 60_000 },
    async () => {
      const server = await fakeServer([]);
      let t = 0;
      const { code, stderr } = await scan(
        repo('version: 1\ngate:\n  timeoutSeconds: 5\n'),
        server,
        [],
        {
          clock: () => t,
          wait: (ms) => {
            t += ms;
            return Promise.resolve();
          },
        },
      );
      expect(code).toBe(4);
      expect(stderr).toContain('not available after 5 s');
    },
  );

  it(
    'uploads but exits 3 without waiting when a required analyzer failed (ruling E3)',
    { timeout: 60_000 },
    async () => {
      const server = await fakeServer([done('passed')]);
      const failing: Analyzer = {
        id: 'pmd',
        languages: [],
        prepare: () => Promise.resolve({ skip: 'pmd is not installed' }),
      };
      const { code, stderr } = await scan(
        repo('version: 1\nanalyzers:\n  pmd:\n    enabled: true\n'),
        server,
        [],
        { analyzers: [failing] },
      );
      expect(code).toBe(3);
      expect(server.uploaded[0]?.engines).toEqual([
        expect.objectContaining({ id: 'pmd', status: 'failed', reason: 'pmd is not installed' }),
      ]);
      expect(server.paths).not.toContain(`GET /api/v0/analyses/${ID}`);
      expect(stderr).toContain('required analyzers failed: pmd');
    },
  );

  it(
    'exits 5 when the upload is refused for the token, and 4 for an unknown project',
    { timeout: 60_000 },
    async () => {
      const auth = await fakeServer([], (res) => problem(res, 403, 'TOKEN_NOT_ALLOWED'));
      expect((await scan(repo(), auth, ['--branch', 'feature/x'])).code).toBe(5);
      const missing = await fakeServer([], (res) => problem(res, 404, 'PROJECT_NOT_FOUND'));
      const r = await scan(repo(), missing, ['--branch', 'feature/x']);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('project acme/app does not exist on the server');
    },
  );

  it(
    'refuses to send the token to a server.url that only qualor.yml names',
    { timeout: 60_000 },
    async () => {
      const server = await fakeServer([]);
      const root = repo(`version: 1\nserver:\n  url: ${server.url}\n`);
      const c = captureIO({ cwd: root, env: { ...SCAN_TEST_ENV, QUALOR_TOKEN: TOKEN } });
      const code = await runScan(flags(), c.io, createLogger('info', c.io.stderr), {
        analyzers: [],
      }).catch((e: unknown) => e);
      expect(code).toMatchObject({ exitCode: 2 });
      expect(server.paths).toEqual([]);
      // --server-url (like QUALOR_URL) is trusted.
      const trusted = captureIO({ cwd: root, env: { ...SCAN_TEST_ENV, QUALOR_TOKEN: TOKEN } });
      server.paths.length = 0;
      const ok = await runScan(
        flags(['--server-url', server.url, '--no-wait']),
        trusted.io,
        createLogger('info', trusted.io.stderr),
        { analyzers: [] },
      );
      expect(ok).toBe(0);
      expect(server.paths).toContain('POST /api/v0/analyses');
    },
  );
});

// ─── AI review: the repository snapshot of a merge request (6I-2) ───────────

const MiB = 1024 * 1024;
const REVIEW_ON = {
  review: true,
  reason: null,
  lastReviewedCommit: null,
  limits: {
    maxCompressedBytes: 50 * MiB,
    maxDecompressedBytes: 500 * MiB,
    maxFileBytes: MiB,
    maxFiles: 50_000,
  },
};
/** The scans below fetch nothing: origin/main and the head are in the clone. */
const MR_YML = 'version: 1\nscm:\n  autoFetch: false\n';
const MR_TITLE = 'Add the b module';
const MR_DESCRIPTION = 'Adds b to the app, with its tests.';

interface Mr {
  /** The scan root. */
  root: string;
  base: string;
  head: string;
}

/**
 * A merge request's checkout below `dir` of a new repository: `main`, also origin/main, at the
 * merge base, and HEAD on `feature` at the merge request's head, which changes src/a.ts and adds
 * src/b.ts unless `head` says otherwise.
 */
function mrRepo(
  o: {
    yml?: string;
    base?: Record<string, string>;
    head?: Record<string, string>;
    dir?: string;
  } = {},
): Mr {
  const top = path.join(tmp(), 'repo');
  const root = o.dir === undefined ? top : path.join(top, ...o.dir.split('/'));
  writeTree(root, {
    'qualor.yml': o.yml ?? MR_YML,
    'src/a.ts': 'export const a = 1;\n',
    ...o.base,
  });
  initRepo(top);
  const base = commitAll(top, 'base');
  gitSync(top, 'update-ref', 'refs/remotes/origin/main', base);
  gitSync(top, 'checkout', '-q', '-b', 'feature');
  writeTree(
    root,
    o.head ?? { 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 1;\n' },
  );
  return { root, base, head: commitAll(top, 'head') };
}

/** A GitLab merge request pipeline for `head` (detached unless `more` says otherwise). */
function gitlabMr(head: string, more: Record<string, string> = {}): Record<string, string> {
  return {
    GITLAB_CI: 'true',
    CI_COMMIT_SHA: head,
    CI_COMMIT_REF_NAME: 'feature',
    CI_DEFAULT_BRANCH: 'main',
    CI_MERGE_REQUEST_IID: '7',
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main',
    CI_MERGE_REQUEST_EVENT_TYPE: 'detached',
    CI_MERGE_REQUEST_TITLE: MR_TITLE,
    CI_MERGE_REQUEST_DESCRIPTION: MR_DESCRIPTION,
    ...more,
  };
}

const isChange = (l: SnapshotLine): l is SnapshotChangeLine => l.type === 'change';
const isFile = (l: SnapshotLine): l is SnapshotFileLine => l.type === 'file';
const isHeader = (l: SnapshotLine): l is SnapshotHeaderLine => l.type === 'header';
const reviewWarnings = (stderr: string) =>
  stderr.split('\n').filter((l) => l.startsWith('warn: AI review'));

const UNTIL_REPORT = ['GET /api/v0/system/version', 'POST /api/v0/analyses'];
const CONTEXT = 'GET /api/v0/projects/review-context';
const SNAPSHOT = `POST /api/v0/analyses/${ID}/review-snapshot`;
const GATE = `GET /api/v0/analyses/${ID}`;

describe('qualor scan: the AI review snapshot of a merge request (6I-2)', () => {
  it(
    'a merge request scan with review on uploads a snapshot after the report',
    { timeout: 60_000 },
    async () => {
      const mr = mrRepo();
      const server = await fakeServer([done('failed')], undefined, { context: REVIEW_ON });
      const temp = tmp();
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        { reviewTempRoot: temp },
        gitlabMr(mr.head),
      );
      // The gate decides the exit code: it failed.
      expect(code, stderr).toBe(1);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, SNAPSHOT, GATE]);
      expect(server.contextQueries).toEqual(['projectKey=acme%2Fapp&mergeRequest=7']);
      const [snapshot] = server.snapshots;
      expect(snapshot?.url).toBe(`/api/v0/analyses/${ID}/review-snapshot?projectKey=acme%2Fapp`);
      expect(snapshot?.headers).toMatchObject({
        'content-type': REVIEW_SNAPSHOT_CONTENT_TYPE,
        'content-encoding': 'gzip',
        authorization: `Bearer ${TOKEN}`,
      });
      const lines = snapshotLinesOf(snapshot?.body ?? Buffer.alloc(0));
      expect(lines.find(isHeader)).toMatchObject({
        headSha: mr.head,
        baseSha: mr.base,
        sinceSha: null,
        targetBranch: 'main',
        partial: false,
        mergeRequest: { id: '7', title: MR_TITLE, description: MR_DESCRIPTION },
      });
      expect(lines.filter(isChange).map((l) => [l.path, l.status])).toEqual([
        ['src/a.ts', 'modified'],
        ['src/b.ts', 'added'],
      ]);
      expect(lines.filter(isFile).map((l) => l.path)).toEqual([
        'src/a.ts',
        'src/b.ts',
        'qualor.yml',
      ]);
      expect(stderr).toContain('AI review: repository snapshot uploaded');
      expect(reviewWarnings(stderr)).toEqual([]);
      expect(stderr).not.toContain(TOKEN);
      // The merge request's title and description go to the snapshot only, never to the report.
      expect(server.uploaded[0]?.scm.mergeRequest).toEqual({
        id: '7',
        targetBranch: 'main',
        sourceBranch: 'feature',
      });
      expect(server.reportTexts[0]).not.toContain(MR_TITLE);
      expect(server.reportTexts[0]).not.toContain(MR_DESCRIPTION);
      // The snapshot's private directory is gone.
      expect(readdirSync(temp)).toEqual([]);
    },
  );

  it('sends the snapshot without waiting for the gate as well', { timeout: 60_000 }, async () => {
    const mr = mrRepo();
    const server = await fakeServer([], undefined, { context: REVIEW_ON });
    const { code, stderr } = await scan(mr.root, server, ['--no-wait'], {}, gitlabMr(mr.head));
    expect(code, stderr).toBe(0);
    expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, SNAPSHOT]);
  });

  it('review off: no snapshot', { timeout: 60_000 }, async () => {
    const mr = mrRepo();
    const server = await fakeServer([done('passed')], undefined, {
      context: { ...REVIEW_ON, review: false, reason: 'review_disabled' },
    });
    const { code, stderr } = await scan(mr.root, server, [], {}, gitlabMr(mr.head));
    expect(code, stderr).toBe(0);
    expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, GATE]);
    expect(stderr).toContain('AI review is off for this project (review_disabled)');
    expect(reviewWarnings(stderr)).toEqual([]);
  });

  it(
    'a server without the review context route: no snapshot, and no warning',
    { timeout: 60_000 },
    async () => {
      const mr = mrRepo();
      const server = await fakeServer([done('passed')]);
      const { code, stderr } = await scan(mr.root, server, [], {}, gitlabMr(mr.head));
      expect(code, stderr).toBe(0);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, GATE]);
      expect(stderr).not.toMatch(/^warn: /m);
    },
  );

  it(
    'secret scan unreadable: no snapshot and a warning (Review Focus 2)',
    { timeout: 60_000 },
    async () => {
      // Not required, so the scan does not exit 3 on it.
      const mr = mrRepo({ yml: `${MR_YML}analyzers:\n  gitleaks:\n    enabled: auto\n` });
      const engine = fakeSecretEngine(tmp(), 'unreadable');
      const server = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        { analyzers: [engine.analyzer] },
        gitlabMr(mr.head),
      );
      expect(code, stderr).toBe(0);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, GATE]);
      expect(server.snapshots).toEqual([]);
      expect(reviewWarnings(stderr)).toEqual([
        "warn: AI review: no snapshot sent, the secret scan's output could not be read",
      ]);
    },
  );

  it(
    'a scan whose required analyzer failed exits 3 and sends no snapshot',
    { timeout: 60_000 },
    async () => {
      const mr = mrRepo();
      const engine = fakeSecretEngine(tmp(), 'fail');
      const server = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        { analyzers: [engine.analyzer] },
        gitlabMr(mr.head),
      );
      expect(code, stderr).toBe(3);
      expect(server.paths).toEqual(UNTIL_REPORT);
    },
  );

  /** An analyzer `id` with `languages` that cannot run here (its tool is not installed). */
  const notInstalled = (id: 'semgrep' | 'qualor', languages: Language[]): Analyzer => ({
    id,
    languages,
    prepare: () => Promise.resolve({ unavailable: `${id} is not installed here` }),
  });
  /** `qualor.yml` with these lines under `analyzers:`. */
  const withAnalyzers = (lines: string) =>
    lines === '' ? MR_YML : `${MR_YML}analyzers:\n${lines}`;

  it.each([
    [
      'Gitleaks failed',
      '  gitleaks:\n    enabled: auto\n',
      (dir: string) => [fakeSecretEngine(dir, 'fail').analyzer],
      'gitleaks',
    ],
    [
      'Gitleaks timed out',
      '  gitleaks:\n    enabled: auto\n    timeoutSeconds: 1\n',
      (dir: string) => [fakeSecretEngine(dir, 'hang').analyzer],
      'gitleaks',
    ],
    [
      'Gitleaks is not installed',
      '  gitleaks:\n    enabled: auto\n',
      (dir: string) => [fakeSecretEngine(dir, 'unavailable').analyzer],
      'gitleaks',
    ],
    [
      'Semgrep, whose secret rules mask too, is not installed',
      '',
      () => [notInstalled('semgrep', [])],
      'semgrep',
    ],
    [
      "Qualor's rules did not run over files of their languages",
      '',
      () => [notInstalled('qualor', ['typescript'])],
      'qualor',
    ],
  ])(
    'a secret scan enabled for the scan that did not complete (%s): no snapshot and a warning (Review Focus 2)',
    { timeout: 60_000 },
    async (_name, lines, analyzers, engine) => {
      // Not required, so the scan does not exit 3 on it.
      const mr = mrRepo({ yml: withAnalyzers(lines) });
      const server = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        { analyzers: analyzers(tmp()) },
        gitlabMr(mr.head),
      );
      expect(code, stderr).toBe(0);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, GATE]);
      expect(reviewWarnings(stderr)).toEqual([
        `warn: AI review: no snapshot sent, the secret scan (${engine}) did not complete`,
      ]);
    },
  );

  it.each([
    ['Gitleaks completed', '', (dir: string) => [fakeSecretEngine(dir).analyzer], false],
    [
      "Gitleaks is off in qualor.yml, the user's choice",
      '  gitleaks:\n    enabled: false\n',
      (dir: string) => [fakeSecretEngine(dir).analyzer],
      true,
    ],
    [
      "Qualor's rules had no file of their languages to scan",
      '',
      () => [notInstalled('qualor', ['python'])],
      false,
    ],
  ])(
    'the secret scans are complete (%s): the snapshot is sent',
    { timeout: 60_000 },
    async (_name, lines, analyzers, off) => {
      const mr = mrRepo({ yml: withAnalyzers(lines) });
      const server = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        { analyzers: analyzers(tmp()) },
        gitlabMr(mr.head),
      );
      expect(code, stderr).toBe(0);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, SNAPSHOT, GATE]);
      expect(reviewWarnings(stderr)).toEqual([]);
      const said = stderr
        .split('\n')
        .filter(
          (l) =>
            l ===
            'AI review: the secret scan is off in qualor.yml; only built-in patterns mask secrets in the snapshot',
        );
      expect(said).toHaveLength(off ? 1 : 0);
    },
  );

  it.each([
    [
      '409 SNAPSHOT_EXISTS',
      'passed',
      0,
      (_req: IncomingMessage, res: ServerResponse) => problem(res, 409, 'SNAPSHOT_EXISTS'),
    ],
    [
      '500 INTERNAL_ERROR',
      'failed',
      1,
      (_req: IncomingMessage, res: ServerResponse) => problem(res, 500, 'INTERNAL_ERROR'),
    ],
    [
      'a dropped connection',
      'passed',
      0,
      (req: IncomingMessage) => {
        req.socket.destroy();
      },
    ],
  ])(
    'the snapshot upload fails (%s): a warning, the gate (%s) decides the exit code (%i)',
    { timeout: 60_000 },
    async (_name, gate, exit, answer) => {
      const mr = mrRepo();
      const server = await fakeServer([done(gate)], undefined, {
        context: REVIEW_ON,
        snapshot: answer,
      });
      const temp = tmp();
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        { reviewTempRoot: temp },
        gitlabMr(mr.head),
      );
      expect(code, stderr).toBe(exit);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, SNAPSHOT, GATE]);
      expect(reviewWarnings(stderr)).toEqual([
        expect.stringMatching(/^warn: AI review: no snapshot sent/),
      ]);
      expect(stderr).not.toContain(TOKEN);
      // Removed after the failed upload too.
      expect(readdirSync(temp)).toEqual([]);
    },
  );

  it.each([
    [
      "a merged-result pipeline that does not name the merge request's head",
      { CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result' },
      REVIEW_ON,
      /head commit is unknown/,
    ],
    [
      'a head that is not in the clone, with scm.autoFetch false (R12)',
      {
        CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result',
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: 'e'.repeat(40),
      },
      REVIEW_ON,
      /head commit e{40} is not in the clone/,
    ],
    [
      "changes over the server's limits",
      {},
      { ...REVIEW_ON, limits: { ...REVIEW_ON.limits, maxDecompressedBytes: 16 } },
      /limits/,
    ],
  ])('%s: a warning and no snapshot', { timeout: 60_000 }, async (_name, ci, context, why) => {
    const mr = mrRepo();
    const server = await fakeServer([done('passed')], undefined, { context });
    const temp = tmp();
    const { code, stderr } = await scan(
      mr.root,
      server,
      [],
      { reviewTempRoot: temp },
      gitlabMr(mr.head, ci),
    );
    expect(code, stderr).toBe(0);
    expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, GATE]);
    const warned = reviewWarnings(stderr);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(why);
    expect(readdirSync(temp)).toEqual([]);
  });

  it(
    '--mr naming another merge request than CI runs for: a warning and no snapshot',
    { timeout: 60_000 },
    async () => {
      const mr = mrRepo();
      const other = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const { code, stderr } = await scan(
        mr.root,
        other,
        ['--mr', '8', '--mr-target', 'main'],
        {},
        gitlabMr(mr.head),
      );
      expect(code, stderr).toBe(0);
      expect(other.paths).toEqual([...UNTIL_REPORT, CONTEXT, GATE]);
      expect(reviewWarnings(stderr)).toEqual([
        expect.stringContaining('--mr and --mr-target name another merge request'),
      ]);
      // The one CI runs for: sent.
      const same = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const again = await scan(
        mr.root,
        same,
        ['--mr', '7', '--mr-target', 'main'],
        {},
        gitlabMr(mr.head),
      );
      expect(again.code, again.stderr).toBe(0);
      expect(same.paths).toEqual([...UNTIL_REPORT, CONTEXT, SNAPSHOT, GATE]);
    },
  );

  it('a branch scan never asks', { timeout: 60_000 }, async () => {
    const mr = mrRepo();
    const server = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
    const { code, stderr } = await scan(
      mr.root,
      server,
      [],
      {},
      {
        GITLAB_CI: 'true',
        CI_COMMIT_SHA: mr.head,
        CI_COMMIT_REF_NAME: 'feature',
        CI_DEFAULT_BRANCH: 'main',
      },
    );
    expect(code, stderr).toBe(0);
    expect(server.paths).toEqual([...UNTIL_REPORT, GATE]);
  });

  it(
    'a GitHub pull request: the snapshot of the head its event names, with its title and body (R9)',
    { timeout: 60_000 },
    async () => {
      const mr = mrRepo();
      const event = path.join(tmp(), 'event.json');
      writeFileSync(
        event,
        JSON.stringify({
          pull_request: {
            number: 7,
            head: { sha: mr.head },
            base: { ref: 'main' },
            title: MR_TITLE,
            body: null,
          },
          repository: { default_branch: 'main' },
        }),
      );
      const server = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        {},
        {
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_PATH: event,
          GITHUB_SHA: 'f'.repeat(40),
          GITHUB_HEAD_REF: 'feature',
          GITHUB_BASE_REF: 'main',
          GITHUB_REF_NAME: '7/merge',
          GITHUB_REPOSITORY: 'acme/app',
        },
      );
      expect(code, stderr).toBe(0);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, SNAPSHOT, GATE]);
      const lines = snapshotLinesOf(server.snapshots[0]?.body ?? Buffer.alloc(0));
      expect(lines.find(isHeader)).toMatchObject({
        headSha: mr.head,
        mergeRequest: { id: '7', title: MR_TITLE, description: null },
      });
    },
  );

  it(
    'masks the secrets of the scan and of the merge base, and the token, the scan root a subdirectory (Review Focus 2, R13)',
    { timeout: 60_000 },
    async () => {
      const headSecret = fakeSecret('head0secret0value');
      const baseSecret = fakeSecret('base0secret0value');
      // A rule for src/ only: the merge base's files are found by it only when they are laid out
      // as the head scan saw its files, below the scan root.
      const rules = `[[rules]]\nid = "src-token"\nregex = '''qk7-[A-Za-z0-9-]{8,}'''\npath = '''^src/'''\n`;
      const mr = mrRepo({
        dir: 'pkg',
        base: {
          '.gitleaks.toml': rules,
          'src/a.ts': `export const a = 1;\nconst old = '${baseSecret}';\n`,
        },
        head: {
          'src/a.ts': `export const a = 2;\nconst key = '${headSecret}';\n`,
          'src/token.ts': `export const token = '${TOKEN}';\n`,
        },
      });
      const engine = fakeSecretEngine(tmp());
      const server = await fakeServer([done('passed')], undefined, { context: REVIEW_ON });
      const temp = tmp();
      const { code, stderr } = await scan(
        mr.root,
        server,
        [],
        { analyzers: [engine.analyzer], reviewTempRoot: temp },
        gitlabMr(mr.head, {
          CI_MERGE_REQUEST_DESCRIPTION: `Rotates ${headSecret} and ${baseSecret}; token ${TOKEN}`,
        }),
      );
      expect(code, stderr).toBe(0);
      expect(server.paths).toEqual([...UNTIL_REPORT, CONTEXT, SNAPSHOT, GATE]);
      // The head scan and the merge base's scan, both against the scan root.
      expect(engine.prepared).toEqual([mr.root, mr.root]);
      // The snapshot, the merge base's files and the engine's output there are all gone.
      expect(readdirSync(temp)).toEqual([]);
      const body = server.snapshots[0]?.body ?? Buffer.alloc(0);
      const text = gunzipSync(body).toString('utf8');
      for (const secret of [headSecret, baseSecret, TOKEN]) expect(text).not.toContain(secret);
      const lines = snapshotLinesOf(body);
      const patch = lines.filter(isChange).find((l) => l.path === 'src/a.ts')?.patch ?? '';
      // The removed line is sent, masked: the merge base's scan found its secret at src/a.ts.
      expect(patch).toContain(`-const old = '${REDACTED}';`);
      expect(patch).toContain(`+const key = '${REDACTED}';`);
      const files = new Map(lines.filter(isFile).map((l) => [l.path, l.text]));
      expect(files.get('src/a.ts')).toBe(`export const a = 2;\nconst key = '${REDACTED}';\n`);
      expect(files.get('src/token.ts')).toBe(`export const token = '${REDACTED}';\n`);
      expect(lines.find(isHeader)?.mergeRequest.description).toBe(
        `Rotates ${REDACTED} and ${REDACTED}; token ${REDACTED}`,
      );
      expect(stderr).not.toContain(TOKEN);
      expect(stderr).not.toContain(headSecret);
      expect(stderr).not.toContain(baseSecret);
    },
  );
});
