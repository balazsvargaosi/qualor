import { contextHash, filelessHash, lineHash, REDACTED } from '@qualor/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { memorySnapshot } from '../../test/review';
import { pgConstraint } from '../db/errors';
import { first } from '../db/rows';
import {
  analyses,
  branches,
  issueChanges,
  issues,
  organizations,
  projects,
  reviewFindings,
  reviewRuns,
  reviewSnapshots,
  rules,
  type AiCategory,
  type ReviewRunRow,
} from '../db/schema';
import type { ReviewableChange, ReviewContext } from './context';
import { fingerprintOf } from './findings';
import { reviewSummary } from './findings-render';
import { priorAiFindings } from './findings-query';
import { lineCountOf, MaskedFiles, MaskedText } from './masked-files';
import { Masker } from './masker';
import type { JudgedFinding, PipelineOutcome } from './pipeline';
import { ensureAiRules } from './rules';
import type { SnapshotReader } from './snapshot-reader';
import {
  prepareReviewOutcome,
  ReviewNotStoringError,
  startStoring,
  storeReviewOutcome,
  type ReviewPrepareDeps,
} from './store';

const HEAD = 'a1'.repeat(20);
/** The head an earlier review placed its findings at. */
const OLD_HEAD = 'b2'.repeat(20);
const j = (...parts: string[]) => parts.join('');
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The reader, and the paths its `file()` was asked for. */
function counting(inner: SnapshotReader): { reader: SnapshotReader; read: string[] } {
  const read: string[] = [];
  return {
    reader: {
      ...inner,
      file: (path) => {
        read.push(path);
        return inner.file(path);
      },
    },
    read,
  };
}

type Reviewed = Extract<PipelineOutcome, { kind: 'reviewed' }>;

/** `line N;` for the 60 lines of a file, with `over` in place of some of them. */
const fileLines = (over: Record<number, string> = {}): string[] =>
  range(1, 60).map((n) => over[n] ?? `line ${n};`);
const textOf = (lines: readonly string[]): string => `${lines.join('\n')}\n`;
const maskedOf = (lines: readonly string[]): MaskedText => {
  const text = textOf(lines);
  return MaskedText.of(text, lineCountOf(text));
};

function change(path: string, over: Partial<ReviewableChange> = {}): ReviewableChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    since: null,
    hasPatch: true,
    patchUsable: true,
    lines: 60,
    text: maskedOf(fileLines()),
    added: new Set(range(10, 30)),
    removalPoints: [],
    changedLines: 21,
    sensitive: false,
    removed: [],
    unshown: null,
    ...over,
  };
}

function judged(over: Partial<JudgedFinding> = {}): JudgedFinding {
  return {
    category: 'logic',
    severity: 'major',
    confidence: 'high',
    path: 'src/cart.ts',
    line: 15,
    endLine: 15,
    title: 'Total skips the last item',
    body: 'The loop stops one item early, so the last item is never added.',
    assumption: null,
    suggestion: null,
    sources: [],
    priorId: null,
    verification: null,
    ...over,
  };
}

const outcomeOf = (over: Partial<Reviewed> = {}): Reviewed => ({
  kind: 'reviewed',
  tier: 'lite',
  specialists: ['quality', 'tests'],
  findings: [],
  prior: [],
  shownPriorIds: [],
  namedPriorIds: [],
  summary: { verdict: 'Two problems.', walkthrough: ['The cart total.'] },
  tokenLimitReached: false,
  notes: [],
  ...over,
});

describe('storeReviewOutcome (6I-3)', () => {
  let t: TestDatabase;
  let projectId: string;
  let ruleIds: ReadonlyMap<AiCategory, string>;
  let masker: Masker;
  let counter = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'store', name: 'Store' }).returning(),
    ).id;
    projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'store/api', name: 'api' })
        .returning(),
    ).id;
    // Before any transaction opens, as the review job does.
    ruleIds = await ensureAiRules(t.db);
    masker = new Masker();
  });
  afterAll(async () => {
    await masker.close();
    await t.close();
  });

  /**
   * A merge request branch, its analysis and a run that is storing its results, with the snapshot
   * it read (a row of it: the store reads no file of it).
   */
  async function newRun(over: Partial<typeof reviewRuns.$inferInsert> = {}) {
    counter += 1;
    const branchId = first(
      await t.db
        .insert(branches)
        .values({ projectId, kind: 'merge_request', name: `mr-${counter}` })
        .returning(),
    ).id;
    const analysisId = first(
      await t.db.insert(analyses).values({ projectId, branchId }).returning(),
    ).id;
    const snapshotId = first(
      await t.db
        .insert(reviewSnapshots)
        .values({
          analysisId,
          projectId,
          branchId,
          status: 'ready',
          compressedBytes: 0,
          headSha: HEAD,
        })
        .returning(),
    ).id;
    const run = first(
      await t.db
        .insert(reviewRuns)
        .values({
          projectId,
          branchId,
          analysisId,
          snapshotId,
          status: 'running',
          phase: 'storing',
          headSha: HEAD,
          startedAt: new Date(),
          deadlineAt: new Date(),
          ...over,
        })
        .returning(),
    );
    return { branchId, analysisId, snapshotId, run };
  }

  /** An issue of the AI review and its finding row, as an earlier review left them. */
  async function seedPrior(
    branchId: string,
    over: {
      category?: AiCategory;
      path?: string;
      line?: number;
      endLine?: number;
      title?: string;
      status?: 'open' | 'false_positive' | 'wont_fix' | 'resolved' | 'closed';
      severity?: 'high' | 'medium' | 'low';
      severityOverridden?: boolean;
    } = {},
  ) {
    const category = over.category ?? 'logic';
    const path = over.path ?? 'src/cart.ts';
    const title = over.title ?? 'Total skips the last item';
    const line = over.line ?? 15;
    const issue = first(
      await t.db
        .insert(issues)
        .values({
          projectId,
          branchId,
          ruleId: ruleIds.get(category) ?? '',
          fingerprint: fingerprintOf(category, path, title),
          lineHash: 'old-line-hash',
          contextHash: 'old-context-hash',
          path,
          startLine: line,
          endLine: over.endLine ?? line,
          message: title,
          severity: over.severity ?? 'medium',
          severityOverridden: over.severityOverridden ?? false,
          quality: 'reliability',
          kind: 'issue',
          status: over.status ?? 'open',
          inNewCode: true,
          confidence: 'medium',
          snippet: { startLine: line, lines: ['old snippet'] },
          firstSeenAt: sql`now()`,
        })
        .returning(),
    );
    await t.db.insert(reviewFindings).values({
      issueId: issue.id,
      category,
      body: 'The earlier body.',
      assumption: 'An earlier assumption.',
      verification: 'confirmed',
      suggestion: { startLine: line, endLine: line, lines: ['old;'] },
      anchorLine: line,
      reviewedHeadSha: OLD_HEAD,
    });
    return issue.id;
  }

  const contextOf = async (
    branchId: string,
    reviewed: ReviewableChange[],
  ): Promise<ReviewContext> => ({
    meta: {
      snapshotId: null,
      headSha: HEAD,
      baseSha: 'c3'.repeat(20),
      sinceSha: null,
      targetBranch: 'main',
      mrTitle: null,
      mrDescription: null,
      instructions: [],
      partial: false,
    },
    reviewed,
    skipped: [],
    slices: '',
    omittedFromSlices: [],
    analyzer: [],
    prior: await priorAiFindings(t.db, branchId),
    redactions: 0,
  });

  const depsOf = (files: Record<string, string> = {}, over: Partial<ReviewPrepareDeps> = {}) =>
    ({
      files: new MaskedFiles(memorySnapshot({ files }), { masker }),
      masker,
      budget: { maskedBytes: 10_000_000 },
      ...over,
    }) satisfies ReviewPrepareDeps;

  /** What the review job does: prepare the outcome outside any transaction, then store it in one. */
  const store = async (
    run: ReviewRunRow,
    context: ReviewContext,
    outcome: Reviewed,
    deps: ReviewPrepareDeps = depsOf(),
  ) => {
    const prepared = await prepareReviewOutcome(context, outcome, deps);
    return t.db.transaction((tx) => storeReviewOutcome(tx, run, prepared, ruleIds));
  };

  /** The constraint a failed action was refused by, or undefined when it did not fail on one. */
  const refusedBy = (action: PromiseLike<unknown>) =>
    Promise.resolve(action).then(
      () => undefined,
      (err: unknown) => pgConstraint(err),
    );
  const issueRow = async (id: string) =>
    first(await t.db.select().from(issues).where(eq(issues.id, id)));
  const findingRow = async (id: string) =>
    first(await t.db.select().from(reviewFindings).where(eq(reviewFindings.issueId, id)));
  const changesOf = (id: string) =>
    t.db
      .select()
      .from(issueChanges)
      .where(eq(issueChanges.issueId, id))
      .orderBy(asc(issueChanges.id));
  const runRow = async (id: string) =>
    first(await t.db.select().from(reviewRuns).where(eq(reviewRuns.id, id)));
  const aiIssues = async (branchId: string) =>
    t.db
      .select({ issue: issues, ruleKey: rules.key })
      .from(issues)
      .innerJoin(rules, eq(rules.id, issues.ruleId))
      .where(and(eq(issues.branchId, branchId), eq(rules.engineId, 'ai')))
      .orderBy(asc(issues.id));
  /** Every row the store writes, for a comparison before and after. */
  const everything = async (branchId: string) => ({
    issues: await t.db
      .select()
      .from(issues)
      .where(eq(issues.branchId, branchId))
      .orderBy(asc(issues.id)),
    findings: await t.db
      .select({ f: reviewFindings })
      .from(reviewFindings)
      .innerJoin(issues, eq(issues.id, reviewFindings.issueId))
      .where(eq(issues.branchId, branchId))
      .orderBy(asc(reviewFindings.issueId)),
    changes: await t.db
      .select({ c: issueChanges })
      .from(issueChanges)
      .innerJoin(issues, eq(issues.id, issueChanges.issueId))
      .where(eq(issues.branchId, branchId))
      .orderBy(asc(issueChanges.id)),
  });

  it('storeReviewOutcome writes issues, finding rows and changelog in one transaction', async () => {
    const { branchId, analysisId, run } = await newRun();
    const secret = `const key = "${REDACTED}";`;
    const lines = fileLines({ 13: secret });
    const reviewed = [change('src/cart.ts', { text: maskedOf(lines) })];

    const reEmitted = await seedPrior(branchId, {
      line: 25,
      title: 'Old words for the problem',
      severity: 'high',
    });
    const fixed = await seedPrior(branchId, { line: 42, title: 'A problem that was fixed' });
    const left = await seedPrior(branchId, { line: 50, title: 'A problem on unchanged lines' });
    const dismissed = await seedPrior(branchId, {
      line: 20,
      title: 'A problem a person dismissed',
      status: 'wont_fix',
    });
    const leftBefore = await issueRow(left);
    const dismissedBefore = await issueRow(dismissed);
    const context = await contextOf(branchId, reviewed);

    const suggestion = { startLine: 15, endLine: 16, lines: ['const total = items.length;'] };
    const keyFinding = judged({
      category: 'security',
      severity: 'critical',
      confidence: 'high',
      verification: 'confirmed',
      title: 'A key is written into the code',
      body: 'The key is a constant.',
      assumption: 'Assumes the key is real.',
      line: 15,
      endLine: 16,
      suggestion,
    });
    const testsFinding = judged({
      category: 'tests',
      severity: 'minor',
      confidence: 'medium',
      title: 'No test covers the empty cart',
      line: 28,
      endLine: 28,
    });
    const outOfScope = judged({ title: 'A problem far from the change', line: 55, endLine: 55 });
    const doubtful = judged({
      title: 'A doubtful problem',
      confidence: 'low',
      line: 12,
      endLine: 12,
    });
    const dismissedAgain = judged({ title: 'a problem a PERSON dismissed', line: 22, endLine: 22 });
    const again = judged({
      title: 'New words for the problem',
      severity: 'minor',
      confidence: 'high',
      priorId: reEmitted,
      line: 26,
      endLine: 26,
      body: 'The newer body.',
    });
    const outcome = outcomeOf({
      findings: [keyFinding, testsFinding, outOfScope, doubtful, dismissedAgain, again],
      prior: [{ id: fixed, status: 'fixed', reason: 'The loop was rewritten.' }],
      shownPriorIds: [reEmitted, fixed, left, dismissed],
      notes: ['token_limit_reached'],
      tokenLimitReached: true,
    });

    const counts = await store(run, context, outcome);
    expect(counts).toEqual({ created: 2, updated: 1, closed: 1, dropped: 3 });

    // The two new findings are issues of their category's rule, open, in new code.
    const stored = await aiIssues(branchId);
    const news = stored.filter((r) => ![reEmitted, fixed, left, dismissed].includes(r.issue.id));
    expect(news).toHaveLength(2);
    const security = first(news.filter((r) => r.ruleKey === 'ai:security'));
    const tests = first(news.filter((r) => r.ruleKey === 'ai:tests'));
    expect(security.issue).toMatchObject({
      projectId,
      branchId,
      ruleId: ruleIds.get('security'),
      fingerprint: fingerprintOf('security', 'src/cart.ts', 'A key is written into the code'),
      path: 'src/cart.ts',
      startLine: 15,
      startColumn: null,
      endLine: 16,
      endColumn: null,
      message: 'A key is written into the code',
      severity: 'high',
      severityOverridden: false,
      quality: 'security',
      kind: 'issue',
      status: 'open',
      inNewCode: true,
      confidence: 'high',
      firstSeenAnalysisId: analysisId,
      lastSeenAnalysisId: analysisId,
      closedAt: null,
      resolvedAt: null,
      duplicateOfIssueId: null,
      secondaryLocations: [],
    });
    expect(tests.issue).toMatchObject({
      ruleId: ruleIds.get('tests'),
      severity: 'low',
      quality: 'maintainability',
      confidence: 'medium',
      startLine: 28,
      endLine: 28,
    });
    // The snippet and the hashes are of the masked file: the secret never reached them.
    expect(security.issue.snippet).toEqual({ startLine: 12, lines: lines.slice(11, 19) });
    expect(JSON.stringify(security.issue.snippet)).toContain(REDACTED);
    expect(security.issue.lineHash).toBe(lineHash(lines, 15, 16));
    expect(security.issue.contextHash).toBe(contextHash(lines, 15, 16));

    // Their finding rows hold the text, the suggestion, the anchor and where they come from.
    expect(await findingRow(security.issue.id)).toMatchObject({
      runId: run.id,
      category: 'security',
      body: 'The key is a constant.',
      assumption: 'Assumes the key is real.',
      verification: 'confirmed',
      suggestion,
      anchorLine: 15,
      reviewedHeadSha: HEAD,
    });
    expect(await findingRow(tests.issue.id)).toMatchObject({
      category: 'tests',
      verification: null,
      suggestion: null,
      assumption: null,
      anchorLine: 28,
    });

    // The changelog says who raised each.
    for (const row of [security, tests]) {
      const [entry, ...rest] = await changesOf(row.issue.id);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        userId: null,
        analysisId,
        field: 'comment',
        oldValue: null,
        newValue: null,
      });
      expect(entry?.comment).toBe(`Raised by the AI review of commit ${HEAD.slice(0, 12)}.`);
    }

    // The re-emitted prior finding is the same issue, with the new text; it stays open.
    expect(await issueRow(reEmitted)).toMatchObject({
      status: 'open',
      message: 'New words for the problem',
      startLine: 26,
      endLine: 26,
      severity: 'low',
      confidence: 'high',
      lastSeenAnalysisId: analysisId,
      closedAt: null,
      fingerprint: fingerprintOf('logic', 'src/cart.ts', 'New words for the problem'),
      snippet: { startLine: 23, lines: lines.slice(22, 29) },
      lineHash: lineHash(lines, 26, 26),
      contextHash: contextHash(lines, 26, 26),
    });
    // The anchor, the suggestion and the head are written together: the old ones went with the old head.
    expect(await findingRow(reEmitted)).toMatchObject({
      runId: run.id,
      body: 'The newer body.',
      assumption: null,
      verification: null,
      suggestion: null,
      anchorLine: 26,
      reviewedHeadSha: HEAD,
    });
    expect(await changesOf(reEmitted)).toEqual([]);

    // The fixed prior is closed, and the changelog names the review and the commit.
    const closed = await issueRow(fixed);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBeInstanceOf(Date);
    const [entry, ...others] = await changesOf(fixed);
    expect(others).toEqual([]);
    expect(entry).toMatchObject({
      userId: null,
      analysisId,
      field: 'status',
      oldValue: 'open',
      newValue: 'closed',
    });
    expect(entry?.comment).toMatch(/AI review/);
    expect(entry?.comment).toContain(HEAD.slice(0, 12));
    expect(await findingRow(fixed)).toMatchObject({ runId: run.id, reviewedHeadSha: OLD_HEAD });

    // What the review left alone, and what a person dismissed, are exactly as they were.
    expect(await issueRow(left)).toEqual(leftBefore);
    expect(await issueRow(dismissed)).toEqual(dismissedBefore);
    expect(await changesOf(left)).toEqual([]);
    expect(await changesOf(dismissed)).toEqual([]);

    // The run is done, with its counts and its summary, and no phase.
    const done = await runRow(run.id);
    expect(done).toMatchObject({
      status: 'done',
      phase: null,
      reason: null,
      tier: 'lite',
      reviewers: ['quality', 'tests'],
      tokenLimitReached: true,
      findingsNew: 2,
      // The two new ones, the re-emitted one and the one left alone.
      findingsOpen: 4,
      findingsFixed: 1,
      summary: {
        verdict: 'Two problems.',
        walkthrough: ['The cart total.'],
        notes: ['token_limit_reached'],
      },
    });
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.summary).toEqual(reviewSummary(outcome));
  });

  it('a failure mid-store leaves nothing', async () => {
    const { branchId, run } = await newRun();
    const reviewed = [change('src/cart.ts')];
    const updated = await seedPrior(branchId, { line: 40, title: 'Old words' });
    const fixed = await seedPrior(branchId, { line: 42, title: 'Fixed words' });
    const context = await contextOf(branchId, reviewed);
    const outcome = outcomeOf({
      findings: [
        judged({ title: 'A new problem', line: 12 }),
        judged({ title: 'New words', priorId: updated, line: 41 }),
        judged({ title: 'Another new problem', line: 20, category: 'docs' }),
      ],
      prior: [{ id: fixed, status: 'fixed', reason: 'Gone.' }],
      shownPriorIds: [updated, fixed],
    });
    const before = await everything(branchId);
    const runBefore = await runRow(run.id);

    // The first new issue is inserted before the finding row that the database refuses.
    expect(await refusedBy(store({ ...run, headSha: 'NOT-A-SHA' }, context, outcome))).toBe(
      'review_findings_reviewed_head_sha_format',
    );
    expect(await everything(branchId)).toEqual(before);
    expect(await runRow(run.id)).toEqual(runBefore);

    // Everything is written, and then the last statement, the run's own, is refused.
    expect(await refusedBy(store(run, context, { ...outcome, tier: 'huge' as never }))).toBe(
      'review_runs_tier_check',
    );
    expect(await everything(branchId)).toEqual(before);
    expect(await runRow(run.id)).toEqual(runBefore);
    expect(runBefore).toMatchObject({ status: 'running', phase: 'storing' });

    // And the same review, whole, stores.
    const counts = await store(run, context, outcome);
    expect(counts).toEqual({ created: 2, updated: 1, closed: 1, dropped: 0 });
  });

  it('writes in the transaction it is given and commits none of it: rolled back after the store, nothing remains', async () => {
    const { branchId, run } = await newRun();
    const fixed = await seedPrior(branchId, { line: 14, title: 'Fixed words' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const before = await everything(branchId);
    const runBefore = await runRow(run.id);
    const prepared = await prepareReviewOutcome(
      context,
      outcomeOf({
        findings: [judged({ title: 'A new problem', line: 12 })],
        prior: [{ id: fixed, status: 'fixed', reason: 'Gone.' }],
        shownPriorIds: [fixed],
      }),
      depsOf(),
    );

    await expect(
      t.db.transaction(async (tx) => {
        const counts = await storeReviewOutcome(tx, run, prepared, ruleIds);
        expect(counts).toMatchObject({ created: 1, closed: 1 });
        // Written, and seen by this transaction alone: the pool's other connections see none of it.
        expect(await aiIssues(branchId)).toHaveLength(1);
        expect((await runRow(run.id)).status).toBe('running');
        expect(
          (await tx.select().from(reviewRuns).where(eq(reviewRuns.id, run.id)))[0]?.status,
        ).toBe('done');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await everything(branchId)).toEqual(before);
    expect(await runRow(run.id)).toEqual(runBefore);
  });

  it('a run is stored once', async () => {
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const outcome = outcomeOf({ findings: [judged({ title: 'A new problem', line: 12 })] });

    expect(await store(run, context, outcome)).toMatchObject({ created: 1 });
    const after = await everything(branchId);
    expect(after.issues).toHaveLength(1);
    const done = await runRow(run.id);

    // The same run again, though the row the caller holds still says it is storing.
    await expect(store(run, context, outcome)).rejects.toBeInstanceOf(ReviewNotStoringError);
    await expect(store(run, context, outcome)).rejects.toThrow(
      `review run ${run.id} is not storing`,
    );
    expect(await everything(branchId)).toEqual(after);
    expect(await runRow(run.id)).toEqual(done);
  });

  it('prepares an outcome as plain data before any transaction opens, and a failed transaction can be tried again with it', async () => {
    const { branchId, run } = await newRun();
    const fixed = await seedPrior(branchId, { line: 14, title: 'Fixed words' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const prepared = await prepareReviewOutcome(
      context,
      outcomeOf({
        findings: [judged({ title: 'A new problem', line: 12 })],
        prior: [{ id: fixed, status: 'fixed', reason: 'Gone.' }],
        shownPriorIds: [fixed],
      }),
      depsOf(),
    );
    // Nothing in it is a handle or a function: it can be copied, kept and stored later.
    expect(structuredClone(prepared)).toEqual(prepared);
    const before = await everything(branchId);

    // The first transaction fails, as one can, and leaves nothing; the same prepared outcome stores.
    expect(
      await refusedBy(
        t.db.transaction((tx) =>
          storeReviewOutcome(tx, { ...run, headSha: 'NOT-A-SHA' }, prepared, ruleIds),
        ),
      ),
    ).toBe('review_findings_reviewed_head_sha_format');
    expect(await everything(branchId)).toEqual(before);
    const counts = await t.db.transaction((tx) => storeReviewOutcome(tx, run, prepared, ruleIds));
    expect(counts).toEqual({ created: 1, updated: 0, closed: 1, dropped: 0 });
    expect(await aiIssues(branchId)).toHaveLength(2);
  });

  it('a fixed prior is closed with a changelog entry', async () => {
    const { branchId, analysisId, run } = await newRun();
    const fixed = await seedPrior(branchId, { line: 14, title: 'A problem that was fixed' });
    const other = await seedPrior(branchId, { line: 50, title: 'A problem on unchanged lines' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const otherBefore = await issueRow(other);

    const counts = await store(
      run,
      context,
      outcomeOf({
        prior: [{ id: fixed, status: 'fixed', reason: 'The loop was rewritten.' }],
        shownPriorIds: [fixed, other],
      }),
    );
    expect(counts).toEqual({ created: 0, updated: 0, closed: 1, dropped: 0 });

    const closed = await issueRow(fixed);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBeInstanceOf(Date);
    const entries = await changesOf(fixed);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: null,
      analysisId,
      field: 'status',
      oldValue: 'open',
      newValue: 'closed',
    });
    // The entry names the review and the commit, and none of the model's words.
    expect(entries[0]?.comment).toBe(
      `Closed by the AI review of commit ${HEAD.slice(0, 12)}: the problem is fixed.`,
    );
    // Its row says which review closed it; the head its anchor belongs to is not changed.
    expect(await findingRow(fixed)).toMatchObject({ runId: run.id, reviewedHeadSha: OLD_HEAD });
    expect(await issueRow(other)).toEqual(otherBefore);
    expect(await runRow(run.id)).toMatchObject({ findingsFixed: 1, findingsOpen: 1 });
  });

  it('stores a run once even when two stores of it start together', async () => {
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const outcome = outcomeOf({ findings: [judged({ title: 'A new problem', line: 12 })] });

    const results = await Promise.allSettled([
      store(run, context, outcome),
      store(run, context, outcome),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(ReviewNotStoringError);
    expect(await aiIssues(branchId)).toHaveLength(1);
    expect(await runRow(run.id)).toMatchObject({ status: 'done', findingsNew: 1 });
  });

  it('stores nothing for a run that is not storing: waiting, running a stage, or ended', async () => {
    for (const over of [
      { status: 'waiting', phase: null },
      { status: 'running', phase: 'judge' },
      { status: 'superseded', phase: null },
      { status: 'failed', phase: null, reason: 'internal' },
    ] as const) {
      const { branchId, run } = await newRun(over);
      const context = await contextOf(branchId, [change('src/cart.ts')]);
      await expect(
        store(run, context, outcomeOf({ findings: [judged({ line: 12 })] })),
        JSON.stringify(over),
      ).rejects.toBeInstanceOf(ReviewNotStoringError);
      expect(await aiIssues(branchId)).toEqual([]);
      expect(await runRow(run.id)).toMatchObject(over);
    }
  });

  it('stores nothing for a run whose snapshot was deleted since its last stop check', async () => {
    const { branchId, snapshotId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    // Its merge request was merged or closed, which deleted the copy the review read.
    await t.db.delete(reviewSnapshots).where(eq(reviewSnapshots.id, snapshotId));
    const before = await everything(branchId);
    await expect(
      store(run, context, outcomeOf({ findings: [judged({ line: 12 })] })),
    ).rejects.toBeInstanceOf(ReviewNotStoringError);
    expect(await everything(branchId)).toEqual(before);
    // The caller ends it: the store leaves it storing, without its snapshot.
    expect(await runRow(run.id)).toMatchObject({
      status: 'running',
      phase: 'storing',
      snapshotId: null,
    });
  });

  it('stores nothing for a run that was started again: its start is not the one its job made', async () => {
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    // The run ended and another job started it again while this job worked: the row holds that start.
    const again = new Date((run.startedAt?.getTime() ?? 0) + 60_000);
    await t.db.update(reviewRuns).set({ startedAt: again }).where(eq(reviewRuns.id, run.id));
    const before = await everything(branchId);
    await expect(
      store(run, context, outcomeOf({ findings: [judged({ line: 12 })] })),
    ).rejects.toBeInstanceOf(ReviewNotStoringError);
    expect(await everything(branchId)).toEqual(before);
    expect(await runRow(run.id)).toMatchObject({
      status: 'running',
      phase: 'storing',
      startedAt: again,
    });
  });

  it('stores a run whose start has microseconds, which the job read as milliseconds', async () => {
    const { branchId, run: made } = await newRun();
    await t.db.execute(
      sql`UPDATE review_runs SET started_at = '2026-10-25 12:00:00.123456+00' WHERE id = ${made.id}`,
    );
    // As the job holds it: read back from the row, where a Date keeps three of the six digits.
    const run = await runRow(made.id);
    expect(run.startedAt?.toISOString()).toBe('2026-10-25T12:00:00.123Z');
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    expect(
      await store(run, context, outcomeOf({ findings: [judged({ line: 12 })] })),
    ).toMatchObject({ created: 1 });
  });

  describe('startStoring', () => {
    it('turns a running run to storing, once', async () => {
      const { run } = await newRun({ phase: 'judge' });
      expect(await startStoring(t.db, run)).toMatchObject({
        id: run.id,
        status: 'running',
        phase: 'storing',
      });
      expect(await startStoring(t.db, run)).toBeUndefined();
      expect(await runRow(run.id)).toMatchObject({ status: 'running', phase: 'storing' });
    });

    it('leaves a run that was started again: its start is not the one its job made', async () => {
      const { run } = await newRun({ phase: 'judge' });
      const again = new Date((run.startedAt?.getTime() ?? 0) + 60_000);
      await t.db.update(reviewRuns).set({ startedAt: again }).where(eq(reviewRuns.id, run.id));
      expect(await startStoring(t.db, run)).toBeUndefined();
      expect(await runRow(run.id)).toMatchObject({
        status: 'running',
        phase: 'judge',
        startedAt: again,
      });
    });

    it('leaves a run that waits or ended', async () => {
      for (const over of [
        { status: 'waiting', phase: null, startedAt: null },
        { status: 'superseded', phase: null },
        { status: 'failed', phase: null, reason: 'internal' },
        { status: 'done', phase: null },
      ] as const) {
        const { run } = await newRun(over);
        expect(await startStoring(t.db, run), JSON.stringify(over)).toBeUndefined();
        expect(await runRow(run.id)).toMatchObject(over);
      }
    });

    it('turns a run whose start has microseconds, which the job read as milliseconds', async () => {
      const { run: made } = await newRun({ phase: 'judge' });
      await t.db.execute(
        sql`UPDATE review_runs SET started_at = '2026-10-25 12:00:00.123456+00' WHERE id = ${made.id}`,
      );
      const run = await runRow(made.id);
      expect(await startStoring(t.db, run)).toMatchObject({ phase: 'storing' });
    });
  });

  it('keeps what a person did while the review ran: a dismissed or resolved issue is not touched', async () => {
    const { branchId, run } = await newRun();
    const reviewed = [change('src/cart.ts')];
    const reEmitted = await seedPrior(branchId, { line: 12, title: 'Dismissed meanwhile' });
    const fixed = await seedPrior(branchId, { line: 14, title: 'Resolved meanwhile' });
    const left = await seedPrior(branchId, { line: 16, title: 'Resolved meanwhile too' });
    const present = await seedPrior(branchId, { line: 18, title: 'Present, dismissed meanwhile' });
    const context = await contextOf(branchId, reviewed);
    // Open when the review began; by the time it stores, people have had their say.
    await t.db.update(issues).set({ status: 'false_positive' }).where(eq(issues.id, reEmitted));
    await t.db.update(issues).set({ status: 'resolved' }).where(eq(issues.id, fixed));
    await t.db.update(issues).set({ status: 'wont_fix' }).where(eq(issues.id, left));
    await t.db.update(issues).set({ status: 'wont_fix' }).where(eq(issues.id, present));
    const before = await everything(branchId);

    const counts = await store(
      run,
      context,
      outcomeOf({
        findings: [judged({ title: 'Dismissed meanwhile', priorId: reEmitted, line: 12 })],
        prior: [
          { id: fixed, status: 'fixed', reason: 'Gone.' },
          { id: present, status: 'present', reason: 'It is.' },
        ],
        shownPriorIds: [reEmitted, fixed, left, present],
      }),
    );
    expect(counts).toEqual({ created: 0, updated: 0, closed: 0, dropped: 1 });
    expect(await everything(branchId)).toEqual(before);
    expect(await runRow(run.id)).toMatchObject({ status: 'done', findingsFixed: 0 });
  });

  it('moves an issue to the new path when the judge raises it again in a file the merge request renamed', async () => {
    const { branchId, run } = await newRun();
    const title = 'A problem in a renamed file';
    const renamed = await seedPrior(branchId, { path: 'src/old.ts', line: 14, title });
    const context = await contextOf(branchId, [
      change('src/new.ts', { oldPath: 'src/old.ts', status: 'renamed' }),
    ]);
    await store(
      run,
      context,
      outcomeOf({
        findings: [judged({ path: 'src/new.ts', title, priorId: renamed, line: 14 })],
        shownPriorIds: [renamed],
      }),
    );
    expect(await issueRow(renamed)).toMatchObject({
      status: 'open',
      path: 'src/new.ts',
      fingerprint: fingerprintOf('logic', 'src/new.ts', title),
    });
    expect(await findingRow(renamed)).toMatchObject({ anchorLine: 14, runId: run.id });
    expect(await aiIssues(branchId)).toHaveLength(1);
  });

  it('keeps the rule of an earlier finding when the judge raises it again under another category', async () => {
    const { branchId, run } = await newRun();
    const title = 'A problem the judge sorts again';
    const earlier = await seedPrior(branchId, { category: 'logic', line: 14, title });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    await store(
      run,
      context,
      outcomeOf({
        findings: [judged({ category: 'security', title, priorId: earlier, line: 14 })],
        shownPriorIds: [earlier],
      }),
    );
    const only = first(await aiIssues(branchId));
    expect(only.ruleKey).toBe('ai:logic');
    expect(only.issue).toMatchObject({
      id: earlier,
      ruleId: ruleIds.get('logic'),
      quality: 'reliability',
      fingerprint: fingerprintOf('logic', 'src/cart.ts', title),
    });
    expect(await findingRow(earlier)).toMatchObject({ category: 'logic', runId: run.id });
  });

  it('reads and masks a file once for all the findings in it, also when the review keeps no masked text', async () => {
    const source = { 'src/cart.ts': textOf(fileLines()) };
    const { reader, read } = counting(memorySnapshot({ files: source }));
    // Nothing is kept: every request for the file would read and mask it again.
    const files = new MaskedFiles(reader, { masker, maxBytes: 0 });
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts', { text: null })]);
    await store(
      run,
      context,
      outcomeOf({
        findings: [
          judged({ title: 'First problem', line: 12, endLine: 12 }),
          judged({ title: 'Second problem', line: 20, endLine: 20 }),
        ],
      }),
      depsOf({}, { files }),
    );
    expect(read).toEqual(['src/cart.ts']);
    const snippets = (await aiIssues(branchId)).map((r) => r.issue.snippet);
    expect(snippets).toHaveLength(2);
    for (const snippet of snippets) expect(snippet).not.toBeNull();
  });

  it('refuses an outcome whose summary cannot be kept before it reads a file', async () => {
    const source = { 'src/cart.ts': textOf(fileLines()) };
    const { reader, read } = counting(memorySnapshot({ files: source }));
    const files = new MaskedFiles(reader, { masker });
    const { branchId } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts', { text: null })]);
    // Only a hand-made outcome has a note that is none of the known ones.
    const outcome = outcomeOf({
      findings: [judged({ line: 12, endLine: 12 })],
      notes: ['not a note' as never],
    });
    await expect(
      prepareReviewOutcome(context, outcome, depsOf({}, { files })),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(read).toEqual([]);
  });

  it('stores a review whose masker fails: its findings have no snippet', async () => {
    const broken = new Masker();
    await broken.close();
    const files = new MaskedFiles(
      memorySnapshot({ files: { 'src/cart.ts': textOf(fileLines()) } }),
      {
        masker: broken,
      },
    );
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts', { text: null })]);
    const counts = await store(
      run,
      context,
      outcomeOf({ findings: [judged({ line: 15, endLine: 15 })] }),
      depsOf({}, { files, masker: broken }),
    );
    expect(counts).toMatchObject({ created: 1 });
    expect(first(await aiIssues(branchId)).issue.snippet).toBeNull();
    expect(await runRow(run.id)).toMatchObject({ status: 'done' });
  });

  it('keeps a severity a person set when it updates a finding, and updates the rest', async () => {
    const { branchId, run } = await newRun();
    const kept = await seedPrior(branchId, {
      line: 12,
      title: 'Overridden problem',
      severity: 'low',
      severityOverridden: true,
    });
    const free = await seedPrior(branchId, { line: 14, title: 'Free problem', severity: 'low' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    await store(
      run,
      context,
      outcomeOf({
        findings: [
          judged({ title: 'Overridden problem', priorId: kept, severity: 'critical', line: 12 }),
          judged({ title: 'Free problem', priorId: free, severity: 'critical', line: 14 }),
        ],
        shownPriorIds: [kept, free],
      }),
    );
    expect(await issueRow(kept)).toMatchObject({ severity: 'low', severityOverridden: true });
    expect(await issueRow(free)).toMatchObject({ severity: 'high', severityOverridden: false });
  });

  it('closes an omitted or unclear prior finding only when its file was deleted, with a changelog that says why', async () => {
    const { branchId, analysisId, run } = await newRun();
    const reviewed = [
      change('src/cart.ts'),
      change('src/gone.ts', { status: 'deleted', lines: null, added: new Set(), text: null }),
    ];
    // On the lines the change added, far from them, not clear, and in a file the merge request
    // deleted (one of those the judge was not shown, and one it was).
    const onChanged = await seedPrior(branchId, { line: 14, title: 'On changed lines' });
    const far = await seedPrior(branchId, { line: 50, title: 'On unchanged lines' });
    const unclear = await seedPrior(branchId, { line: 18, title: 'Not clear' });
    const unshown = await seedPrior(branchId, {
      path: 'src/gone.ts',
      line: 4,
      title: 'Not shown to the judge',
    });
    const inDeleted = await seedPrior(branchId, { path: 'src/gone.ts', line: 3, title: 'Deleted' });
    const context = await contextOf(branchId, reviewed);
    const untouched = [onChanged, far, unclear, unshown];
    const before = await Promise.all(untouched.map((id) => issueRow(id)));

    const counts = await store(
      run,
      context,
      outcomeOf({
        prior: [{ id: unclear, status: 'unclear', reason: 'Cannot tell.' }],
        shownPriorIds: [onChanged, far, inDeleted, unclear],
      }),
    );
    expect(counts).toEqual({ created: 0, updated: 0, closed: 1, dropped: 0 });
    // The lines of an earlier finding are of an older head than the lines this review changed, so
    // they close nothing.
    expect(await Promise.all(untouched.map((id) => issueRow(id)))).toEqual(before);
    for (const id of untouched) expect(await changesOf(id), id).toEqual([]);

    expect(await issueRow(inDeleted)).toMatchObject({ status: 'closed' });
    const entries = await changesOf(inDeleted);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      analysisId,
      field: 'status',
      oldValue: 'open',
      newValue: 'closed',
      comment: `Closed by the AI review of commit ${HEAD.slice(0, 12)}: the file was deleted.`,
    });
    expect(await findingRow(inDeleted)).toMatchObject({ runId: run.id, reviewedHeadSha: OLD_HEAD });
  });

  it('marks a prior finding the judge found still present but did not repeat as looked at, and nothing else', async () => {
    const { branchId, analysisId, run } = await newRun();
    const present = await seedPrior(branchId, { line: 14, title: 'Still here' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const before = await issueRow(present);
    const rowBefore = await findingRow(present);

    const counts = await store(
      run,
      context,
      outcomeOf({
        prior: [{ id: present, status: 'present', reason: 'It is.' }],
        shownPriorIds: [present],
      }),
    );
    expect(counts).toEqual({ created: 0, updated: 1, closed: 0, dropped: 0 });
    // Open, with its lines and words as they were, and seen by this analysis.
    expect(await issueRow(present)).toMatchObject({
      status: 'open',
      message: before.message,
      startLine: before.startLine,
      endLine: before.endLine,
      snippet: before.snippet,
      lineHash: before.lineHash,
      lastSeenAnalysisId: analysisId,
    });
    // Its anchor and its suggestion still belong to the head they were made for.
    const row = await findingRow(present);
    expect(row).toMatchObject({
      body: rowBefore.body,
      anchorLine: rowBefore.anchorLine,
      suggestion: rowBefore.suggestion,
      reviewedHeadSha: OLD_HEAD,
      runId: run.id,
    });
    expect(await changesOf(present)).toEqual([]);
  });

  it('keeps an earlier finding that a finding named but the review could not use, as it is', async () => {
    const { branchId, analysisId, run } = await newRun();
    const earlier = await seedPrior(branchId, { line: 14, title: 'Named by a stale line' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const before = await issueRow(earlier);
    const rowBefore = await findingRow(earlier);

    const counts = await store(
      run,
      context,
      outcomeOf({
        // The judge copied a line the push has taken away, and called the problem fixed as well.
        findings: [
          judged({ title: 'Named by a stale line', priorId: earlier, line: 500, endLine: 500 }),
        ],
        prior: [{ id: earlier, status: 'fixed', reason: 'Gone.' }],
        shownPriorIds: [earlier],
      }),
    );
    expect(counts).toEqual({ created: 0, updated: 1, closed: 0, dropped: 1 });
    expect(await issueRow(earlier)).toMatchObject({
      status: 'open',
      closedAt: null,
      message: before.message,
      startLine: before.startLine,
      snippet: before.snippet,
      lastSeenAnalysisId: analysisId,
    });
    expect(await findingRow(earlier)).toMatchObject({
      body: rowBefore.body,
      anchorLine: rowBefore.anchorLine,
      suggestion: rowBefore.suggestion,
      reviewedHeadSha: OLD_HEAD,
      runId: run.id,
    });
    expect(await changesOf(earlier)).toEqual([]);
    expect(await aiIssues(branchId)).toHaveLength(1);
  });

  it('keeps a prior finding the judge raises again where it cannot be placed, with the head of its last placement', async () => {
    const { branchId, analysisId, run } = await newRun();
    const earlier = await seedPrior(branchId, { line: 45, title: 'Old words for the problem' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const before = await issueRow(earlier);
    const rowBefore = await findingRow(earlier);

    // No line the change added is near line 46: its new words have no place on this head.
    const counts = await store(
      run,
      context,
      outcomeOf({
        findings: [
          judged({
            title: 'New words for the problem',
            body: 'A newer body.',
            priorId: earlier,
            line: 46,
            endLine: 46,
          }),
        ],
        shownPriorIds: [earlier],
      }),
    );
    expect(counts).toEqual({ created: 0, updated: 1, closed: 0, dropped: 0 });
    expect(await issueRow(earlier)).toMatchObject({
      status: 'open',
      message: before.message,
      startLine: before.startLine,
      fingerprint: before.fingerprint,
      snippet: before.snippet,
      lastSeenAnalysisId: analysisId,
    });
    expect(await findingRow(earlier)).toMatchObject({
      body: rowBefore.body,
      anchorLine: rowBefore.anchorLine,
      suggestion: rowBefore.suggestion,
      reviewedHeadSha: OLD_HEAD,
      runId: run.id,
    });
  });

  it('names an issue in another file only for a rename: otherwise the earlier finding stays and the finding is its own', async () => {
    const { branchId, run } = await newRun();
    const earlier = await seedPrior(branchId, {
      path: 'src/cart.ts',
      line: 14,
      title: 'In the cart',
    });
    const context = await contextOf(branchId, [change('src/cart.ts'), change('src/other.ts')]);
    const counts = await store(
      run,
      context,
      outcomeOf({
        findings: [
          judged({ path: 'src/other.ts', title: 'In the other file', priorId: earlier, line: 14 }),
        ],
        shownPriorIds: [earlier],
      }),
    );
    expect(counts).toEqual({ created: 1, updated: 1, closed: 0, dropped: 0 });
    expect(await issueRow(earlier)).toMatchObject({
      status: 'open',
      path: 'src/cart.ts',
      message: 'In the cart',
    });
    const stored = await aiIssues(branchId);
    expect(stored.map((r) => [r.issue.path, r.issue.message]).sort()).toEqual([
      ['src/cart.ts', 'In the cart'],
      ['src/other.ts', 'In the other file'],
    ]);
  });

  it('moves an issue to the new path when the judge still calls a renamed file by its old name', async () => {
    const { branchId, run } = await newRun();
    const title = 'A problem in a renamed file';
    const renamed = await seedPrior(branchId, { path: 'src/old.ts', line: 14, title });
    const context = await contextOf(branchId, [
      change('src/new.ts', { oldPath: 'src/old.ts', status: 'renamed' }),
    ]);
    await store(
      run,
      context,
      outcomeOf({
        findings: [judged({ path: 'src/old.ts', title, priorId: renamed, line: 14 })],
        shownPriorIds: [renamed],
      }),
    );
    expect(await issueRow(renamed)).toMatchObject({
      path: 'src/new.ts',
      fingerprint: fingerprintOf('logic', 'src/new.ts', title),
    });
    expect(await aiIssues(branchId)).toHaveLength(1);
  });

  it('raises no second issue for a finding of a renamed file that an issue already stands for', async () => {
    const title = 'A problem in a renamed file';
    // Where the issue sits (an earlier review may have moved it already), what the judge calls the
    // file, and whether it names the issue.
    const cases = [
      { label: 'old name, by id', issueAt: 'src/new.ts', calls: 'src/old.ts', byId: true },
      { label: 'old name, by words', issueAt: 'src/new.ts', calls: 'src/old.ts', byId: false },
      { label: 'new name, by words', issueAt: 'src/old.ts', calls: 'src/new.ts', byId: false },
    ];
    for (const { label, issueAt, calls, byId } of cases) {
      const { branchId, run } = await newRun();
      const id = await seedPrior(branchId, { path: issueAt, line: 14, title });
      const context = await contextOf(branchId, [
        change('src/new.ts', { oldPath: 'src/old.ts', status: 'renamed' }),
      ]);
      const counts = await store(
        run,
        context,
        outcomeOf({
          findings: [judged({ path: calls, title, line: 15, priorId: byId ? id : null })],
          shownPriorIds: [id],
        }),
      );
      expect(counts, label).toEqual({ created: 0, updated: 1, closed: 0, dropped: 0 });
      const stored = await aiIssues(branchId);
      expect(
        stored.map((row) => row.issue.id),
        label,
      ).toEqual([id]);
      expect(await issueRow(id), label).toMatchObject({
        path: 'src/new.ts',
        startLine: 15,
        status: 'open',
        fingerprint: fingerprintOf('logic', 'src/new.ts', title),
      });
      expect(await findingRow(id), label).toMatchObject({ anchorLine: 15, reviewedHeadSha: HEAD });
    }
  });

  it('keeps a prior finding that the review named in a finding it dropped itself, whatever the judge says of it', async () => {
    const { branchId, run } = await newRun();
    const id = await seedPrior(branchId, { line: 14 });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const counts = await store(
      run,
      context,
      outcomeOf({
        namedPriorIds: [id],
        prior: [{ id, status: 'fixed', reason: 'Gone.' }],
        shownPriorIds: [id],
      }),
    );
    expect(counts).toEqual({ created: 0, updated: 1, closed: 0, dropped: 0 });
    expect(await issueRow(id)).toMatchObject({ status: 'open', closedAt: null });
    expect(await changesOf(id)).toEqual([]);
    expect(await findingRow(id)).toMatchObject({ runId: run.id, reviewedHeadSha: OLD_HEAD });
  });

  it('keeps one prior finding for one finding when two claim it: the second becomes a new issue', async () => {
    const { branchId, run } = await newRun();
    const prior = await seedPrior(branchId, { line: 14, title: 'Shared words' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const counts = await store(
      run,
      context,
      outcomeOf({
        findings: [
          judged({ title: 'First words', priorId: prior, line: 14 }),
          judged({ title: 'Second words', priorId: prior, line: 20 }),
        ],
        shownPriorIds: [prior],
      }),
    );
    expect(counts).toMatchObject({ created: 1, updated: 1 });
    const stored = await aiIssues(branchId);
    expect(stored).toHaveLength(2);
    expect((await issueRow(prior)).message).toBe('First words');
    expect(stored.map((r) => r.issue.message).sort()).toEqual(['First words', 'Second words']);
  });

  it('stores a finding that no added line is near, with no anchor: the summary lists it', async () => {
    const { branchId, run } = await newRun();
    // The lines changed since the last review are far from the lines the change adds.
    const reviewed = [change('src/cart.ts', { added: new Set([10, 11]), since: [[40, 42]] })];
    const context = await contextOf(branchId, reviewed);
    await store(run, context, outcomeOf({ findings: [judged({ line: 41, endLine: 41 })] }));
    const stored = first(await aiIssues(branchId));
    expect(await findingRow(stored.issue.id)).toMatchObject({ anchorLine: null });
  });

  it('drops a suggestion that fails a check and stores the finding, anchored at its nearest added line', async () => {
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    const withSuggestion = (title: string, startLine: number, endLine: number, lines: string[]) =>
      judged({ title, line: 12, endLine: 12, suggestion: { startLine, endLine, lines } });
    await store(
      run,
      context,
      outcomeOf({
        findings: [
          // Over a context line, over 16 lines, a fence, and unchanged: each stored without it.
          withSuggestion('Context line', 8, 12, ['x;']),
          withSuggestion('Sixteen lines', 10, 25, ['x;']),
          withSuggestion('A fence', 12, 12, ['```']),
          withSuggestion('Unchanged', 12, 12, ['line 12;']),
          withSuggestion('Applies', 12, 12, ['line twelve;']),
        ],
      }),
    );
    const rows = await Promise.all(
      (await aiIssues(branchId)).map(async (r) => ({
        title: r.issue.message,
        finding: await findingRow(r.issue.id),
      })),
    );
    expect(rows).toHaveLength(5);
    for (const { title, finding } of rows) {
      expect(finding.anchorLine, title).toBe(12);
      expect(finding.suggestion, title).toEqual(
        title === 'Applies' ? { startLine: 12, endLine: 12, lines: ['line twelve;'] } : null,
      );
    }
  });

  it('cuts model text to its columns and replaces the NUL a text column cannot hold', async () => {
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    await store(
      run,
      context,
      outcomeOf({
        findings: [
          judged({
            title: `A\u0000title ${'t'.repeat(300)}`,
            body: `Body\u0000${'b'.repeat(2500)}`,
            assumption: `Assumes\u0000${'a'.repeat(400)}`,
          }),
        ],
      }),
    );
    const issue = first(await aiIssues(branchId)).issue;
    expect(issue.message.startsWith('A\uFFFDtitle t')).toBe(true);
    expect([...issue.message]).toHaveLength(120);
    const row = await findingRow(issue.id);
    expect(row.body.startsWith('Body\uFFFDb')).toBe(true);
    expect([...row.body]).toHaveLength(2000);
    expect(row.assumption?.startsWith('Assumes\uFFFDa')).toBe(true);
    expect([...(row.assumption ?? '')]).toHaveLength(300);
  });

  it("makes the snippet and hashes of a file that was not kept by masking it with the review's masker", async () => {
    const { branchId, run } = await newRun();
    const password = j('const password = "', 'hunter2', '-very-secret";');
    const lines = fileLines({ 15: password });
    // The context holds no masked text of the file: it was not sliced.
    const reviewed = [change('src/cart.ts', { text: null })];
    const context = await contextOf(branchId, reviewed);
    const files = { 'src/cart.ts': textOf(lines) };
    const budget = { maskedBytes: 10_000_000 };
    await store(
      run,
      context,
      outcomeOf({ findings: [judged({ line: 15, endLine: 15 })] }),
      depsOf(files, { budget }),
    );
    const issue = first(await aiIssues(branchId)).issue;
    const masked = lines.map((l) => (l === password ? `const password = "${REDACTED}";` : l));
    expect(issue.snippet).toEqual({ startLine: 12, lines: masked.slice(11, 18) });
    expect(issue.lineHash).toBe(lineHash(masked, 15, 15));
    expect(issue.contextHash).toBe(contextHash(masked, 15, 15));
    // The raw secret is nowhere in what was written, and the masking was charged.
    expect(JSON.stringify(await everything(branchId))).not.toContain('hunter2');
    expect(budget.maskedBytes).toBeLessThan(10_000_000);
  });

  it('leaves no snippet, and hashes the words, where the review has no time or bytes left to mask', async () => {
    const files = { 'src/cart.ts': textOf(fileLines()) };
    const spent = new Masker({ budgetMs: 0 });
    try {
      for (const spentTime of [true, false]) {
        const { reader, read } = counting(memorySnapshot({ files }));
        const over: Partial<ReviewPrepareDeps> = spentTime
          ? { masker: spent, files: new MaskedFiles(reader, { masker: spent }) }
          : { files: new MaskedFiles(reader, { masker }), budget: { maskedBytes: 5 } };
        const { branchId, run } = await newRun();
        const context = await contextOf(branchId, [change('src/cart.ts', { text: null })]);
        await store(
          run,
          context,
          outcomeOf({
            findings: [judged({ line: 15, endLine: 15, title: 'Total skips the last item' })],
          }),
          depsOf(files, over),
        );
        const issue = first(await aiIssues(branchId)).issue;
        expect(issue.snippet).toBeNull();
        // Hashed as a finding with no source is: the rule, the path and the words.
        const words = filelessHash('ai:logic', 'Total skips the last item', 'src/cart.ts');
        expect([issue.lineHash, issue.contextHash]).toEqual([words, words]);
        // With no time left the file is not even read.
        expect(read, String(spentTime)).toEqual(spentTime ? [] : ['src/cart.ts']);
      }
    } finally {
      await spent.close();
    }
  });

  it("takes the masked text the review's files keep, whatever time the masker has left", async () => {
    const password = j('const password = "', 'hunter2', '-very-secret";');
    const lines = fileLines({ 15: password });
    const { reader, read } = counting(memorySnapshot({ files: { 'src/cart.ts': textOf(lines) } }));
    const files = new MaskedFiles(reader, { masker });
    // Masked once, by the context's own reading of the file: kept.
    await files.file('src/cart.ts');
    read.length = 0;
    const spent = new Masker({ budgetMs: 0 });
    try {
      const { branchId, run } = await newRun();
      const context = await contextOf(branchId, [change('src/cart.ts', { text: null })]);
      await store(
        run,
        context,
        outcomeOf({ findings: [judged({ line: 15, endLine: 15 })] }),
        depsOf({}, { files, masker: spent }),
      );
      const issue = first(await aiIssues(branchId)).issue;
      expect(JSON.stringify(issue.snippet)).toContain(REDACTED);
      expect(JSON.stringify(issue.snippet)).not.toContain('hunter2');
      expect(read).toEqual([]);
    } finally {
      await spent.close();
    }
  });

  it('writes the summary as plain text for people, with the notes', async () => {
    const { branchId, run } = await newRun();
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    await store(
      run,
      context,
      outcomeOf({
        summary: {
          verdict: '  One\u0000 problem.\u202e ',
          walkthrough: ['The cart.\u200b', '  '],
        },
        notes: ['reviewer_unreadable', 'verification_capped'],
      }),
    );
    expect((await runRow(run.id)).summary).toEqual({
      verdict: 'One  problem.',
      walkthrough: ['The cart.'],
      notes: ['reviewer_unreadable', 'verification_capped'],
    });
  });

  it('touches only the issues of the AI review on its own branch', async () => {
    const { branchId, run } = await newRun();
    const other = await newRun();
    // An analyzer issue and an issue of another branch: a forged id must not reach them.
    const analyzerRule = first(
      await t.db
        .insert(rules)
        .values({
          key: 'eslint:no-eval',
          engineId: 'eslint',
          engineRuleId: 'no-eval',
          name: 'no-eval',
          defaultSeverity: 'high',
          quality: 'security',
          kind: 'issue',
          origin: 'reported',
        })
        .onConflictDoNothing()
        .returning(),
    ).id;
    const foreign = first(
      await t.db
        .insert(issues)
        .values({
          projectId,
          branchId,
          ruleId: analyzerRule,
          fingerprint: 'f'.repeat(32),
          lineHash: 'l',
          contextHash: 'c',
          path: 'src/cart.ts',
          startLine: 14,
          message: 'eval',
          severity: 'high',
          quality: 'security',
          kind: 'issue',
          firstSeenAt: sql`now()`,
        })
        .returning(),
    ).id;
    const elsewhere = await seedPrior(other.branchId, { line: 14, title: 'Other branch' });
    const context = await contextOf(branchId, [change('src/cart.ts')]);
    // A context that was tampered with, or a bug: priors that are not this branch's AI issues.
    const forged = {
      ...context,
      prior: [
        ...context.prior,
        ...[foreign, elsewhere].map((id) => ({
          id,
          category: 'logic' as const,
          severity: 'high',
          status: 'open' as const,
          path: 'src/cart.ts',
          line: 14,
          endLine: 14,
          title: 'Forged',
          body: '',
          fingerprint: fingerprintOf('logic', 'src/cart.ts', 'Forged'),
        })),
      ],
    };
    const foreignBefore = await issueRow(foreign);
    const elsewhereBefore = await issueRow(elsewhere);
    await store(
      run,
      forged,
      outcomeOf({
        findings: [judged({ title: 'Forged', priorId: foreign, line: 14 })],
        prior: [{ id: elsewhere, status: 'fixed', reason: 'Gone.' }],
        shownPriorIds: [foreign, elsewhere],
      }),
    );
    expect(await issueRow(foreign)).toEqual(foreignBefore);
    expect(await issueRow(elsewhere)).toEqual(elsewhereBefore);
    expect(
      await t.db
        .select()
        .from(issueChanges)
        .where(inArray(issueChanges.issueId, [foreign, elsewhere])),
    ).toEqual([]);
  });
});
