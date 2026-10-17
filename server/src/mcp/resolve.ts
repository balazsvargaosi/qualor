import { z } from 'zod';
import { unwrap, type McpCaller } from './inject';
import { ToolError } from './tool';

/** The input every branch-scoped tool shares: which project, and which branch or merge request. */
export const targetInput = {
  project: z.string().min(1).max(400).describe('The project key (as in qualor.yml)'),
  branch: z.string().min(1).max(255).optional().describe('A branch name; default: the main branch'),
  mergeRequest: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('A merge or pull request number (instead of branch)'),
};

export interface ProjectRef {
  id: string;
  key: string;
  name: string;
  organizationId: string;
}

export interface BranchRef {
  id: string;
  kind: 'branch' | 'merge_request';
  name: string;
  isMain: boolean;
  lastAnalysisId: string | null;
  gateStatus: string | null;
  mrUrl: string | null;
  mrSourceBranch: string | null;
}

/** A project by its key, as the user sees it (an invisible project is as missing as an absent one). */
export async function projectByKey(call: McpCaller, key: string): Promise<ProjectRef> {
  const res = await call.get<ProjectRef>('/api/v0/projects/by-key', { key });
  if (!res.ok && res.status === 404) {
    throw new ToolError(
      `No project with key "${key}" that you can see. Call qualor_projects to list them.`,
      'NOT_FOUND',
    );
  }
  const p = unwrap(res);
  return { id: p.id, key: p.key, name: p.name, organizationId: p.organizationId };
}

const MAX_PAGES = 10;

/** A branch by name, a merge request by number, or the main branch. */
export async function branchOf(
  call: McpCaller,
  project: ProjectRef,
  target: { branch?: string | undefined; mergeRequest?: string | undefined },
): Promise<BranchRef> {
  if (target.branch && target.mergeRequest) {
    throw new ToolError('Give either branch or mergeRequest, not both.', 'VALIDATION_FAILED');
  }
  const kind = target.mergeRequest ? 'merge_request' : 'branch';
  const wanted = target.mergeRequest ?? target.branch;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = unwrap(
      await call.get<{ items: BranchRef[]; nextCursor: string | null }>(
        `/api/v0/projects/${project.id}/branches`,
        { kind, limit: 500, cursor },
      ),
    );
    const found = res.items.find((b) => (wanted === undefined ? b.isMain : b.name === wanted));
    if (found) return found;
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  const what = target.mergeRequest
    ? `merge request ${wanted}`
    : wanted
      ? `branch "${wanted}"`
      : 'a main branch';
  throw new ToolError(
    `Project ${project.key} has no analysed ${what}. It appears after CI runs qualor scan on it.`,
    'NOT_FOUND',
  );
}

/** "main" or "merge request 42" for the first line of an answer. */
export function describeBranch(branch: Pick<BranchRef, 'kind' | 'name'>): string {
  return branch.kind === 'merge_request' ? `merge request ${branch.name}` : `branch ${branch.name}`;
}
