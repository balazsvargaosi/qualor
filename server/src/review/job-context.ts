import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { reviewRuns } from '../db/schema';
import { excludedPathMatcher } from '../llm/settings';
import {
  analyzerFindings,
  buildReviewContext,
  priorAiFindings,
  type ContextLimits,
  type ContextShape,
  type ReviewableChange,
  type ReviewContext,
} from './context';
import type { ReviewJobDeps } from './job';
import type { Running } from './job-start';
import type { MaskedFiles } from './masked-files';
import type { Masker } from './masker';
import { reviewFits, reviewLimits } from './pipeline';
import { startedAtIs } from './run-ends';
import { lastReviewedDigest } from './runs';
import { effectiveReviewBudgets } from './settings';
import type { SnapshotChange, SnapshotReader } from './snapshot-reader';
import type { ToolPolicy } from './tools';
import { remainingReviewTokens, reservedReviewTokens, reviewUsageToday } from './usage';

/**
 * What the context's limits throw, before anything is masked: the review is skipped. A budget that
 * is spent for the day has no detail; one the merge request is too large for is `too_large`, and a
 * model's context window it is too large for, with Tokens per review enough, `window_too_small`.
 */
export class SkipReview extends Error {
  constructor(
    readonly reason: 'empty_diff' | 'unchanged' | 'budget_spent',
    readonly detail: 'too_large' | 'window_too_small' | null = null,
  ) {
    super(reason);
    this.name = 'SkipReview';
  }
}

/** The review's context, or why there is none to review (with the digest, when it was made). */
export type ContextOutcome =
  | { kind: 'built'; context: ReviewContext }
  | {
      kind: 'skipped';
      reason: SkipReview['reason'];
      detail: SkipReview['detail'];
      digest: string | null;
    };

/**
 * The reader with its changes read once: buildReviewContext and the digest both need them, and a
 * merge request's patches can be large. `release` lets them go once both have them.
 */
export function changesReadOnce(reader: SnapshotReader): {
  reader: SnapshotReader;
  release(): void;
} {
  let held: Promise<SnapshotChange[]> | null = null;
  return {
    reader: { ...reader, changes: () => (held ??= reader.changes()) },
    release: () => {
      held = null;
    },
  };
}

/**
 * The digest of what the review reads of the diff: sha256 over the reviewed changes, by path, each
 * its path, status and patch as the snapshot has them (the raw patch: it never leaves the digest).
 */
export function diffDigest(
  changes: readonly SnapshotChange[],
  reviewed: readonly Pick<ReviewableChange, 'path'>[],
): string {
  const paths = new Set(reviewed.map((change) => change.path));
  const hash = createHash('sha256');
  const byPath = (a: SnapshotChange, b: SnapshotChange) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  };
  for (const change of changes.filter((c) => paths.has(c.path)).sort(byPath)) {
    hash.update(`${JSON.stringify([change.path, change.status, change.patch])}\n`);
  }
  return hash.digest('hex');
}

/** Why a merge request does not fit the review's budget: too large for Tokens per review, or for the window alone. */
function tooLargeDetail(
  shape: Parameters<typeof reviewFits>[0],
  perReview: number,
  window: number,
): 'too_large' | 'window_too_small' | null {
  // Too large for Tokens per review is said first: a larger window alone would not do.
  if (!reviewFits(shape, perReview, Number.POSITIVE_INFINITY)) return 'too_large';
  return reviewFits(shape, perReview, window) ? null : 'window_too_small';
}

/**
 * Steps 7 to 9 and the review's context. They are decided when the context asks for its limits,
 * once it knows the reviewed changes and before it masks anything: none (`empty_diff`), the same
 * diff as the branch's last review that was done (`unchanged`), or a budget too small for the
 * smallest share of the review, in the model's context window (`window`, R46), as `reviewFits` asks
 * it (`budget_spent`). A merge request too large for what one review may use (`perReview`, Tokens
 * per review) whatever the window has the detail `too_large`, and the summary names that budget;
 * one that Tokens per review holds but not the window, `window_too_small`, and the summary names
 * the window; one that only what is left of the day is too little for has none, as the day is what
 * stops it. The digest is written on the run either way.
 */
export async function runContext(
  deps: ReviewJobDeps,
  running: Running,
  o: {
    files: MaskedFiles;
    masker: Masker;
    policy: ToolPolicy;
    budget: number;
    perReview: number;
    /** The model's context window, in tokens: the provider's, or the default. */
    window: number;
  },
): Promise<ContextOutcome> {
  const { db } = deps;
  const { run, settings } = running;
  const { budget, window } = o;
  const previous = await lastReviewedDigest(db, run.branchId, run.id);
  const changes = await o.files.reader.changes();
  const seen: { digest: string | null } = { digest: null };
  const limits = (shape: ContextShape): ContextLimits => {
    if (shape.reviewed.length === 0) throw new SkipReview('empty_diff');
    seen.digest = diffDigest(changes, shape.reviewed);
    if (seen.digest === previous) throw new SkipReview('unchanged');
    if (budget <= 0) throw new SkipReview('budget_spent');
    if (!reviewFits(shape, budget, window)) {
      throw new SkipReview('budget_spent', tooLargeDetail(shape, o.perReview, window));
    }
    return reviewLimits(shape, budget, window);
  };
  let context: ReviewContext;
  try {
    context = await buildReviewContext(
      o.files,
      o.masker,
      {
        analyzer: (paths) => analyzerFindings(db, run.analysisId, paths),
        prior: await priorAiFindings(db, run.branchId),
      },
      { excluded: excludedPathMatcher(settings.excludePaths), budget: o.policy.budget, limits },
    );
  } catch (err) {
    if (!(err instanceof SkipReview)) throw err;
    return { kind: 'skipped', reason: err.reason, detail: err.detail, digest: seen.digest };
  }
  // Only into the run this job started: one started again meanwhile has its own digest to make.
  await db
    .update(reviewRuns)
    .set({ diffDigest: seen.digest })
    .where(and(eq(reviewRuns.id, run.id), startedAtIs(run.startedAt)));
  return { kind: 'built', context };
}

/**
 * What the review may spend: the smallest of its own ceiling and what the day has left (C2), less
 * what the other running reviews of the organisation (and of the project) may still spend (R45).
 */
export async function reviewTokensLeft(db: Executor, running: Running): Promise<number> {
  const { organizationId, run, settings } = running;
  const budgets = effectiveReviewBudgets(settings, organizationId);
  const perReview = budgets.maxTokensPerReview;
  const [organization, project, reservedOrganization, reservedProject] = await Promise.all([
    reviewUsageToday(db, organizationId),
    reviewUsageToday(db, organizationId, run.projectId),
    reservedReviewTokens(db, { organizationId, exceptRunId: run.id, perReview }),
    // Without a budget of its own the project's reservation cannot change the answer.
    budgets.perProjectTokensPerDay === null
      ? 0
      : reservedReviewTokens(db, {
          organizationId,
          projectId: run.projectId,
          exceptRunId: run.id,
          perReview,
        }),
  ]);
  return remainingReviewTokens(
    budgets,
    { organization, project },
    settings.pricing,
    settings.provider,
    { organization: reservedOrganization, project: reservedProject },
  );
}
