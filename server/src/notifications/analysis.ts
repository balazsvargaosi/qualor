import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client';
import { LOCKS } from '../db/locks';
import { analyses, branches, projects, type BranchKind } from '../db/schema';
import { queueMail } from '../mail/outbox';
import { mailConfigured } from '../mail/settings';
import { renderAnalysisFailed } from '../mail/templates/notify-analysis-failed';
import type { NotifyDeps } from './deps';
import { watchLinks, withUnsubscribe } from './links';
import { watchersFor } from './recipients';

/** The branch a failed report named, when the failure came after the report was decoded. */
export interface BranchHint {
  name: string;
  kind: BranchKind;
  isMain: boolean;
}

/** mail E3 N7: a broken pipeline mails each watcher at most once per branch in this window. */
export const ANALYSIS_FAILED_DEDUPE_HOURS = 6;

/**
 * At most 200 characters (E1's `dedupe_key`, which `queueMail` clips): a long branch name is
 * replaced by its hash, or two long branch names would share one dedupe window.
 */
export function analysisFailedKey(projectId: string, branchName: string | null): string {
  const name =
    branchName === null
      ? '?'
      : branchName.length <= 100
        ? branchName
        : `#${createHash('sha256').update(branchName).digest('hex').slice(0, 32)}`;
  return `analysis.failed:${projectId}:${name}`;
}

/**
 * mail E3: after a `markFailed` that changed the row, in its own short transaction (the failure
 * paths have none). The branch comes from the analysis row, else from the report (`branchHint`),
 * else is unknown (then every scope matches). Never throws: a mail problem is logged, and the
 * analysis stays failed either way.
 */
export async function notifyAnalysisFailed(
  db: Db,
  deps: NotifyDeps,
  input: { analysisId: string; branchHint?: BranchHint | null },
  logger?: Pick<FastifyBaseLogger, 'warn'>,
): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ analysis: analyses, project: projects, branch: branches })
        .from(analyses)
        .innerJoin(projects, eq(projects.id, analyses.projectId))
        .leftJoin(branches, eq(branches.id, analyses.branchId))
        .where(eq(analyses.id, input.analysisId));
      if (!row || row.analysis.status !== 'failed') return 0;
      // The dead-job sweep runs on every replica and a lease expiry can run a job twice: one
      // project's failures are queued one at a time, so `queueMail`'s dedupe read sees the other's.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${LOCKS.analysisFailedMail}, hashtext(${row.project.id}))`,
      );
      // Once per event: with mail off nobody gets anything, so no recipient query either.
      if (!(await mailConfigured(tx, deps.config))) return 0;
      const branch: BranchHint | null = row.branch
        ? { name: row.branch.name, kind: row.branch.kind, isMain: row.branch.isMain }
        : (input.branchHint ?? null);
      const watchers = await watchersFor(tx, {
        projectId: row.project.id,
        event: 'analysis.failed',
        branchIsMain: branch === null ? null : branch.isMain,
        demoUser: deps.config.demoUser,
      });
      let count = 0;
      for (const watcher of watchers) {
        const links = watchLinks(deps.config, watcher.userId, row.project.id);
        const result = await queueMail(tx, deps, {
          kind: 'notify.analysis-failed',
          to: { address: watcher.email, userId: watcher.userId },
          dedupe: {
            key: analysisFailedKey(row.project.id, branch?.name ?? null),
            withinHours: ANALYSIS_FAILED_DEDUPE_HOURS,
          },
          render: () =>
            withUnsubscribe(
              renderAnalysisFailed({
                project: { id: row.project.id, name: row.project.name },
                branch: branch === null ? null : { name: branch.name, kind: branch.kind },
                revision: row.analysis.revision,
                scannerVersion: row.analysis.scannerVersion,
                error: row.analysis.error
                  ? { code: row.analysis.error.code, message: row.analysis.error.message }
                  : null,
                links,
              }),
              deps.config.publicUrl,
              links.token,
            ),
        });
        // A `skipped` here is an address mail cannot take: the next watcher still gets theirs.
        if (result.status === 'queued') count += 1;
      }
      return count;
    });
  } catch (err) {
    // The class only: a database error's message carries the query's parameters (addresses).
    logger?.warn(
      {
        analysisId: input.analysisId,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      },
      'analysis failure notifications could not be queued',
    );
    return 0;
  }
}

/** The dead-job sweep's analyses (main.ts `afterReap`), one after the other. */
export async function notifyAnalysesFailed(
  db: Db,
  deps: NotifyDeps,
  analysisIds: readonly string[],
  logger?: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  for (const analysisId of analysisIds)
    await notifyAnalysisFailed(db, deps, { analysisId }, logger);
}
