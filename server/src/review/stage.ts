import type { IngestionStage } from '../ingest/process';
import { linkSnapshot } from './snapshot-store';

/**
 * 6I-2, after `scm` and before `webhooks`: a merge request keeps the review snapshot of its newest
 * analysis only. The analysis being ingested becomes its branch's newest when the ingestion
 * commits, so its snapshot, when already unpacked, is linked to the branch, and the branch's other
 * snapshots are deleted (the copies of older heads). A snapshot unpacked later is linked by its
 * job. It writes no analysis column.
 */
export const reviewSnapshotStage: IngestionStage = {
  name: 'review-snapshot',
  async run(ctx) {
    await linkSnapshot(ctx.tx, ctx.analysisId, ctx.branch);
  },
};
