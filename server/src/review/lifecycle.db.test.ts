import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Report, SnapshotLine } from '@qualor/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, login, organizationId, type Session } from '../../test/app';
import { createFakeGitHub, type FakeGitHub } from '../../test/fake-github';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import { mappedGitHubProject, pullRequestReport } from '../../test/github';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { storeTestSnapshot, switchReviewOn } from '../../test/review';
import {
  decorationDeps,
  mappedProject,
  mergeRequestReport,
  PUBLIC_URL,
  silentLogger,
} from '../../test/scm';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { uuidv7 } from '../db/ids';
import { first } from '../db/rows';
import {
  analyses,
  jobs,
  projects,
  reviewSnapshotFiles,
  reviewSnapshots,
  scmConnections,
} from '../db/schema';
import { runHousekeeping } from '../housekeeping/run';
import { readLlmSettings, writeLlmSettings } from '../llm/settings';
import { enqueue } from '../queue/queue';
import { runUntilIdle } from '../queue/worker';
import { SCM_TOKEN_AAD } from '../scm/connections';
import { scmHandlers } from '../scm/decorate';
import { MAX_DECORATIONS_PER_ORGANIZATION } from '../scm/runtime';
import { parseInternalHosts } from '../scm/url';
import { reviewSnapshotHandlers } from './jobs';
import {
  MR_STATE_CHECK_SECONDS,
  purgeInactiveSnapshots,
  purgeProjectSnapshots,
  REVIEW_MR_STATE_QUEUE,
  scheduleMergeRequestCheck,
} from './lifecycle';
import { DEFAULT_REVIEW } from './settings';
import { linkSnapshot, REVIEW_SNAPSHOT_QUEUE, storeSnapshotUpload } from './snapshot-store';

const GITLAB_PROJECT = 931;
const REPOSITORY = 9_931;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TITLE = 'A change';

/** One file: all a snapshot needs to be there. */
const FILE: SnapshotLine = { type: 'file', path: 'src/a.ts', text: 'export const a = 1;\n' };

describe('the hourly check of a merge request that holds a snapshot (6I-3, R16)', () => {
  let gitlab: FakeGitLab;
  let github: FakeGitHub;
  let h: IngestHarness;
  let gl: IngestProject & { connectionId: string };
  let gh: IngestProject & { connectionId: string };
  let analysed = 0;

  /** A merge request of the fake GitLab project, in `state`. */
  const gitlabMergeRequest = (
    iid: number,
    state: 'opened' | 'merged' | 'closed' = 'opened',
    draft = false,
  ) =>
    gitlab.addMergeRequest(GITLAB_PROJECT, {
      iid,
      title: TITLE,
      state,
      draft,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      headSha: HEAD,
      baseSha: BASE,
      startSha: BASE,
      diffs: [],
    });
  const githubPull = (number: number, state: 'open' | 'closed', merged = false) =>
    github.addPull(REPOSITORY, {
      number,
      title: TITLE,
      state,
      merged,
      headSha: HEAD,
      baseSha: BASE,
      files: [],
    });
  /** A report of the merge request, each one dated after the one before. */
  const gitlabReport = (iid: number): Report => {
    analysed += 1;
    return mergeRequestReport(iid, HEAD, {
      projectKey: gl.key,
      gitlab: { projectId: String(GITLAB_PROJECT), mergeRequestEventType: 'detached' },
      analysisDate: `2026-10-01T10:${String(analysed).padStart(2, '0')}:00Z`,
    });
  };
  const githubReport = (number: number): Report => {
    analysed += 1;
    return pullRequestReport(number, HEAD, {
      projectKey: gh.key,
      github: { repositoryId: String(REPOSITORY), checkout: 'head' },
      analysisDate: `2026-10-01T10:${String(analysed).padStart(2, '0')}:00Z`,
    });
  };
  const branchOf = async (analysisId: string) =>
    first(
      await h.ctx.db
        .select({ id: analyses.branchId })
        .from(analyses)
        .where(eq(analyses.id, analysisId)),
    ).id!;
  /** The merge request's analysis, ingested, and its snapshot unpacked and linked. */
  const analysedWithSnapshot = async (project: IngestProject, report: Report, iid: number) => {
    const analysisId = await project.ingestOk(report);
    const snapshotId = await storeTestSnapshot(h.ctx.db, analysisId, [FILE], {
      mergeRequest: { id: String(iid), title: TITLE, description: null },
    });
    return { analysisId, snapshotId, branchId: await branchOf(analysisId) };
  };
  /** The checks of the merge request's branch, the first queued first, with their time ahead. */
  const checksOf = (branchId: string) =>
    h.ctx.db
      .select({
        status: jobs.status,
        attempts: jobs.attempts,
        key: jobs.concurrencyKey,
        payload: jobs.payload,
        inSeconds: sql<number>`round(extract(epoch FROM ${jobs.runAt} - now()))::int`,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, REVIEW_MR_STATE_QUEUE),
          sql`${jobs.payload} ->> 'branchId' = ${branchId}`,
        ),
      )
      .orderBy(jobs.id);
  const queuedChecks = async (branchId: string) =>
    (await checksOf(branchId)).filter((check) => check.status === 'queued');
  const snapshotsOf = (branchId: string) =>
    h.ctx.db
      .select({ id: reviewSnapshots.id })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.branchId, branchId));
  /**
   * The scm worker's checks that are due run now: their handler is the one `scmHandlers` gives that
   * worker, and no other queue of it runs (a decoration would delete the snapshots itself). The
   * check of `branchId` is made due first; the others wait for their hour.
   */
  const runCheck = async (branchId: string, deps = decorationDeps(h)): Promise<number> => {
    const handler = scmHandlers(deps)[REVIEW_MR_STATE_QUEUE];
    expect(handler, 'the scm worker runs the check').toBeDefined();
    await h.ctx.db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(
        and(
          eq(jobs.queue, REVIEW_MR_STATE_QUEUE),
          eq(jobs.status, 'queued'),
          sql`${jobs.payload} ->> 'branchId' = ${branchId}`,
        ),
      );
    return runUntilIdle(h.ctx.db, { [REVIEW_MR_STATE_QUEUE]: handler! }, silentLogger);
  };
  const requestsTo = (iid: number) =>
    gitlab.requests.filter((r) => r.path.endsWith(`/merge_requests/${iid}`));

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
    gitlab.addProject({ id: GITLAB_PROJECT, path: 'acme/life' });
    github.addRepository({ id: REPOSITORY, owner: 'acme', name: 'life', installationId: 931 });
    gl = await mappedProject(h, gitlab, 'life/gitlab', GITLAB_PROJECT);
    gh = await mappedGitHubProject(h, github, 'life/github', 'acme/life');
  });
  afterAll(async () => {
    await h.close();
    await gitlab.close();
    await github.close();
  });

  it('a linked merge request snapshot schedules one hourly check', async () => {
    gitlabMergeRequest(1);
    const analysisId = await gl.ingestOk(gitlabReport(1));
    const branchId = await branchOf(analysisId);
    expect(await checksOf(branchId)).toEqual([]);
    // An upload that nothing has unpacked and linked yet is no reason to look at the merge request.
    const upload = await storeSnapshotUpload(h.ctx.db, {
      analysisId,
      projectId: gl.id,
      body: Buffer.from('not yet unpacked'),
      compressedBytes: 16,
    });
    expect(await checksOf(branchId)).toEqual([]);
    await h.ctx.db.delete(reviewSnapshots).where(eq(reviewSnapshots.id, upload));

    await storeTestSnapshot(h.ctx.db, analysisId, [FILE], {
      mergeRequest: { id: '1', title: TITLE, description: null },
    });
    const checks = await checksOf(branchId);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: 'queued',
      attempts: 0,
      key: `review-mr-state:branch:${branchId}`,
      payload: { branchId },
    });
    // An hour on, by the database's clock.
    expect(checks[0]!.inSeconds).toBeGreaterThan(MR_STATE_CHECK_SECONDS - 60);
    expect(checks[0]!.inSeconds).toBeLessThanOrEqual(MR_STATE_CHECK_SECONDS);

    // The next analysis links its snapshot too, and a link repeated changes nothing: still one.
    const second = await analysedWithSnapshot(gl, gitlabReport(1), 1);
    expect(second.branchId).toBe(branchId);
    await linkSnapshot(h.ctx.db, second.analysisId);
    expect(await checksOf(branchId)).toHaveLength(1);
    expect((await snapshotsOf(branchId)).map((s) => s.id)).toEqual([second.snapshotId]);
  });

  it('a refused snapshot schedules no check, and a branch that holds only its reason needs none', async () => {
    gitlabMergeRequest(8);
    const analysisId = await gl.ingestOk(gitlabReport(8));
    const branchId = await branchOf(analysisId);
    // The snapshot names another merge request (R22): rejected, never linked.
    await expect(
      storeTestSnapshot(h.ctx.db, analysisId, [FILE], {
        mergeRequest: { id: '9', title: TITLE, description: null },
      }),
    ).rejects.toThrow('merge_request_mismatch');
    expect(await checksOf(branchId)).toEqual([]);
    // A check queued for the branch all the same finds the reason of the refusal and no copy: it
    // asks the provider nothing.
    await h.ctx.db.transaction((tx) => scheduleMergeRequestCheck(tx, branchId));
    expect(await runCheck(branchId)).toBe(1);
    expect(requestsTo(8)).toHaveLength(0);
    expect((await checksOf(branchId)).map((c) => c.status)).toEqual(['succeeded']);
  });

  it('queues one check however many links race for it', async () => {
    const branchId = uuidv7();
    await Promise.all(
      Array.from({ length: 6 }, () =>
        h.ctx.db.transaction((tx) => scheduleMergeRequestCheck(tx, branchId)),
      ),
    );
    expect(await checksOf(branchId)).toHaveLength(1);
    await h.ctx.db.transaction((tx) => scheduleMergeRequestCheck(tx, branchId));
    expect(await checksOf(branchId)).toHaveLength(1);
  });

  it('the check deletes after a merge and reschedules while open', async () => {
    gitlabMergeRequest(2);
    const { branchId, snapshotId } = await analysedWithSnapshot(gl, gitlabReport(2), 2);
    expect((await snapshotsOf(branchId)).map((s) => s.id)).toEqual([snapshotId]);

    // Open: the copy stays, the check ran once and the next is an hour away.
    expect(await runCheck(branchId)).toBe(1);
    expect(requestsTo(2)).toHaveLength(1);
    expect((await snapshotsOf(branchId)).map((s) => s.id)).toEqual([snapshotId]);
    const afterOpen = await checksOf(branchId);
    expect(afterOpen.map((c) => [c.status, c.attempts])).toEqual([
      ['succeeded', 1],
      ['queued', 0],
    ]);
    expect(afterOpen[1]!.inSeconds).toBeGreaterThan(MR_STATE_CHECK_SECONDS - 60);

    // Merged: the copy and its files go, and nothing is scheduled again.
    gitlab.updateMergeRequest(GITLAB_PROJECT, 2, { state: 'merged' });
    expect(await runCheck(branchId)).toBe(1);
    expect(await snapshotsOf(branchId)).toEqual([]);
    expect(
      await h.ctx.db
        .select({ path: reviewSnapshotFiles.path })
        .from(reviewSnapshotFiles)
        .where(eq(reviewSnapshotFiles.snapshotId, snapshotId)),
    ).toEqual([]);
    expect((await checksOf(branchId)).map((c) => c.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('a closed merge request is deleted too, and a draft one is not', async () => {
    gitlabMergeRequest(3, 'closed');
    const closed = await analysedWithSnapshot(gl, gitlabReport(3), 3);
    await runCheck(closed.branchId);
    expect(await snapshotsOf(closed.branchId)).toEqual([]);

    gitlabMergeRequest(4, 'opened', true);
    const draft = await analysedWithSnapshot(gl, gitlabReport(4), 4);
    await runCheck(draft.branchId);
    expect(await snapshotsOf(draft.branchId)).toHaveLength(1);
    expect(await queuedChecks(draft.branchId)).toHaveLength(1);
  });

  it('a closed GitHub pull request is deleted', async () => {
    githubPull(1, 'open');
    githubPull(2, 'closed');
    githubPull(3, 'closed', true);
    const opened = await analysedWithSnapshot(gh, githubReport(1), 1);
    const closed = await analysedWithSnapshot(gh, githubReport(2), 2);
    const merged = await analysedWithSnapshot(gh, githubReport(3), 3);
    for (const pull of [opened, closed, merged]) await runCheck(pull.branchId);
    expect(await snapshotsOf(closed.branchId)).toEqual([]);
    expect(await snapshotsOf(merged.branchId)).toEqual([]);
    expect(await snapshotsOf(opened.branchId)).toHaveLength(1);
    expect(await queuedChecks(opened.branchId)).toHaveLength(1);
    expect(await queuedChecks(closed.branchId)).toEqual([]);
    // The pull request is closed meanwhile: the next check deletes the copy.
    github.updatePull(REPOSITORY, 1, { state: 'closed' });
    await runCheck(opened.branchId);
    expect(await snapshotsOf(opened.branchId)).toEqual([]);
  });

  it('an SCM error reschedules', async () => {
    gitlabMergeRequest(5);
    const { branchId, snapshotId } = await analysedWithSnapshot(gl, gitlabReport(5), 5);
    // A server error, then a merge request the provider does not know any more: both reschedule,
    // and neither fails the job (its tries are not spent).
    gitlab.inject('GET', /\/merge_requests\/5$/, { status: 500 });
    expect(await runCheck(branchId)).toBe(1);
    gitlab.inject('GET', /\/merge_requests\/5$/, {
      status: 404,
      body: { message: '404 Not found' },
    });
    expect(await runCheck(branchId)).toBe(1);
    expect((await snapshotsOf(branchId)).map((s) => s.id)).toEqual([snapshotId]);
    const checks = await checksOf(branchId);
    expect(checks.map((c) => [c.status, c.attempts])).toEqual([
      ['succeeded', 1],
      ['succeeded', 1],
      ['queued', 0],
    ]);
    expect(checks[2]!.inSeconds).toBeGreaterThan(MR_STATE_CHECK_SECONDS - 60);
    // The provider answers again, and the merge request is merged: now the copy goes.
    gitlab.updateMergeRequest(GITLAB_PROJECT, 5, { state: 'merged' });
    await runCheck(branchId);
    expect(await snapshotsOf(branchId)).toEqual([]);
  });

  it('never waits for a busy organisation or an open circuit: it reschedules without a request', async () => {
    gitlabMergeRequest(6);
    const { branchId, snapshotId } = await analysedWithSnapshot(gl, gitlabReport(6), 6);
    const deps = decorationDeps(h);
    // The organisation's decoration slots are all taken.
    for (let i = 0; i < MAX_DECORATIONS_PER_ORGANIZATION; i += 1) {
      expect(deps.runtime.slots.tryTake(h.organizationId)).toBe(true);
    }
    expect(await runCheck(branchId, deps)).toBe(1);
    expect(requestsTo(6)).toHaveLength(0);
    for (let i = 0; i < MAX_DECORATIONS_PER_ORGANIZATION; i += 1) {
      deps.runtime.slots.release(h.organizationId);
    }
    // The connection's circuit is open.
    for (let i = 0; i < 5; i += 1) deps.runtime.circuit.failure(gl.connectionId);
    expect(deps.runtime.circuit.tryPass(gl.connectionId)).toBe(false);
    expect(await runCheck(branchId, deps)).toBe(1);
    expect(requestsTo(6)).toHaveLength(0);
    expect((await snapshotsOf(branchId)).map((s) => s.id)).toEqual([snapshotId]);
    expect((await checksOf(branchId)).map((c) => c.status)).toEqual([
      'succeeded',
      'succeeded',
      'queued',
    ]);
    // A healthy runtime asks, and finds it merged.
    gitlab.updateMergeRequest(GITLAB_PROJECT, 6, { state: 'merged' });
    expect(await runCheck(branchId)).toBe(1);
    expect(await snapshotsOf(branchId)).toEqual([]);
  });

  it('is done at once when the branch holds no snapshot or is gone, without a request', async () => {
    gitlabMergeRequest(7);
    const { branchId } = await analysedWithSnapshot(gl, gitlabReport(7), 7);
    // Retention (or the purge) deleted the copy since.
    await h.ctx.db.delete(reviewSnapshots).where(eq(reviewSnapshots.branchId, branchId));
    expect(await runCheck(branchId)).toBe(1);
    expect(requestsTo(7)).toHaveLength(0);
    expect((await checksOf(branchId)).map((c) => c.status)).toEqual(['succeeded']);
    // A branch that does not exist, and a payload that is no check's, complete without a retry.
    const gone = uuidv7();
    await enqueue(h.ctx.db, {
      queue: REVIEW_MR_STATE_QUEUE,
      payload: { branchId: gone },
      concurrencyKey: `review-mr-state:branch:${gone}`,
    });
    const malformed = await enqueue(h.ctx.db, {
      queue: REVIEW_MR_STATE_QUEUE,
      payload: { branch: 'x' },
    });
    expect(await runCheck(gone)).toBeGreaterThanOrEqual(1);
    expect(
      (await h.ctx.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, malformed)))[0],
    ).toEqual({ status: 'succeeded' });
    expect((await checksOf(gone)).map((c) => c.status)).toEqual(['succeeded']);
  });
});

describe('the purge of the snapshots of projects without AI review (6I-3, R17)', () => {
  let llm: FakeLlm;
  let h: IngestHarness;
  let admin: Session;
  let orgA: string;
  let orgB: string;
  /** In `orgA`, selected and mapped. */
  let a1: IngestProject;
  /** In `orgA`, selected and mapped: the one the tests exclude. */
  let a2: IngestProject;
  /** In `orgA`, never mapped to an SCM connection. */
  let a3: IngestProject;
  /** In `orgB`, selected and mapped. */
  let b1: IngestProject;
  /** The SCM connections of `orgA` (a1 and a2 are mapped to it) and `orgB` (b1 is). */
  let connectionA: string;
  let connectionB: string;
  let seq = 0;

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    session: Session,
    payload?: object,
  ) =>
    h.ctx.app.inject({
      method,
      url: `/api/v0${url}`,
      headers: session.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  /** AI review on for both organisations: every project in scope, the consent the provider's. */
  const reviewOn = async (over: { excluded?: string[] } = {}) => {
    await switchReviewOn(h.ctx.db, {
      secretKey: h.ctx.config.secretKey,
      fake: llm,
      organizationId: orgA,
      userId: h.ctx.adminId,
    });
    const settings = await readLlmSettings(h.ctx.db);
    const entry = settings.organizations[orgA]!;
    await writeLlmSettings(h.ctx.db, {
      ...settings,
      organizations: {
        [orgA]: { ...entry, excludedProjectIds: over.excluded ?? [] },
        [orgB]: { ...entry },
      },
    });
  };
  /** A merge request analysis of `project` with its snapshot unpacked and linked. */
  const snapshotOf = async (project: IngestProject): Promise<string> => {
    seq += 1;
    const analysisId = await project.ingestOk(
      mergeRequestReport(seq, HEAD, { projectKey: project.key }),
    );
    return storeTestSnapshot(h.ctx.db, analysisId, [FILE], {
      mergeRequest: { id: String(seq), title: TITLE, description: null },
    });
  };
  const snapshotCount = async (project: IngestProject): Promise<number> =>
    (
      await h.ctx.db
        .select({ id: reviewSnapshots.id })
        .from(reviewSnapshots)
        .where(eq(reviewSnapshots.projectId, project.id))
    ).length;
  const snapshotIds = async (project: IngestProject): Promise<string[]> =>
    (
      await h.ctx.db
        .select({ id: reviewSnapshots.id })
        .from(reviewSnapshots)
        .where(eq(reviewSnapshots.projectId, project.id))
    ).map((row) => row.id);
  /** Every project's snapshots at once, in the order a1, a2, a3, b1. */
  const counts = async () => [
    await snapshotCount(a1),
    await snapshotCount(a2),
    await snapshotCount(a3),
    await snapshotCount(b1),
  ];
  const seedAll = async () => {
    for (const project of [a1, a2, a3, b1]) await snapshotOf(project);
    expect(await counts()).toEqual([1, 1, 1, 1]);
  };
  const purgeJobs = () =>
    h.ctx.db
      .select({ payload: jobs.payload, key: jobs.concurrencyKey })
      .from(jobs)
      .where(
        and(
          eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE),
          eq(jobs.status, 'queued'),
          sql`(jsonb_exists(${jobs.payload}, 'purgeOrganizationId') OR jsonb_exists(${jobs.payload}, 'purgeProjectId'))`,
        ),
      );
  /** The analysis worker's `review-snapshot` jobs: the unpacks and the purges. */
  const runSnapshotJobs = () =>
    runUntilIdle(
      h.ctx.db,
      reviewSnapshotHandlers({
        db: h.ctx.db,
        logger: h.ctx.app.log,
        limits: h.ctx.config.reviewSnapshot,
      }),
      silentLogger,
    );
  /** The instance admin's form as `GET /system/llm` shows it, `change`d. */
  const settingsBody = async (change: (body: Record<string, unknown>) => void) => {
    const read = (await call('GET', '/system/llm', admin)).json();
    const p = read.provider;
    const body = {
      ...read,
      provider: {
        kind: p.kind,
        baseUrl: p.baseUrl,
        model: p.model,
        auth: p.auth,
        jsonMode: p.jsonMode,
        maxTokensField: p.maxTokensField,
        temperature: p.temperature,
        timeoutSeconds: p.timeoutSeconds,
      },
    };
    change(body);
    return body;
  };
  /** A GitLab connection of the organisation, as the API would have stored it. */
  const connect = async (organizationId: string): Promise<string> =>
    first(
      await h.ctx.db
        .insert(scmConnections)
        .values({
          organizationId,
          provider: 'gitlab',
          baseUrl: 'https://gitlab.example.com',
          tokenEnc: encryptSecret(encryptionKey(h.ctx.config.secretKey), 'x', SCM_TOKEN_AAD),
        })
        .returning({ id: scmConnections.id }),
    ).id;
  const mapTo = (project: IngestProject, connectionId: string | null) =>
    h.ctx.db
      .update(projects)
      .set({ scmConnectionId: connectionId })
      .where(eq(projects.id, project.id));
  /** `n` snapshots of a project without files or an upload: rows for the counts of a purge. */
  const bulkSnapshots = async (project: IngestProject, n: number): Promise<string[]> => {
    const made = await h.ctx.db
      .insert(analyses)
      .values(Array.from({ length: n }, () => ({ projectId: project.id })))
      .returning({ id: analyses.id });
    const rows = await h.ctx.db
      .insert(reviewSnapshots)
      .values(
        made.map((analysis) => ({
          analysisId: analysis.id,
          projectId: project.id,
          status: 'rejected' as const,
          error: 'SNAPSHOT_INVALID:test',
          compressedBytes: 0,
        })),
      )
      .returning({ id: reviewSnapshots.id });
    return rows.map((row) => row.id);
  };

  beforeAll(async () => {
    llm = await createFakeLlm();
    h = await createIngestHarness({
      config: { publicUrl: PUBLIC_URL, llmInternalHosts: parseInternalHosts(llm.host) },
    });
    admin = await login(h.ctx, 'admin', ADMIN_PASSWORD);
    orgA = h.organizationId;
    const created = await call('POST', '/organizations', admin, {
      key: 'purge-b',
      name: 'Purge B',
    });
    expect(created.statusCode, created.body).toBe(201);
    orgB = (created.json() as { id: string }).id;
    expect(orgB).toBe(await organizationId(h.ctx, 'purge-b'));
    a1 = await h.project('purge/a1');
    a2 = await h.project('purge/a2');
    a3 = await h.project('purge/a3');
    b1 = await h.project('purge/b1', { organizationId: orgB, session: admin });
    // a1 and a2 are mapped to an SCM connection of their organisation, b1 to one of its own.
    connectionA = await connect(orgA);
    connectionB = await connect(orgB);
    for (const [project, connection] of [
      [a1, connectionA],
      [a2, connectionA],
      [b1, connectionB],
    ] as const) {
      await h.ctx.db
        .update(projects)
        .set({ scmConnectionId: connection, scmProjectRef: String(project.key.length) })
        .where(eq(projects.id, project.id));
    }
  });
  afterAll(async () => {
    await h.close();
    await llm.close();
  });
  beforeEach(async () => {
    await h.ctx.db.delete(reviewSnapshots);
    await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
    await reviewOn();
  });

  it("switching review off purges the organisation's snapshots", async () => {
    await seedAll();
    await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
    const off = {
      enabled: false,
      scope: 'all',
      projectIds: [],
      budgets: { ...DEFAULT_REVIEW.budgets },
    };
    const res = await call('PUT', `/organizations/${orgA}/ai/review`, h.orgAdmin, off);
    expect(res.statusCode, res.body).toBe(200);
    // The route only queues the purge: nothing is deleted while it answers.
    expect(await counts()).toEqual([1, 1, 1, 1]);
    expect(await purgeJobs()).toEqual([
      { payload: { purgeOrganizationId: orgA }, key: 'review-snapshot:purge' },
    ]);
    await runSnapshotJobs();
    // The organisation's copies are gone, the other organisation's stay.
    expect(await counts()).toEqual([0, 0, 0, 1]);
    // Saving the same again changes nothing, so nothing is queued.
    const again = await call('PUT', `/organizations/${orgA}/ai/review`, h.orgAdmin, off);
    expect(again.statusCode, again.body).toBe(200);
    expect(await purgeJobs()).toEqual([]);
  });

  it('a save that leaves some projects out of the selection purges them too', async () => {
    await seedAll();
    // Scope `selected` with only a1 listed: a2 is out of the selection (a3 is unmapped anyway).
    const res = await call('PUT', `/organizations/${orgA}/ai/review`, h.orgAdmin, {
      enabled: true,
      scope: 'selected',
      projectIds: [a1.id],
      budgets: { ...DEFAULT_REVIEW.budgets },
    });
    expect(res.statusCode, res.body).toBe(200);
    await runSnapshotJobs();
    expect(await counts()).toEqual([1, 0, 0, 1]);
  });

  it('excluding a project from the AI assistant purges its snapshots', async () => {
    await seedAll();
    await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
    const body = await settingsBody((b) => {
      const organizations = b.organizations as Record<string, { excludedProjectIds: string[] }>;
      organizations[orgA]!.excludedProjectIds = [a2.id];
    });
    // A save that is refused queues nothing.
    const refused = await call('PUT', '/system/llm', admin, {
      ...body,
      budgets: { ...(body.budgets as object), fixPerDay: 100_001 },
    });
    expect(refused.statusCode).toBe(422);
    expect(await purgeJobs()).toEqual([]);

    const res = await call('PUT', '/system/llm', admin, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(await counts()).toEqual([1, 1, 1, 1]);
    // Any of its settings can change who is reviewed, so the purge looks at every organisation.
    expect((await purgeJobs()).map((job) => job.payload)).toEqual([{ purgeOrganizationId: null }]);
    await runSnapshotJobs();
    // a2 is excluded now, and a3 was never mapped; a1 and b1 stay.
    expect(await counts()).toEqual([1, 0, 0, 1]);
  });

  it('unmapping a project purges its snapshots, and a PATCH that leaves the mapping alone queues nothing', async () => {
    await seedAll();
    await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
    const patch = (project: IngestProject, payload: object) =>
      call('PATCH', `/projects/${project.id}`, h.orgAdmin, payload);
    const other = await connect(orgA);
    try {
      // Neither a rename nor a project that was never mapped changes what AI review covers.
      for (const [project, payload] of [
        [a1, { name: 'Renamed' }],
        [a3, { scmConnectionId: null }],
      ] as const) {
        const res = await patch(project, payload);
        expect(res.statusCode, JSON.stringify(payload) + res.body).toBe(200);
      }
      expect(await purgeJobs()).toEqual([]);

      // Mapped to another repository or connection: the copies of the old one go (R41).
      for (const payload of [{ scmProjectRef: '77' }, { scmConnectionId: other }]) {
        await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
        const res = await patch(a1, payload);
        expect(res.statusCode, JSON.stringify(payload) + res.body).toBe(200);
        expect(await purgeJobs()).toEqual([
          {
            payload: { purgeProjectId: a1.id, createdBefore: expect.any(String) },
            key: 'review-snapshot:purge',
          },
        ]);
      }
      await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));

      // The mapping goes: the route queues the purge of the organisation and deletes nothing.
      const res = await patch(a1, { scmConnectionId: null });
      expect(res.statusCode, res.body).toBe(200);
      expect(await counts()).toEqual([1, 1, 1, 1]);
      expect(await purgeJobs()).toEqual([
        { payload: { purgeOrganizationId: orgA }, key: 'review-snapshot:purge' },
      ]);
      await runSnapshotJobs();
      // a1 is unmapped now, and a3 never was; a2 and the other organisation's b1 are reviewed.
      expect(await counts()).toEqual([0, 1, 0, 1]);
    } finally {
      await mapTo(a1, connectionA);
      await h.ctx.db
        .update(projects)
        .set({ scmProjectRef: String(a1.key.length) })
        .where(eq(projects.id, a1.id));
    }
  });

  it('a remap deletes the snapshots made before it and keeps one uploaded after it (Review Focus 5)', async () => {
    await seedAll();
    await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
    try {
      const res = await call('PATCH', `/projects/${a1.id}`, h.orgAdmin, { scmProjectRef: '77' });
      expect(res.statusCode, res.body).toBe(200);
      // A new analysis stores its snapshot after the remap, before the job runs.
      const s2 = await snapshotOf(a1);
      await runSnapshotJobs();
      expect(await snapshotIds(a1)).toEqual([s2]);
      // a2, a3 and b1 are untouched (seedAll gave each one snapshot).
      expect(await counts()).toEqual([1, 1, 1, 1]);
    } finally {
      await h.ctx.db
        .update(projects)
        .set({ scmProjectRef: String(a1.key.length) })
        .where(eq(projects.id, a1.id));
    }
  });

  it('a remap purge that skips a locked old snapshot fails, and its retry deletes it', async () => {
    const [locked] = [await snapshotOf(a1)];
    const cutoff = new Date(Date.now() + 60_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const other = h.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM review_snapshots WHERE id = ${locked} FOR UPDATE`);
      held();
      await gate;
    });
    await holding;
    try {
      // The row another transaction holds is skipped, but the purge must not report success.
      await expect(purgeProjectSnapshots(h.ctx.db, a1.id, cutoff)).rejects.toThrow(/locked/);
      expect(await snapshotIds(a1)).toEqual([locked]);
    } finally {
      release();
      await other;
    }
    // The job queue retries a throwing handler; the retry finds the row free.
    expect(await purgeProjectSnapshots(h.ctx.db, a1.id, cutoff)).toBe(1);
    expect(await snapshotIds(a1)).toEqual([]);
  });

  it('unmap then remap before the purge runs still drops the old repository snapshots', async () => {
    await seedAll();
    await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
    const patch = (payload: object) => call('PATCH', `/projects/${a1.id}`, h.orgAdmin, payload);
    const other = await connect(orgA);
    try {
      // A no-op PATCH (same mapping) queues nothing.
      const same = await patch({
        scmConnectionId: connectionA,
        scmProjectRef: String(a1.key.length),
      });
      expect(same.statusCode, same.body).toBe(200);
      expect(await purgeJobs()).toEqual([]);

      expect((await patch({ scmConnectionId: null })).statusCode).toBe(200);
      expect((await patch({ scmConnectionId: other })).statusCode).toBe(200);
      await runSnapshotJobs();
      // a3 was never mapped, so the unmap's organisation purge takes its copy too.
      expect(await counts()).toEqual([0, 1, 0, 1]);
    } finally {
      await mapTo(a1, connectionA);
    }
  });

  it('deleting an SCM connection purges the snapshots of the projects it unmapped', async () => {
    // a2 is mapped to a connection of its own, which the organisation admin deletes.
    const own = await connect(orgA);
    await mapTo(a2, own);
    try {
      await seedAll();
      await h.ctx.db.delete(jobs).where(eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE));
      const res = await call('DELETE', `/scm-connections/${own}`, h.orgAdmin);
      expect(res.statusCode, res.body).toBe(204);
      expect(await counts()).toEqual([1, 1, 1, 1]);
      expect(await purgeJobs()).toEqual([
        { payload: { purgeOrganizationId: orgA }, key: 'review-snapshot:purge' },
      ]);
      await runSnapshotJobs();
      // a2 lost its mapping with the connection, and a3 never had one; a1 and b1 are reviewed.
      expect(await counts()).toEqual([1, 0, 0, 1]);
      // A connection that is gone cannot be deleted twice: the second answer queues nothing.
      expect((await call('DELETE', `/scm-connections/${own}`, h.orgAdmin)).statusCode).toBe(404);
      expect(await purgeJobs()).toEqual([]);
    } finally {
      await mapTo(a2, connectionA);
    }
  });

  it('removing the provider purges every organisation', async () => {
    await seedAll();
    const body = await settingsBody((b) => {
      b.provider = null;
    });
    const res = await call('PUT', '/system/llm', admin, body);
    expect(res.statusCode, res.body).toBe(200);
    await runSnapshotJobs();
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });

  it('housekeeping purges inactive projects', async () => {
    await seedAll();
    // a2 is excluded from the AI assistant and a3 was never mapped; a1 and b1 are reviewed.
    await reviewOn({ excluded: [a2.id] });
    const result = await runHousekeeping(h.ctx.db);
    expect(result.reviewSnapshotsInactive).toBe(2);
    expect(await counts()).toEqual([1, 0, 0, 1]);
    // The retention rules are their own step: nothing was old.
    expect(result.reviewSnapshots).toBe(0);
    expect((await runHousekeeping(h.ctx.db)).reviewSnapshotsInactive).toBe(0);
  });

  describe('purgeInactiveSnapshots', () => {
    it('keeps the snapshots of the projects it reviews, and purges one organisation or all', async () => {
      await seedAll();
      // Only a3 is unmapped: the organisation asked for is purged of it, and of nothing else.
      expect(await purgeInactiveSnapshots(h.ctx.db, orgB)).toBe(0);
      expect(await counts()).toEqual([1, 1, 1, 1]);
      expect(await purgeInactiveSnapshots(h.ctx.db, orgA)).toBe(1);
      expect(await counts()).toEqual([1, 1, 0, 1]);
      await writeLlmSettings(h.ctx.db, { ...(await readLlmSettings(h.ctx.db)), provider: null });
      // Review is off for everyone now, but only the organisation asked for is purged.
      expect(await purgeInactiveSnapshots(h.ctx.db, orgB)).toBe(1);
      expect(await counts()).toEqual([1, 1, 0, 0]);
      expect(await purgeInactiveSnapshots(h.ctx.db, null)).toBe(2);
      expect(await counts()).toEqual([0, 0, 0, 0]);
      expect(await purgeInactiveSnapshots(h.ctx.db, null)).toBe(0);
    });

    it('purges a snapshot in any state with its files, a not yet unpacked upload too', async () => {
      const ready = await snapshotOf(a2);
      seq += 1;
      const analysisId = await a2.ingestOk(mergeRequestReport(seq, HEAD, { projectKey: a2.key }));
      const upload = await storeSnapshotUpload(h.ctx.db, {
        analysisId,
        projectId: a2.id,
        body: Buffer.from('gzip'),
        compressedBytes: 4,
      });
      const [rejected] = await bulkSnapshots(a2, 1);
      await reviewOn({ excluded: [a2.id] });
      expect(await purgeInactiveSnapshots(h.ctx.db, orgA)).toBe(3);
      const left = await h.ctx.db
        .select({ id: reviewSnapshots.id })
        .from(reviewSnapshots)
        .where(inArray(reviewSnapshots.id, [ready, upload, rejected!]));
      expect(left).toEqual([]);
      expect(
        await h.ctx.db
          .select({ path: reviewSnapshotFiles.path })
          .from(reviewSnapshotFiles)
          .where(eq(reviewSnapshotFiles.snapshotId, ready)),
      ).toEqual([]);
    });

    it('deletes in batches until none is left, whatever their number', async () => {
      await reviewOn({ excluded: [a2.id] });
      for (const n of [50, 51, 120]) {
        await bulkSnapshots(a2, n);
        expect(await purgeInactiveSnapshots(h.ctx.db, null)).toBe(n);
        expect(await snapshotCount(a2)).toBe(0);
      }
    });

    it('skips what another transaction holds, never waits for it, and takes it next time', async () => {
      await reviewOn({ excluded: [a2.id] });
      const ids = await bulkSnapshots(a2, 5);
      const held = ids[0]!;
      let purged = -1;
      await h.ctx.db.transaction(async (tx) => {
        await tx
          .select({ id: reviewSnapshots.id })
          .from(reviewSnapshots)
          .where(eq(reviewSnapshots.id, held))
          .for('update');
        // Another connection: it would wait for this lock if it did not skip the row.
        purged = await purgeInactiveSnapshots(h.ctx.db, null);
      });
      expect(purged).toBe(4);
      expect(await snapshotCount(a2)).toBe(1);
      expect(await purgeInactiveSnapshots(h.ctx.db, null)).toBe(1);
      expect(await snapshotCount(a2)).toBe(0);
    });
  });
});
