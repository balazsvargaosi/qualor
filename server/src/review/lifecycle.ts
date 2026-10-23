import { eq, inArray, or } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { analyses, reviewSnapshots } from '../db/schema';

/*
 * How long the copies of a merge request's repository live (6I-3, R11, R16, R17). A snapshot is
 * kept for the newest analysis of an open merge request only (snapshot-store.ts links it), and
 * goes when Qualor sees the merge request merged or closed.
 */

/**
 * Deletes every snapshot of the merge request branch `branchId`: the one linked to it and the
 * snapshot of any of its analyses, unpacked or not (the scanner may have uploaded one that no job
 * has unpacked yet). The files of a snapshot go with it; a run that read one keeps its row, without
 * the snapshot. Answers how many were deleted.
 */
export async function deleteBranchSnapshots(db: Executor, branchId: string): Promise<number> {
  const deleted = await db
    .delete(reviewSnapshots)
    .where(
      or(
        eq(reviewSnapshots.branchId, branchId),
        inArray(
          reviewSnapshots.analysisId,
          db.select({ id: analyses.id }).from(analyses).where(eq(analyses.branchId, branchId)),
        ),
      ),
    )
    .returning({ id: reviewSnapshots.id });
  return deleted.length;
}
