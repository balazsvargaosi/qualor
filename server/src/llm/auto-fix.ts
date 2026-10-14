import { SEVERITIES, type Severity } from '@qualor/shared';
import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SYSTEM_ACTOR, type AuditRecorder } from '../audit/recorder';
import type { Db, Executor } from '../db/client';
import { analyses, branches, issues, projects } from '../db/schema';
import { ProblemError } from '../http/problem';
import type { Limits } from '../limits';
import { enqueue } from '../queue/queue';
import type { JobHandlers, WorkerLogger } from '../queue/worker';
import { effectiveAutoFix } from './auto-fix-settings';
import { createAiRequest } from './service';
import { pathExcluded, readLlmSettings, type StoredLlmSettings } from './settings';

/** 4E-3a §3: the automatic fix suggestions of one analysis are a job of their own. */
export const AUTO_FIX_QUEUE = 'llm-auto-fix';
/**
 * One attempt: a retry after a failure midway would start counting `maxPerAnalysis` again, and
 * the rows do not say which analysis asked. What a failed job did not ask about, the merge
 * request's next analysis does.
 */
export const AUTO_FIX_JOB_MAX_ATTEMPTS = 1;

/** 4E-3a §3: two analyses of one merge request are never handled at once. */
export const autoFixKey = (branchId: string): string => `${AUTO_FIX_QUEUE}:${branchId}`;

export const autoFixPayload = z.strictObject({ analysisId: z.uuid() });
export type AutoFixPayload = z.infer<typeof autoFixPayload>;

export interface AutoFixDeps {
  db: Db;
  /** The edition's limits, read on every job (enterprise.md §7). */
  limits: () => Limits;
  /** Records `ai.requested` for each automatic request, as the system actor. */
  audit?: AuditRecorder | undefined;
  logger?: WorkerLogger | undefined;
}

/**
 * 4E-3a §3, the trigger: called by the SCM stage in the ingestion transaction, once the
 * decoration of a merge request's analysis is queued. Queues the analysis's automatic fix
 * suggestions when the effective rule holds for its project now; the job checks it again.
 */
export async function enqueueAutoFix(
  tx: Executor,
  limits: Limits,
  input: {
    analysisId: string;
    branch: { id: string; kind: string };
    project: { id: string; organizationId: string };
  },
): Promise<void> {
  if (input.branch.kind !== 'merge_request') return;
  const settings = await readLlmSettings(tx);
  if (!effectiveAutoFix(settings, limits, input.project).allowed) return;
  await enqueue(tx, {
    queue: AUTO_FIX_QUEUE,
    payload: { analysisId: input.analysisId } satisfies AutoFixPayload,
    concurrencyKey: autoFixKey(input.branch.id),
    maxAttempts: AUTO_FIX_JOB_MAX_ATTEMPTS,
  });
}

/**
 * 4E-3a §3 step 2: the branch's open issues in new code, not duplicates, with a path, a start line
 * and a snippet, at or above `minSeverity`, whose path is not excluded from AI and that never had
 * an automatic fix request (whatever its outcome); the most severe first, then by path (byte
 * order), start line and id. The caller takes at most `maxPerAnalysis` of them.
 */
export async function autoFixCandidates(
  db: Executor,
  branchId: string,
  settings: StoredLlmSettings,
  minSeverity: Severity,
): Promise<string[]> {
  const rows = await db
    .select({ id: issues.id, path: issues.path })
    .from(issues)
    .where(
      and(
        eq(issues.branchId, branchId),
        eq(issues.status, 'open'),
        eq(issues.inNewCode, true),
        isNull(issues.duplicateOfIssueId),
        isNotNull(issues.path),
        isNotNull(issues.startLine),
        isNotNull(issues.snippet),
        lte(issues.severityRank, SEVERITIES.indexOf(minSeverity)),
        sql`NOT EXISTS (
              SELECT 1 FROM llm_requests r
               WHERE r.issue_id = ${issues.id} AND r.feature = 'fix' AND r.user_id IS NULL)`,
      ),
    )
    .orderBy(
      asc(issues.severityRank),
      sql`${issues.path} COLLATE "C"`,
      asc(issues.startLine),
      asc(issues.id),
    );
  return rows.filter((r) => !pathExcluded(settings, r.path)).map((r) => r.id);
}

/** Why a candidate was not asked about: the job goes on, or stops. */
function refusalOf(err: unknown): 'skip' | 'budget_exhausted' | 'disabled' | null {
  if (!(err instanceof ProblemError)) return null;
  if (err.code === 'AI_QUOTA_EXCEEDED') return 'budget_exhausted';
  if (err.code === 'AI_DISABLED') return 'disabled';
  if (err.code === 'AI_NOT_ELIGIBLE' || err.code === 'NOT_FOUND') return 'skip';
  return null;
}

/**
 * 4E-3a §3 steps 1–3: the effective rule and the analysis checked again (it must still be the
 * merge request's latest), then one automatic request per candidate, through the function a
 * person's request uses, until `maxPerAnalysis` were queued or the organisation's fix budget for
 * the day is used up. A candidate answered from the cache or already in flight (a person asked)
 * costs nothing and is not counted.
 */
async function runAutoFix(deps: AutoFixDeps, analysisId: string): Promise<void> {
  const [found] = await deps.db
    .select({ analysis: analyses, branch: branches, project: projects })
    .from(analyses)
    .innerJoin(branches, eq(branches.id, analyses.branchId))
    .innerJoin(projects, eq(projects.id, analyses.projectId))
    .where(eq(analyses.id, analysisId));
  if (
    !found ||
    found.analysis.status !== 'succeeded' ||
    found.branch.kind !== 'merge_request' ||
    found.branch.lastAnalysisId !== analysisId
  ) {
    return;
  }
  const { branch, project } = found;
  const limits = deps.limits();
  const settings = await readLlmSettings(deps.db);
  const rule = effectiveAutoFix(settings, limits, project);
  if (!rule.allowed) return;
  const candidates = await autoFixCandidates(deps.db, branch.id, settings, rule.minSeverity);
  const audit = deps.audit ? { recorder: deps.audit, context: SYSTEM_ACTOR } : undefined;
  let requested = 0;
  let stopped: 'budget_exhausted' | 'disabled' | null = null;
  for (const issueId of candidates) {
    if (requested >= rule.maxPerAnalysis) break;
    try {
      const outcome = await createAiRequest(
        // The limits read once per job: what was checked above is what is used.
        { db: deps.db, limits, ...(audit ? { audit } : {}) },
        { kind: 'automatic' },
        { issueId, projectId: project.id },
        'fix',
        { refresh: false },
      );
      if (outcome.kind === 'queued') requested += 1;
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal === null) throw err;
      if (refusal === 'skip') continue;
      stopped = refusal;
      break;
    }
  }
  const details = { analysisId, organizationId: project.organizationId, requested };
  if (stopped === 'budget_exhausted') {
    deps.logger?.warn(
      { ...details, outcome: 'budget_exhausted' },
      'automatic fix suggestions stopped: budget_exhausted',
    );
  } else if (requested > 0 || stopped !== null) {
    deps.logger?.info({ ...details, outcome: stopped ?? 'requested' }, 'automatic fix suggestions');
  }
}

/** The `llm-auto-fix` queue's handler, run by the `llm` worker (main.ts). */
export function autoFixHandlers(deps: AutoFixDeps): JobHandlers {
  return {
    [AUTO_FIX_QUEUE]: async (job) => {
      const parsed = autoFixPayload.safeParse(job.payload);
      if (!parsed.success) {
        deps.logger?.warn({ jobId: job.id }, 'malformed automatic fix job payload; completing');
        return;
      }
      await runAutoFix(deps, parsed.data.analysisId);
    },
  };
}
