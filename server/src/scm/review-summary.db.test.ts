import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { seedIssue, seedRule } from '../../test/issues';
import { seedAiIssue } from '../../test/review';
import { first } from '../db/rows';
import {
  analyses,
  branches,
  organizations,
  projects,
  reviewFindings,
  reviewRuns,
  type AiCategory,
} from '../db/schema';
import { loadReviewSummary } from './decoration-data';

const PUBLIC_URL = 'https://qualor.example.com';
const HEAD = 'a'.repeat(40);

/** The summary of a finished review as the run stores it. */
const STORED_SUMMARY = {
  verdict: 'Adds refunds; one retry path can charge twice.',
  walkthrough: ['Adds a refund endpoint', 'Validates the amount'],
  notes: ['reviewer_unreadable'],
};

describe('the state of the AI review for the summary', () => {
  let t: TestDatabase;
  let projectId: string;
  let eslint: string;
  let n = 0;

  /** A new analysis of the branch, which becomes its newest. */
  const newerAnalysis = async (branchId: string) => {
    const id = first(await t.db.insert(analyses).values({ projectId, branchId }).returning()).id;
    await t.db.update(branches).set({ lastAnalysisId: id }).where(eq(branches.id, branchId));
    return id;
  };
  /** A branch with an analysis that is its newest, and the review run of that analysis when `run` is given. */
  const setup = async (run?: Partial<typeof reviewRuns.$inferInsert>) => {
    n += 1;
    const branchId = first(
      await t.db
        .insert(branches)
        .values({ projectId, kind: 'merge_request', name: String(n) })
        .returning(),
    ).id;
    const analysisId = await newerAnalysis(branchId);
    let runId: string | null = null;
    if (run !== undefined) {
      runId = first(
        await t.db
          .insert(reviewRuns)
          .values({
            projectId,
            branchId,
            analysisId,
            status: 'done',
            deadlineAt: new Date(),
            headSha: HEAD,
            summary: STORED_SUMMARY,
            ...run,
          })
          .returning(),
      ).id;
    }
    return { branchId, analysisId, runId };
  };
  /** An open AI issue with its finding row (`anchorLine` null: not on a changed line). */
  const aiFinding = async (
    branchId: string,
    over: {
      category?: AiCategory;
      path?: string;
      line?: number;
      severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
      status?: 'open' | 'resolved' | 'wont_fix' | 'false_positive' | 'closed';
      anchorLine?: number | null;
      body?: string;
      withRow?: boolean;
    } = {},
  ) => {
    const category = over.category ?? 'logic';
    const id = await seedAiIssue(t.db, {
      branchId,
      category,
      path: over.path ?? 'src/a.ts',
      line: over.line ?? 1,
      ...(over.status === undefined ? {} : { status: over.status }),
      ...(over.severity === undefined ? {} : { severity: over.severity }),
    });
    if (over.withRow !== false) {
      await t.db.insert(reviewFindings).values({
        issueId: id,
        category,
        body: over.body ?? `Body of ${id}`,
        anchorLine: over.anchorLine === undefined ? 5 : over.anchorLine,
        reviewedHeadSha: HEAD,
      });
    }
    return id;
  };
  const state = (analysisId: string, publicUrl: string | null = PUBLIC_URL) =>
    loadReviewSummary(t.db, analysisId, publicUrl);
  const done = async (analysisId: string) => {
    const loaded = await state(analysisId);
    if (loaded?.kind !== 'done') throw new Error(`not done: ${JSON.stringify(loaded)}`);
    return loaded;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'rs', name: 'Rs' }).returning(),
    ).id;
    projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'rs/api', name: 'api' })
        .returning(),
    ).id;
    eslint = await seedRule(t.db, { key: 'eslint:no-eval' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('is null for an analysis with no run', async () => {
    const { analysisId } = await setup();
    expect(await state(analysisId)).toBeNull();
    expect(await state('01920000-0000-7000-8000-00000000dead')).toBeNull();
  });

  it('says in progress for a run that waits or runs', async () => {
    for (const status of ['waiting', 'running'] as const) {
      const { analysisId } = await setup({ status, headSha: null, summary: null });
      expect(await state(analysisId)).toEqual({ kind: 'pending' });
    }
  });

  it('gives the reason and the detail of a run that was skipped, and the reason of one that failed', async () => {
    const skipped = await setup({
      status: 'skipped',
      reason: 'snapshot_rejected',
      detail: 'SNAPSHOT_INVALID',
      summary: null,
    });
    expect(await state(skipped.analysisId)).toEqual({
      kind: 'skipped',
      reason: 'snapshot_rejected',
      detail: 'SNAPSHOT_INVALID',
    });
    const noDetail = await setup({ status: 'skipped', reason: 'draft', summary: null });
    expect(await state(noDetail.analysisId)).toEqual({
      kind: 'skipped',
      reason: 'draft',
      detail: null,
    });
    const failed = await setup({ status: 'failed', reason: 'bad_answer', summary: null });
    expect(await state(failed.analysisId)).toEqual({
      kind: 'failed',
      reason: 'bad_answer',
      detail: null,
    });
    // The window that had no room for the judge is said by the detail of a failure.
    const windowFull = await setup({
      status: 'failed',
      reason: 'provider_error',
      detail: 'window_full',
      summary: null,
    });
    expect(await state(windowFull.analysisId)).toEqual({
      kind: 'failed',
      reason: 'provider_error',
      detail: 'window_full',
    });
  });

  it('shows nothing for a run an older analysis was superseded by', async () => {
    const { analysisId } = await setup({ status: 'superseded', summary: null });
    expect(await state(analysisId)).toBeNull();
  });

  it('gives the stored summary, the reviewed commit and what the run knows of itself', async () => {
    const { analysisId } = await setup({
      tokenLimitReached: true,
      snapshotPartial: true,
    });
    expect(await state(analysisId)).toEqual({
      kind: 'done',
      verdict: 'Adds refunds; one retry path can charge twice.',
      walkthrough: ['Adds a refund endpoint', 'Validates the amount'],
      counts: { high: 0, medium: 0, low: 0 },
      unplaced: [],
      moreUnplaced: 0,
      reviewedSha: HEAD,
      mergeRequestHeadSha: null,
      tokenLimitReached: true,
      snapshotPartial: true,
      notes: ['reviewer_unreadable'],
      fixPrompt: [],
    });
  });

  it('shows a finished review whose stored summary cannot be read without a verdict', async () => {
    for (const summary of [null, { verdict: 3 }, { verdict: 'x', extra: true }, 'text']) {
      const { analysisId } = await setup({ summary });
      const loaded = await done(analysisId);
      expect(loaded).toMatchObject({ verdict: '', walkthrough: [], notes: [], reviewedSha: HEAD });
    }
    const { analysisId } = await setup({ headSha: null });
    expect((await done(analysisId)).reviewedSha).toBe('');
  });

  it('counts the open AI findings of the branch by severity, and nothing else', async () => {
    const { branchId, analysisId } = await setup({});
    const other = await setup({});
    await aiFinding(branchId, { severity: 'blocker', line: 1 });
    await aiFinding(branchId, { severity: 'high', line: 2 });
    await aiFinding(branchId, { severity: 'medium', line: 3 });
    await aiFinding(branchId, { severity: 'medium', line: 4 });
    await aiFinding(branchId, { severity: 'low', line: 5 });
    await aiFinding(branchId, { severity: 'info', line: 6 });
    // Not counted: dismissed or closed ones, another branch's, and an analyzer's issue.
    for (const status of ['resolved', 'closed', 'false_positive', 'wont_fix'] as const) {
      await aiFinding(branchId, { severity: 'high', status });
    }
    await aiFinding(other.branchId, { severity: 'high' });
    await seedIssue(t.db, {
      projectId,
      branchId,
      ruleId: eslint,
      path: 'src/a.ts',
      startLine: 9,
      severity: 'high',
    });
    const loaded = await done(analysisId);
    expect(loaded.counts).toEqual({ high: 2, medium: 2, low: 2 });
  });

  it('lists the open findings that sit on no changed line, most severe first, with a link', async () => {
    const { branchId, analysisId } = await setup({});
    const placed = await aiFinding(branchId, { severity: 'high', anchorLine: 7, path: 'src/p.ts' });
    const low = await aiFinding(branchId, {
      severity: 'low',
      anchorLine: null,
      path: 'src/z.ts',
      line: 4,
    });
    const high = await aiFinding(branchId, {
      severity: 'blocker',
      anchorLine: null,
      path: 'src/y.ts',
      line: 9,
    });
    const medium = await aiFinding(branchId, {
      severity: 'medium',
      anchorLine: null,
      path: 'src/a.ts',
      line: 2,
    });
    // An issue with no finding row has no anchor either.
    const bare = await aiFinding(branchId, {
      severity: 'medium',
      withRow: false,
      path: 'src/b.ts',
      line: 3,
    });
    const loaded = await done(analysisId);
    const url = (id: string) => `${PUBLIC_URL}/projects/${projectId}/issues/${id}`;
    expect(loaded.unplaced.map((u) => [u.severity, u.path, u.line, u.url])).toEqual([
      ['high', 'src/y.ts', 9, url(high)],
      ['medium', 'src/a.ts', 2, url(medium)],
      ['medium', 'src/b.ts', 3, url(bare)],
      ['low', 'src/z.ts', 4, url(low)],
    ]);
    expect(loaded.unplaced.every((u) => u.title.startsWith('AI finding '))).toBe(true);
    expect(loaded.unplaced.map((u) => u.url)).not.toContain(url(placed));
    expect(loaded.moreUnplaced).toBe(0);
    // Without QUALOR_PUBLIC_URL there is no link.
    const noLink = await state(analysisId, null);
    expect(noLink?.kind === 'done' && noLink.unplaced.every((u) => u.url === null)).toBe(true);
  });

  it('lists ten of them at most and counts the rest', async () => {
    const { branchId, analysisId } = await setup({});
    for (let line = 1; line <= 13; line += 1) {
      await aiFinding(branchId, { anchorLine: null, line, path: 'src/many.ts' });
    }
    const loaded = await done(analysisId);
    expect(loaded.unplaced.map((u) => u.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(loaded.moreUnplaced).toBe(3);
    expect(loaded.counts.medium).toBe(13);
  });

  it('gives the prompt the open findings with their text, most severe first', async () => {
    const { branchId, analysisId } = await setup({});
    await aiFinding(branchId, { severity: 'low', path: 'src/c.ts', line: 3, body: 'Third body' });
    await aiFinding(branchId, {
      severity: 'high',
      path: 'src/a.ts',
      line: 1,
      body: 'First body',
      anchorLine: null,
    });
    await aiFinding(branchId, {
      severity: 'medium',
      path: 'src/b.ts',
      line: 2,
      body: 'Second body',
    });
    await aiFinding(branchId, { status: 'closed', body: 'Closed body' });
    const loaded = await done(analysisId);
    expect(loaded.fixPrompt.map((f) => [f.path, f.line, f.body])).toEqual([
      ['src/a.ts', 1, 'First body'],
      ['src/b.ts', 2, 'Second body'],
      ['src/c.ts', 3, 'Third body'],
    ]);
    expect(loaded.fixPrompt.every((f) => f.title.startsWith('AI finding '))).toBe(true);
  });

  it('gives an analysis that is no longer the newest its verdict and none of the branch’s findings', async () => {
    const { branchId, analysisId } = await setup({ tokenLimitReached: true });
    await aiFinding(branchId, { severity: 'high', anchorLine: null, line: 4, path: 'src/old.ts' });
    await aiFinding(branchId, { severity: 'medium', line: 5, body: 'A body' });
    const whileNewest = await done(analysisId);
    expect(whileNewest.counts).toEqual({ high: 1, medium: 1, low: 0 });
    expect(whileNewest.latest).toBeUndefined();

    // A newer analysis of the branch: the findings are the branch's now, not this run's.
    const newer = await newerAnalysis(branchId);
    const older = await done(analysisId);
    expect(older).toEqual({
      kind: 'done',
      latest: false,
      verdict: 'Adds refunds; one retry path can charge twice.',
      walkthrough: ['Adds a refund endpoint', 'Validates the amount'],
      counts: { high: 0, medium: 0, low: 0 },
      unplaced: [],
      moreUnplaced: 0,
      reviewedSha: HEAD,
      mergeRequestHeadSha: null,
      tokenLimitReached: true,
      snapshotPartial: false,
      notes: ['reviewer_unreadable'],
      fixPrompt: [],
    });

    // The newer analysis' own run is the branch's newest, and shows what the branch has.
    await t.db.insert(reviewRuns).values({
      projectId,
      branchId,
      analysisId: newer,
      status: 'done',
      deadlineAt: new Date(),
      headSha: 'b'.repeat(40),
      summary: STORED_SUMMARY,
    });
    const current = await done(newer);
    expect(current.latest).toBeUndefined();
    expect(current.counts).toEqual({ high: 1, medium: 1, low: 0 });
    expect(current.unplaced.map((u) => u.path)).toEqual(['src/old.ts']);
    expect(current.fixPrompt).toHaveLength(2);

    // A run that has not finished says what it says, whichever analysis it is of.
    const waiting = await setup({ status: 'waiting', headSha: null, summary: null });
    await newerAnalysis(waiting.branchId);
    expect(await state(waiting.analysisId)).toEqual({ kind: 'pending' });
  });

  it('lists twenty findings in the prompt at most', async () => {
    const { branchId, analysisId } = await setup({});
    for (let line = 1; line <= 25; line += 1) {
      await aiFinding(branchId, { line, path: 'src/lots.ts' });
    }
    const loaded = await done(analysisId);
    expect(loaded.fixPrompt).toHaveLength(20);
    expect(loaded.counts.medium).toBe(25);
  });
});
