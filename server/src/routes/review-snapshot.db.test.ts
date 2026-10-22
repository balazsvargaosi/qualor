import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import {
  encodeSnapshotLine,
  REVIEW_SNAPSHOT_CONTENT_TYPE,
  type SnapshotHeaderLine,
  type SnapshotLine,
} from '@qualor/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer } from '../../test/app';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { gzipJson, REPORT_CONTENT_TYPE, sampleReport, uploadReport } from '../../test/reports';
import { mergeRequestReport } from '../../test/scm';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import {
  analyses,
  jobs,
  projects,
  reviewSnapshotFiles,
  reviewSnapshots,
  scmConnections,
} from '../db/schema';
import {
  DEFAULT_AUTO_FIX,
  DEFAULT_LLM_SETTINGS,
  writeLlmSettings,
  type StoredLlmSettings,
  type StoredProvider,
} from '../llm/settings';
import { runUntilIdle } from '../queue/worker';
import { reviewSnapshotHandlers } from '../review/jobs';
import { defaultReview, reviewProvider, type ReviewSettings } from '../review/settings';
import { REVIEW_SNAPSHOT_QUEUE } from '../review/snapshot-store';
import { SCM_TOKEN_AAD } from '../scm/connections';

const KiB = 1024;
const MiB = 1024 * KiB;
/** Small limits, so the 413 cases need no large body. */
const LIMITS = { maxCompressedBytes: 64 * KiB, maxDecompressedBytes: MiB };

const PROVIDER: StoredProvider = {
  kind: 'openai',
  baseUrl: 'https://llm.example/v1',
  model: 'fake-model',
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_tokens',
  temperature: null,
  timeoutSeconds: 5,
  apiKeyEnc: null,
};

const HEADER: SnapshotHeaderLine = {
  type: 'header',
  v: 1,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  sinceSha: null,
  targetBranch: 'main',
  mergeRequest: { id: '7', title: 'Parse the config', description: null },
  partial: false,
  generator: 'qualor-cli/test',
};

/** A small valid snapshot: one changed file and one omitted. */
function snapshotBody(): Buffer {
  const lines: SnapshotLine[] = [
    HEADER,
    {
      type: 'change',
      path: 'src/a.ts',
      oldPath: null,
      status: 'modified',
      patch: null,
      since: null,
    },
    { type: 'file', path: 'src/a.ts', text: 'export const a = 1;\n' },
    { type: 'omitted', path: 'logo.png', reason: 'binary' },
    { type: 'end', files: 1, changes: 1, omitted: 1 },
  ];
  return gzipSync(lines.map(encodeSnapshotLine).join(''));
}

/** The `llm` setting with `h`'s organisation's review on for every project (a current consent). */
async function configureReviewOf(
  h: IngestHarness,
  review: Partial<ReviewSettings> = {},
): Promise<void> {
  const base: StoredLlmSettings = { ...DEFAULT_LLM_SETTINGS, provider: PROVIDER };
  const provider = reviewProvider(base)!;
  await writeLlmSettings(h.ctx.db, {
    ...base,
    organizations: {
      [h.organizationId]: {
        enabled: true,
        features: { explain: true, triage: false, fix: false },
        excludedProjectIds: [],
        autoFix: { ...DEFAULT_AUTO_FIX },
        autoFixDisabledProjectIds: [],
        review: {
          ...defaultReview(),
          enabled: true,
          scope: 'all',
          consent: {
            providerUrl: provider.url,
            providerHost: provider.host,
            model: provider.model,
            userId: h.ctx.adminId,
            at: new Date().toISOString(),
          },
          ...review,
        },
      },
    },
  });
}

/** Maps projects to their repository on a GitLab connection of `h`'s organisation (a review needs it). */
async function mapToGitLab(
  h: IngestHarness,
  mapped: readonly (readonly [IngestProject, string])[],
): Promise<void> {
  const [connection] = await h.ctx.db
    .insert(scmConnections)
    .values({
      organizationId: h.organizationId,
      provider: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      tokenEnc: encryptSecret(encryptionKey(h.ctx.config.secretKey), 'x', SCM_TOKEN_AAD),
    })
    .returning();
  for (const [project, ref] of mapped) {
    await h.ctx.db
      .update(projects)
      .set({ scmConnectionId: connection!.id, scmProjectRef: ref })
      .where(eq(projects.id, project.id));
  }
}

/**
 * A body whose second half is sent only by `release()`: the upload that reads it keeps its slot
 * until then. `reading` resolves once the upload has started reading (and so holds its slot).
 */
function gatedBody(body: Buffer): {
  stream: Readable;
  reading: Promise<void>;
  release: () => void;
} {
  const half = Math.ceil(body.length / 2);
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const stream = new Readable({
    read() {
      reads += 1;
      if (reads === 1) {
        started();
        this.push(body.subarray(0, half));
        return;
      }
      void gate.then(() => {
        this.push(body.subarray(half));
        this.push(null);
      });
    },
  });
  return { stream, reading, release };
}

describe('POST /analyses/{id}/review-snapshot (6I-2)', () => {
  let h: IngestHarness;
  /** Mapped to an SCM connection, and selected for review. */
  let p: IngestProject;
  /** Another mapped project of the organisation. */
  let q: IngestProject;
  /** Not mapped: review never runs for it. */
  let unmapped: IngestProject;
  let mr = 0;
  let port: number;

  const url = (analysisId: string, projectKey: string) =>
    `/api/v0/analyses/${analysisId}/review-snapshot?projectKey=${encodeURIComponent(projectKey)}`;
  const post = (
    analysisId: string,
    body: Buffer | Readable,
    options: { token?: string; projectKey?: string; headers?: Record<string, string> } = {},
  ) =>
    h.ctx.app.inject({
      method: 'POST',
      url: url(analysisId, options.projectKey ?? p.key),
      headers: {
        ...bearer(options.token ?? p.token),
        'content-type': REVIEW_SNAPSHOT_CONTENT_TYPE,
        'content-encoding': 'gzip',
        ...options.headers,
      },
      payload: body,
    });
  /** An analysis of a merge request of `project`, ingested. */
  const mergeRequestAnalysis = async (project: IngestProject = p): Promise<string> => {
    mr += 1;
    return project.ingestOk(mergeRequestReport(mr, 'c'.repeat(40), { projectKey: project.key }));
  };
  const snapshotsOf = (analysisId: string) =>
    h.ctx.db
      .select({
        id: reviewSnapshots.id,
        projectId: reviewSnapshots.projectId,
        status: reviewSnapshots.status,
        compressedBytes: reviewSnapshots.compressedBytes,
      })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.analysisId, analysisId));
  const snapshotJobs = () =>
    h.ctx.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
  const unpackAll = () =>
    runUntilIdle(
      h.ctx.db,
      reviewSnapshotHandlers({ db: h.ctx.db, logger: h.ctx.app.log, limits: LIMITS }),
      h.ctx.app.log,
    );
  const configureReview = (review: Partial<ReviewSettings> = {}) => configureReviewOf(h, review);

  beforeAll(async () => {
    h = await createIngestHarness({
      config: { reviewSnapshot: LIMITS, maxConcurrentUploads: 1 },
    });
    p = await h.project('rs/p');
    q = await h.project('rs/q');
    unmapped = await h.project('rs/unmapped');
    await mapToGitLab(h, [
      [p, '7'],
      [q, '8'],
    ]);
    await h.ctx.app.listen({ port: 0, host: '127.0.0.1' });
    port = (h.ctx.app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await configureReview();
  });

  it('answers 202 and stores the snapshot as sent; its job unpacks it and links it to the merge request', async () => {
    const analysisId = await mergeRequestAnalysis();
    const body = snapshotBody();
    const res = await post(analysisId, body);
    expect(res.statusCode, res.body).toBe(202);
    const answer = res.json() as { snapshotId: string; status: string };
    expect(answer).toEqual({ snapshotId: expect.any(String), status: 'uploaded' });
    expect(await snapshotsOf(analysisId)).toEqual([
      { id: answer.snapshotId, projectId: p.id, status: 'uploaded', compressedBytes: body.length },
    ]);
    expect(await unpackAll()).toBeGreaterThanOrEqual(1);
    const [row] = await h.ctx.db
      .select({
        status: reviewSnapshots.status,
        branchId: reviewSnapshots.branchId,
        body: reviewSnapshots.body,
        fileCount: reviewSnapshots.fileCount,
      })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.id, answer.snapshotId));
    const [analysis] = await h.ctx.db
      .select({ branchId: analyses.branchId })
      .from(analyses)
      .where(eq(analyses.id, analysisId));
    expect(row).toEqual({
      status: 'ready',
      branchId: analysis!.branchId,
      body: null,
      fileCount: 1,
    });
    const files = await h.ctx.db
      .select({ path: reviewSnapshotFiles.path })
      .from(reviewSnapshotFiles)
      .where(eq(reviewSnapshotFiles.snapshotId, answer.snapshotId));
    expect(files.map((f) => f.path).sort()).toEqual(['logo.png', 'src/a.ts']);
  });

  it('accepts a token of a user that may analyse the project', async () => {
    const pat = await h.ctx.app.inject({
      method: 'POST',
      url: '/api/v0/tokens',
      headers: h.orgAdmin.headers,
      payload: { name: 'ci', scopes: ['analysis:write'] },
    });
    const analysisId = await mergeRequestAnalysis();
    const res = await post(analysisId, snapshotBody(), { token: pat.json().token as string });
    expect(res.statusCode, res.body).toBe(202);
  });

  it('answers 409 AI_REVIEW_OFF while review is off for the project, and stores nothing', async () => {
    const analysisId = await mergeRequestAnalysis();
    const offs: [string, () => Promise<void>][] = [
      ['review_disabled', () => configureReview({ enabled: false })],
      ['project_not_selected', () => configureReview({ scope: 'selected', projectIds: [q.id] })],
      ['consent_outdated', () => configureReview({ consent: null })],
      [
        'organization_disabled',
        () => writeLlmSettings(h.ctx.db, { ...DEFAULT_LLM_SETTINGS, provider: PROVIDER }),
      ],
    ];
    for (const [reason, off] of offs) {
      await off();
      const res = await post(analysisId, snapshotBody());
      expect([reason, res.statusCode, res.json().code]).toEqual([reason, 409, 'AI_REVIEW_OFF']);
      expect(res.json().detail).toContain(reason);
      expect(res.headers.connection).toBe('close');
    }
    await configureReview();
    const notMapped = await mergeRequestAnalysis(unmapped);
    const res = await post(notMapped, snapshotBody(), {
      token: unmapped.token,
      projectKey: unmapped.key,
    });
    expect([res.statusCode, res.json().code]).toEqual([409, 'AI_REVIEW_OFF']);
    expect(res.json().detail).toContain('not_mapped');
    expect(await snapshotsOf(analysisId)).toEqual([]);
    expect(await snapshotsOf(notMapped)).toEqual([]);
  });

  it("another project's token or analysis: 404, nothing stored (Review Focus 4)", async () => {
    const own = await mergeRequestAnalysis(p);
    const foreign = await mergeRequestAnalysis(q);
    const jobsBefore = (await snapshotJobs()).length;
    const cases: [string, string, { token: string; projectKey: string }, string][] = [
      ["another project's token", own, { token: q.token, projectKey: p.key }, 'PROJECT_NOT_FOUND'],
      [
        "an analysis of another project, with that project's own token",
        foreign,
        { token: p.token, projectKey: p.key },
        'ANALYSIS_NOT_FOUND',
      ],
      [
        "another project's analysis with its key and the wrong token",
        foreign,
        { token: p.token, projectKey: q.key },
        'PROJECT_NOT_FOUND',
      ],
      [
        'an analysis that does not exist',
        '00000000-0000-7000-8000-000000000000',
        { token: p.token, projectKey: p.key },
        'ANALYSIS_NOT_FOUND',
      ],
    ];
    for (const [name, analysisId, caller, code] of cases) {
      const res = await post(analysisId, snapshotBody(), caller);
      expect([name, res.statusCode, res.json().code]).toEqual([name, 404, code]);
      expect(res.headers.connection).toBe('close');
    }
    expect(await snapshotsOf(own)).toEqual([]);
    expect(await snapshotsOf(foreign)).toEqual([]);
    expect(await snapshotJobs()).toHaveLength(jobsBefore);
  });

  it('answers 413 SNAPSHOT_TOO_LARGE over the compressed limit, declared or streamed, and for a gzip bomb (Review Focus 5)', async () => {
    const analysisId = await mergeRequestAnalysis();
    const big = gzipSync(randomBytes(128 * KiB), { level: 0 });
    const declared = await post(analysisId, big);
    expect([declared.statusCode, declared.json().code]).toEqual([413, 'SNAPSHOT_TOO_LARGE']);
    expect(declared.json().detail).toBe(`The compressed snapshot exceeds ${64 * KiB} bytes`);
    expect(declared.headers.connection).toBe('close');
    const streamed = await post(
      analysisId,
      Readable.from([big.subarray(0, 32 * KiB), big.subarray(32 * KiB)]),
    );
    expect([streamed.statusCode, streamed.json().code]).toEqual([413, 'SNAPSHOT_TOO_LARGE']);
    // 8 MiB of zeros gzip to about 8 KiB, under the compressed limit, and inflate past 1 MiB.
    const bomb = gzipSync(Buffer.alloc(8 * MiB), { level: 9 });
    expect(bomb.length).toBeLessThan(LIMITS.maxCompressedBytes);
    const inflated = await post(analysisId, bomb);
    expect([inflated.statusCode, inflated.json().code]).toEqual([413, 'SNAPSHOT_TOO_LARGE']);
    expect(inflated.json().detail).toBe(`The decompressed snapshot exceeds ${MiB} bytes`);
    expect(await snapshotsOf(analysisId)).toEqual([]);
  });

  it('answers 415 without gzip or with another media type, and 422 SNAPSHOT_INVALID for a body that is not gzip', async () => {
    const analysisId = await mergeRequestAnalysis();
    const identity = await post(analysisId, snapshotBody(), {
      headers: { 'content-encoding': 'identity' },
    });
    expect([identity.statusCode, identity.json().code]).toEqual([415, 'UNSUPPORTED_ENCODING']);
    expect(identity.headers.connection).toBe('close');
    const json = await post(analysisId, Buffer.from('{}'), {
      headers: { 'content-type': 'application/json' },
    });
    expect([json.statusCode, json.json().code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    const report = await post(analysisId, gzipJson(sampleReport()), {
      headers: { 'content-type': REPORT_CONTENT_TYPE },
    });
    expect([report.statusCode, report.json().code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    // RFC 9110: Content-Encoding is compared case-insensitively.
    const upperCase = await post(analysisId, snapshotBody(), {
      headers: { 'content-encoding': 'GZIP' },
    });
    expect(upperCase.statusCode, upperCase.body).toBe(202);
    const other = await mergeRequestAnalysis();
    const notGzip = await post(other, Buffer.from(encodeSnapshotLine(HEADER)));
    expect([notGzip.statusCode, notGzip.json().code]).toEqual([422, 'SNAPSHOT_INVALID']);
    expect(await snapshotsOf(other)).toEqual([]);
  });

  it('answers 409 SNAPSHOT_EXISTS for a second upload of an analysis', async () => {
    const analysisId = await mergeRequestAnalysis();
    expect((await post(analysisId, snapshotBody())).statusCode).toBe(202);
    const again = await post(analysisId, snapshotBody());
    expect([again.statusCode, again.json().code]).toEqual([409, 'SNAPSHOT_EXISTS']);
    expect(await snapshotsOf(analysisId)).toHaveLength(1);
  });

  it('answers in order: 415, 404, AI_REVIEW_OFF, SNAPSHOT_EXISTS, 413', async () => {
    const analysisId = await mergeRequestAnalysis();
    expect((await post(analysisId, snapshotBody())).statusCode).toBe(202);
    const foreign = await mergeRequestAnalysis(q);
    const big = gzipSync(randomBytes(128 * KiB), { level: 0 });
    const codeOf = async (
      id: string,
      body: Buffer,
      headers: Record<string, string> = {},
    ): Promise<string> => (await post(id, body, { headers })).json().code as string;
    expect(await codeOf(foreign, big, { 'content-encoding': 'identity' })).toBe(
      'UNSUPPORTED_ENCODING',
    );
    expect(await codeOf(foreign, big)).toBe('ANALYSIS_NOT_FOUND');
    await configureReview({ enabled: false });
    expect(await codeOf(analysisId, big)).toBe('AI_REVIEW_OFF');
    await configureReview();
    expect(await codeOf(analysisId, big)).toBe('SNAPSHOT_EXISTS');
    expect(await codeOf(await mergeRequestAnalysis(), big)).toBe('SNAPSHOT_TOO_LARGE');
  });

  it('answers 503 UPLOADS_BUSY while a report upload holds the only slot: one bound for both', async () => {
    const analysisId = await mergeRequestAnalysis();
    // A report whose second half is sent only on release(): the slot stays taken until then.
    const { stream, reading, release } = gatedBody(gzipJson(sampleReport({ projectKey: p.key })));
    const held = h.ctx.app.inject({
      method: 'POST',
      url: `/api/v0/analyses?projectKey=${encodeURIComponent(p.key)}`,
      headers: {
        ...bearer(p.token),
        'content-type': REPORT_CONTENT_TYPE,
        'content-encoding': 'gzip',
      },
      payload: stream,
    });
    await reading;
    const busy = await post(analysisId, snapshotBody());
    expect([busy.statusCode, busy.json().code]).toEqual([503, 'UPLOADS_BUSY']);
    expect(busy.headers['retry-after']).toBe('1');
    expect(await snapshotsOf(analysisId)).toEqual([]);
    release();
    expect((await held).statusCode).toBe(202);
    expect((await post(analysisId, snapshotBody())).statusCode).toBe(202);
  });

  describe('Expect: 100-continue (RFC 9110 §10.1.1)', () => {
    const CONTINUE = 'HTTP/1.1 100 Continue\r\n\r\n';
    /**
     * Sends the head and collects the answer; the body follows only after `100 Continue`. The
     * client hangs up once the final answer's JSON has come, as a client honouring Expect does.
     */
    const exchange = (analysisId: string, body: Buffer): Promise<string> =>
      new Promise((resolve) => {
        let text = '';
        let sent = false;
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          socket.write(
            `POST ${url(analysisId, p.key)} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
              `Authorization: Bearer ${p.token}\r\nContent-Type: ${REVIEW_SNAPSHOT_CONTENT_TYPE}\r\n` +
              `Content-Encoding: gzip\r\nContent-Length: ${body.length}\r\n` +
              `Expect: 100-continue\r\n\r\n`,
          );
        });
        const finish = (): void => {
          socket.destroy();
          resolve(text);
        };
        socket.on('data', (d: Buffer) => {
          text += d.toString('utf8');
          if (!sent && text.startsWith(CONTINUE)) {
            sent = true;
            socket.write(body);
          }
          const final = text.startsWith(CONTINUE) ? text.slice(CONTINUE.length) : text;
          if (/^HTTP\/1\.1 [2-5]\d\d /.test(final) && final.endsWith('}')) finish();
        });
        socket.on('error', () => undefined);
        socket.on('close', finish);
      });

    it('refuses a snapshot it cannot take before its body is sent, and asks for one it takes', async () => {
      const analysisId = await mergeRequestAnalysis();
      const taken = await exchange(analysisId, snapshotBody());
      expect(taken).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 202 /);
      const refused = await exchange(analysisId, snapshotBody());
      expect(refused).not.toContain('100 Continue');
      expect(refused.startsWith('HTTP/1.1 409 ')).toBe(true);
      expect(refused).toContain('"code":"SNAPSHOT_EXISTS"');
      await configureReview({ enabled: false });
      const off = await exchange(await mergeRequestAnalysis(), snapshotBody());
      expect(off).not.toContain('100 Continue');
      expect(off).toContain('"code":"AI_REVIEW_OFF"');
    });
  });
});

describe('POST /analyses/{id}/review-snapshot: the upload slots it shares with the reports (6I-2)', () => {
  let h: IngestHarness;
  let p: IngestProject;
  let mr = 0;

  const post = (analysisId: string, body: Buffer | Readable) =>
    h.ctx.app.inject({
      method: 'POST',
      url: `/api/v0/analyses/${analysisId}/review-snapshot?projectKey=${encodeURIComponent(p.key)}`,
      headers: {
        ...bearer(p.token),
        'content-type': REVIEW_SNAPSHOT_CONTENT_TYPE,
        'content-encoding': 'gzip',
      },
      payload: body,
    });
  const mergeRequestAnalysis = async (): Promise<string> => {
    mr += 1;
    return p.ingestOk(mergeRequestReport(mr, 'c'.repeat(40), { projectKey: p.key }));
  };
  const snapshotsOf = (analysisId: string) =>
    h.ctx.db
      .select({ id: reviewSnapshots.id })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.analysisId, analysisId));

  beforeAll(async () => {
    h = await createIngestHarness({
      config: { reviewSnapshot: LIMITS, maxConcurrentUploads: 2 },
    });
    p = await h.project('rs/slots');
    await mapToGitLab(h, [[p, '7']]);
    await configureReviewOf(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('keeps the last of two slots for the reports: a snapshot is refused while another is read, a report is taken', async () => {
    const first = await mergeRequestAnalysis();
    const second = await mergeRequestAnalysis();
    const held = gatedBody(snapshotBody());
    const holding = post(first, held.stream);
    await held.reading;
    // One snapshot holds one of the two slots. Another would take the one the reports keep.
    const busy = await post(second, snapshotBody());
    expect([busy.statusCode, busy.json().code]).toEqual([503, 'UPLOADS_BUSY']);
    expect(busy.headers['retry-after']).toBe('1');
    expect(await snapshotsOf(second)).toEqual([]);
    // A report takes it, though a snapshot is being read.
    const report = await uploadReport(
      h.ctx,
      bearer(p.token),
      p.key,
      gzipJson(sampleReport({ projectKey: p.key })),
    );
    expect(report).toEqual(expect.any(String));
    held.release();
    expect((await holding).statusCode).toBe(202);
    // The slot is free again: the refused snapshot is taken when it is sent once more.
    expect((await post(second, snapshotBody())).statusCode).toBe(202);
    expect(await snapshotsOf(second)).toHaveLength(1);
  });
});
