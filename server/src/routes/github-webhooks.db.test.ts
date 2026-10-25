import { createHmac, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, type FakeGitHub } from '../../test/fake-github';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import {
  githubConnection,
  githubDeps,
  githubTestConfig,
  mappedGitHubProject,
  pullRequestReport,
  WEBHOOK_SECRET,
} from '../../test/github';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import { queuedAnswers, reviewOff, reviewOn, reviewScope, scanJob } from '../../test/replies';
import { decorationDeps, queuedDecorations, runDecorations, silentLogger } from '../../test/scm';
import {
  analyses,
  branches,
  jobs,
  organizations,
  projects,
  reviewReplies,
  scmConnections,
} from '../db/schema';
import { createLlmRuntime } from '../llm/job';
import { runUntilIdle } from '../queue/worker';
import type { ReviewJobDeps } from '../review/job';
import { replyHandlers } from '../review/reply-job';
import { AI_REPLY_QUEUE, replyKey } from '../review/reply-queue';
import { parseInternalHosts } from '../scm/url';

const HEAD = '1'.repeat(40);

const sign = (body: string, secret = WEBHOOK_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * A delivery to the App's webhook of a connection, as GitHub makes it: signed over the body, with
 * the event and an id of its own. The harness and the connection are the test's, read when sent.
 */
function deliveryTo(harness: () => IngestHarness, connection: () => string) {
  return (
    event: string,
    payload: unknown,
    options: {
      id?: string;
      signature?: string | null;
      connection?: string;
      contentType?: string;
      delivery?: string;
      /** The sender's address: each throttle test has its own. */
      ip?: string;
    } = {},
  ) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return harness().ctx.app.inject({
      method: 'POST',
      url: `/api/v0/github/webhooks/${options.connection ?? connection()}`,
      remoteAddress: options.ip ?? '127.0.0.1',
      headers: {
        'content-type': options.contentType ?? 'application/json',
        'x-github-event': event,
        'x-github-delivery': options.delivery ?? randomUUID(),
        ...(options.signature === null
          ? {}
          : { 'x-hub-signature-256': options.signature ?? sign(body) }),
      },
      payload: body,
    });
  };
}

describe('GitHub webhooks (github.md §9)', () => {
  let h: IngestHarness;
  let fake: FakeGitHub;
  let connectionId: string;
  let analysisId: string;
  const deliver = deliveryTo(
    () => h,
    () => connectionId,
  );
  const rerun = (
    externalId: string | null,
    overrides: { appId?: number; repositoryId?: number } = {},
  ) => ({
    action: 'rerequested',
    check_run: {
      id: 4,
      name: 'qualor/x',
      external_id: externalId,
      app: { id: overrides.appId ?? fake.appId },
    },
    repository: { id: overrides.repositoryId ?? 424242, full_name: 'acme/api' },
    installation: { id: 777 },
  });

  beforeAll(async () => {
    fake = await createFakeGitHub();
    fake.addRepository({ id: 424242, owner: 'acme', name: 'api', installationId: 777 });
    fake.addPull(424242, {
      number: 7,
      title: 'x',
      state: 'open',
      headSha: HEAD,
      baseSha: 'b'.repeat(40),
      files: [],
    });
    h = await createIngestHarness({ config: githubTestConfig(fake) });
    connectionId = await githubConnection(h, fake);
    const project = await mappedGitHubProject(h, fake, 'gh/hooks', 'acme/api', { connectionId });
    analysisId = await project.ingestOk(pullRequestReport(7, HEAD, { projectKey: project.key }));
    await runDecorations(h, githubDeps(h));
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });
  beforeEach(async () => {
    await runDecorations(h, githubDeps(h)); // start every test with an empty scm queue
  });

  const externalId = () => fake.checkRuns.at(-1)!.externalId!;

  it('answers a signed ping with 204 and does nothing', async () => {
    const res = await deliver('ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
    expect(res.statusCode).toBe(204);
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('re-decorates when the Re-run button of Qualor’s check run is pressed', async () => {
    const res = await deliver('check_run', rerun(externalId()));
    expect(res.statusCode).toBe(204);
    const [job] = await queuedDecorations(h);
    expect(job?.payload).toMatchObject({
      analysisId,
      attempt: 0,
      reevaluation: true,
      github: { repositoryId: '424242', checkout: 'head' },
    });
  });

  it.each([
    ['another App', () => rerun(externalId(), { appId: 1 })],
    ['another repository', () => rerun(externalId(), { repositoryId: 5 })],
    ['a foreign external id', () => rerun('ci:1234')],
    [
      'an analysis of another connection',
      () => rerun(`qualor:v1:${randomUUID()}:0123456789abcdef`),
    ],
    ['another action', () => ({ ...rerun(externalId()), action: 'completed' })],
  ])('does nothing for %s', async (_, payload) => {
    expect((await deliver('check_run', payload())).statusCode).toBe(204);
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('does nothing for Qualor’s check run delivered to another connection, even of the same App and secret', async () => {
    const other = await githubConnection(h, fake);
    expect(
      (await deliver('check_run', rerun(externalId()), { connection: other })).statusCode,
    ).toBe(204);
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('refuses a wrong, missing or SHA-1-only signature with 401, and does nothing', async () => {
    const body = JSON.stringify(rerun(externalId()));
    const ip = '198.51.100.1';
    expect(
      (await deliver('check_run', body, { signature: sign(body, 'another-secret-value'), ip }))
        .statusCode,
    ).toBe(401);
    expect((await deliver('check_run', body, { signature: null, ip })).statusCode).toBe(401);
    expect(
      (
        await deliver('check_run', body, {
          signature: `sha1=${createHmac('sha1', WEBHOOK_SECRET).update(body).digest('hex')}`,
          ip,
        })
      ).statusCode,
    ).toBe(401);
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('answers 404 alike for an unknown connection, one without a secret, one whose secret no longer decrypts, and a non-id', async () => {
    const without = await githubConnection(h, fake, { webhookSecret: null });
    const rotated = await githubConnection(h, fake);
    // A key copied into webhook_secret_enc (another AAD) reads as no secret, like a rotated server key.
    const [row] = await h.ctx.db
      .select()
      .from(scmConnections)
      .where(eq(scmConnections.id, rotated));
    await h.ctx.db
      .update(scmConnections)
      .set({ webhookSecretEnc: row!.tokenEnc })
      .where(eq(scmConnections.id, rotated));
    const [gitlab] = await h.ctx.db
      .insert(scmConnections)
      .values({
        organizationId: h.organizationId,
        provider: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        tokenEnc: row!.tokenEnc,
      })
      .returning({ id: scmConnections.id });
    const answers = await Promise.all(
      [randomUUID(), without, rotated, gitlab!.id, 'not-an-id'].map((connection) =>
        deliver('ping', {}, { connection }),
      ),
    );
    expect(answers.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);
  });

  it('refuses a form or text body with 415 and a body over 1 MiB with 413', async () => {
    expect(
      (
        await deliver('ping', 'payload=%7B%7D', {
          contentType: 'application/x-www-form-urlencoded',
        })
      ).statusCode,
    ).toBe(415);
    // Fastify parses text/plain by default: a string, never checked against the signature of
    // an empty body.
    expect(
      (await deliver('ping', '', { contentType: 'text/plain', signature: sign('') })).statusCode,
    ).toBe(415);
    expect((await deliver('ping', '{}', { contentType: 'text/plain' })).statusCode).toBe(415);
    const big = JSON.stringify({ zen: 'x'.repeat(1024 * 1024) });
    expect((await deliver('ping', big)).statusCode).toBe(413);
  });

  it('ignores a delivery id it has seen', async () => {
    const delivery = randomUUID();
    await deliver('check_run', rerun(externalId()), { delivery });
    await runDecorations(h, githubDeps(h));
    expect((await deliver('check_run', rerun(externalId()), { delivery })).statusCode).toBe(204);
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('re-decorates in an organisation beyond the old community limit (enterprise.md §8)', async () => {
    // Three organisations older than this one: before 5A it was read-only and nothing re-ran.
    const older = await h.ctx.db
      .insert(organizations)
      .values(
        ['ro-a', 'ro-b', 'ro-c'].map((key) => ({
          key,
          name: key,
          createdAt: new Date('2000-01-01T00:00:00Z'),
        })),
      )
      .returning({ id: organizations.id });
    try {
      expect((await deliver('check_run', rerun(externalId()))).statusCode).toBe(204);
      expect(await queuedDecorations(h)).toHaveLength(1);
    } finally {
      await h.ctx.db.delete(organizations).where(
        inArray(
          organizations.id,
          older.map((o) => o.id),
        ),
      );
    }
  });

  it('does nothing for the rerun of an analysis that is no longer its branch’s latest', async () => {
    const [pr] = await h.ctx.db.select().from(branches).where(eq(branches.kind, 'merge_request'));
    const older = externalId();
    await h.ctx.db.update(branches).set({ lastAnalysisId: null }).where(eq(branches.id, pr!.id));
    expect((await deliver('check_run', rerun(older))).statusCode).toBe(204);
    expect(await queuedDecorations(h)).toEqual([]);
    await h.ctx.db
      .update(branches)
      .set({ lastAnalysisId: analysisId })
      .where(eq(branches.id, pr!.id));
  });

  it('rate-limits failed signatures per address, and still takes a valid one from it', async () => {
    const ip = '198.51.100.2';
    let last = 0;
    for (let i = 0; i < 61; i++)
      last = (await deliver('ping', {}, { signature: 'sha256=' + '0'.repeat(64), ip })).statusCode;
    expect(last).toBe(429);
    expect((await deliver('ping', {}, { ip })).statusCode).toBe(204);
    expect((await deliver('ping', {}, { signature: 'sha256=' + '0'.repeat(64) })).statusCode).toBe(
      401,
    );
  });

  it('refuses a delivery without a GitHub event or delivery id with 400', async () => {
    expect((await deliver('Check-Run', {})).statusCode).toBe(400);
    expect((await deliver('', {})).statusCode).toBe(400);
    expect((await deliver('ping', {}, { delivery: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await deliver('ping', {}, { delivery: '' })).statusCode).toBe(400);
  });

  it('takes a body that is not JSON for an event it does not read', async () => {
    expect((await deliver('ping', 'not json')).statusCode).toBe(204);
    expect((await deliver('check_run', 'not json')).statusCode).toBe(400);
  });

  it.each([
    ['no GitHub context (an older CLI)', null],
    ['no repository id', { checkout: 'head' }],
  ])('does nothing for the rerun of an analysis with %s', async (_, github) => {
    const [row] = await h.ctx.db.select().from(analyses).where(eq(analyses.id, analysisId));
    const saved = row!.scmContext;
    await h.ctx.db
      .update(analyses)
      .set({ scmContext: { provider: 'github', mergeRequestId: '7', gitlab: null, github } })
      .where(eq(analyses.id, analysisId));
    try {
      expect((await deliver('check_run', rerun(externalId()))).statusCode).toBe(204);
      expect(await queuedDecorations(h)).toEqual([]);
    } finally {
      await h.ctx.db.update(analyses).set({ scmContext: saved }).where(eq(analyses.id, analysisId));
    }
  });

  it('forgets a delivery id whose processing failed, so GitHub’s redelivery counts', async () => {
    const delivery = randomUUID();
    const failing = vi
      .spyOn(h.ctx.db, 'transaction')
      .mockRejectedValueOnce(new Error('database down'));
    try {
      expect((await deliver('check_run', rerun(externalId()), { delivery })).statusCode).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect((await deliver('check_run', rerun(externalId()), { delivery })).statusCode).toBe(204);
    expect(await queuedDecorations(h)).toHaveLength(1);
  });

  it('never answers with the secret', async () => {
    const res = await deliver('ping', {}, { signature: 'sha256=' + '0'.repeat(64) });
    expect(res.body).not.toContain(WEBHOOK_SECRET);
  });
});

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
