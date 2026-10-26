import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeGitHub,
  githubShape,
  githubWrites,
  type FakeGitHub,
  type FakeRepository,
} from '../../../test/fake-github';
import {
  githubConnection,
  githubDeps,
  githubTestConfig,
  mappedGitHubProject,
  pullRequestReport,
} from '../../../test/github';
import { createIngestHarness, type IngestHarness } from '../../../test/ingest';
import { engine, file, finding, reportWith } from '../../../test/reports';
import { seedAiIssue } from '../../../test/review';
import { PUBLIC_URL, queuedDecorations, runDecorations } from '../../../test/scm';
import { encryptionKey, encryptSecret } from '../../crypto/secrets';
import { analyses, branches, reviewFindings, reviewRuns, scmConnections } from '../../db/schema';
import { SCM_TOKEN_AAD } from '../connections';
import { markerOf } from '../markdown';
import { enqueueDecoration } from '../queue';
import { statusName } from '../render';
import { MAX_FILE_PAGES } from './decorate';
import { NO_ANNOTATIONS_DIGEST, parseCheckRunExternalId } from './render';

const HEAD = '1'.repeat(40);
/** src/a.ts: lines 1-2 are context, lines 3-5 are added. */
const PATCH = '@@ -1,2 +1,5 @@\n a\n b\n+c\n+d\n+e';
const GRAPHQL = '/api/graphql';
/** github.md §6.2: the exact sentences of GitHub's summary (Global Constraints of 6I-1). */
const CHECKOUT_OTHER =
  'The analyzers’ issues are not commented inline: the workflow analysed a commit other than the pull request’s head (GitHub’s merge commit, by default); check out the head to get them (`ref: ${{ github.event.pull_request.head.sha }}`).';
const STALE = 'Inline comments wait for the analysis of the pull request’s latest commit.';

describe('GitHub decoration (github.md §5–§6)', () => {
  let h: IngestHarness;
  let fake: FakeGitHub;
  let nextRepo = 1000;
  let day = 1;
  let connectionId: string;

  /** A mapped project on its own repository with an open pull request #7 at HEAD. */
  const setup = async (
    key: string,
    options: {
      files?: { filename: string; patch?: string }[];
      repo?: { id: number; name: string };
    } = {},
  ) => {
    const repo = options.repo ?? { id: nextRepo++, name: key.replace(/\W/g, '-') };
    if (!options.repo) {
      fake.addRepository({ id: repo.id, owner: 'acme', name: repo.name, installationId: 777 });
      fake.addPull(repo.id, {
        number: 7,
        title: 'Refunds @all',
        state: 'open',
        headSha: HEAD,
        baseSha: 'b'.repeat(40),
        files: options.files ?? [{ filename: 'src/a.ts', patch: PATCH }],
      });
    }
    const project = await mappedGitHubProject(h, fake, key, `acme/${repo.name}`, { connectionId });
    const ingest = (
      lines: number[],
      github: NonNullable<Parameters<typeof pullRequestReport>[2]>['github'] = {
        repositoryId: String(repo.id),
        checkout: 'head',
      },
      revision = HEAD,
    ) =>
      project.ingestOk(
        pullRequestReport(7, revision, {
          projectKey: project.key,
          analysisDate: new Date(Date.UTC(2026, 8, 1, 10) + 86_400_000 * day++).toISOString(),
          engines: [engine('eslint')],
          files: [file('src/a.ts', { newLines: [[1, 60]] })],
          findings: lines.map((line) => finding({ path: 'src/a.ts', line })),
          github,
        }),
      );
    return { project, repo, ingest };
  };
  const runsOf = (repoId: number) => fake.checkRuns.filter((r) => r.repoId === repoId);
  const newestRun = (repoId: number) => runsOf(repoId).at(-1);
  const summaries = (repoId: number) =>
    fake.comments.filter((c) => c.repoId === repoId && markerOf(c.body)?.kind === 'summary');
  /** The review comments on the repository's pull request (Qualor's threads are the first of each). */
  const reviewCommentsOf = (repoId: number) =>
    fake.reviewComments.filter((c) => c.repoId === repoId);
  const threadsOf = (repoId: number) => fake.reviewThreads.filter((t) => t.repoId === repoId);
  /** Whether the thread on each line is resolved (a test with one thread to a line). */
  const resolvedByLine = (repoId: number) =>
    Object.fromEntries(
      threadsOf(repoId).map((t) => [
        fake.reviewComments.find((c) => c.id === t.commentIds[0])?.line,
        t.resolved,
      ]),
    );
  /** What the requests changed on GitHub (an installation token or a GraphQL query changes nothing). */
  const writes = () => githubWrites(fake.requests);
  /** The writes that touch the pull request's threads: review comments and GraphQL mutations. */
  const threadWrites = () => writes().filter((w) => w.includes('/pulls/') || w.includes(GRAPHQL));
  /** The pull request review that carries a decoration's new threads. */
  const reviewPost = (repoName: string) => `POST /repos/acme/${repoName}/pulls/7/reviews`;
  const reviews = (repoName: string) => new RegExp(`^/repos/acme/${repoName}/pulls/7/reviews$`);
  const singleComments = (repoName: string) =>
    new RegExp(`^/repos/acme/${repoName}/pulls/7/comments$`);

  /** Enqueues the decoration of `analysisId` again, as its ingestion did: the same job. */
  const enqueueAgain = async (analysisId: string, repoId: number) => {
    const [analysis] = await h.ctx.db
      .select({ branchId: analyses.branchId })
      .from(analyses)
      .where(eq(analyses.id, analysisId));
    await enqueueDecoration(h.ctx.db, {
      analysisId,
      branchId: analysis!.branchId!,
      gitlab: null,
      github: { repositoryId: String(repoId), checkout: 'head' },
    });
  };

  beforeAll(async () => {
    fake = await createFakeGitHub();
    h = await createIngestHarness({ config: githubTestConfig(fake) });
    connectionId = await githubConnection(h, fake);
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });
  beforeEach(() => fake.clearRequests());

  it('sets a check run on a main-branch analysis, with its name, verdict and link', async () => {
    const repoId = nextRepo++;
    fake.addRepository({ id: repoId, owner: 'acme', name: 'main-only', installationId: 777 });
    const project = await mappedGitHubProject(h, fake, 'gh/main', 'acme/main-only', {
      connectionId,
    });
    const report = reportWith({ projectKey: project.key, revision: 'c'.repeat(40) });
    const analysisId = await project.ingestOk({
      ...report,
      scm: { ...report.scm, provider: 'github', github: { repositoryId: String(repoId) } },
    });
    expect(await runDecorations(h, githubDeps(h))).toBe(1);
    const [main] = await h.ctx.db.select().from(branches).where(eq(branches.projectId, project.id));
    expect(runsOf(repoId)).toEqual([
      expect.objectContaining({
        name: statusName(project.key),
        headSha: 'c'.repeat(40),
        conclusion: 'failure',
        title: 'Quality gate failed: new_issues 1 > 0',
        detailsUrl: `${PUBLIC_URL}/projects/${project.id}/branches/${main!.id}`,
        externalId: `qualor:v1:${analysisId}:${NO_ANNOTATIONS_DIGEST}`,
        annotations: [],
      }),
    ]);
    expect(runsOf(repoId)[0]?.summary?.startsWith('### ❌ Qualor: quality gate failed')).toBe(true);
    expect(fake.comments.filter((c) => c.repoId === repoId)).toEqual([]);
    expect(fake.reviewComments.filter((c) => c.repoId === repoId)).toEqual([]);
  });

  it('a pull request’s new issues become review threads and the check run has none', async () => {
    const { repo, ingest } = await setup('gh/pr');
    const analysisId = await ingest([1, 3, 4]); // line 1 is new code for Qualor, but not an added line of the diff
    await runDecorations(h, githubDeps(h));
    // The check run first, with the counts the plan gives (as GitLab's commit status comes first),
    // then the threads, both in one review, then the summary.
    expect(writes()).toEqual([
      `POST /repos/acme/${repo.name}/check-runs`,
      reviewPost(repo.name),
      `POST /repos/acme/${repo.name}/issues/7/comments`,
    ]);
    // One check run, with no annotation, and the constant digest.
    expect(runsOf(repo.id)).toHaveLength(1);
    const run = newestRun(repo.id)!;
    expect(run.annotations.length).toBe(0);
    expect(run.externalId?.endsWith(NO_ANNOTATIONS_DIGEST)).toBe(true);
    expect(run.externalId).toBe(`qualor:v1:${analysisId}:${NO_ANNOTATIONS_DIGEST}`);
    expect(parseCheckRunExternalId(run.externalId)).toEqual({
      analysisId,
      digest: NO_ANNOTATIONS_DIGEST,
    });
    const created = fake.requests.find(
      (r) => r.method === 'POST' && r.path === `/repos/acme/${repo.name}/check-runs`,
    );
    const output = (JSON.parse(created!.body) as { output: Record<string, unknown> }).output;
    expect(Object.keys(output).sort()).toEqual(['summary', 'title']);
    // Two review comments, on the two added lines, by the App, each the first of its thread.
    const comments = reviewCommentsOf(repo.id);
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => c.line).sort()).toEqual([3, 4]);
    for (const comment of comments) {
      expect(comment).toMatchObject({
        path: 'src/a.ts',
        side: 'RIGHT',
        commitId: HEAD,
        user: { login: `${fake.slug}[bot]`, type: 'Bot' },
        inReplyToId: null,
      });
      expect(markerOf(comment.body)?.kind).toBe('issue');
    }
    expect(threadsOf(repo.id)).toHaveLength(2);
    expect(threadsOf(repo.id).every((t) => !t.resolved)).toBe(true);
    // One summary, in review-comment words; the check run says the same.
    const sentence = '2 new issues are commented inline; 1 could not be placed on the diff.';
    expect(summaries(repo.id)).toHaveLength(1);
    expect(summaries(repo.id)[0]?.body).toContain(sentence);
    expect(summaries(repo.id)[0]?.user.login).toBe(`${fake.slug}[bot]`);
    expect(run.summary).toContain(sentence);
    expect(`${run.summary}${summaries(repo.id)[0]?.body}`).not.toMatch(/annotat/i);
  });

  it('a rerun changes nothing, and a new analysis with the same result only moves the check run', async () => {
    const { repo, ingest } = await setup('gh/rerun');
    const analysisId = await ingest([1, 3, 4]);
    await runDecorations(h, githubDeps(h));
    const run = newestRun(repo.id)!;
    const comments = reviewCommentsOf(repo.id).map((c) => c.id);
    // The same job again (github.md §11 #1): no POST or PATCH, and no GraphQL mutation. It did read
    // the threads (a GraphQL query), which is no change.
    fake.clearRequests();
    await enqueueAgain(analysisId, repo.id);
    await runDecorations(h, githubDeps(h));
    expect(fake.requests.some((r) => r.path === GRAPHQL)).toBe(true);
    expect(writes()).toEqual([]);
    // A new analysis with the same result: only the check run's analysis id moves (§6.1, a PATCH).
    fake.clearRequests();
    await ingest([1, 3, 4]);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([`PATCH /repos/acme/${repo.name}/check-runs/${run.id}`]);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(reviewCommentsOf(repo.id).map((c) => c.id)).toEqual(comments);
    expect(summaries(repo.id)).toHaveLength(1);
  });

  it('puts the state of the AI review in the summary comment and the check run, in GitHub’s words', async () => {
    const { project, repo, ingest } = await setup('gh/ai-section');
    const analysisId = await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(summaries(repo.id)[0]?.body).not.toContain('AI review');
    expect(newestRun(repo.id)?.summary).not.toContain('AI review');
    const [pull] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    const decorateAgain = async () => {
      fake.clearRequests();
      await enqueueAgain(analysisId, repo.id);
      await runDecorations(h, githubDeps(h));
      // The check run is written once, already with the section the comment gets after it.
      expect(writes().filter((w) => w.startsWith('PATCH') && w.includes('/check-runs/'))).toEqual([
        `PATCH /repos/acme/${repo.name}/check-runs/${newestRun(repo.id)!.id}`,
      ]);
      // The comment and the check run are edited in place, and say the same.
      expect(summaries(repo.id)).toHaveLength(1);
      expect(runsOf(repo.id)).toHaveLength(1);
      expect(newestRun(repo.id)?.summary).toBe(
        summaries(repo.id)[0]!.body.split('\n').slice(1).join('\n'),
      );
      return summaries(repo.id)[0]!.body;
    };

    const [run] = await h.ctx.db
      .insert(reviewRuns)
      .values({
        projectId: project.id,
        branchId: pull!.id,
        analysisId,
        status: 'running',
        phase: 'judge',
        deadlineAt: new Date(),
      })
      .returning();
    expect((await decorateAgain()).endsWith('\n\n#### AI review\n\nAI review in progress…')).toBe(
      true,
    );

    await h.ctx.db
      .update(reviewRuns)
      .set({ status: 'failed', phase: null, reason: 'provider_error' })
      .where(eq(reviewRuns.id, run!.id));
    expect(await decorateAgain()).toContain(
      'AI review failed: the model provider returned an error or could not be reached. The next push reviews again.',
    );

    // Done for another commit than the pull request is at now: GitHub's words for the move.
    await h.ctx.db
      .update(reviewRuns)
      .set({
        status: 'done',
        reason: null,
        headSha: '2'.repeat(40),
        summary: { verdict: 'Adds refunds.', walkthrough: [], notes: [] },
      })
      .where(eq(reviewRuns.id, run!.id));
    const done = await decorateAgain();
    expect(done).toContain('#### AI review\n\nAdds refunds.\n\nNo findings.');
    expect(done).toContain(
      'Reviewed commit: ` 222222222222 `; the pull request is now at ` 111111111111 `; the next workflow run reviews the new commits.',
    );
    expect(done).not.toContain('merge request');

    // The run of an older analysis a newer one superseded shows nothing.
    await h.ctx.db
      .update(reviewRuns)
      .set({ status: 'superseded' })
      .where(eq(reviewRuns.id, run!.id));
    expect(await decorateAgain()).not.toContain('AI review');
  });

  it('tells the check run of an older analysis its verdict and commit, and none of the branch’s findings', async () => {
    const { project, repo, ingest } = await setup('gh/ai-older');
    const older = await ingest([3]);
    // A newer analysis, of a later commit, comes before the older one is decorated again.
    const newer = await ingest(
      [3],
      { repositoryId: String(repo.id), checkout: 'head' },
      '2'.repeat(40),
    );
    const [pull] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    expect(pull?.lastAnalysisId).toBe(newer);
    const issueId = await seedAiIssue(h.ctx.db, {
      branchId: pull!.id,
      category: 'security',
      path: 'src/a.ts',
      line: 3,
      severity: 'high',
    });
    await h.ctx.db.insert(reviewFindings).values({
      issueId,
      category: 'security',
      body: 'Check the input first.',
      anchorLine: null,
      reviewedHeadSha: '1'.repeat(40),
    });
    const stored = { verdict: 'Adds refunds.', walkthrough: ['Adds an endpoint'], notes: [] };
    await h.ctx.db.insert(reviewRuns).values([
      {
        projectId: project.id,
        branchId: pull!.id,
        analysisId: older,
        status: 'done',
        deadlineAt: new Date(),
        headSha: HEAD,
        summary: stored,
      },
      {
        projectId: project.id,
        branchId: pull!.id,
        analysisId: newer,
        status: 'done',
        deadlineAt: new Date(),
        headSha: '2'.repeat(40),
        summary: stored,
      },
    ]);
    const checkRunOf = (sha: string) =>
      runsOf(repo.id)
        .filter((r) => r.headSha === sha)
        .at(-1)?.summary ?? null;

    await enqueueAgain(newer, repo.id);
    await runDecorations(h, githubDeps(h));
    await enqueueAgain(older, repo.id);
    await runDecorations(h, githubDeps(h));

    // The newest analysis shows the branch’s findings.
    const current = checkRunOf('2'.repeat(40));
    expect(current).toContain('**Findings:** 1 high · 0 medium · 0 low');
    expect(current).toContain('**Not on changed lines:**');
    // The older one is its own review: the verdict and the commit it covered, no counts, no lists.
    const past = checkRunOf(HEAD);
    expect(past).toContain('#### AI review\n\nAdds refunds.\n\nReviewed commit: ` 111111111111 `');
    for (const gone of [
      'Findings',
      'Not on changed lines',
      '<details>',
      'Adds an endpoint',
      'now at',
    ]) {
      expect(past, gone).not.toContain(gone);
    }
  });

  it('gives two issues on one line a thread each, and the same job again adds none', async () => {
    const { project, repo } = await setup('gh/tied');
    // Two issues of the same severity on the same line, from two rules.
    const analysisId = await project.ingestOk(
      pullRequestReport(7, HEAD, {
        projectKey: project.key,
        analysisDate: new Date(Date.UTC(2026, 8, 1, 10) + 86_400_000 * day++).toISOString(),
        engines: [engine('eslint')],
        files: [file('src/a.ts', { newLines: [[1, 60]] })],
        findings: ['no-debugger', 'no-console'].map((ruleId) =>
          finding({ path: 'src/a.ts', line: 3, ruleId }),
        ),
        github: { repositoryId: String(repo.id), checkout: 'head' },
      }),
    );
    await runDecorations(h, githubDeps(h));
    expect(reviewCommentsOf(repo.id).map((c) => c.line)).toEqual([3, 3]);
    expect(
      reviewCommentsOf(repo.id)
        .map((c) => /eslint:[\w-]+/.exec(c.body)?.[0])
        .sort(),
    ).toEqual(['eslint:no-console', 'eslint:no-debugger']);
    expect(threadsOf(repo.id)).toHaveLength(2);
    fake.clearRequests();
    await enqueueAgain(analysisId, repo.id);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([]);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(reviewCommentsOf(repo.id)).toHaveLength(2);
  });

  it('links each rule to its live documentation in the thread, the check run and the summary', async () => {
    const { project, repo } = await setup('gh/rule-links');
    const dead = 'https://rules.sonarsource.com/javascript/RSPEC-1871';
    const live =
      'https://sonarcloud.io/organizations/sonarsource/rules?open=javascript%3AS1871&rule_key=javascript%3AS1871';
    const ingest = () =>
      project.ingestOk(
        pullRequestReport(7, HEAD, {
          projectKey: project.key,
          analysisDate: new Date(Date.UTC(2026, 8, 1, 10) + 86_400_000 * day++).toISOString(),
          engines: [engine('eslint', [{ id: 'no-alert', helpUri: dead }])],
          files: [file('src/a.ts', { newLines: [[1, 60]] })],
          findings: [finding({ path: 'src/a.ts', line: 3, ruleId: 'no-alert' })],
          github: { repositoryId: String(repo.id), checkout: 'head' },
        }),
      );
    const analysisId = await ingest();
    await runDecorations(h, githubDeps(h));
    const run = newestRun(repo.id)!;
    const link = `[\` eslint:no-alert \`](${live})`;
    expect(reviewCommentsOf(repo.id)[0]?.body).toContain(link);
    expect(run.summary).toContain(link);
    expect(summaries(repo.id)[0]?.body).toContain(link);
    // The same job again changes nothing: the bodies are the same.
    fake.clearRequests();
    await enqueueAgain(analysisId, repo.id);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([]);
  });

  it('resolves the thread of a fixed issue and reopens it when the issue comes back, editing the check run and the summary in place', async () => {
    const { repo, ingest } = await setup('gh/fix');
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    const commentId = summaries(repo.id)[0]?.id;
    const run = newestRun(repo.id)!;
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    // Line 4 is fixed: its thread is resolved by the App, and the one check run is edited, not replaced.
    fake.clearRequests();
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([
      `PATCH /repos/acme/${repo.name}/check-runs/${run.id}`,
      `POST ${GRAPHQL} QualorResolveThread`,
      `PATCH /repos/acme/${repo.name}/issues/comments/${commentId}`,
    ]);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: true });
    expect(threadsOf(repo.id).find((t) => t.resolved)?.resolvedBy).toBe(`${fake.slug}[bot]`);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(newestRun(repo.id)?.annotations).toEqual([]);
    expect(newestRun(repo.id)?.summary).toContain('1 new issue is commented inline.');
    expect(summaries(repo.id).map((c) => c.id)).toEqual([commentId]);
    expect(summaries(repo.id)[0]?.body).toContain('1 new issue is commented inline.');
    expect(reviewCommentsOf(repo.id)).toHaveLength(2);
    // The issue comes back: the thread Qualor resolved is reopened, with no second thread.
    fake.clearRequests();
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toContain(`POST ${GRAPHQL} QualorUnresolveThread`);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    expect(reviewCommentsOf(repo.id)).toHaveLength(2);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(summaries(repo.id)[0]?.body).toContain('2 new issues are commented inline.');
  });

  it('leaves a thread a person resolved resolved, whatever becomes of its issue', async () => {
    const { repo, ingest } = await setup('gh/person-resolved');
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    // A person resolves the thread of line 4, which is then fixed, and detected again.
    const [thread] = threadsOf(repo.id).filter(
      (t) => fake.reviewComments.find((c) => c.id === t.commentIds[0])?.line === 4,
    );
    fake.resolveThreadAs(thread!.id, 'octocat');
    fake.clearRequests();
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    expect(writes().filter((w) => w.includes(GRAPHQL))).toEqual([]);
    expect(thread).toMatchObject({ resolved: true, resolvedBy: 'octocat' });
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: true });
    // Its issue is open, and has a thread: it counts.
    expect(summaries(repo.id)[0]?.body).toContain('2 new issues are commented inline.');
    expect(reviewCommentsOf(repo.id)).toHaveLength(2);
  });

  it('checkout other: no threads, and the summary says why', async () => {
    const { repo, ingest } = await setup('gh/merge');
    await ingest([3], { repositoryId: String(repo.id), checkout: 'other' });
    await runDecorations(h, githubDeps(h));
    expect(reviewCommentsOf(repo.id)).toEqual([]);
    expect(threadsOf(repo.id)).toEqual([]);
    expect(threadWrites()).toEqual([]);
    expect(newestRun(repo.id)?.annotations).toEqual([]);
    expect(summaries(repo.id)[0]?.body).toContain(CHECKOUT_OTHER);
    expect(newestRun(repo.id)?.summary).toContain(CHECKOUT_OTHER);
  });

  it('checkout other: leaves the threads it finds as they are', async () => {
    const { repo, ingest } = await setup('gh/merge-kept');
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    // Line 4 is fixed in the next analysis, but the workflow checked out the merge commit.
    fake.clearRequests();
    await ingest([3], { repositoryId: String(repo.id), checkout: 'other' });
    await runDecorations(h, githubDeps(h));
    expect(threadWrites()).toEqual([]);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    expect(reviewCommentsOf(repo.id)).toHaveLength(2);
    expect(summaries(repo.id)[0]?.body).toContain(CHECKOUT_OTHER);
    expect(newestRun(repo.id)?.summary).toContain(CHECKOUT_OTHER);
  });

  it('a stale head: no threads', async () => {
    const { repo, ingest } = await setup('gh/stale');
    fake.updatePull(repo.id, 7, { headSha: '2'.repeat(40) });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(reviewCommentsOf(repo.id)).toEqual([]);
    expect(threadsOf(repo.id)).toEqual([]);
    expect(threadWrites()).toEqual([]);
    expect(summaries(repo.id)[0]?.body).toContain(STALE);
    expect(summaries(repo.id)[0]?.body).toContain('the pull request is now at');
    expect(newestRun(repo.id)?.summary).toContain(STALE);
  });

  it('a stale head: leaves the threads it finds as they are', async () => {
    const { repo, ingest } = await setup('gh/stale-kept');
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    // The pull request moves on; the analysis of the old head fixes line 4, which is no one's to resolve.
    fake.updatePull(repo.id, 7, { headSha: '2'.repeat(40) });
    fake.clearRequests();
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(threadWrites()).toEqual([]);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    expect(summaries(repo.id)[0]?.body).toContain(STALE);
  });

  it('counts issues on a file without a patch as not placed', async () => {
    const { repo, ingest } = await setup('gh/binary', { files: [{ filename: 'src/a.ts' }] });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(newestRun(repo.id)?.annotations).toEqual([]);
    expect(reviewCommentsOf(repo.id)).toEqual([]);
    expect(summaries(repo.id)[0]?.body).toContain(
      '0 new issues are commented inline; 1 could not be placed on the diff.',
    );
  });

  it('counts the issues on files beyond the page bound as not placed, and places the others', async () => {
    const { project, repo } = await setup('gh/many-files', {
      files: [
        { filename: 'src/a.ts', patch: PATCH },
        { filename: 'src/b.ts', patch: PATCH },
      ],
    });
    const next = { link: '<https://x.example/?page=2>; rel="next"' };
    const first = {
      ...(githubShape<unknown[]>('pull_request_files')[0] as object),
      filename: 'src/a.ts',
      status: 'modified',
      patch: PATCH,
    };
    // Page 1 holds src/a.ts and every page up to the bound has a next one: src/b.ts is never read.
    fake.inject(
      'GET',
      new RegExp(`^/repos/acme/${repo.name}/pulls/7/files$`),
      { status: 200, body: [first], headers: next },
      ...Array.from({ length: MAX_FILE_PAGES - 1 }, () => ({
        status: 200,
        body: [],
        headers: next,
      })),
    );
    await project.ingestOk(
      pullRequestReport(7, HEAD, {
        projectKey: project.key,
        analysisDate: new Date(Date.UTC(2026, 8, 1, 10) + 86_400_000 * day++).toISOString(),
        engines: [engine('eslint')],
        files: [
          file('src/a.ts', { newLines: [[1, 60]] }),
          file('src/b.ts', { newLines: [[1, 60]] }),
        ],
        findings: ['src/a.ts', 'src/b.ts'].map((path) => finding({ path, line: 3 })),
        github: { repositoryId: String(repo.id), checkout: 'head' },
      }),
    );
    await runDecorations(h, githubDeps(h));
    expect(fake.requests.filter((r) => /\/pulls\/7\/files\?/.test(r.path))).toHaveLength(
      MAX_FILE_PAGES,
    );
    expect(reviewCommentsOf(repo.id).map((c) => c.path)).toEqual(['src/a.ts']);
    expect(summaries(repo.id)[0]?.body).toContain(
      '1 new issue is commented inline; 1 could not be placed on the diff.',
    );
  });

  it('corrects the check run’s counts with one PATCH when GitHub refuses a position', async () => {
    const { repo, ingest } = await setup('gh/refused');
    // GitHub refuses the review, then line 3 posted alone; line 4 alone it places.
    fake.inject('POST', reviews(repo.name), { status: 422, body: { message: 'Unprocessable' } });
    fake.inject('POST', singleComments(repo.name), {
      status: 422,
      body: { message: 'Validation Failed' },
    });
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    expect(reviewCommentsOf(repo.id).map((c) => c.line)).toEqual([4]);
    expect(runsOf(repo.id)).toHaveLength(1);
    const run = newestRun(repo.id)!;
    expect(writes()).toEqual([
      `POST /repos/acme/${repo.name}/check-runs`,
      reviewPost(repo.name),
      `POST /repos/acme/${repo.name}/pulls/7/comments`,
      `POST /repos/acme/${repo.name}/pulls/7/comments`,
      `POST /repos/acme/${repo.name}/issues/7/comments`,
      `PATCH /repos/acme/${repo.name}/check-runs/${run.id}`,
    ]);
    // The check run first said what the plan expected, and the PATCH says what came of it.
    const sent = (method: string) =>
      (
        JSON.parse(
          fake.requests.find((r) => r.method === method && r.path.includes('/check-runs'))!.body,
        ) as { output: { summary: string } }
      ).output.summary;
    expect(sent('POST')).toContain('2 new issues are commented inline.');
    const sentence = '1 new issue is commented inline; 1 could not be placed on the diff.';
    expect(sent('PATCH')).toContain(sentence);
    expect(run.summary).toContain(sentence);
    expect(run.annotations).toEqual([]);
    expect(summaries(repo.id)[0]?.body).toContain(sentence);
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('does not try a refused check run again without annotations, and goes on to the summary', async () => {
    const { repo, ingest } = await setup('gh/refused-run');
    fake.inject('POST', /check-runs$/, { status: 422, body: { message: 'Invalid request.' } });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    const posts = fake.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/check-runs'),
    );
    expect(posts).toHaveLength(1);
    expect(runsOf(repo.id)).toEqual([]);
    expect(summaries(repo.id)).toHaveLength(1);
    expect(reviewCommentsOf(repo.id)).toHaveLength(1);
    expect(await queuedDecorations(h)).toEqual([]); // a refusal is not retried
  });

  it('keeps one check run, one summary and the threads of its own issues per Qualor project of a monorepo', async () => {
    const first = await setup('gh/mono-a');
    const second = await setup('gh/mono-b', { repo: first.repo });
    await first.ingest([3]);
    await second.ingest([4]);
    await runDecorations(h, githubDeps(h));
    expect(new Set(runsOf(first.repo.id).map((r) => r.name))).toEqual(
      new Set([statusName(first.project.key), statusName(second.project.key)]),
    );
    expect(summaries(first.repo.id).map((c) => markerOf(c.body))).toEqual(
      expect.arrayContaining([
        { kind: 'summary', projectId: first.project.id },
        { kind: 'summary', projectId: second.project.id },
      ]),
    );
    // Each project made the thread of its own issue.
    expect(resolvedByLine(first.repo.id)).toEqual({ 3: false, 4: false });
    // Fixing A's issue resolves A's thread and leaves B's alone.
    await first.ingest([]);
    await runDecorations(h, githubDeps(h));
    expect(resolvedByLine(first.repo.id)).toEqual({ 3: true, 4: false });
    expect(reviewCommentsOf(first.repo.id)).toHaveLength(2);
  });

  it('never edits a person’s comment that carries a Qualor marker', async () => {
    const { project, repo, ingest } = await setup('gh/person');
    fake.addComment(repo.id, 7, {
      body: `<!-- qualor:summary ${project.id} -->\nI copied this`,
      login: 'dev',
    });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(fake.comments.find((c) => c.user.login === 'dev')?.body).toBe(
      `<!-- qualor:summary ${project.id} -->\nI copied this`,
    );
    expect(summaries(repo.id).filter((c) => c.user.type === 'Bot')).toHaveLength(1);
  });

  it('stops without retry when the workflow’s repository is not the mapped one', async () => {
    const { ingest } = await setup('gh/mismatch');
    await ingest([3], { repositoryId: '1', checkout: 'head' });
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([]);
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('waits as long as a secondary rate limit says, and makes no second thread on the retry', async () => {
    const { repo, ingest } = await setup('gh/limited');
    fake.inject('POST', /check-runs$/, {
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
      headers: { 'retry-after': '90' },
    });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    const [retry] = await queuedDecorations(h);
    expect(retry?.payload).toMatchObject({ attempt: 1 });
    // The check run comes first: refused, it stops the job before any thread or summary.
    expect(reviewCommentsOf(repo.id)).toEqual([]);
    expect(summaries(repo.id)).toEqual([]);
    // On the database clock: the retry is created and scheduled by it. Node's clock may differ
    // from the database container's by more than a second (the old check against Date.now()
    // failed with 88 904 ms against 89 000).
    const waits = (retry!.runAt.getTime() - retry!.createdAt.getTime()) / 1000;
    expect(waits).toBeGreaterThan(89);
    expect(waits).toBeLessThan(95);
    // The retry (made due now) then decorates; no job is left for the next test.
    await runDecorations(h, githubDeps(h));
    expect(await queuedDecorations(h)).toEqual([]);
    expect(reviewCommentsOf(repo.id)).toHaveLength(1);
    expect(threadsOf(repo.id)).toHaveLength(1);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(summaries(repo.id)).toHaveLength(1);
  });

  it('resolves and reopens at most the bound of threads per job, the rest in a later one', async () => {
    const { repo, ingest } = await setup('gh/update-cap');
    await ingest([3, 4, 5]);
    await runDecorations(h, githubDeps(h));
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false, 5: false });
    const resolved = () => threadsOf(repo.id).filter((t) => t.resolved).length;
    const capped = () => githubDeps(h, { maxThreadUpdates: 2 });
    fake.clearRequests();
    await ingest([]);
    await runDecorations(h, capped());
    expect(writes().filter((w) => w.includes(GRAPHQL))).toHaveLength(2);
    expect(resolved()).toBe(2);
    await ingest([]);
    await runDecorations(h, capped());
    expect(resolved()).toBe(3);
  });

  it('still writes the summary, saying the inline comments could not be updated, when GitHub refuses the review', async () => {
    const { repo, ingest } = await setup('gh/no-permission');
    fake.inject('POST', reviews(repo.name), {
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    });
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    expect(reviewCommentsOf(repo.id)).toEqual([]);
    expect(runsOf(repo.id)).toHaveLength(1);
    const run = newestRun(repo.id)!;
    expect(run.conclusion).toBe('failure');
    expect(run.annotations).toEqual([]);
    // The check run said what the plan expected; once the review failed, the summary comment and
    // the check run say the inline comments could not be updated, and count none.
    expect(writes()).toEqual([
      `POST /repos/acme/${repo.name}/check-runs`,
      reviewPost(repo.name),
      `POST /repos/acme/${repo.name}/issues/7/comments`,
      `PATCH /repos/acme/${repo.name}/check-runs/${run.id}`,
    ]);
    const sentence = 'Inline comments could not be updated this time.';
    expect(summaries(repo.id)).toHaveLength(1);
    expect(summaries(repo.id)[0]?.body).toContain(sentence);
    expect(summaries(repo.id)[0]?.body).not.toContain('commented inline');
    expect(run.summary).toContain(sentence);
    expect(await queuedDecorations(h)).toEqual([]); // a missing permission is not retried
  });

  it('goes on past a conversation the App may not resolve: the new thread is made, and the summary says how many stay as they are', async () => {
    // An App created before Qualor needed Contents (write), on an installation of its own.
    const id = nextRepo++;
    const installed: FakeRepository = {
      id,
      owner: 'acme',
      name: 'no-contents',
      installationId: id,
      permissions: { checks: 'write', issues: 'read', metadata: 'read', pull_requests: 'write' },
    };
    fake.addRepository(installed);
    fake.addPull(installed.id, {
      number: 7,
      title: 'Refunds',
      state: 'open',
      headSha: HEAD,
      baseSha: 'b'.repeat(40),
      files: [{ filename: 'src/a.ts', patch: PATCH }],
    });
    const { project, repo, ingest } = await setup('gh/no-contents', {
      repo: { id: installed.id, name: installed.name },
    });
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    const run = newestRun(repo.id)!;
    const summary = summaries(repo.id)[0]!;
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    // Line 4 is fixed and line 5 is new: no resolution is asked for, and the rest is written,
    // the check run once, already with what came of the threads.
    fake.clearRequests();
    const told: unknown[][] = [];
    const logger = { info: (...args: unknown[]) => void told.push(args), warn: () => undefined };
    const analysisId = await ingest([3, 5]);
    await runDecorations(h, githubDeps(h, { logger }));
    expect(writes()).toEqual([
      `PATCH /repos/acme/${repo.name}/check-runs/${run.id}`,
      reviewPost(repo.name),
      `PATCH /repos/acme/${repo.name}/issues/comments/${summary.id}`,
    ]);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false, 5: false });
    const line =
      '1 conversation could not be resolved or reopened: give the GitHub App Contents: Read and write.';
    for (const body of [summaries(repo.id)[0]!.body, newestRun(repo.id)!.summary!]) {
      expect(body).toContain('2 new issues are commented inline.');
      expect(body).toContain(line);
      expect(body).not.toContain('could not be updated');
    }
    expect(newestRun(repo.id)?.summary).toBe(
      summaries(repo.id)[0]!.body.split('\n').slice(1).join('\n'),
    );
    expect(told.filter(([, message]) => String(message).includes('Contents'))).toEqual([
      [
        { analysisId, connectionId: project.connectionId, unresolved: 1 },
        'GitHub conversations not resolved or reopened: the GitHub App needs Contents: Read and write',
      ],
    ]);
    expect(await queuedDecorations(h)).toEqual([]);
    // The same job again writes nothing: the check run and the summary already say it.
    fake.clearRequests();
    await enqueueAgain(analysisId, repo.id);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([]);
    // The owner grants Contents (write): the next decoration resolves the thread, and says nothing
    // more of it.
    installed.permissions = { ...installed.permissions, contents: 'write' };
    fake.clearRequests();
    await enqueueAgain(analysisId, repo.id);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([
      `PATCH /repos/acme/${repo.name}/check-runs/${run.id}`,
      `POST ${GRAPHQL} QualorResolveThread`,
      `PATCH /repos/acme/${repo.name}/issues/comments/${summary.id}`,
    ]);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: true, 5: false });
    expect(summaries(repo.id)[0]?.body).not.toContain('could not be resolved');
    expect(newestRun(repo.id)?.summary).not.toContain('could not be resolved');
  });

  it('ends the job after the check run when the review is rate limited, and the retry makes the rest with no duplicate', async () => {
    const { repo, ingest } = await setup('gh/review-limited');
    fake.inject('POST', reviews(repo.name), {
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
      headers: { 'retry-after': '90' },
    });
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    // Attempt 0: the check run, written first, then the refused review; nothing after it.
    expect(writes()).toEqual([`POST /repos/acme/${repo.name}/check-runs`, reviewPost(repo.name)]);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(reviewCommentsOf(repo.id)).toEqual([]);
    expect(summaries(repo.id)).toEqual([]);
    const queued = await queuedDecorations(h);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ attempt: 1 });
    // On the database clock, as in the test above.
    const waits = (queued[0]!.runAt.getTime() - queued[0]!.createdAt.getTime()) / 1000;
    expect(waits).toBeGreaterThan(89);
    expect(waits).toBeLessThan(95);
    // The retry: the threads, in one review, then the summary. The check run already said so.
    fake.clearRequests();
    await runDecorations(h, githubDeps(h));
    expect(await queuedDecorations(h)).toEqual([]);
    expect(writes()).toEqual([
      reviewPost(repo.name),
      `POST /repos/acme/${repo.name}/issues/7/comments`,
    ]);
    expect(reviewCommentsOf(repo.id).map((c) => c.line)).toEqual([3, 4]);
    expect(threadsOf(repo.id)).toHaveLength(2);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(summaries(repo.id)).toHaveLength(1);
    const sentence = '2 new issues are commented inline.';
    expect(newestRun(repo.id)?.summary).toContain(sentence);
    expect(summaries(repo.id)[0]?.body).toContain(sentence);
  });

  it('still writes the check run and the summary when the threads cannot be read, and the retry brings them', async () => {
    const { repo, ingest } = await setup('gh/threads-unreadable');
    fake.inject('POST', /^\/api\/graphql$/, { status: 502, body: { message: 'Server Error' } });
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    // A failure other than a rate limit: the check run and the summary say so, and the job is
    // retried (a 502 is transient).
    expect(writes()).toEqual([
      `POST /repos/acme/${repo.name}/check-runs`,
      `POST /repos/acme/${repo.name}/issues/7/comments`,
    ]);
    const failed = 'Inline comments could not be updated this time.';
    expect(newestRun(repo.id)?.summary).toContain(failed);
    expect(summaries(repo.id)[0]?.body).toContain(failed);
    expect(reviewCommentsOf(repo.id)).toEqual([]);
    expect((await queuedDecorations(h))[0]?.payload).toMatchObject({ attempt: 1 });
    fake.clearRequests();
    await runDecorations(h, githubDeps(h));
    expect(await queuedDecorations(h)).toEqual([]);
    const run = newestRun(repo.id)!;
    const summary = summaries(repo.id)[0]!;
    expect(writes()).toEqual([
      `PATCH /repos/acme/${repo.name}/check-runs/${run.id}`,
      reviewPost(repo.name),
      `PATCH /repos/acme/${repo.name}/issues/comments/${summary.id}`,
    ]);
    expect(run.summary).toContain('2 new issues are commented inline.');
    expect(summary.body).toContain('2 new issues are commented inline.');
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(summaries(repo.id)).toHaveLength(1);
  });

  it('writes the check run before it stops on a GraphQL rate limit, and waits for the limit’s reset', async () => {
    const { repo, ingest } = await setup('gh/graphql-limited');
    fake.inject('POST', /^\/api\/graphql$/, {
      status: 200,
      body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300),
      },
    });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(writes()).toEqual([`POST /repos/acme/${repo.name}/check-runs`]);
    expect(newestRun(repo.id)?.summary).toContain(
      'Inline comments could not be updated this time.',
    );
    expect(summaries(repo.id)).toEqual([]);
    const [retry] = await queuedDecorations(h);
    expect(retry?.payload).toMatchObject({ attempt: 1 });
    // Until the reset GitHub named (M3), on the database clock.
    const waits = (retry!.runAt.getTime() - retry!.createdAt.getTime()) / 1000;
    expect(waits).toBeGreaterThan(290);
    expect(waits).toBeLessThan(306);
    fake.clearRequests();
    await runDecorations(h, githubDeps(h));
    expect(await queuedDecorations(h)).toEqual([]);
    expect(reviewCommentsOf(repo.id)).toHaveLength(1);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(newestRun(repo.id)?.summary).toContain('1 new issue is commented inline.');
    expect(summaries(repo.id)).toHaveLength(1);
  });

  it('leaves the threads and the summary alone, and still sets the check run, when the pull request part fails', async () => {
    const { repo, ingest } = await setup('gh/pr-fails');
    await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    const run = newestRun(repo.id)!;
    const summary = summaries(repo.id)[0]!.body;
    const comments = reviewCommentsOf(repo.id).map((c) => c.id);
    expect(run.summary).toContain('2 new issues are commented inline.');
    fake.inject('GET', new RegExp(`^/repos/acme/${repo.name}/pulls/7$`), {
      status: 404,
      body: { message: 'Not Found' },
    });
    fake.clearRequests();
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    // The check run is edited in place (the gate and the analysis are the new ones, the digest is
    // always the same); the threads and the summary are as they were.
    expect(writes()).toEqual([`PATCH /repos/acme/${repo.name}/check-runs/${run.id}`]);
    expect(runsOf(repo.id)).toHaveLength(1);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    expect(reviewCommentsOf(repo.id).map((c) => c.id)).toEqual(comments);
    expect(summaries(repo.id)[0]?.body).toBe(summary);
    expect(newestRun(repo.id)?.annotations).toEqual([]);
  });

  it('leaves the threads alone when it decorates an analysis that is not the latest', async () => {
    const { repo, ingest } = await setup('gh/older');
    const older = await ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    expect(reviewCommentsOf(repo.id)).toHaveLength(2);
    fake.updatePull(repo.id, 7, { headSha: '2'.repeat(40) });
    await ingest([3, 4], undefined, '2'.repeat(40));
    await runDecorations(h, githubDeps(h));
    const onHead = runsOf(repo.id).filter((r) => r.headSha === HEAD);
    expect(onHead).toHaveLength(1);
    expect(reviewCommentsOf(repo.id)).toHaveLength(2);
    const summary = summaries(repo.id)[0]!.body;
    fake.clearRequests();
    await enqueueAgain(older, repo.id);
    await runDecorations(h, githubDeps(h));
    // Nothing is created, no thread is touched, and the pull request's summary is as it was.
    expect(writes().filter((w) => w.startsWith('POST'))).toEqual([]);
    expect(threadWrites()).toEqual([]);
    expect(runsOf(repo.id).filter((r) => r.headSha === HEAD)).toHaveLength(1);
    expect(resolvedByLine(repo.id)).toEqual({ 3: false, 4: false });
    expect(summaries(repo.id)[0]?.body).toBe(summary);
  });

  it('never edits another App’s bot comment that carries a Qualor marker', async () => {
    const { project, repo, ingest } = await setup('gh/other-bot');
    const foreign = `<!-- qualor:summary ${project.id} -->\nAnother App wrote this`;
    fake.addComment(repo.id, 7, { body: foreign, login: 'other-app[bot]', type: 'Bot' });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(fake.comments.find((c) => c.user.login === 'other-app[bot]')?.body).toBe(foreign);
    expect(summaries(repo.id).filter((c) => c.user.login === `${fake.slug}[bot]`)).toHaveLength(1);
  });

  it('never touches another App’s check run of the same name', async () => {
    const { project, repo, ingest } = await setup('gh/other-run');
    const analysisId = await ingest([3]);
    fake.checkRuns.push({
      id: 900_000 + repo.id,
      repoId: repo.id,
      appId: 1,
      name: statusName(project.key),
      headSha: HEAD,
      conclusion: 'success',
      externalId: `qualor:v1:${analysisId}:${NO_ANNOTATIONS_DIGEST}`,
      detailsUrl: null,
      title: 'theirs',
      summary: 'theirs',
      annotations: [],
    });
    fake.clearRequests();
    await runDecorations(h, githubDeps(h));
    const theirs = runsOf(repo.id).find((r) => r.appId === 1);
    expect(theirs).toMatchObject({ title: 'theirs', summary: 'theirs', conclusion: 'success' });
    expect(writes()).not.toContain(`PATCH /repos/acme/${repo.name}/check-runs/${theirs!.id}`);
    expect(runsOf(repo.id).filter((r) => r.appId === fake.appId)).toHaveLength(1);
  });

  describe('a check run of 0.11 (ruling T4)', () => {
    /** A check run as 0.11 made it: annotations on the lines, and their digest in the external id. */
    const oldRun = (repoId: number, name: string, externalId: string, withAnnotations: boolean) =>
      fake.addCheckRun(repoId, {
        name,
        headSha: HEAD,
        conclusion: 'failure',
        externalId,
        title: 'Quality gate failed: new_issues 2 > 0',
        summary: '2 new issues are annotated inline.',
        annotations: withAnnotations
          ? [3, 4].map((line) => ({
              path: 'src/a.ts',
              start_line: line,
              end_line: line,
              annotation_level: 'warning',
              title: 'Medium · maintainability · eslint:no-console',
              message: 'Problem',
            }))
          : [],
      });

    it('an analysis decorated by 0.11 gets one check run without annotations', async () => {
      const { project, repo, ingest } = await setup('gh/old-run');
      const analysisId = await ingest([3, 4]);
      const old = oldRun(
        repo.id,
        statusName(project.key),
        `qualor:v1:${analysisId}:0123456789abcdef`,
        true,
      );
      fake.clearRequests();
      await runDecorations(h, githubDeps(h));
      // GitHub cannot remove an annotation: a new check run replaces the old one, once.
      expect(runsOf(repo.id)).toHaveLength(2);
      const fresh = newestRun(repo.id)!;
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.annotations).toEqual([]);
      expect(fresh.externalId).toBe(`qualor:v1:${analysisId}:${NO_ANNOTATIONS_DIGEST}`);
      expect(old.annotations).toHaveLength(2);
      expect(writes().filter((w) => w.includes('/check-runs'))).toEqual([
        `POST /repos/acme/${repo.name}/check-runs`,
      ]);
      // The threads took the place of the annotations.
      expect(reviewCommentsOf(repo.id).map((c) => c.line)).toEqual([3, 4]);
      // The same job again: nothing but reads.
      fake.clearRequests();
      await enqueueAgain(analysisId, repo.id);
      await runDecorations(h, githubDeps(h));
      expect(writes()).toEqual([]);
      expect(runsOf(repo.id)).toHaveLength(2);
    });

    it('keeps a check run 0.11 made without annotations, and edits it in place', async () => {
      const { project, repo, ingest } = await setup('gh/old-run-bare');
      const analysisId = await ingest([3]);
      const old = oldRun(
        repo.id,
        statusName(project.key),
        `qualor:v1:${analysisId}:${NO_ANNOTATIONS_DIGEST}`,
        false,
      );
      fake.clearRequests();
      await runDecorations(h, githubDeps(h));
      expect(runsOf(repo.id)).toEqual([old]);
      expect(writes().filter((w) => w.includes('/check-runs'))).toEqual([
        `PATCH /repos/acme/${repo.name}/check-runs/${old.id}`,
      ]);
      expect(old.summary).toContain('1 new issue is commented inline.');
    });
  });

  it('creates no summary when the comment list is longer than it reads', async () => {
    const { repo, ingest } = await setup('gh/many-comments');
    fake.inject(
      'GET',
      new RegExp(`^/repos/acme/${repo.name}/issues/7/comments`),
      ...Array.from({ length: 50 }, () => ({
        status: 200,
        body: [],
        headers: { link: '<https://x.example/?page=2>; rel="next"' },
      })),
    );
    await ingest([3]);
    fake.clearRequests();
    await runDecorations(h, githubDeps(h));
    expect(fake.requests.filter((r) => r.path.includes('/issues/7/comments'))).toHaveLength(50);
    expect(writes().filter((w) => w.includes('/issues/'))).toEqual([]);
    expect(summaries(repo.id)).toEqual([]);
    expect(runsOf(repo.id)).toHaveLength(1);
    // The pull request part ran before: the thread is there.
    expect(reviewCommentsOf(repo.id)).toHaveLength(1);
  });

  it('records the pull request link only on the connection’s web base (GH13)', async () => {
    const { project, repo, ingest } = await setup('gh/links');
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    const branchOf = async () =>
      (
        await h.ctx.db
          .select({ mrUrl: branches.mrUrl, mrTitle: branches.mrTitle })
          .from(branches)
          .where(eq(branches.projectId, project.id))
      ).find((b) => b.mrTitle !== null);
    const webBase = fake.url.slice(0, -'/api/v3'.length);
    expect((await branchOf())?.mrUrl).toBe(`${webBase}/acme/${repo.name}/pull/7`);
    fake.inject('GET', new RegExp(`^/repos/acme/${repo.name}/pulls/7$`), {
      status: 200,
      body: {
        ...githubShape('pull_request'),
        number: 7,
        state: 'open',
        title: 'Refunds @all',
        html_url: `https://elsewhere.example/acme/${repo.name}/pull/7`,
        head: { ref: 'feature/x', sha: HEAD, label: 'x' },
        base: { ref: 'main', sha: 'b'.repeat(40), label: 'y' },
      },
    });
    await ingest([3]);
    await runDecorations(h, githubDeps(h));
    expect(await branchOf()).toMatchObject({ mrTitle: 'Refunds @all', mrUrl: null });
  });

  it('closed pull request: check run only', async () => {
    const closed = await setup('gh/closed');
    // Threads from while it was open; the pull request is then closed with line 4 fixed.
    await closed.ingest([3, 4]);
    await runDecorations(h, githubDeps(h));
    const summary = summaries(closed.repo.id)[0]!.body;
    expect(resolvedByLine(closed.repo.id)).toEqual({ 3: false, 4: false });
    fake.updatePull(closed.repo.id, 7, { state: 'closed' });
    fake.clearRequests();
    await closed.ingest([3]);
    // Another pull request is closed before its first decoration.
    const fresh = await setup('gh/closed-fresh');
    fake.updatePull(fresh.repo.id, 7, { state: 'closed' });
    await fresh.ingest([3]);
    await runDecorations(h, githubDeps(h));
    // The check run is set; no comment is written and no thread is touched.
    expect(runsOf(closed.repo.id)).toHaveLength(1);
    expect(runsOf(fresh.repo.id)).toHaveLength(1);
    expect(newestRun(closed.repo.id)?.annotations).toEqual([]);
    expect(threadWrites()).toEqual([]);
    expect(writes().filter((w) => w.includes('/issues/'))).toEqual([]);
    expect(resolvedByLine(closed.repo.id)).toEqual({ 3: false, 4: false });
    expect(reviewCommentsOf(closed.repo.id)).toHaveLength(2);
    expect(summaries(closed.repo.id)[0]?.body).toBe(summary);
    expect(summaries(fresh.repo.id)).toEqual([]);
    expect(reviewCommentsOf(fresh.repo.id)).toEqual([]);
    expect(threadsOf(fresh.repo.id)).toEqual([]);
  });

  it('sets only the check run of a pull request GitHub does not have', async () => {
    const gone = await setup('gh/gone');
    await gone.project.ingestOk(
      pullRequestReport(99, HEAD, {
        projectKey: gone.project.key,
        github: { repositoryId: String(gone.repo.id), checkout: 'head' },
      }),
    );
    await runDecorations(h, githubDeps(h));
    expect(runsOf(gone.repo.id)).toHaveLength(1);
    expect(reviewCommentsOf(gone.repo.id)).toEqual([]);
    expect(await queuedDecorations(h)).toEqual([]); // a 404 on the pull request is not retried
  });

  it('decorates only a report of its own provider', async () => {
    const { project, repo } = await setup('gh/provider');
    const gitlabReport = reportWith({ projectKey: project.key, revision: 'd'.repeat(40) }); // provider gitlab
    await project.ingestOk(gitlabReport);
    expect(await queuedDecorations(h)).toEqual([]);
    expect(runsOf(repo.id)).toEqual([]);
  });

  it('sends nothing with a private key that no longer decrypts', async () => {
    const own = await githubConnection(h, fake);
    const repoId = nextRepo++;
    fake.addRepository({ id: repoId, owner: 'acme', name: 'rotated', installationId: 777 });
    const project = await mappedGitHubProject(h, fake, 'gh/rotated', 'acme/rotated', {
      connectionId: own,
    });
    await h.ctx.db
      .update(scmConnections)
      .set({ tokenEnc: encryptSecret(encryptionKey('z'.repeat(32)), 'x', SCM_TOKEN_AAD) })
      .where(eq(scmConnections.id, own));
    const report = reportWith({ projectKey: project.key, revision: 'e'.repeat(40) });
    await project.ingestOk({ ...report, scm: { ...report.scm, provider: 'github' } });
    fake.clearRequests();
    await runDecorations(h, githubDeps(h));
    expect(fake.requests).toEqual([]);
  });
});
