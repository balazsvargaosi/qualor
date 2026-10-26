import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, type FakeGitHub } from '../../test/fake-github';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import {
  deliveryTo,
  githubConnection,
  githubDeps,
  githubTestConfig,
  mappedGitHubProject,
  pullRequestReport,
  sign,
} from '../../test/github';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import { queuedAnswers, reviewOff, reviewOn, reviewScope, scanJob } from '../../test/replies';
import { decorationDeps, silentLogger } from '../../test/scm';
import { analyses, branches, jobs, projects, reviewReplies } from '../db/schema';
import { createLlmRuntime } from '../llm/job';
import { runUntilIdle } from '../queue/worker';
import type { ReviewJobDeps } from '../review/job';
import { replyHandlers } from '../review/reply-job';
import { AI_REPLY_QUEUE, replyKey } from '../review/reply-queue';
import { parseInternalHosts } from '../scm/url';

const HEAD = '1'.repeat(40);

/*
 * The comment events of the App's webhook (6I-4): a person's new comment on a pull request, a reply
 * in a review thread or a note on the pull request's page, queues one scan of that pull request's
 * notes (review/reply-scan.ts), so that a reply in one of Qualor's threads, or a `qualor review`,
 * is answered at once rather than at the next analysis. The payload is only a pointer: the
 * comment's words are never read, and the scan reads the notes through the API.
 */

/** The GitHub repository of the pull request the tests read: `acme/api`. */
const ACME = 424242;
const COMMENT_EVENTS = ['pull_request_review_comment', 'issue_comment'] as const;

interface CommentOptions {
  action?: string;
  repositoryId?: number;
  number?: number;
  /** The comment author's account type: `User`, or `Bot` for an App. */
  type?: string;
  text?: string;
}

/** GitHub's `pull_request_review_comment` event (webhook events and payloads): what Qualor reads, and more. */
const reviewCommentEvent = (o: CommentOptions = {}) => ({
  action: o.action ?? 'created',
  comment: {
    id: 3_000_000_777,
    in_reply_to_id: 3_000_000_001,
    body: o.text ?? 'thanks',
    user: { login: 'octocat', id: 583_231, type: o.type ?? 'User' },
  },
  pull_request: { id: 1_000_007, number: o.number ?? 7, state: 'open' },
  repository: { id: o.repositoryId ?? ACME, full_name: 'acme/api' },
  sender: { login: 'octocat', id: 583_231, type: o.type ?? 'User' },
  installation: { id: 777 },
});

/** GitHub's `issue_comment` event: on a pull request's page (`issue.pull_request` is there), or on an issue's. */
const issueCommentEvent = (o: CommentOptions & { pullRequest?: boolean } = {}) => ({
  action: o.action ?? 'created',
  issue: {
    id: 2_000_007,
    number: o.number ?? 7,
    state: 'open',
    ...(o.pullRequest === false
      ? {}
      : {
          pull_request: { url: 'https://api.github.com/repos/acme/api/pulls/7', merged_at: null },
        }),
  },
  comment: {
    id: 4_000_777,
    body: o.text ?? 'qualor review',
    user: { login: 'octocat', id: 583_231, type: o.type ?? 'User' },
  },
  repository: { id: o.repositoryId ?? ACME, full_name: 'acme/api' },
  sender: { login: 'octocat', id: 583_231, type: o.type ?? 'User' },
  installation: { id: 777 },
});
const commentEvent = {
  pull_request_review_comment: reviewCommentEvent,
  issue_comment: issueCommentEvent,
} as const;

describe('GitHub comment webhooks (6I-4)', () => {
  let h: IngestHarness;
  let fake: FakeGitHub;
  let llm: FakeLlm;
  let connectionId: string;
  /** The branch of pull request 7 of the Qualor project mapped to repository `ACME`. */
  let acmeBranch: string;
  /** A repository of its own for each test that maps more projects. */
  let nextRepository = 5_000;

  const deliver = deliveryTo(
    () => h,
    () => connectionId,
  );

  /** The `ai-reply` jobs there are, whatever their branch and their state. */
  const allJobs = () => h.ctx.db.select().from(jobs).where(eq(jobs.queue, AI_REPLY_QUEUE));
  const clearJobs = () => h.ctx.db.delete(jobs).where(eq(jobs.queue, AI_REPLY_QUEUE));
  /** The scans of the branch that wait to run. */
  const scansOf = async (branchId: string) =>
    (await queuedAnswers(h.ctx.db, branchId)).jobs.filter(
      (job) => (job.payload as { kind?: string }).kind === 'scan' && job.status === 'queued',
    );
  const branchOf = async (projectId: string) =>
    (
      await h.ctx.db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.projectId, projectId), eq(branches.kind, 'merge_request')))
    )[0]!.id;
  /**
   * A Qualor project mapped to a repository of its own (`repositoryId`, a new one unless given),
   * with its pull request 7 analysed in a GitHub context of that repository, on the connection
   * (`repo` is the name it is mapped to: the fake's repository for the first project).
   */
  const mapped = async (
    key: string,
    options: { repositoryId?: number; repo?: string; connection?: string } = {},
  ) => {
    const repositoryId = options.repositoryId ?? nextRepository++;
    const project = await mappedGitHubProject(
      h,
      fake,
      key,
      options.repo ?? `acme/r${repositoryId}`,
      { connectionId: options.connection ?? connectionId },
    );
    await project.ingestOk(
      pullRequestReport(7, HEAD, {
        projectKey: project.key,
        github: { repositoryId: String(repositoryId), checkout: 'head' },
      }),
    );
    return { project, repositoryId, branchId: await branchOf(project.id) };
  };
  const jobDeps = (): ReviewJobDeps => ({
    db: h.ctx.db,
    config: h.ctx.config,
    logger: silentLogger,
    llmCircuit: createLlmRuntime().circuit,
    scm: decorationDeps(h).scm,
    scmRuntime: githubDeps(h).runtime,
    shutdown: new AbortController().signal,
  });
  /** Runs the `ai-reply` jobs that are due, as the review worker does. */
  const worker = () => runUntilIdle(h.ctx.db, replyHandlers(jobDeps()), silentLogger);
  /** The scan job as the review worker runs it, alone: what it queues stays queued. */
  const scan = (branchId: string) =>
    replyHandlers(jobDeps())[AI_REPLY_QUEUE]!({
      id: randomUUID(),
      queue: AI_REPLY_QUEUE,
      concurrencyKey: replyKey(branchId),
      payload: { kind: 'scan', branchId },
      attempts: 1,
      maxAttempts: 2,
    });

  beforeAll(async () => {
    llm = await createFakeLlm();
    fake = await createFakeGitHub();
    fake.addRepository({ id: ACME, owner: 'acme', name: 'api', installationId: 777 });
    fake.addPull(ACME, {
      number: 7,
      title: 'x',
      state: 'open',
      headSha: HEAD,
      baseSha: 'b'.repeat(40),
      files: [],
    });
    h = await createIngestHarness({
      config: { ...githubTestConfig(fake), llmInternalHosts: parseInternalHosts(llm.host) },
    });
    connectionId = await githubConnection(h, fake);
    // Analysed with AI review off, then switched on for the organisation.
    const acme = await mapped('hooks/comments', { repositoryId: ACME, repo: 'acme/api' });
    acmeBranch = acme.branchId;
    await reviewOn(h, llm);
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
    await llm.close();
  });
  beforeEach(async () => {
    await clearJobs();
    await h.ctx.db.delete(reviewReplies);
    fake.comments.splice(0);
    fake.reviewComments.splice(0);
    fake.reviewThreads.splice(0);
  });

  it('a review comment reply event queues one scan for its pull request', async () => {
    const res = await deliver('pull_request_review_comment', reviewCommentEvent());
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await queuedAnswers(h.ctx.db, acmeBranch)).jobs).toEqual([scanJob(acmeBranch)]);
    expect(await allJobs()).toHaveLength(1);
    // Nothing is written to the ledger: the scan reads the notes and decides.
    expect((await queuedAnswers(h.ctx.db, acmeBranch)).rows).toEqual([]);
  });

  it('an issue comment on a pull request queues one scan for it, and one on an issue queues none', async () => {
    expect((await deliver('issue_comment', issueCommentEvent())).statusCode).toBe(204);
    expect((await queuedAnswers(h.ctx.db, acmeBranch)).jobs).toEqual([scanJob(acmeBranch)]);
    expect(await allJobs()).toHaveLength(1);
    await clearJobs();
    // An issue that has the pull request's number is no pull request: it has no `pull_request`.
    const onIssue = await deliver('issue_comment', issueCommentEvent({ pullRequest: false }));
    expect(onIssue.statusCode).toBe(204);
    expect(await allJobs()).toEqual([]);
  });

  it.each(
    COMMENT_EVENTS.flatMap((event) =>
      ['edited', 'deleted', 'Created', 'pinned', ''].map((action) => [event, action] as const),
    ),
  )('the event %s with the action %j is ignored: 204 and no scan', async (event, action) => {
    expect((await deliver(event, commentEvent[event]({ action }))).statusCode).toBe(204);
    expect(await allJobs()).toEqual([]);
    // The same comment, created, does queue one: nothing else about it was wrong.
    expect((await deliver(event, commentEvent[event]())).statusCode).toBe(204);
    expect(await scansOf(acmeBranch)).toHaveLength(1);
  });

  it('ignores a delivery id it has seen, on either event: the scan ran, so only the id tells the retry from a new comment', async () => {
    const delivery = randomUUID();
    expect(
      (await deliver('pull_request_review_comment', reviewCommentEvent(), { delivery })).statusCode,
    ).toBe(204);
    expect(await scansOf(acmeBranch)).toHaveLength(1);
    expect(await worker()).toBe(1);
    expect(await scansOf(acmeBranch)).toHaveLength(0);
    // GitHub's redelivery of the same delivery is the same delivery.
    expect(
      (await deliver('pull_request_review_comment', reviewCommentEvent(), { delivery })).statusCode,
    ).toBe(204);
    expect((await deliver('issue_comment', issueCommentEvent(), { delivery })).statusCode).toBe(
      204,
    );
    expect(await scansOf(acmeBranch)).toHaveLength(0);
    // Another id is another delivery.
    await deliver('pull_request_review_comment', reviewCommentEvent());
    expect(await scansOf(acmeBranch)).toHaveLength(1);
  });

  it.each(COMMENT_EVENTS)(
    'a comment by a Bot (the App’s own answer) queues no scan: %s',
    async (event) => {
      expect((await deliver(event, commentEvent[event]({ type: 'Bot' }))).statusCode).toBe(204);
      expect(await allJobs()).toEqual([]);
      // A person's comment on the same pull request does.
      expect((await deliver(event, commentEvent[event]())).statusCode).toBe(204);
      expect(await scansOf(acmeBranch)).toHaveLength(1);
    },
  );

  it('queues nothing for another pull request of the repository: the number tells them apart', async () => {
    for (const event of COMMENT_EVENTS) {
      expect((await deliver(event, commentEvent[event]({ number: 8 }))).statusCode).toBe(204);
    }
    expect(await allJobs()).toEqual([]);
    expect((await deliver('issue_comment', issueCommentEvent())).statusCode).toBe(204);
    expect(await scansOf(acmeBranch)).toHaveLength(1);
  });

  it('queues nothing for a repository id that is not the one the analysis stored', async () => {
    for (const event of COMMENT_EVENTS) {
      const res = await deliver(event, commentEvent[event]({ repositoryId: 5 }));
      expect(res.statusCode).toBe(204);
    }
    expect(await allJobs()).toEqual([]);
  });

  it('tells pull requests of the same number in different repositories apart by the repository id', async () => {
    const other = await mapped('hooks/other-repository');
    await deliver('issue_comment', issueCommentEvent({ repositoryId: other.repositoryId }));
    expect((await allJobs()).map((job) => job.concurrencyKey)).toEqual([replyKey(other.branchId)]);
    await clearJobs();
    await deliver('issue_comment', issueCommentEvent());
    expect((await allJobs()).map((job) => job.concurrencyKey)).toEqual([replyKey(acmeBranch)]);
  });

  it.each([
    ['no stored context (an analysis from before the column)', null],
    ['an invalid stored context', { invalid: true }],
    [
      'no GitHub context (an older CLI)',
      { provider: 'github', mergeRequestId: '7', gitlab: null, github: null },
    ],
    [
      'no repository id',
      { provider: 'github', mergeRequestId: '7', gitlab: null, github: { checkout: 'head' } },
    ],
  ])('queues nothing for a pull request whose analysis has %s', async (_, scmContext) => {
    const own = await mapped(`hooks/no-context-${nextRepository}`);
    // With its context it queues a scan, so the context alone makes the difference.
    await deliver('issue_comment', issueCommentEvent({ repositoryId: own.repositoryId }));
    expect(await scansOf(own.branchId)).toHaveLength(1);
    await clearJobs();
    await h.ctx.db
      .update(analyses)
      .set({ scmContext })
      .where(eq(analyses.projectId, own.project.id));
    for (const event of COMMENT_EVENTS) {
      const res = await deliver(event, commentEvent[event]({ repositoryId: own.repositoryId }));
      expect(res.statusCode).toBe(204);
    }
    expect(await allJobs()).toEqual([]);
  });

  it('queues nothing for a pull request whose branch has no newest analysis', async () => {
    const own = await mapped('hooks/no-newest');
    await h.ctx.db
      .update(branches)
      .set({ lastAnalysisId: null })
      .where(eq(branches.id, own.branchId));
    await deliver('issue_comment', issueCommentEvent({ repositoryId: own.repositoryId }));
    expect(await allJobs()).toEqual([]);
  });

  it('makes one scan of five comment events for a pull request while its scan is queued', async () => {
    for (const event of [...COMMENT_EVENTS, ...COMMENT_EVENTS, 'issue_comment' as const]) {
      expect((await deliver(event, commentEvent[event]())).statusCode).toBe(204);
    }
    expect(await scansOf(acmeBranch)).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
  });

  it('makes one scan of comment events that arrive at once', async () => {
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const event = COMMENT_EVENTS[i % 2]!;
        return deliver(event, commentEvent[event]());
      }),
    );
    expect(answers.map((answer) => answer.statusCode)).toEqual([204, 204, 204, 204, 204, 204]);
    expect(await scansOf(acmeBranch)).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
  });

  it('queues nothing for a project without AI review: it is off, or the project is not in its scope', async () => {
    await reviewOff(h);
    try {
      expect((await deliver('issue_comment', issueCommentEvent())).statusCode).toBe(204);
      expect(await allJobs()).toEqual([]);
    } finally {
      await reviewOn(h, llm);
    }
    await reviewScope(h, 'selected');
    try {
      expect((await deliver('pull_request_review_comment', reviewCommentEvent())).statusCode).toBe(
        204,
      );
      expect(await allJobs()).toEqual([]);
    } finally {
      await reviewOn(h, llm);
    }
    expect((await deliver('issue_comment', issueCommentEvent())).statusCode).toBe(204);
    expect(await scansOf(acmeBranch)).toHaveLength(1);
  });

  it('queues nothing for a project that is no longer mapped to the connection', async () => {
    const lone = await mapped('hooks/unmapped');
    await h.ctx.db
      .update(projects)
      .set({ scmConnectionId: null })
      .where(eq(projects.id, lone.project.id));
    await deliver('issue_comment', issueCommentEvent({ repositoryId: lone.repositoryId }));
    expect(await allJobs()).toEqual([]);
  });

  it('queues nothing for a comment delivered to another connection, even of the same App and secret', async () => {
    const other = await githubConnection(h, fake);
    for (const event of COMMENT_EVENTS) {
      const res = await deliver(event, commentEvent[event](), { connection: other });
      expect(res.statusCode).toBe(204);
    }
    expect(await allJobs()).toEqual([]);
  });

  it('keeps a delivery id per connection: the same delivery to two connections whose Apps share a repository is each one’s', async () => {
    const other = await githubConnection(h, fake);
    // A project of the second connection that analysed pull request 7 of the same repository.
    const second = await mapped('hooks/comments-second', {
      repositoryId: ACME,
      repo: 'acme/api',
      connection: other,
    });
    const delivery = randomUUID();
    for (const connection of [connectionId, other]) {
      const res = await deliver('pull_request_review_comment', reviewCommentEvent(), {
        delivery,
        connection,
      });
      expect(res.statusCode).toBe(204);
    }
    expect(await scansOf(acmeBranch)).toHaveLength(1);
    expect(await scansOf(second.branchId)).toHaveLength(1);
  });

  it('queues nothing for an analysis whose stored context is not GitHub’s, whatever repository it names', async () => {
    const { branchId, repositoryId } = await mapped('hooks/comments-not-github');
    // As no ingestion writes it: a GitLab context that carries a GitHub block.
    await h.ctx.db.execute(
      sql`UPDATE analyses SET scm_context = jsonb_set(scm_context, '{provider}', '"gitlab"')
           WHERE id = (SELECT last_analysis_id FROM branches WHERE id = ${branchId})`,
    );
    await deliver('pull_request_review_comment', reviewCommentEvent({ repositoryId }));
    expect(await scansOf(branchId)).toEqual([]);
  });

  it('queues one scan for each Qualor project of a monorepo: those that stored the same repository', async () => {
    const repositoryId = nextRepository++;
    const a = await mapped('hooks/mono-a', { repositoryId });
    const b = await mapped('hooks/mono-b', { repositoryId });
    await deliver('issue_comment', issueCommentEvent({ repositoryId }));
    const queued = await allJobs();
    expect(queued.map((job) => job.concurrencyKey).sort()).toEqual(
      [a.branchId, b.branchId].map(replyKey).sort(),
    );
    expect(queued.map((job) => (job.payload as { branchId: string }).branchId).sort()).toEqual(
      [a.branchId, b.branchId].sort(),
    );
  });

  it('reads only pull requests: a plain branch named like the number is none', async () => {
    const own = await mapped('hooks/plain-branch');
    await h.ctx.db.update(branches).set({ kind: 'branch' }).where(eq(branches.id, own.branchId));
    await deliver('issue_comment', issueCommentEvent({ repositoryId: own.repositoryId }));
    expect(await allJobs()).toEqual([]);
  });

  const unreadable: [string, (event: (typeof COMMENT_EVENTS)[number]) => unknown][] = [
    ['an empty object', () => ({})],
    ['a JSON array', (event) => [commentEvent[event]()]],
    ['JSON null', () => null],
    ['a JSON number', () => 7],
    ['no action', (event) => ({ ...commentEvent[event](), action: undefined })],
    ['an action that is no text', (event) => ({ ...commentEvent[event](), action: 1 })],
    ['no repository', (event) => ({ ...commentEvent[event](), repository: undefined })],
    [
      'a repository id that is no number',
      (event) => ({ ...commentEvent[event](), repository: { id: String(ACME) } }),
    ],
    [
      'a repository id that is no integer',
      (event) => ({ ...commentEvent[event](), repository: { id: ACME + 0.5 } }),
    ],
    ['no comment', (event) => ({ ...commentEvent[event](), comment: undefined })],
    [
      'a comment without an author',
      (event) => ({ ...commentEvent[event](), comment: { body: 'qualor review' } }),
    ],
    [
      'an author that is none (a deleted account)',
      (event) => ({ ...commentEvent[event](), comment: { user: null } }),
    ],
    [
      'an author without a type',
      (event) => ({ ...commentEvent[event](), comment: { user: { login: 'octocat' } } }),
    ],
    [
      'an author type that is no text',
      (event) => ({ ...commentEvent[event](), comment: { user: { type: 1 } } }),
    ],
  ];
  it.each(
    COMMENT_EVENTS.flatMap((event) =>
      unreadable.map(([name, payload]) => [event, name, payload] as const),
    ),
  )('%s: answers 204 for %s, and queues nothing', async (event, _, payload) => {
    const res = await deliver(event, JSON.stringify(payload(event)));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await allJobs()).toEqual([]);
  });

  it.each([
    [
      'pull_request_review_comment',
      'no pull request',
      { ...reviewCommentEvent(), pull_request: undefined },
    ],
    [
      'pull_request_review_comment',
      'a pull request number that is no integer',
      { ...reviewCommentEvent(), pull_request: { number: '7' } },
    ],
    ['issue_comment', 'no issue', { ...issueCommentEvent(), issue: undefined }],
    [
      'issue_comment',
      'an issue without a number',
      { ...issueCommentEvent(), issue: { pull_request: {} } },
    ],
    [
      'issue_comment',
      'an issue whose pull_request is null',
      { ...issueCommentEvent(), issue: { number: 7, pull_request: null } },
    ],
  ])('%s: answers 204 for %s, and queues nothing', async (event, _, payload) => {
    expect((await deliver(event, JSON.stringify(payload))).statusCode).toBe(204);
    expect(await allJobs()).toEqual([]);
  });

  it.each(['pull_request_review', 'pull_request', 'issues', 'commit_comment', 'check_suite'])(
    'does not read the event %s: 204, whatever its body holds',
    async (event) => {
      // A body shaped like a comment event, and one that is no JSON at all.
      expect((await deliver(event, issueCommentEvent())).statusCode).toBe(204);
      expect((await deliver(event, reviewCommentEvent())).statusCode).toBe(204);
      expect((await deliver(event, 'not json')).statusCode).toBe(204);
      expect(await allJobs()).toEqual([]);
    },
  );

  it.each(COMMENT_EVENTS)('refuses a %s whose body is not JSON with 400', async (event) => {
    expect((await deliver(event, 'not json')).statusCode).toBe(400);
    expect(await allJobs()).toEqual([]);
  });

  it.each(COMMENT_EVENTS)(
    'refuses a %s with a wrong or missing signature with 401',
    async (event) => {
      const body = JSON.stringify(commentEvent[event]());
      const ip = '198.51.100.9';
      const wrong = sign(body, 'another-secret-value');
      expect((await deliver(event, body, { signature: wrong, ip })).statusCode).toBe(401);
      expect((await deliver(event, body, { signature: null, ip })).statusCode).toBe(401);
      expect(await allJobs()).toEqual([]);
    },
  );

  it('forgets a delivery whose processing failed, so GitHub’s redelivery of it counts', async () => {
    const delivery = randomUUID();
    const failing = vi
      .spyOn(h.ctx.db, 'transaction')
      .mockRejectedValueOnce(new Error('database down'));
    try {
      expect((await deliver('issue_comment', issueCommentEvent(), { delivery })).statusCode).toBe(
        500,
      );
    } finally {
      failing.mockRestore();
    }
    expect(await allJobs()).toEqual([]);
    expect((await deliver('issue_comment', issueCommentEvent(), { delivery })).statusCode).toBe(
      204,
    );
    expect(await scansOf(acmeBranch)).toHaveLength(1);
  });

  it('never uses the payload’s comment: a command it names that the API does not hold is none', async () => {
    const sent = await deliver('issue_comment', issueCommentEvent({ text: 'qualor review' }));
    expect(sent.statusCode).toBe(204);
    fake.clearRequests();
    await scan(acmeBranch);
    // The scan read the pull request's comments from GitHub, and found none of the payload's.
    expect(fake.requests.some((r) => /^\/repos\/acme\/api\/issues\/7\/comments/.test(r.path))).toBe(
      true,
    );
    expect((await queuedAnswers(h.ctx.db, acmeBranch)).rows).toEqual([]);
  });

  it('never uses the payload’s comment: a command the API holds is found whatever the payload says', async () => {
    const command = fake.addComment(ACME, 7, { body: 'Qualor STOP please', login: 'octocat' });
    // The payload names another author and words that are no command.
    const sent = await deliver('issue_comment', {
      ...issueCommentEvent({ text: 'looks good to me' }),
      sender: { login: 'someone-else', id: 99, type: 'User' },
    });
    expect(sent.statusCode).toBe(204);
    await scan(acmeBranch);
    const { rows, jobs: queued } = await queuedAnswers(h.ctx.db, acmeBranch);
    expect(rows).toMatchObject([
      {
        kind: 'command',
        command: 'stop',
        // The comment's id is GitHub's of now, not the payload's 4 000 777.
        noteId: command.id,
        threadId: null,
        author: 'octocat',
        status: 'queued',
      },
    ]);
    // The delivery's scan, which this test ran by hand, and the command's answer the scan queued.
    expect(queued.map((job) => (job.payload as { kind: string }).kind)).toEqual(['scan', 'answer']);
  });
});
