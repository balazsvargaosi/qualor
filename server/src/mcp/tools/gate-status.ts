import type { ConditionResult } from '@qualor/shared';
import { z } from 'zod';
import { conditionLine } from '../format';
import { unwrap } from '../inject';
import { branchOf, describeBranch, projectByKey, targetInput } from '../resolve';
import type { McpTool } from '../tool';

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

const LIST_LIMIT = 50;

const matches = (revision: string | null, commit: string) =>
  !!revision && revision.toLowerCase().startsWith(commit.toLowerCase());

/** The gate's conditions that did not pass; the stored result is JSON, so it is checked here. */
function unmetConditions(gateResult: unknown): ConditionResult[] {
  const conditions = (gateResult as { conditions?: unknown } | null)?.conditions;
  if (!Array.isArray(conditions)) return [];
  return (conditions as ConditionResult[]).filter((c) => c.status !== 'passed');
}

/** Spec §5, ruling R3: the gate of a branch or merge request, and whether CI has reached a commit. */
export const gateStatusTool: McpTool<typeof input> = {
  name: 'qualor_gate_status',
  title: 'Quality gate status',
  description:
    'Whether the quality gate of a branch or merge request passes, and which conditions fail. With commit, also whether CI ' +
    'has analysed that commit yet (analyzed, in_progress, failed or not_yet); call again after a minute or two when it is not ready.',
  access: 'read',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { call }) {
    const project = await projectByKey(call, args.project);
    const branch = await branchOf(call, project, args);
    let analysis: Analysis | null = null;
    let commit: { sha: string; state: CommitState; latestRevision?: string | null } | null = null;
    if (args.commit) {
      const list = unwrap(
        await call.get<{ items: Analysis[] }>(`/api/v0/branches/${branch.id}/analyses`, {
          limit: LIST_LIMIT,
        }),
      );
      const hit = list.items.find((a) => matches(a.revision, args.commit ?? ''));
      if (!hit) {
        const latest = list.items.find((a) => a.status === 'succeeded');
        commit = { sha: args.commit, state: 'not_yet', latestRevision: latest?.revision ?? null };
      } else if (hit.status === 'succeeded') {
        commit = { sha: args.commit, state: 'analyzed' };
        analysis = hit;
      } else if (hit.status === 'failed') {
        commit = { sha: args.commit, state: 'failed' };
        analysis = hit;
      } else {
        commit = { sha: args.commit, state: 'in_progress' };
      }
    } else if (branch.lastAnalysisId) {
      analysis = unwrap(await call.get<Analysis>(`/api/v0/analyses/${branch.lastAnalysisId}`));
    }
    // With a commit that is not analysed there is no gate to show: the latest one would be another commit's.
    const gateAnalysis = analysis;
    const failed = unmetConditions(gateAnalysis?.gateResult);
    const gate = gateAnalysis ? gateAnalysis.gateStatus : null;
    const lines = [
      `${project.key} ${describeBranch(branch)}: gate ${gate ?? 'not computed'}`,
      ...failed.map((c) => `- ${conditionLine(c)}`),
    ];
    if (gateAnalysis?.revision) {
      lines.push(
        `Analysed commit ${gateAnalysis.revision} at ${gateAnalysis.analysisDate ?? gateAnalysis.queuedAt}.`,
      );
    }
    if (gateAnalysis?.status === 'failed' && gateAnalysis.error) {
      lines.push(`The analysis failed: ${gateAnalysis.error.message}`);
    }
    if (commit?.state === 'not_yet') {
      lines.push(
        `Commit ${commit.sha} is not analysed yet; the latest analysed is ${commit.latestRevision ?? 'none'}.`,
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
        analysis: gateAnalysis
          ? {
              id: gateAnalysis.id,
              revision: gateAnalysis.revision,
              date: gateAnalysis.analysisDate,
              status: gateAnalysis.status,
            }
          : null,
        commit,
      },
    };
  },
};
