import type { Report } from '@qualor/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeGitHub,
  githubWrites,
  type FakeFile,
  type FakeGitHub,
  type FakeReviewComment,
} from '../../../test/fake-github';
import {
  githubConnection,
  githubDeps,
  githubTestConfig,
  mappedGitHubProject,
  pullRequestReport,
} from '../../../test/github';
import { createIngestHarness, type IngestHarness } from '../../../test/ingest';
import { checkAiThreadLines, FORBIDDEN_ANYWHERE } from '../../../test/markdown-check';
import { engine, file, finding } from '../../../test/reports';
import { seedAiIssue, storeTestSnapshot } from '../../../test/review';
import { PUBLIC_URL, runDecorations } from '../../../test/scm';
import {
  branches,
  issues,
  reviewFindings,
  reviewRuns,
  reviewSnapshots,
  type AiCategory,
} from '../../db/schema';
import { markerOf } from '../markdown';
import { enqueueDecoration } from '../queue';

/*
 * The AI review's threads on a GitHub pull request (6I-3): which findings get one and where, in
 * the one review that holds the analyzers' too, a suggestion over several lines sent with its
 * start_line and re-checked against the live diff, the cap beside the analyzers', the findings the
 * summary lists instead, and the snapshots a closed pull request loses. The review itself is
 * seeded: a run that is done, its findings, and the snapshot it read.
 */

const HEAD = '1'.repeat(40);
const NEWER = '2'.repeat(40);
const MERGE_COMMIT = '9'.repeat(40);
const BASE = 'b'.repeat(40);
const GRAPHQL = '/api/graphql';
const PATH = 'src/cart.ts';
/** The file the pull request adds, as the snapshot the review read holds it. */
const LINES = Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
/** The patch of a new file, as GitHub's file listing gives it (no final newline). */
const added = (lines: readonly string[]) =>
  `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
type Suggestion = { startLine: number; endLine: number; lines: string[] };
/** A suggestion that applies to line 9 of LINES. */
const LINE9: Suggestion = { startLine: 9, endLine: 9, lines: ['export const line9 = 90;'] };
/** A suggestion that applies to line 14 of LINES. */
const LINE14: Suggestion = { startLine: 14, endLine: 14, lines: ['export const line14 = 140;'] };
/** A suggestion over two lines that applies to lines 5 and 6 of LINES. */
const LINES5TO6: Suggestion = {
  startLine: 5,
  endLine: 6,
  lines: ['export const line5 = 50;', 'export const line6 = 60;'],
};
/** github.md §6.2: what the summary says when the workflow analysed another commit than the head. */
const CHECKOUT_OTHER =
  'No inline comments: the workflow analysed a commit other than the pull request’s head (GitHub’s merge commit, by default); check out the head to get them (`ref: ${{ github.event.pull_request.head.sha }}`).';
const STALE = 'Inline comments wait for the analysis of the pull request’s latest commit.';

/** A comment of a review as the client sent it. */
interface SentComment {
  path: string;
  line: number;
  side: string;
  start_line?: number;
  start_side?: string;
  body: string;
}
interface SentReview {
  commit_id: string;
  event: string;
  body: string;
  comments: SentComment[];
}
interface SentSingle extends SentComment {
  commit_id: string;
}

describe('GitHub decoration: AI review threads (6I-3, R16, R18)', () => {
  let h: IngestHarness;
  let fake: FakeGitHub;
  let connectionId: string;
  let nextRepo = 5000;
  let day = 1;

  /**
   * A mapped project on its own repository with pull request #7 at HEAD, which adds PATH (`live`:
   * its lines in GitHub's patch), the analysis of its workflow run, a review of HEAD that is done,
   * and the snapshot that review read (PATH as LINES). With `modified`, the pull request changes
   * PATH instead: GitHub's patch of it, and its text as the snapshot holds it. With `review:
   * false`, there is no review at all.
   */
  const setup = async (
    key: string,
    o: {
      live?: readonly string[];
      modified?: { patch: string; snapshot: readonly string[] };
      checkout?: 'head' | 'other';
      revision?: string;
      findings?: Report['findings'];
      review?: boolean;
    } = {},
  ) => {
    const repo = { id: nextRepo++, name: key.replace(/\W/g, '-') };
    fake.addRepository({ id: repo.id, owner: 'acme', name: repo.name, installationId: 777 });
    const patched: FakeFile =
      o.modified === undefined
        ? { filename: PATH, status: 'added', patch: added(o.live ?? LINES) }
        : { filename: PATH, status: 'modified', patch: o.modified.patch };
    fake.addPull(repo.id, {
      number: 7,
      title: 'Add the cart',
      state: 'open',
      headSha: HEAD,
      baseSha: BASE,
      files: [patched],
    });
    const project = await mappedGitHubProject(h, fake, key, `acme/${repo.name}`, { connectionId });
    const checkout = o.checkout ?? 'head';
    const github = { repositoryId: String(repo.id), checkout };
    const analysisId = await project.ingestOk(
      pullRequestReport(7, o.revision ?? HEAD, {
        projectKey: project.key,
        analysisDate: new Date(Date.UTC(2026, 8, 1, 10) + 86_400_000 * day++).toISOString(),
        engines: [engine('eslint')],
        files: [file(PATH, { lines: LINES.length, newLines: [[1, LINES.length]] })],
        findings: o.findings ?? [],
        github,
      }),
    );
    const [branch] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.kind, 'merge_request')));
    const branchId = branch!.id;
    if (o.review !== false) {
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
            patch: o.modified?.patch ?? added(LINES),
            since: null,
          },
          { type: 'file', path: PATH, text: `${(o.modified?.snapshot ?? LINES).join('\n')}\n` },
        ],
        { headSha: HEAD, mergeRequest: { id: '7', title: 'Add the cart', description: null } },
      );
    }
    return { project, repo, analysisId, branchId, github };
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
      body?: string;
      assumption?: string | null;
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
      body: o.body ?? `Why line ${o.line} is wrong, and how to fix it.`,
      assumption: o.assumption ?? null,
      suggestion: o.suggestion ?? null,
      anchorLine: o.anchorLine === undefined ? o.line : o.anchorLine,
      reviewedHeadSha: o.reviewedHeadSha ?? HEAD,
    });
    return id;
  };

  /** Qualor's threads on #7 by the issue their marker names: the first comment of each. */
  const threadsOf = (repoId: number) =>
    new Map(
      fake.reviewComments
        .filter((c) => c.repoId === repoId && c.inReplyToId === null)
        .flatMap((c) => {
          const marker = markerOf(c.body);
          return marker?.kind === 'issue' ? [[marker.issueId, c] as const] : [];
        }),
    );
  const threadOf = (comment: FakeReviewComment) => {
    const thread = fake.reviewThreads.find((t) => t.commentIds[0] === comment.id);
    if (!thread) throw new Error(`no thread for comment ${comment.id}`);
    return thread;
  };
  const summaryOf = (repoId: number) =>
    fake.comments.find((c) => c.repoId === repoId && markerOf(c.body)?.kind === 'summary')?.body ??
    '';
  const checkRunSummary = (repoId: number) =>
    fake.checkRuns.filter((r) => r.repoId === repoId).at(-1)?.summary ?? '';
  const posted = <T>(path: string): T[] =>
    fake.requests
      .filter((r) => r.method === 'POST' && r.path === path)
      .map((r) => JSON.parse(r.body) as T);
  /** The reviews a decoration POSTed, and the comments it POSTed alone. */
  const reviewsOf = (name: string) => posted<SentReview>(`/repos/acme/${name}/pulls/7/reviews`);
  const singlesOf = (name: string) => posted<SentSingle>(`/repos/acme/${name}/pulls/7/comments`);
  const reviewPath = (name: string) => new RegExp(`^/repos/acme/${name}/pulls/7/reviews$`);
  const singlePath = (name: string) => new RegExp(`^/repos/acme/${name}/pulls/7/comments$`);
  const writes = () => githubWrites(fake.requests);
  const mutations = () => writes().filter((w) => w.includes(GRAPHQL));
  const decorateAgain = async (
    s: Pick<Awaited<ReturnType<typeof setup>>, 'analysisId' | 'branchId' | 'github'>,
  ) => {
    await enqueueDecoration(h.ctx.db, {
      analysisId: s.analysisId,
      branchId: s.branchId,
      gitlab: null,
      github: s.github,
    });
    await runDecorations(h, githubDeps(h));
  };
  const snapshotsOf = (branchId: string) =>
    h.ctx.db
      .select({ id: reviewSnapshots.id })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.branchId, branchId));
  const closeFindings = (ids: string[]) =>
    h.ctx.db
      .update(issues)
      .set({ status: 'closed', closedAt: sql`now()` })
      .where(inArray(issues.id, ids));
  const issueLink = (projectId: string, issueId: string) =>
    `[View in Qualor](${PUBLIC_URL}/projects/${projectId}/issues/${issueId})`;

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

  it('a reviewed pull request gets its AI threads in the one review POST, a multi-line suggestion with start_line', async () => {
    const s = await setup('gh-ai/posted', { findings: [finding({ path: PATH, line: 3 })] });
    const { repo, branchId, project } = s;
    // A suggestion over lines 5 and 6, anchored on 5; one over line 9 only; a finding with none.
    const multi = await aiFinding(branchId, {
      line: 6,
      anchorLine: 5,
      severity: 'high',
      suggestion: LINES5TO6,
      title: 'The constants are off by ten',
    });
    const single = await aiFinding(branchId, { line: 9, suggestion: LINE9, title: 'Line nine' });
    const plain = await aiFinding(branchId, { line: 12 });
    // A finding an earlier review placed on an older head: its anchor is a line of that head, so
    // it is never posted with it. And one of a review with no place on a changed line.
    const older = await aiFinding(branchId, { line: 20, reviewedHeadSha: '3'.repeat(40) });
    const nowhere = await aiFinding(branchId, { line: 22, anchorLine: null });
    await runDecorations(h, githubDeps(h));

    // The check run, then one review that holds the analyzer's thread and the three AI threads,
    // then the summary: nothing else is written.
    expect(writes()).toEqual([
      `POST /repos/acme/${repo.name}/check-runs`,
      `POST /repos/acme/${repo.name}/pulls/7/reviews`,
      `POST /repos/acme/${repo.name}/issues/7/comments`,
    ]);
    const [review, ...more] = reviewsOf(repo.name);
    expect(more).toEqual([]);
    expect(singlesOf(repo.name)).toEqual([]);
    expect(review).toMatchObject({ commit_id: HEAD, event: 'COMMENT' });
    expect(review?.body).toBe(
      `<!-- qualor:review ${project.id} -->\nQualor: 4 new issues on changed lines.`,
    );
    // The analyzers' first, then the AI review's, the most severe first.
    const sent = review!.comments;
    expect(sent.map((c) => [c.line, c.start_line])).toEqual([
      [3, undefined],
      [6, 5],
      [9, undefined],
      [12, undefined],
    ]);
    // Over two lines the comment spans them (the suggestion replaces its whole range), on the
    // RIGHT side at both ends; over one line it is the line alone, with no start_line at all.
    expect(sent[1]).toEqual({
      path: PATH,
      line: 6,
      side: 'RIGHT',
      start_line: 5,
      start_side: 'RIGHT',
      body: [
        `<!-- qualor:issue ${multi} -->`,
        '**AI review** · High · Logic · likely · ` ai:logic `',
        '',
        '**The constants are off by ten**',
        '',
        'Why line 6 is wrong, and how to fix it.',
        '',
        '```suggestion',
        'export const line5 = 50;',
        'export const line6 = 60;',
        '```',
        '',
        issueLink(project.id, multi),
      ].join('\n'),
    });
    expect(Object.keys(sent[2] ?? {}).sort()).toEqual(['body', 'line', 'path', 'side']);
    expect(sent[2]?.body).toContain('```suggestion\nexport const line9 = 90;\n```');
    expect(sent[3]?.body).not.toContain('```suggestion');
    // GitHub holds them as comments of the App, each the first of a thread, with their ranges.
    const threads = threadsOf(repo.id);
    expect(threads.size).toBe(4);
    expect(threads.has(older) || threads.has(nowhere)).toBe(false);
    expect(
      [multi, single, plain].map((id) => [threads.get(id)?.line, threads.get(id)?.startLine]),
    ).toEqual([
      [6, 5],
      [9, null],
      [12, null],
    ]);
    for (const id of [multi, single, plain]) {
      const comment = threads.get(id)!;
      expect(comment).toMatchObject({ commitId: HEAD, side: 'RIGHT', user: { type: 'Bot' } });
      const body = comment.body.replace(PUBLIC_URL, 'https://q.example');
      expect(checkAiThreadLines(body), body).toBe(true);
    }
    // The summary counts the analyzers' thread as theirs, and the AI section speaks for its own:
    // the finding with no place is listed, the one of the older head only counted.
    const body = summaryOf(repo.id);
    expect(body).toContain('1 new issue is commented inline.');
    expect(body).toContain('**Findings:** 1 high · 4 medium · 0 low');
    expect(body).toContain(
      `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:22 \` · Line 22 is wrong · ${issueLink(project.id, nowhere)}\n\n`,
    );
    expect(checkRunSummary(repo.id)).toContain('1 new issue is commented inline.');
    // Decorating again changes nothing: the AI threads that are there now are still not counted as
    // the analyzers', so neither the summary nor the check run is edited.
    fake.clearRequests();
    await decorateAgain(s);
    expect(writes()).toEqual([]);
    expect(summaryOf(repo.id)).toBe(body);
  });

  it("a fixed prior's thread is resolved", async () => {
    const s = await setup('gh-ai/fixed', { findings: [finding({ path: PATH, line: 3 })] });
    const { repo, branchId } = s;
    const kept = await aiFinding(branchId, { line: 5 });
    const fixed = await aiFinding(branchId, { line: 9 });
    const discussed = await aiFinding(branchId, { line: 12 });
    const personResolved = await aiFinding(branchId, { line: 14 });
    await runDecorations(h, githubDeps(h));
    const threads = threadsOf(repo.id);
    expect(threads.size).toBe(5);
    // A person replies in the third thread, and resolves the fourth while its finding is open.
    fake.replyToReviewComment(repo.id, 7, threads.get(discussed)!.id, {
      body: 'Is it?',
      login: 'octocat',
    });
    fake.resolveThreadAs(threadOf(threads.get(personResolved)!).id, 'octocat');
    // A later review closes the second, third and fourth findings.
    await closeFindings([fixed, discussed, personResolved]);
    fake.clearRequests();
    await decorateAgain(s);
    // Qualor resolves the thread of the fixed finding no person spoke in, and nothing else.
    expect(mutations()).toEqual([`POST ${GRAPHQL} QualorResolveThread`]);
    const resolved = (id: string) => threadOf(threadsOf(repo.id).get(id)!);
    expect(resolved(fixed)).toMatchObject({ resolved: true, resolvedBy: `${fake.slug}[bot]` });
    expect(resolved(kept)).toMatchObject({ resolved: false });
    expect(resolved(discussed)).toMatchObject({ resolved: false });
    expect(resolved(personResolved)).toMatchObject({ resolved: true, resolvedBy: 'octocat' });
    expect(threadsOf(repo.id).size).toBe(5);
    // The analyzers' count is theirs alone: the closed AI findings change nothing in it.
    expect(summaryOf(repo.id)).toContain('1 new issue is commented inline.');

    // The finding comes back: the thread Qualor resolved is reopened, with no second thread. The
    // thread a person resolved stays resolved whatever becomes of its finding.
    await h.ctx.db
      .update(issues)
      .set({ status: 'open', closedAt: null })
      .where(inArray(issues.id, [fixed, personResolved]));
    fake.clearRequests();
    await decorateAgain(s);
    expect(mutations()).toEqual([`POST ${GRAPHQL} QualorUnresolveThread`]);
    expect(resolved(fixed)).toMatchObject({ resolved: false, resolvedBy: null });
    expect(resolved(personResolved)).toMatchObject({ resolved: true, resolvedBy: 'octocat' });
    expect(
      fake.reviewComments.filter((c) => c.repoId === repo.id && c.inReplyToId === null),
    ).toHaveLength(5);
    expect(
      fake.requests.filter((r) => r.method === 'POST' && r.path.includes('/pulls/7/')),
    ).toEqual([]);
  });

  it('a moved-on pull request gets no AI thread', async () => {
    const s = await setup('gh-ai/moved-on');
    const { repo, branchId, project } = s;
    const placed = await aiFinding(branchId, { line: 5, severity: 'high' });
    await runDecorations(h, githubDeps(h));
    expect([...threadsOf(repo.id).keys()]).toEqual([placed]);
    // Two findings of the same review without a thread yet (a low one with a suggestion that
    // applies, and a medium one), and a push after the review: GitHub's pull request is at a newer
    // head, whose workflow run is not analysed yet. No thread is posted with the numbers of the
    // head the review read.
    const waiting = await aiFinding(branchId, { line: 9, title: 'The ninth line is wrong' });
    await aiFinding(branchId, {
      line: 14,
      severity: 'low',
      suggestion: LINE14,
    });
    fake.updatePull(repo.id, 7, { headSha: NEWER });
    fake.clearRequests();
    await decorateAgain(s);
    expect(reviewsOf(repo.name)).toEqual([]);
    expect(singlesOf(repo.name)).toEqual([]);
    expect(writes().filter((w) => w.includes('/pulls/'))).toEqual([]);
    expect([...threadsOf(repo.id).keys()]).toEqual([placed]);
    // The summary lists the one without a thread, and only it: not the one that has its thread, nor
    // the low one (which is counted).
    const listed = `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:9 \` · The ninth line is wrong · ${issueLink(project.id, waiting)}\n\n`;
    for (const body of [summaryOf(repo.id), checkRunSummary(repo.id)]) {
      expect(body).toContain(listed);
      expect(body).not.toMatch(/^- \*\*(?:High|Low)\*\* · /m);
      expect(body).not.toContain('more in Qualor');
      expect(body).toContain(STALE);
      expect(body).toContain(
        'Reviewed commit: ` 111111111111 `; the pull request is now at ` 222222222222 `; the next workflow run reviews the new commits.',
      );
    }
    // The pull request is back at the reviewed head (a force push): their threads are posted, in a
    // review of their own.
    fake.updatePull(repo.id, 7, { headSha: HEAD });
    fake.clearRequests();
    await decorateAgain(s);
    expect(reviewsOf(repo.name).map((r) => r.comments.map((c) => c.line))).toEqual([[9, 14]]);
    expect(summaryOf(repo.id)).not.toContain('Not on changed lines');
  });

  it('a closed pull request deletes the snapshots', async () => {
    for (const [name, merged] of [
      ['closed', false],
      ['merged', true],
    ] as const) {
      const s = await setup(`gh-ai/${name}`);
      await runDecorations(h, githubDeps(h));
      // While it is open, the snapshot stays: the next push of the pull request replaces it.
      expect(await snapshotsOf(s.branchId)).toHaveLength(1);
      // GitHub shows a merged pull request as a closed one.
      fake.updatePull(s.repo.id, 7, { state: 'closed', merged });
      await decorateAgain(s);
      expect([name, await snapshotsOf(s.branchId)]).toEqual([name, []]);
    }
  });

  it('keeps the 21st AI finding without a thread, beside the analyzers’ own', async () => {
    const s = await setup('gh-ai/cap', {
      // Two analyzer findings: the analyzers' threads have a cap of their own.
      findings: [finding({ path: PATH, line: 25 }), finding({ path: PATH, line: 26 })],
    });
    const { repo, branchId } = s;
    const ids: string[] = [];
    for (let line = 1; line <= 21; line += 1) ids.push(await aiFinding(branchId, { line }));
    // Past the cap as well: a low finding with a suggestion, which is counted and never listed.
    await aiFinding(branchId, {
      line: 23,
      severity: 'low',
      suggestion: { startLine: 23, endLine: 23, lines: ['export const line23 = 230;'] },
    });
    await runDecorations(h, githubDeps(h));
    // One review holds the two analyzer threads and the twenty most severe AI findings, then by
    // place: lines 1 to 20.
    const reviews = reviewsOf(repo.name);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.comments.map((c) => c.line)).toEqual([
      25,
      26,
      ...Array.from({ length: 20 }, (_, i) => i + 1),
    ]);
    const threads = threadsOf(repo.id);
    expect(ids.filter((id) => threads.has(id))).toEqual(ids.slice(0, 20));
    expect(reviews[0]?.body).toContain('Qualor: 22 new issues on changed lines.');
    const body = summaryOf(repo.id);
    expect(body).toContain('2 new issues are commented inline.');
    expect(body).toContain('**Findings:** 0 high · 21 medium · 1 low');
    expect(body).toContain(`**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:21 \` · `);
    expect(body.match(/^- \*\*Medium\*\* · /gm)).toHaveLength(1);
    expect(body).not.toMatch(/^- \*\*Low\*\* · /m);
    expect(body).not.toContain('more in Qualor');
  });

  it('a low finding without a suggestion gets no thread', async () => {
    const s = await setup('gh-ai/low');
    const { repo, branchId } = s;
    const bare = await aiFinding(branchId, { line: 5, severity: 'low' });
    const lowered = await aiFinding(branchId, { line: 7, severity: 'info' });
    const suggested = await aiFinding(branchId, { line: 9, severity: 'low', suggestion: LINE9 });
    const medium = await aiFinding(branchId, { line: 12, severity: 'medium' });
    const raised = await aiFinding(branchId, { line: 14, severity: 'blocker' });
    await runDecorations(h, githubDeps(h));
    const threads = threadsOf(repo.id);
    expect(new Set(threads.keys())).toEqual(new Set([suggested, medium, raised]));
    expect(threads.has(bare) || threads.has(lowered)).toBe(false);
    expect(threads.get(suggested)?.body).toContain(
      '**AI review** · Low · Logic · likely · ` ai:logic `',
    );
    expect(threads.get(suggested)?.body).toContain('```suggestion\nexport const line9 = 90;\n```');
    expect(threads.get(medium)?.line).toBe(12);
    // It is counted, and not listed among the findings that could not be posted.
    const body = summaryOf(repo.id);
    expect(body).toContain('**Findings:** 1 high · 1 medium · 3 low');
    expect(body).not.toContain('Not on changed lines');
  });

  it('a suggestion whose lines changed in the live diff is left out, and the comment spans no range', async () => {
    // GitHub's patch of the head has line 5 otherwise than the snapshot the review read.
    const live = LINES.map((line, i) => (i === 4 ? 'export const line5 = 500;' : line));
    const s = await setup('gh-ai/live-diff', { live });
    const { repo, branchId } = s;
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
    // A range whose last line changed: the whole suggestion goes, and with it the range.
    const first = await aiFinding(branchId, {
      line: 4,
      severity: 'high',
      suggestion: {
        startLine: 4,
        endLine: 5,
        lines: ['export const line4 = 40;', 'export const line5 = 50;'],
      },
    });
    // One that does not start on the line its thread sits on would replace other lines.
    const elsewhere = await aiFinding(branchId, {
      line: 14,
      suggestion: { startLine: 15, endLine: 15, lines: ['export const line15 = 1500;'] },
    });
    // A low finding is posted for its suggestion only: when that no longer applies, nothing is.
    const low = await aiFinding(branchId, {
      line: 20,
      severity: 'low',
      suggestion: {
        startLine: 20,
        endLine: 21,
        lines: ['export const line20 = 200;', 'export const line21 = 210;', 'x'],
      },
    });
    const lowChanged = await aiFinding(branchId, {
      line: 5,
      severity: 'low',
      suggestion: { startLine: 5, endLine: 5, lines: ['x'] },
    });
    await runDecorations(h, githubDeps(h));
    const threads = threadsOf(repo.id);
    expect(new Set(threads.keys())).toEqual(new Set([changed, same, first, elsewhere, low]));
    expect(threads.has(lowChanged)).toBe(false);
    const bodyOf = (id: string) => threads.get(id)?.body ?? '';
    for (const id of [changed, first, elsewhere]) {
      expect(bodyOf(id)).not.toContain('```suggestion');
      // On its anchor, as one line.
      expect(threads.get(id)?.startLine).toBeNull();
    }
    expect(threads.get(changed)?.line).toBe(5);
    expect(threads.get(first)?.line).toBe(4);
    expect(threads.get(elsewhere)?.line).toBe(14);
    expect(bodyOf(changed)).toContain('Why line 5 is wrong, and how to fix it.');
    expect(bodyOf(same)).toContain(
      '```suggestion\nexport const line9 = 9000;\nexport const line10 = 10;\n```',
    );
    // The kept one spans its two lines.
    expect([threads.get(same)?.line, threads.get(same)?.startLine]).toEqual([10, 9]);
    // The low one is posted for its suggestion, which still applies: it has a range.
    expect(bodyOf(low)).toContain('```suggestion');
    expect(summaryOf(repo.id)).not.toContain('Not on changed lines');

    // Without the snapshot the review read (deleted since), no suggestion can be checked: none is
    // posted, and the finding still is, on its anchor.
    const gone = await setup('gh-ai/no-snapshot');
    await h.ctx.db.delete(reviewSnapshots).where(eq(reviewSnapshots.branchId, gone.branchId));
    const unchecked = await aiFinding(gone.branchId, {
      line: 9,
      suggestion: { startLine: 9, endLine: 10, lines: ['export const line9 = 9000;', 'y'] },
    });
    await runDecorations(h, githubDeps(h));
    const comment = threadsOf(gone.repo.id).get(unchecked);
    expect(comment?.body).toContain('Why line 9 is wrong, and how to fix it.');
    expect(comment?.body).not.toContain('```suggestion');
    expect([comment?.line, comment?.startLine]).toEqual([9, null]);
  });

  it('leaves out a suggestion over a context or a masked line, and posts nothing on a context line', async () => {
    // A file the pull request changes: GitHub's patch adds lines 2, 3, 5 and 6, and keeps lines 1,
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
    const patch = [
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
    ].join('\n');
    // The scanner masked line 2 in the snapshot: the review read it so, and GitHub has it as it is.
    const snapshot = head.map((line, i) => (i === 1 ? '  const fee = «redacted»;' : line));
    const { repo, branchId, project } = await setup('gh-ai/context-lines', {
      modified: { patch, snapshot },
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
    // base, say), which GitHub's patch keeps as a context line.
    const onContext = await aiFinding(branchId, { line: 4, title: 'The total ignores the rate' });
    await runDecorations(h, githubDeps(h));
    const threads = threadsOf(repo.id);
    expect(new Set(threads.keys())).toEqual(new Set([masked, crossing, applies]));
    expect([masked, crossing, applies].map((id) => threads.get(id)?.line)).toEqual([2, 3, 6]);
    // Over a line the snapshot masked, and over a context line, the suggestion would replace code
    // other than the model was shown, or than the pull request added: the threads go without it.
    for (const id of [masked, crossing]) {
      expect(threads.get(id)?.body).not.toContain('```suggestion');
      expect(threads.get(id)?.startLine).toBeNull();
    }
    expect(threads.get(masked)?.body).toContain('Why line 2 is wrong, and how to fix it.');
    expect(threads.get(applies)?.body).toContain(
      '```suggestion\n  const rounded = Math.round(total * 100) / 100;\n  return rounded;\n```',
    );
    expect(threads.get(applies)?.startLine).toBe(5);
    // No position is tried on a context line: the finding is listed instead.
    expect(reviewsOf(repo.name)[0]?.comments).toHaveLength(3);
    expect(summaryOf(repo.id)).toContain(
      `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:4 \` · The total ignores the rate · ${issueLink(project.id, onContext)}\n\n`,
    );
  });

  it('comments only the anchor when the note leaves its suggestion out', async () => {
    const s = await setup('gh-ai/block-dropped');
    const { repo, branchId } = s;
    // A suggestion that applies to the diff, but one the note would not write: its first line is a
    // GitLab quick action. The finding keeps its thread, as one line, with no range to show. Its
    // body holds a fence line of its own, which the model's words cannot turn into a block.
    const id = await aiFinding(branchId, {
      line: 9,
      body: 'Replace it.\n```suggestion\nexport const line9 = 0;\n```',
      suggestion: { startLine: 9, endLine: 10, lines: ['/merge now', 'x'] },
    });
    await runDecorations(h, githubDeps(h));
    const [review] = reviewsOf(repo.name);
    expect(review?.comments).toHaveLength(1);
    expect(review?.comments[0]).toMatchObject({ path: PATH, line: 9 });
    expect(review?.comments[0]).not.toHaveProperty('start_line');
    const lines = review?.comments[0]?.body.split('\n') ?? [];
    expect(lines).not.toContain('```suggestion');
    expect(lines).toContain('```` ```suggestion ````');
    expect(threadsOf(repo.id).get(id)?.startLine).toBeNull();
  });

  it('posts a comment GitHub refused alone with its start_line, and lists it until it is posted', async () => {
    const s = await setup('gh-ai/refused');
    const { repo, branchId, project } = s;
    const multi = await aiFinding(branchId, {
      line: 6,
      anchorLine: 5,
      severity: 'high',
      suggestion: LINES5TO6,
      title: 'The constants are off by ten',
    });
    const single = await aiFinding(branchId, { line: 9, suggestion: LINE9 });
    // GitHub refuses the review, then the first comment posted alone; the second it places.
    fake.inject('POST', reviewPath(repo.name), { status: 422, body: { message: 'Unprocessable' } });
    fake.inject('POST', singlePath(repo.name), {
      status: 422,
      body: { message: 'Validation Failed' },
    });
    await runDecorations(h, githubDeps(h));
    const run = fake.checkRuns.filter((r) => r.repoId === repo.id).at(-1)!;
    expect(writes()).toEqual([
      `POST /repos/acme/${repo.name}/check-runs`,
      `POST /repos/acme/${repo.name}/pulls/7/reviews`,
      `POST /repos/acme/${repo.name}/pulls/7/comments`,
      `POST /repos/acme/${repo.name}/pulls/7/comments`,
      `POST /repos/acme/${repo.name}/issues/7/comments`,
      `PATCH /repos/acme/${repo.name}/check-runs/${run.id}`,
    ]);
    // The review carried the range; so does the comment alone, which GitHub refused.
    const [review] = reviewsOf(repo.name);
    expect(review?.comments[0]).toMatchObject({ line: 6, start_line: 5, start_side: 'RIGHT' });
    const [refused, placed] = singlesOf(repo.name);
    expect(refused).toMatchObject({
      commit_id: HEAD,
      path: PATH,
      line: 6,
      side: 'RIGHT',
      start_line: 5,
      start_side: 'RIGHT',
    });
    expect(placed).toMatchObject({ commit_id: HEAD, path: PATH, line: 9, side: 'RIGHT' });
    expect(placed).not.toHaveProperty('start_line');
    expect([...threadsOf(repo.id).keys()]).toEqual([single]);
    // The one GitHub refused is listed, in the check run (corrected by the PATCH) and the summary.
    const listed = `**Not on changed lines:**\n\n- **High** · \` ${PATH}:6 \` · The constants are off by ten · ${issueLink(project.id, multi)}\n\n`;
    expect(summaryOf(repo.id)).toContain(listed);
    expect(run.summary).toContain(listed);
    const sentSummary = (method: string) =>
      (
        JSON.parse(
          fake.requests.find((r) => r.method === method && r.path.includes('/check-runs'))!.body,
        ) as { output: { summary: string } }
      ).output.summary;
    expect(sentSummary('POST')).not.toContain('Not on changed lines');
    expect(sentSummary('PATCH')).toContain(listed);

    // The next decoration tries it again, as the one thread it is missing, and the list is empty.
    fake.clearRequests();
    await decorateAgain(s);
    const [again, ...rest] = reviewsOf(repo.name);
    expect(rest).toEqual([]);
    expect(again?.comments).toHaveLength(1);
    expect(again?.comments[0]).toMatchObject({ line: 6, start_line: 5 });
    expect(threadsOf(repo.id).has(multi)).toBe(true);
    expect(summaryOf(repo.id)).not.toContain('Not on changed lines');
  });

  it('lists a refused finding, counts a refused low one, and keeps the analyzers’ counts apart', async () => {
    const s = await setup('gh-ai/all-refused', { findings: [finding({ path: PATH, line: 3 })] });
    const { repo, branchId, project } = s;
    const medium = await aiFinding(branchId, { line: 9, title: 'Line nine is wrong' });
    await aiFinding(branchId, { line: 14, severity: 'low', suggestion: LINE14 });
    // GitHub refuses the review and then every comment posted alone: the analyzer's, the medium
    // finding's and the low one's.
    const refusal = { status: 422, body: { message: 'Validation Failed' } };
    fake.inject('POST', reviewPath(repo.name), { status: 422, body: { message: 'Unprocessable' } });
    fake.inject('POST', singlePath(repo.name), refusal, refusal, refusal);
    await runDecorations(h, githubDeps(h));
    expect(singlesOf(repo.name).map((c) => c.line)).toEqual([3, 9, 14]);
    expect(threadsOf(repo.id).size).toBe(0);
    for (const body of [summaryOf(repo.id), checkRunSummary(repo.id)]) {
      // The analyzer's issue is the one that could not be placed: the AI findings are no part of it.
      expect(body).toContain(
        '0 new issues are commented inline; 1 could not be placed on the diff.',
      );
      expect(body).toContain(
        `**Not on changed lines:**\n\n- **Medium** · \` ${PATH}:9 \` · Line nine is wrong · ${issueLink(project.id, medium)}\n\n`,
      );
      expect(body).toContain('**Findings:** 0 high · 1 medium · 1 low');
      expect(body).not.toMatch(/^- \*\*Low\*\* · /m);
    }
  });

  it('checkout other: posts the AI threads while the analyzers’ threads stay skipped', async () => {
    const s = await setup('gh-ai/other', {
      checkout: 'other',
      revision: MERGE_COMMIT,
      findings: [finding({ path: PATH, line: 3 })],
    });
    const { repo, branchId } = s;
    const id = await aiFinding(branchId, {
      line: 6,
      anchorLine: 5,
      severity: 'high',
      suggestion: LINES5TO6,
    });
    const closing = await aiFinding(branchId, { line: 12 });
    await runDecorations(h, githubDeps(h));
    // The review read the pull request's head, whose line numbers are GitHub's: its threads are
    // posted, and only its. The analyzer's finding, found in a merge commit, has no thread.
    const [review] = reviewsOf(repo.name);
    expect(review?.commit_id).toBe(HEAD);
    expect(review?.comments.map((c) => [c.line, c.start_line])).toEqual([
      [6, 5],
      [12, undefined],
    ]);
    expect([...threadsOf(repo.id).keys()].sort()).toEqual([id, closing].sort());
    // The summary says why the analyzers' issues are not inline, and the AI section is there.
    for (const body of [summaryOf(repo.id), checkRunSummary(repo.id)]) {
      expect(body).toContain(CHECKOUT_OTHER);
      expect(body).toContain(
        '#### AI review\n\nThe cart has problems.\n\n**Findings:** 1 high · 1 medium · 0 low',
      );
    }
    // A later review closes one finding: its thread is resolved, and nothing of the analyzers' is.
    await closeFindings([closing]);
    fake.clearRequests();
    await decorateAgain(s);
    expect(mutations()).toEqual([`POST ${GRAPHQL} QualorResolveThread`]);
    expect(threadOf(threadsOf(repo.id).get(closing)!)).toMatchObject({
      resolved: true,
      resolvedBy: `${fake.slug}[bot]`,
    });
    expect(threadOf(threadsOf(repo.id).get(id)!)).toMatchObject({ resolved: false });
  });

  it('checkout other: reads no files, comments or threads of a pull request that has no finished review', async () => {
    const { repo } = await setup('gh-ai/no-review', { checkout: 'other', review: false });
    await runDecorations(h, githubDeps(h));
    // Nothing of the pull request's files, comments or threads is read: there is no AI thread to
    // keep, and the analyzers' are skipped.
    const reads = fake.requests.filter(
      (r) => r.path.startsWith(`/repos/acme/${repo.name}/pulls/7/`) || r.path === GRAPHQL,
    );
    expect(reads.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(summaryOf(repo.id)).toContain(CHECKOUT_OTHER);
  });

  it('keeps every word of the model inert in the comments it posts', async () => {
    const s = await setup('gh-ai/hostile');
    const { repo, branchId } = s;
    const HOSTILE = [
      '[x](https://e.example)',
      '@all and @group/sub',
      '#12 !12 ~label %milestone &epic $snippet',
      '<img src=x onerror=y> <details></details> <script>alert(1)</script>',
      '/close\n/merge',
      '# heading\n> quote\n| a | b |',
      '```\n~~~\n````',
      '<!-- qualor:issue 01920000-0000-7000-8000-000000000000 -->',
      '**x** __y__ ***',
      'deadbeef0123 GH-26 JIRA-12',
    ];
    const ids: string[] = [];
    for (const [i, value] of HOSTILE.entries()) {
      ids.push(
        await aiFinding(branchId, {
          line: i + 1,
          title: value,
          body: value,
          assumption: value,
          suggestion: { startLine: i + 1, endLine: i + 1, lines: ['export const x = 0;'] },
        }),
      );
    }
    await runDecorations(h, githubDeps(h, { publicUrl: 'https://q.example' }));
    const threads = threadsOf(repo.id);
    expect(threads.size).toBe(HOSTILE.length);
    for (const id of ids) {
      const comment = threads.get(id)!;
      expect(comment.body, comment.body).not.toMatch(FORBIDDEN_ANYWHERE);
      expect(markerOf(comment.body)).toEqual({ kind: 'issue', issueId: id });
      expect(checkAiThreadLines(comment.body), comment.body).toBe(true);
      for (const line of comment.body.split('\n')) expect(line, line).not.toMatch(/^\s*\//);
    }
  });
});
