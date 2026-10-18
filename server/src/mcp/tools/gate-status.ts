import type { ConditionResult } from '@qualor/shared';
import { z } from 'zod';
import { conditionLine } from '../format';
import { unwrap, type McpCaller } from '../inject';
import { branchOf, describeBranch, projectByKey, targetInput } from '../resolve';
import { ToolError, type McpTool } from '../tool';

const input = z.object({
  ...targetInput,
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional()
    .describe('A commit SHA (7–40 hex). Says whether CI has analysed that commit yet.'),
});

/** The part of `GET /analyses/{id}` this tool reads (`analysisSchema`). */
interface Analysis {
  id: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  revision: string | null;
  analysisDate: string | null;
  gateStatus: string | null;
  gateResult: unknown;
  error: { code: string; message: string } | null;
  queuedAt: string;
}

type CommitState = 'analyzed' | 'in_progress' | 'failed' | 'not_yet';

/** Pages of analyses searched for a commit (newest first): 10 x 100 = the newest 1 000. */
export const MAX_ANALYSIS_PAGES = 10;
const PAGE_SIZE = 100;

const matches = (revision: string | null, commit: string) =>
  !!revision && revision.toLowerCase().startsWith(commit.toLowerCase());

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The gate's conditions that did not pass; the stored result is JSON, so each entry is checked. */
function unmetConditions(gateResult: unknown): ConditionResult[] {
  const conditions = isObject(gateResult) ? gateResult.conditions : undefined;
  if (!Array.isArray(conditions)) return [];
  const unmet: ConditionResult[] = [];
  for (const c of conditions as unknown[]) {
    if (
      isObject(c) &&
      typeof c.metric === 'string' &&
      (c.operator === 'gt' || c.operator === 'lt') &&
      typeof c.threshold === 'number' &&
      (typeof c.value === 'number' || c.value === null) &&
      (c.status === 'failed' || c.status === 'no_value')
    ) {
      unmet.push(c as unknown as ConditionResult);
    }
  }
  return unmet;
}

interface CommitSearch {
  /** Newest first. */
  hits: Analysis[];
  latestRevision: string | null;
  searched: number;
  /** The search reached the end of the history, or a full SHA matched; false when the budget ended it. */
  complete: boolean;
}

const FULL_SHA = 40;

/**
 * Pages through a branch's analyses (newest first). A full SHA stops at the first page with a hit;
 * a shorter prefix goes on to the end (or the budget) so a second commit with the same prefix is
 * seen, not hidden behind the first.
 */
async function searchCommit(call: McpCaller, branchId: string, sha: string): Promise<CommitSearch> {
  let cursor: string | undefined;
  let searched = 0;
  let latestRevision: string | null = null;
  const hits: Analysis[] = [];
  for (let page = 0; page < MAX_ANALYSIS_PAGES; page += 1) {
    const res = unwrap(
      await call.get<{ items: Analysis[]; nextCursor: string | null }>(
        `/api/v0/branches/${branchId}/analyses`,
        { limit: PAGE_SIZE, cursor },
      ),
    );
    searched += res.items.length;
    latestRevision ??= res.items.find((a) => a.status === 'succeeded')?.revision ?? null;
    hits.push(...res.items.filter((a) => matches(a.revision, sha)));
    if (hits.length && sha.length >= FULL_SHA)
      return { hits, latestRevision, searched, complete: true };
    if (!res.nextCursor) return { hits, latestRevision, searched, complete: true };
    cursor = res.nextCursor;
  }
  return { hits, latestRevision, searched, complete: false };
}

/** Spec §5, ruling R3: the gate of a branch or merge request, and whether CI has reached a commit. */
export const gateStatusTool: McpTool<typeof input> = {
  name: 'qualor_gate_status',
  title: 'Quality gate status',
  description:
    'Whether the quality gate of a branch or merge request passes, and which conditions fail. With commit, also whether CI ' +
    'has analysed that commit yet (analyzed, in_progress, failed or not_yet); call again after a minute or two when it is not ready. ' +
    'A commit analysed more than once answers with the latest analysis of that commit; a short SHA that matches several ' +
    'commits is refused, so give more characters. Only the newest 1 000 analyses are searched (the answer says when that was not enough).',
  access: 'read',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { call }) {
    const project = await projectByKey(call, args.project);
    const branch = await branchOf(call, project, args);
    let analysis: Analysis | null = null;
    let commit: {
      sha: string;
      state: CommitState;
      latestRevision?: string | null;
      searched?: number;
      complete?: boolean;
    } | null = null;
    if (args.commit) {
      const found = await searchCommit(call, branch.id, args.commit);
      const revisions = [...new Set(found.hits.map((a) => (a.revision ?? '').toLowerCase()))];
      if (revisions.length > 1) {
        const shown = revisions.slice(0, 5).map((r) => r.slice(0, 12));
        throw new ToolError(
          `The commit prefix ${args.commit} matches ${revisions.length} commits (${shown.join(', ')}${revisions.length > shown.length ? ', …' : ''}). Give more characters of the SHA.`,
          'AMBIGUOUS_COMMIT',
        );
      }
      // Newest first, so the first hit is the latest analysis of that commit.
      const hit = found.hits[0];
      if (!hit) {
        commit = {
          sha: args.commit,
          state: 'not_yet',
          latestRevision: found.latestRevision,
          searched: found.searched,
          complete: found.complete,
        };
      } else if (hit.status === 'succeeded') {
        commit = {
          sha: args.commit,
          state: 'analyzed',
          searched: found.searched,
          complete: found.complete,
        };
        analysis = hit;
      } else if (hit.status === 'failed') {
        commit = {
          sha: args.commit,
          state: 'failed',
          searched: found.searched,
          complete: found.complete,
        };
        analysis = hit;
      } else {
        commit = {
          sha: args.commit,
          state: 'in_progress',
          searched: found.searched,
          complete: found.complete,
        };
      }
    } else if (branch.lastAnalysisId) {
      analysis = unwrap(await call.get<Analysis>(`/api/v0/analyses/${branch.lastAnalysisId}`));
    }
    // With a commit that is not analysed there is no gate to show: the latest one would be another commit's.
    const failed = unmetConditions(analysis?.gateResult);
    const gate = analysis ? analysis.gateStatus : null;
    const lines = [
      `${project.key} ${describeBranch(branch)}: gate ${gate ?? 'not computed'}`,
      ...failed.map((c) => `- ${conditionLine(c)}`),
    ];
    if (analysis?.revision) {
      lines.push(
        `Analysed commit ${analysis.revision} at ${analysis.analysisDate ?? analysis.queuedAt}.`,
      );
    }
    if (analysis?.status === 'failed' && analysis.error) {
      lines.push(`The analysis failed: ${analysis.error.message}`);
    }
    if (commit?.state === 'not_yet') {
      lines.push(
        commit.complete
          ? `Commit ${commit.sha} is not analysed yet; the latest analysed is ${commit.latestRevision ?? 'none'}.`
          : `Commit ${commit.sha} was not found among the newest ${commit.searched} analyses of this branch; older ones were not searched, so it may still have been analysed earlier.`,
      );
    }
    if (commit && commit.state !== 'not_yet' && commit.complete === false) {
      lines.push(
        'Only the newest ' +
          commit.searched +
          ' analyses were searched; another commit with the same prefix may exist further back, so give more characters of the SHA to be sure.',
      );
    }
    if (commit?.state === 'in_progress') {
      lines.push(`Commit ${commit.sha} is being analysed; ask again in a minute.`);
    }
    return {
      text: lines.join('\n'),
      structured: {
        project: { key: project.key, name: project.name },
        branch: { id: branch.id, name: branch.name, kind: branch.kind, mrUrl: branch.mrUrl },
        gate,
        failedConditions: failed.map((c) => ({
          metric: c.metric,
          operator: c.operator,
          threshold: c.threshold,
          value: c.value,
        })),
        analysis: analysis
          ? {
              id: analysis.id,
              revision: analysis.revision,
              date: analysis.analysisDate,
              status: analysis.status,
            }
          : null,
        commit,
      },
    };
  },
};
