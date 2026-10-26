import { randomUUID } from 'node:crypto';
import { LLM_FEATURES } from '@qualor/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { seedIssue, seedRule } from '../../test/issues';
import {
  checkViolation,
  llmRequestRow,
  PG_NOT_NULL_VIOLATION,
  refusal,
  type Refusal,
} from '../../test/refusals';
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION } from '../db/errors';
import { first } from '../db/rows';
import {
  AI_CATEGORIES,
  analyses,
  type AiCategory,
  branches,
  issues,
  llmRequests,
  organizations,
  projects,
  REVIEW_FAILURE_REASONS,
  REVIEW_PHASES,
  REVIEW_RUN_STATUSES,
  REVIEW_SKIP_REASONS,
  REVIEW_TIERS,
  reviewFindings,
  type ReviewFailureReason,
  type ReviewFindingRow,
  reviewRuns,
  type ReviewRunRow,
  type ReviewRunStatus,
  reviewSnapshots,
  type ReviewSkipReason,
  type LlmRequestFeature,
} from '../db/schema';

const SHA1 = 'a'.repeat(40);
const SHA256 = '0123456789abcdef'.repeat(4);
const DEADLINE = new Date('2026-10-22T09:15:00Z');
/** PostgreSQL's string_data_right_truncation: a value too long for `char(64)`. */
const PG_STRING_TOO_LONG = '22001';

type RunInsert = typeof reviewRuns.$inferInsert;
type FindingInsert = typeof reviewFindings.$inferInsert;

/** The reason a run in `status` must carry (null where the status takes none). */
function reasonFor(status: ReviewRunStatus): ReviewSkipReason | ReviewFailureReason | null {
  if (status === 'skipped') return 'draft';
  if (status === 'failed') return 'internal';
  return null;
}

describe('review_runs and review_findings (6I-3, migration 0016_review_runs)', () => {
  let t: TestDatabase;
  let organizationId: string;
  let projectId: string;
  let mergeRequestId: string;
  let ruleId: string;

  const newProject = async (key: string) =>
    first(await t.db.insert(projects).values({ organizationId, key, name: key }).returning()).id;
  const newBranch = async (name: string) =>
    first(
      await t.db.insert(branches).values({ projectId, kind: 'merge_request', name }).returning(),
    ).id;
  const newAnalysis = async () =>
    first(await t.db.insert(analyses).values({ projectId }).returning()).id;
  const newIssue = () => seedIssue(t.db, { projectId, branchId: mergeRequestId, ruleId });
  const newSnapshot = async (analysisId: string) =>
    first(
      await t.db
        .insert(reviewSnapshots)
        .values({ analysisId, projectId, compressedBytes: 40, body: Buffer.from('gzip bytes') })
        .returning(),
    );

  /** Values of a waiting run of a fresh analysis on the merge request, unless `over` says otherwise. */
  const runValues = async (over: Partial<RunInsert> = {}): Promise<RunInsert> => ({
    projectId,
    branchId: mergeRequestId,
    analysisId: await newAnalysis(),
    deadlineAt: DEADLINE,
    ...over,
  });
  const run = async (over: Partial<RunInsert> = {}): Promise<ReviewRunRow> =>
    first(
      await t.db
        .insert(reviewRuns)
        .values(await runValues(over))
        .returning(),
    );
  /**
   * The refusal of a run of `analysisId`, or null when it was accepted. The run is removed again,
   * so one analysis serves every combination of a table.
   */
  const tryRun = async (analysisId: string, over: Partial<RunInsert>): Promise<Refusal | null> => {
    const outcome = await refusal(
      t.db
        .insert(reviewRuns)
        .values({ projectId, branchId: mergeRequestId, analysisId, deadlineAt: DEADLINE, ...over }),
    );
    await t.db.delete(reviewRuns).where(eq(reviewRuns.analysisId, analysisId));
    return outcome;
  };
  const survivors = async (ids: string[]) =>
    (await t.db.select({ id: reviewRuns.id }).from(reviewRuns).where(inArray(reviewRuns.id, ids)))
      .map((row) => row.id)
      .sort();

  const findingValues = async (over: Partial<FindingInsert> = {}): Promise<FindingInsert> => ({
    issueId: await newIssue(),
    category: 'logic',
    body: 'The loop never ends when the list is empty.',
    reviewedHeadSha: SHA1,
    ...over,
  });
  const finding = async (over: Partial<FindingInsert> = {}): Promise<ReviewFindingRow> =>
    first(
      await t.db
        .insert(reviewFindings)
        .values(await findingValues(over))
        .returning(),
    );
  const tryFinding = async (over: Partial<FindingInsert>): Promise<Refusal | null> => {
    const values = await findingValues(over);
    const outcome = await refusal(t.db.insert(reviewFindings).values(values));
    await t.db.delete(issues).where(eq(issues.id, values.issueId));
    return outcome;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    organizationId = first(
      await t.db.insert(organizations).values({ key: 'runs', name: 'Runs' }).returning(),
    ).id;
    projectId = await newProject('runs/api');
    mergeRequestId = await newBranch('7');
    ruleId = await seedRule(t.db, { key: 'ai:logic' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('lists the values the checks allow', () => {
    expect(REVIEW_RUN_STATUSES).toEqual([
      'waiting',
      'running',
      'done',
      'skipped',
      'failed',
      'superseded',
    ]);
    expect(REVIEW_SKIP_REASONS).toEqual([
      'no_snapshot',
      'snapshot_rejected',
      'draft',
      'closed',
      'inactive',
      'empty_diff',
      'unchanged',
      'budget_spent',
    ]);
    expect(REVIEW_FAILURE_REASONS).toEqual([
      'provider_error',
      'provider_no_tools',
      'bad_answer',
      'internal',
    ]);
    expect(REVIEW_PHASES).toEqual(['specialists', 'judge', 'verification', 'storing']);
    expect(REVIEW_TIERS).toEqual(['trivial', 'lite', 'full']);
    expect(AI_CATEGORIES).toEqual([
      'logic',
      'error-handling',
      'compatibility',
      'concurrency',
      'security',
      'performance',
      'tests',
      'docs',
    ]);
  });

  it('stores a waiting run with its defaults', async () => {
    const stored = await run();
    expect(stored).toMatchObject({
      snapshotId: null,
      status: 'waiting',
      phase: null,
      reason: null,
      detail: null,
      headSha: null,
      sinceSha: null,
      diffDigest: null,
      tier: null,
      reviewers: [],
      providerHost: null,
      model: null,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: null,
      tokenLimitReached: false,
      snapshotPartial: false,
      summary: null,
      findingsNew: 0,
      findingsOpen: 0,
      findingsFixed: 0,
      startedAt: null,
      finishedAt: null,
    });
    expect(stored.id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(stored.deadlineAt).toEqual(DEADLINE);
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps what a finished run records, with token counts past 2^31', async () => {
    const analysisId = await newAnalysis();
    const snapshot = await newSnapshot(analysisId);
    const summary = {
      verdict: 'Two things to fix before this merges.',
      walkthrough: ['Parses the config file', 'Adds a retry'],
      notes: ['token_limit_reached'],
    };
    const stored = await run({
      analysisId,
      snapshotId: snapshot.id,
      status: 'done',
      headSha: SHA256,
      sinceSha: SHA1,
      diffDigest: SHA256,
      tier: 'full',
      reviewers: ['quality', 'security'],
      providerHost: 'api.example.com',
      model: 'model-1',
      modelCalls: 9,
      toolCalls: 31,
      inputTokens: 5_000_000_000,
      outputTokens: 120_000,
      costMicroUsd: 3_500_000,
      tokenLimitReached: true,
      snapshotPartial: true,
      summary,
      findingsNew: 2,
      findingsOpen: 3,
      findingsFixed: 1,
      startedAt: new Date('2026-10-22T08:00:05Z'),
      finishedAt: new Date('2026-10-22T08:03:41Z'),
    });
    expect(stored).toMatchObject({
      snapshotId: snapshot.id,
      status: 'done',
      phase: null,
      reason: null,
      headSha: SHA256,
      sinceSha: SHA1,
      diffDigest: SHA256,
      tier: 'full',
      reviewers: ['quality', 'security'],
      providerHost: 'api.example.com',
      model: 'model-1',
      modelCalls: 9,
      toolCalls: 31,
      inputTokens: 5_000_000_000,
      outputTokens: 120_000,
      costMicroUsd: 3_500_000,
      tokenLimitReached: true,
      snapshotPartial: true,
      summary,
      findingsNew: 2,
      findingsOpen: 3,
      findingsFixed: 1,
    });
    expect(stored.startedAt).toEqual(new Date('2026-10-22T08:00:05Z'));
    expect(stored.finishedAt).toEqual(new Date('2026-10-22T08:03:41Z'));
  });

  it('one run per analysis', async () => {
    const stored = await run();
    expect(
      await refusal(
        t.db.insert(reviewRuns).values(await runValues({ analysisId: stored.analysisId })),
      ),
    ).toEqual({
      code: PG_UNIQUE_VIOLATION,
      constraint: 'review_runs_analysis_id_unique',
    });
  });

  it('a run has a project, a branch, an analysis and a deadline', async () => {
    for (const missing of ['projectId', 'branchId', 'analysisId', 'deadlineAt'] as const) {
      const values = { ...(await runValues()), [missing]: undefined } as RunInsert;
      expect((await refusal(t.db.insert(reviewRuns).values(values)))?.code, missing).toBe(
        PG_NOT_NULL_VIOLATION,
      );
    }
  });

  it('status and tier are limited to their lists', async () => {
    const analysisId = await newAnalysis();
    for (const status of REVIEW_RUN_STATUSES) {
      expect(await tryRun(analysisId, { status, reason: reasonFor(status) }), status).toBeNull();
    }
    for (const tier of REVIEW_TIERS) expect(await tryRun(analysisId, { tier }), tier).toBeNull();
    for (const status of ['cancelled', 'Done', 'queued', '']) {
      expect(await tryRun(analysisId, { status: status as never }), status).toEqual(
        checkViolation('review_runs_status_check'),
      );
    }
    for (const tier of ['huge', 'Full', 'medium', '']) {
      expect(await tryRun(analysisId, { tier: tier as never }), tier).toEqual(
        checkViolation('review_runs_tier_check'),
      );
    }
  });

  it('reason follows status', async () => {
    // The three the plan names, each on its own.
    expect(
      await refusal(t.db.insert(reviewRuns).values(await runValues({ status: 'skipped' }))),
    ).toEqual(checkViolation('review_runs_reason_by_status'));
    expect(
      await refusal(
        t.db.insert(reviewRuns).values(await runValues({ status: 'done', reason: 'draft' })),
      ),
    ).toEqual(checkViolation('review_runs_reason_by_status'));
    expect(
      await refusal(
        t.db.insert(reviewRuns).values(await runValues({ status: 'failed', reason: 'draft' })),
      ),
    ).toEqual(checkViolation('review_runs_reason_by_status'));

    // Every status against every reason: a skip reason iff skipped, a failure reason iff failed,
    // and no reason at all on any other status.
    const analysisId = await newAnalysis();
    const reasons: (string | null)[] = [
      null,
      ...REVIEW_SKIP_REASONS,
      ...REVIEW_FAILURE_REASONS,
      'nonsense',
      '',
    ];
    for (const status of REVIEW_RUN_STATUSES) {
      const allowed: readonly (string | null)[] =
        status === 'skipped'
          ? REVIEW_SKIP_REASONS
          : status === 'failed'
            ? REVIEW_FAILURE_REASONS
            : [null];
      for (const reason of reasons) {
        expect(
          await tryRun(analysisId, { status, reason: reason as never }),
          `${status} with ${String(reason)}`,
        ).toEqual(allowed.includes(reason) ? null : checkViolation('review_runs_reason_by_status'));
      }
    }
  });

  it('phase only while running', async () => {
    const analysisId = await newAnalysis();
    for (const status of REVIEW_RUN_STATUSES) {
      for (const phase of [null, ...REVIEW_PHASES]) {
        expect(
          await tryRun(analysisId, { status, reason: reasonFor(status), phase }),
          `${status} in ${String(phase)}`,
        ).toEqual(
          phase === null || status === 'running'
            ? null
            : checkViolation('review_runs_phase_only_while_running'),
        );
      }
    }
    // A phase outside the list is refused even while running.
    for (const phase of ['planning', 'Judge', '']) {
      expect(await tryRun(analysisId, { status: 'running', phase: phase as never }), phase).toEqual(
        checkViolation('review_runs_phase_check'),
      );
    }
  });

  it('a bad SHA, digest or over-long detail is refused', async () => {
    const analysisId = await newAnalysis();
    const bad = [
      '',
      'HEAD',
      'A'.repeat(40),
      'g'.repeat(40),
      ...[39, 41, 63, 65].map((n) => 'a'.repeat(n)),
    ];
    const columns = [
      ['review_runs_head_sha_format', (sha: string): Partial<RunInsert> => ({ headSha: sha })],
      ['review_runs_since_sha_format', (sha: string): Partial<RunInsert> => ({ sinceSha: sha })],
    ] as const;
    for (const [constraint, set] of columns) {
      for (const sha of bad) {
        expect(await tryRun(analysisId, set(sha)), `${constraint} ${sha}`).toEqual(
          checkViolation(constraint),
        );
      }
      // A SHA-1 or a SHA-256 object name in lower case, and no SHA at all.
      for (const sha of [SHA1, SHA256]) expect(await tryRun(analysisId, set(sha))).toBeNull();
      expect(await tryRun(analysisId, {})).toBeNull();
    }

    // The digest is a sha256 in hex: 64 lower-case digits, nothing shorter (char(64) pads it).
    for (const digest of ['', 'abc', SHA1, 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      expect(await tryRun(analysisId, { diffDigest: digest }), digest).toEqual(
        checkViolation('review_runs_diff_digest_format'),
      );
    }
    expect(await tryRun(analysisId, { diffDigest: SHA256 })).toBeNull();
    expect((await tryRun(analysisId, { diffDigest: 'a'.repeat(65) }))?.code).toBe(
      PG_STRING_TOO_LONG,
    );

    // 200 characters, counted as characters and not as bytes.
    expect(await tryRun(analysisId, { detail: 'SNAPSHOT_INVALID'.padEnd(200, 'x') })).toBeNull();
    expect(await tryRun(analysisId, { detail: 'é'.repeat(200) })).toBeNull();
    expect(await tryRun(analysisId, { detail: 'x'.repeat(201) })).toEqual(
      checkViolation('review_runs_detail_length'),
    );
  });

  it('deleting the analysis deletes its run; deleting the snapshot keeps the run with snapshot_id null', async () => {
    // The analysis: its run goes with it (and so does the snapshot of that analysis).
    const doomedAnalysis = await newAnalysis();
    const doomedSnapshot = await newSnapshot(doomedAnalysis);
    const doomed = await run({ analysisId: doomedAnalysis, snapshotId: doomedSnapshot.id });
    const other = await run();
    await t.db.delete(analyses).where(eq(analyses.id, doomedAnalysis));
    expect(await survivors([doomed.id, other.id])).toEqual([other.id]);

    // The snapshot: the run stays, and says it has none.
    const analysisId = await newAnalysis();
    const snapshot = await newSnapshot(analysisId);
    const kept = await run({ analysisId, snapshotId: snapshot.id, status: 'done' });
    expect(kept.snapshotId).toBe(snapshot.id);
    await t.db.delete(reviewSnapshots).where(eq(reviewSnapshots.id, snapshot.id));
    const [after] = await t.db.select().from(reviewRuns).where(eq(reviewRuns.id, kept.id));
    expect(after).toMatchObject({ id: kept.id, analysisId, status: 'done', snapshotId: null });
  });

  it('deleting the branch or the project deletes its runs', async () => {
    const doomedBranch = await newBranch('8');
    const onBranch = await run({ branchId: doomedBranch });
    const elsewhere = await run();
    await t.db.delete(branches).where(eq(branches.id, doomedBranch));
    expect(await survivors([onBranch.id, elsewhere.id])).toEqual([elsewhere.id]);
    // The run's own branch FK did it: the analysis was never on that branch and stays.
    expect(
      await t.db
        .select({ id: analyses.id })
        .from(analyses)
        .where(eq(analyses.id, onBranch.analysisId)),
    ).toHaveLength(1);

    // The run's own project FK, on its own: its analysis and branch belong to the surviving project.
    const doomedProject = await newProject('runs/doomed');
    const ofProject = await run({ projectId: doomedProject });
    await t.db.delete(projects).where(eq(projects.id, doomedProject));
    expect(await survivors([ofProject.id])).toEqual([]);
    expect(
      await t.db
        .select({ id: analyses.id })
        .from(analyses)
        .where(eq(analyses.id, ofProject.analysisId)),
    ).toHaveLength(1);
  });

  it('stores a finding beside its issue', async () => {
    const bare = await finding();
    expect(bare).toMatchObject({
      runId: null,
      category: 'logic',
      body: 'The loop never ends when the list is empty.',
      assumption: null,
      verification: null,
      suggestion: null,
      anchorLine: null,
      reviewedHeadSha: SHA1,
    });
    expect(bare.createdAt).toBeInstanceOf(Date);
    expect(bare.updatedAt).toBeInstanceOf(Date);

    const { id: runId } = await run();
    const suggestion = { startLine: 41, endLine: 42, lines: ['if (list.length === 0) return;'] };
    const full = await finding({
      runId,
      category: 'error-handling',
      assumption: 'The caller never passes null.',
      verification: 'needs_validation',
      suggestion,
      anchorLine: 41,
      reviewedHeadSha: SHA256,
    });
    expect(full).toMatchObject({
      runId,
      category: 'error-handling',
      assumption: 'The caller never passes null.',
      verification: 'needs_validation',
      suggestion,
      anchorLine: 41,
      reviewedHeadSha: SHA256,
    });
  });

  it('a finding row follows its issue', async () => {
    const stored = await finding();
    // One finding row per issue.
    expect(
      await refusal(
        t.db.insert(reviewFindings).values(await findingValues({ issueId: stored.issueId })),
      ),
    ).toEqual({
      code: PG_UNIQUE_VIOLATION,
      constraint: 'review_findings_pkey',
    });
    // No finding row without an issue.
    expect(
      await refusal(
        t.db.insert(reviewFindings).values(await findingValues({ issueId: randomUUID() })),
      ),
    ).toEqual({
      code: PG_FOREIGN_KEY_VIOLATION,
      constraint: 'review_findings_issue_id_issues_id_fk',
    });
    // Deleting the issue deletes the row.
    const other = await finding();
    await t.db.delete(issues).where(eq(issues.id, stored.issueId));
    const left = await t.db
      .select({ issueId: reviewFindings.issueId })
      .from(reviewFindings)
      .where(inArray(reviewFindings.issueId, [stored.issueId, other.issueId]));
    expect(left).toEqual([{ issueId: other.issueId }]);
  });

  it('deleting a run keeps its findings with run_id null', async () => {
    const doomed = await run();
    const kept = await run();
    const ofDoomed = await finding({ runId: doomed.id });
    const ofKept = await finding({ runId: kept.id });
    await t.db.delete(reviewRuns).where(eq(reviewRuns.id, doomed.id));
    const rows = await t.db
      .select({
        issueId: reviewFindings.issueId,
        runId: reviewFindings.runId,
        body: reviewFindings.body,
      })
      .from(reviewFindings)
      .where(inArray(reviewFindings.issueId, [ofDoomed.issueId, ofKept.issueId]));
    const byIssue = Object.fromEntries(rows.map((row) => [row.issueId, row]));
    expect(byIssue[ofDoomed.issueId]).toMatchObject({ runId: null, body: ofDoomed.body });
    expect(byIssue[ofKept.issueId]).toMatchObject({ runId: kept.id });
    // A finding names a run that exists.
    expect(await tryFinding({ runId: randomUUID() })).toEqual({
      code: PG_FOREIGN_KEY_VIOLATION,
      constraint: 'review_findings_run_id_review_runs_id_fk',
    });
  });

  it('a finding has a category from the list', async () => {
    for (const category of AI_CATEGORIES) {
      expect(await tryFinding({ category }), category).toBeNull();
    }
    for (const category of ['style', 'Logic', 'error_handling', '']) {
      expect(await tryFinding({ category: category as AiCategory }), category).toEqual(
        checkViolation('review_findings_category_check'),
      );
    }
  });

  it('a finding is confirmed, needs validation or says nothing', async () => {
    for (const verification of ['confirmed', 'needs_validation', null] as const) {
      expect(await tryFinding({ verification }), String(verification)).toBeNull();
    }
    for (const verification of ['rejected', 'Confirmed', '']) {
      expect(await tryFinding({ verification: verification as never }), verification).toEqual(
        checkViolation('review_findings_verification_check'),
      );
    }
  });

  it('a finding body and assumption are bounded in characters, not bytes', async () => {
    expect(await tryFinding({ body: 'x'.repeat(2_000) })).toBeNull();
    expect(await tryFinding({ body: 'é'.repeat(2_000) })).toBeNull();
    expect(await tryFinding({ body: 'x'.repeat(2_001) })).toEqual(
      checkViolation('review_findings_body_length'),
    );
    expect(await tryFinding({ assumption: 'x'.repeat(300) })).toBeNull();
    expect(await tryFinding({ assumption: 'é'.repeat(300) })).toBeNull();
    expect(await tryFinding({ assumption: 'x'.repeat(301) })).toEqual(
      checkViolation('review_findings_assumption_length'),
    );
  });

  it('a finding names the commit it was reviewed at', async () => {
    const bad = [
      '',
      'HEAD',
      'A'.repeat(40),
      'g'.repeat(40),
      ...[39, 41, 63, 65].map((n) => 'a'.repeat(n)),
    ];
    for (const sha of bad) {
      expect(await tryFinding({ reviewedHeadSha: sha }), sha).toEqual(
        checkViolation('review_findings_reviewed_head_sha_format'),
      );
    }
    for (const sha of [SHA1, SHA256]) expect(await tryFinding({ reviewedHeadSha: sha })).toBeNull();
    // It is not optional.
    expect((await tryFinding({ reviewedHeadSha: undefined as never }))?.code).toBe(
      PG_NOT_NULL_VIOLATION,
    );
  });

  it('llm_requests accepts feature review and still refuses another value', async () => {
    const request = (feature: string) =>
      llmRequestRow({ organizationId, projectId }, feature, {
        promptVersion: 'review.v1',
        field: 'review',
      });
    // The three single-shot features, as before, and the review.
    for (const feature of [...LLM_FEATURES, 'review']) {
      expect(await refusal(t.db.insert(llmRequests).values(request(feature))), feature).toBeNull();
    }
    const stored = first(await t.db.insert(llmRequests).values(request('review')).returning());
    // The column's TypeScript type says so too.
    const feature: LlmRequestFeature = stored.feature;
    expect(feature).toBe('review');
    expect(stored).toMatchObject({ issueId: null, userId: null, status: 'queued' });
    for (const other of ['poem', 'Review', 'reviews', '']) {
      expect(await refusal(t.db.insert(llmRequests).values(request(other))), other).toEqual(
        checkViolation('llm_requests_feature_check'),
      );
    }
    // LLM_FEATURES stays the three single-shot features.
    expect(LLM_FEATURES).toEqual(['explain', 'triage', 'fix']);
  });

  it('indexes the runs of a branch, newest first, and the runs that still wait or run', async () => {
    const { rows } = await t.pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('review_runs', 'review_findings')`,
    );
    const definitions = Object.fromEntries(
      rows.map((row) => [row.indexname, row.indexdef.replace(/^.* USING /, '')]),
    );
    expect(definitions['review_runs_branch_idx']).toBe('btree (branch_id, created_at DESC)');
    expect(definitions['review_runs_active_idx']).toBe(
      "btree (status) WHERE (status = ANY (ARRAY['waiting'::text, 'running'::text]))",
    );
  });
});
