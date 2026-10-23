import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { reviewSnapshots } from '../db/schema';
import type { JobHandlers } from '../queue/worker';
import { REVIEW_SNAPSHOT_QUEUE, unpackSnapshot, type SnapshotLimits } from './snapshot-store';

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn'>;

const payloadSchema = z.object({
  snapshotId: z.uuid(),
  /** How often the unpack waited already for its analysis to be ingested (6I-3). */
  deferrals: z.number().int().min(0).optional(),
});

/**
 * The queue that unpacks the uploaded review snapshots (6I-2); main.ts runs it on the analysis
 * worker. Unpacking never throws for what the scanner sent: a snapshot it refuses is `rejected`,
 * with the reason logged (it never holds the snapshot's content). One whose analysis is not
 * ingested yet waits: another job comes later, and this one completes (it spends no try).
 */
export function reviewSnapshotHandlers(deps: {
  db: Db;
  logger: Logger;
  limits: SnapshotLimits;
}): JobHandlers {
  return {
    [REVIEW_SNAPSHOT_QUEUE]: async (job) => {
      // A payload that does not parse never will: complete the job instead of retrying it.
      const parsed = payloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        deps.logger.warn(
          { jobId: job.id, queue: job.queue },
          'malformed review snapshot job payload; completing without retry',
        );
        return;
      }
      const { snapshotId, deferrals = 0 } = parsed.data;
      const outcome = await unpackSnapshot(deps.db, snapshotId, deps.limits, { deferrals });
      if (outcome === 'deferred') {
        deps.logger.info(
          { snapshotId, deferrals: deferrals + 1 },
          'review snapshot waits for its analysis to be ingested',
        );
      } else if (outcome === 'rejected') {
        const [row] = await deps.db
          .select({ error: reviewSnapshots.error })
          .from(reviewSnapshots)
          .where(eq(reviewSnapshots.id, snapshotId));
        deps.logger.warn({ snapshotId, error: row?.error ?? null }, 'review snapshot rejected');
      } else if (outcome === 'ready') {
        deps.logger.info({ snapshotId }, 'review snapshot unpacked');
      } else {
        deps.logger.info({ snapshotId }, 'review snapshot no longer stored; nothing to unpack');
      }
    },
  };
}
