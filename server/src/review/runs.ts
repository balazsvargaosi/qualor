import { and, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Db, Executor, Tx } from '../db/client';
import { uuidv7 } from '../db/ids';
import { branches, jobs, reviewRuns } from '../db/schema';
import { enqueue } from '../queue/queue';
import type { WorkerLogger } from '../queue/worker';
import { tryLockBranchQueue } from '../scm/queue';
import { decorateRun, endRun, errorClass, type RunEnd } from './run-ends';

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
 * the branch, the branch's decoration lock and the snapshots, as ingestion and the snapshot's link
 * take them (the link takes no decoration lock: it ends no run).
 *
 * Every job queued for an existing run is queued by a transaction that holds the run's row (a
 * wake, the job's own decision, the sweep below); only the queue itself takes a job away, when its
 * tries are spent. A run with no job queued or running for it would wait or run for good: the sweep
 * after every reap ends it (reconcileStuckReviewRuns).
 */

export const AI_REVIEW_QUEUE = 'ai-review';
/** How long a run waits for its snapshot (R15). */
export const REVIEW_SNAPSHOT_WAIT_SECONDS = 900;
/**
 * A run's job is tried twice at most. The second try is for an error before the run started (the
 * first try's decision wrote nothing), or for a lease that expired: it finds the run running and
 * ends it failed, so a review is never run twice into more spend. An error on the last try ends
 * the run failed too (job.ts).
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
 * Whether a job of the run `runId` (an id, or the column of an outer query) is queued or running:
 * one will decide the run. Compared as text, so that a malformed payload never fails the query.
 */
const liveJobOf = (runId: SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM ${jobs}
               WHERE ${jobs.queue} = ${AI_REVIEW_QUEUE}
                 AND ${jobs.status} IN ('queued', 'running')
                 AND ${jobs.payload} ->> 'runId' = (${runId})::text)`;

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

/** How many runs one sweep looks at; the next sweep, 30 seconds on, takes the rest. */
const SWEEP_BATCH = 100;

/** What a sweep did: the runs it ended, and the waiting ones it queued a job for. */
export interface ReviewSweep {
  ended: number;
  queued: number;
}

type SweepLogger = Pick<WorkerLogger, 'info' | 'warn'>;

/**
 * One run of the sweep, in a transaction of its own: the branch's decoration lock, then the run's
 * row, then a look for its job once more (a job queued meanwhile, by a wake, is seen). It waits
 * for neither lock: a run whose branch or row another transaction holds (an ingestion, a job
 * deciding) is left to the next sweep, so the worker it runs on never stalls.
 */
async function reconcileRun(
  db: Db,
  candidate: { id: string; branchId: string },
  logger: SweepLogger,
): Promise<RunEnd | 'queued' | 'none'> {
  return db.transaction(async (tx) => {
    if (!(await tryLockBranchQueue(tx, candidate.branchId))) return 'none';
    const [locked] = await tx
      .select({ run: reviewRuns, due: sql<boolean>`${reviewRuns.deadlineAt} <= now()` })
      .from(reviewRuns)
      .where(
        and(eq(reviewRuns.id, candidate.id), inArray(reviewRuns.status, ['waiting', 'running'])),
      )
      .for('update', { skipLocked: true });
    if (locked === undefined) return 'none';
    // Under the run's lock, in a statement of its own: it sees a job queued until now.
    const live = await tx.execute<{ live: boolean }>(
      sql`SELECT ${liveJobOf(sql`${candidate.id}`)} AS live`,
    );
    if (live.rows[0]?.live === true) return 'none';
    const { run, due } = locked;
    if (run.status === 'waiting' && !due) {
      await queueAtDeadline(tx, run);
      return 'queued';
    }
    const end: RunEnd =
      run.status === 'running'
        ? { status: 'failed', reason: 'internal' }
        : { status: 'skipped', reason: 'no_snapshot' };
    // What the dead job spent is on the run as far as it wrote it, and stays so.
    if (!(await endRun(tx, run, [run.status], end))) return 'none';
    await decorateRun(tx, run, logger);
    return end;
  });
}

/**
 * The runs that wait or review with no `ai-review` job queued or running for them: their job is
 * gone for good (its lease expired on both tries, or its last try could not end the run either),
 * so nothing would ever end them and the merge request's summary would say the review is in
 * progress for good. After every reap of the review worker (main.ts, every 30 seconds), each is
 * ended here, never through a job: a running one `failed: internal`, a waiting one past its
 * deadline `skipped: no_snapshot`, and a waiting one before its deadline gets a job at the
 * deadline. Each end is decorated (run-ends.ts). Decided by whether a job is there, never by the
 * run's age: a long review keeps its job running, its lease extended by the worker. A run whose
 * transaction fails is said once (its id and the error's class) and left to the next sweep; the
 * runs after it are swept all the same.
 */
export async function reconcileStuckReviewRuns(db: Db, logger: SweepLogger): Promise<ReviewSweep> {
  const stuck = await db
    .select({ id: reviewRuns.id, branchId: reviewRuns.branchId })
    .from(reviewRuns)
    .where(
      and(
        inArray(reviewRuns.status, ['waiting', 'running']),
        sql`NOT ${liveJobOf(sql`${reviewRuns.id}`)}`,
      ),
    )
    .orderBy(reviewRuns.id)
    .limit(SWEEP_BATCH);
  const swept: ReviewSweep = { ended: 0, queued: 0 };
  for (const candidate of stuck) {
    let outcome: RunEnd | 'queued' | 'none';
    try {
      outcome = await reconcileRun(db, candidate, logger);
    } catch (err) {
      logger.warn(
        { runId: candidate.id, errorClass: errorClass(err) },
        'AI review run without its job could not be reconciled',
      );
      continue;
    }
    if (outcome === 'queued') {
      swept.queued += 1;
    } else if (outcome !== 'none') {
      swept.ended += 1;
      logger.warn(
        {
          runId: candidate.id,
          status: outcome.status,
          reason: outcome.status === 'superseded' ? null : outcome.reason,
        },
        'AI review run ended without its job',
      );
    }
  }
  return swept;
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
