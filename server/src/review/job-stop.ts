import { and, eq } from 'drizzle-orm';
import { branches, projects, reviewRuns } from '../db/schema';
import { readLlmSettings } from '../llm/settings';
import type { ReviewJobDeps } from './job';
import type { Running } from './job-start';
import { sameModels } from './model-tiers';
import { startedAtIs } from './run-ends';
import { reviewActive, reviewProvider, type ReviewProvider } from './settings';

/** Why the pipeline was told to stop. */
export type StopReason =
  | { kind: 'superseded' }
  | { kind: 'inactive'; detail: string }
  | { kind: 'snapshot_deleted' }
  | { kind: 'shutdown' };

/** What a stop check leaves of its answer: the reason the pipeline was told to stop, once there is one. */
export interface StopState {
  stop: StopReason | null;
}

/**
 * Whether two providers are the same address, host, standard model and set of models: a tier given
 * a model the consent does not name would send the review's data to it, while tiers that only trade
 * the models of the set send it to no model it has not named.
 */
export const sameProvider = (a: ReviewProvider | null, b: ReviewProvider): boolean =>
  a !== null &&
  a.url === b.url &&
  a.host === b.host &&
  a.model === b.model &&
  sameModels(a.models, b.models);

/**
 * Asked before every call to the provider, and once more after the last: the server is stopping,
 * or the run was superseded (or its analysis is no longer the newest, or it was ended and started
 * again, and is another job's now), or review is no longer on for the project, or the provider
 * is no longer the one the run started with (R10), or the run's snapshot is gone (the merge
 * request was merged or closed, which deletes its snapshots, R16; the run's reference to it is
 * then null). What the run reads of a snapshot that is gone is nothing, and an outcome built on
 * that is not stored. The masker's signal is aborted with the stop.
 */
export function stopCheck(
  deps: ReviewJobDeps,
  running: Running,
  controller: AbortController,
  state: StopState,
): () => Promise<boolean> {
  const { db } = deps;
  const { run, provider } = running;
  return async () => {
    if (state.stop !== null) return true;
    if (deps.shutdown.aborted) {
      state.stop = { kind: 'shutdown' };
      controller.abort();
      return true;
    }
    const [now] = await db
      .select({
        status: reviewRuns.status,
        snapshotId: reviewRuns.snapshotId,
        newest: branches.lastAnalysisId,
      })
      .from(reviewRuns)
      .innerJoin(branches, eq(branches.id, reviewRuns.branchId))
      .where(and(eq(reviewRuns.id, run.id), startedAtIs(run.startedAt)));
    if (now?.status !== 'running' || now.newest !== run.analysisId) {
      state.stop = { kind: 'superseded' };
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
        state.stop = { kind: 'inactive', detail: active?.reason ?? 'project_deleted' };
      } else if (!sameProvider(reviewProvider(settings), provider)) {
        state.stop = { kind: 'inactive', detail: 'provider_changed' };
      } else if (now.snapshotId === null) {
        state.stop = { kind: 'snapshot_deleted' };
      }
    }
    if (state.stop !== null) controller.abort();
    return state.stop !== null;
  };
}
