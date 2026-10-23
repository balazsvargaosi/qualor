import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeGitHub, type FakeGitHub } from '../../test/fake-github';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { mappedGitHubProject } from '../../test/github';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import { decorationDeps, mappedProject, PUBLIC_URL } from '../../test/scm';
import { readMergeRequestState } from './mr-state';
import { parseInternalHosts } from './url';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const GITLAB_PROJECT = 701;
const REPOSITORY = 9_701;

describe('readMergeRequestState (6I-3)', () => {
  let gitlab: FakeGitLab;
  let github: FakeGitHub;
  let h: IngestHarness;
  let gitlabProject: string;
  let githubProject: string;
  let unmapped: string;

  const stateOf = (projectId: string, mergeRequestId: string) =>
    readMergeRequestState({ db: h.ctx.db, scm: decorationDeps(h).scm }, projectId, mergeRequestId);

  beforeAll(async () => {
    gitlab = await createFakeGitLab();
    github = await createFakeGitHub();
    h = await createIngestHarness({
      config: {
        publicUrl: PUBLIC_URL,
        scmInternalHosts: parseInternalHosts(
          `${new URL(gitlab.url).host},${new URL(github.url).host}`,
        ),
      },
    });
    gitlab.addProject({ id: GITLAB_PROJECT, path: 'acme/mrs' });
    const mergeRequest = {
      title: 'A change',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      headSha: HEAD,
      baseSha: BASE,
      startSha: BASE,
      diffs: [],
    };
    gitlab.addMergeRequest(GITLAB_PROJECT, { ...mergeRequest, iid: 1, state: 'opened' });
    gitlab.addMergeRequest(GITLAB_PROJECT, { ...mergeRequest, iid: 2, state: 'merged' });
    gitlab.addMergeRequest(GITLAB_PROJECT, { ...mergeRequest, iid: 3, state: 'closed' });
    gitlab.addMergeRequest(GITLAB_PROJECT, {
      ...mergeRequest,
      iid: 4,
      state: 'opened',
      draft: true,
    });
    // As a GitLab before 14 answers: no `draft`, only `work_in_progress`.
    gitlab.addMergeRequest(GITLAB_PROJECT, {
      ...mergeRequest,
      iid: 5,
      state: 'opened',
      legacyDraft: true,
    });
    gitlab.addMergeRequest(GITLAB_PROJECT, {
      ...mergeRequest,
      iid: 6,
      state: 'opened',
      legacyDraft: false,
    });
    gitlabProject = (await mappedProject(h, gitlab, 'mrs/gitlab', GITLAB_PROJECT)).id;

    github.addRepository({ id: REPOSITORY, owner: 'acme', name: 'prs', installationId: 701 });
    const pull = { title: 'A change', headSha: HEAD, baseSha: BASE, files: [] };
    github.addPull(REPOSITORY, { ...pull, number: 1, state: 'open' });
    github.addPull(REPOSITORY, { ...pull, number: 2, state: 'closed', merged: true });
    github.addPull(REPOSITORY, { ...pull, number: 3, state: 'closed' });
    github.addPull(REPOSITORY, { ...pull, number: 4, state: 'open', draft: true });
    githubProject = (await mappedGitHubProject(h, github, 'mrs/github', 'acme/prs')).id;
    unmapped = (await h.project('mrs/unmapped')).id;
  });
  afterAll(async () => {
    await h.close();
    await gitlab.close();
    await github.close();
  });

  it('GitLab and GitHub open, merged, closed and draft', async () => {
    for (const projectId of [gitlabProject, githubProject]) {
      const states = await Promise.all(['1', '2', '3', '4'].map((id) => stateOf(projectId, id)));
      expect(states).toEqual([
        { state: 'open', draft: false, headSha: HEAD },
        { state: 'merged', draft: false, headSha: HEAD },
        { state: 'closed', draft: false, headSha: HEAD },
        { state: 'open', draft: true, headSha: HEAD },
      ]);
    }
  });

  it('a GitLab before 14 says a draft by work_in_progress', async () => {
    expect(await stateOf(gitlabProject, '5')).toEqual({
      state: 'open',
      draft: true,
      headSha: HEAD,
    });
    expect(await stateOf(gitlabProject, '6')).toEqual({
      state: 'open',
      draft: false,
      headSha: HEAD,
    });
  });

  it('an SCM error answers null', async () => {
    // A merge request the provider does not know, an answer that is an error, a project that is
    // not mapped, a repository the App is not installed on, and an id that is no merge request's.
    expect(await stateOf(gitlabProject, '99')).toBeNull();
    gitlab.inject('GET', /\/merge_requests\/1$/, { status: 500 });
    expect(await stateOf(gitlabProject, '1')).toBeNull();
    expect(await stateOf(githubProject, '99')).toBeNull();
    expect(await stateOf(unmapped, '1')).toBeNull();
    github.addRepository({ id: 9_702, owner: 'acme', name: 'gone', installationId: null });
    const notInstalled = (await mappedGitHubProject(h, github, 'mrs/gone', 'acme/gone')).id;
    expect(await stateOf(notInstalled, '1')).toBeNull();
    expect(await stateOf(gitlabProject, 'feature/x')).toBeNull();
    // A provider that answers again is read again.
    expect(await stateOf(gitlabProject, '1')).toEqual({
      state: 'open',
      draft: false,
      headSha: HEAD,
    });
  });
});
