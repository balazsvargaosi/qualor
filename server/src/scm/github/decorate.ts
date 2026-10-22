import type { DecorationDeps, DecorationOutcome } from '../decorate';
import {
  branchUrl,
  comparable,
  issueUrl,
  recordMergeRequest,
  summaryData,
  type Loaded,
} from '../decoration-data';
import { markerOf } from '../markdown';
import { ScmError } from '../provider';
import type { DecorationPayload } from '../queue';
import { statusName, summaryBody, type SummaryInput } from '../render';
import {
  GITHUB_PR_NUMBER,
  GITHUB_TEXT,
  MAX_THREAD_PAGES,
  type CheckRunUpdate,
  type GitHubClient,
  type GitHubPullRequest,
} from './client';
import { githubClientFor } from './connections';
import {
  checkRunExternalId,
  checkRunSummary,
  checkRunVerdict,
  NO_ANNOTATIONS_DIGEST,
  parseCheckRunExternalId,
} from './render';
import {
  applyReviewThreads,
  MAX_COMMENT_PAGES,
  planReviewThreads,
  type ReviewThreadContext,
} from './threads';
import { githubWebBase, parseRepoRef } from './url';

/** github.md §5.3: pages of pull request files one job reads at most. */
export const MAX_FILE_PAGES = 30;
// The bound on pages of comments, of the issue comments that hold the summary and of the pull
// request's review comments alike, lives in threads.ts, which reads the review comments by it.
export { MAX_COMMENT_PAGES };
/**
 * github.md §5.3 (ruling R7): the most requests a job makes besides creating, resolving and
 * reopening review threads:
 * - the App, the installation, its token, the repository and the pull request (5);
 * - every page of files, review comments, review threads and issue comments it may read;
 * - the check run: its listing, and its creation or update (2);
 * - the summary: its creation or edit (1);
 * - what a token refreshed after a 401 adds: the new token and the request made again (2).
 * With the creations (`MAX_CREATION_REQUESTS`: one review, and each comment alone when GitHub
 * refuses it) and the resolutions and reopenings (at most `MAX_GITHUB_THREAD_UPDATES`) this stays
 * within `MAX_GITHUB_REQUESTS`, so the check run and the summary are always written.
 */
export const REQUESTS_OUTSIDE_THREADS =
  5 + MAX_FILE_PAGES + MAX_COMMENT_PAGES + MAX_THREAD_PAGES + 2 + MAX_COMMENT_PAGES + 1 + 2;
export const REPOSITORY_MISMATCH =
  "The workflow's GitHub repository is not the repository Qualor is mapped to";

type Inline = SummaryInput['inline'];

/**
 * github.md §6.4: the review threads of an open pull request whose head is the analysed revision,
 * checked out by the workflow: the pull request's files (a file the page bound cuts places no
 * issue: its issues count as not placed) and the reconciliation of Qualor's threads with them.
 */
async function reconcileThreads(
  deps: DecorationDeps,
  client: GitHubClient,
  loaded: Loaded,
  pull: GitHubPullRequest,
  botLogin: string,
): Promise<Inline> {
  const number = loaded.branch.name;
  const files = await client.pullRequestFiles(number, MAX_FILE_PAGES);
  const ctx: ReviewThreadContext = {
    db: deps.db,
    client,
    number,
    projectId: loaded.project.id,
    branchId: loaded.branch.id,
    headSha: pull.head.sha,
    files: files.items,
    botLogin,
    issueUrl: (issueId) => issueUrl(deps.publicUrl, loaded.project.id, issueId),
    ...(deps.maxThreadUpdates === undefined ? {} : { maxThreadUpdates: deps.maxThreadUpdates }),
  };
  const { commented, unplaced } = await applyReviewThreads(ctx, await planReviewThreads(ctx));
  return { commented, unplaced, skipped: null };
}

/**
 * github.md §6.1: Qualor's check run of this name on the revision, read before written. One with
 * the digest of no annotations (every check run Qualor writes has it, and a 0.11 one without
 * annotations) and the same conclusion, title, summary, link and analysis → nothing; the same
 * digest and anything else changed → PATCH. None of Qualor's, or the newest has another digest (a
 * 0.11 check run with annotations, which GitHub cannot take off it) → a new check run, which
 * GitHub shows (and branch protection uses) in its place.
 */
async function reconcileCheckRun(
  client: GitHubClient,
  a: {
    name: string;
    revision: string;
    analysisId: string;
    verdict: { conclusion: 'success' | 'failure'; title: string };
    detailsUrl: string | null;
    summary: string;
  },
): Promise<void> {
  const current =
    (await client.checkRuns(a.revision, a.name))
      .map((run) => ({ run, ids: parseCheckRunExternalId(run.external_id) }))
      .filter((c) => c.ids !== null)
      .sort((x, y) => y.run.id - x.run.id)[0] ?? null;
  const desired: CheckRunUpdate = {
    conclusion: a.verdict.conclusion,
    title: a.verdict.title,
    summary: a.summary,
    detailsUrl: a.detailsUrl,
    externalId: checkRunExternalId(a.analysisId, NO_ANNOTATIONS_DIGEST),
  };
  if (current === null || current.ids?.digest !== NO_ANNOTATIONS_DIGEST) {
    await client.createCheckRun({ ...desired, name: a.name, headSha: a.revision });
    return;
  }
  const r = current.run;
  const same =
    r.conclusion === desired.conclusion &&
    (r.output.title ?? '') === desired.title &&
    comparable(r.output.summary ?? '') === comparable(desired.summary) &&
    // GitHub fills in a details URL of its own when none is sent: compare only one Qualor sent.
    (desired.detailsUrl === null || r.details_url === desired.detailsUrl) &&
    r.external_id === desired.externalId;
  if (!same) await client.updateCheckRun(r.id, desired);
}

/** github.md §6.2–§6.3: the summary comment, recognised by the App's bot login and the marker. */
async function reconcileComment(
  deps: DecorationDeps,
  client: GitHubClient,
  loaded: Loaded,
  number: string,
  body: string,
  slug: string,
): Promise<void> {
  const listed = await client.issueComments(number, MAX_COMMENT_PAGES);
  const login = `${slug}[bot]`;
  const own = listed.items.find((c) => {
    if (c.user?.type !== 'Bot' || c.user.login !== login || c.body === null) return false;
    const marker = markerOf(c.body);
    return marker?.kind === 'summary' && marker.projectId === loaded.project.id;
  });
  if (own) {
    if (comparable(own.body ?? '') !== comparable(body)) await client.updateComment(own.id, body);
  } else if (listed.complete) {
    await client.createComment(number, body);
  } else {
    // Beyond the page bound the summary may exist unseen: never post a second one.
    deps.logger?.warn(
      { analysisId: loaded.analysis.id, connectionId: loaded.connection.id },
      'GitHub pull request has too many comments to find the Qualor summary; not posting one',
    );
  }
}

const retryable = (e: ScmError) => e.kind === 'transient' || e.kind === 'rate_limited';
/** More requests now would only be refused too (the retry waits for GitHub's Retry-After). */
const stopsTheJob = (e: ScmError) => e.kind === 'budget' || e.kind === 'rate_limited';

/**
 * One GitHub decoration (github.md §5.2): the App, the installation and the repository; for the
 * branch's latest analysis of an open pull request, its review threads (§6.4); the check run of
 * the revision (§6.1), which carries no annotations; then the summary comment. A failed pull
 * request part does not stop the check run (which then says nothing about inline comments),
 * unless GitHub rate-limited it or the budget ran out; the threads and the summary stay as they
 * are. Only a transient failure or a rate limit is retried (by the caller, through `failed`); any
 * other error stops the job.
 */
export async function decorateGitHub(
  deps: DecorationDeps,
  payload: DecorationPayload,
  loaded: Loaded,
  failed: (error: ScmError) => DecorationOutcome,
): Promise<DecorationOutcome> {
  const { connection, branch, project, analysis } = loaded;
  // The key is decrypted and the base URL checked against the current rules (scm.md §2.1,
  // github.md §2.2) before any request; the worker's token cache and pacer are shared.
  const found = githubClientFor(connection, deps.scm, deps.runtime);
  if ('problem' in found) return failed(new ScmError('refused', found.problem));
  const ref = parseRepoRef(project.scmProjectRef ?? '');
  if (ref === null) {
    return failed(new ScmError('refused', GITHUB_TEXT.notFound, { reason: 'invalid_input' }));
  }
  const client = found.client;
  const errors: ScmError[] = [];
  try {
    const app = await client.app();
    const repo = await client.useRepository(ref);
    const expected = payload.github?.repositoryId;
    if (expected !== undefined && String(repo.id) !== expected) {
      return failed(new ScmError('refused', REPOSITORY_MISMATCH));
    }
    let pull: GitHubPullRequest | null = null;
    // An analysis that is no longer the branch's latest, or whose pull request part failed, leaves
    // the threads as they are and says nothing about them.
    let inline: Inline = { commented: 0, unplaced: 0, skipped: null };
    const latestPullRequest =
      branch.kind === 'merge_request' &&
      GITHUB_PR_NUMBER.test(branch.name) &&
      branch.lastAnalysisId === analysis.id;
    if (latestPullRequest) {
      try {
        pull = await client.pullRequest(branch.name);
        await recordMergeRequest(
          deps.db,
          loaded,
          { title: pull.title, url: pull.html_url },
          githubWebBase(connection.baseUrl),
        );
        if (pull.state === 'open') {
          const skipped: Inline['skipped'] =
            payload.github?.checkout !== 'head'
              ? 'checkout_other'
              : pull.head.sha !== loaded.revision
                ? 'stale'
                : null;
          inline =
            skipped === null
              ? await reconcileThreads(deps, client, loaded, pull, `${app.slug}[bot]`)
              : { commented: 0, unplaced: 0, skipped };
        }
      } catch (err) {
        if (!(err instanceof ScmError)) throw err;
        if (stopsTheJob(err)) return failed(err);
        errors.push(err);
        pull = null;
      }
    }
    const data = await summaryData(deps.db, loaded, deps.publicUrl);
    const head = pull !== null && pull.head.sha !== loaded.revision ? pull.head.sha : null;
    const body = summaryBody({
      projectId: project.id,
      revision: loaded.revision,
      gate: loaded.gate,
      newIssues: data.newIssues,
      topIssues: data.top,
      topIssuesTotal: data.total,
      inline,
      branchUrl: branchUrl(deps.publicUrl, loaded),
      mergeRequestHead: head,
      vocabulary: 'github',
      smallChangesetLines: data.smallChangesetLines,
    });
    try {
      await reconcileCheckRun(client, {
        name: statusName(project.key),
        revision: loaded.revision,
        analysisId: analysis.id,
        verdict: checkRunVerdict(loaded.gate),
        detailsUrl: branchUrl(deps.publicUrl, loaded),
        summary: checkRunSummary(body),
      });
    } catch (err) {
      if (!(err instanceof ScmError)) throw err;
      if (stopsTheJob(err)) return failed(err);
      errors.push(err);
    }
    if (pull !== null && pull.state === 'open') {
      try {
        await reconcileComment(deps, client, loaded, branch.name, body, app.slug);
      } catch (err) {
        if (!(err instanceof ScmError)) throw err;
        errors.push(err);
      }
    }
    const error =
      errors.find((e) => e.kind === 'budget') ?? errors.find(retryable) ?? errors[0] ?? null;
    return error === null ? { kind: 'done', connectionId: connection.id } : failed(error);
  } catch (err) {
    if (err instanceof ScmError) return failed(err);
    throw err;
  }
}
