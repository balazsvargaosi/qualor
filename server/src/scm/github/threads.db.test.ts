import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFakeGitHub,
  githubShape,
  githubWrites,
  reviewCommentNodeId,
  type FakeFile,
  type FakeGitHub,
  type FakeReviewComment,
  type FakeReviewThread,
} from '../../../test/fake-github';
import {
  githubConnection,
  githubTestConfig,
  mappedGitHubProject,
  pullRequestReport,
} from '../../../test/github';
import { createIngestHarness, type IngestHarness } from '../../../test/ingest';
import { engine, file, finding } from '../../../test/reports';
import { PUBLIC_URL } from '../../../test/scm';
import { analyses, issues } from '../../db/schema';
import { issueUrl } from '../decoration-data';
import { MAX_INLINE_THREADS, type InlineResult } from '../inline';
import { markerOf } from '../markdown';
import { credentialsId, MutationPacer, parseAppPrivateKey } from './app-auth';
import { GitHubClient, MAX_THREAD_PAGES } from './client';
import { MAX_COMMENT_PAGES as MAX_COMMENT_PAGES_OF_DECORATE } from './decorate';
import {
  applyReviewThreads,
  MAX_COMMENT_PAGES,
  MAX_GITHUB_THREAD_UPDATES,
  plannedCounts,
  planReviewThreads,
  type ReviewThreadContext,
} from './threads';

const HEAD = '1'.repeat(40);
const BASE = 'b'.repeat(40);
/** src/a.ts: lines 1–2 are context, lines 3–5 are added. */
const PATCH = '@@ -1,2 +1,5 @@\n a\n b\n+c\n+d\n+e';
const GRAPHQL = /^\/api\/graphql$/;
/** When a comment made by hand was made: no test here is about dates. */
const MADE = '2026-09-26T10:00:00Z';

/** The patch of a new file of `count` lines: every one is an added line. */
function newFile(count: number): string {
  return `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+l${i + 1}`).join('\n')}`;
}

/** A client on the fake, whose mutation pacing runs on a fake clock (no real second between them). */
function clientFor(fake: FakeGitHub): GitHubClient {
  const parsed = parseAppPrivateKey(fake.privateKeyPem);
  if (!('key' in parsed)) throw new Error('the fake has no usable key');
  let clock = 0;
  return new GitHubClient(
    {
      connectionId: 'threads-test',
      baseUrl: fake.url,
      appId: String(fake.appId),
      privateKey: parsed.key,
      credentials: credentialsId(String(fake.appId), parsed.pkcs8),
      allowInternalHosts: true,
    },
    {
      timeoutMs: 2_000,
      pacer: new MutationPacer(
        () => clock,
        async (ms) => void (clock += ms),
      ),
    },
  );
}

/** What a run of the reconciliation asked GitHub's GraphQL endpoint. */
interface GraphqlCall {
  operation: string | undefined;
  /** The thread a mutation is about. */
  id: string | undefined;
}
/** A review comment as the reconciliation POSTs it, in a review or alone. */
interface Creation {
  body: string;
  path: string;
  side: string;
  line: number;
}
/** A review comment POSTed alone, after GitHub refused the review. */
interface Single extends Creation {
  commit_id: string;
}
/** A pull request review as the reconciliation POSTs it: the run's new threads, together. */
interface Review {
  commit_id: string;
  event: string;
  body: string;
  comments: Creation[];
}
type ReportExtra = NonNullable<Parameters<typeof pullRequestReport>[2]>;

interface Scenario {
  project: Awaited<ReturnType<typeof mappedGitHubProject>>;
  repo: { id: number; name: string };
  /** The pull request's branch, known after the first ingestion. */
  branchId: string;
  /** Ingests a pull request report of #7 at the head with findings on `lines` of src/a.ts. */
  ingest(lines: number[], extra?: ReportExtra): Promise<string>;
  /**
   * The context of a run on #7, with a client of its own and the pull request's files. The
   * requests of the setup are forgotten, so `fake.requests` afterwards holds what the run sent.
   */
  context(overrides?: Partial<ReviewThreadContext>): Promise<ReviewThreadContext>;
  /** One run: `planReviewThreads`, then `applyReviewThreads` of its plan. */
  reconcile(overrides?: Partial<ReviewThreadContext>): Promise<InlineResult>;
}

describe('GitHub review threads (github.md §6.4)', () => {
  let h: IngestHarness;
  let fake: FakeGitHub;
  let connectionId: string;
  let botLogin: string;
  let nextRepo = 2000;
  /**
   * Ids of comments the tests make by hand: past 2^31 like GitHub's (and the fake's, from
   * 3 000 000 001), and far from the fake's own counter.
   */
  let nextForeign = 5_000_000_001;
  let day = 1;

  /** A mapped project on its own repository with an open pull request #7 at HEAD. */
  const setup = async (
    key: string,
    options: { files?: FakeFile[]; repo?: { id: number; name: string } } = {},
  ): Promise<Scenario> => {
    const repo = options.repo ?? { id: nextRepo++, name: key.replace(/\W/g, '-') };
    if (!options.repo) {
      fake.addRepository({ id: repo.id, owner: 'acme', name: repo.name, installationId: 777 });
      fake.addPull(repo.id, {
        number: 7,
        title: 'Threads',
        state: 'open',
        headSha: HEAD,
        baseSha: BASE,
        files: options.files ?? [{ filename: 'src/a.ts', patch: PATCH }],
      });
    }
    const project = await mappedGitHubProject(h, fake, key, `acme/${repo.name}`, { connectionId });
    const scenario: Scenario = {
      project,
      repo,
      branchId: '',
      ingest: async (lines, extra = {}) => {
        const analysisId = await project.ingestOk(
          pullRequestReport(7, HEAD, {
            projectKey: project.key,
            analysisDate: new Date(Date.UTC(2026, 8, 1, 10) + 86_400_000 * day++).toISOString(),
            engines: [engine('eslint')],
            files: [file('src/a.ts', { newLines: [[1, 60]] })],
            findings: lines.map((line) => finding({ path: 'src/a.ts', line })),
            github: { repositoryId: String(repo.id), checkout: 'head' },
            ...extra,
          }),
        );
        if (scenario.branchId === '') {
          const [row] = await h.ctx.db
            .select({ branchId: analyses.branchId })
            .from(analyses)
            .where(eq(analyses.id, analysisId));
          scenario.branchId = row!.branchId!;
        }
        return analysisId;
      },
      context: async (overrides = {}) => {
        const client = clientFor(fake);
        await client.useRepository({ owner: 'acme', repo: repo.name });
        const files = await client.pullRequestFiles('7', 30);
        fake.clearRequests();
        return {
          db: h.ctx.db,
          client,
          number: '7',
          projectId: project.id,
          branchId: scenario.branchId,
          headSha: HEAD,
          files: files.items,
          analyzers: true,
          botLogin,
          replies: null,
          issueUrl: (issueId) => issueUrl(PUBLIC_URL, project.id, issueId),
          ...overrides,
        };
      },
      reconcile: async (overrides = {}) => {
        const ctx = await scenario.context(overrides);
        // The AI review's findings are the subject of ai-threads.db.test.ts: these seed none.
        const { commented, unplaced, aiNotPosted } = await applyReviewThreads(
          ctx,
          await planReviewThreads(ctx),
        );
        expect(aiNotPosted).toEqual([]);
        return { commented, unplaced };
      },
    };
    return scenario;
  };

  // ─── What GitHub holds, and what a run sent ───

  const commentOf = (thread: FakeReviewThread): FakeReviewComment => {
    const first = fake.reviewComments.find((c) => c.id === thread.commentIds[0]);
    if (!first) throw new Error(`thread ${thread.id} has no first comment`);
    return first;
  };
  /** The threads the App itself made on the repository's pull request, oldest first. */
  const appThreads = (repoId: number) =>
    fake.reviewThreads.filter((t) => t.repoId === repoId && commentOf(t).user.login === botLogin);
  const threadAt = (repoId: number, line: number): FakeReviewThread => {
    const found = appThreads(repoId).find((t) => commentOf(t).line === line);
    if (!found) throw new Error(`no thread of the App on line ${line}`);
    return found;
  };
  /** Whether the App's thread on each line is resolved. */
  const resolvedByLine = (repoId: number) =>
    Object.fromEntries(appThreads(repoId).map((t) => [commentOf(t).line, t.resolved]));
  const graphqlCalls = (): GraphqlCall[] =>
    fake.requests
      .filter((r) => r.path === '/api/graphql')
      .map((r) => {
        const sent = JSON.parse(r.body) as { query: string; variables?: { id?: string } };
        return {
          operation: /^\s*(?:query|mutation)\s+(\w+)/.exec(sent.query)?.[1],
          id: sent.variables?.id,
        };
      });
  /** The resolve and reopen mutations of the run. */
  const mutations = () => graphqlCalls().filter((c) => c.operation !== 'QualorReviewThreads');
  const posted = <T>(path: RegExp): T[] =>
    fake.requests
      .filter((r) => r.method === 'POST' && path.test(r.path))
      .map((r) => JSON.parse(r.body) as T);
  /** The reviews the run POSTed. */
  const reviews = () => posted<Review>(/\/pulls\/7\/reviews$/);
  /** The review comments the run POSTed one at a time. */
  const singles = () => posted<Single>(/\/pulls\/7\/comments$/);
  /** Every review comment the run POSTed: in its review, then any posted alone. */
  const creations = (): Creation[] => [...reviews().flatMap((r) => r.comments), ...singles()];
  const requests = () => fake.requests.map((r) => `${r.method} ${r.path}`);
  const issueIdsByLine = async (projectId: string): Promise<Record<number, string>> =>
    Object.fromEntries(
      (
        await h.ctx.db
          .select({ id: issues.id, line: issues.startLine })
          .from(issues)
          .where(eq(issues.projectId, projectId))
      ).map((row) => [row.line, row.id]),
    );

  // ─── Comments and threads of other people, made by hand ───

  /**
   * A top-level review comment by someone else than the App on `line` of src/a.ts, the first of a
   * thread of its own; `older` puts it before everything listed so far.
   */
  const foreignThread = (
    repoId: number,
    line: number,
    body: string,
    who: { login: string; type: 'User' | 'Bot' } = { login: 'octocat', type: 'User' },
    older = false,
  ) => {
    const id = nextForeign++;
    const comment: FakeReviewComment = {
      id,
      repoId,
      pull: 7,
      body,
      path: 'src/a.ts',
      line,
      startLine: null,
      side: 'RIGHT',
      commitId: HEAD,
      user: { login: who.login, id: who.type === 'Bot' ? 41898283 : 5, type: who.type },
      inReplyToId: null,
      createdAt: MADE,
    };
    const thread: FakeReviewThread = {
      id: `PRRT_foreign${id}`,
      repoId,
      pull: 7,
      commentIds: [id],
      resolved: false,
      resolvedBy: null,
    };
    if (older) {
      fake.reviewComments.unshift(comment);
      fake.reviewThreads.unshift(thread);
    } else {
      fake.reviewComments.push(comment);
      fake.reviewThreads.push(thread);
    }
    return { comment, thread };
  };
  /** `count` conversations of people that are older than everything listed so far. */
  const olderConversations = (repoId: number, count: number) => {
    for (let i = 0; i < count; i++) {
      foreignThread(repoId, 1, `Earlier remark ${i}`, undefined, true);
    }
  };
  /** A thread of the App for `issueId` on `line`, as an earlier job would have made it. */
  const appThread = (repoId: number, line: number, issueId: string) => {
    const id = nextForeign++;
    fake.reviewComments.push({
      id,
      repoId,
      pull: 7,
      body: `<!-- qualor:issue ${issueId} -->\nMade earlier`,
      path: 'src/a.ts',
      line,
      startLine: null,
      side: 'RIGHT',
      commitId: HEAD,
      user: { login: botLogin, id: 41898282, type: 'Bot' },
      inReplyToId: null,
      createdAt: MADE,
    });
    fake.reviewThreads.push({
      id: `PRRT_app${id}`,
      repoId,
      pull: 7,
      commentIds: [id],
      resolved: false,
      resolvedBy: null,
    });
  };

  /**
   * A thread as GraphQL lists it, under `id` when the test wants GitHub to know another one, and
   * with `firstComment` as its first comment's node id when the test wants another one there.
   */
  const threadNode = (
    thread: FakeReviewThread,
    id = thread.id,
    firstComment = reviewCommentNodeId(thread.commentIds[0]!),
  ) => ({
    id,
    isResolved: thread.resolved,
    resolvedBy: thread.resolvedBy === null ? null : { login: thread.resolvedBy },
    comments: { nodes: [{ id: firstComment }] },
  });
  /** A GraphQL answer for the review threads query, with these thread nodes. */
  const threadsPage = (nodes: unknown[], hasNextPage = false) => ({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null },
            nodes,
          },
        },
      },
    },
  });

  beforeAll(async () => {
    fake = await createFakeGitHub();
    botLogin = `${fake.slug}[bot]`;
    h = await createIngestHarness({ config: githubTestConfig(fake) });
    connectionId = await githubConnection(h, fake);
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  it('keeps the bounds of the plan, and the comment bound where decoration finds it', () => {
    expect([MAX_COMMENT_PAGES, MAX_THREAD_PAGES, MAX_GITHUB_THREAD_UPDATES]).toEqual([50, 10, 100]);
    expect(MAX_COMMENT_PAGES_OF_DECORATE).toBe(MAX_COMMENT_PAGES);
  });

  it('creates one thread per new issue on an added line, at the head, all in one review', async () => {
    const s = await setup('threads/create');
    // Line 1 is new code for Qualor, but a context line of the diff.
    await s.ingest([1, 3, 4, 5]);
    expect(await s.reconcile()).toEqual({ commented: 3, unplaced: 1 });
    // One review carries the three comments: GitHub notifies once and adds one timeline entry.
    const [review, ...more] = reviews();
    expect(more).toEqual([]);
    expect(singles()).toEqual([]);
    expect(review).toMatchObject({ commit_id: HEAD, event: 'COMMENT' });
    // Its body is plain text after a marker line; GitHub requires one with COMMENT.
    expect(review!.body).toBe(
      `<!-- qualor:review ${s.project.id} -->\nQualor: 3 new issues on changed lines.`,
    );
    expect(review!.comments.map((c) => c.line).sort((a, b) => a - b)).toEqual([3, 4, 5]);
    const ids = await issueIdsByLine(s.project.id);
    for (const c of review!.comments) {
      expect(Object.keys(c).sort()).toEqual(['body', 'line', 'path', 'side']);
      expect(c).toMatchObject({ side: 'RIGHT', path: 'src/a.ts' });
      expect(c.body.split('\n')[0]).toBe(`<!-- qualor:issue ${ids[c.line]} -->`);
      expect(markerOf(c.body)).toEqual({ kind: 'issue', issueId: ids[c.line] });
      expect(c.body).toContain(`${PUBLIC_URL}/projects/${s.project.id}/issues/${ids[c.line]}`);
    }
    // GitHub made a thread of each comment, by the App, still open. The review's own body is no
    // review comment, so no thread: the next run finds the three, and posts nothing.
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false, 5: false });
    expect(fake.reviewComments.filter((c) => c.body.includes('qualor:review'))).toEqual([]);
    expect(await s.reconcile()).toEqual({ commented: 3, unplaced: 1 });
    expect(creations()).toEqual([]);
  });

  it('says one new issue in the review’s body when there is one', async () => {
    const s = await setup('threads/create-one');
    await s.ingest([4]);
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(reviews().map((r) => [r.body, r.comments.length])).toEqual([
      [`<!-- qualor:review ${s.project.id} -->\nQualor: 1 new issue on changed lines.`, 1],
    ]);
  });

  it(`creates at most ${MAX_INLINE_THREADS} threads, the most severe first`, async () => {
    const s = await setup('threads/cap', { files: [{ filename: 'src/a.ts', patch: newFile(60) }] });
    const lines = Array.from({ length: 60 }, (_, i) => i + 1);
    await s.ingest(lines, {
      findings: lines.map((line) =>
        finding({ path: 'src/a.ts', line, severity: line > 50 ? 'info' : 'high' }),
      ),
    });
    expect(await s.reconcile()).toEqual({ commented: 50, unplaced: 0 });
    // All 50 in one review: one paced request.
    expect(reviews().map((r) => r.comments.length)).toEqual([50]);
    expect(creations().map((c) => c.line)).toEqual(lines.slice(0, 50));
    // The next job has nothing to add: the 50 have their threads and the 10 least severe stay out.
    expect(await s.reconcile()).toEqual({ commented: 50, unplaced: 0 });
    expect(creations()).toEqual([]);
  });

  it('places nothing on a removed file or a file without a patch', async () => {
    const s = await setup('threads/unplaceable', {
      files: [
        { filename: 'src/removed.ts', status: 'removed', patch: PATCH },
        { filename: 'src/binary.ts' },
        { filename: 'src/a.ts', patch: PATCH },
      ],
    });
    const paths = ['src/removed.ts', 'src/binary.ts', 'src/a.ts'];
    await s.ingest([], {
      files: paths.map((path) => file(path, { newLines: [[1, 60]] })),
      findings: paths.map((path) => finding({ path, line: 3 })),
    });
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 2 });
    expect(creations().map((c) => c.path)).toEqual(['src/a.ts']);
  });

  it('resolves the thread of an issue that is fixed', async () => {
    const s = await setup('threads/fixed');
    await s.ingest([3, 4]);
    await s.reconcile();
    const gone = threadAt(s.repo.id, 4);
    await s.ingest([3]);
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(mutations()).toEqual([{ operation: 'QualorResolveThread', id: gone.id }]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: true });
    // GitHub names the App as the resolver, which is how a later run knows the resolution is its own.
    expect(gone.resolvedBy).toBe(botLogin);
    expect(creations()).toEqual([]);
  });

  it('reopens a thread Qualor resolved when its issue is open again', async () => {
    const s = await setup('threads/reopen');
    await s.ingest([3, 4]);
    await s.reconcile();
    await s.ingest([3]);
    await s.reconcile(); // resolves the thread on line 4
    const thread = threadAt(s.repo.id, 4);
    expect(thread).toMatchObject({ resolved: true, resolvedBy: botLogin });
    await s.ingest([3, 4]);
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(mutations()).toEqual([{ operation: 'QualorUnresolveThread', id: thread.id }]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false });
    expect(creations()).toEqual([]);
    expect(appThreads(s.repo.id)).toHaveLength(2);
    // A resolution by the App that this server did not make itself is Qualor's too.
    fake.resolveThreadAs(thread.id, botLogin);
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(mutations()).toEqual([{ operation: 'QualorUnresolveThread', id: thread.id }]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false });
  });

  it('never reopens a thread someone else resolved, and still counts its issue (ruling G3)', async () => {
    const s = await setup('threads/resolved-by-others');
    await s.ingest([3, 4, 5]);
    await s.reconcile();
    const person = threadAt(s.repo.id, 3);
    const otherApp = threadAt(s.repo.id, 4);
    const nameless = threadAt(s.repo.id, 5);
    fake.resolveThreadAs(person.id, 'octocat');
    fake.resolveThreadAs(otherApp.id, 'other-app[bot]');
    // GitHub names nobody, e.g. when the resolver's account is gone: not Qualor's either.
    Object.assign(nameless, { resolved: true, resolvedBy: null });
    // The issues are open still: the reviewers' decisions stand, and the issues count.
    await s.ingest([3, 4, 5]);
    expect(await s.reconcile()).toEqual({ commented: 3, unplaced: 0 });
    expect(mutations()).toEqual([]);
    expect(creations()).toEqual([]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: true, 5: true });
    expect([person.resolvedBy, otherApp.resolvedBy, nameless.resolvedBy]).toEqual([
      'octocat',
      'other-app[bot]',
      null,
    ]);
    // Fixed, then back: still never reopened, and never given a second thread.
    await s.ingest([]);
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    await s.ingest([3, 4, 5]);
    expect(await s.reconcile()).toEqual({ commented: 3, unplaced: 0 });
    expect(mutations()).toEqual([]);
    expect(creations()).toEqual([]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: true, 5: true });
    expect(appThreads(s.repo.id)).toHaveLength(3);
  });

  it('leaves open the thread of a fixed issue that someone else replied in', async () => {
    const s = await setup('threads/reply', {
      files: [{ filename: 'src/a.ts', patch: newFile(10) }],
    });
    await s.ingest([3, 4, 5, 6]);
    await s.reconcile();
    const reply = (line: number, login: string, type: 'User' | 'Bot') =>
      fake.replyToReviewComment(s.repo.id, 7, commentOf(threadAt(s.repo.id, line)).id, {
        body: 'A word on this.',
        login,
        type,
      });
    reply(3, 'octocat', 'User');
    reply(4, 'other-app[bot]', 'Bot');
    // The App's own reply is not someone else's.
    reply(5, botLogin, 'Bot');
    await s.ingest([]);
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations().map((m) => m.id)).toEqual([
      threadAt(s.repo.id, 5).id,
      threadAt(s.repo.id, 6).id,
    ]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false, 5: true, 6: true });
    // Nothing more, run after run: the people's threads are theirs to resolve.
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([]);
  });

  it('resolves again a thread of a fixed issue that a person reopened without a word', async () => {
    const s = await setup('threads/reopened-by-person');
    await s.ingest([3]);
    await s.reconcile();
    await s.ingest([]);
    await s.reconcile();
    const thread = threadAt(s.repo.id, 3);
    expect(thread.resolved).toBe(true);
    Object.assign(thread, { resolved: false, resolvedBy: null });
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([{ operation: 'QualorResolveThread', id: thread.id }]);
    expect(thread.resolved).toBe(true);
  });

  it('takes an issue that is a duplicate, or is not on the pull request’s branch, for no longer open', async () => {
    const s = await setup('threads/not-open');
    await s.ingest([3, 4, 5]);
    await s.reconcile();
    const ids = await issueIdsByLine(s.project.id);
    await h.ctx.db
      .update(issues)
      .set({ duplicateOfIssueId: ids[3]! })
      .where(eq(issues.id, ids[4]!));
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: threadAt(s.repo.id, 4).id },
    ]);
    // Seen from another branch, none of the issues is open: the rest of the threads are resolved.
    const elsewhere = '00000000-0000-4000-8000-000000000000';
    expect(await s.reconcile({ branchId: elsewhere })).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations().map((m) => m.id)).toEqual([
      threadAt(s.repo.id, 3).id,
      threadAt(s.repo.id, 5).id,
    ]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: true, 5: true });
  });

  it('does not take a comment that quotes a marker for one of its own threads', async () => {
    const s = await setup('threads/quote');
    await s.ingest([3, 4]);
    const ids = await issueIdsByLine(s.project.id);
    const quoted = (line: number) => `<!-- qualor:issue ${ids[line]} -->\nI copied this marker`;
    // Listed before anything the App makes, so a reading that trusted a marker would pick them.
    const person = foreignThread(s.repo.id, 3, quoted(3));
    const otherApp = foreignThread(s.repo.id, 4, quoted(4), {
      login: 'other-app[bot]',
      type: 'Bot',
    });
    // Both issues are open: Qualor makes its own threads, whatever the quotes say.
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(creations().map((c) => c.line)).toEqual([3, 4]);
    expect(appThreads(s.repo.id)).toHaveLength(2);
    // Both are fixed: only the App's own threads are resolved, and no quote is ever resolved.
    await s.ingest([]);
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations().map((m) => m.id)).toEqual(appThreads(s.repo.id).map((t) => t.id));
    expect([person.thread, otherApp.thread]).toEqual([
      expect.objectContaining({ resolved: false, resolvedBy: null }),
      expect.objectContaining({ resolved: false, resolvedBy: null }),
    ]);
    // The issues come back: the App reopens its own threads, and the quotes still play no part.
    await s.ingest([3, 4]);
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(mutations()).toHaveLength(2);
    expect(mutations().every((m) => m.operation === 'QualorUnresolveThread')).toBe(true);
    expect(creations()).toEqual([]);
  });

  it('does not take a reply for the thread of an issue, even the App’s own that starts with a marker', async () => {
    const s = await setup('threads/marker-reply');
    await s.ingest([3]);
    const ids = await issueIdsByLine(s.project.id);
    const person = foreignThread(s.repo.id, 4, 'Is this right?');
    fake.replyToReviewComment(s.repo.id, 7, person.comment.id, {
      body: `<!-- qualor:issue ${ids[3]} -->\nA reply`,
      login: botLogin,
      type: 'Bot',
    });
    // Only a top-level comment starts a thread of Qualor's: the issue still gets its own.
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(creations().map((c) => c.line)).toEqual([3]);
    expect(person.thread).toMatchObject({ resolved: false, resolvedBy: null });
  });

  it('creates no thread when the review comments run past the page bound, and resolves the threads it saw', async () => {
    const s = await setup('threads/cut-comments');
    await s.ingest([3, 4]);
    await s.reconcile();
    // 99 earlier comments of people: with a one-page bound the listing shows them and the App's
    // comment on line 3, but not its comment on line 4.
    olderConversations(s.repo.id, 99);
    // Line 3 is fixed, line 4 is open (its thread unseen), and line 5 is new.
    await s.ingest([4, 5]);
    expect(await s.reconcile({ maxCommentPages: 1 })).toEqual({ commented: 0, unplaced: 0 });
    expect(requests().filter((r) => r.includes('/pulls/7/comments'))).toEqual([
      `GET /repos/acme/${s.repo.name}/pulls/7/comments?per_page=100&page=1`,
    ]);
    // No thread for line 4 (it has one, unseen) nor for line 5, but the seen one is resolved.
    expect(creations()).toEqual([]);
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: threadAt(s.repo.id, 3).id },
    ]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: false });
    // Without the cut, line 4 is known and only line 5 gets its thread.
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(creations().map((c) => c.line)).toEqual([5]);
    expect(appThreads(s.repo.id)).toHaveLength(3);
  });

  it('creates no thread when the review threads run past the page bound, and resolves the threads it saw', async () => {
    const s = await setup('threads/cut-threads');
    await s.ingest([3, 4]);
    await s.reconcile();
    // The same, for the thread listing: line 3's thread is on its first page, line 4's is not.
    olderConversations(s.repo.id, 99);
    await s.ingest([4, 5]);
    // The comment on line 4 is listed without its thread: Qualor takes it as existing, and counts it.
    expect(await s.reconcile({ maxThreadPages: 1 })).toEqual({ commented: 1, unplaced: 0 });
    expect(graphqlCalls().map((c) => c.operation)).toEqual([
      'QualorReviewThreads',
      'QualorResolveThread',
    ]);
    expect(creations()).toEqual([]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: false });
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(creations().map((c) => c.line)).toEqual([5]);
    expect(appThreads(s.repo.id)).toHaveLength(3);
  });

  it(`reads at most ${MAX_COMMENT_PAGES} pages of review comments, and creates nothing past them`, async () => {
    const s = await setup('threads/default-comment-bound');
    await s.ingest([3]);
    fake.inject(
      'GET',
      new RegExp(`^/repos/acme/${s.repo.name}/pulls/7/comments$`),
      ...Array.from({ length: MAX_COMMENT_PAGES }, () => ({
        status: 200,
        body: [],
        headers: { link: '<https://x.example/?page=2>; rel="next"' },
      })),
    );
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(requests().filter((r) => r.includes('/pulls/7/comments'))).toHaveLength(
      MAX_COMMENT_PAGES,
    );
    expect(creations()).toEqual([]);
    expect(appThreads(s.repo.id)).toEqual([]);
  });

  it(`reads at most ${MAX_THREAD_PAGES} pages of review threads, and creates nothing past them`, async () => {
    const s = await setup('threads/default-thread-bound');
    await s.ingest([3]);
    fake.inject(
      'POST',
      GRAPHQL,
      ...Array.from({ length: MAX_THREAD_PAGES }, () => ({
        status: 200,
        body: threadsPage([], true),
      })),
    );
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(graphqlCalls()).toHaveLength(MAX_THREAD_PAGES);
    expect(creations()).toEqual([]);
    expect(appThreads(s.repo.id)).toEqual([]);
  });

  it('leaves the threads of another Qualor project on the same pull request alone', async () => {
    const a = await setup('threads/mono-a');
    const b = await setup('threads/mono-b', { repo: a.repo });
    await a.ingest([3]);
    await b.ingest([4]);
    expect(await a.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    // B sees A's thread, whose issue it does not have, and leaves it open.
    expect(await b.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(mutations()).toEqual([]);
    expect(resolvedByLine(a.repo.id)).toEqual({ 3: false, 4: false });
    // A's issue is fixed: A resolves its own thread, not B's.
    await a.ingest([]);
    expect(await a.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: threadAt(a.repo.id, 3).id },
    ]);
    expect(resolvedByLine(a.repo.id)).toEqual({ 3: true, 4: false });
    // A's issue comes back while its thread is resolved by the App: B, which has no such issue,
    // does not reopen it; A does.
    await a.ingest([3]);
    expect(await b.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(mutations()).toEqual([]);
    expect(resolvedByLine(a.repo.id)).toEqual({ 3: true, 4: false });
    expect(await a.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorUnresolveThread', id: threadAt(a.repo.id, 3).id },
    ]);
    // B's issue is fixed: B resolves its thread, and A's open one stays as it is.
    await b.ingest([]);
    expect(await b.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: threadAt(b.repo.id, 4).id },
    ]);
    expect(resolvedByLine(a.repo.id)).toEqual({ 3: false, 4: true });
    expect(appThreads(a.repo.id)).toHaveLength(2);
  });

  it('sends nothing but reads when nothing changed', async () => {
    const s = await setup('threads/idempotent');
    await s.ingest([3, 4]);
    await s.reconcile();
    const reads = [
      `GET /repos/acme/${s.repo.name}/pulls/7/comments?per_page=100&page=1`,
      'POST /api/graphql',
    ];
    // After the threads were made ...
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(requests()).toEqual(reads);
    expect(graphqlCalls().map((c) => c.operation)).toEqual(['QualorReviewThreads']);
    // ... after one was resolved ...
    await s.ingest([3]);
    await s.reconcile();
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(requests()).toEqual(reads);
    expect(graphqlCalls().map((c) => c.operation)).toEqual(['QualorReviewThreads']);
    // ... and after it was reopened.
    await s.ingest([3, 4]);
    await s.reconcile();
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(requests()).toEqual(reads);
    expect(graphqlCalls().map((c) => c.operation)).toEqual(['QualorReviewThreads']);
  });

  it('resolves or reopens at most the bound of threads per run, the rest in later runs', async () => {
    const s = await setup('threads/update-cap');
    await s.ingest([3, 4, 5]);
    await s.reconcile();
    await s.ingest([]);
    // The oldest threads go first, so what waits for the next run is the same on every machine.
    expect(await s.reconcile({ maxThreadUpdates: 2 })).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toHaveLength(2);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: true, 5: false });
    expect(await s.reconcile({ maxThreadUpdates: 2 })).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: threadAt(s.repo.id, 5).id },
    ]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: true, 5: true });
    expect(await s.reconcile({ maxThreadUpdates: 2 })).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([]);
  });

  it(`resolves at most ${MAX_GITHUB_THREAD_UPDATES} threads per run when nothing smaller is set`, async () => {
    const count = MAX_GITHUB_THREAD_UPDATES + 1;
    const lines = Array.from({ length: count }, (_, i) => i + 1);
    const s = await setup('threads/default-update-cap', {
      files: [{ filename: 'src/a.ts', patch: newFile(count) }],
    });
    const wide = { files: [file('src/a.ts', { newLines: [[1, count]] })] };
    await s.ingest(lines, wide);
    // The threads an earlier job made: Qualor creates 50 a run, which is not what this tests.
    const ids = await issueIdsByLine(s.project.id);
    for (const line of lines) appThread(s.repo.id, line, ids[line]!);
    await s.ingest([], wide);
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toHaveLength(MAX_GITHUB_THREAD_UPDATES);
    // The newest thread is the one that waits.
    expect(appThreads(s.repo.id).filter((t) => !t.resolved)).toEqual([threadAt(s.repo.id, count)]);
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: threadAt(s.repo.id, count).id },
    ]);
    expect(appThreads(s.repo.id).every((t) => t.resolved)).toBe(true);
  });

  it('goes on when GitHub no longer has a thread it meant to resolve', async () => {
    const s = await setup('threads/deleted');
    await s.ingest([3, 4]);
    await s.reconcile();
    const gone = threadAt(s.repo.id, 3);
    const kept = threadAt(s.repo.id, 4);
    await s.ingest([]);
    // The listing shows line 3's thread under an id GitHub does not have any more (a person
    // deleted its comments after the listing): resolving it is a GraphQL NOT_FOUND, which skips it.
    fake.inject('POST', GRAPHQL, {
      status: 200,
      body: threadsPage([threadNode(gone, 'PRRT_deleted'), threadNode(kept)]),
    });
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: 'PRRT_deleted' },
      { operation: 'QualorResolveThread', id: kept.id },
    ]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: true });
  });

  it('does not count an open issue whose thread GitHub no longer has when it is reopened', async () => {
    const s = await setup('threads/deleted-open');
    await s.ingest([3, 4]);
    await s.reconcile();
    const gone = threadAt(s.repo.id, 3);
    const kept = threadAt(s.repo.id, 4);
    fake.resolveThreadAs(gone.id, botLogin);
    await s.ingest([3, 4]);
    // Line 3's thread was resolved by the App, and GitHub no longer has it when it is reopened.
    fake.inject('POST', GRAPHQL, {
      status: 200,
      body: threadsPage([threadNode(gone, 'PRRT_deleted'), threadNode(kept)]),
    });
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(mutations()).toEqual([{ operation: 'QualorUnresolveThread', id: 'PRRT_deleted' }]);
    expect(creations()).toEqual([]);
  });

  it('ties each thread to its comment by node id, with comment ids past 2^31 (C1)', async () => {
    const s = await setup('threads/node-ids');
    await s.ingest([3, 4]);
    await s.reconcile();
    // GitHub's review comment ids no longer fit GraphQL's 32-bit `databaseId`; the fake's do not.
    const ids = appThreads(s.repo.id).map((t) => commentOf(t).id);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => id > 2 ** 31)).toBe(true);
    await s.ingest([3]);
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 0 });
    expect(mutations()).toEqual([
      { operation: 'QualorResolveThread', id: threadAt(s.repo.id, 4).id },
    ]);
    // The query asked for the first comment's node id only.
    const queries = fake.requests
      .filter((r) => r.path === '/api/graphql')
      .map((r) => (JSON.parse(r.body) as { query: string }).query);
    expect(queries.some((q) => q.includes('comments(first: 1) { nodes { id } }'))).toBe(true);
    expect(queries.some((q) => /databaseid/i.test(q))).toBe(false);
  });

  it('takes a comment whose thread GraphQL ties to another node id for existing, and leaves it alone', async () => {
    const s = await setup('threads/unmatched-node');
    await s.ingest([3, 4, 5]);
    await s.reconcile();
    const [t3, t4, t5] = [3, 4, 5].map((line) => threadAt(s.repo.id, line));
    // Line 3 is fixed, lines 4 and 5 are open.
    await s.ingest([4, 5]);
    // GraphQL ties the threads of lines 3 and 4 to node ids the REST listing does not have.
    fake.inject('POST', GRAPHQL, {
      status: 200,
      body: threadsPage([
        threadNode(t3!, t3!.id, 'PRRC_elsewhere3'),
        threadNode(t4!, t4!.id, 'PRRC_elsewhere4'),
        threadNode(t5!),
      ]),
    });
    // Their comments count as existing, as when the listing does not show their threads: nothing
    // is created for them, line 3's thread is not resolved, and line 4's open issue still counts.
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(mutations()).toEqual([]);
    expect(creations()).toEqual([]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false, 5: false });
  });

  it('takes a review comment whose in_reply_to_id is null for the first comment of its thread (M1)', async () => {
    const s = await setup('threads/null-reply-to');
    await s.ingest([3]);
    await s.reconcile();
    const thread = threadAt(s.repo.id, 3);
    const own = commentOf(thread);
    await s.ingest([]);
    // GitHub may send the field as null on a first comment: the listing stays readable, and the
    // comment is still the first of Qualor's thread.
    fake.inject('GET', new RegExp(`^/repos/acme/${s.repo.name}/pulls/7/comments$`), {
      status: 200,
      body: [
        {
          ...githubShape('pull_request_review_comment'),
          id: own.id,
          node_id: reviewCommentNodeId(own.id),
          body: own.body,
          user: own.user,
          path: own.path,
          line: own.line,
          in_reply_to_id: null,
        },
      ],
    });
    expect(await s.reconcile()).toEqual({ commented: 0, unplaced: 0 });
    expect(mutations()).toEqual([{ operation: 'QualorResolveThread', id: thread.id }]);
    expect(thread.resolved).toBe(true);
  });

  it('posts the comments one at a time when GitHub refuses the review, and counts a refused position as not placed', async () => {
    const s = await setup('threads/refused');
    await s.ingest([3, 4]);
    // A position of the review GitHub will not place: it makes none of the review's comments.
    fake.inject('POST', new RegExp(`^/repos/acme/${s.repo.name}/pulls/7/reviews$`), {
      status: 422,
      body: { message: 'Unprocessable Entity', errors: ['Line could not be resolved'] },
    });
    fake.inject('POST', new RegExp(`^/repos/acme/${s.repo.name}/pulls/7/comments$`), {
      status: 422,
      body: { message: 'Validation Failed' },
    });
    expect(await s.reconcile()).toEqual({ commented: 1, unplaced: 1 });
    // The review, then each comment alone, as before: GitHub refused line 3, and placed line 4.
    expect(reviews().map((r) => r.comments.map((c) => c.line))).toEqual([[3, 4]]);
    expect(singles().map((c) => [c.line, c.commit_id, c.side])).toEqual([
      [3, HEAD, 'RIGHT'],
      [4, HEAD, 'RIGHT'],
    ]);
    expect(appThreads(s.repo.id).map((t) => commentOf(t).line)).toEqual([4]);
    // The next run tries the refused one again (there is no memory of it, as on GitLab).
    expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
    expect(reviews().map((r) => r.comments.map((c) => c.line))).toEqual([[3]]);
    expect(singles()).toEqual([]);
  });

  it('places every comment alone when only the review was refused', async () => {
    const s = await setup('threads/refused-review');
    await s.ingest([3, 4, 5]);
    fake.inject('POST', new RegExp(`^/repos/acme/${s.repo.name}/pulls/7/reviews$`), {
      status: 422,
      body: { message: 'Unprocessable Entity' },
    });
    expect(await s.reconcile()).toEqual({ commented: 3, unplaced: 0 });
    expect(singles().map((c) => c.line)).toEqual([3, 4, 5]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false, 5: false });
    expect(await s.reconcile()).toEqual({ commented: 3, unplaced: 0 });
    expect(creations()).toEqual([]);
  });

  it('plans from the listings with reads only, and writes when the plan is applied', async () => {
    const s = await setup('threads/plan');
    await s.ingest([3, 4]);
    await s.reconcile();
    // Line 4 is fixed, line 5 is new.
    await s.ingest([3, 5]);
    const ctx = await s.context();
    const plan = await planReviewThreads(ctx);
    expect(githubWrites(fake.requests)).toEqual([]);
    expect(plan).toMatchObject({
      updates: [{ threadId: threadAt(s.repo.id, 4).id, resolve: true }],
      creations: [{ path: 'src/a.ts', line: 5 }],
      // What the counts are once the plan is applied: the check run's first text.
      commented: 2,
      unplaced: 0,
      aiNotPosted: [],
    });
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false });
    expect(await applyReviewThreads(ctx, plan)).toEqual({
      commented: 2,
      unplaced: 0,
      unresolved: 0,
      aiNotPosted: [],
    });
    expect(githubWrites(fake.requests)).toEqual([
      'POST /api/graphql QualorResolveThread',
      `POST /repos/acme/${s.repo.name}/pulls/7/reviews`,
    ]);
    expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: true, 5: false });
  });

  describe('a conversation the App may not resolve or reopen (it lacks Contents: write)', () => {
    /** The permissions of an App created before Qualor needed Contents (write). */
    const WITHOUT_CONTENTS = {
      checks: 'write',
      issues: 'read',
      metadata: 'read',
      pull_requests: 'write',
    } as const;
    const FORBIDDEN = {
      data: { resolveReviewThread: null },
      errors: [
        {
          type: 'FORBIDDEN',
          path: ['resolveReviewThread'],
          message: 'Resource not accessible by integration',
        },
      ],
    };

    it('skips each update it may not make, counts it, and still creates the new threads', async () => {
      // An installation of its own, which grants no Contents (write).
      const id = nextRepo++;
      fake.addRepository({
        id,
        owner: 'acme',
        name: 'no-contents',
        installationId: id,
        permissions: WITHOUT_CONTENTS,
      });
      fake.addPull(id, {
        number: 7,
        title: 'Threads',
        state: 'open',
        headSha: HEAD,
        baseSha: BASE,
        files: [{ filename: 'src/a.ts', patch: PATCH }],
      });
      const s = await setup('threads/no-contents', { repo: { id, name: 'no-contents' } });
      await s.ingest([3, 4]);
      expect(await s.reconcile()).toEqual({ commented: 2, unplaced: 0 });
      // Line 4 is fixed and line 5 is new: the resolution is not asked for, and the thread is made.
      await s.ingest([3, 5]);
      const ctx = await s.context();
      expect(ctx.client.mayResolveThreads).toBe(false);
      const plan = await planReviewThreads(ctx);
      expect(plan.updates).toEqual([
        { threadId: threadAt(s.repo.id, 4).id, resolve: true, counted: false },
      ]);
      // What the check run says before anything is applied is what applying the plan comes to.
      expect(plannedCounts(plan, ctx.client.mayResolveThreads)).toEqual({
        commented: 2,
        unplaced: 0,
        unresolved: 1,
      });
      expect(await applyReviewThreads(ctx, plan)).toEqual({
        commented: 2,
        unplaced: 0,
        unresolved: 1,
        aiNotPosted: [],
      });
      expect(mutations()).toEqual([]);
      expect(creations().map((c) => c.line)).toEqual([5]);
      expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false, 5: false });
      // Line 3's thread was resolved by the App when it could, and its issue is open: the
      // reopening is not made either, and the open issue whose thread stays resolved does not
      // count, as one whose thread is gone.
      fake.resolveThreadAs(threadAt(s.repo.id, 3).id, botLogin);
      const again = await s.context();
      const replan = await planReviewThreads(again);
      expect(replan.updates).toEqual([
        { threadId: threadAt(s.repo.id, 3).id, resolve: false, counted: true },
        { threadId: threadAt(s.repo.id, 4).id, resolve: true, counted: false },
      ]);
      expect(plannedCounts(replan, again.client.mayResolveThreads)).toEqual({
        commented: 1,
        unplaced: 0,
        unresolved: 2,
      });
      expect(await applyReviewThreads(again, replan)).toEqual({
        commented: 1,
        unplaced: 0,
        unresolved: 2,
        aiNotPosted: [],
      });
      expect(mutations()).toEqual([]);
      expect(creations()).toEqual([]);
      expect(resolvedByLine(s.repo.id)).toEqual({ 3: true, 4: false, 5: false });
    });

    it('takes GitHub’s FORBIDDEN for an update it may not make: the thread stays, and the rest goes on', async () => {
      const s = await setup('threads/forbidden');
      await s.ingest([3, 4, 5]);
      await s.reconcile();
      // Lines 4 and 5 are fixed: GitHub refuses the first resolution (a token asked before the
      // installation lost Contents (write)), and the second is made.
      await s.ingest([3]);
      const ctx = await s.context();
      const plan = await planReviewThreads(ctx);
      fake.inject('POST', GRAPHQL, { status: 200, body: FORBIDDEN });
      expect(await applyReviewThreads(ctx, plan)).toEqual({
        commented: 1,
        unplaced: 0,
        unresolved: 1,
        aiNotPosted: [],
      });
      expect(mutations()).toEqual([
        { operation: 'QualorResolveThread', id: threadAt(s.repo.id, 4).id },
        { operation: 'QualorResolveThread', id: threadAt(s.repo.id, 5).id },
      ]);
      expect(resolvedByLine(s.repo.id)).toEqual({ 3: false, 4: false, 5: true });
    });
  });

  describe('the people’s replies it finds for Qualor to answer (6I-4)', () => {
    /** Where the plan looks for new replies: nothing is in the ledger, and an hour back counts. */
    const window = (over: Partial<NonNullable<ReviewThreadContext['replies']>> = {}) => ({
      largestNoteIds: new Map<string, number>(),
      since: new Date(Date.now() - 3_600_000),
      ...over,
    });
    const person = { body: 'This is intended.', login: 'octocat' };
    const roundsOf = async (s: Scenario, replies: ReviewThreadContext['replies']) =>
      (await planReviewThreads(await s.context({ replies }))).rounds;
    const round = (first: FakeReviewComment, issueId: string | undefined, notes: number[]) => ({
      threadId: String(first.id),
      issueId,
      noteIds: notes,
      newest: notes.at(-1),
      author: 'octocat',
    });

    it('plans a round for the new replies in Qualor’s threads, read from the listings', async () => {
      const s = await setup('threads/rounds');
      await s.ingest([3, 4]);
      await s.reconcile();
      const ids = await issueIdsByLine(s.project.id);
      const first = commentOf(threadAt(s.repo.id, 3));
      const one = fake.replyToReviewComment(s.repo.id, 7, first.id, person);
      const two = fake.replyToReviewComment(s.repo.id, 7, first.id, person);
      fake.clearRequests();
      // Both replies are one round, keyed by the newest, for the issue of the thread.
      expect(await roundsOf(s, window())).toEqual([round(first, ids[3], [one.id, two.id])]);
      // The plan reads what it always reads: the comments and the threads, nothing more.
      expect(requests()).toEqual([
        `GET /repos/acme/${s.repo.name}/pulls/7/comments?per_page=100&page=1`,
        'POST /api/graphql',
      ]);
      // Without a window AI review is not active for the project, and Qualor answers none.
      expect(await roundsOf(s, null)).toEqual([]);
      // The ledger holds the first reply: only the second is new. It holds both: nothing is.
      const held = (note: number) =>
        window({ largestNoteIds: new Map([[String(first.id), note]]) });
      expect(await roundsOf(s, held(one.id))).toEqual([round(first, ids[3], [two.id])]);
      expect(await roundsOf(s, held(two.id))).toEqual([]);
      // Nothing written before `since` is new.
      expect(await roundsOf(s, window({ since: new Date(Date.now() + 60_000) }))).toEqual([]);
    });

    it('plans the rounds it saw when the threads, or the comments, run past the page bound', async () => {
      // The thread listing is cut: line 3's thread is on its first page, line 4's is not, so its
      // reply waits for a later job, and the reply in line 3's thread is a round now.
      const cutThreads = await setup('threads/rounds-cut-threads');
      await cutThreads.ingest([3, 4]);
      await cutThreads.reconcile();
      const [on3, on4] = [3, 4].map((line) => commentOf(threadAt(cutThreads.repo.id, line)));
      const seen = fake.replyToReviewComment(cutThreads.repo.id, 7, on3!.id, person);
      fake.replyToReviewComment(cutThreads.repo.id, 7, on4!.id, person);
      olderConversations(cutThreads.repo.id, 99);
      const ctx = await cutThreads.context({ replies: window(), maxThreadPages: 1 });
      const plan = await planReviewThreads(ctx);
      expect(plan.creations).toEqual([]);
      expect(plan.rounds.map((r) => r.noteIds)).toEqual([[seen.id]]);

      // The comment listing is cut: the reply is on its first page, and a later comment is not.
      const cutComments = await setup('threads/rounds-cut-comments');
      await cutComments.ingest([3, 4]);
      await cutComments.reconcile();
      const first = commentOf(threadAt(cutComments.repo.id, 3));
      const reply = fake.replyToReviewComment(cutComments.repo.id, 7, first.id, person);
      olderConversations(cutComments.repo.id, 97);
      foreignThread(cutComments.repo.id, 5, 'A comment on the second page.');
      const cut = await planReviewThreads(
        await cutComments.context({ replies: window(), maxCommentPages: 1 }),
      );
      expect(cut.creations).toEqual([]);
      expect(cut.rounds.map((r) => r.noteIds)).toEqual([[reply.id]]);
    });

    it('plans the rounds of every thread of Qualor’s on the pull request: the queue keeps the project’s own', async () => {
      const a = await setup('threads/rounds-mono-a');
      const b = await setup('threads/rounds-mono-b', { repo: a.repo });
      await a.ingest([3]);
      await b.ingest([4]);
      await a.reconcile();
      await b.reconcile();
      const onA = commentOf(threadAt(a.repo.id, 3));
      const onB = commentOf(threadAt(a.repo.id, 4));
      const forA = fake.replyToReviewComment(a.repo.id, 7, onA.id, person);
      const forB = fake.replyToReviewComment(a.repo.id, 7, onB.id, person);
      // Both projects' plans list both replies, each with the issue its thread is for.
      const ids = {
        ...(await issueIdsByLine(a.project.id)),
        ...(await issueIdsByLine(b.project.id)),
      };
      for (const scenario of [a, b]) {
        const rounds = await roundsOf(scenario, window());
        expect(rounds.map((r) => [r.noteIds, r.issueId])).toEqual([
          [[forA.id], ids[3]],
          [[forB.id], ids[4]],
        ]);
      }
    });
  });
});
