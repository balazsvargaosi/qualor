import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidList } from '../db/bulk';
import type { Db, Executor } from '../db/client';
import { LOCKS } from '../db/locks';
import { analyses, branches, jobs, projects, reviewSnapshots } from '../db/schema';
import { readLlmSettings } from '../llm/settings';
import { enqueue } from '../queue/queue';
import type { JobHandlers } from '../queue/worker';
import type { DecorationDeps } from '../scm/decorate';
import { readMergeRequestState } from '../scm/mr-state';
import { inSeconds } from '../scm/queue';
import { reviewActive } from './settings';

/*
 * How long the copies of a merge request's repository live (6I-3, R11, R16, R17). A snapshot is
 * kept for the newest analysis of an open merge request only (snapshot-store.ts links it), and
 * goes when Qualor sees the merge request merged or closed: in its decoration, in its review, and
 * in the hourly check below, which covers a merge request nobody pushes to or decorates any more.
 * It goes too when the project is no longer reviewed (switched off, left out of the selection,
 * excluded from the AI assistant, unmapped, no provider, a consent that is out of date): the
 * purge, queued after every settings write, after a project is unmapped or its connection deleted,
 * and run daily by housekeeping.
 */

/** The queue of the hourly check of a merge request that holds snapshots (the `scm` worker's). */
export const REVIEW_MR_STATE_QUEUE = 'review-mr-state';
/** How long a check waits before it looks at its merge request again: an hour. */
export const MR_STATE_CHECK_SECONDS = 3600;

/** One check at a time per merge request. */
const checkKey = (branchId: string): string => `review-mr-state:branch:${branchId}`;

const checkPayload = z.object({ branchId: z.uuid() });

/** The snapshots of the merge request branch `branchId`: its linked one and each analysis' own. */
export function ofBranch(db: Executor, branchId: string) {
  return or(
    eq(reviewSnapshots.branchId, branchId),
    inArray(
      reviewSnapshots.analysisId,
      db.select({ id: analyses.id }).from(analyses).where(eq(analyses.branchId, branchId)),
    ),
  );
}

/**
 * Deletes every snapshot of the merge request branch `branchId`: the one linked to it and the
 * snapshot of any of its analyses, unpacked or not (the scanner may have uploaded one that no job
 * has unpacked yet). The files of a snapshot go with it; a run that read one keeps its row, without
 * the snapshot. Answers how many were deleted.
 */
export async function deleteBranchSnapshots(db: Executor, branchId: string): Promise<number> {
  const deleted = await db
    .delete(reviewSnapshots)
    .where(ofBranch(db, branchId))
    .returning({ id: reviewSnapshots.id });
  return deleted.length;
}

/** Whether the branch holds a copy of its repository; a refused snapshot keeps only its reason. */
async function holdsSnapshot(db: Executor, branchId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reviewSnapshots.id })
    .from(reviewSnapshots)
    .where(and(ofBranch(db, branchId), ne(reviewSnapshots.status, 'rejected')))
    .limit(1);
  return row !== undefined;
}

// ─── The hourly check ────────────────────────────────────────────────────────

/**
 * The merge request `branchId` holds a snapshot: unless a check of it is queued already, one is
 * queued an hour from now. `tx` is a transaction: the look and the insert are one step for the
 * branch (a lock held to its end), so a snapshot linked while a check ends, or two linked at once,
 * never queue two.
 */
export async function scheduleMergeRequestCheck(tx: Executor, branchId: string): Promise<void> {
  const key = checkKey(branchId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${LOCKS.reviewMrCheck}, hashtext(${branchId}))`,
  );
  const [queued] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.queue, REVIEW_MR_STATE_QUEUE),
        eq(jobs.concurrencyKey, key),
        eq(jobs.status, 'queued'),
      ),
    )
    .limit(1);
  if (queued !== undefined) return;
  await enqueue(tx, {
    queue: REVIEW_MR_STATE_QUEUE,
    payload: { branchId },
    concurrencyKey: key,
    runAt: inSeconds(MR_STATE_CHECK_SECONDS),
  });
}

/**
 * One check: what the merge request is now, according to its provider. Merged or closed, its
 * snapshots are deleted and the check is over. Open, or no answer (the provider failed or refused,
 * the organisation's slots are taken, the connection's circuit is open, the project is not mapped),
 * the next check is an hour on: the job never waits for anything, and a lookup that fails costs
 * only that hour. A branch without a snapshot (retention or the purge got it, a newer push
 * replaced it) needs none, and a branch that is gone cannot be asked about.
 */
async function checkMergeRequest(
  deps: Pick<DecorationDeps, 'db' | 'scm' | 'runtime' | 'logger'>,
  branchId: string,
): Promise<void> {
  const { db } = deps;
  const [branch] = await db
    .select({ kind: branches.kind, name: branches.name, projectId: branches.projectId })
    .from(branches)
    .where(eq(branches.id, branchId));
  if (branch?.kind !== 'merge_request' || !(await holdsSnapshot(db, branchId))) return;
  const state = await readMergeRequestState(
    { db, scm: deps.scm, runtime: deps.runtime },
    branch.projectId,
    branch.name,
  );
  if (state !== null && state.state !== 'open') {
    const deleted = await deleteBranchSnapshots(db, branchId);
    deps.logger?.info(
      { branchId, state: state.state, deleted },
      'review snapshots of a merge request that is no longer open deleted',
    );
    return;
  }
  await db.transaction((tx) => scheduleMergeRequestCheck(tx, branchId));
}

/**
 * The `scm` worker's handler of the hourly check (scm/decorate.ts `scmHandlers`), run with the
 * decorations' runtime: their circuit, their slots of an organisation, their GitHub tokens. A
 * payload that does not parse never will, so the job completes.
 */
export function mergeRequestStateHandlers(
  deps: Pick<DecorationDeps, 'db' | 'scm' | 'runtime' | 'logger'>,
): JobHandlers {
  return {
    [REVIEW_MR_STATE_QUEUE]: async (job) => {
      const parsed = checkPayload.safeParse(job.payload);
      if (!parsed.success) {
        deps.logger?.warn(
          { jobId: job.id },
          'malformed merge request state check payload; completing',
        );
        return;
      }
      await checkMergeRequest(deps, parsed.data.branchId);
    },
  };
}

// ─── The purge ───────────────────────────────────────────────────────────────

/** Snapshots per statement, so that no statement holds the rows (and the files) of a whole project. */
const PURGE_BATCH = 50;

/**
 * Deletes the snapshots of the projects for which AI review does not run (`reviewActive` is
 * false), of `organizationId`'s projects or, with null, of all. The settings are read now, so a
 * purge queued by a write sees that write and any since. Rows go in batches of 50, each statement
 * its own short transaction, skipping any row another transaction holds (`FOR UPDATE SKIP LOCKED`:
 * a job that reads or unpacks it): the next purge takes those. Answers how many were deleted.
 */
export async function purgeInactiveSnapshots(
  db: Db,
  organizationId: string | null,
): Promise<number> {
  const settings = await readLlmSettings(db);
  const holders = await db
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      scmConnectionId: projects.scmConnectionId,
    })
    .from(projects)
    .where(
      and(
        organizationId === null ? undefined : eq(projects.organizationId, organizationId),
        sql`EXISTS (SELECT 1 FROM ${reviewSnapshots} WHERE ${reviewSnapshots.projectId} = ${projects.id})`,
      ),
    );
  const inactive = holders
    .filter((project) => !reviewActive(settings, project).active)
    .map((project) => project.id);
  if (inactive.length === 0) return 0;
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM review_snapshots WHERE id IN (
        SELECT id FROM review_snapshots
         WHERE project_id IN ${uuidList(inactive)}
         LIMIT ${PURGE_BATCH}
         FOR UPDATE SKIP LOCKED)`);
    const n = result.rowCount ?? 0;
    deleted += n;
    if (n < PURGE_BATCH) return deleted;
  }
}

/**
 * Deletes the snapshots of one project made before `createdBefore`: it was mapped to another
 * repository or connection, and the copies of the old one must go at once. Same batches and row
 * skipping as `purgeInactiveSnapshots`. The project is still active, so no later sweep would take
 * a row that was skipped because a job held it: when any matching row is left, this throws and the
 * job queue retries it with its backoff. Answers how many were deleted.
 */
export async function purgeProjectSnapshots(
  db: Db,
  projectId: string,
  createdBefore: Date,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM review_snapshots WHERE id IN (
        SELECT id FROM review_snapshots
         WHERE project_id = ${projectId} AND created_at < ${createdBefore.toISOString()}::timestamptz
         LIMIT ${PURGE_BATCH}
         FOR UPDATE SKIP LOCKED)`);
    const n = result.rowCount ?? 0;
    deleted += n;
    if (n < PURGE_BATCH) break;
  }
  const left = await db.execute(sql`
    SELECT 1 FROM review_snapshots
     WHERE project_id = ${projectId} AND created_at < ${createdBefore.toISOString()}::timestamptz
     LIMIT 1`);
  if ((left.rowCount ?? 0) > 0) {
    throw new Error('old review snapshots of a remapped project are locked; retrying');
  }
  return deleted;
}
