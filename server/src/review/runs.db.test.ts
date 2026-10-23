import { gzipSync } from 'node:zlib';
import { encodeSnapshotLine, type SnapshotLine } from '@qualor/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer } from '../../test/app';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { gzipJson, reportWith, uploadReport } from '../../test/reports';
import { storeTestSnapshot, switchReviewOn } from '../../test/review';
import { mergeRequestReport } from '../../test/scm';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { first } from '../db/rows';
import { analyses, jobs, projects, reviewRuns, scmConnections } from '../db/schema';
import { gateHandlers } from '../gates/reevaluate';
import { jobHandlers } from '../ingest/handlers';
import { DEFAULT_LLM_SETTINGS, writeLlmSettings } from '../llm/settings';
import { runUntilIdle } from '../queue/worker';
import { SCM_TOKEN_AAD } from '../scm/connections';
import { lockBranchQueue, SCM_QUEUE } from '../scm/queue';
import {
  AI_REVIEW_QUEUE,
  reconcileStuckReviewRuns,
  REVIEW_SNAPSHOT_WAIT_SECONDS,
  supersedeRuns,
  wakeReviewRun,
} from './runs';
import { storeSnapshotUpload, unpackSnapshot } from './snapshot-store';

const MiB = 1024 * 1024;
const LIMITS = { maxCompressedBytes: 50 * MiB, maxDecompressedBytes: 500 * MiB };
const revision = (n: number) => String(n % 10).repeat(40);

/** The lines of a small snapshot: one changed file. */
const SNAPSHOT_LINES: SnapshotLine[] = [
  { type: 'change', path: 'src/a.ts', oldPath: null, status: 'modified', patch: null, since: null },
  { type: 'file', path: 'src/a.ts', text: 'export const a = 2;\n' },
];

describe('the review run lifecycle (6I-3, R15)', () => {
  let llm: FakeLlm;
  let h: IngestHarness;
  /** Mapped to an SCM connection: review runs for it. */
  let p: IngestProject;
  /** Not mapped: review never runs for it. */
  let unmapped: IngestProject;
  let iid = 0;
  const nextMergeRequest = () => (iid += 1);

  const reviewOn = () =>
    switchReviewOn(h.ctx.db, {
      secretKey: h.ctx.config.secretKey,
      fake: llm,
      organizationId: h.organizationId,
      userId: h.ctx.adminId,
    });
  const report = (mr: number, n = 1, projectKey = p.key) =>
    mergeRequestReport(mr, revision(n), {
      projectKey,
      analysisDate: `2026-10-0${n}T10:00:00Z`,
    });
  const runsOf = (analysisId: string) =>
    h.ctx.db.select().from(reviewRuns).where(eq(reviewRuns.analysisId, analysisId));
  const runOf = async (analysisId: string) => first(await runsOf(analysisId));
  /** The run's queued jobs, each with whether it is due now. */
  const jobsOf = (runId: string) =>
    h.ctx.db
      .select({
        id: jobs.id,
        concurrencyKey: jobs.concurrencyKey,
        maxAttempts: jobs.maxAttempts,
        runAt: jobs.runAt,
        due: sql<boolean>`${jobs.runAt} <= now()`,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, AI_REVIEW_QUEUE),
          eq(jobs.status, 'queued'),
          sql`${jobs.payload} ->> 'runId' = ${runId}`,
        ),
      );
  /** Uploads a report without processing it: the analysis stays queued. */
  const queuedAnalysis = (mr: number, n = 1) =>
    uploadReport(h.ctx, bearer(p.token), p.key, gzipJson(report(mr, n)));
  const runIngestion = () =>
    runUntilIdle(
      h.ctx.db,
      {
        ...jobHandlers({ db: h.ctx.db, upload: h.ctx.config.upload, logger: h.ctx.app.log }),
        ...gateHandlers({ db: h.ctx.db }),
      },
      h.ctx.app.log,
    );
  const snapshotOf = (analysisId: string, mr: number) =>
    storeTestSnapshot(h.ctx.db, analysisId, SNAPSHOT_LINES, {
      mergeRequest: { id: String(mr), title: 'A change', description: null },
    });
  /** Uploads a snapshot of the merge request `mr` for the analysis, without unpacking it. */
  const uploadSnapshot = (analysisId: string, mr: number) => {
    const lines: SnapshotLine[] = [
      {
        type: 'header',
        v: 1,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        sinceSha: null,
        targetBranch: 'main',
        mergeRequest: { id: String(mr), title: null, description: null },
        partial: false,
        generator: 'qualor-cli/test',
      },
      ...SNAPSHOT_LINES,
      { type: 'end', files: 1, changes: 1, omitted: 0 },
    ];
    const body = gzipSync(lines.map(encodeSnapshotLine).join(''));
    return storeSnapshotUpload(h.ctx.db, {
      analysisId,
      projectId: p.id,
      body,
      compressedBytes: body.length,
    });
  };
  /** The decorations queued for the analysis. */
  const decorationsOf = (analysisId: string) =>
    h.ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, SCM_QUEUE),
          eq(jobs.status, 'queued'),
          sql`${jobs.payload} ->> 'analysisId' = ${analysisId}`,
        ),
      );
  /** The run's job dies: its tries are spent (the reaper made it dead). */
  const jobDies = (runId: string) =>
    h.ctx.db
      .update(jobs)
      .set({ status: 'dead', lastError: 'lease expired' })
      .where(and(eq(jobs.queue, AI_REVIEW_QUEUE), sql`${jobs.payload} ->> 'runId' = ${runId}`));
  const warned: unknown[][] = [];
  const sweepLogger = {
    info: () => undefined,
    warn: (...args: unknown[]) => void warned.push(args),
  };

  beforeAll(async () => {
    llm = await createFakeLlm();
    h = await createIngestHarness();
    p = await h.project('runs/p');
    unmapped = await h.project('runs/unmapped');
    const [connection] = await h.ctx.db
      .insert(scmConnections)
      .values({
        organizationId: h.organizationId,
        provider: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        tokenEnc: encryptSecret(encryptionKey(h.ctx.config.secretKey), 'x', SCM_TOKEN_AAD),
      })
      .returning();
    await h.ctx.db
      .update(projects)
      .set({ scmConnectionId: connection!.id, scmProjectRef: '7' })
      .where(eq(projects.id, p.id));
  });
  afterAll(async () => {
    await h.close();
    await llm.close();
  });
  beforeEach(reviewOn);

  it('the stage creates a run only for merge request analyses with review active', async () => {
    // A branch analysis of a project that is reviewed: no run.
    const branchAnalysis = await p.ingestOk(
      reportWith({ projectKey: p.key, branch: 'feature/runs' }),
    );
    expect(await runsOf(branchAnalysis)).toEqual([]);
    // A merge request analysis of a project that is not mapped: no run.
    const notMapped = await unmapped.ingestOk(report(nextMergeRequest(), 1, unmapped.key));
    expect(await runsOf(notMapped)).toEqual([]);
    // No AI assistant at all: no run.
    await writeLlmSettings(h.ctx.db, DEFAULT_LLM_SETTINGS);
    const off = await p.ingestOk(report(nextMergeRequest()));
    expect(await runsOf(off)).toEqual([]);
    await reviewOn();

    const before = Date.now();
    const analysisId = await p.ingestOk(report(nextMergeRequest()));
    const after = Date.now();
    const [analysis] = await h.ctx.db
      .select({ branchId: analyses.branchId })
      .from(analyses)
      .where(eq(analyses.id, analysisId));
    const run = await runOf(analysisId);
    expect(run).toMatchObject({
      projectId: p.id,
      branchId: analysis!.branchId,
      status: 'waiting',
      phase: null,
      reason: null,
      startedAt: null,
      finishedAt: null,
    });
    // Waits 15 minutes for its snapshot; the database clock may be a little ahead of this one.
    const wait = REVIEW_SNAPSHOT_WAIT_SECONDS * 1_000;
    expect(run.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + wait - 5_000);
    expect(run.deadlineAt.getTime()).toBeLessThanOrEqual(after + wait + 5_000);
    // Its job runs at the deadline, one of the branch's runs at a time, and is tried twice at most.
    expect(await jobsOf(run.id)).toEqual([
      {
        id: expect.any(String),
        concurrencyKey: `ai-review:branch:${analysis!.branchId}`,
        maxAttempts: 2,
        runAt: run.deadlineAt,
        due: false,
      },
    ]);
  });

  it('a newer analysis supersedes the waiting run and deletes its job', async () => {
    const mr = nextMergeRequest();
    const older = await runOf(await p.ingestOk(report(mr, 1)));
    expect(await jobsOf(older.id)).toHaveLength(1);
    const newer = await runOf(await p.ingestOk(report(mr, 2)));
    expect(await runOf(older.analysisId)).toMatchObject({
      status: 'superseded',
      phase: null,
      reason: null,
      finishedAt: expect.any(Date),
    });
    expect(await jobsOf(older.id)).toEqual([]);
    expect(newer).toMatchObject({ status: 'waiting', branchId: older.branchId });
    expect(await jobsOf(newer.id)).toHaveLength(1);
    // A run already ended is left as it is.
    expect(await h.ctx.db.transaction((tx) => supersedeRuns(tx, newer.branchId, newer.id))).toBe(0);
    expect((await runOf(older.analysisId)).status).toBe('superseded');
  });

  it('a running run in storing is not superseded', async () => {
    const mr = nextMergeRequest();
    const storing = await runOf(await p.ingestOk(report(mr, 1)));
    const running = (phase: 'judge' | 'storing') =>
      h.ctx.db
        .update(reviewRuns)
        .set({ status: 'running', phase, startedAt: new Date(), headSha: revision(1) })
        .where(eq(reviewRuns.id, storing.id));
    await running('storing');
    const newer = await runOf(await p.ingestOk(report(mr, 2)));
    expect(await runOf(storing.analysisId)).toMatchObject({
      status: 'running',
      phase: 'storing',
      finishedAt: null,
    });
    expect(newer.status).toBe('waiting');
    // A run still reviewing, in any other phase, is superseded.
    const other = nextMergeRequest();
    const judging = await runOf(await p.ingestOk(report(other, 1)));
    await h.ctx.db
      .update(reviewRuns)
      .set({ status: 'running', phase: 'judge', startedAt: new Date(), headSha: revision(1) })
      .where(eq(reviewRuns.id, judging.id));
    await p.ingestOk(report(other, 2));
    expect(await runOf(judging.analysisId)).toMatchObject({
      status: 'superseded',
      phase: null,
      finishedAt: expect.any(Date),
    });
  });

  it('a snapshot uploaded before or after ingestion wakes the run once it is linked', async () => {
    // Before: the snapshot comes while its analysis is still queued. Its unpack waits for the
    // ingestion (R22), which creates the run; unpacked and linked then, it makes the run due.
    const before = nextMergeRequest();
    const queued = await queuedAnalysis(before);
    const early = await uploadSnapshot(queued, before);
    expect(await unpackSnapshot(h.ctx.db, early, LIMITS)).toBe('deferred');
    await runIngestion();
    const linked = await runOf(queued);
    expect(linked.status).toBe('waiting');
    expect(await jobsOf(linked.id)).toEqual([expect.objectContaining({ due: false })]);
    expect(await unpackSnapshot(h.ctx.db, early, LIMITS)).toBe('ready');
    expect(await jobsOf(linked.id)).toEqual([expect.objectContaining({ due: true })]);

    // After: the run waits for its deadline until the snapshot is linked.
    const later = nextMergeRequest();
    const run = await runOf(await p.ingestOk(report(later)));
    expect(await jobsOf(run.id)).toEqual([expect.objectContaining({ due: false })]);
    await snapshotOf(run.analysisId, later);
    expect(await runOf(run.analysisId)).toMatchObject({ status: 'waiting' });
    const [job] = await jobsOf(run.id);
    expect(job).toMatchObject({ due: true });
    // Waking it again moves the same job, and queues no other.
    await wakeReviewRun(h.ctx.db, run.analysisId);
    expect(await jobsOf(run.id)).toEqual([expect.objectContaining({ id: job!.id, due: true })]);
  });

  it('a snapshot of another merge request uploaded before the ingestion is refused after it, and wakes the run', async () => {
    const mr = nextMergeRequest();
    const queued = await queuedAnalysis(mr);
    const snapshotId = await uploadSnapshot(queued, mr + 1_000);
    expect(await unpackSnapshot(h.ctx.db, snapshotId, LIMITS)).toBe('deferred');
    await runIngestion();
    const run = await runOf(queued);
    expect(run.status).toBe('waiting');
    expect(await jobsOf(run.id)).toEqual([expect.objectContaining({ due: false })]);
    expect(await unpackSnapshot(h.ctx.db, snapshotId, LIMITS)).toBe('rejected');
    expect(await jobsOf(run.id)).toEqual([expect.objectContaining({ due: true })]);
  });

  it('a rejected snapshot wakes the run too', async () => {
    const mr = nextMergeRequest();
    const run = await runOf(await p.ingestOk(report(mr)));
    const body = gzipSync(
      [
        {
          type: 'header',
          v: 1,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          sinceSha: null,
          targetBranch: 'main',
          mergeRequest: { id: String(mr), title: null, description: null },
          partial: false,
          generator: 'qualor-cli/test',
        },
        { type: 'file', path: '../escape.ts', text: 'x\n' },
        { type: 'end', files: 1, changes: 0, omitted: 0 },
      ]
        .map((line) => encodeSnapshotLine(line as SnapshotLine))
        .join(''),
    );
    const snapshotId = await storeSnapshotUpload(h.ctx.db, {
      analysisId: run.analysisId,
      projectId: p.id,
      body,
      compressedBytes: body.length,
    });
    expect(await unpackSnapshot(h.ctx.db, snapshotId, LIMITS)).toBe('rejected');
    expect(await jobsOf(run.id)).toEqual([expect.objectContaining({ due: true })]);
  });

  it('a run skipped for no snapshot restarts only while its analysis is the newest', async () => {
    const mr = nextMergeRequest();
    const run = await runOf(await p.ingestOk(report(mr, 1)));
    const noSnapshot = (runId: string) =>
      h.ctx.db
        .update(reviewRuns)
        .set({ status: 'skipped', reason: 'no_snapshot', finishedAt: new Date() })
        .where(eq(reviewRuns.id, runId));
    await noSnapshot(run.id);
    await h.ctx.db.delete(jobs).where(sql`${jobs.payload} ->> 'runId' = ${run.id}`);
    await wakeReviewRun(h.ctx.db, run.analysisId);
    const restarted = await runOf(run.analysisId);
    expect(restarted).toMatchObject({ status: 'waiting', reason: null, finishedAt: null });
    expect(restarted.deadlineAt.getTime()).toBeGreaterThanOrEqual(run.deadlineAt.getTime());
    expect(await jobsOf(run.id)).toEqual([expect.objectContaining({ due: true })]);
    // A newer analysis has its own run: the older one's is never started again.
    const newer = await runOf(await p.ingestOk(report(mr, 2)));
    expect((await runOf(run.analysisId)).status).toBe('superseded');
    await noSnapshot(run.id);
    await wakeReviewRun(h.ctx.db, run.analysisId);
    expect(await runOf(run.analysisId)).toMatchObject({ status: 'skipped', reason: 'no_snapshot' });
    expect(await jobsOf(run.id)).toEqual([]);
    expect((await runOf(newer.analysisId)).status).toBe('waiting');
  });

  describe('the sweep of runs whose job is gone (reconcileStuckReviewRuns)', () => {
    beforeEach(async () => {
      // Each case sees only its own runs: the others' are ended first.
      await h.ctx.db
        .update(reviewRuns)
        .set({ status: 'superseded', phase: null, reason: null, finishedAt: new Date() })
        .where(inArray(reviewRuns.status, ['waiting', 'running']));
      warned.length = 0;
    });

    it('ends a running run whose job died as failed internal, keeps its spend and decorates it', async () => {
      const analysisId = await p.ingestOk(report(nextMergeRequest()));
      const run = await runOf(analysisId);
      await h.ctx.db
        .update(reviewRuns)
        .set({
          status: 'running',
          phase: 'specialists',
          startedAt: new Date(),
          headSha: revision(1),
          modelCalls: 2,
          inputTokens: 2_000,
          outputTokens: 200,
        })
        .where(eq(reviewRuns.id, run.id));
      await jobDies(run.id);
      await h.ctx.db.delete(jobs).where(eq(jobs.queue, SCM_QUEUE));
      expect(await reconcileStuckReviewRuns(h.ctx.db, sweepLogger)).toEqual({
        ended: 1,
        queued: 0,
      });
      expect(await runOf(analysisId)).toMatchObject({
        status: 'failed',
        reason: 'internal',
        phase: null,
        finishedAt: expect.any(Date),
        modelCalls: 2,
        inputTokens: 2_000,
        outputTokens: 200,
      });
      // Ended directly: no job is queued for it, and its end is decorated.
      expect(await jobsOf(run.id)).toEqual([]);
      expect(await decorationsOf(analysisId)).toHaveLength(1);
      expect(warned).toEqual([
        [
          { runId: run.id, status: 'failed', reason: 'internal' },
          'AI review run ended without its job',
        ],
      ]);
      // A second sweep finds nothing to do.
      expect(await reconcileStuckReviewRuns(h.ctx.db, sweepLogger)).toEqual({
        ended: 0,
        queued: 0,
      });
    });

    it('ends a waiting run past its deadline as no_snapshot; one before it gets a job at its deadline', async () => {
      const late = await runOf(await p.ingestOk(report(nextMergeRequest())));
      await h.ctx.db
        .update(reviewRuns)
        .set({ deadlineAt: sql`now() - interval '1 minute'` })
        .where(eq(reviewRuns.id, late.id));
      await jobDies(late.id);
      const early = await runOf(await p.ingestOk(report(nextMergeRequest())));
      await h.ctx.db.delete(jobs).where(sql`${jobs.payload} ->> 'runId' = ${early.id}`);
      await h.ctx.db.delete(jobs).where(eq(jobs.queue, SCM_QUEUE));
      expect(await reconcileStuckReviewRuns(h.ctx.db, sweepLogger)).toEqual({
        ended: 1,
        queued: 1,
      });
      expect(await runOf(late.analysisId)).toMatchObject({
        status: 'skipped',
        reason: 'no_snapshot',
        finishedAt: expect.any(Date),
      });
      expect(await decorationsOf(late.analysisId)).toHaveLength(1);
      // The one before its deadline waits on, with a job at the deadline, and no decoration.
      expect(await runOf(early.analysisId)).toMatchObject({ status: 'waiting', finishedAt: null });
      expect(await jobsOf(early.id)).toEqual([
        expect.objectContaining({ runAt: early.deadlineAt, due: false }),
      ]);
      expect(await decorationsOf(early.analysisId)).toEqual([]);
    });

    it('leaves a run alone while a job of it is queued or running, however old the run', async () => {
      const waiting = await runOf(await p.ingestOk(report(nextMergeRequest())));
      const running = await runOf(await p.ingestOk(report(nextMergeRequest())));
      const long = sql`now() - interval '3 hours'`;
      await h.ctx.db
        .update(reviewRuns)
        .set({ deadlineAt: long, createdAt: long })
        .where(eq(reviewRuns.id, waiting.id));
      await h.ctx.db
        .update(reviewRuns)
        .set({ status: 'running', phase: 'judge', startedAt: long, headSha: revision(1) })
        .where(eq(reviewRuns.id, running.id));
      // A long review: its job runs, its lease kept by the worker.
      await h.ctx.db
        .update(jobs)
        .set({
          status: 'running',
          attempts: 1,
          lockedBy: 'a-worker',
          lockedUntil: sql`now() + interval '20 minutes'`,
        })
        .where(sql`${jobs.payload} ->> 'runId' = ${running.id}`);
      expect(await reconcileStuckReviewRuns(h.ctx.db, sweepLogger)).toEqual({
        ended: 0,
        queued: 0,
      });
      expect((await runOf(waiting.analysisId)).status).toBe('waiting');
      expect((await runOf(running.analysisId)).status).toBe('running');
      expect(warned).toEqual([]);
    });

    it('never waits on a branch another transaction holds: the next sweep ends its run', async () => {
      const run = await runOf(await p.ingestOk(report(nextMergeRequest())));
      await jobDies(run.id);
      await h.ctx.db
        .update(reviewRuns)
        .set({ status: 'running', phase: 'judge', startedAt: new Date(), headSha: revision(1) })
        .where(eq(reviewRuns.id, run.id));
      // An ingestion of the merge request holds the branch's decoration lock meanwhile.
      await h.ctx.db.transaction(async (tx) => {
        await lockBranchQueue(tx, run.branchId);
        expect(await reconcileStuckReviewRuns(h.ctx.db, sweepLogger)).toEqual({
          ended: 0,
          queued: 0,
        });
      });
      expect((await runOf(run.analysisId)).status).toBe('running');
      expect(await reconcileStuckReviewRuns(h.ctx.db, sweepLogger)).toEqual({
        ended: 1,
        queued: 0,
      });
      expect(await runOf(run.analysisId)).toMatchObject({ status: 'failed', reason: 'internal' });
    });
  });
});
