import { randomUUID } from 'node:crypto';
import type { Report } from '@qualor/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import { file, finding, reportWith } from '../../test/reports';
import { seedAiIssue, storeTestSnapshot } from '../../test/review';
import {
  decorationDeps,
  mappedProject,
  mergeRequestReport,
  PUBLIC_URL,
  queuedDecorations,
  runDecorations,
  scmTestConfig,
} from '../../test/scm';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import type { Db } from '../db/client';
import {
  branches,
  issues,
  jobs,
  reviewFindings,
  reviewRuns,
  reviewSnapshots,
  scmConnections,
  type AiCategory,
} from '../db/schema';
import type { Job } from '../queue/queue';
import { SCM_TOKEN_AAD } from './connections';
import { markerOf } from './markdown';
import { scmHandlers } from './decorate';
import {
  enqueueDecoration,
  inSeconds,
  MAX_DECORATION_ATTEMPTS,
  REDECORATION_INTERVAL_SECONDS,
  requeueDecoration,
  SCM_QUEUE,
} from './queue';
import { statusName } from './render';
import { createScmRuntime, SCM_CIRCUIT_FAILURES } from './runtime';

const HEAD = '1'.repeat(40);

/** Polls until `n` backends of this file's own database wait on a lock (never a fixed sleep). */
async function waitForLockWaiters(db: Db, n: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`);
    if (Number(result.rows[0]?.n) >= n) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${n} lock waiter(s)`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const BASE = 'b'.repeat(40);
const DIFF = '@@ -1,2 +1,5 @@\n a\n b\n+c\n+d\n+e\n';

describe('GitLab decoration: commit status and summary (scm.md §4, §5.1–§5.3)', () => {
  let h: IngestHarness;
  let fake: FakeGitLab;
  let nextGitLabProject = 100;

  /** A mapped project with an open merge request !12 at HEAD. */
  const setup = async (key: string, options: { ownConnection?: boolean } = {}) => {
    const gitlabId = nextGitLabProject++;
    fake.addProject({ id: gitlabId, path: `acme/${key.replace(/\W/g, '-')}` });
    fake.addPipeline(gitlabId, 99001, 'main');
    fake.addMergeRequest(gitlabId, {
      iid: 12,
      title: 'Refund limits\u0000 @all',
      state: 'opened',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      headSha: HEAD,
      baseSha: BASE,
      startSha: BASE,
      diffs: [{ oldPath: 'src/a.ts', newPath: 'src/a.ts', diff: DIFF }],
    });
    const project = await mappedProject(h, fake, key, gitlabId, options);
    return { project, gitlabId };
  };
  const summaries = (gitlabId: number) =>
    fake
      .discussions(gitlabId, 12)
      .flatMap((d) => d.notes)
      .filter((n) => markerOf(n.body)?.kind === 'summary');
  const statusesOf = (gitlabId: number) => fake.statuses.filter((s) => s.projectId === gitlabId);
  const writes = () =>
    fake.requests.filter((r) => r.method !== 'GET').map((r) => r.method + r.path);
  /** The AI review section of a summary: from its heading to the end. */
  const sectionOf = (body: string) => body.slice(body.indexOf('#### AI review'));

  beforeAll(async () => {
    fake = await createFakeGitLab();
    h = await createIngestHarness({ config: scmTestConfig(fake) });
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });
  beforeEach(() => fake.clearRequests());

  it('sets the commit status of a main-branch analysis, with its pipeline and a link', async () => {
    const { project, gitlabId } = await setup('scm/main');
    const analysisId = await project.ingestOk({
      ...reportWith({ projectKey: project.key, revision: 'c'.repeat(40) }),
      scm: {
        ...reportWith({ projectKey: project.key, revision: 'c'.repeat(40) }).scm,
        gitlab: { projectId: String(gitlabId), pipelineId: '99001' },
      },
    });
    expect(await runDecorations(h, decorationDeps(h))).toBe(1);
    const [main] = await h.ctx.db.select().from(branches).where(eq(branches.projectId, project.id));
    expect(statusesOf(gitlabId)).toEqual([
      {
        projectId: gitlabId,
        sha: 'c'.repeat(40),
        name: `qualor/${project.key}`,
        state: 'failed',
        description: 'Quality gate failed: new_issues 1 > 0',
        targetUrl: `${PUBLIC_URL}/projects/${project.id}/branches/${main!.id}`,
        pipelineId: 99001,
        ref: 'main',
      },
    ]);
    // With a pipeline, GitLab takes the ref from it: none is sent beside pipeline_id.
    const posted = fake.requests.find((r) => r.method === 'POST');
    expect(JSON.parse(posted!.body)).not.toHaveProperty('ref');
    // A branch analysis never touches merge requests.
    expect(fake.requests.some((r) => r.path.includes('merge_requests'))).toBe(false);
    expect(analysisId).toBeTruthy();
  });

  it('adds no status row on a rerun when GitLab refused the pipeline and took the status without it', async () => {
    const { project, gitlabId } = await setup('scm/gone-pipeline');
    const revision = 'd'.repeat(40);
    const base = reportWith({ projectKey: project.key, revision });
    // A pipeline GitLab does not know (deleted, say): the post with it is refused (404), and the
    // status is posted again with the ref only, which GitLab attaches to another pipeline.
    const analysisId = await project.ingestOk({
      ...base,
      scm: { ...base.scm, gitlab: { projectId: String(gitlabId), pipelineId: '424242' } },
    });
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(gitlabId)).toHaveLength(1);
    expect(statusesOf(gitlabId)[0]).toMatchObject({ pipelineId: null, ref: 'main' });
    const [main] = await h.ctx.db.select().from(branches).where(eq(branches.projectId, project.id));
    // The same decoration again (a retry, a re-evaluation): the listed status is on another
    // pipeline, but its name and ref match and it says the same, so nothing is posted again.
    for (let run = 0; run < 2; run++) {
      fake.clearRequests();
      await enqueueDecoration(h.ctx.db, {
        analysisId,
        branchId: main!.id,
        gitlab: { projectId: String(gitlabId), pipelineId: '424242' },
      });
      await runDecorations(h, decorationDeps(h));
      expect(statusesOf(gitlabId)).toHaveLength(1);
      expect(
        fake.requests.filter((r) => r.method === 'POST' && !/"pipeline_id"/.test(r.body)),
      ).toHaveLength(0);
    }
  });

  it('posts one summary on the merge request and edits it in place afterwards', async () => {
    const { project, gitlabId } = await setup('scm/mr');
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        gitlab: { projectId: String(gitlabId), mergeRequestEventType: 'detached' },
      }),
    );
    await runDecorations(h, decorationDeps(h));
    const [summary] = summaries(gitlabId);
    expect(summaries(gitlabId)).toHaveLength(1);
    expect(summary?.authorId).toBe(fake.botUserId);
    expect(summary?.body).toContain('### ❌ Qualor: quality gate failed');
    expect(summary?.body).toContain('**1 new issue** in this merge request');
    expect(summary?.body).toContain('**By severity:** 🟠 1 medium');
    expect(summary?.body).toMatch(
      /^1\. 🟠 \*\*Medium\*\* · \w+ · ` [^`]+ ` · \S*` src\/a\.ts:3 `\S*\\\n {3}` Unexpected console statement\. `$/m,
    );
    // Without a pipeline, the status names the merge request's source branch as its ref.
    expect(statusesOf(gitlabId).map((s) => [s.state, s.ref])).toEqual([['failed', 'feature/x']]);
    // The merge request's title and URL land on the branch, the title without controls.
    const [mr] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    expect(mr).toMatchObject({
      kind: 'merge_request',
      mrTitle: 'Refund limits  @all',
      mrUrl: `${fake.url}/acme/scm-mr/-/merge_requests/12`,
    });
    // The same job again changes nothing on GitLab: no second note, no edit, and no status post
    // (GitLab would add a second row for the same final state, so the job reads it first).
    fake.clearRequests();
    await enqueueDecoration(h.ctx.db, {
      analysisId: mr!.lastAnalysisId!,
      branchId: mr!.id,
      gitlab: null,
    });
    await runDecorations(h, decorationDeps(h));
    expect(summaries(gitlabId)).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(statusesOf(gitlabId)).toHaveLength(1);
    // A new analysis (the issue fixed) edits the same note.
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        findings: [],
        analysisDate: '2026-09-23T10:15:00Z',
      }),
    );
    await runDecorations(h, decorationDeps(h));
    expect(summaries(gitlabId)).toHaveLength(1);
    expect(summaries(gitlabId)[0]?.body).toContain('### ✅ Qualor: quality gate passed');
    expect(statusesOf(gitlabId).map((s) => s.state)).toEqual(['failed', 'success']);
    // Another analysis with the same result posts no status and edits nothing.
    fake.clearRequests();
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        findings: [],
        analysisDate: '2026-09-23T10:30:00Z',
      }),
    );
    await runDecorations(h, decorationDeps(h));
    expect(writes()).toEqual([]);
    expect(statusesOf(gitlabId)).toHaveLength(2);
  });

  it('puts the state of the AI review in the summary, edited in place as the review goes on', async () => {
    const { project, gitlabId } = await setup('scm/ai-section');
    const analysisId = await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        gitlab: { projectId: String(gitlabId), mergeRequestEventType: 'detached' },
      }),
    );
    await runDecorations(h, decorationDeps(h));
    const body = () => summaries(gitlabId)[0]!.body;
    expect(body()).not.toContain('AI review');
    const [mr] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    const decorateAgain = async () => {
      await enqueueDecoration(h.ctx.db, { analysisId, branchId: mr!.id, gitlab: null });
      await runDecorations(h, decorationDeps(h));
      expect(summaries(gitlabId)).toHaveLength(1);
    };

    // The review waits for its snapshot: the summary says it is in progress, in the same note.
    const [run] = await h.ctx.db
      .insert(reviewRuns)
      .values({
        projectId: project.id,
        branchId: mr!.id,
        analysisId,
        status: 'waiting',
        deadlineAt: new Date(Date.now() + 900_000),
      })
      .returning();
    await decorateAgain();
    expect(body()).toContain('### ❌ Qualor: quality gate failed');
    expect(body().endsWith('\n\n#### AI review\n\nAI review in progress…')).toBe(true);

    // It ended without a review: the reason, in a sentence of Qualor's.
    await h.ctx.db
      .update(reviewRuns)
      .set({ status: 'skipped', reason: 'no_snapshot' })
      .where(eq(reviewRuns.id, run!.id));
    await decorateAgain();
    expect(body()).toContain('no repository snapshot came for this commit');
    expect(body()).not.toContain('in progress');

    // It is done, for another commit than the merge request is at now, with a finding that sits on
    // no changed line, and the summary says so.
    const issueId = await seedAiIssue(h.ctx.db, {
      branchId: mr!.id,
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
      reviewedHeadSha: '2'.repeat(40),
    });
    await h.ctx.db
      .update(reviewRuns)
      .set({
        status: 'done',
        reason: null,
        headSha: '2'.repeat(40),
        summary: {
          verdict: 'Adds refunds @all, but one path can fail.',
          walkthrough: ['Adds a refund endpoint'],
          notes: [],
        },
      })
      .where(eq(reviewRuns.id, run!.id));
    await decorateAgain();
    expect(body()).toContain('#### AI review\n\nAdds refunds ` @all, ` but one path can fail.');
    expect(body()).toContain('**Findings:** 1 high · 0 medium · 0 low');
    expect(body()).toContain('- Adds a refund endpoint');
    expect(body()).toMatch(
      /^- \*\*High\*\* · ` src\/a\.ts:3 ` · AI finding \d+ · \[View in Qualor\]/m,
    );
    expect(body()).toContain(
      `[View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${issueId})`,
    );
    // The merge request is at HEAD; the review covered another commit, and the summary says so.
    expect(body()).toContain(
      'Reviewed commit: ` 222222222222 `; the merge request is now at ` 111111111111 `; the next pipeline reviews the new commits.',
    );
    // The AI finding is none of the analyzers' numbers.
    expect(body()).toContain('**1 new issue** in this merge request');

    // The review covered the head: the merge request has not moved on.
    await h.ctx.db.update(reviewRuns).set({ headSha: HEAD }).where(eq(reviewRuns.id, run!.id));
    await decorateAgain();
    expect(body()).toContain('Reviewed commit: ` 111111111111 `');
    expect(sectionOf(body())).not.toContain('is now at');

    // The run of an older analysis a newer one superseded shows nothing.
    await h.ctx.db
      .update(reviewRuns)
      .set({ status: 'superseded' })
      .where(eq(reviewRuns.id, run!.id));
    await decorateAgain();
    expect(body()).not.toContain('AI review');
  });

  it('never edits a summary marker in someone else’s note, and a stale analysis only sets its status', async () => {
    const { project, gitlabId } = await setup('scm/foreign');
    fake.addNote(gitlabId, 12, {
      body: `<!-- qualor:summary ${project.id} -->\nforged`,
      authorId: 5,
    });
    fake.updateMergeRequest(gitlabId, 12, { headSha: 'f'.repeat(40) });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await runDecorations(h, decorationDeps(h));
    const notes = fake.discussions(gitlabId, 12).flatMap((d) => d.notes);
    // A Developer token may not delete another user's note: it stays, and the job still succeeds.
    expect(notes.find((n) => n.authorId === 5)?.body).toContain('forged');
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(true);
    expect(await queuedDecorations(h)).toHaveLength(0);
    const own = notes.filter((n) => n.authorId === fake.botUserId);
    expect(own).toHaveLength(1);
    expect(own[0]?.body).toContain('the merge request is now at ` ffffffffffff `');
  });

  it('replaces the summary an earlier token’s user posted when the token may delete it (Maintainer)', async () => {
    const { project, gitlabId } = await setup('scm/replaced-token');
    // The summary of the previous token's bot user, and a reply in a thread quoting its marker.
    const old = fake.addNote(gitlabId, 12, {
      body: `<!-- qualor:summary ${project.id} -->\n### Qualor: quality gate passed`,
      authorId: 77,
    });
    const oldNoteId = old.notes[0]!.id;
    const thread = fake.addNote(gitlabId, 12, { body: 'Why?', authorId: 5 });
    thread.individualNote = false;
    fake.reply(gitlabId, 12, thread.id, {
      body: `<!-- qualor:summary ${project.id} -->\nquoted`,
      authorId: 5,
    });
    fake.accessLevel = 40;
    try {
      await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
      await runDecorations(h, decorationDeps(h));
    } finally {
      fake.accessLevel = 30;
    }
    // The old summary is gone, the reply in the thread is left alone, and one summary is new.
    expect(fake.discussions(gitlabId, 12).some((d) => d.id === old.id)).toBe(false);
    expect(summaries(gitlabId).map((n) => n.authorId)).toEqual([5, fake.botUserId]);
    expect(summaries(gitlabId)[1]?.body).toContain('### ❌ Qualor: quality gate failed');
    expect(writes().filter((w) => w.startsWith('DELETE'))).toEqual([
      `DELETE/projects/${gitlabId}/merge_requests/12/notes/${oldNoteId}`,
    ]);
    expect(await queuedDecorations(h)).toHaveLength(0);
  });

  it('never says "now at" for a merged-results pipeline, whose merge commit is never the head (§5.2)', async () => {
    const { project, gitlabId } = await setup('scm/merged-result');
    const mergeCommit = '9'.repeat(40);
    await project.ingestOk(
      mergeRequestReport(12, mergeCommit, {
        projectKey: project.key,
        gitlab: { projectId: String(gitlabId), mergeRequestEventType: 'merged_result' },
      }),
    );
    await runDecorations(h, decorationDeps(h));
    const [summary] = summaries(gitlabId);
    expect(summary?.body).toContain('merged-results pipeline');
    expect(summary?.body).not.toContain('now at');
    // The merge commit's status goes to the source branch's ref (it is on no branch itself).
    expect(statusesOf(gitlabId)).toMatchObject([{ sha: mergeCommit, ref: 'feature/x' }]);
  });

  it('decorates nothing for a local scan, an unmapped project or a closed merge request', async () => {
    const { project, gitlabId } = await setup('scm/nothing');
    const local = reportWith({ projectKey: project.key });
    await project.ingestOk({ ...local, scm: { ...local.scm, provider: 'none' } });
    expect(await queuedDecorations(h)).toHaveLength(0);
    const unmapped = await h.project('scm/unmapped');
    await unmapped.ingestOk(reportWith({ projectKey: unmapped.key }));
    expect(await queuedDecorations(h)).toHaveLength(0);
    fake.updateMergeRequest(gitlabId, 12, { state: 'merged' });
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        analysisDate: '2026-09-23T10:15:00Z',
      }),
    );
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(gitlabId)).toHaveLength(1);
    expect(fake.discussions(gitlabId, 12)).toHaveLength(0);
  });

  it('refuses a pipeline of another GitLab project than the mapped one', async () => {
    const { project, gitlabId } = await setup('scm/mismatch');
    await project.ingestOk(
      mergeRequestReport(12, HEAD, { projectKey: project.key, gitlab: { projectId: '999999' } }),
    );
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(gitlabId)).toHaveLength(0);
    expect(fake.discussions(gitlabId, 12)).toHaveLength(0);
    expect(await queuedDecorations(h)).toHaveLength(0);
  });

  it('retries a 429 after Retry-After and 5xx with backoff, and stops at once on 401', async () => {
    const { project, gitlabId } = await setup('scm/retry');
    const deps = decorationDeps(h);
    fake.inject('POST', new RegExp(`^/projects/${gitlabId}/statuses/`), {
      status: 429,
      headers: { 'retry-after': '600' },
    });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await runDecorations(h, deps);
    const [retry] = await queuedDecorations(h);
    expect(retry?.payload).toMatchObject({ attempt: 1 });
    // On the database clock: the retry is created and scheduled by it (Node's may drift).
    const inSeconds = (retry!.runAt.getTime() - retry!.createdAt.getTime()) / 1000;
    expect(inSeconds).toBeGreaterThan(595);
    expect(inSeconds).toBeLessThan(605);
    // The retry runs (made due) and succeeds.
    await runDecorations(h, deps);
    expect(statusesOf(gitlabId)).toHaveLength(1);
    expect(await queuedDecorations(h)).toHaveLength(0);

    // 401: no retry at all.
    const refused = await setup('scm/refused');
    fake.inject('GET', new RegExp(`^/projects/${refused.gitlabId}$`), { status: 401 });
    await refused.project.ingestOk(
      mergeRequestReport(12, HEAD, { projectKey: refused.project.key }),
    );
    await runDecorations(h, deps);
    expect(await queuedDecorations(h)).toHaveLength(0);
    expect(statusesOf(refused.gitlabId)).toHaveLength(0);
  });

  it('says a 403 on the commit status is a missing permission, not a refused token', async () => {
    const { project, gitlabId } = await setup('scm/protected');
    // GitLab's answer to a Developer's status on a protected branch.
    fake.inject('POST', new RegExp(`^/projects/${gitlabId}/statuses/`), {
      status: 403,
      body: { message: '403 Forbidden' },
    });
    const analysisId = await project.ingestOk(
      reportWith({ projectKey: project.key, revision: 'e'.repeat(40) }),
    );
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(gitlabId)).toHaveLength(0);
    // Not retried: a role does not change by itself.
    expect(await queuedDecorations(h)).toHaveLength(0);
    const line = h.ctx.logs.find(
      (l) => l.includes(analysisId) && l.includes('GitLab decoration stopped'),
    );
    expect(line).toContain('"status":403');
    expect(line).toContain('a commit status on a protected branch needs the Maintainer role');
    expect(line).not.toContain('refused the token');
  });

  it('goes on to the summary when the commit status fails, and sets the status on the retry', async () => {
    const { project, gitlabId } = await setup('scm/status-down');
    fake.inject('POST', new RegExp(`^/projects/${gitlabId}/statuses/`), { status: 502 });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(gitlabId)).toHaveLength(0);
    expect(summaries(gitlabId)).toHaveLength(1);
    const [retry] = await queuedDecorations(h);
    expect(retry?.payload).toMatchObject({ attempt: 1 });
    fake.clearRequests();
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(gitlabId)).toHaveLength(1);
    expect(writes()).toEqual([`POST/projects/${gitlabId}/statuses/${HEAD}`]);
    expect(summaries(gitlabId)).toHaveLength(1);
    expect(await queuedDecorations(h)).toHaveLength(0);
  });

  it('stops without retry when a job runs out of its request budget (§4.3)', async () => {
    const { project, gitlabId } = await setup('scm/budget');
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    const deps = decorationDeps(h);
    await runDecorations(h, {
      ...deps,
      scm: { ...deps.scm, clientOptions: { timeoutMs: 2_000, maxRequests: 4 } },
    });
    // project, statuses (read), status (post), merge request; then the budget is spent.
    expect(statusesOf(gitlabId)).toHaveLength(1);
    expect(summaries(gitlabId)).toHaveLength(0);
    expect(await queuedDecorations(h)).toHaveLength(0);
    expect(
      h.ctx.logs.some(
        (line) =>
          line.includes('GitLab decoration stopped') &&
          line.includes('More than 4 GitLab requests in one job'),
      ),
    ).toBe(true);
  });

  it(`gives up after ${MAX_DECORATION_ATTEMPTS} attempts and opens the circuit after ${SCM_CIRCUIT_FAILURES} failures`, async () => {
    const { project, gitlabId } = await setup('scm/down');
    let now = Date.now();
    const deps = decorationDeps(h, { runtime: createScmRuntime(() => now) });
    const down = { status: 503 };
    fake.inject(
      'GET',
      new RegExp(`^/projects/${gitlabId}$`),
      ...Array(SCM_CIRCUIT_FAILURES).fill(down),
    );
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    for (let attempt = 1; attempt <= SCM_CIRCUIT_FAILURES; attempt++) {
      await runDecorations(h, deps);
      expect((await queuedDecorations(h))[0]?.payload).toMatchObject({ attempt });
    }
    // The circuit is open: the sixth attempt makes no request and is the last.
    fake.clearRequests();
    await runDecorations(h, deps);
    expect(fake.requests).toHaveLength(0);
    expect(await queuedDecorations(h)).toHaveLength(0);
    // Ten minutes later one decoration goes through again and closes the circuit.
    now += 10 * 60_000 + 1;
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        analysisDate: '2026-09-23T10:15:00Z',
      }),
    );
    await runDecorations(h, deps);
    expect(statusesOf(gitlabId)).toHaveLength(1);
    expect(deps.runtime.circuit.openUntil(project.connectionId)).toBeNull();
  });

  it('lets a new decoration of the branch replace its queued retries', async () => {
    const { project, gitlabId } = await setup('scm/supersede');
    fake.inject('POST', new RegExp(`^/projects/${gitlabId}/statuses/`), { status: 502 });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await runDecorations(h, decorationDeps(h));
    const [retry] = await queuedDecorations(h);
    expect(retry?.payload).toMatchObject({ attempt: 1 });
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        analysisDate: '2026-09-23T10:15:00Z',
      }),
    );
    const queued = await queuedDecorations(h);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ attempt: 0 });
    expect(queued[0]?.id).not.toBe(retry?.id);
  });

  it('stops at once when GitLab rate-limits the commit status, without the merge request part', async () => {
    const { project, gitlabId } = await setup('scm/status-429');
    fake.inject('POST', new RegExp(`^/projects/${gitlabId}/statuses/`), {
      status: 429,
      headers: { 'retry-after': '30' },
    });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await runDecorations(h, decorationDeps(h));
    expect(
      fake.requests.filter((r) => r.path.startsWith(`/projects/${gitlabId}/merge_requests`)),
    ).toHaveLength(0);
    expect(summaries(gitlabId)).toHaveLength(0);
    const [retry] = await queuedDecorations(h);
    expect(retry?.payload).toMatchObject({ attempt: 1 });
    await h.ctx.db.delete(jobs).where(eq(jobs.id, retry!.id));
  });

  it('never queues a retry beside a newer decoration being enqueued (one branch lock)', async () => {
    const { project } = await setup('scm/race');
    const analysisId = await project.ingestOk(
      mergeRequestReport(12, HEAD, { projectKey: project.key }),
    );
    const [first] = await queuedDecorations(h);
    // The ingestion's decoration runs (it is no longer queued) and fails ...
    await h.ctx.db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, first!.id));
    const [branch] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    let retried: Promise<boolean> | undefined;
    // ... while a newer decoration of the branch is being enqueued in another transaction.
    await h.ctx.db.transaction(async (tx) => {
      await enqueueDecoration(tx, { analysisId, branchId: branch!.id, gitlab: null });
      retried = requeueDecoration(
        h.ctx.db,
        branch!.id,
        { analysisId, attempt: 1, gitlab: null },
        inSeconds(60),
      );
      await waitForLockWaiters(h.ctx.db, 1);
    });
    expect(await retried!).toBe(false);
    const queued = await queuedDecorations(h);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ attempt: 0 });
    await h.ctx.db.delete(jobs).where(eq(jobs.id, first!.id));
    await h.ctx.db.delete(jobs).where(eq(jobs.id, queued[0]!.id));
  });

  it('logs a failed decoration whose retry a newer decoration of the branch replaces', async () => {
    const { project, gitlabId } = await setup('scm/superseded');
    const older = await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    // A newer analysis of the branch queues its decoration (and deletes the older one's) ...
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        analysisDate: '2026-09-23T10:15:00Z',
      }),
    );
    // ... while the older one was already running, and now fails.
    fake.inject('GET', new RegExp(`^/projects/${gitlabId}$`), { status: 502 });
    await scmHandlers(decorationDeps(h))[SCM_QUEUE]!({
      id: randomUUID(),
      payload: { analysisId: older, attempt: 0, gitlab: null },
    } as unknown as Job);
    const lines = h.ctx.logs.filter((line) => line.includes(older));
    expect(lines.some((line) => line.includes('GitLab decoration superseded'))).toBe(true);
    expect(lines.some((line) => line.includes('GitLab decoration retried'))).toBe(false);
    const queued = await queuedDecorations(h);
    expect(queued).toHaveLength(1);
    await h.ctx.db.delete(jobs).where(eq(jobs.id, queued[0]!.id));
  });

  it(`re-decorates a branch after a re-evaluation at most once per ${REDECORATION_INTERVAL_SECONDS} s (ruling G7)`, async () => {
    const { project } = await setup('scm/redecorate-rate');
    const analysisId = await project.ingestOk(
      mergeRequestReport(12, HEAD, { projectKey: project.key }),
    );
    const deps = decorationDeps(h);
    await runDecorations(h, deps);
    const [branch] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    const redecorate = () =>
      enqueueDecoration(h.ctx.db, {
        analysisId,
        branchId: branch!.id,
        gitlab: null,
        reevaluation: true,
      });
    // Times are compared on the database clock (a container's clock may drift from Node's).
    const queuedWait = async () => {
      const [queued] = await queuedDecorations(h);
      return (queued!.runAt.getTime() - queued!.createdAt.getTime()) / 1_000;
    };
    const lastRedecoration = async () => {
      const [last] = await h.ctx.db
        .select({ createdAt: jobs.createdAt })
        .from(jobs)
        .where(
          sql`${jobs.queue} = ${SCM_QUEUE} AND ${jobs.status} <> 'queued' AND ${jobs.concurrencyKey} = ${`scm:branch:${branch!.id}`} AND ${jobs.payload} ->> 'reevaluation' = 'true'`,
        )
        .orderBy(sql`${jobs.createdAt} DESC`)
        .limit(1);
      return last!.createdAt.getTime();
    };
    // The first re-decoration is not held back by the ingestion's decoration.
    await redecorate();
    expect(await queuedWait()).toBeLessThan(1);
    await runDecorations(h, deps);
    // The next one waits for the interval after the previous one, and toggling again while it
    // waits does not push it later: at most one re-decoration per interval, never starved.
    await redecorate();
    const [held] = await queuedDecorations(h);
    expect((held!.runAt.getTime() - (await lastRedecoration())) / 1_000).toBeCloseTo(
      REDECORATION_INTERVAL_SECONDS,
      2,
    );
    // Held back at all: it runs after it was enqueued (the interval is not over yet).
    expect(await queuedWait()).toBeGreaterThan(0);
    await redecorate();
    const again = await queuedDecorations(h);
    expect(again).toHaveLength(1);
    expect(again[0]!.runAt.getTime()).toBe(held!.runAt.getTime());
    // A new analysis's decoration is never held back.
    await enqueueDecoration(h.ctx.db, { analysisId, branchId: branch!.id, gitlab: null });
    expect(await queuedWait()).toBeLessThan(1);
    await runDecorations(h, deps);
  });

  it('records no merge request link when the connection moved while the job ran (scm.md §8)', async () => {
    const { project, gitlabId } = await setup('scm/moved-meanwhile', { ownConnection: true });
    // The address changes (as a PATCH with a new token would) after the job loaded the
    // connection and before it records the merge request GitLab answered with.
    fake.inject('GET', new RegExp(`^/projects/${gitlabId}/merge_requests/12$`), {
      status: 200,
      passThrough: true,
      before: async () => {
        await h.ctx.db
          .update(scmConnections)
          .set({ baseUrl: 'https://gitlab.moved.example' })
          .where(eq(scmConnections.id, project.connectionId));
      },
    });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await runDecorations(h, decorationDeps(h));
    const [mr] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    expect(mr?.mrUrl).toBeNull();
  });

  it('never writes the token into a log line, a job row or a comment', async () => {
    const { project, gitlabId } = await setup('scm/secret');
    fake.inject('GET', new RegExp(`^/projects/${gitlabId}$`), { status: 500 });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await runDecorations(h, decorationDeps(h));
    await runDecorations(h, decorationDeps(h));
    const allJobs = await h.ctx.db.select().from(jobs);
    expect(JSON.stringify(allJobs)).not.toContain(fake.token);
    expect(h.ctx.logs.join('\n')).not.toContain(fake.token);
    expect(h.ctx.logs.join('\n')).toContain('GitLab decoration retried');
    const bodies = fake.discussions(gitlabId, 12).flatMap((d) => d.notes.map((n) => n.body));
    expect(bodies.join('\n')).not.toContain(fake.token);
  });

  // Review Focus of plan 2A: what the spec implies and a user will meet.

  it('sends nothing with a token that no longer decrypts (QUALOR_SECRET_KEY rotated), and says so', async () => {
    const { project, gitlabId } = await setup('scm/rotated', { ownConnection: true });
    await h.ctx.db
      .update(scmConnections)
      .set({
        tokenEnc: encryptSecret(
          encryptionKey('another-secret-key-of-at-least-32-chars'),
          fake.token,
          SCM_TOKEN_AAD,
        ),
      })
      .where(eq(scmConnections.id, project.connectionId));
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    fake.clearRequests();
    await runDecorations(h, decorationDeps(h));
    expect(fake.requests).toHaveLength(0);
    expect(statusesOf(gitlabId)).toHaveLength(0);
    expect(await queuedDecorations(h)).toHaveLength(0);
    expect(
      h.ctx.logs.some(
        (line) =>
          line.includes('GitLab decoration stopped') && line.includes('cannot be decrypted'),
      ),
    ).toBe(true);
  });

  it('sends nothing to a host the operator no longer lists in QUALOR_SCM_INTERNAL_HOSTS', async () => {
    const { project } = await setup('scm/unlisted');
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    fake.clearRequests();
    const deps = decorationDeps(h);
    await runDecorations(h, { ...deps, scm: { ...deps.scm, internalHosts: new Set() } });
    expect(fake.requests).toHaveLength(0);
    expect(await queuedDecorations(h)).toHaveLength(0);
  });

  it('keeps one summary per Qualor project when two projects decorate one merge request', async () => {
    const { project, gitlabId } = await setup('scm/mono-a');
    const other = await mappedProject(h, fake, 'scm/mono-b', gitlabId);
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    await other.ingestOk(mergeRequestReport(12, HEAD, { projectKey: other.key, findings: [] }));
    await runDecorations(h, decorationDeps(h));
    await project.ingestOk(
      mergeRequestReport(12, HEAD, {
        projectKey: project.key,
        analysisDate: '2026-09-23T10:15:00Z',
      }),
    );
    await runDecorations(h, decorationDeps(h));
    const owners = summaries(gitlabId).map((n) => {
      const marker = markerOf(n.body);
      return marker?.kind === 'summary' ? marker.projectId : null;
    });
    expect(owners.sort()).toEqual([project.id, other.id].sort());
    // Ruling G4: each project has its own commit status on the shared commit.
    expect(
      statusesOf(gitlabId)
        .filter((s) => s.sha === HEAD)
        .map((s) => [s.name, s.state])
        .sort(),
    ).toEqual(
      [
        [statusName(project.key), 'failed'],
        [statusName(other.key), 'success'],
      ].sort(),
    );
    expect(summaries(gitlabId).find((n) => n.body.includes(other.id))?.body).toContain(
      'quality gate passed',
    );
  });

  it('sets only the commit status for a merge request GitLab does not have, or a non-GitLab id', async () => {
    const { project, gitlabId } = await setup('scm/no-mr');
    await project.ingestOk(mergeRequestReport(99, HEAD, { projectKey: project.key }));
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(gitlabId)).toHaveLength(1);
    expect(await queuedDecorations(h)).toHaveLength(0);
    const pr = await setup('scm/pr-id');
    const report = mergeRequestReport(12, 'e'.repeat(40), { projectKey: pr.project.key });
    await pr.project.ingestOk({
      ...report,
      scm: {
        ...report.scm,
        mergeRequest: { id: 'pr-12', targetBranch: 'main', sourceBranch: 'feature/x' },
      },
    });
    fake.clearRequests();
    await runDecorations(h, decorationDeps(h));
    expect(statusesOf(pr.gitlabId)).toHaveLength(1);
    expect(fake.requests.some((r) => r.path.includes('merge_requests'))).toBe(false);
  });

  it('does nothing when the connection was deleted while the decoration waited', async () => {
    const { project } = await setup('scm/deleted', { ownConnection: true });
    await project.ingestOk(mergeRequestReport(12, HEAD, { projectKey: project.key }));
    const removed = await h.ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/scm-connections/${project.connectionId}`,
      headers: h.orgAdmin.headers,
    });
    expect(removed.statusCode).toBe(204);
    fake.clearRequests();
    expect(await runDecorations(h, decorationDeps(h))).toBe(1);
    expect(fake.requests).toHaveLength(0);
    expect(await queuedDecorations(h)).toHaveLength(0);
  });

  it('does nothing for an analysis of a local scan, however its decoration was queued', async () => {
    const { project } = await setup('scm/local-scan');
    const report = mergeRequestReport(12, HEAD, { projectKey: project.key });
    const analysisId = await project.ingestOk({
      ...report,
      scm: { ...report.scm, provider: 'none' },
    });
    // §4.1: the stage enqueues nothing for it ...
    expect(await queuedDecorations(h)).toHaveLength(0);
    // ... and a decoration queued anyway (a re-evaluation, say) reads the stored context.
    const [mr] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    await enqueueDecoration(h.ctx.db, { analysisId, branchId: mr!.id, gitlab: null });
    fake.clearRequests();
    expect(await runDecorations(h, decorationDeps(h))).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('GitLab decoration: AI review threads (6I-3, R16, R18)', () => {
  let h: IngestHarness;
  let fake: FakeGitLab;
  let nextGitLabProject = 400;
  const HUMAN = 5;
  const NEWER = '2'.repeat(40);
  const MERGE_COMMIT = '9'.repeat(40);
  const PATH = 'src/cart.ts';
  /** The file the merge request adds, as the snapshot the review read holds it. */
  const LINES = Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
  const added = (lines: readonly string[]) =>
    `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
  type Suggestion = { startLine: number; endLine: number; lines: string[] };

  /**
   * A mapped project with merge request !12 at HEAD, which adds PATH (`live`: its lines in GitLab's
   * diff), the analysis of its pipeline, a review of HEAD that is done, and the snapshot that
   * review read (PATH as LINES).
   */
  const setup = async (
    key: string,
    o: {
      live?: readonly string[];
      eventType?: 'detached' | 'merged_result';
      revision?: string;
      findings?: Report['findings'];
    } = {},
  ) => {
    const gitlabId = nextGitLabProject++;
    fake.addProject({ id: gitlabId, path: `acme/${key.replace(/\W/g, '-')}` });
    fake.addMergeRequest(gitlabId, {
      iid: 12,
      title: 'Add the cart',
      state: 'opened',
      sourceBranch: 'feature/cart',
      targetBranch: 'main',
      headSha: HEAD,
      baseSha: BASE,
      startSha: BASE,
      diffs: [{ oldPath: PATH, newPath: PATH, diff: added(o.live ?? LINES), newFile: true }],
    });
    const project = await mappedProject(h, fake, key, gitlabId);
    const analysisId = await project.ingestOk(
      mergeRequestReport(12, o.revision ?? HEAD, {
        projectKey: project.key,
        gitlab: { projectId: String(gitlabId), mergeRequestEventType: o.eventType ?? 'detached' },
        files: [file(PATH, { lines: LINES.length, newLines: [[1, LINES.length]] })],
        findings: o.findings ?? [],
      }),
    );
    const [branch] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    const branchId = branch!.id;
    await h.ctx.db.insert(reviewRuns).values({
      projectId: project.id,
      branchId,
      analysisId,
      status: 'done',
      deadlineAt: new Date(),
      headSha: HEAD,
      summary: { verdict: 'The cart has problems.', walkthrough: [], notes: [] },
    });
    await storeTestSnapshot(
      h.ctx.db,
      analysisId,
      [
        {
          type: 'change',
          path: PATH,
          oldPath: null,
          status: 'added',
          patch: added(LINES),
          since: null,
        },
        { type: 'file', path: PATH, text: `${LINES.join('\n')}\n` },
      ],
      { headSha: HEAD, mergeRequest: { id: '12', title: 'Add the cart', description: null } },
    );
    return { project, gitlabId, analysisId, branchId };
  };
  /** An open AI finding on PATH with its row, as the review of HEAD (by default) left it. */
  const aiFinding = async (
    branchId: string,
    o: {
      line: number;
      severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
      category?: AiCategory;
      anchorLine?: number | null;
      suggestion?: Suggestion | null;
      reviewedHeadSha?: string;
      title?: string;
    },
  ) => {
    const category = o.category ?? 'logic';
    const id = await seedAiIssue(h.ctx.db, {
      branchId,
      category,
      path: PATH,
      line: o.line,
      severity: o.severity ?? 'medium',
    });
    await h.ctx.db
      .update(issues)
      .set({ message: o.title ?? `Line ${o.line} is wrong` })
      .where(eq(issues.id, id));
    await h.ctx.db.insert(reviewFindings).values({
      issueId: id,
      category,
      body: `Why line ${o.line} is wrong, and how to fix it.`,
      suggestion: o.suggestion ?? null,
      anchorLine: o.anchorLine === undefined ? o.line : o.anchorLine,
      reviewedHeadSha: o.reviewedHeadSha ?? HEAD,
    });
    return id;
  };
  /** Qualor's inline threads on !12, by the issue their marker names. */
  const threadsOf = (gitlabId: number) =>
    new Map(
      fake.discussions(gitlabId, 12).flatMap((d) => {
        const marker = d.notes[0] === undefined ? null : markerOf(d.notes[0].body);
        return marker?.kind === 'issue' ? [[marker.issueId, d] as const] : [];
      }),
    );
  const summaryOf = (gitlabId: number) =>
    fake
      .discussions(gitlabId, 12)
      .flatMap((d) => d.notes)
      .find((n) => markerOf(n.body)?.kind === 'summary')?.body ?? '';
  const lineOf = (d: { notes: { position: Record<string, unknown> | null }[] }) =>
    d.notes[0]?.position?.['new_line'];
  const threadPosts = () =>
    fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/discussions'));
  const threadWrites = () =>
    fake.requests.filter((r) => r.method !== 'GET' && r.path.includes('/discussions'));
  const decorateAgain = async (
    analysisId: string,
    branchId: string,
    gitlab: Parameters<typeof enqueueDecoration>[1]['gitlab'] = null,
  ) => {
    await enqueueDecoration(h.ctx.db, { analysisId, branchId, gitlab });
    await runDecorations(h, decorationDeps(h));
  };
  const snapshotsOf = (branchId: string) =>
    h.ctx.db
      .select({ id: reviewSnapshots.id })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.branchId, branchId));

  beforeAll(async () => {
    fake = await createFakeGitLab();
    h = await createIngestHarness({ config: scmTestConfig(fake) });
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });
  beforeEach(() => fake.clearRequests());

  it('posts an AI finding on its anchor, with its suggestion, apart from the analyzers’ count', async () => {
    const { gitlabId, analysisId, branchId, project } = await setup('ai/posted', {
      findings: [finding({ path: PATH, line: 3 })],
    });
    const suggestion = {
      startLine: 5,
      endLine: 6,
      lines: ['export const line5 = 50;', 'export const line6 = 60;'],
    };
    const id = await aiFinding(branchId, {
      line: 6,
      anchorLine: 5,
      severity: 'high',
      suggestion,
      title: 'The constants are off by ten',
    });
    // A finding an earlier review placed on an older head, and the newest only found still there:
    // its anchor is a line number of that head, so it is never posted with it.
    const older = await aiFinding(branchId, { line: 20, reviewedHeadSha: '3'.repeat(40) });
    // A finding of a review with no place on a changed line (the summary lists it).
    const nowhere = await aiFinding(branchId, { line: 22, anchorLine: null });
    await runDecorations(h, decorationDeps(h));
    expect(threadsOf(gitlabId).has(older) || threadsOf(gitlabId).has(nowhere)).toBe(false);
    const thread = threadsOf(gitlabId).get(id);
    expect(thread?.notes[0]?.position).toMatchObject({
      position_type: 'text',
      base_sha: BASE,
      start_sha: BASE,
      head_sha: HEAD,
      old_path: PATH,
      new_path: PATH,
      new_line: 5,
    });
    expect(thread?.notes[0]?.body).toBe(
      [
        `<!-- qualor:issue ${id} -->`,
        '**AI review** · High · Logic · likely · ` ai:logic `',
        '',
        '**The constants are off by ten**',
        '',
        'Why line 6 is wrong, and how to fix it.',
        '',
        '```suggestion:-0+1',
        'export const line5 = 50;',
        'export const line6 = 60;',
        '```',
        '',
        `[View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${id})`,
      ].join('\n'),
    );
    // The summary counts the analyzers' thread as theirs, and the AI section speaks for its own:
    // the finding with no place is listed, the one of the older head only counted.
    const body = summaryOf(gitlabId);
    expect(body).toContain('1 new issue is commented inline.');
    expect(body).toContain('**Findings:** 1 high · 2 medium · 0 low');
    expect(body).toContain(
      `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:22 \` · Line 22 is wrong · [View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${nowhere})\n\n`,
    );
    expect(threadsOf(gitlabId).size).toBe(2);
    // Decorating again changes nothing: the AI thread that is there now is still not counted as
    // the analyzers', so the summary is not edited either.
    fake.clearRequests();
    await decorateAgain(analysisId, branchId);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(summaryOf(gitlabId)).toBe(body);
  });

  it('lists an AI finding it cannot place when GitLab gives the merge request no diff refs', async () => {
    const { gitlabId, branchId, project } = await setup('ai/no-diff-refs');
    const id = await aiFinding(branchId, { line: 5, title: 'Line five is wrong' });
    // The head is the one the review read, but GitLab has no base and start for a position yet.
    fake.inject('GET', new RegExp(`^/projects/${gitlabId}/merge_requests/12$`), {
      status: 200,
      body: {
        id: 3012,
        iid: 12,
        project_id: gitlabId,
        title: 'Add the cart',
        state: 'opened',
        web_url: `${fake.url}/acme/ai-no-diff-refs/-/merge_requests/12`,
        source_branch: 'feature/cart',
        target_branch: 'main',
        sha: HEAD,
        diff_refs: { base_sha: null, head_sha: HEAD, start_sha: null },
        draft: false,
      },
    });
    await runDecorations(h, decorationDeps(h));
    expect(threadsOf(gitlabId).size).toBe(0);
    expect(summaryOf(gitlabId)).toContain(
      `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:5 \` · Line five is wrong · [View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${id})\n\n`,
    );
  });

  it('a merged-result pipeline posts AI threads while analyzer threads are skipped', async () => {
    const { gitlabId, analysisId, branchId } = await setup('ai/merged-result', {
      eventType: 'merged_result',
      revision: MERGE_COMMIT,
      // An analyzer finding on an added line, which a pipeline of the head would comment.
      findings: [finding({ path: PATH, line: 3 })],
    });
    const id = await aiFinding(branchId, {
      line: 5,
      severity: 'high',
      suggestion: { startLine: 5, endLine: 6, lines: ['export const line5 = 50;', 'x;'] },
    });
    await runDecorations(h, decorationDeps(h));
    // The AI review read the merge request's head, whose line numbers are GitLab's: its thread is
    // posted, and only its.
    const threads = threadsOf(gitlabId);
    expect([...threads.keys()]).toEqual([id]);
    expect(threads.get(id)?.notes[0]?.position).toMatchObject({ head_sha: HEAD, new_line: 5 });
    expect(threads.get(id)?.notes[0]?.body).toContain(
      '```suggestion:-0+1\nexport const line5 = 50;\nx;\n```',
    );
    const body = summaryOf(gitlabId);
    expect(body).toContain('No inline comments: this was a merged-results pipeline');
    expect(body).toContain(
      '#### AI review\n\nThe cart has problems.\n\n**Findings:** 1 high · 0 medium · 0 low',
    );
    expect(body).not.toContain('now at');
    // A later review closes it: its thread is resolved in a merged-results pipeline too.
    await h.ctx.db
      .update(issues)
      .set({ status: 'closed', closedAt: sql`now()` })
      .where(eq(issues.id, id));
    await decorateAgain(analysisId, branchId, {
      projectId: String(gitlabId),
      mergeRequestEventType: 'merged_result',
    });
    expect(threadsOf(gitlabId).get(id)?.notes[0]).toMatchObject({
      resolved: true,
      resolvedBy: fake.botUserId,
    });
  });

  it('a moved-on merge request gets no AI thread and the summary lists the findings', async () => {
    const { gitlabId, analysisId, branchId, project } = await setup('ai/moved-on');
    const placed = await aiFinding(branchId, { line: 5, severity: 'high' });
    const refused = await aiFinding(branchId, { line: 9, title: 'The ninth line is wrong' });
    // GitLab refuses the second thread's position: it is listed in the summary instead.
    fake.inject(
      'POST',
      new RegExp(`^/projects/${gitlabId}/merge_requests/12/discussions$`),
      { status: 201, passThrough: true },
      {
        status: 400,
        body: { message: '400 Bad request - Note {:line_code=>["can\'t be blank"]}' },
      },
    );
    await runDecorations(h, decorationDeps(h));
    expect([...threadsOf(gitlabId).keys()]).toEqual([placed]);
    // The list holds the one without a thread, and only it (the prompt for an agent lists both).
    const item = `- **Medium** · \` ${PATH}:9 \` · The ninth line is wrong · [View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${refused})`;
    const listed = `**Not on changed lines:**\n\n${item}\n\n`;
    expect(summaryOf(gitlabId)).toContain(listed);
    expect(summaryOf(gitlabId)).not.toMatch(/^- \*\*High\*\* · /m);

    // A push after the review: GitLab's merge request is at a newer head, whose pipeline is not
    // analysed yet. No thread is posted with the numbers of the head the review read.
    fake.updateMergeRequest(gitlabId, 12, {
      headSha: NEWER,
      diffs: [{ oldPath: PATH, newPath: PATH, diff: added(['// a new line', ...LINES]) }],
    });
    fake.clearRequests();
    await decorateAgain(analysisId, branchId);
    expect(threadPosts()).toEqual([]);
    expect([...threadsOf(gitlabId).keys()]).toEqual([placed]);
    const body = summaryOf(gitlabId);
    // The one without a thread is listed, the one with its thread is not.
    expect(body).toContain(listed);
    expect(body).not.toMatch(/^- \*\*High\*\* · /m);
    expect(body).toContain(
      'Reviewed commit: ` 111111111111 `; the merge request is now at ` 222222222222 `; the next pipeline reviews the new commits.',
    );
  });

  it('a person-resolved AI thread is never reopened', async () => {
    const { gitlabId, analysisId, branchId } = await setup('ai/human-resolved');
    const kept = await aiFinding(branchId, { line: 5 });
    const fixed = await aiFinding(branchId, { line: 9 });
    const discussed = await aiFinding(branchId, { line: 12 });
    await runDecorations(h, decorationDeps(h));
    const threads = threadsOf(gitlabId);
    expect(threads.size).toBe(3);
    // A person resolves the first thread while its finding is open, and replies in the third.
    fake.resolveAs(gitlabId, 12, threads.get(kept)!.id, HUMAN, true);
    fake.reply(gitlabId, 12, threads.get(discussed)!.id, { body: 'Is it?', authorId: HUMAN });
    // A later review closes the second and third findings.
    await h.ctx.db
      .update(issues)
      .set({ status: 'closed', closedAt: sql`now()` })
      .where(inArray(issues.id, [fixed, discussed]));
    fake.clearRequests();
    await decorateAgain(analysisId, branchId);
    // Qualor resolves the thread of the closed finding no person spoke in, and nothing else: the
    // person's resolution stands (no thread reopened, none posted again).
    expect(threadWrites().map((r) => `${r.method} ${r.path}`)).toEqual([
      `PUT /projects/${gitlabId}/merge_requests/12/discussions/${threads.get(fixed)!.id}`,
    ]);
    const after = threadsOf(gitlabId);
    expect(after.size).toBe(3);
    expect(after.get(kept)?.notes[0]).toMatchObject({ resolved: true, resolvedBy: HUMAN });
    expect(after.get(fixed)?.notes[0]).toMatchObject({
      resolved: true,
      resolvedBy: fake.botUserId,
    });
    expect(after.get(discussed)?.notes[0]).toMatchObject({ resolved: false });
    // Its finding closed as well, the thread a person resolved is still left as it is.
    await h.ctx.db
      .update(issues)
      .set({ status: 'closed', closedAt: sql`now()` })
      .where(eq(issues.id, kept));
    fake.clearRequests();
    await decorateAgain(analysisId, branchId);
    expect(threadWrites()).toEqual([]);
    expect(threadsOf(gitlabId).get(kept)?.notes[0]).toMatchObject({
      resolved: true,
      resolvedBy: HUMAN,
    });
  });

  it('a low finding without a suggestion gets no thread', async () => {
    const { gitlabId, branchId } = await setup('ai/low');
    const bare = await aiFinding(branchId, { line: 5, severity: 'low' });
    const lowered = await aiFinding(branchId, { line: 7, severity: 'info' });
    const suggested = await aiFinding(branchId, {
      line: 9,
      severity: 'low',
      suggestion: { startLine: 9, endLine: 9, lines: ['export const line9 = 90;'] },
    });
    const medium = await aiFinding(branchId, { line: 12, severity: 'medium' });
    const raised = await aiFinding(branchId, { line: 14, severity: 'blocker' });
    await runDecorations(h, decorationDeps(h));
    const threads = threadsOf(gitlabId);
    expect(new Set(threads.keys())).toEqual(new Set([suggested, medium, raised]));
    expect(threads.has(bare) || threads.has(lowered)).toBe(false);
    expect(threads.get(suggested)?.notes[0]?.body).toContain(
      '**AI review** · Low · Logic · likely · ` ai:logic `',
    );
    expect(threads.get(suggested)?.notes[0]?.body).toContain(
      '```suggestion:-0+0\nexport const line9 = 90;\n```',
    );
    expect(lineOf(threads.get(medium)!)).toBe(12);
    // It is counted, and not listed among the findings that could not be posted.
    const body = summaryOf(gitlabId);
    expect(body).toContain('**Findings:** 1 high · 1 medium · 3 low');
    expect(body).not.toContain('Not on changed lines');
  });

  it('the 21st AI finding gets no thread', async () => {
    const { gitlabId, branchId } = await setup('ai/cap', {
      // Two analyzer findings: the analyzers' threads have a cap of their own.
      findings: [finding({ path: PATH, line: 25 }), finding({ path: PATH, line: 26 })],
    });
    const ids: string[] = [];
    for (let line = 1; line <= 21; line += 1) ids.push(await aiFinding(branchId, { line }));
    await runDecorations(h, decorationDeps(h));
    const threads = threadsOf(gitlabId);
    // The twenty most severe, then by place: lines 1 to 20.
    expect(ids.filter((id) => threads.has(id))).toEqual(ids.slice(0, 20));
    expect([...threads.values()].map(lineOf).sort((a, b) => Number(a) - Number(b))).toEqual([
      ...Array.from({ length: 20 }, (_, i) => i + 1),
      25,
      26,
    ]);
    const body = summaryOf(gitlabId);
    expect(body).toContain('2 new issues are commented inline.');
    expect(body).toContain('**Findings:** 0 high · 21 medium · 0 low');
    expect(body).toContain(`**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:21 \` · `);
    expect(body.match(/^- \*\*Medium\*\* · /gm)).toHaveLength(1);
  });

  it('a suggestion whose lines changed in the live diff is left out', async () => {
    // GitLab's diff of the head has line 5 otherwise than the snapshot the review read.
    const live = LINES.map((line, i) => (i === 4 ? 'export const line5 = 500;' : line));
    const { gitlabId, branchId } = await setup('ai/live-diff', { live });
    const changed = await aiFinding(branchId, {
      line: 5,
      suggestion: { startLine: 5, endLine: 5, lines: ['export const line5 = 5000;'] },
    });
    const same = await aiFinding(branchId, {
      line: 9,
      suggestion: {
        startLine: 9,
        endLine: 10,
        lines: ['export const line9 = 9000;', 'export const line10 = 10;'],
      },
    });
    // One that does not start on the line its thread sits on would replace other lines.
    const elsewhere = await aiFinding(branchId, {
      line: 14,
      suggestion: { startLine: 15, endLine: 15, lines: ['export const line15 = 1500;'] },
    });
    // A low finding is posted for its suggestion only: when that no longer applies, nothing is.
    const low = await aiFinding(branchId, {
      line: 4,
      severity: 'low',
      suggestion: {
        startLine: 4,
        endLine: 5,
        lines: ['export const line4 = 40;', 'export const line5 = 50;'],
      },
    });
    await runDecorations(h, decorationDeps(h));
    const threads = threadsOf(gitlabId);
    expect(new Set(threads.keys())).toEqual(new Set([changed, same, elsewhere]));
    expect(threads.has(low)).toBe(false);
    const bodyOf = (id: string) => threads.get(id)?.notes[0]?.body ?? '';
    expect(bodyOf(changed)).not.toContain('```suggestion');
    expect(bodyOf(changed)).toContain('Why line 5 is wrong, and how to fix it.');
    expect(bodyOf(same)).toContain(
      '```suggestion:-0+1\nexport const line9 = 9000;\nexport const line10 = 10;\n```',
    );
    expect(bodyOf(elsewhere)).not.toContain('```suggestion');
    expect(lineOf(threads.get(elsewhere)!)).toBe(14);
    expect(summaryOf(gitlabId)).not.toContain('Not on changed lines');

    // Without the snapshot the review read (deleted since), no suggestion can be checked: none is
    // posted, and the finding still is.
    const gone = await setup('ai/no-snapshot');
    await h.ctx.db.delete(reviewSnapshots).where(eq(reviewSnapshots.branchId, gone.branchId));
    const unchecked = await aiFinding(gone.branchId, {
      line: 9,
      suggestion: { startLine: 9, endLine: 9, lines: ['export const line9 = 9000;'] },
    });
    await runDecorations(h, decorationDeps(h));
    const posted = threadsOf(gone.gitlabId).get(unchecked)?.notes[0]?.body ?? '';
    expect(posted).toContain('Why line 9 is wrong, and how to fix it.');
    expect(posted).not.toContain('```suggestion');
  });

  it('a merged or closed merge request deletes the snapshots of its branch, an open one keeps them', async () => {
    for (const state of ['merged', 'closed'] as const) {
      const { gitlabId, analysisId, branchId } = await setup(`ai/${state}`);
      await runDecorations(h, decorationDeps(h));
      expect(await snapshotsOf(branchId)).toHaveLength(1);
      fake.updateMergeRequest(gitlabId, 12, { state });
      await decorateAgain(analysisId, branchId);
      expect([state, await snapshotsOf(branchId)]).toEqual([state, []]);
    }
  });
});
