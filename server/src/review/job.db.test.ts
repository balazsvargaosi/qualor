import { gzipSync } from 'node:zlib';
import { encodeSnapshotLine, type SnapshotLine } from '@qualor/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeGitHub, type FakeGitHub } from '../../test/fake-github';
import { createFakeGitLab, type FakeGitLab, type FakeMergeRequest } from '../../test/fake-gitlab';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import { mappedGitHubProject, pullRequestReport } from '../../test/github';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { configuredProvider } from '../../test/llm';
import {
  REVIEW_CALL_USAGE,
  reviewResponder,
  reviewRoleOf,
  storeTestSnapshot,
  switchReviewOn,
  type ReviewScript,
} from '../../test/review';
import {
  decorationDeps,
  mappedProject,
  mergeRequestReport,
  PUBLIC_URL,
  silentLogger,
} from '../../test/scm';
import { first } from '../db/rows';
import {
  analyses,
  issues,
  jobs,
  llmRequests,
  reviewFindings,
  reviewRuns,
  reviewSnapshots,
  rules,
} from '../db/schema';
import { createLlmRuntime } from '../llm/job';
import { runUntilIdle } from '../queue/worker';
import { enqueueLatestDecoration, SCM_QUEUE } from '../scm/queue';
import { parseInternalHosts } from '../scm/url';
import { reviewHandlers, type ReviewJobDeps } from './job';
import { mergeRequestStateHandlers, REVIEW_MR_STATE_QUEUE } from './lifecycle';
import { AI_REVIEW_QUEUE } from './runs';
import type { ReviewBudgets } from './settings';
import { storeSnapshotUpload, unpackSnapshot } from './snapshot-store';
import { reviewUsageToday } from './usage';

const MiB = 1024 * 1024;
const LIMITS = { maxCompressedBytes: 50 * MiB, maxDecompressedBytes: 500 * MiB };
const GITLAB_PROJECT = 710;
const GITHUB_REPOSITORY = 9_710;
/** The head and base of `storeTestSnapshot`'s header. */
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PRICING = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const revision = (n: number) => String(n % 10).repeat(40);

const CART_LINES = [
  'export function total(items: number[]): number {',
  '  let sum = 0;',
  '  for (let i = 0; i < items.length - 1; i += 1) sum += items[i];',
  '  return sum;',
  '}',
];
const CART = `${CART_LINES.join('\n')}\n`;
/** A merge request that adds one small file: a trivial change, which one reviewer and the judge read. */
const CHANGE: SnapshotLine[] = [
  {
    type: 'change',
    path: 'src/cart.ts',
    oldPath: null,
    status: 'added',
    patch: `@@ -0,0 +1,${CART_LINES.length} @@\n${CART_LINES.map((line) => `+${line}`).join('\n')}\n`,
    since: null,
  },
  { type: 'file', path: 'src/cart.ts', text: CART },
];
const FINDING = {
  category: 'logic',
  severity: 'major',
  confidence: 'high',
  path: 'src/cart.ts',
  line: 3,
  endLine: 3,
  title: 'The loop skips the last item',
  body: 'The loop stops one item early, so the last item is never added to the sum.',
};
const FOUND: ReviewScript = {
  quality: JSON.stringify({ findings: [FINDING] }),
  judge: JSON.stringify({
    findings: [{ ...FINDING, sources: ['s1'] }],
    dropped: [],
    prior: [],
    summary: { verdict: 'One logic problem in the cart total.', walkthrough: ['Adds a total.'] },
  }),
};

describe('the ai-review job (6I-3, R15)', () => {
  let llm: FakeLlm;
  let gitlab: FakeGitLab;
  let github: FakeGitHub;
  let h: IngestHarness;
  let p: IngestProject;
  /** Mapped to a repository of the fake GitHub. */
  let gh: IngestProject;
  let iid = 0;
  /** Every line the job logged. */
  const logged: unknown[][] = [];
  const logger = {
    info: (...args: unknown[]) => void logged.push(['info', ...args]),
    warn: (...args: unknown[]) => void logged.push(['warn', ...args]),
    error: (...args: unknown[]) => void logged.push(['error', ...args]),
  };

  const reviewOn = (o: { budgets?: Partial<ReviewBudgets>; pricing?: typeof PRICING } = {}) =>
    switchReviewOn(h.ctx.db, {
      secretKey: h.ctx.config.secretKey,
      fake: llm,
      organizationId: h.organizationId,
      userId: h.ctx.adminId,
      ...(o.budgets === undefined ? {} : { budgets: o.budgets }),
      over: { pricing: o.pricing ?? null },
    });
  /** The organisation switches AI review off; everything else stays as it is. */
  const reviewOff = () =>
    h.ctx.db.execute(
      sql`UPDATE instance_settings
             SET value = jsonb_set(value, ${`{organizations,${h.organizationId},review,enabled}`}::text[], 'false')
           WHERE key = 'llm'`,
    );
  /** A merge request of its own on the fake GitLab: open, and no draft, unless `over` says so. */
  const mergeRequest = (over: Partial<FakeMergeRequest> = {}): number => {
    iid += 1;
    gitlab.addMergeRequest(GITLAB_PROJECT, {
      iid,
      title: 'Add the cart total',
      state: 'opened',
      sourceBranch: `feature/${iid}`,
      targetBranch: 'main',
      headSha: HEAD,
      baseSha: BASE,
      startSha: BASE,
      diffs: [],
      ...over,
    });
    return iid;
  };
  /** The merge request's analysis, ingested: its run waits for a snapshot. */
  const analysisOf = (mr: number, n = 1) =>
    p.ingestOk(
      mergeRequestReport(mr, revision(n), {
        projectKey: p.key,
        gitlab: { projectId: String(GITLAB_PROJECT) },
        analysisDate: `2026-10-0${n}T10:00:00Z`,
      }),
    );
  const snapshotOf = (analysisId: string, mr: number, lines: SnapshotLine[] = CHANGE) =>
    storeTestSnapshot(h.ctx.db, analysisId, lines, {
      mergeRequest: { id: String(mr), title: 'Add the cart total', description: null },
    });
  const runOf = async (analysisId: string) =>
    first(await h.ctx.db.select().from(reviewRuns).where(eq(reviewRuns.analysisId, analysisId)));
  const jobDeps = (over: Partial<ReviewJobDeps> = {}): ReviewJobDeps => ({
    db: h.ctx.db,
    config: h.ctx.config,
    logger,
    llmCircuit: createLlmRuntime().circuit,
    scm: decorationDeps(h).scm,
    ...over,
  });
  /** Runs the `ai-review` jobs that are due, as its worker does. */
  const runReviews = (over: Partial<ReviewJobDeps> = {}) =>
    runUntilIdle(h.ctx.db, reviewHandlers(jobDeps(over)), silentLogger);
  /** The run's queued job is due now (as if its deadline had come). */
  const dueNow = (runId: string) =>
    h.ctx.db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(and(eq(jobs.queue, AI_REVIEW_QUEUE), sql`${jobs.payload} ->> 'runId' = ${runId}`));
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
  /** Forgets the decorations ingestion queued, so that only the job's are left to see. */
  const forgetDecorations = () => h.ctx.db.delete(jobs).where(eq(jobs.queue, SCM_QUEUE));
  const reviewCalls = () => llm.requests.filter((request) => reviewRoleOf(request) !== null);
  const aiIssuesOf = async (branchId: string) =>
    h.ctx.db
      .select({ issue: issues, finding: reviewFindings, ruleKey: rules.key })
      .from(issues)
      .innerJoin(rules, eq(rules.id, issues.ruleId))
      .leftJoin(reviewFindings, eq(reviewFindings.issueId, issues.id))
      .where(and(eq(issues.branchId, branchId), eq(rules.engineId, 'ai')));
  const snapshotsOfBranch = async (branchId: string) =>
    h.ctx.db
      .select({ id: reviewSnapshots.id })
      .from(reviewSnapshots)
      .where(
        or(
          eq(reviewSnapshots.branchId, branchId),
          inArray(
            reviewSnapshots.analysisId,
            h.ctx.db
              .select({ id: analyses.id })
              .from(analyses)
              .where(eq(analyses.branchId, branchId)),
          ),
        ),
      );

  beforeAll(async () => {
    llm = await createFakeLlm();
    gitlab = await createFakeGitLab();
    github = await createFakeGitHub();
    h = await createIngestHarness({
      config: {
        publicUrl: PUBLIC_URL,
        scmInternalHosts: parseInternalHosts(
          `${new URL(gitlab.url).host},${new URL(github.url).host}`,
        ),
        llmInternalHosts: parseInternalHosts(llm.host),
      },
    });
    gitlab.addProject({ id: GITLAB_PROJECT, path: 'acme/review' });
    p = await mappedProject(h, gitlab, 'review/p', GITLAB_PROJECT);
    github.addRepository({
      id: GITHUB_REPOSITORY,
      owner: 'acme',
      name: 'reviewed',
      installationId: 710,
    });
    gh = await mappedGitHubProject(h, github, 'review/gh', 'acme/reviewed');
  });
  afterAll(async () => {
    await h.close();
    await gitlab.close();
    await github.close();
    await llm.close();
  });
  beforeEach(async () => {
    await reviewOn();
    logged.length = 0;
  });

  it('a full run with reviewResponder stores issues, writes usage on the run and queues decoration', async () => {
    await reviewOn({ pricing: PRICING });
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    const snapshotId = await snapshotOf(analysisId, mr);
    await forgetDecorations();
    const calls = reviewCalls().length;
    llm.enqueue(reviewResponder(FOUND), reviewResponder(FOUND));
    expect(await runReviews()).toBe(1);

    // One reviewer for a trivial change, then the judge.
    expect(reviewCalls().slice(calls).map(reviewRoleOf)).toEqual(['quality', 'judge']);
    const run = await runOf(analysisId);
    const { input, output } = REVIEW_CALL_USAGE;
    expect(run).toMatchObject({
      status: 'done',
      phase: null,
      reason: null,
      snapshotId,
      headSha: HEAD,
      sinceSha: null,
      snapshotPartial: false,
      tier: 'trivial',
      reviewers: ['quality'],
      providerHost: llm.host,
      model: 'fake-model',
      modelCalls: 2,
      toolCalls: 0,
      inputTokens: 2 * input,
      outputTokens: 2 * output,
      costMicroUsd: 2 * (input * PRICING.inputUsdPerMTok + output * PRICING.outputUsdPerMTok),
      findingsNew: 1,
      findingsOpen: 1,
      findingsFixed: 0,
      summary: {
        verdict: 'One logic problem in the cart total.',
        walkthrough: ['Adds a total.'],
        notes: [],
      },
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date),
    });
    expect(run.diffDigest).toMatch(/^[0-9a-f]{64}$/);
    const stored = await aiIssuesOf(run.branchId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      ruleKey: 'ai:logic',
      issue: { path: 'src/cart.ts', startLine: 3, severity: 'medium', status: 'open' },
      finding: { runId: run.id, anchorLine: 3, reviewedHeadSha: HEAD },
    });
    // Every call is a row of its own feature.
    const rows = await h.ctx.db
      .select({ feature: llmRequests.feature, projectId: llmRequests.projectId })
      .from(llmRequests)
      .where(eq(llmRequests.feature, 'review'));
    expect(rows.filter((row) => row.projectId === p.id).length).toBeGreaterThanOrEqual(2);
    expect(await decorationsOf(analysisId)).toHaveLength(1);
    // Nothing of the repository or of the model's words is logged.
    const log = JSON.stringify(logged);
    expect(log).toContain(run.id);
    for (const text of [CART_LINES[2]!, FINDING.title, FINDING.body]) {
      expect(log).not.toContain(text);
    }
  });

  it('a rejected snapshot ends the run as snapshot_rejected', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    const body = gzipSync(
      [
        {
          type: 'header',
          v: 1,
          headSha: HEAD,
          baseSha: BASE,
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
      analysisId,
      projectId: p.id,
      body,
      compressedBytes: body.length,
    });
    expect(await unpackSnapshot(h.ctx.db, snapshotId, LIMITS)).toBe('rejected');
    await forgetDecorations();
    // Woken by the rejection: it does not wait for its deadline.
    expect(await runReviews()).toBe(1);
    expect(await runOf(analysisId)).toMatchObject({
      status: 'skipped',
      reason: 'snapshot_rejected',
      detail: 'SNAPSHOT_INVALID',
      startedAt: null,
      finishedAt: expect.any(Date),
    });
    expect(await decorationsOf(analysisId)).toHaveLength(1);
  });

  it('the deadline ends it as no_snapshot and a late snapshot restarts it', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    const waiting = await runOf(analysisId);
    await forgetDecorations();
    // Before its deadline a run without a snapshot waits on: its job comes back at the deadline.
    await dueNow(waiting.id);
    expect(await runReviews()).toBe(1);
    expect(await runOf(analysisId)).toMatchObject({ status: 'waiting', finishedAt: null });
    const [again] = await h.ctx.db
      .select({ runAt: jobs.runAt })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, AI_REVIEW_QUEUE),
          eq(jobs.status, 'queued'),
          sql`${jobs.payload} ->> 'runId' = ${waiting.id}`,
        ),
      );
    expect(again?.runAt).toEqual(waiting.deadlineAt);
    expect(await decorationsOf(analysisId)).toEqual([]);

    // At the deadline, still no snapshot.
    await dueNow(waiting.id);
    const late = new Date(waiting.deadlineAt.getTime() + 1_000);
    expect(await runReviews({ now: () => late })).toBe(1);
    expect(await runOf(analysisId)).toMatchObject({
      status: 'skipped',
      reason: 'no_snapshot',
      finishedAt: expect.any(Date),
    });
    expect(await decorationsOf(analysisId)).toHaveLength(1);

    // The snapshot comes after all: the run waits again, with a new deadline, and is due at once.
    await forgetDecorations();
    await snapshotOf(analysisId, mr);
    const restarted = await runOf(analysisId);
    expect(restarted).toMatchObject({ status: 'waiting', reason: null, finishedAt: null });
    expect(restarted.deadlineAt.getTime()).toBeGreaterThanOrEqual(waiting.deadlineAt.getTime());
    llm.enqueue(reviewResponder(), reviewResponder());
    expect(await runReviews()).toBe(1);
    expect(await runOf(analysisId)).toMatchObject({ status: 'done', findingsNew: 0 });
    expect(await decorationsOf(analysisId)).toHaveLength(1);
  });

  it('a merged merge request deletes the snapshots and ends the run as closed', async () => {
    for (const state of ['merged', 'closed'] as const) {
      const mr = mergeRequest({ state });
      const analysisId = await analysisOf(mr);
      await snapshotOf(analysisId, mr);
      await forgetDecorations();
      const calls = reviewCalls().length;
      expect(await runReviews()).toBe(1);
      const run = await runOf(analysisId);
      expect([state, run.status, run.reason]).toEqual([state, 'skipped', 'closed']);
      expect(run.startedAt).toEqual(expect.any(Date));
      expect(await snapshotsOfBranch(run.branchId)).toEqual([]);
      expect(reviewCalls()).toHaveLength(calls);
      expect(await decorationsOf(analysisId)).toHaveLength(1);
    }
  });

  it('a draft is skipped', async () => {
    const mr = mergeRequest({ draft: true });
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    await forgetDecorations();
    const calls = reviewCalls().length;
    expect(await runReviews()).toBe(1);
    const run = await runOf(analysisId);
    expect(run).toMatchObject({ status: 'skipped', reason: 'draft', headSha: HEAD });
    expect(reviewCalls()).toHaveLength(calls);
    // The snapshot stays: the merge request is still open.
    expect(await snapshotsOfBranch(run.branchId)).toHaveLength(1);
    expect(await decorationsOf(analysisId)).toHaveLength(1);
  });

  it('a merge request the provider cannot be asked about is reviewed all the same', async () => {
    // No such merge request on the fake: GitLab answers 404, and the review goes on.
    const analysisId = await analysisOf(9_000);
    await snapshotOf(analysisId, 9_000);
    llm.enqueue(reviewResponder(), reviewResponder());
    expect(await runReviews()).toBe(1);
    expect(await runOf(analysisId)).toMatchObject({ status: 'done' });
  });

  it('an unchanged diff is skipped', async () => {
    const mr = mergeRequest();
    const first1 = await analysisOf(mr, 1);
    await snapshotOf(first1, mr);
    llm.enqueue(reviewResponder(FOUND), reviewResponder(FOUND));
    expect(await runReviews()).toBe(1);
    const done = await runOf(first1);
    expect(done.status).toBe('done');
    // A push that changes nothing the review reads (an amend, a rebase onto the same tree).
    const second = await analysisOf(mr, 2);
    await snapshotOf(second, mr);
    await forgetDecorations();
    const calls = reviewCalls().length;
    expect(await runReviews()).toBe(1);
    const skipped = await runOf(second);
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'unchanged' });
    expect(skipped.diffDigest).toBe(done.diffDigest);
    expect(reviewCalls()).toHaveLength(calls);
    expect(await decorationsOf(second)).toHaveLength(1);
    // The first review's finding is left as it is.
    expect(await aiIssuesOf(done.branchId)).toHaveLength(1);
  });

  it('a spent budget is skipped', async () => {
    // The organisation's tokens of the day are used up.
    const used = await reviewUsageToday(h.ctx.db, h.organizationId);
    await reviewOn({ budgets: { tokensPerDay: used.tokens } });
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    const calls = reviewCalls().length;
    expect(await runReviews()).toBe(1);
    const spent = await runOf(analysisId);
    expect(spent).toMatchObject({ status: 'skipped', reason: 'budget_spent' });
    expect(spent.diffDigest).toMatch(/^[0-9a-f]{64}$/);
    // A review whose smallest share cannot hold even its first message is not started either.
    await reviewOn({ budgets: { maxTokensPerReview: 1_000 } });
    const small = mergeRequest();
    const tiny = await analysisOf(small);
    await snapshotOf(tiny, small);
    expect(await runReviews()).toBe(1);
    expect(await runOf(tiny)).toMatchObject({ status: 'skipped', reason: 'budget_spent' });
    expect(reviewCalls()).toHaveLength(calls);
  });

  it('a run superseded between two model calls stores nothing', async () => {
    const mr = mergeRequest();
    const older = await analysisOf(mr, 1);
    await snapshotOf(older, mr);
    let newer: string | undefined;
    // The quality reviewer answers once a newer push of the merge request has been ingested.
    llm.enqueue(
      reviewResponder({
        quality: async () => {
          newer = await analysisOf(mr, 2);
          return JSON.stringify({ findings: [FINDING] });
        },
      }),
    );
    const calls = reviewCalls().length;
    expect(await runReviews()).toBe(1);
    expect(newer).toBeDefined();
    const run = await runOf(older);
    expect(run).toMatchObject({ status: 'superseded', modelCalls: 1, findingsNew: 0 });
    expect(reviewCalls().slice(calls).map(reviewRoleOf)).toEqual(['quality']);
    expect(await aiIssuesOf(run.branchId)).toEqual([]);
    // Only the newer analysis is decorated (its ingestion queued that); the job queued nothing.
    expect(await decorationsOf(older)).toEqual([]);
    expect(await decorationsOf(newer!)).toHaveLength(1);
    expect((await runOf(newer!)).status).toBe('waiting');
  });

  it('review switched off during the run stops it as inactive and stores nothing', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    await forgetDecorations();
    // The judge answers once the organisation has switched review off: after the last call.
    llm.enqueue(
      reviewResponder(FOUND),
      reviewResponder({
        ...FOUND,
        judge: async () => {
          await reviewOff();
          return FOUND.judge as string;
        },
      }),
    );
    expect(await runReviews()).toBe(1);
    const run = await runOf(analysisId);
    expect(run).toMatchObject({
      status: 'skipped',
      reason: 'inactive',
      detail: 'review_disabled',
      modelCalls: 2,
      findingsNew: 0,
    });
    expect(await aiIssuesOf(run.branchId)).toEqual([]);
    // Its end is decorated: the summary says the review did not run to the end.
    expect(await decorationsOf(analysisId)).toHaveLength(1);
  });

  /**
   * The merge request is merged, and the hourly check of its snapshot, come due, deletes the copy
   * (what a decoration or another review would do on seeing the merge as well).
   */
  const mergeAndCheck = async (mr: number, branchId: string) => {
    gitlab.updateMergeRequest(GITLAB_PROJECT, mr, { state: 'merged' });
    await h.ctx.db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(
        and(
          eq(jobs.queue, REVIEW_MR_STATE_QUEUE),
          eq(jobs.status, 'queued'),
          sql`${jobs.payload} ->> 'branchId' = ${branchId}`,
        ),
      );
    await runUntilIdle(h.ctx.db, mergeRequestStateHandlers(decorationDeps(h)), silentLogger);
    expect(await snapshotsOfBranch(branchId)).toEqual([]);
  };
  /** A run that stopped for its deleted snapshot stored nothing, and says so. */
  const expectStoppedForSnapshot = async (
    analysisId: string,
    modelCalls: number,
  ): Promise<void> => {
    const run = await runOf(analysisId);
    expect(run).toMatchObject({
      status: 'skipped',
      reason: 'closed',
      detail: 'snapshot_deleted',
      snapshotId: null,
      modelCalls,
      findingsNew: 0,
      finishedAt: expect.any(Date),
    });
    expect(await aiIssuesOf(run.branchId)).toEqual([]);
    expect(
      await h.ctx.db
        .select({ issueId: reviewFindings.issueId })
        .from(reviewFindings)
        .where(eq(reviewFindings.runId, run.id)),
    ).toEqual([]);
    // Its end is decorated like any other, so that the summary leaves "in progress".
    expect(await decorationsOf(analysisId)).toHaveLength(1);
  };

  it('a merge request merged during its review stops the run and stores nothing', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    const { branchId } = await runOf(analysisId);
    await forgetDecorations();
    const calls = reviewCalls().length;
    // The quality reviewer answers once the copy it reads has been deleted.
    llm.enqueue(
      reviewResponder({
        quality: async () => {
          await mergeAndCheck(mr, branchId);
          return JSON.stringify({ findings: [FINDING] });
        },
      }),
    );
    expect(await runReviews()).toBe(1);
    // It stopped before the judge was asked, and stored nothing of what the reviewer said.
    expect(reviewCalls().slice(calls).map(reviewRoleOf)).toEqual(['quality']);
    await expectStoppedForSnapshot(analysisId, 1);
  });

  it('a merge request merged while the judge answers is found before anything is stored', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    const { branchId } = await runOf(analysisId);
    await forgetDecorations();
    // The last call answers after the merge: the check that comes after it, before the store.
    llm.enqueue(
      reviewResponder(FOUND),
      reviewResponder({
        ...FOUND,
        judge: async () => {
          await mergeAndCheck(mr, branchId);
          return FOUND.judge as string;
        },
      }),
    );
    expect(await runReviews()).toBe(1);
    await expectStoppedForSnapshot(analysisId, 2);
  });

  it('a waiting run whose analysis is no longer the newest is superseded', async () => {
    const mr = mergeRequest();
    const older = await analysisOf(mr, 1);
    const run = await runOf(older);
    // A newer push while review is off: no newer run supersedes this one.
    await reviewOff();
    const newer = await analysisOf(mr, 2);
    await reviewOn();
    await forgetDecorations();
    await dueNow(run.id);
    expect(await runReviews()).toBe(1);
    expect(await runOf(older)).toMatchObject({
      status: 'superseded',
      finishedAt: expect.any(Date),
    });
    expect(await decorationsOf(older)).toEqual([]);
    expect(
      await h.ctx.db.select().from(reviewRuns).where(eq(reviewRuns.analysisId, newer)),
    ).toEqual([]);
  });

  it('a run that ends after a newer push queues no decoration over the newer one', async () => {
    const mr = mergeRequest();
    const older = await analysisOf(mr, 1);
    const newer = await analysisOf(mr, 2);
    const { branchId } = await runOf(newer);
    const queued = await decorationsOf(newer);
    expect(queued).toHaveLength(1);
    expect(
      await enqueueLatestDecoration(h.ctx.db, { analysisId: older, branchId, gitlab: null }),
    ).toBe(false);
    expect(await decorationsOf(newer)).toEqual(queued);
    expect(await decorationsOf(older)).toEqual([]);
    expect(
      await enqueueLatestDecoration(h.ctx.db, { analysisId: newer, branchId, gitlab: null }),
    ).toBe(true);
    const again = await decorationsOf(newer);
    expect(again).toHaveLength(1);
    expect(again).not.toEqual(queued);
  });

  it('a crash ends the run as failed internal and still queues decoration', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    const snapshotId = await snapshotOf(analysisId, mr);
    // A stored snapshot the reader cannot read: a fault of the server, not of the scanner.
    await h.ctx.db
      .update(reviewSnapshots)
      .set({ instructions: sql`'{"not": "a list"}'::jsonb` })
      .where(eq(reviewSnapshots.id, snapshotId));
    await forgetDecorations();
    const calls = reviewCalls().length;
    expect(await runReviews()).toBe(1);
    const run = await runOf(analysisId);
    expect(run).toMatchObject({
      status: 'failed',
      reason: 'internal',
      phase: null,
      finishedAt: expect.any(Date),
    });
    expect(reviewCalls()).toHaveLength(calls);
    expect(await decorationsOf(analysisId)).toHaveLength(1);
    const failures = logged.filter(([level]) => level === 'error');
    expect(failures).toEqual([
      [
        'error',
        expect.objectContaining({ runId: run.id, errorClass: 'TypeError' }),
        expect.any(String),
      ],
    ]);
    // The job completed: it is never tried again into more spend.
    const [job] = await h.ctx.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.queue, AI_REVIEW_QUEUE), sql`${jobs.payload} ->> 'runId' = ${run.id}`));
    expect(job).toEqual({ status: 'succeeded' });

    // A run its job finds running already was left so by a job that died: it ends failed too,
    // and what that job wrote of its spend stays (this job spent nothing).
    const other = mergeRequest();
    const crashed = await analysisOf(other);
    const stuck = await runOf(crashed);
    const spent = {
      providerHost: llm.host,
      model: 'fake-model',
      modelCalls: 3,
      toolCalls: 1,
      inputTokens: 3_000,
      outputTokens: 300,
      costMicroUsd: 13_500,
    };
    await h.ctx.db
      .update(reviewRuns)
      .set({ status: 'running', startedAt: new Date(), headSha: HEAD, ...spent })
      .where(eq(reviewRuns.id, stuck.id));
    await dueNow(stuck.id);
    await forgetDecorations();
    expect(await runReviews()).toBe(1);
    expect(await runOf(crashed)).toMatchObject({
      status: 'failed',
      reason: 'internal',
      ...spent,
    });
    expect(await decorationsOf(crashed)).toHaveLength(1);
  });

  it('a failure before the run starts leaves it as it was for the second try: an end and its decoration are one step', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    const run = await runOf(analysisId);
    await forgetDecorations();
    // Review is off when the job decides: it ends the run, and the decoration it queues with that
    // end fails once, as a database can.
    await reviewOff();
    await h.ctx.db.execute(sql`CREATE SEQUENCE review_test_fail_once`);
    await h.ctx.db.execute(sql`
      CREATE FUNCTION review_test_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.queue = 'scm' AND nextval('review_test_fail_once') = 1 THEN
          RAISE EXCEPTION 'a transient failure' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END $$`);
    await h.ctx.db.execute(sql`
      CREATE TRIGGER review_test_fail_once BEFORE INSERT ON jobs
         FOR EACH ROW EXECUTE FUNCTION review_test_fail_once()`);
    try {
      expect(await runReviews()).toBe(1);
      // Nothing of that step is kept: the run waits, undecorated, and its job is tried again.
      expect(await runOf(analysisId)).toMatchObject({ status: 'waiting', finishedAt: null });
      expect(await decorationsOf(analysisId)).toEqual([]);
      const [job] = await h.ctx.db
        .select({ status: jobs.status, attempts: jobs.attempts })
        .from(jobs)
        .where(and(eq(jobs.queue, AI_REVIEW_QUEUE), sql`${jobs.payload} ->> 'runId' = ${run.id}`));
      expect(job).toEqual({ status: 'queued', attempts: 1 });
      expect(logged).toContainEqual([
        'warn',
        { runId: run.id, errorClass: expect.any(String), code: '40001' },
        'AI review run not decided; its job is tried again',
      ]);
      expect(logged.filter(([level]) => level === 'error')).toEqual([]);
      // The second try decides it: ended, and decorated in the same step.
      await dueNow(run.id);
      expect(await runReviews()).toBe(1);
      expect(await runOf(analysisId)).toMatchObject({
        status: 'skipped',
        reason: 'inactive',
        detail: 'review_disabled',
      });
      expect(await decorationsOf(analysisId)).toHaveLength(1);
    } finally {
      await h.ctx.db.execute(sql`DROP TRIGGER review_test_fail_once ON jobs`);
      await h.ctx.db.execute(sql`DROP FUNCTION review_test_fail_once()`);
      await h.ctx.db.execute(sql`DROP SEQUENCE review_test_fail_once`);
    }
  });

  it('an error before the run starts that comes again on its last try ends the run failed', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    const run = await runOf(analysisId);
    await forgetDecorations();
    // The run cannot start, on either try: its snapshot is gone under the start (23503) each time.
    await h.ctx.db.execute(sql`
      CREATE FUNCTION review_test_never_starts() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'waiting' AND NEW.status = 'running' THEN
          RAISE EXCEPTION 'the snapshot is gone' USING ERRCODE = '23503';
        END IF;
        RETURN NEW;
      END $$`);
    await h.ctx.db.execute(sql`
      CREATE TRIGGER review_test_never_starts BEFORE UPDATE ON review_runs
         FOR EACH ROW EXECUTE FUNCTION review_test_never_starts()`);
    const notDecided = 'AI review run not decided; its job is tried again';
    const jobOfRun = async () =>
      first(
        await h.ctx.db
          .select({ status: jobs.status, attempts: jobs.attempts })
          .from(jobs)
          .where(
            and(eq(jobs.queue, AI_REVIEW_QUEUE), sql`${jobs.payload} ->> 'runId' = ${run.id}`),
          ),
      );
    try {
      // The first try is tried again: such a race is over by the second, as a rule.
      expect(await runReviews()).toBe(1);
      expect(await runOf(analysisId)).toMatchObject({ status: 'waiting', finishedAt: null });
      expect(await jobOfRun()).toEqual({ status: 'queued', attempts: 1 });
      expect(logged).toContainEqual([
        'warn',
        { runId: run.id, errorClass: expect.any(String), code: '23503' },
        notDecided,
      ]);
      // The last try fails as the first did: the run ends failed, with its decoration, rather than
      // be left to the sweep (which would say it had no snapshot), and the job completes.
      logged.length = 0;
      await dueNow(run.id);
      expect(await runReviews()).toBe(1);
      expect(await runOf(analysisId)).toMatchObject({
        status: 'failed',
        reason: 'internal',
        startedAt: null,
        finishedAt: expect.any(Date),
      });
      expect(await decorationsOf(analysisId)).toHaveLength(1);
      expect(await jobOfRun()).toEqual({ status: 'succeeded', attempts: 2 });
      expect(logged.filter((line) => line[2] === notDecided)).toEqual([]);
      expect(logged).toContainEqual([
        'error',
        { runId: run.id, errorClass: expect.any(String), code: '23503' },
        'AI review run failed',
      ]);
    } finally {
      await h.ctx.db.execute(sql`DROP TRIGGER review_test_never_starts ON review_runs`);
      await h.ctx.db.execute(sql`DROP FUNCTION review_test_never_starts()`);
    }
  });

  it('a provider changed during the run stops it before its next call', async () => {
    const mr = mergeRequest();
    const analysisId = await analysisOf(mr);
    await snapshotOf(analysisId, mr);
    await forgetDecorations();
    // The quality reviewer answers once the instance has moved to another model, with a consent
    // that names it: review is still on, but not with the provider the run started with (R10).
    llm.enqueue(
      reviewResponder({
        quality: async () => {
          await switchReviewOn(h.ctx.db, {
            secretKey: h.ctx.config.secretKey,
            fake: llm,
            organizationId: h.organizationId,
            userId: h.ctx.adminId,
            over: {
              pricing: null,
              provider: {
                ...configuredProvider(h.ctx.config.secretKey, llm),
                model: 'other-model',
              },
            },
          });
          return JSON.stringify({ findings: [FINDING] });
        },
      }),
    );
    const calls = reviewCalls().length;
    expect(await runReviews()).toBe(1);
    const run = await runOf(analysisId);
    expect(run).toMatchObject({
      status: 'skipped',
      reason: 'inactive',
      detail: 'provider_changed',
      modelCalls: 1,
      model: 'fake-model',
      findingsNew: 0,
    });
    // The judge was never asked, of either model.
    expect(reviewCalls().slice(calls).map(reviewRoleOf)).toEqual(['quality']);
    expect(await aiIssuesOf(run.branchId)).toEqual([]);
    expect(await decorationsOf(analysisId)).toHaveLength(1);
  });

  it('a GitHub pull request is decorated with its Actions context, and one without it is not', async () => {
    const pull = (number: number) =>
      github.addPull(GITHUB_REPOSITORY, {
        number,
        title: 'Add the cart total',
        headSha: HEAD,
        baseSha: BASE,
        files: [],
        state: 'open',
        draft: true,
      });
    const githubContext = { repositoryId: String(GITHUB_REPOSITORY), checkout: 'head' as const };
    pull(1);
    const analysisId = await gh.ingestOk(
      pullRequestReport(1, revision(1), {
        projectKey: gh.key,
        analysisDate: '2026-10-01T10:00:00Z',
        github: githubContext,
      }),
    );
    await snapshotOf(analysisId, 1);
    await forgetDecorations();
    expect(await runReviews()).toBe(1);
    // A draft on GitHub, as the provider says now: skipped, and the summary says so.
    expect(await runOf(analysisId)).toMatchObject({ status: 'skipped', reason: 'draft' });
    const queued = await h.ctx.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, SCM_QUEUE),
          eq(jobs.status, 'queued'),
          sql`${jobs.payload} ->> 'analysisId' = ${analysisId}`,
        ),
      );
    expect(queued).toEqual([
      { payload: { analysisId, attempt: 0, gitlab: null, github: githubContext } },
    ]);

    // An analysis an older CLI sent, without the Actions context: which revision it checked out
    // is unknown, so it is not decorated (fail closed), and that is said once.
    pull(2);
    const older = pullRequestReport(2, revision(2), {
      projectKey: gh.key,
      analysisDate: '2026-10-02T10:00:00Z',
    });
    const scm = { ...older.scm };
    delete scm.github;
    const withoutContext = await gh.ingestOk({ ...older, scm });
    await snapshotOf(withoutContext, 2);
    await forgetDecorations();
    logged.length = 0;
    expect(await runReviews()).toBe(1);
    const run = await runOf(withoutContext);
    expect(run).toMatchObject({ status: 'skipped', reason: 'draft' });
    expect(await decorationsOf(withoutContext)).toEqual([]);
    expect(logged).toContainEqual([
      'warn',
      { runId: run.id, analysisId: withoutContext },
      'AI review ended but not decorated: the analysis has no stored GitHub Actions context',
    ]);
  });

  it('a run of an analysis from another provider than its project connection is not decorated, and says so', async () => {
    // A GitHub Actions report uploaded to the project mapped to GitLab (github.md §5.1).
    const analysisId = await p.ingestOk(
      pullRequestReport(9_100, revision(1), {
        projectKey: p.key,
        analysisDate: '2026-10-01T10:00:00Z',
      }),
    );
    const run = await runOf(analysisId);
    await forgetDecorations();
    await dueNow(run.id);
    const late = new Date(run.deadlineAt.getTime() + 1_000);
    expect(await runReviews({ now: () => late })).toBe(1);
    expect(await runOf(analysisId)).toMatchObject({ status: 'skipped', reason: 'no_snapshot' });
    expect(await decorationsOf(analysisId)).toEqual([]);
    expect(logged).toContainEqual([
      'warn',
      { runId: run.id, analysisId, provider: 'github', connection: 'gitlab' },
      "AI review ended but not decorated: the analysis is not of the provider of its project's SCM connection",
    ]);
  });
});
