import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeGitHub, type FakeGitHub } from '../../test/fake-github';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import { githubConnection } from '../../test/github';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import {
  answeredWithin,
  holdScanQueue,
  queuedAnswers,
  reviewOff,
  reviewOn,
  reviewScope,
  scanJob,
} from '../../test/replies';
import {
  decorationDeps,
  GITLAB_WEBHOOK_SECRET,
  mappedProject,
  mergeRequestReport,
  PUBLIC_URL,
  silentLogger,
} from '../../test/scm';
import type { Executor } from '../db/client';
import { branches, jobs, projects, reviewReplies, scmConnections } from '../db/schema';
import { createLlmRuntime } from '../llm/job';
import { runUntilIdle } from '../queue/worker';
import type { ReviewJobDeps } from '../review/job';
import { replyHandlers } from '../review/reply-job';
import { AI_REPLY_QUEUE, replyKey } from '../review/reply-queue';
import { createScmRuntime } from '../scm/runtime';
import { parseInternalHosts } from '../scm/url';

/*
 * GitLab's webhook (6I-4): a note event on a merge request queues one scan of that merge request's
 * notes, and the scan reads them through the API. The delivery is answered 204 whatever Qualor makes
 * of it, because GitLab counts any other answer as a failure and disables a hook that fails.
 */

const HEAD = '1'.repeat(40);
/** The GitLab project of the merge request the tests read. */
const PAYMENTS = 7;

describe('GitLab webhooks (6I-4)', () => {
  let h: IngestHarness;
  let gitlab: FakeGitLab;
  let github: FakeGitHub;
  let llm: FakeLlm;
  /** The connection with the webhook secret, to which the deliveries go. */
  let connectionId: string;
  /** The branch of merge request 12 of the Qualor project mapped to GitLab project 7. */
  let paymentsBranch: string;
  /** A GitLab project of its own for each test that maps more projects. */
  let nextGitLabProject = 100;

  const deliver = (
    payload: unknown,
    options: {
      token?: string | null;
      event?: string | null;
      connection?: string;
      contentType?: string;
      /** The headers GitLab 17.4 and 19.0 send to tell the retries of one delivery. */
      idempotencyKey?: string;
      webhookId?: string;
      /** The sender's address: each throttle test has its own. */
      ip?: string;
    } = {},
  ) =>
    h.ctx.app.inject({
      method: 'POST',
      url: `/api/v0/gitlab/webhooks/${options.connection ?? connectionId}`,
      remoteAddress: options.ip ?? '127.0.0.1',
      headers: {
        'content-type': options.contentType ?? 'application/json',
        ...(options.event === null ? {} : { 'x-gitlab-event': options.event ?? 'Note Hook' }),
        ...(options.token === null
          ? {}
          : { 'x-gitlab-token': options.token ?? GITLAB_WEBHOOK_SECRET }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { 'idempotency-key': options.idempotencyKey }),
        ...(options.webhookId === undefined ? {} : { 'webhook-id': options.webhookId }),
      },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });

  /** GitLab's note event on a merge request (docs.gitlab.com, Note Hook): what Qualor reads, and more. */
  const noteEvent = (
    o: { iid?: number; projectId?: number; path?: string; noteable?: string; text?: string } = {},
  ) => ({
    object_kind: 'note',
    event_type: 'note',
    user: { id: 5, username: 'user5', name: 'A person' },
    project_id: o.projectId ?? PAYMENTS,
    project: {
      id: o.projectId ?? PAYMENTS,
      name: 'payments',
      path_with_namespace: o.path ?? 'acme/payments',
    },
    object_attributes: {
      id: 31_337,
      note: o.text ?? 'thanks',
      noteable_type: o.noteable ?? 'MergeRequest',
      noteable_id: 70,
    },
    merge_request: { id: 70, iid: o.iid ?? 12, title: 'Add the cart', state: 'opened' },
  });

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
   * A Qualor project mapped to GitLab project `gitlabProjectId` (a project of its own unless
   * given), with its merge request 12 analysed, on the connection (unless `own` makes one, with
   * the secret).
   */
  const mapped = async (key: string, options: { gitlabProjectId?: number; own?: boolean } = {}) => {
    const gitlabProjectId = options.gitlabProjectId ?? nextGitLabProject++;
    const project = await mappedProject(
      h,
      gitlab,
      key,
      gitlabProjectId,
      options.own ? { webhookSecret: GITLAB_WEBHOOK_SECRET } : { connectionId: connectionId },
    );
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        gitlab: { projectId: String(gitlabProjectId), mergeRequestEventType: 'detached' },
      }),
    );
    return { project, gitlabProjectId, branchId: await branchOf(project.id) };
  };
  const jobDeps = (): ReviewJobDeps => ({
    db: h.ctx.db,
    config: h.ctx.config,
    logger: silentLogger,
    llmCircuit: createLlmRuntime().circuit,
    scm: decorationDeps(h).scm,
    scmRuntime: createScmRuntime(),
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
    gitlab = await createFakeGitLab();
    github = await createFakeGitHub();
    h = await createIngestHarness({
      config: {
        publicUrl: PUBLIC_URL,
        scmInternalHosts: parseInternalHosts(
          `${new URL(gitlab.url).host},${new URL(github.url).host}`,
        ),
        llmInternalHosts: parseInternalHosts(llm.host),
      },
    });
    gitlab.addProject({ id: PAYMENTS, path: 'acme/payments' });
    gitlab.addMergeRequest(PAYMENTS, {
      iid: 12,
      title: 'Add the cart',
      state: 'opened',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      headSha: HEAD,
      baseSha: 'b'.repeat(40),
      startSha: 'b'.repeat(40),
      diffs: [],
    });
    // Analysed with AI review off, then switched on for the organisation.
    const payments = await mapped('hooks/payments', { gitlabProjectId: PAYMENTS, own: true });
    connectionId = payments.project.connectionId;
    paymentsBranch = payments.branchId;
    await reviewOn(h, llm);
  });
  afterAll(async () => {
    await h.close();
    await gitlab.close();
    await github.close();
    await llm.close();
  });
  beforeEach(async () => {
    await clearJobs();
    await h.ctx.db.delete(reviewReplies);
    gitlab.discussions(PAYMENTS, 12).splice(0);
  });

  it('a note event queues one scan for its merge request', async () => {
    const res = await deliver(noteEvent());
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await queuedAnswers(h.ctx.db, paymentsBranch)).jobs).toEqual([scanJob(paymentsBranch)]);
    expect(await allJobs()).toHaveLength(1);
    // Nothing is written to the ledger: the scan reads the notes and decides.
    expect((await queuedAnswers(h.ctx.db, paymentsBranch)).rows).toEqual([]);
  });

  it('refuses a wrong or missing token with 401, throttles it to 429 per address, and still takes a right one', async () => {
    const ip = '198.51.100.7';
    const first = await deliver(noteEvent(), { token: 'a-wrong-secret-token', ip });
    expect(first.statusCode).toBe(401);
    expect(first.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await deliver(noteEvent(), { token: null, ip })).statusCode).toBe(401);
    expect((await deliver(noteEvent(), { token: '', ip })).statusCode).toBe(401);
    // The secret as a prefix, or with something after it, is not the secret.
    expect(
      (await deliver(noteEvent(), { token: GITLAB_WEBHOOK_SECRET.slice(0, -1), ip })).statusCode,
    ).toBe(401);
    expect(
      (await deliver(noteEvent(), { token: `${GITLAB_WEBHOOK_SECRET}x`, ip })).statusCode,
    ).toBe(401);
    expect(await allJobs()).toEqual([]);
    // Five wrong ones so far: 55 more still get 401, and the 61st is throttled.
    const statuses: number[] = [];
    let throttled: Awaited<ReturnType<typeof deliver>> | undefined;
    for (let i = 0; i < 56; i++) {
      const res = await deliver(noteEvent(), { token: 'a-wrong-secret-token', ip });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) throttled ??= res;
    }
    expect(statuses.slice(0, 55)).toEqual(Array.from({ length: 55 }, () => 401));
    expect(statuses[55]).toBe(429);
    expect(throttled?.headers['retry-after']).toBe('60');
    expect(throttled?.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // A right token from the throttled address is taken, and another address is counted apart.
    expect((await deliver(noteEvent(), { ip })).statusCode).toBe(204);
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
    expect(
      (await deliver(noteEvent(), { token: 'a-wrong-secret-token', ip: '198.51.100.8' }))
        .statusCode,
    ).toBe(401);
  });

  it('answers 404 alike for an unknown connection, one without a secret, one whose secret no longer decrypts, a GitHub connection and a non-id', async () => {
    const without = await mappedProject(h, gitlab, 'hooks/no-secret', nextGitLabProject++, {
      ownConnection: true,
    });
    const rotated = await mappedProject(h, gitlab, 'hooks/rotated', nextGitLabProject++, {
      webhookSecret: GITLAB_WEBHOOK_SECRET,
    });
    // A key copied into webhook_secret_enc (another AAD) reads as no secret, like a rotated server key.
    const [row] = await h.ctx.db
      .select()
      .from(scmConnections)
      .where(eq(scmConnections.id, rotated.connectionId));
    await h.ctx.db
      .update(scmConnections)
      .set({ webhookSecretEnc: row!.tokenEnc })
      .where(eq(scmConnections.id, rotated.connectionId));
    // A GitHub connection holds a webhook secret too: its own is no GitLab token.
    const hub = await githubConnection(h, github, { webhookSecret: GITLAB_WEBHOOK_SECRET });
    const answers = await Promise.all(
      [randomUUID(), without.connectionId, rotated.connectionId, hub, 'not-an-id'].map(
        (connection) => deliver(noteEvent(), { connection }),
      ),
    );
    expect(answers.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);
    expect(await allJobs()).toEqual([]);
  });

  it.each([
    'Push Hook',
    'Merge Request Hook',
    'Issue Hook',
    'Pipeline Hook',
    'System Hook',
    'Confidential Note Hook',
    'note hook',
    '',
  ])('answers 204 for the event %j and queues nothing', async (event) => {
    expect((await deliver(noteEvent(), { event })).statusCode).toBe(204);
    // Not even read: a body that is no JSON is no matter either.
    expect((await deliver('not json', { event })).statusCode).toBe(204);
    expect(await allJobs()).toEqual([]);
  });

  it('answers 204 for a delivery without an event header, and queues nothing', async () => {
    expect((await deliver(noteEvent(), { event: null })).statusCode).toBe(204);
    expect(await allJobs()).toEqual([]);
  });

  it('never uses the payload’s note: a command it names that the API does not hold is none', async () => {
    const sent = await deliver(noteEvent({ text: 'qualor review' }));
    expect(sent.statusCode).toBe(204);
    gitlab.clearRequests();
    await scan(paymentsBranch);
    // The scan read the merge request's notes from GitLab, and found none of the payload's.
    expect(gitlab.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      `GET /projects/${PAYMENTS}/merge_requests/12/discussions`,
    );
    expect((await queuedAnswers(h.ctx.db, paymentsBranch)).rows).toEqual([]);
  });

  it('never uses the payload’s note: a command the API holds is found whatever the payload says', async () => {
    const command = gitlab.addNote(PAYMENTS, 12, { body: 'Qualor STOP please', authorId: 5 });
    // The payload names another author and words that are no command.
    const sent = await deliver({
      ...noteEvent({ text: 'looks good to me' }),
      user: { id: 99, username: 'someone-else' },
    });
    expect(sent.statusCode).toBe(204);
    await scan(paymentsBranch);
    const { rows, jobs: queued } = await queuedAnswers(h.ctx.db, paymentsBranch);
    expect(rows).toMatchObject([
      {
        kind: 'command',
        command: 'stop',
        // The note's id and discussion are GitLab's of now, not the payload's 31 337.
        noteId: command.notes[0]!.id,
        threadId: command.id,
        author: 'user5',
        status: 'queued',
      },
    ]);
    // The delivery's scan, which this test ran by hand, and the command's answer the scan queued.
    expect(queued.map((job) => (job.payload as { kind: string }).kind)).toEqual(['scan', 'answer']);
  });

  it('de-duplicates by the Idempotency-Key of a delivery, else by its webhook-id', async () => {
    const key = randomUUID();
    expect((await deliver(noteEvent(), { idempotencyKey: key })).statusCode).toBe(204);
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
    // The scan runs (nothing is left queued): only the key can tell the retry from a new note.
    expect(await worker()).toBe(1);
    expect(await scansOf(paymentsBranch)).toHaveLength(0);
    expect((await deliver(noteEvent(), { idempotencyKey: key })).statusCode).toBe(204);
    expect(await scansOf(paymentsBranch)).toHaveLength(0);
    // Any case of the same key is the same delivery.
    expect((await deliver(noteEvent(), { idempotencyKey: key.toUpperCase() })).statusCode).toBe(
      204,
    );
    expect(await scansOf(paymentsBranch)).toHaveLength(0);
    // Another key is another delivery.
    expect((await deliver(noteEvent(), { idempotencyKey: randomUUID() })).statusCode).toBe(204);
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
    expect(await worker()).toBe(1);

    // GitLab 19 sends the same value as webhook-id; a retry of it is the same delivery.
    const id = randomUUID();
    await deliver(noteEvent(), { webhookId: id });
    expect(await worker()).toBe(1);
    await deliver(noteEvent(), { webhookId: id });
    expect(await scansOf(paymentsBranch)).toHaveLength(0);
    // With both, the Idempotency-Key is the one that counts.
    await deliver(noteEvent(), { idempotencyKey: randomUUID(), webhookId: id });
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
    expect(await worker()).toBe(1);
    // Without either there is no de-duplication: each delivery is a note of its own.
    await deliver(noteEvent());
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
    expect(await worker()).toBe(1);
    await deliver(noteEvent());
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
  });

  it('takes a key that is not 1 to 128 of [A-Za-z0-9._:-] for none, never for a 400', async () => {
    for (const bad of ['', 'has space', 'semi;colon', 'ü'.repeat(4), 'k'.repeat(129)]) {
      // Sent twice with a scan run between: a bad key remembers nothing.
      expect((await deliver(noteEvent(), { idempotencyKey: bad })).statusCode, bad).toBe(204);
      expect(await scansOf(paymentsBranch), bad).toHaveLength(1);
      expect(await worker()).toBe(1);
      expect((await deliver(noteEvent(), { idempotencyKey: bad })).statusCode, bad).toBe(204);
      expect(await scansOf(paymentsBranch), bad).toHaveLength(1);
      expect(await worker()).toBe(1);
    }
    // A bad Idempotency-Key is none, and the webhook-id counts.
    const id = 'ok-id_1.2:3';
    await deliver(noteEvent(), { idempotencyKey: 'has space', webhookId: id });
    expect(await worker()).toBe(1);
    await deliver(noteEvent(), { idempotencyKey: 'has space', webhookId: id });
    expect(await scansOf(paymentsBranch)).toHaveLength(0);
    // A key of 128 characters is one.
    const longest = 'k'.repeat(128);
    await deliver(noteEvent(), { idempotencyKey: longest });
    expect(await worker()).toBe(1);
    await deliver(noteEvent(), { idempotencyKey: longest });
    expect(await scansOf(paymentsBranch)).toHaveLength(0);
  });

  it('keeps a delivery id of one connection apart from the same id of another', async () => {
    const other = await mapped('hooks/own-key', { gitlabProjectId: PAYMENTS, own: true });
    const key = randomUUID();
    await deliver(noteEvent(), { idempotencyKey: key });
    await deliver(noteEvent(), { idempotencyKey: key, connection: other.project.connectionId });
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
    expect(await scansOf(other.branchId)).toHaveLength(1);
  });

  it('makes one scan of five deliveries for a merge request while its scan is queued', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await deliver(noteEvent(), { idempotencyKey: randomUUID() })).statusCode).toBe(204);
    }
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
  });

  it('makes one scan of deliveries at once: the one that gets the merge request’s lock queues it, the others give way', async () => {
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => deliver(noteEvent(), { idempotencyKey: randomUUID() })),
    );
    expect(answers.map((answer) => answer.statusCode)).toEqual([204, 204, 204, 204, 204, 204]);
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
  });

  /**
   * A delivery made while a transaction holds something (`hold` takes it): its answer, `undefined`
   * when it has not come after two seconds, and how long it took in milliseconds. The delivery
   * is let finish either way, so that a delivery that waits fails the test and does not hang it.
   */
  const deliveredWhileHolding = async (hold: (tx: Executor) => Promise<void>) => {
    let delivery!: ReturnType<typeof deliver>;
    let answer: Awaited<ReturnType<typeof deliver>> | undefined;
    let took = 0;
    await h.ctx.db.transaction(async (tx) => {
      await hold(tx);
      const began = performance.now();
      delivery = deliver(noteEvent(), { idempotencyKey: randomUUID() });
      answer = await answeredWithin(delivery);
      took = performance.now() - began;
    });
    await delivery;
    return { answer, took };
  };

  it('gives way to a delivery that is queueing the merge request’s scan: 204 at once and nothing queued, then the next one queues', async () => {
    const { answer } = await deliveredWhileHolding((tx) => holdScanQueue(tx, paymentsBranch));
    expect(answer?.statusCode).toBe(204);
    expect(await scansOf(paymentsBranch)).toHaveLength(0);
    await deliver(noteEvent(), { idempotencyKey: randomUUID() });
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
  });

  it('is not delayed by an ingestion that holds the merge request’s branch: 204 within a second, and the scan queued', async () => {
    const { answer, took } = await deliveredWhileHolding(async (tx) => {
      // What the ingestion of an analysis of the merge request does to the branch, and holds until it commits.
      await tx
        .update(branches)
        .set({ updatedAt: sql`now()` })
        .where(eq(branches.id, paymentsBranch));
    });
    expect(answer?.statusCode).toBe(204);
    expect(took).toBeLessThan(1_000);
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
  });

  it('does not count a scan that is running: a delivery meanwhile queues the next, which reads what the first may have missed', async () => {
    await deliver(noteEvent(), { idempotencyKey: randomUUID() });
    await h.ctx.db.update(jobs).set({ status: 'running' }).where(eq(jobs.queue, AI_REPLY_QUEUE));
    await deliver(noteEvent(), { idempotencyKey: randomUUID() });
    await deliver(noteEvent(), { idempotencyKey: randomUUID() });
    expect((await allJobs()).map((job) => job.status).sort()).toEqual(['queued', 'running']);
  });

  const nothingToScan: [string, () => unknown][] = [
    [
      'a note on an issue',
      () => ({ ...noteEvent({ noteable: 'Issue' }), merge_request: undefined }),
    ],
    [
      'a note on a commit',
      () => ({ ...noteEvent({ noteable: 'Commit' }), merge_request: undefined }),
    ],
    [
      'a note on a snippet',
      () => ({ ...noteEvent({ noteable: 'Snippet' }), merge_request: undefined }),
    ],
    ['a merge request’s note of another noteable type', () => noteEvent({ noteable: 'Issue' })],
    [
      'a GitLab project that Qualor does not know',
      () => noteEvent({ projectId: 99, path: 'acme/unknown' }),
    ],
    ['a merge request that has no branch in Qualor', () => noteEvent({ iid: 99 })],
    ['an empty object', () => ({})],
    ['a payload without a project', () => ({ ...noteEvent(), project: undefined })],
    [
      'a project id that is no number',
      () => ({ ...noteEvent(), project: { id: '7', path_with_namespace: 'acme/payments' } }),
    ],
    [
      'a project id that is no integer',
      () => ({ ...noteEvent(), project: { id: 7.5, path_with_namespace: 'acme/payments' } }),
    ],
    [
      'a path that is not text',
      () => ({ ...noteEvent(), project: { id: PAYMENTS, path_with_namespace: 7 } }),
    ],
    [
      // The project is one Qualor knows, by its id: the payload is refused for its path alone.
      'a path past 2 048 characters',
      () => ({
        ...noteEvent(),
        project: { id: PAYMENTS, path_with_namespace: 'a'.repeat(2_049) },
      }),
    ],
    ['a merge request without an iid', () => ({ ...noteEvent(), merge_request: { id: 70 } })],
    ['an iid that is no integer', () => ({ ...noteEvent(), merge_request: { iid: '12' } })],
    ['another object kind', () => ({ ...noteEvent(), object_kind: 'push' })],
    ['a JSON array', () => [noteEvent()]],
    ['JSON null', () => null],
    ['a JSON number', () => 12],
  ];
  it.each(nothingToScan)('answers 204 for %s, and queues nothing', async (_, payload) => {
    const res = await deliver(JSON.stringify(payload()));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await allJobs()).toEqual([]);
  });

  it('answers 204 and queues nothing for a project without AI review: it is off, or the project is not in its scope', async () => {
    await reviewOff(h);
    try {
      expect((await deliver(noteEvent())).statusCode).toBe(204);
      expect(await allJobs()).toEqual([]);
    } finally {
      await reviewOn(h, llm);
    }
    await reviewScope(h, 'selected');
    try {
      expect((await deliver(noteEvent())).statusCode).toBe(204);
      expect(await allJobs()).toEqual([]);
    } finally {
      await reviewOn(h, llm);
    }
    expect((await deliver(noteEvent())).statusCode).toBe(204);
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
  });

  it('answers 204 and queues nothing for a project that is no longer mapped to the connection', async () => {
    const lone = await mapped('hooks/unmapped');
    await h.ctx.db
      .update(projects)
      .set({ scmConnectionId: null })
      .where(eq(projects.id, lone.project.id));
    expect(
      (await deliver(noteEvent({ projectId: lone.gitlabProjectId, path: 'acme/unmapped' })))
        .statusCode,
    ).toBe(204);
    expect(await allJobs()).toEqual([]);
  });

  it('queues one scan for each Qualor project of a monorepo: those mapped to the same GitLab project', async () => {
    const gitlabProjectId = nextGitLabProject++;
    const a = await mapped('hooks/mono-a', { gitlabProjectId });
    const b = await mapped('hooks/mono-b', { gitlabProjectId });
    expect(
      (await deliver(noteEvent({ projectId: gitlabProjectId, path: 'acme/mono' }))).statusCode,
    ).toBe(204);
    const queued = await allJobs();
    expect(queued.map((job) => job.concurrencyKey).sort()).toEqual(
      [a.branchId, b.branchId].map(replyKey).sort(),
    );
    expect(queued.map((job) => (job.payload as { branchId: string }).branchId).sort()).toEqual(
      [a.branchId, b.branchId].sort(),
    );
  });

  it('finds the projects by the GitLab project id or by its path without case, on this connection only', async () => {
    const gitlabProjectId = nextGitLabProject++;
    const byPath = await mapped('hooks/by-path', { gitlabProjectId });
    await h.ctx.db
      .update(projects)
      .set({ scmProjectRef: 'Acme/By-PATH' })
      .where(eq(projects.id, byPath.project.id));
    // The same GitLab project on another connection of the organisation is not this one's.
    await mapped('hooks/elsewhere', { gitlabProjectId, own: true });
    // By path: GitLab matches paths without case, and sends its own spelling.
    expect((await deliver(noteEvent({ projectId: 4_242, path: 'acme/by-path' }))).statusCode).toBe(
      204,
    );
    expect((await allJobs()).map((job) => job.concurrencyKey)).toEqual([replyKey(byPath.branchId)]);
    await clearJobs();
    // By id, whatever path the payload names.
    await h.ctx.db
      .update(projects)
      .set({ scmProjectRef: String(gitlabProjectId) })
      .where(eq(projects.id, byPath.project.id));
    expect(
      (await deliver(noteEvent({ projectId: gitlabProjectId, path: 'moved/elsewhere' })))
        .statusCode,
    ).toBe(204);
    expect((await allJobs()).map((job) => job.concurrencyKey)).toEqual([replyKey(byPath.branchId)]);
    await clearJobs();
    // A path that merely contains the project's is another project.
    await h.ctx.db
      .update(projects)
      .set({ scmProjectRef: 'acme/by-path' })
      .where(eq(projects.id, byPath.project.id));
    await deliver(noteEvent({ projectId: 4_242, path: 'acme/by-path-two' }));
    await deliver(noteEvent({ projectId: 4_242, path: 'xacme/by-path' }));
    expect(await allJobs()).toEqual([]);
  });

  it('reads only merge requests: a plain branch named like the iid is none', async () => {
    const gitlabProjectId = nextGitLabProject++;
    const plain = await mappedProject(h, gitlab, 'hooks/plain-branch', gitlabProjectId, {
      connectionId,
    });
    await h.ctx.db.insert(branches).values({ projectId: plain.id, kind: 'branch', name: '13' });
    expect(
      (await deliver(noteEvent({ iid: 13, projectId: gitlabProjectId, path: 'acme/plain' })))
        .statusCode,
    ).toBe(204);
    expect(await allJobs()).toEqual([]);
  });

  it('refuses a body that is not JSON for a note with 400, a form or text body with 415 and one over 1 MiB with 413', async () => {
    expect((await deliver('not json')).statusCode).toBe(400);
    expect((await deliver('')).statusCode).toBe(400);
    expect(
      (
        await deliver('payload=%7B%7D', {
          contentType: 'application/x-www-form-urlencoded',
        })
      ).statusCode,
    ).toBe(415);
    // Fastify parses text/plain by default: a string, which this route never takes.
    expect((await deliver('{}', { contentType: 'text/plain' })).statusCode).toBe(415);
    // No body at all is no JSON either.
    const bodiless = await h.ctx.app.inject({
      method: 'POST',
      url: `/api/v0/gitlab/webhooks/${connectionId}`,
      headers: { 'x-gitlab-event': 'Note Hook', 'x-gitlab-token': GITLAB_WEBHOOK_SECRET },
    });
    expect(bodiless.statusCode).toBe(415);
    const big = JSON.stringify({ ...noteEvent(), filler: 'x'.repeat(1024 * 1024) });
    expect((await deliver(big)).statusCode).toBe(413);
    expect(await allJobs()).toEqual([]);
  });

  it('forgets a delivery whose processing failed, so GitLab’s retry of it counts', async () => {
    const key = randomUUID();
    const failing = vi
      .spyOn(h.ctx.db, 'transaction')
      .mockRejectedValueOnce(new Error('database down'));
    try {
      expect((await deliver(noteEvent(), { idempotencyKey: key })).statusCode).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect(await allJobs()).toEqual([]);
    expect((await deliver(noteEvent(), { idempotencyKey: key })).statusCode).toBe(204);
    expect(await scansOf(paymentsBranch)).toHaveLength(1);
  });

  it('never answers or logs with the secret', async () => {
    const wrong = await deliver(noteEvent(), { token: 'a-wrong-secret-token' });
    expect(wrong.body).not.toContain(GITLAB_WEBHOOK_SECRET);
    expect(JSON.stringify(wrong.headers)).not.toContain(GITLAB_WEBHOOK_SECRET);
    const right = await deliver(noteEvent());
    expect(right.body).toBe('');
    expect(h.ctx.logs.join('\n')).not.toContain(GITLAB_WEBHOOK_SECRET);
  });
});
