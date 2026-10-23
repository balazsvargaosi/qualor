import { and, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Executor, Tx } from '../db/client';
import { uuidv7 } from '../db/ids';
import { branches, jobs, reviewRuns } from '../db/schema';
import { enqueue } from '../queue/queue';

/*
 * The life of a review run (6I-3, R15). The ingestion stage creates one for each merge request
 * analysis of a project that has AI review on: `waiting` for the scanner's snapshot, with a job of
 * the `ai-review` queue at its deadline, 15 minutes on. A snapshot linked for it, or refused, wakes
 * it: its job is due at once. The job decides the rest (job.ts). A newer analysis of the merge
 * request supersedes an older run, unless that run is storing its results already. A run that
 * ended for want of a snapshot waits again when one comes after all, while its analysis is still
 * the branch's newest.
 *
 * A branch's jobs run one at a time (their concurrency key), in the order they were queued, so a
 * newer run reads the findings of an older one only once that one has stored them. A job queued
 * for later holds back the ones queued after it: a run that is superseded takes its queued job with
 * it.
 *
 * A wake updates the run's row only while it is `waiting`, and the job decides while it holds that
 * row (job.ts), so a snapshot linked while the job looks is never missed: either the job sees it, or
 * the wake comes after and makes the job it queued due. The run's row is taken after the analysis,
 * the branch and the snapshots, as ingestion and the snapshot's link take them.
 */

export const AI_REVIEW_QUEUE = 'ai-review';
/** How long a run waits for its snapshot (R15). */
export const REVIEW_SNAPSHOT_WAIT_SECONDS = 900;
/**
 * A run's job is tried twice at most: the second try is for a lease that expired, and it finds the
 * run running and ends it failed, so a review is never run twice into more spend.
 */
export const AI_REVIEW_MAX_ATTEMPTS = 2;

/** The jobs of one merge request's runs run one at a time, in the order they were queued. */
export function reviewRunKey(branchId: string): string {
  return `ai-review:branch:${branchId}`;
}

/** The deadline of a run that starts to wait now, on the database clock. */
const deadlineFromNow = (): SQL =>
  sql`now() + make_interval(secs => ${REVIEW_SNAPSHOT_WAIT_SECONDS})`;

type RunRef = { id: string; branchId: string };

/** Queues the run's job, at `runAt` (now when left out). */
async function queueJob(db: Executor, run: RunRef, runAt?: SQL): Promise<void> {
  await enqueue(db, {
    queue: AI_REVIEW_QUEUE,
    payload: { runId: run.id },
    concurrencyKey: reviewRunKey(run.branchId),
    maxAttempts: AI_REVIEW_MAX_ATTEMPTS,
    ...(runAt === undefined ? {} : { runAt }),
  });
}

/** The queued jobs of `runIds`. */
const queuedJobsOf = (runIds: readonly string[]): SQL | undefined =>
  and(
    eq(jobs.queue, AI_REVIEW_QUEUE),
    eq(jobs.status, 'queued'),
    inArray(sql`${jobs.payload} ->> 'runId'`, [...runIds]),
  );

/**
 * The run of a merge request analysis, `waiting` for its snapshot, and its job at the deadline,
 * 15 minutes from now; the branch's older runs are superseded first. Called by the ingestion stage
 * in the ingestion's transaction. Answers the run's id.
 */
export async function createReviewRun(
  tx: Tx,
  input: { analysisId: string; projectId: string; branchId: string },
): Promise<string> {
  const id = uuidv7();
  await supersedeRuns(tx, input.branchId, id);
  // The deadline and the job's time are the same instant: one expression in one transaction.
  await tx.insert(reviewRuns).values({
    id,
    projectId: input.projectId,
    branchId: input.branchId,
    analysisId: input.analysisId,
    status: 'waiting',
    deadlineAt: deadlineFromNow(),
  });
  await queueJob(tx, { id, branchId: input.branchId }, deadlineFromNow());
  return id;
}

/**
 * Supersedes the branch's runs but `exceptRunId` that a newer analysis replaces: the ones waiting,
 * and the ones reviewing in any phase but `storing` (a run that stores its results already is let
 * finish). They end at once, and their queued jobs are deleted. A superseded run spends no more
 * tokens and stores nothing: its job stops at its next call to the provider. Answers how many.
 */
export async function supersedeRuns(
  tx: Tx,
  branchId: string,
  exceptRunId: string,
): Promise<number> {
  const ended = await tx
    .update(reviewRuns)
    .set({ status: 'superseded', phase: null, reason: null, finishedAt: sql`now()` })
    .where(
      and(
        eq(reviewRuns.branchId, branchId),
        ne(reviewRuns.id, exceptRunId),
        or(
          eq(reviewRuns.status, 'waiting'),
          and(
            eq(reviewRuns.status, 'running'),
            sql`${reviewRuns.phase} IS DISTINCT FROM 'storing'`,
          ),
        ),
      ),
    )
    .returning({ id: reviewRuns.id });
  if (ended.length > 0) await tx.delete(jobs).where(queuedJobsOf(ended.map((run) => run.id)));
  return ended.length;
}

/**
 * The run's job is due now: the job queued for it is moved to now, or, when it has none queued (its
 * job is running, deciding), one more is queued, which finds out what that one decided.
 */
async function dueNow(tx: Executor, run: RunRef): Promise<void> {
  const moved = await tx
    .update(jobs)
    .set({ runAt: sql`now()` })
    .where(queuedJobsOf([run.id]))
    .returning({ id: jobs.id });
  if (moved.length === 0) await queueJob(tx, run);
}

/**
 * The analysis' snapshot has been linked or refused: its run is decided now rather than at its
 * deadline. A `waiting` run's job is due at once. A run that ended for want of a snapshot
 * (`skipped: no_snapshot`) waits again, with a new deadline and a job due at once, but only while
 * its analysis is the branch's newest: an older head's review would be stale. Anything else is left
 * as it is.
 */
export async function wakeReviewRun(tx: Executor, analysisId: string): Promise<void> {
  const [waiting] = await tx
    .update(reviewRuns)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(reviewRuns.analysisId, analysisId), eq(reviewRuns.status, 'waiting')))
    .returning({ id: reviewRuns.id, branchId: reviewRuns.branchId });
  if (waiting !== undefined) {
    await dueNow(tx, waiting);
    return;
  }
  const [restarted] = await tx
    .update(reviewRuns)
    .set({
      status: 'waiting',
      reason: null,
      detail: null,
      finishedAt: null,
      deadlineAt: deadlineFromNow(),
    })
    .where(
      and(
        eq(reviewRuns.analysisId, analysisId),
        eq(reviewRuns.status, 'skipped'),
        eq(reviewRuns.reason, 'no_snapshot'),
        sql`${reviewRuns.analysisId} = (SELECT ${branches.lastAnalysisId} FROM ${branches} WHERE ${branches.id} = ${reviewRuns.branchId})`,
      ),
    )
    .returning({ id: reviewRuns.id, branchId: reviewRuns.branchId });
  if (restarted !== undefined) await dueNow(tx, restarted);
}

/**
 * A waiting run whose job came early, before its snapshot: the job comes again at the run's
 * deadline. The time is read from the row, so that it is exactly the deadline.
 */
export async function queueAtDeadline(tx: Executor, run: RunRef): Promise<void> {
  await queueJob(
    tx,
    run,
    sql`(SELECT ${reviewRuns.deadlineAt} FROM ${reviewRuns} WHERE ${reviewRuns.id} = ${run.id})`,
  );
}

/**
 * The head commit the last review of the project's merge request `mergeRequestId` covered: the
 * `head_sha` of the newest run of its branch that is `done`. Null without one. What the scanner's
 * `since` ranges are counted from (R4, `GET /projects/review-context`).
 */
export async function lastReviewedCommit(
  db: Executor,
  projectId: string,
  mergeRequestId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ headSha: reviewRuns.headSha })
    .from(reviewRuns)
    .innerJoin(branches, eq(branches.id, reviewRuns.branchId))
    .where(
      and(
        eq(branches.projectId, projectId),
        eq(branches.kind, 'merge_request'),
        eq(branches.name, mergeRequestId),
        eq(reviewRuns.status, 'done'),
      ),
    )
    .orderBy(desc(reviewRuns.createdAt), desc(reviewRuns.id))
    .limit(1);
  return row?.headSha ?? null;
}

/** The digest of the reviewed diff of the branch's newest run that is done, but `exceptRunId`'s. */
export async function lastReviewedDigest(
  db: Executor,
  branchId: string,
  exceptRunId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ digest: reviewRuns.diffDigest })
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.branchId, branchId),
        eq(reviewRuns.status, 'done'),
        ne(reviewRuns.id, exceptRunId),
      ),
    )
    .orderBy(desc(reviewRuns.createdAt), desc(reviewRuns.id))
    .limit(1);
  return row?.digest ?? null;
}
