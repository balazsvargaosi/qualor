import type { IngestionStage } from '../ingest/process';
import { readLlmSettings } from '../llm/settings';
import { lockBranchQueue } from '../scm/queue';
import { createReviewRun } from './runs';
import { reviewActive } from './settings';
import { linkSnapshot, unpackDueNow } from './snapshot-store';

/**
 * 6I-2 and 6I-3, after `scm` and before `webhooks`. A merge request keeps the review snapshot of its
 * newest analysis only: the analysis being ingested becomes its branch's newest when the ingestion
 * commits, so the branch's other snapshots are deleted (the copies of older heads). Its own
 * snapshot is unpacked after the ingestion, whose SCM context it is checked against (R22): the
 * unpack that waits for it is made due now, and its job links the snapshot and wakes the run. Then,
 * for a merge request analysis of a project with AI review on, the review run is created (it
 * supersedes the branch's older runs and waits for the snapshot, R15). The analyzer decoration,
 * queued by `scm` before it, never waits for the review. It writes no analysis column.
 *
 * The branch's decoration lock comes first, whether or not `scm` queued a decoration: then its
 * snapshots and its runs, the order in which a review run's job takes them too (run-ends.ts).
 */
export const reviewSnapshotStage: IngestionStage = {
  name: 'review-snapshot',
  async run(ctx) {
    if (ctx.branch.kind === 'merge_request') await lockBranchQueue(ctx.tx, ctx.branch.id);
    await linkSnapshot(ctx.tx, ctx.analysisId, ctx.branch);
    await unpackDueNow(ctx.tx, ctx.analysisId);
    if (ctx.branch.kind !== 'merge_request') return;
    if (!reviewActive(await readLlmSettings(ctx.tx), ctx.project).active) return;
    await createReviewRun(ctx.tx, {
      analysisId: ctx.analysisId,
      projectId: ctx.project.id,
      branchId: ctx.branch.id,
    });
  },
};
