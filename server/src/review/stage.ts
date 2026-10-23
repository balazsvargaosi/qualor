import { eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { reviewSnapshots } from '../db/schema';
import type { IngestionStage } from '../ingest/process';
import { readLlmSettings } from '../llm/settings';
import { createReviewRun, wakeReviewRun } from './runs';
import { reviewActive } from './settings';
import { linkSnapshot } from './snapshot-store';

/**
 * Whether the analysis' snapshot is settled for its run: unpacked and linked to the branch, or
 * refused. Either way the run need not wait for its deadline.
 */
async function snapshotSettled(db: Executor, analysisId: string, branchId: string) {
  const [snapshot] = await db
    .select({ status: reviewSnapshots.status, branchId: reviewSnapshots.branchId })
    .from(reviewSnapshots)
    .where(eq(reviewSnapshots.analysisId, analysisId));
  return (
    snapshot?.status === 'rejected' ||
    (snapshot?.status === 'ready' && snapshot.branchId === branchId)
  );
}

/**
 * 6I-2 and 6I-3, after `scm` and before `webhooks`. A merge request keeps the review snapshot of its
 * newest analysis only. The analysis being ingested becomes its branch's newest when the ingestion
 * commits, so its snapshot, when already unpacked, is linked to the branch, and the branch's other
 * snapshots are deleted (the copies of older heads). A snapshot unpacked later is linked by its
 * job. Then, for a merge request analysis of a project with AI review on, the review run is created
 * (it supersedes the branch's older runs and waits for the snapshot, R15), and woken at once when
 * the snapshot is linked or refused already. The analyzer decoration, queued by `scm` before it,
 * never waits for the review. It writes no analysis column.
 */
export const reviewSnapshotStage: IngestionStage = {
  name: 'review-snapshot',
  async run(ctx) {
    await linkSnapshot(ctx.tx, ctx.analysisId, ctx.branch);
    if (ctx.branch.kind !== 'merge_request') return;
    if (!reviewActive(await readLlmSettings(ctx.tx), ctx.project).active) return;
    await createReviewRun(ctx.tx, {
      analysisId: ctx.analysisId,
      projectId: ctx.project.id,
      branchId: ctx.branch.id,
    });
    if (await snapshotSettled(ctx.tx, ctx.analysisId, ctx.branch.id)) {
      await wakeReviewRun(ctx.tx, ctx.analysisId);
    }
  },
};
