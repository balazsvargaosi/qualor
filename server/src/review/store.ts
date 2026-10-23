import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { uuidv7 } from '../db/ids';
import {
  issueChanges,
  issues,
  reviewFindings,
  reviewRuns,
  type AiCategory,
  type ReviewRunRow,
} from '../db/schema';
import type { ReviewableChange, ReviewContext } from './context';
import {
  planFindings,
  renderFinding,
  reviewSummary,
  type CloseReason,
  type FindingsPlan,
  type RenderedFinding,
} from './findings';
import type { PriorFinding } from './findings-query';
import type { MaskBudget, MaskedFiles, MaskedText } from './masked-files';
import type { Masker } from './masker';
import type { PipelineOutcome } from './pipeline';
import { AI_RULES } from './rules';

/*
 * The end of a review: its findings become issues of engine `ai`, each with a `review_findings` row
 * that keeps the text, the suggestion and where its thread sits, and the run is done. All of it is
 * written in the transaction the caller opens, so a review is stored whole or not at all, and a
 * run is stored once: the transaction takes the run's row, which must be storing its results.
 *
 * What the findings are, which earlier ones they are and which earlier ones are closed is decided in
 * findings.ts; this file reads the masked text of the files the findings are in, and writes. The
 * issues it touches are the open AI issues of the run's branch, taken in one pass in the order of
 * their ids, as every other writer of issues takes theirs, and read again once taken: a person may
 * have triaged one while the review ran, and what a person decided is never undone.
 */

export interface ReviewStoreDeps {
  /**
   * The ids of the eight AI rules by category: `ensureAiRules`, called on the pool before the
   * transaction opens, so that the store never waits on another store's open transaction.
   */
  ruleIds: ReadonlyMap<AiCategory, string>;
  /**
   * The review's masked files, which the store reads the masked text of a finding's file from.
   * It never reads a file's raw text into an issue.
   */
  files: MaskedFiles;
  /** The review's masker: a file that is not kept is masked only while it has time left. */
  masker: Masker;
  /** The review's budget of bytes to mask, which masking a file at this point is charged to. */
  budget: MaskBudget;
}

export interface StoreCounts {
  /** New issues. */
  created: number;
  /** Earlier issues the review raised again or found still there; they stay open. */
  updated: number;
  /** Earlier issues the review closed. */
  closed: number;
  /**
   * Findings not stored: out of scope, not on a line of their file, of low confidence, over the
   * limit, or of an issue a person dismissed (also while the review ran).
   */
  dropped: number;
}

/** The run is not storing its results: it was stored already, or it ended another way. */
export class ReviewNotStoringError extends Error {
  override name = 'ReviewNotStoringError';
  constructor(runId: string) {
    super(`review run ${runId} is not storing its results`);
  }
}

const QUALITY = new Map(AI_RULES.map((rule) => [rule.category, rule.quality]));

const short = (sha: string): string => sha.slice(0, 12);
/** The changelog says what the review did, in its own fixed words. */
const raisedBy = (sha: string): string => `Raised by the AI review of commit ${short(sha)}.`;
const closedBy: Readonly<Record<CloseReason, (sha: string) => string>> = {
  fixed: (sha) => `Closed by the AI review of commit ${short(sha)}: the problem is fixed.`,
  left_out: (sha) =>
    `Closed by the AI review of commit ${short(sha)}: it no longer reports the problem, and the lines it was on changed.`,
  deleted: (sha) => `Closed by the AI review of commit ${short(sha)}: the file was deleted.`,
};

/**
 * The masked text of the head file at `path`, or null when there is none to be had: the one the
 * context was cut from, or the one the review's files keep; else the file is masked now, through the
 * review's masker and charged to its budget, if it has time and bytes left. A failure to mask is no
 * text, not a failed review: a finding without a snippet is still a finding.
 */
async function maskedHead(
  path: string,
  change: ReviewableChange | undefined,
  deps: ReviewStoreDeps,
): Promise<MaskedText | null> {
  const known = change?.text ?? deps.files.keptText(path);
  if (known !== null && known !== undefined) return known;
  if (deps.masker.exhausted) return null;
  try {
    const file = await deps.files.file(path, deps.budget);
    return file.kind === 'text' ? file.text : null;
  } catch {
    return null;
  }
}

interface Created {
  id: string;
  rows: RenderedFinding;
}
interface Updated {
  prior: PriorFinding;
  rows: RenderedFinding;
}

/**
 * The values to store for the findings of the plan. The files are read and masked here, before the
 * transaction takes a lock, so a slow masking holds nothing up.
 */
async function renderPlan(
  plan: FindingsPlan,
  deps: ReviewStoreDeps,
): Promise<{ created: Created[]; updated: Updated[] }> {
  const heads = new Map<string, MaskedText | null>();
  const headOf = async (path: string, change: ReviewableChange | undefined) => {
    if (!heads.has(path)) heads.set(path, await maskedHead(path, change, deps));
    return heads.get(path) ?? null;
  };
  const created: Created[] = [];
  for (const planned of plan.creates) {
    const head = await headOf(planned.finding.path, planned.change);
    created.push({
      id: uuidv7(),
      rows: renderFinding(planned, planned.finding.category, head),
    });
  }
  const updated: Updated[] = [];
  for (const { prior, found } of plan.updates) {
    const head = await headOf(found.finding.path, found.change);
    updated.push({ prior, rows: renderFinding(found, prior.category, head) });
  }
  return { created, updated };
}

/** The row of a finding, as the review that wrote it last left it. */
const findingRow = (rows: RenderedFinding, runId: string, headSha: string) => ({
  runId,
  body: rows.body,
  assumption: rows.assumption,
  verification: rows.verification,
  suggestion: rows.suggestion,
  anchorLine: rows.anchorLine,
  reviewedHeadSha: headSha,
});

/**
 * Takes the run's row, if it is storing its results; the transaction keeps it to the end, so that no
 * other store of the run can start before this one has ended it.
 */
async function lockRun(tx: Tx, runId: string): Promise<void> {
  const locked = await tx
    .select({ id: reviewRuns.id })
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.id, runId),
        eq(reviewRuns.status, 'running'),
        eq(reviewRuns.phase, 'storing'),
      ),
    )
    .for('no key update');
  if (locked.length === 0) throw new ReviewNotStoringError(runId);
}

/**
 * The ids, among `ids`, of the open AI issues of the run's branch, which are locked until the
 * transaction ends. An id of any other issue (another branch's, another engine's) is not among them.
 */
async function lockOpen(
  tx: Tx,
  run: ReviewRunRow,
  ruleIds: ReadonlyMap<AiCategory, string>,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(
      and(
        inArray(issues.id, [...ids]),
        eq(issues.branchId, run.branchId),
        inArray(issues.ruleId, [...ruleIds.values()]),
      ),
    )
    .orderBy(asc(issues.id))
    .for('no key update');
  return new Set(rows.filter((row) => row.status === 'open').map((row) => row.id));
}

/**
 * Stores the outcome of a review that reviewed: the new findings as issues, the earlier ones the
 * review raised again as updates of their issues, the ones it found fixed (or left out where the
 * code changed) as closed ones with a changelog entry, and the run as `done` with its counts and its
 * summary. Run it inside the transaction that ends the run, and call `ensureAiRules` on the pool
 * first; it throws {@link ReviewNotStoringError}, writing nothing, when the run is not storing.
 *
 * The snippet and the hashes of an issue are made of the masked text of its file and of nothing
 * else (`deps`); model text is cut to its columns and made storable.
 */
export async function storeReviewOutcome(
  tx: Tx,
  run: ReviewRunRow,
  context: ReviewContext,
  outcome: Extract<PipelineOutcome, { kind: 'reviewed' }>,
  deps: ReviewStoreDeps,
): Promise<StoreCounts> {
  const headSha = (run.headSha ?? context.meta.headSha).toLowerCase();
  const summary = reviewSummary(outcome);
  const plan = planFindings(context, outcome);
  const { created, updated } = await renderPlan(plan, deps);

  await lockRun(tx, run.id);
  const openNow = await lockOpen(tx, run, deps.ruleIds, [
    ...plan.updates.map((u) => u.prior.id),
    ...plan.keeps.map((p) => p.id),
    ...plan.closes.map((c) => c.prior.id),
  ]);
  const ruleOf = (category: AiCategory) => {
    const id = deps.ruleIds.get(category);
    const quality = QUALITY.get(category);
    if (id === undefined || quality === undefined) {
      throw new Error(`no rule for the AI category ${category}`);
    }
    return { id, quality };
  };

  if (created.length > 0) {
    await tx.insert(issues).values(
      created.map(({ id, rows }) => {
        const rule = ruleOf(rows.category);
        return {
          id,
          projectId: run.projectId,
          branchId: run.branchId,
          ruleId: rule.id,
          fingerprint: rows.fingerprint,
          lineHash: rows.lineHash,
          contextHash: rows.contextHash,
          path: rows.path,
          startLine: rows.startLine,
          endLine: rows.endLine,
          message: rows.message,
          severity: rows.severity,
          quality: rule.quality,
          kind: 'issue' as const,
          status: 'open',
          inNewCode: true,
          snippet: rows.snippet,
          confidence: rows.confidence,
          firstSeenAnalysisId: run.analysisId,
          firstSeenAt: sql`now()`,
          lastSeenAnalysisId: run.analysisId,
        };
      }),
    );
    await tx.insert(reviewFindings).values(
      created.map(({ id, rows }) => ({
        issueId: id,
        category: rows.category,
        ...findingRow(rows, run.id, headSha),
      })),
    );
    await tx.insert(issueChanges).values(
      created.map(({ id }) => ({
        issueId: id,
        analysisId: run.analysisId,
        field: 'comment' as const,
        comment: raisedBy(headSha),
      })),
    );
  }

  // An issue raised again keeps its place in the list and its thread: its words, lines and snippet
  // are the new finding's, and a severity a person set stays. One that is not open now was triaged
  // while the review ran, and the finding is dropped.
  let updates = 0;
  let notOpen = 0;
  for (const { prior, rows } of updated) {
    if (!openNow.has(prior.id)) {
      notOpen += 1;
      continue;
    }
    await tx
      .update(issues)
      .set({
        path: rows.path,
        startLine: rows.startLine,
        endLine: rows.endLine,
        message: rows.message,
        severity: sql`CASE WHEN ${issues.severityOverridden} THEN ${issues.severity} ELSE ${rows.severity} END`,
        confidence: rows.confidence,
        fingerprint: rows.fingerprint,
        lineHash: rows.lineHash,
        contextHash: rows.contextHash,
        snippet: rows.snippet,
        lastSeenAnalysisId: run.analysisId,
      })
      .where(eq(issues.id, prior.id));
    const row = findingRow(rows, run.id, headSha);
    await tx
      .insert(reviewFindings)
      .values({ issueId: prior.id, category: prior.category, ...row })
      .onConflictDoUpdate({
        target: reviewFindings.issueId,
        set: { ...row, updatedAt: sql`now()` },
      });
    updates += 1;
  }

  // Found still there, but not raised again: checked at this commit, nothing else to say of it.
  const kept = plan.keeps.filter((prior) => openNow.has(prior.id)).map((prior) => prior.id);
  if (kept.length > 0) {
    await tx
      .update(issues)
      .set({ lastSeenAnalysisId: run.analysisId })
      .where(inArray(issues.id, kept));
    await tx
      .update(reviewFindings)
      .set({ runId: run.id, reviewedHeadSha: headSha })
      .where(inArray(reviewFindings.issueId, kept));
  }

  let closed = 0;
  for (const why of ['fixed', 'left_out', 'deleted'] as const) {
    const ids = plan.closes
      .filter((close) => close.why === why && openNow.has(close.prior.id))
      .map((close) => close.prior.id);
    if (ids.length === 0) continue;
    const ended = await tx
      .update(issues)
      .set({ status: 'closed', closedAt: sql`now()` })
      .where(inArray(issues.id, ids))
      .returning({ id: issues.id });
    await tx.insert(issueChanges).values(
      ended.map(({ id }) => ({
        issueId: id,
        analysisId: run.analysisId,
        field: 'status' as const,
        oldValue: 'open',
        newValue: 'closed',
        comment: closedBy[why](headSha),
      })),
    );
    await tx
      .update(reviewFindings)
      .set({ runId: run.id, reviewedHeadSha: headSha })
      .where(
        inArray(
          reviewFindings.issueId,
          ended.map(({ id }) => id),
        ),
      );
    closed += ended.length;
  }

  const [openRow] = await tx
    .select({ open: count() })
    .from(issues)
    .where(
      and(
        eq(issues.branchId, run.branchId),
        eq(issues.status, 'open'),
        inArray(issues.ruleId, [...deps.ruleIds.values()]),
      ),
    );
  await tx
    .update(reviewRuns)
    .set({
      status: 'done',
      phase: null,
      reason: null,
      finishedAt: sql`now()`,
      tier: outcome.tier,
      reviewers: outcome.specialists,
      tokenLimitReached: outcome.tokenLimitReached,
      summary,
      findingsNew: created.length,
      findingsOpen: openRow?.open ?? 0,
      findingsFixed: closed,
    })
    .where(eq(reviewRuns.id, run.id));

  return {
    created: created.length,
    updated: updates + kept.length,
    closed,
    dropped: plan.dropped.length + notOpen,
  };
}
