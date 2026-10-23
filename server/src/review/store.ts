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
  type ReviewTier,
} from '../db/schema';
import type { ReviewableChange, ReviewContext } from './context';
import { planFindings, type CloseReason, type FindingsPlan } from './findings';
import {
  renderFinding,
  reviewSummary,
  type RenderedFinding,
  type ReviewSummary,
} from './findings-render';
import type { MaskBudget, MaskedFiles, MaskedText } from './masked-files';
import type { Masker } from './masker';
import type { PipelineOutcome } from './pipeline';
import { AI_RULES } from './rules';

/*
 * The end of a review, in two steps. `prepareReviewOutcome` decides what is stored and makes every
 * value of it, which includes reading and masking the files the findings are in: it writes no
 * database (it reads the snapshot's files, through the review's reader on the pool) and runs before
 * the transaction, so that the seconds masking can take hold nothing up.
 * `storeReviewOutcome` only locks and writes, in the transaction the caller opens: the findings
 * become issues of engine `ai`, each with a `review_findings` row that keeps the text, the
 * suggestion and where its thread sits, and the run is done. A review is stored whole or not at
 * all, and a run is stored once: the transaction takes the run's row, which must be storing its
 * results.
 *
 * What the findings are, which earlier ones they are and which earlier ones are closed is decided in
 * findings.ts, and the values are made in findings-render.ts. The issues the store touches are the
 * open AI issues of the run's branch, taken in one pass in the order of their ids, as every other
 * writer of issues takes theirs, and read again once taken: a person may have triaged one while the
 * review ran, and what a person decided is never undone.
 */

export interface ReviewPrepareDeps {
  /**
   * The review's masked files, which the masked text of a finding's file is read from. A file's raw
   * text never goes into an issue.
   */
  files: MaskedFiles;
  /** The review's masker: a file that is not kept is masked only while it has time left. */
  masker: Masker;
  /** The review's budget of bytes to mask, which masking a file at this point is charged to. */
  budget: MaskBudget;
}

/** What a review stores, made and checked, as plain data: nothing in it holds a connection. */
export interface PreparedOutcome {
  /** The head commit of the review, in lower case: the run's own head is stored when it has one. */
  headSha: string;
  /** New issues. */
  created: RenderedFinding[];
  /**
   * Earlier issues raised again where they can be placed: the new text, lines, snippet, suggestion
   * and anchor are written together, with the head they were made for.
   */
  updated: { priorId: string; category: AiCategory; rows: RenderedFinding }[];
  /** Earlier issues that stay as they are: the review only marks that it looked at them. */
  kept: string[];
  closed: { id: string; why: CloseReason }[];
  /** Findings the review did not store. */
  dropped: number;
  summary: ReviewSummary;
  tier: ReviewTier;
  reviewers: string[];
  tokenLimitReached: boolean;
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
  deps: ReviewPrepareDeps,
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

/** The values to store for the findings of the plan, each file read and masked once. */
async function renderPlan(
  plan: FindingsPlan,
  deps: ReviewPrepareDeps,
): Promise<Pick<PreparedOutcome, 'created' | 'updated'>> {
  const heads = new Map<string, MaskedText | null>();
  const headOf = async (path: string, change: ReviewableChange | undefined) => {
    if (!heads.has(path)) heads.set(path, await maskedHead(path, change, deps));
    return heads.get(path) ?? null;
  };
  const created: RenderedFinding[] = [];
  for (const planned of plan.creates) {
    const head = await headOf(planned.finding.path, planned.change);
    created.push(renderFinding(planned, planned.finding.category, head));
  }
  const updated: PreparedOutcome['updated'] = [];
  for (const { prior, found } of plan.updates) {
    const head = await headOf(found.finding.path, found.change);
    updated.push({
      priorId: prior.id,
      category: prior.category,
      rows: renderFinding(found, prior.category, head),
    });
  }
  return { created, updated };
}

/**
 * Decides what a review stores and makes the values of it: the findings that become issues, the
 * earlier ones raised again, kept or closed, and the summary. It reads and masks the files the
 * findings are in, and writes no database, so call it before the transaction opens. The reader
 * behind `deps.files` is the review's own, opened on the connection pool: it reads
 * `review_snapshot_files`, takes no lock and writes nothing, and it is never opened on the
 * transaction `storeReviewOutcome` is given. Nothing here looks at the run: the caller moves the
 * run to `storing` with an update that only a run still `running` passes, and that update is what
 * refuses a run that was superseded or stored already, before any masking is spent on it.
 * `storeReviewOutcome` takes the run's row again, under lock, and is the authority.
 */
export async function prepareReviewOutcome(
  context: ReviewContext,
  outcome: Extract<PipelineOutcome, { kind: 'reviewed' }>,
  deps: ReviewPrepareDeps,
): Promise<PreparedOutcome> {
  const summary = reviewSummary(outcome);
  const plan = planFindings(context, outcome);
  const { created, updated } = await renderPlan(plan, deps);
  return {
    headSha: context.meta.headSha.toLowerCase(),
    created,
    updated,
    kept: plan.keeps.map((prior) => prior.id),
    closed: plan.closes.map(({ prior, why }) => ({ id: prior.id, why })),
    dropped: plan.dropped.length,
    summary,
    tier: outcome.tier,
    reviewers: [...outcome.specialists],
    tokenLimitReached: outcome.tokenLimitReached,
  };
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
 * Stores a prepared outcome, in the transaction that ends the run: the new findings as issues, the
 * earlier ones raised again as updates of their issues, the ones found fixed (or in a deleted file)
 * as closed ones with a changelog entry, and the run as `done` with its counts and its summary.
 * `ruleIds` are the ids of the eight AI rules by category: call `ensureAiRules` on the pool before
 * the transaction opens, so that the store never waits on another store's open transaction. It
 * throws {@link ReviewNotStoringError}, writing nothing, when the run is not storing.
 *
 * A finding is written with the head its anchor and its suggestion were made for. An earlier finding
 * that is only kept or closed keeps the head of its last placement: the review marks that it looked
 * at it (`run_id`, and `last_seen_analysis_id` of the issue) and nothing more.
 */
export async function storeReviewOutcome(
  tx: Tx,
  run: ReviewRunRow,
  prepared: PreparedOutcome,
  ruleIds: ReadonlyMap<AiCategory, string>,
): Promise<StoreCounts> {
  const headSha = (run.headSha ?? prepared.headSha).toLowerCase();
  await lockRun(tx, run.id);
  const openNow = await lockOpen(tx, run, ruleIds, [
    ...prepared.updated.map((u) => u.priorId),
    ...prepared.kept,
    ...prepared.closed.map((c) => c.id),
  ]);
  const ruleOf = (category: AiCategory) => {
    const id = ruleIds.get(category);
    const quality = QUALITY.get(category);
    if (id === undefined || quality === undefined) {
      throw new Error(`no rule for the AI category ${category}`);
    }
    return { id, quality };
  };

  const created = prepared.created.map((rows) => ({ id: uuidv7(), rows }));
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
  for (const { priorId, category, rows } of prepared.updated) {
    if (!openNow.has(priorId)) {
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
      .where(eq(issues.id, priorId));
    const row = findingRow(rows, run.id, headSha);
    await tx
      .insert(reviewFindings)
      .values({ issueId: priorId, category, ...row })
      .onConflictDoUpdate({
        target: reviewFindings.issueId,
        set: { ...row, updatedAt: sql`now()` },
      });
    updates += 1;
  }

  // Found still there, named by a finding that could not be used, or raised again where it cannot
  // be placed: nothing of it is rewritten, and its anchor and suggestion keep the head they were
  // made for.
  const kept = prepared.kept.filter((id) => openNow.has(id));
  if (kept.length > 0) {
    await tx
      .update(issues)
      .set({ lastSeenAnalysisId: run.analysisId })
      .where(inArray(issues.id, kept));
    await tx
      .update(reviewFindings)
      .set({ runId: run.id })
      .where(inArray(reviewFindings.issueId, kept));
  }

  let closed = 0;
  for (const why of ['fixed', 'deleted'] as const) {
    const ids = prepared.closed
      .filter((close) => close.why === why && openNow.has(close.id))
      .map((close) => close.id);
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
      .set({ runId: run.id })
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
        inArray(issues.ruleId, [...ruleIds.values()]),
      ),
    );
  await tx
    .update(reviewRuns)
    .set({
      status: 'done',
      phase: null,
      reason: null,
      finishedAt: sql`now()`,
      tier: prepared.tier,
      reviewers: prepared.reviewers,
      tokenLimitReached: prepared.tokenLimitReached,
      summary: prepared.summary,
      findingsNew: created.length,
      findingsOpen: openRow?.open ?? 0,
      findingsFixed: closed,
    })
    .where(eq(reviewRuns.id, run.id));

  return {
    created: created.length,
    updated: updates + kept.length,
    closed,
    dropped: prepared.dropped + notOpen,
  };
}
