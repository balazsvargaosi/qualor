import { eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { projects, scmConnections } from '../db/schema';
import { gitlabClientFor, type ScmConnectionRow, type ScmDeps } from './connections';
import { GITHUB_PR_NUMBER } from './github/client';
import { githubClientFor } from './github/connections';
import { parseRepoRef } from './github/url';
import { GITLAB_MR_IID } from './gitlab/client';
import { ScmError } from './provider';

/** A merge request, or a GitHub pull request, as an AI review reads it before it runs (6I-3). */
export interface MergeRequestState {
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  /** Its head commit as the provider says it is now; null when it does not say. */
  headSha: string | null;
}

/**
 * GitLab's states. `locked` is a merge request GitLab is merging at this moment: still open until
 * it says merged.
 */
const GITLAB_STATES: Readonly<Record<string, MergeRequestState['state']>> = {
  opened: 'open',
  locked: 'open',
  merged: 'merged',
  closed: 'closed',
};

async function gitlabState(
  connection: ScmConnectionRow,
  ref: string,
  iid: string,
  scm: ScmDeps,
): Promise<MergeRequestState | null> {
  if (!GITLAB_MR_IID.test(iid)) return null;
  const found = gitlabClientFor(connection, scm);
  if ('problem' in found) return null;
  const mr = await found.client.mergeRequest(ref, iid);
  const state = GITLAB_STATES[mr.state];
  if (state === undefined) return null;
  // A GitLab before 14 says a draft by `work_in_progress` only.
  const draft = mr.draft || mr.work_in_progress;
  return { state, draft, headSha: mr.diff_refs?.head_sha ?? mr.sha };
}

/** GitHub says `closed` for a pull request that was merged too: its `merged` flag tells them apart. */
async function githubState(
  connection: ScmConnectionRow,
  ref: string,
  number: string,
  scm: ScmDeps,
): Promise<MergeRequestState | null> {
  const repository = parseRepoRef(ref);
  if (repository === null || !GITHUB_PR_NUMBER.test(number)) return null;
  const found = githubClientFor(connection, scm);
  if ('problem' in found) return null;
  await found.client.useRepository(repository);
  const pull = await found.client.pullRequest(number);
  const state =
    pull.state === 'open'
      ? 'open'
      : pull.state === 'closed'
        ? pull.merged
          ? 'merged'
          : 'closed'
        : null;
  if (state === null) return null;
  return { state, draft: pull.draft, headSha: pull.head.sha };
}

/**
 * What the merge request `mergeRequestId` of the project's mapped GitLab project (or pull request
 * of its GitHub repository) is now: open, merged or closed, whether it is a draft, and its head
 * commit. One read, made through the project's connection with the current rules for its address
 * and its key. Null when that cannot be told: the project is not mapped, its connection cannot be
 * used, the id is no merge request's, or the provider failed or refused. An SCM error is no answer,
 * never a state; anything else (the database, a bug) is thrown.
 */
export async function readMergeRequestState(
  deps: { db: Executor; scm: ScmDeps },
  projectId: string,
  mergeRequestId: string,
): Promise<MergeRequestState | null> {
  const [found] = await deps.db
    .select({ ref: projects.scmProjectRef, connection: scmConnections })
    .from(projects)
    .innerJoin(scmConnections, eq(scmConnections.id, projects.scmConnectionId))
    .where(eq(projects.id, projectId));
  if (!found || found.ref === null) return null;
  try {
    return found.connection.provider === 'github'
      ? await githubState(found.connection, found.ref, mergeRequestId, deps.scm)
      : await gitlabState(found.connection, found.ref, mergeRequestId, deps.scm);
  } catch (err) {
    if (err instanceof ScmError) return null;
    throw err;
  }
}
