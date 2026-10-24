import { eq } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { projects, scmConnections } from '../db/schema';
import { gitlabClientFor, type ScmConnectionRow, type ScmDeps } from './connections';
import { GITHUB_PR_NUMBER } from './github/client';
import { githubClientFor } from './github/connections';
import { parseRepoRef } from './github/url';
import { GITLAB_MR_IID } from './gitlab/client';
import { ScmError } from './provider';
import type { ScmRuntime } from './runtime';

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
  runtime: ScmRuntime | undefined,
): Promise<MergeRequestState | null> {
  const repository = parseRepoRef(ref);
  if (repository === null || !GITHUB_PR_NUMBER.test(number)) return null;
  const found = githubClientFor(connection, scm, runtime);
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

/** A failure that says the provider is down or limiting, which counts against its circuit. */
const retryable = (error: ScmError) => error.kind === 'transient' || error.kind === 'rate_limited';

/**
 * `read` made as the `scm` worker's jobs make theirs (scm.md §4.2): it takes a slot of the project's
 * organisation and passes the connection's circuit, and waits for neither, so a read that cannot
 * start answers null at once. The circuit hears what came of it as a decoration reports it: a
 * transient failure counts, any other answer (a refusal too) means the provider is up, and a read
 * that asked nothing hands the probe on.
 */
async function throughRuntime(
  runtime: ScmRuntime,
  organizationId: string,
  connectionId: string,
  read: () => Promise<MergeRequestState | null>,
): Promise<MergeRequestState | null> {
  const { circuit, slots } = runtime;
  if (!slots.tryTake(organizationId)) return null;
  try {
    if (!circuit.tryPass(connectionId)) return null;
    try {
      const state = await read();
      if (state === null) circuit.release(connectionId);
      else circuit.success(connectionId);
      return state;
    } catch (err) {
      if (!(err instanceof ScmError)) {
        circuit.release(connectionId);
        throw err;
      }
      if (retryable(err)) circuit.failure(connectionId);
      else if (err.status !== null) circuit.success(connectionId);
      else circuit.release(connectionId);
      throw err;
    }
  } finally {
    slots.release(organizationId);
  }
}

/**
 * What the merge request `mergeRequestId` of the project's mapped GitLab project (or pull request
 * of its GitHub repository) is now: open, merged or closed, whether it is a draft, and its head
 * commit. One read, made through the project's connection with the current rules for its address
 * and its key. Null when that cannot be told: the project is not mapped, its connection cannot be
 * used, the id is no merge request's, or the provider failed or refused. An SCM error is no answer,
 * never a state; anything else (the database, a bug) is thrown.
 *
 * With the `scm` worker's `runtime` the read shares its state: the organisation's slots, the
 * connection's circuit (null when no slot is free or the circuit is open) and the GitHub
 * installation tokens. The review job reads without it.
 */
export async function readMergeRequestState(
  deps: { db: Executor; scm: ScmDeps; runtime?: ScmRuntime },
  projectId: string,
  mergeRequestId: string,
): Promise<MergeRequestState | null> {
  const [found] = await deps.db
    .select({
      ref: projects.scmProjectRef,
      organizationId: projects.organizationId,
      connection: scmConnections,
    })
    .from(projects)
    .innerJoin(scmConnections, eq(scmConnections.id, projects.scmConnectionId))
    .where(eq(projects.id, projectId));
  if (!found || found.ref === null) return null;
  const { connection, organizationId } = found;
  const ref = found.ref;
  const { runtime, scm } = deps;
  const read = () =>
    connection.provider === 'github'
      ? githubState(connection, ref, mergeRequestId, scm, runtime)
      : gitlabState(connection, ref, mergeRequestId, scm);
  try {
    return runtime === undefined
      ? await read()
      : await throughRuntime(runtime, organizationId, connection.id, read);
  } catch (err) {
    if (err instanceof ScmError) return null;
    throw err;
  }
}
