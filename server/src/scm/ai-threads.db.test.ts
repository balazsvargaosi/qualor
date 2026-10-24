import type { Report } from '@qualor/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import { file, finding } from '../../test/reports';
import { seedAiIssue, storeTestSnapshot } from '../../test/review';
import {
  decorationDeps,
  mappedProject,
  mergeRequestReport,
  PUBLIC_URL,
  runDecorations,
  scmTestConfig,
} from '../../test/scm';
import {
  branches,
  issues,
  reviewFindings,
  reviewRuns,
  reviewSnapshots,
  type AiCategory,
} from '../db/schema';
import { markerOf } from './markdown';
import { enqueueDecoration } from './queue';

/*
 * The AI review's threads on a GitLab merge request (6I-3): which findings get one and where, the
 * one-click suggestion re-checked against the live diff, the cap beside the analyzers', the
 * findings the summary lists instead, and the snapshots a merged or closed merge request loses.
 * The review itself is seeded: a run that is done, its findings, and the snapshot it read.
 */

const HEAD = '1'.repeat(40);
const BASE = 'b'.repeat(40);

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
  /** A suggestion that applies to line 9 of LINES. */
  const LINE9: Suggestion = { startLine: 9, endLine: 9, lines: ['export const line9 = 90;'] };

  /**
   * A mapped project with merge request !12 at HEAD, which adds PATH (`live`: its lines in GitLab's
   * diff), the analysis of its pipeline, a review of HEAD that is done, and the snapshot that
   * review read (PATH as LINES). With `modified`, the merge request changes PATH instead: GitLab's
   * diff of it, and its text as the snapshot holds it.
   */
  const setup = async (
    key: string,
    o: {
      live?: readonly string[];
      modified?: { diff: string; snapshot: readonly string[] };
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
      diffs: [
        o.modified === undefined
          ? { oldPath: PATH, newPath: PATH, diff: added(o.live ?? LINES), newFile: true }
          : { oldPath: PATH, newPath: PATH, diff: o.modified.diff },
      ],
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
          status: o.modified === undefined ? 'added' : 'modified',
          patch: o.modified?.diff ?? added(LINES),
          since: null,
        },
        { type: 'file', path: PATH, text: `${(o.modified?.snapshot ?? LINES).join('\n')}\n` },
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
    // A low finding, which has a thread only for its suggestion, is counted and never listed.
    await aiFinding(branchId, { line: 9, severity: 'low', suggestion: LINE9 });
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
    const body = summaryOf(gitlabId);
    expect(body).toContain(
      `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:5 \` · Line five is wrong · [View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${id})\n\n`,
    );
    expect(body).toContain('**Findings:** 0 high · 1 medium · 1 low');
    expect(body).not.toMatch(/^- \*\*Low\*\* · /m);
    expect(body).not.toContain('more in Qualor');
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
    // The summary says why the analyzers' issues are not inline, and only theirs: the AI thread is.
    const body = summaryOf(gitlabId);
    expect(body).toContain(
      'The analyzers’ issues are not commented inline: this was a merged-results pipeline, whose line numbers are not the merge request’s.',
    );
    expect(body).not.toContain('No inline comments');
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
    // A low finding with a suggestion that applies: it is posted for it, or else only counted.
    await aiFinding(branchId, {
      line: 14,
      severity: 'low',
      suggestion: { startLine: 14, endLine: 14, lines: ['export const line14 = 140;'] },
    });
    // GitLab refuses the second and third threads' positions: the second is listed in the summary
    // instead, the low one is not.
    const refusal = {
      status: 400,
      body: { message: '400 Bad request - Note {:line_code=>["can\'t be blank"]}' },
    };
    fake.inject(
      'POST',
      new RegExp(`^/projects/${gitlabId}/merge_requests/12/discussions$`),
      { status: 201, passThrough: true },
      refusal,
      refusal,
    );
    await runDecorations(h, decorationDeps(h));
    expect([...threadsOf(gitlabId).keys()]).toEqual([placed]);
    expect(threadPosts()).toHaveLength(3);
    // The list holds the one without a thread, and only it (the prompt for an agent lists both).
    const item = `- **Medium** · \` ${PATH}:9 \` · The ninth line is wrong · [View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${refused})`;
    const listed = `**Not on changed lines:**\n\n${item}\n\n`;
    expect(summaryOf(gitlabId)).toContain(listed);
    expect(summaryOf(gitlabId)).not.toMatch(/^- \*\*(?:High|Low)\*\* · /m);

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
    // The one without a thread is listed, the one with its thread is not, nor the low one.
    expect(body).toContain(listed);
    expect(body).not.toMatch(/^- \*\*(?:High|Low)\*\* · /m);
    expect(body).not.toContain('more in Qualor');
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
    // Past the cap as well: a low finding with a suggestion, which is counted and never listed.
    await aiFinding(branchId, {
      line: 23,
      severity: 'low',
      suggestion: { startLine: 23, endLine: 23, lines: ['export const line23 = 230;'] },
    });
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
    expect(body).toContain('**Findings:** 0 high · 21 medium · 1 low');
    expect(body).toContain(`**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:21 \` · `);
    expect(body.match(/^- \*\*Medium\*\* · /gm)).toHaveLength(1);
    expect(body).not.toMatch(/^- \*\*Low\*\* · /m);
    expect(body).not.toContain('more in Qualor');
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

  it('leaves out a suggestion over a context or a masked line, and posts nothing on a context line', async () => {
    // A file the merge request changes: GitLab's diff adds lines 2, 3, 5 and 6, and keeps lines 1,
    // 4 and 7 as context.
    const head = [
      'export function pay(amount: number): number {',
      '  const fee = 1;',
      '  const label = "plain";',
      '  const total = amount + fee;',
      '  const rounded = Math.round(total);',
      '  return rounded;',
      '}',
    ];
    const diff = [
      '@@ -1,5 +1,7 @@',
      ' export function pay(amount: number): number {',
      '-  const fee = 0;',
      '+  const fee = 1;',
      '+  const label = "plain";',
      '   const total = amount + fee;',
      '-  return total;',
      '+  const rounded = Math.round(total);',
      '+  return rounded;',
      ' }',
      '',
    ].join('\n');
    // The scanner masked line 2 in the snapshot: the review read it so, and GitLab has it as it is.
    const snapshot = head.map((line, i) => (i === 1 ? '  const fee = «redacted»;' : line));
    const { gitlabId, branchId, project } = await setup('ai/context-lines', {
      modified: { diff, snapshot },
    });
    const masked = await aiFinding(branchId, {
      line: 2,
      suggestion: { startLine: 2, endLine: 2, lines: ['  const fee = 2;'] },
    });
    const crossing = await aiFinding(branchId, {
      line: 3,
      suggestion: {
        startLine: 3,
        endLine: 5,
        lines: ['  const label = "paid";', head[3]!, head[4]!],
      },
    });
    const applies = await aiFinding(branchId, {
      line: 5,
      suggestion: {
        startLine: 5,
        endLine: 6,
        lines: ['  const rounded = Math.round(total * 100) / 100;', '  return rounded;'],
      },
    });
    // The review placed this one on line 4, a line the scanner's diff added (against another merge
    // base, say), which GitLab's diff keeps as a context line.
    const onContext = await aiFinding(branchId, { line: 4, title: 'The total ignores the rate' });
    await runDecorations(h, decorationDeps(h));
    const threads = threadsOf(gitlabId);
    expect(new Set(threads.keys())).toEqual(new Set([masked, crossing, applies]));
    expect([masked, crossing, applies].map((id) => lineOf(threads.get(id)!))).toEqual([2, 3, 5]);
    const bodyOf = (id: string) => threads.get(id)?.notes[0]?.body ?? '';
    // Over a line the snapshot masked, and over a context line, the suggestion would replace code
    // other than the model was shown, or than the merge request added: the threads go without it.
    expect(bodyOf(masked)).not.toContain('```suggestion');
    expect(bodyOf(masked)).toContain('Why line 2 is wrong, and how to fix it.');
    expect(bodyOf(crossing)).not.toContain('```suggestion');
    expect(bodyOf(applies)).toContain(
      '```suggestion:-0+1\n  const rounded = Math.round(total * 100) / 100;\n  return rounded;\n```',
    );
    // No position is tried on a context line: the finding is listed instead.
    expect(threadPosts()).toHaveLength(3);
    expect(summaryOf(gitlabId)).toContain(
      `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:4 \` · The total ignores the rate · [View in Qualor](${PUBLIC_URL}/projects/${project.id}/issues/${onContext})\n\n`,
    );
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
