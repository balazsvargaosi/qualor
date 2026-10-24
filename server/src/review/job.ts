import { createHash } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db, Executor } from '../db/client';
import { pgErrorCode } from '../db/errors';
import {
  branches,
  projects,
  reviewRuns,
  reviewSnapshots,
  type ReviewPhase,
  type ReviewRunRow,
  type ReviewRunStatus,
} from '../db/schema';
import { costOf, type LlmRuntime } from '../llm/job';
import { LlmError, type LlmConversation, type LlmTurn } from '../llm/providers';
import {
  excludedPathMatcher,
  providerApiKey,
  readLlmSettings,
  type StoredLlmSettings,
} from '../llm/settings';
import type { JobHandlers, WorkerLogger } from '../queue/worker';
import type { DecorationDeps } from '../scm/decorate';
import { readMergeRequestState } from '../scm/mr-state';
import { lockBranchQueue } from '../scm/queue';
import {
  analyzerFindings,
  buildReviewContext,
  priorAiFindings,
  type ContextLimits,
  type ContextShape,
  type ReviewableChange,
  type ReviewContext,
} from './context';
import { CONVERSATION_LIMITS, runConversation, type ConversationResult } from './conversation';
import { deleteBranchSnapshots } from './lifecycle';
import { MaskedFiles } from './masked-files';
import { Masker } from './masker';
import {
  REVIEW_OUTPUT_TOKENS,
  reviewFits,
  reviewLimits,
  runReviewPipeline,
  type PipelineOutcome,
  type ReviewRole,
} from './pipeline';
import { REVIEW_PROMPT_VERSION, SYSTEM_PROMPTS } from './prompts';
import { ensureAiRules } from './rules';
import {
  decorateRun,
  endAndDecorate,
  endRun,
  errorClass,
  logRunEnd,
  writeRunSpend,
  type RunEnd,
  type RunRef,
  type RunSpend,
} from './run-ends';
import { AI_REVIEW_QUEUE, lastReviewedDigest, queueAtDeadline } from './runs';
import {
  effectiveReviewBudgets,
  reviewActive,
  reviewProvider,
  type ReviewProvider,
} from './settings';
import { openSnapshotReader, type SnapshotChange, type SnapshotReader } from './snapshot-reader';
import { prepareReviewOutcome, ReviewNotStoringError, storeReviewOutcome } from './store';
import { REVIEW_TOOLS, runReviewTool, TOOL_LIMITS, type ToolPolicy } from './tools';
import { RedactionTally, remainingReviewTokens, reviewSender, reviewUsageToday } from './usage';

/*
 * The `ai-review` job (6I-3, R15, R21): one review run, from waiting for its snapshot to the
 * findings it stores. In order:
 * 1. a run that is not `waiting` is left as it is; one found `running` was left so by a job that
 *    died, and ends `failed: internal`;
 * 2. an analysis that is no longer its branch's newest is `superseded`;
 * 3. review no longer on for the project: `skipped: inactive`;
 * 4. no snapshot yet: before the deadline the job comes back at it; at or after it,
 *    `skipped: no_snapshot` (a snapshot that comes later starts the run again, runs.ts); a refused
 *    one, `skipped: snapshot_rejected`;
 * 5. the run is `running`, with its snapshot, head and last reviewed commit;
 * 6. the merge request as its provider says it is now: merged or closed, the branch's snapshots
 *    are deleted and the run `skipped: closed`; a draft, `skipped: draft`; no answer, the review
 *    goes on;
 * 7–9. nothing reviewable changed (`empty_diff`), the same diff as the last review that was done
 *    (`unchanged`), no tokens left today or too few for the smallest share of the review
 *    (`budget_spent`): decided before anything is masked or sent;
 * 10. the pipeline (pipeline.ts), its calls recorded as the review's own (usage.ts), stopping at
 *    the next call to the provider when the run is superseded, review is switched off or its
 *    snapshot is deleted (the merge request was merged or closed: `skipped: closed`); then the
 *    findings are stored (store.ts), or the run fails with the pipeline's reason.
 *
 * Every end but `superseded` queues the decoration of the analysis in the same transaction
 * (run-ends.ts), so the summary of the merge request says how the review ended. An exception once
 * the run is running ends it `failed: internal`, and the job completes: a review is never tried
 * again into more spend. One before (steps 1 to 5 decide in one transaction, which then wrote
 * nothing) fails the job into its second try, which decides again; on that last try it ends the
 * run `failed: internal` too, so an error that comes every time is said as one. A run whose job is
 * gone for good is ended by the sweep (runs.ts). Nothing the model said, no prompt and no file of
 * the repository is ever logged: the run's id, codes and counts only.
 */

/** The job's lease: a review waits on its provider, call after call; the worker extends it. */
export const REVIEW_LEASE_MS = 20 * 60_000;

type Logger = WorkerLogger;

export interface ReviewJobDeps {
  db: Db;
  config: Config;
  logger: Logger;
  /**
   * The `llm` worker's circuit: one LlmRuntime serves both workers, so a provider that is failing
   * is left alone by explain, triage and fix and by the reviews at once. A review takes no slot of
   * the organisation's AI requests (R21).
   */
  llmCircuit: LlmRuntime['circuit'];
  scm: DecorationDeps['scm'];
  /** The clock a run's deadline is compared with; the database's when left out. */
  now?: () => Date;
}

const payloadSchema = z.object({ runId: z.uuid() });

/** Why the pipeline was told to stop. */
type StopReason =
  { kind: 'superseded' } | { kind: 'inactive'; detail: string } | { kind: 'snapshot_deleted' };

/** What the context's limits throw, before anything is masked: the review is skipped. */
class SkipReview extends Error {
  constructor(readonly reason: 'empty_diff' | 'unchanged' | 'budget_spent') {
    super(reason);
    this.name = 'SkipReview';
  }
}

/** The review's context, or why there is none to review (with the digest, when it was made). */
type ContextOutcome =
  | { kind: 'built'; context: ReviewContext }
  | { kind: 'skipped'; reason: SkipReview['reason']; digest: string | null };

/** The run's own state while the job works on it, once it is running. */
interface Running {
  run: ReviewRunRow;
  /** The merge request's id: its branch's name. */
  mergeRequestId: string;
  settings: StoredLlmSettings;
  provider: ReviewProvider;
  organizationId: string;
}

/** What steps 1 to 5 decided, in the transaction that holds the run's row. */
type Decision =
  { kind: 'started'; running: Running } | { kind: 'ended'; end: RunEnd } | { kind: 'none' };

/** Whether two providers are the same address, host and model (R10). */
const sameProvider = (a: ReviewProvider | null, b: ReviewProvider): boolean =>
  a !== null && a.url === b.url && a.host === b.host && a.model === b.model;

/**
 * The reader with its changes read once: buildReviewContext and the digest both need them, and a
 * merge request's patches can be large. `release` lets them go once both have them.
 */
function changesReadOnce(reader: SnapshotReader): { reader: SnapshotReader; release(): void } {
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
function diffDigest(
  changes: readonly SnapshotChange[],
  reviewed: readonly Pick<ReviewableChange, 'path'>[],
): string {
  const paths = new Set(reviewed.map((change) => change.path));
  const hash = createHash('sha256');
  const byPath = (a: SnapshotChange, b: SnapshotChange) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  for (const change of changes.filter((c) => paths.has(c.path)).sort(byPath)) {
    hash.update(`${JSON.stringify([change.path, change.status, change.patch])}\n`);
  }
  return hash.digest('hex');
}

class ReviewJob {
  /** Provider calls made, the ones that failed included; the tokens and tool calls of the conversations. */
  private calls = 0;
  private toolCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cost = 0;
  /** Where the calls go and what they cost: set once the review reaches the provider. */
  private provider: { host: string; model: string; pricing: StoredLlmSettings['pricing'] } | null =
    null;
  private stop: StopReason | null = null;
  /** The run, once this job has made it `running`: from then on an exception ends it. */
  private started: ReviewRunRow | null = null;

  constructor(
    private readonly deps: ReviewJobDeps,
    private readonly runId: string,
    /** Whether this is the job's last try (its attempts are spent with it). */
    private readonly lastTry: boolean,
  ) {}

  async run(): Promise<void> {
    try {
      await this.review();
    } catch (err) {
      const fields = {
        runId: this.runId,
        errorClass: errorClass(err),
        code: pgErrorCode(err) ?? null,
      };
      const running = this.started;
      if (running === null && !this.lastTry) {
        // Steps 1 to 5 wrote nothing: the run is as it was, and the job's next try decides it (a
        // snapshot deleted under the start, say, is found gone then).
        this.deps.logger.warn(fields, 'AI review run not decided; its job is tried again');
        throw err;
      }
      this.deps.logger.error(fields, 'AI review run failed');
      if (running !== null) {
        await this.endRunning(running, { status: 'failed', reason: 'internal' });
        return;
      }
      // The last try: nothing will try again, so the run ends here rather than be left to the
      // sweep, which would end it for want of a snapshot.
      const [run] = await this.deps.db
        .select({
          id: reviewRuns.id,
          analysisId: reviewRuns.analysisId,
          branchId: reviewRuns.branchId,
        })
        .from(reviewRuns)
        .where(eq(reviewRuns.id, this.runId));
      if (run === undefined) return;
      await endAndDecorate(
        this.deps.db,
        run,
        ['waiting', 'running'],
        { status: 'failed', reason: 'internal' },
        {},
        this.deps.logger,
      );
    }
  }

  // ─── Steps 1 to 5: waiting for the snapshot ─────────────────────────────────

  /**
   * Decides, holding the run's row, whether the run starts, waits on or ends; a run that ends here
   * is decorated in the same transaction. A run that starts is reviewed.
   */
  private async review(): Promise<void> {
    const decided = await this.deps.db.transaction((tx) => this.decide(tx));
    if (decided.kind === 'ended') {
      logRunEnd(this.deps.logger, this.runId, decided.end);
      return;
    }
    if (decided.kind === 'started') {
      this.started = decided.running.run;
      await this.reviewRunning(decided.running);
    }
  }

  private async decide(tx: Executor): Promise<Decision> {
    // A run's branch never changes. Its decoration lock is taken before the run's row, as
    // ingestion takes them: an end here and its decoration are one step (run-ends.ts).
    const [ref] = await tx
      .select({ branchId: reviewRuns.branchId })
      .from(reviewRuns)
      .where(eq(reviewRuns.id, this.runId));
    if (ref === undefined) return { kind: 'none' };
    await lockBranchQueue(tx, ref.branchId);
    const clock: SQL =
      this.deps.now === undefined ? sql`now()` : sql`${this.deps.now().toISOString()}::timestamptz`;
    const [found] = await tx
      .select({ run: reviewRuns, due: sql<boolean>`${reviewRuns.deadlineAt} <= ${clock}` })
      .from(reviewRuns)
      .where(eq(reviewRuns.id, this.runId))
      .for('update');
    if (found === undefined) return { kind: 'none' };
    const { run, due } = found;
    const from: ReviewRunStatus[] = [run.status];
    // Nothing is spent yet: an end here leaves the spend columns as they are.
    const ended = async (end: RunEnd): Promise<Decision> => {
      if (!(await endRun(tx, run, from, end))) return { kind: 'none' };
      if (end.status !== 'superseded') await decorateRun(tx, run, this.deps.logger);
      return { kind: 'ended', end };
    };
    // A job that died left its run running (its lease expired, or it could not end the run): this
    // is its second try. What that job spent is on the run as far as it wrote it, and stays so.
    if (run.status === 'running') return ended({ status: 'failed', reason: 'internal' });
    if (run.status !== 'waiting') return { kind: 'none' };

    const [branch] = await tx
      .select({ name: branches.name, lastAnalysisId: branches.lastAnalysisId })
      .from(branches)
      .where(eq(branches.id, run.branchId));
    if (branch === undefined || branch.lastAnalysisId !== run.analysisId) {
      return ended({ status: 'superseded' });
    }
    const settings = await readLlmSettings(tx);
    const [project] = await tx
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        scmConnectionId: projects.scmConnectionId,
      })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    if (project === undefined) return { kind: 'none' };
    const active = reviewActive(settings, project);
    const provider = reviewProvider(settings);
    if (!active.active || provider === null) {
      const detail = active.active ? 'no_provider' : active.reason;
      return ended({ status: 'skipped', reason: 'inactive', detail });
    }

    const [snapshot] = await tx
      .select({
        id: reviewSnapshots.id,
        status: reviewSnapshots.status,
        error: reviewSnapshots.error,
        headSha: reviewSnapshots.headSha,
        sinceSha: reviewSnapshots.sinceSha,
        partial: reviewSnapshots.partial,
      })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.analysisId, run.analysisId));
    if (snapshot?.status === 'rejected') {
      // The code of the reason (`SNAPSHOT_INVALID`), never what follows it.
      const detail = (snapshot.error ?? '').split(':', 1)[0] || null;
      return ended({ status: 'skipped', reason: 'snapshot_rejected', detail });
    }
    if (snapshot?.status !== 'ready') {
      if (!due) {
        await queueAtDeadline(tx, run);
        return { kind: 'none' };
      }
      return ended({ status: 'skipped', reason: 'no_snapshot' });
    }

    const [started] = await tx
      .update(reviewRuns)
      .set({
        status: 'running',
        startedAt: sql`now()`,
        snapshotId: snapshot.id,
        headSha: snapshot.headSha,
        sinceSha: snapshot.sinceSha,
        snapshotPartial: snapshot.partial,
      })
      .where(and(eq(reviewRuns.id, run.id), eq(reviewRuns.status, 'waiting')))
      .returning();
    if (started === undefined) return { kind: 'none' };
    return {
      kind: 'started',
      running: {
        run: started,
        mergeRequestId: branch.name,
        settings,
        provider,
        organizationId: project.organizationId,
      },
    };
  }

  // ─── Steps 6 to 10: the review ──────────────────────────────────────────────

  private async reviewRunning(running: Running): Promise<void> {
    const { db } = this.deps;
    const { run, settings } = running;
    const state = await readMergeRequestState(
      { db, scm: this.deps.scm },
      run.projectId,
      running.mergeRequestId,
    );
    if (state !== null && state.state !== 'open') {
      // R16: a merge request that is merged or closed keeps no copy of its repository.
      await deleteBranchSnapshots(db, run.branchId);
      return this.endRunning(run, { status: 'skipped', reason: 'closed' });
    }
    if (state?.draft === true) return this.endRunning(run, { status: 'skipped', reason: 'draft' });

    const opened = run.snapshotId === null ? null : await openSnapshotReader(db, run.snapshotId);
    if (opened === null) {
      // Deleted since it was found ready: a newer push, or the snapshot's retention.
      return this.endRunning(run, { status: 'skipped', reason: 'no_snapshot' });
    }
    const { reader, release } = changesReadOnce(opened);
    const controller = new AbortController();
    const masker = new Masker({ signal: controller.signal });
    try {
      const files = new MaskedFiles(reader, { masker });
      const policy: ToolPolicy = {
        excludePaths: settings.excludePaths,
        budget: {
          calls: TOOL_LIMITS.callsPerReview,
          greps: TOOL_LIMITS.grepsPerReview,
          maskedBytes: TOOL_LIMITS.maskedBytesPerReview,
        },
        masked: files,
        masker,
      };
      const budget = await this.tokensLeft(running);
      let built: ContextOutcome;
      try {
        built = await this.contextOf(running, { files, masker, policy, budget });
      } finally {
        // The patches were read for the context and the digest: nothing else reads them.
        release();
      }
      if (built.kind === 'skipped') {
        return await this.endRunning(
          run,
          { status: 'skipped', reason: built.reason },
          { diffDigest: built.digest },
        );
      }
      const { context } = built;

      const key = providerApiKey(settings, this.deps.config.secretKey);
      if (!key.ok || settings.provider === null) {
        // The key no longer decrypts (QUALOR_SECRET_KEY changed): no call could be made.
        return await this.endRunning(run, { status: 'failed', reason: 'provider_error' });
      }
      this.provider = {
        host: new URL(settings.provider.baseUrl).host,
        model: settings.provider.model,
        pricing: settings.pricing,
      };
      const shouldStop = this.stopCheck(running, controller);
      const outcome = await runReviewPipeline(
        context,
        budget,
        {
          converse: (role, user, nonce, tokenBudget, accept) =>
            this.converse(
              { running, reader, policy, context, shouldStop },
              { role, user, nonce, tokenBudget, accept },
            ),
          providerKey: key.key,
        },
        (phase) => this.phase(phase),
      );
      await this.finish(running, outcome, { context, files, masker, policy, shouldStop });
    } finally {
      await masker.close();
    }
  }

  /**
   * Steps 7 to 9 and the review's context. They are decided when the context asks for its limits,
   * once it knows the reviewed changes and before it masks anything: none (`empty_diff`), the same
   * diff as the branch's last review that was done (`unchanged`), or a budget too small for the
   * smallest share of the review (`budget_spent`). The digest is written on the run either way.
   */
  private async contextOf(
    running: Running,
    o: { files: MaskedFiles; masker: Masker; policy: ToolPolicy; budget: number },
  ): Promise<ContextOutcome> {
    const { db } = this.deps;
    const { run, settings } = running;
    const { budget } = o;
    const previous = await lastReviewedDigest(db, run.branchId, run.id);
    const changes = await o.files.reader.changes();
    const seen: { digest: string | null } = { digest: null };
    const limits = (shape: ContextShape): ContextLimits => {
      if (shape.reviewed.length === 0) throw new SkipReview('empty_diff');
      seen.digest = diffDigest(changes, shape.reviewed);
      if (seen.digest === previous) throw new SkipReview('unchanged');
      if (budget <= 0 || !reviewFits(shape, budget)) throw new SkipReview('budget_spent');
      return reviewLimits(shape, budget);
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
      return { kind: 'skipped', reason: err.reason, digest: seen.digest };
    }
    await db.update(reviewRuns).set({ diffDigest: seen.digest }).where(eq(reviewRuns.id, run.id));
    return { kind: 'built', context };
  }

  /** What the review may spend: the smallest of its own ceiling and what the day has left (C2). */
  private async tokensLeft(running: Running): Promise<number> {
    const { db } = this.deps;
    const { organizationId, run, settings } = running;
    const [organization, project] = await Promise.all([
      reviewUsageToday(db, organizationId),
      reviewUsageToday(db, organizationId, run.projectId),
    ]);
    return remainingReviewTokens(
      effectiveReviewBudgets(settings, organizationId),
      { organization, project },
      settings.pricing,
    );
  }

  /**
   * Asked before every call to the provider, and once more after the last: the run was superseded
   * (or its analysis is no longer the newest), or review is no longer on for the project, or the
   * provider is no longer the one the run started with (R10), or the run's snapshot is gone (the
   * merge request was merged or closed, which deletes its snapshots, R16; the run's reference to
   * it is then null). What the run reads of a snapshot that is gone is nothing, and an outcome
   * built on that is not stored. The masker's signal is aborted with the stop.
   */
  private stopCheck(running: Running, controller: AbortController): () => Promise<boolean> {
    const { db } = this.deps;
    const { run, provider } = running;
    return async () => {
      if (this.stop !== null) return true;
      const [now] = await db
        .select({
          status: reviewRuns.status,
          snapshotId: reviewRuns.snapshotId,
          newest: branches.lastAnalysisId,
        })
        .from(reviewRuns)
        .innerJoin(branches, eq(branches.id, reviewRuns.branchId))
        .where(eq(reviewRuns.id, run.id));
      if (now?.status !== 'running' || now.newest !== run.analysisId) {
        this.stop = { kind: 'superseded' };
      } else {
        const settings = await readLlmSettings(db);
        const [project] = await db
          .select({
            id: projects.id,
            organizationId: projects.organizationId,
            scmConnectionId: projects.scmConnectionId,
          })
          .from(projects)
          .where(eq(projects.id, run.projectId));
        const active = project === undefined ? null : reviewActive(settings, project);
        if (active === null || !active.active) {
          this.stop = { kind: 'inactive', detail: active?.reason ?? 'project_deleted' };
        } else if (!sameProvider(reviewProvider(settings), provider)) {
          this.stop = { kind: 'inactive', detail: 'provider_changed' };
        } else if (now.snapshotId === null) {
          this.stop = { kind: 'snapshot_deleted' };
        }
      }
      if (this.stop !== null) controller.abort();
      return this.stop !== null;
    };
  }

  /**
   * One conversation of the pipeline: its own redaction tally (the context's replacements go with
   * the first message of a reviewer or the judge, each tool answer's with the call after it), the
   * role's output limit, and every call through the sender that records it.
   */
  private async converse(
    ctx: {
      running: Running;
      reader: SnapshotReader;
      policy: ToolPolicy;
      context: ReviewContext;
      shouldStop: () => Promise<boolean>;
    },
    call: {
      role: ReviewRole;
      user: string;
      nonce: string;
      tokenBudget: number;
      accept: (text: string) => boolean;
    },
  ): Promise<ConversationResult> {
    const { running, reader, policy, context, shouldStop } = ctx;
    const tally = new RedactionTally();
    if (call.role !== 'verify') tally.add(context.redactions);
    const sender = reviewSender({
      db: this.deps.db,
      runtime: { circuit: this.deps.llmCircuit },
      config: this.deps.config,
      settings: running.settings,
      run: running.run,
      promptVersion: REVIEW_PROMPT_VERSION,
      redactions: tally,
      logger: this.deps.logger,
    });
    const result = await runConversation({
      system: SYSTEM_PROMPTS[call.role],
      user: call.user,
      nonce: call.nonce,
      tools: REVIEW_TOOLS,
      runTool: async (toolCall) => {
        const answer = await runReviewTool(reader, toolCall, policy);
        tally.add(answer.redactions);
        return answer.text;
      },
      limits: {
        maxTurns: CONVERSATION_LIMITS.maxTurns,
        maxCallsPerTurn: CONVERSATION_LIMITS.maxCallsPerTurn,
        tokenBudget: call.tokenBudget,
        maxOutputTokens: REVIEW_OUTPUT_TOKENS[call.role],
      },
      send: (conversation) => this.counted(sender, conversation),
      shouldStop,
      accept: call.accept,
    });
    // Whichever way it ended, what it spent is the run's.
    this.inputTokens += result.inputTokens;
    this.outputTokens += result.outputTokens;
    this.toolCalls += result.toolCalls;
    return result;
  }

  /**
   * One call through the sender, counted: a call the provider answered, with its estimated cost,
   * and one that failed (the sender recorded it; the key was read before the review began, so
   * every failure it throws as the provider's is a call that was made).
   */
  private async counted(
    sender: (conversation: LlmConversation) => Promise<LlmTurn>,
    conversation: LlmConversation,
  ): Promise<LlmTurn> {
    try {
      const turn = await sender(conversation);
      this.calls += 1;
      this.cost += costOf(this.provider?.pricing ?? null, turn.usage) ?? 0;
      return turn;
    } catch (err) {
      if (err instanceof LlmError) this.calls += 1;
      throw err;
    }
  }

  /** The pipeline starts a phase: written on the run while it reviews. */
  private async phase(phase: ReviewPhase): Promise<void> {
    await this.deps.db
      .update(reviewRuns)
      .set({ phase })
      .where(
        and(
          eq(reviewRuns.id, this.runId),
          eq(reviewRuns.status, 'running'),
          sql`${reviewRuns.phase} IS DISTINCT FROM 'storing'`,
        ),
      );
  }

  /**
   * The pipeline's outcome. A review is stored once the run is `storing`, which a guarded update
   * makes it, and only a run still running and not storing passes: from then on no newer analysis
   * supersedes it. The values are made before the transaction (masking takes time), which only
   * writes; the store refuses a run no longer storing, under its lock.
   */
  private async finish(
    running: Running,
    outcome: PipelineOutcome,
    o: {
      context: ReviewContext;
      files: MaskedFiles;
      masker: Masker;
      policy: ToolPolicy;
      shouldStop: () => Promise<boolean>;
    },
  ): Promise<void> {
    const { db } = this.deps;
    const { run } = running;
    if (outcome.kind === 'failed') {
      return this.endRunning(run, { status: 'failed', reason: outcome.reason });
    }
    // Asked once more after the last call: nothing is stored for a run that should have stopped.
    if (outcome.kind === 'stopped' || (await o.shouldStop())) return this.stopped(run);
    const [storing] = await db
      .update(reviewRuns)
      .set({ phase: 'storing' })
      .where(
        and(
          eq(reviewRuns.id, run.id),
          eq(reviewRuns.status, 'running'),
          sql`${reviewRuns.phase} IS DISTINCT FROM 'storing'`,
        ),
      )
      .returning();
    if (storing === undefined) return this.stopped(run);
    const ruleIds = await ensureAiRules(db);
    const prepared = await prepareReviewOutcome(o.context, outcome, {
      files: o.files,
      masker: o.masker,
      budget: o.policy.budget,
    });
    try {
      // One step with its decoration, the branch's decoration lock first (run-ends.ts).
      await db.transaction(async (tx) => {
        await lockBranchQueue(tx, run.branchId);
        await storeReviewOutcome(tx, storing, prepared, ruleIds);
        await tx.update(reviewRuns).set(this.spend()).where(eq(reviewRuns.id, run.id));
        await decorateRun(tx, run, this.deps.logger);
      });
    } catch (err) {
      if (!(err instanceof ReviewNotStoringError)) throw err;
      // Ended meanwhile by a job tried again after this one's lease expired: that one decorated.
      await this.writeSpend();
      return;
    }
    this.deps.logger.info(
      { runId: run.id, status: 'done', findings: prepared.created.length },
      'AI review run ended',
    );
  }

  /**
   * The pipeline stopped: the run was superseded, review was switched off meanwhile, or its
   * snapshot was deleted.
   */
  private async stopped(run: ReviewRunRow): Promise<void> {
    if (this.stop?.kind === 'inactive') {
      return this.endRunning(run, {
        status: 'skipped',
        reason: 'inactive',
        detail: this.stop.detail,
      });
    }
    if (this.stop?.kind === 'snapshot_deleted') {
      return this.endRunning(run, {
        status: 'skipped',
        reason: 'closed',
        detail: 'snapshot_deleted',
      });
    }
    // Superseded by a newer analysis (already ended), or its analysis is no longer the newest.
    return this.endRunning(run, { status: 'superseded' });
  }

  // ─── Ends (run-ends.ts) ─────────────────────────────────────────────────────

  /** What the run spent: where its calls went, how many, their tokens and their estimated cost. */
  private spend(): RunSpend {
    return {
      providerHost: this.provider?.host ?? null,
      model: this.provider?.model ?? null,
      modelCalls: this.calls,
      toolCalls: this.toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costMicroUsd: this.provider === null || this.provider.pricing === null ? null : this.cost,
    };
  }

  /** The spend of a run another job or a newer analysis ended: it was spent all the same. */
  private async writeSpend(): Promise<void> {
    if (this.calls === 0) return;
    await writeRunSpend(this.deps.db, this.runId, this.spend());
  }

  /**
   * Ends the running run with what it spent, and queues its decoration unless it was superseded,
   * in one transaction. A run that something else ended meanwhile keeps that end, with this
   * job's spend written on it.
   */
  private async endRunning(
    run: RunRef,
    end: RunEnd,
    extra: { diffDigest?: string | null } = {},
  ): Promise<void> {
    const ended = await endAndDecorate(
      this.deps.db,
      run,
      ['running'],
      end,
      { ...extra, spend: this.spend() },
      this.deps.logger,
    );
    if (!ended) await this.writeSpend();
  }
}

/**
 * The `ai-review` queue's handler (R21): main.ts runs it on a worker of its own, with the `llm`
 * worker's circuit. A payload that does not parse never will: the job completes. A review's job
 * fails into its retry only for an error before its run started, which left the run as it was, and
 * never on its last try; once the run is running, an error ends it `failed: internal` and the job
 * completes, so a review is never run twice.
 */
export function reviewHandlers(deps: ReviewJobDeps): JobHandlers {
  return {
    [AI_REVIEW_QUEUE]: async (job) => {
      const parsed = payloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        deps.logger.warn(
          { jobId: job.id, queue: job.queue },
          'malformed AI review job payload; completing without retry',
        );
        return;
      }
      await new ReviewJob(deps, parsed.data.runId, job.attempts >= job.maxAttempts).run();
    },
  };
}
