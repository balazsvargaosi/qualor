import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import {
  answerJob,
  queuedAnswers,
  refuseAnswerJobs,
  reviewOff,
  reviewOn,
  reviewScope,
} from '../../test/replies';
import { engine, file, finding } from '../../test/reports';
import {
  decorationDeps,
  mappedProject,
  mergeRequestReport,
  queuedDecorations,
  runDecorations,
  scmTestConfig,
} from '../../test/scm';
import { first } from '../db/rows';
import { branches, issues, jobs, reviewReplies } from '../db/schema';
import { endReply, insertReplies } from '../review/replies';
import { MAX_QUEUED_COMMANDS, MAX_QUEUED_ROUNDS, replyKey } from '../review/reply-queue';
import { MAX_GITLAB_REQUESTS } from './gitlab/client';
import {
  addedLineTexts,
  MAX_AI_THREADS,
  MAX_DIFF_PAGES,
  MAX_DISCUSSION_PAGES,
  MAX_FIXED_NOTES,
  MAX_INLINE_THREADS,
  MAX_THREAD_UPDATES,
  REQUESTS_OUTSIDE_INLINE,
} from './inline';
import { issueMarker, markerOf } from './markdown';
import { enqueueDecoration } from './queue';

const HEAD = '1'.repeat(40);
const BASE = 'b'.repeat(40);
/** src/a.ts: lines 3–5 added. src/renamed.ts: renamed from src/old.ts, line 2 added. */
const DIFFS = [
  { oldPath: 'src/a.ts', newPath: 'src/a.ts', diff: '@@ -1,2 +1,5 @@\n a\n b\n+c\n+d\n+e\n' },
  {
    oldPath: 'src/old.ts',
    newPath: 'src/renamed.ts',
    diff: '@@ -1,2 +1,3 @@\n x\n+y\n z\n',
    renamedFile: true,
  },
];
const HUMAN = 5;

describe('addedLineTexts', () => {
  it('numbers the added lines of every hunk in the new file', () => {
    const numbers = (diff: string) => [...addedLineTexts(diff).keys()];
    expect(numbers(DIFFS[0]!.diff)).toEqual([3, 4, 5]);
    expect(numbers('@@ -1 +1,2 @@\n-a\n+b\n+c\n@@ -9,2 +10,2 @@\n x\n+y\n')).toEqual([1, 2, 11]);
    expect(numbers('Binary files differ')).toEqual([]);
  });
});

describe('the request budget (scm.md §4.3)', () => {
  it('the GitLab request bounds sum to 377', () => {
    // Project, user, merge request, commit status (read, post and its retry without the pipeline),
    // the summary, and every page of discussions and diffs.
    expect(REQUESTS_OUTSIDE_INLINE).toBe(7 + MAX_DISCUSSION_PAGES + MAX_DIFF_PAGES);
    // The analyzers' threads, the AI review's beside them, the resolutions and reopenings of both,
    // and the notes of fixed issues in the threads people replied in: a job that does all it may
    // still writes the summary.
    expect([
      REQUESTS_OUTSIDE_INLINE,
      MAX_INLINE_THREADS,
      MAX_AI_THREADS,
      MAX_THREAD_UPDATES,
      MAX_FIXED_NOTES,
    ]).toEqual([87, 50, 20, 200, 20]);
    const sum =
      REQUESTS_OUTSIDE_INLINE +
      MAX_INLINE_THREADS +
      MAX_AI_THREADS +
      MAX_THREAD_UPDATES +
      MAX_FIXED_NOTES;
    expect(sum).toBe(377);
    expect(sum).toBeLessThanOrEqual(MAX_GITLAB_REQUESTS);
    expect(MAX_GITLAB_REQUESTS).toBe(400);
  });
});

describe('GitLab inline discussions (scm.md §5.4)', () => {
  let h: IngestHarness;
  let fake: FakeGitLab;
  let nextGitLabProject = 200;
  let day = 1;

  /** A mapped project and merge request !7; `shared` maps it to another project's GitLab project. */
  const setup = async (key: string, shared?: number) => {
    const gitlabId = shared ?? nextGitLabProject++;
    if (shared === undefined) {
      fake.addProject({ id: gitlabId, path: `acme/${key.replace(/\W/g, '-')}` });
      fake.addMergeRequest(gitlabId, {
        iid: 7,
        title: 'Inline',
        state: 'opened',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        headSha: HEAD,
        baseSha: BASE,
        startSha: BASE,
        diffs: DIFFS,
      });
    }
    const project = await mappedProject(h, fake, key, gitlabId);
    const ingest = (
      lines: number[],
      extra: Parameters<typeof mergeRequestReport>[2] = {},
      revision = HEAD,
    ) =>
      project.ingestOk(
        mergeRequestReport(7, revision, {
          projectKey: project.key,
          analysisDate: new Date(Date.UTC(2026, 8, 1, 10) + 86_400_000 * day++).toISOString(),
          engines: [engine('eslint')],
          files: [
            file('src/a.ts', { newLines: [[1, 60]] }),
            file('src/renamed.ts', { newLines: [[2, 2]] }),
          ],
          findings: lines.map((line) => finding({ path: 'src/a.ts', line })),
          ...extra,
        }),
      );
    return { project, gitlabId, ingest };
  };
  const threads = (gitlabId: number) =>
    fake
      .discussions(gitlabId, 7)
      .filter((d) => d.notes[0] && markerOf(d.notes[0].body)?.kind === 'issue');
  const summary = (gitlabId: number, projectId?: string) =>
    fake
      .discussions(gitlabId, 7)
      .flatMap((d) => d.notes)
      .find((n) => {
        const marker = markerOf(n.body);
        return (
          marker?.kind === 'summary' && (projectId === undefined || marker.projectId === projectId)
        );
      })?.body ?? '';
  const lineOf = (d: ReturnType<typeof threads>[number]) => d.notes[0]?.position?.['new_line'];
  const resolvedByLine = (gitlabId: number) =>
    Object.fromEntries(threads(gitlabId).map((d) => [lineOf(d), d.notes[0]?.resolved]));
  const threadAt = (gitlabId: number, line: number) => {
    const found = threads(gitlabId).find((d) => lineOf(d) === line);
    if (!found) throw new Error(`no thread on line ${line}`);
    return found;
  };
  const threadWrites = () =>
    fake.requests.filter((r) => r.method !== 'GET' && r.path.includes('/discussions'));

  beforeAll(async () => {
    fake = await createFakeGitLab();
    h = await createIngestHarness({ config: scmTestConfig(fake) });
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });
  beforeEach(() => fake.clearRequests());

  it('comments the new issues on added lines, counts the others, and does it once', async () => {
    const { gitlabId, ingest } = await setup('inline/place');
    // Line 1 is new code for Qualor but not an added line of GitLab's diff.
    await ingest([1, 3, 4]);
    await runDecorations(h, decorationDeps(h));
    const placed = threads(gitlabId);
    expect(placed.map((d) => d.notes[0]?.position?.['new_line']).sort()).toEqual([3, 4]);
    expect(placed[0]?.notes[0]?.position).toMatchObject({
      position_type: 'text',
      base_sha: BASE,
      start_sha: BASE,
      head_sha: HEAD,
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
    });
    expect(placed[0]?.notes[0]?.body).toMatch(
      /^<!-- qualor:issue [0-9a-f-]{36} -->\n\*\*Medium\*\*/,
    );
    expect(summary(gitlabId)).toContain(
      '2 new issues are commented inline; 1 could not be placed on the diff.',
    );
    fake.clearRequests();
    await ingest([1, 3, 4]);
    await runDecorations(h, decorationDeps(h));
    expect(threads(gitlabId)).toHaveLength(2);
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/discussions'))).toBe(
      false,
    );
  });

  it("links each rule key to the rule's live documentation, in the threads and the summary", async () => {
    const { gitlabId, ingest } = await setup('inline/rule-links');
    const dead = 'https://rules.sonarsource.com/javascript/RSPEC-1871/';
    const live =
      'https://sonarcloud.io/organizations/sonarsource/rules?open=javascript%3AS1871&rule_key=javascript%3AS1871';
    await ingest([], {
      engines: [engine('eslint', [{ id: 'no-alert', helpUri: dead }])],
      findings: [
        finding({ path: 'src/a.ts', line: 3, ruleId: 'no-alert' }),
        finding({ path: 'src/a.ts', line: 4, ruleId: 'eqeqeq' }),
      ],
    });
    await runDecorations(h, decorationDeps(h));
    expect(threadAt(gitlabId, 3).notes[0]?.body.split('\n')[1]).toBe(
      `**Medium** · maintainability · [\` eslint:no-alert \`](${live})`,
    );
    expect(threadAt(gitlabId, 4).notes[0]?.body.split('\n')[1]).toBe(
      '**Medium** · maintainability · ` eslint:eqeqeq `',
    );
    const body = summary(gitlabId);
    expect(body).toContain(`[\` eslint:no-alert \`](${live})`);
    // Decorating again with nothing changed edits no note.
    fake.clearRequests();
    await ingest([], {
      engines: [engine('eslint', [{ id: 'no-alert', helpUri: dead }])],
      findings: [
        finding({ path: 'src/a.ts', line: 3, ruleId: 'no-alert' }),
        finding({ path: 'src/a.ts', line: 4, ruleId: 'eqeqeq' }),
      ],
    });
    await runDecorations(h, decorationDeps(h));
    expect(fake.requests.filter((r) => r.method === 'PUT' || r.method === 'POST')).toEqual([]);
    expect(summary(gitlabId)).toBe(body);
  });

  it('resolves the thread of a fixed issue and reopens it when the issue comes back', async () => {
    const { gitlabId, ingest } = await setup('inline/fix');
    await ingest([3, 4]);
    await runDecorations(h, decorationDeps(h));
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: false, 4: true });
    expect(threadAt(gitlabId, 4).notes[0]?.resolvedBy).toBe(fake.botUserId);
    expect(summary(gitlabId)).toContain('1 new issue is commented inline.');
    // Resolving again changes nothing; the issue coming back reopens its own thread.
    fake.clearRequests();
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    expect(fake.requests.filter((r) => r.path.includes('/discussions/'))).toHaveLength(0);
    await ingest([3, 4]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: false, 4: false });
    expect(threads(gitlabId)).toHaveLength(2);
  });

  it('never reopens a thread a person resolved, and still counts its issue (ruling G3)', async () => {
    const { gitlabId, ingest } = await setup('inline/human-resolved');
    await ingest([3, 4]);
    await runDecorations(h, decorationDeps(h));
    fake.resolveAs(gitlabId, 7, threadAt(gitlabId, 3).id, HUMAN, true);
    // The issue is still open: the reviewer's decision stands.
    fake.clearRequests();
    await ingest([3, 4]);
    await runDecorations(h, decorationDeps(h));
    expect(threadWrites()).toEqual([]);
    expect(resolvedByLine(gitlabId)).toEqual({ 3: true, 4: false });
    expect(threadAt(gitlabId, 3).notes[0]?.resolvedBy).toBe(HUMAN);
    expect(summary(gitlabId)).toContain('2 new issues are commented inline.');
    // Fixed, then back: a thread a person resolved is still never reopened, and never duplicated.
    await ingest([4]);
    await runDecorations(h, decorationDeps(h));
    await ingest([3, 4]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: true, 4: false });
    expect(threads(gitlabId)).toHaveLength(2);
  });

  it('leaves a person the thread of a fixed issue they reopened and replied to', async () => {
    const { gitlabId, ingest } = await setup('inline/human-reply');
    await ingest([3, 4]);
    await runDecorations(h, decorationDeps(h));
    await ingest([]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: true, 4: true });
    // Line 3: reopened without a word, so Qualor resolves it again (the issue is still fixed).
    fake.resolveAs(gitlabId, 7, threadAt(gitlabId, 3).id, HUMAN, false);
    // Line 4: reopened with a reply, so the conversation is the people's now.
    fake.resolveAs(gitlabId, 7, threadAt(gitlabId, 4).id, HUMAN, false);
    fake.reply(gitlabId, 7, threadAt(gitlabId, 4).id, {
      body: 'Not so fast: the fix moved it.',
      authorId: HUMAN,
    });
    await ingest([]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: true, 4: false });
    // A reply by Qualor's own user is not a person's.
    const own = await setup('inline/bot-reply');
    await own.ingest([3]);
    await runDecorations(h, decorationDeps(h));
    fake.reply(own.gitlabId, 7, threadAt(own.gitlabId, 3).id, {
      body: 'a note by the bot',
      authorId: fake.botUserId,
    });
    await own.ingest([]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(own.gitlabId)).toEqual({ 3: true });
  });

  it('leaves a person the thread they replied to after Qualor resolved it, when its issue returns', async () => {
    const { gitlabId, ingest } = await setup('inline/reply-to-resolved');
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    await ingest([]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: true });
    // GitLab creates a reply in a resolved thread resolved, by its author (seen on GitLab CE
    // 18.11.11): the thread stays resolved, and one of its notes is now resolved by a person.
    const reply = fake.reply(gitlabId, 7, threadAt(gitlabId, 3).id, {
      body: 'Agreed, fixed.',
      authorId: HUMAN,
    });
    expect(reply).toMatchObject({ resolvable: true, resolved: true, resolvedBy: HUMAN });
    // The issue comes back: the thread is not Qualor's alone any more, so it stays resolved (G3).
    fake.clearRequests();
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    expect(threadWrites()).toEqual([]);
    expect(resolvedByLine(gitlabId)).toEqual({ 3: true });
    expect(threads(gitlabId)).toHaveLength(1);
    expect(summary(gitlabId)).toContain('1 new issue is commented inline.');
  });

  it('reopens only a thread every resolvable note of which Qualor resolved', async () => {
    const { gitlabId, ingest } = await setup('inline/partly-human');
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    const thread = threadAt(gitlabId, 3);
    fake.reply(gitlabId, 7, thread.id, { body: 'looking', authorId: HUMAN });
    // Resolved note by note: Qualor's note by Qualor, the reply by a person.
    const [first, reply] = thread.notes;
    Object.assign(first!, { resolved: true, resolvedBy: fake.botUserId });
    Object.assign(reply!, { resolved: true, resolvedBy: HUMAN });
    fake.clearRequests();
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    expect(threadWrites()).toEqual([]);
    expect(resolvedByLine(gitlabId)).toEqual({ 3: true });
  });

  it(`resolves or reopens at most the bound of threads per job, the rest in later jobs`, async () => {
    const { gitlabId, ingest } = await setup('inline/update-cap');
    await ingest([3, 4, 5]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: false, 4: false, 5: false });
    const resolvedCount = () => threads(gitlabId).filter((d) => d.notes[0]?.resolved).length;
    const capped = decorationDeps(h, { maxThreadUpdates: 2 });
    fake.clearRequests();
    await ingest([]);
    await runDecorations(h, capped);
    expect(threadWrites()).toHaveLength(2);
    expect(resolvedCount()).toBe(2);
    await ingest([]);
    await runDecorations(h, capped);
    expect(resolvedCount()).toBe(3);
  });

  it('goes on when a thread was deleted meanwhile, and still writes the summary', async () => {
    const { gitlabId, ingest } = await setup('inline/deleted-thread');
    await ingest([3, 4]);
    await runDecorations(h, decorationDeps(h));
    expect(summary(gitlabId)).toContain('quality gate failed');
    const gone = threadAt(gitlabId, 3);
    fake.inject(
      'PUT',
      new RegExp(`^/projects/${gitlabId}/merge_requests/7/discussions/${gone.id}$`),
      { status: 404, body: { message: '404 Not found' } },
    );
    await ingest([]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(gitlabId)).toEqual({ 3: false, 4: true });
    expect(summary(gitlabId)).toContain('quality gate passed');
    // The job ended done: nothing is retried.
    expect(await queuedDecorations(h)).toEqual([]);
  });

  it('places an issue of a renamed file with its old path, and counts a rejected position', async () => {
    const { gitlabId, ingest } = await setup('inline/rename');
    fake.inject('POST', new RegExp(`^/projects/${gitlabId}/merge_requests/7/discussions$`), {
      status: 400,
      body: { message: '400 Bad request - Note {:line_code=>["can\'t be blank"]}' },
    });
    await ingest([3], {
      findings: [
        finding({ path: 'src/a.ts', line: 3 }),
        finding({ path: 'src/renamed.ts', line: 2 }),
      ],
    });
    await runDecorations(h, decorationDeps(h));
    const placed = threads(gitlabId);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.notes[0]?.position).toMatchObject({
      old_path: 'src/old.ts',
      new_path: 'src/renamed.ts',
      new_line: 2,
    });
    expect(summary(gitlabId)).toContain('1 new issue is commented inline; 1 could not be placed');
  });

  it('never comments inline for a merged-results pipeline, and leaves other people’s threads alone', async () => {
    const { gitlabId, ingest } = await setup('inline/merged');
    const human = fake.addNote(gitlabId, 7, {
      body: '<!-- qualor:issue 01920000-0000-7000-8000-000000000001 -->\nnot Qualor',
      authorId: HUMAN,
    });
    await ingest([3], { gitlab: { mergeRequestEventType: 'merged_result' } });
    await runDecorations(h, decorationDeps(h));
    expect(threads(gitlabId).map((d) => d.id)).toEqual([human.id]);
    expect(summary(gitlabId)).toContain('merged-results pipeline');
    expect(fake.requests.some((r) => r.method === 'PUT' && r.path.includes('/discussions/'))).toBe(
      false,
    );
  });

  it('says merged results, not "now at", when a merged-results pipeline is also stale', async () => {
    const { gitlabId, ingest } = await setup('inline/merged-stale');
    fake.updateMergeRequest(gitlabId, 7, { headSha: '2'.repeat(40) });
    await ingest([3], { gitlab: { mergeRequestEventType: 'merge_train' } });
    await runDecorations(h, decorationDeps(h));
    expect(threads(gitlabId)).toEqual([]);
    expect(summary(gitlabId)).toContain('merged-results pipeline');
    expect(summary(gitlabId)).not.toContain('now at');
    expect(summary(gitlabId)).not.toContain('wait for the analysis');
  });

  it('changes no thread while the merge request is ahead of the analysed revision', async () => {
    const { gitlabId, ingest } = await setup('inline/stale');
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    fake.updateMergeRequest(gitlabId, 7, { headSha: '3'.repeat(40) });
    fake.clearRequests();
    // Line 3 is fixed and line 4 new, but the line numbers are no longer the merge request's.
    await ingest([4]);
    await runDecorations(h, decorationDeps(h));
    expect(threadWrites()).toEqual([]);
    expect(resolvedByLine(gitlabId)).toEqual({ 3: false });
    expect(summary(gitlabId)).toContain(
      'wait for the analysis of the merge request’s latest commit',
    );
    expect(summary(gitlabId)).toContain('the merge request is now at ` 333333333333 `');
  });

  it('leaves the threads of another Qualor project on the same merge request alone', async () => {
    const a = await setup('inline/mono-a');
    const b = await setup('inline/mono-b', a.gitlabId);
    await a.ingest([3]);
    await b.ingest([4]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(a.gitlabId)).toEqual({ 3: false, 4: false });
    // B's issue is fixed: B resolves its own thread and not A's, whose issue B does not have.
    await b.ingest([]);
    await runDecorations(h, decorationDeps(h));
    expect(resolvedByLine(a.gitlabId)).toEqual({ 3: false, 4: true });
    expect(summary(a.gitlabId, a.project.id)).toContain('1 new issue is commented inline.');
    expect(summary(a.gitlabId, b.project.id)).not.toContain('commented inline');
  });

  it('creates no thread when the discussions run past the page bound (one may exist unseen)', async () => {
    const { gitlabId, ingest } = await setup('inline/paged');
    fake.inject(
      'GET',
      new RegExp(`^/projects/${gitlabId}/merge_requests/7/discussions$`),
      ...Array.from({ length: MAX_DISCUSSION_PAGES }, (_, i) => ({
        status: 200,
        body: [],
        headers: { 'x-next-page': String(i + 2) },
      })),
    );
    await ingest([3]);
    await runDecorations(h, decorationDeps(h));
    expect(fake.requests.filter((r) => r.path.endsWith('/discussions')).length).toBe(
      MAX_DISCUSSION_PAGES,
    );
    expect(fake.requests.some((r) => r.method === 'POST')).toBe(true); // the commit status
    expect(threadWrites()).toEqual([]);
    expect(threads(gitlabId)).toEqual([]);
  });

  it(`comments at most ${MAX_INLINE_THREADS} issues, the most severe first`, async () => {
    const { gitlabId, ingest } = await setup('inline/cap');
    fake.updateMergeRequest(gitlabId, 7, {
      diffs: [
        {
          oldPath: 'src/a.ts',
          newPath: 'src/a.ts',
          diff: `@@ -0,0 +1,60 @@\n${Array.from({ length: 60 }, (_, i) => `+l${i + 1}`).join('\n')}\n`,
        },
      ],
    });
    const lines = Array.from({ length: 60 }, (_, i) => i + 1);
    await ingest(lines, {
      findings: lines.map((line) =>
        finding({ path: 'src/a.ts', line, severity: line === 60 ? 'blocker' : 'low' }),
      ),
    });
    await runDecorations(h, decorationDeps(h));
    const placed = threads(gitlabId);
    expect(placed).toHaveLength(MAX_INLINE_THREADS);
    expect(placed.some((d) => d.notes[0]?.position?.['new_line'] === 60)).toBe(true);
    expect(summary(gitlabId)).toContain('50 new issues are commented inline.');
    expect(summary(gitlabId)).toContain('\n…and 50 more\n');
  });

  describe('the note of a fixed issue in a thread a person replied in', () => {
    const NEWER = '2'.repeat(40);
    /** The issue Qualor's thread on `line` is for: the marker of its first note. */
    const issueAt = (gitlabId: number, line: number): string => {
      const marker = markerOf(threadAt(gitlabId, line).notes[0]?.body ?? '');
      if (marker?.kind !== 'issue') throw new Error(`no issue thread on line ${line}`);
      return marker.issueId;
    };
    /** Qualor's notes in its thread on `line`, after the first. */
    const qualorNotes = (gitlabId: number, line: number) =>
      threadAt(gitlabId, line)
        .notes.slice(1)
        .filter((note) => note.authorId === fake.botUserId)
        .map((note) => note.body);
    /** The note, as it reads: its marker, then its sentence. */
    const fixedText = (issueId: string, sha: string) =>
      `<!-- qualor:fixed ${issueId} ${sha} -->\nFixed in \` ${sha.slice(0, 7)} \`. Qualor leaves this thread open because someone replied in it.`;
    const replyIn = (gitlabId: number, line: number) =>
      fake.reply(gitlabId, 7, threadAt(gitlabId, line).id, { body: 'Is it?', authorId: HUMAN });
    /** The notes the run posted into discussions. */
    const notePosts = () =>
      fake.requests.filter(
        (r) => r.method === 'POST' && /\/discussions\/[^/]+\/notes$/.test(r.path),
      );
    /** The project's merge request branch. */
    const branchOf = async (projectId: string) =>
      first(
        await h.ctx.db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.projectId, projectId), eq(branches.kind, 'merge_request'))),
      ).id;
    /** Another decoration of the analysis. */
    const redecorate = async (projectId: string, analysisId: string, deps = decorationDeps(h)) => {
      const branchId = await branchOf(projectId);
      await enqueueDecoration(h.ctx.db, { analysisId, branchId, gitlab: null });
      await runDecorations(h, deps);
    };

    it('writes one, with the revision, in the open thread of a fixed issue a person replied in; the next decoration none', async () => {
      const { project, gitlabId, ingest } = await setup('inline/fixed-note');
      await ingest([3, 4]);
      await runDecorations(h, decorationDeps(h));
      replyIn(gitlabId, 3);
      const issue = issueAt(gitlabId, 3);
      fake.clearRequests();
      const fixedAt = await ingest([]);
      await runDecorations(h, decorationDeps(h));
      // The person's thread stays open, with Qualor's one note in it; the other is resolved.
      expect(resolvedByLine(gitlabId)).toEqual({ 3: false, 4: true });
      expect(qualorNotes(gitlabId, 3)).toEqual([fixedText(issue, HEAD)]);
      expect(qualorNotes(gitlabId, 4)).toEqual([]);
      expect(notePosts()).toHaveLength(1);
      // Decorated again, and after another analysis at which the issue is still fixed: no second
      // note. Qualor's note is no person's reply, so the thread is still the person's.
      fake.clearRequests();
      await redecorate(project.id, fixedAt);
      await ingest([]);
      await runDecorations(h, decorationDeps(h));
      expect(notePosts()).toEqual([]);
      expect(qualorNotes(gitlabId, 3)).toEqual([fixedText(issue, HEAD)]);
      expect(resolvedByLine(gitlabId)).toEqual({ 3: false, 4: true });
    });

    it('writes a new one when the issue, back meanwhile, is fixed again at another revision', async () => {
      const { gitlabId, ingest } = await setup('inline/fixed-again');
      await ingest([3]);
      await runDecorations(h, decorationDeps(h));
      replyIn(gitlabId, 3);
      const issue = issueAt(gitlabId, 3);
      await ingest([]);
      await runDecorations(h, decorationDeps(h));
      // Back: its thread is open, with the note of its first fix.
      await ingest([3]);
      await runDecorations(h, decorationDeps(h));
      expect(resolvedByLine(gitlabId)).toEqual({ 3: false });
      expect(qualorNotes(gitlabId, 3)).toEqual([fixedText(issue, HEAD)]);
      // Fixed again in a newer commit: a note of its own.
      fake.updateMergeRequest(gitlabId, 7, { headSha: NEWER });
      await ingest([], {}, NEWER);
      await runDecorations(h, decorationDeps(h));
      expect(qualorNotes(gitlabId, 3)).toEqual([fixedText(issue, HEAD), fixedText(issue, NEWER)]);
      expect(resolvedByLine(gitlabId)).toEqual({ 3: false });
    });

    it('skips a thread GitLab no longer has when it writes its note, and goes on', async () => {
      const { gitlabId, ingest } = await setup('inline/fixed-gone');
      await ingest([3, 4]);
      await runDecorations(h, decorationDeps(h));
      for (const line of [3, 4]) replyIn(gitlabId, line);
      // The older thread is deleted while the job runs: GitLab answers its note with a 404.
      const [gone, kept] = threads(gitlabId);
      fake.inject(
        'POST',
        new RegExp(`^/projects/${gitlabId}/merge_requests/7/discussions/${gone!.id}/notes$`),
        { status: 404, body: { message: '404 Discussion Not Found' } },
      );
      fake.clearRequests();
      await ingest([]);
      await runDecorations(h, decorationDeps(h));
      // Its note was asked for, the other thread's is made after it, and the summary is written.
      const notes = (discussion: typeof gone) =>
        discussion!.notes.slice(1).filter((note) => note.authorId === fake.botUserId);
      expect(notePosts()).toHaveLength(2);
      expect(notes(gone)).toEqual([]);
      expect(notes(kept).map((note) => markerOf(note.body)?.kind)).toEqual(['fixed']);
      expect(summary(gitlabId)).toContain('quality gate passed');
      // The job ended done: nothing is retried.
      expect(await queuedDecorations(h)).toEqual([]);
    });

    it('writes none for an issue a person decided on, nor in a thread a person resolved', async () => {
      const { project, gitlabId, ingest } = await setup('inline/fixed-decided');
      const analysisId = await ingest([3, 4, 5]);
      await runDecorations(h, decorationDeps(h));
      for (const line of [3, 4, 5]) replyIn(gitlabId, line);
      // A person marks each in Qualor, which decorates the analysis again.
      for (const [line, status] of [
        [3, 'wont_fix'],
        [4, 'false_positive'],
        [5, 'resolved'],
      ] as const) {
        await h.ctx.db
          .update(issues)
          .set({ status })
          .where(eq(issues.id, issueAt(gitlabId, line)));
      }
      fake.clearRequests();
      await redecorate(project.id, analysisId);
      expect(notePosts()).toEqual([]);
      expect(resolvedByLine(gitlabId)).toEqual({ 3: false, 4: false, 5: false });

      // Fixed, in a thread that a person replied in and resolved.
      const resolved = await setup('inline/fixed-person-resolved');
      await resolved.ingest([3]);
      await runDecorations(h, decorationDeps(h));
      replyIn(resolved.gitlabId, 3);
      fake.resolveAs(resolved.gitlabId, 7, threadAt(resolved.gitlabId, 3).id, HUMAN, true);
      fake.clearRequests();
      await resolved.ingest([]);
      await runDecorations(h, decorationDeps(h));
      expect(notePosts()).toEqual([]);
      expect(qualorNotes(resolved.gitlabId, 3)).toEqual([]);
    });

    it(`writes at most ${MAX_FIXED_NOTES} in a decoration, the oldest threads first, and the rest in the next`, async () => {
      const { project, gitlabId, ingest } = await setup('inline/fixed-cap');
      fake.updateMergeRequest(gitlabId, 7, {
        diffs: [
          {
            oldPath: 'src/a.ts',
            newPath: 'src/a.ts',
            diff: `@@ -0,0 +1,30 @@\n${Array.from({ length: 30 }, (_, i) => `+l${i + 1}`).join('\n')}\n`,
          },
        ],
      });
      await ingest(Array.from({ length: MAX_FIXED_NOTES + 1 }, (_, i) => i + 1));
      await runDecorations(h, decorationDeps(h));
      // In the order GitLab lists them: the oldest first.
      const listed = threads(gitlabId);
      expect(listed).toHaveLength(MAX_FIXED_NOTES + 1);
      for (const discussion of listed) {
        fake.reply(gitlabId, 7, discussion.id, { body: 'Hmm.', authorId: HUMAN });
      }
      const noted = () =>
        threads(gitlabId).map((discussion) =>
          discussion.notes.some(
            (note) => note.authorId === fake.botUserId && markerOf(note.body)?.kind === 'fixed',
          ),
        );
      const fixedAt = await ingest([]);
      await runDecorations(h, decorationDeps(h));
      expect(noted()).toEqual([...Array<boolean>(MAX_FIXED_NOTES).fill(true), false]);
      // The next decoration writes the last one, and no second in the others.
      fake.clearRequests();
      await redecorate(project.id, fixedAt);
      expect(noted()).toEqual(Array<boolean>(MAX_FIXED_NOTES + 1).fill(true));
      expect(notePosts()).toHaveLength(1);
    });

    it('counts its notes toward the job’s request budget', async () => {
      // Twins: one decorated with room for all it does, which shows where its first note comes in
      // the job's requests; the other with room for that note and none after it.
      const twin = async (key: string) => {
        const s = await setup(key);
        await s.ingest([3, 4]);
        await runDecorations(h, decorationDeps(h));
        for (const line of [3, 4]) replyIn(s.gitlabId, line);
        await s.ingest([]);
        fake.clearRequests();
        return s;
      };
      const roomy = await twin('inline/fixed-budget-roomy');
      await runDecorations(h, decorationDeps(h));
      const firstNote = fake.requests.findIndex(
        (r) => r.method === 'POST' && /\/discussions\/[^/]+\/notes$/.test(r.path),
      );
      expect(notePosts()).toHaveLength(2);
      expect(qualorNotes(roomy.gitlabId, 3)).toHaveLength(1);
      const tight = await twin('inline/fixed-budget-tight');
      const deps = decorationDeps(h);
      const maxRequests = firstNote + 1;
      await runDecorations(h, {
        ...deps,
        scm: { ...deps.scm, clientOptions: { timeoutMs: 2_000, maxRequests } },
      });
      // The first note is the last request the job may make: the second is refused with the job.
      expect(notePosts()).toHaveLength(1);
      expect([...qualorNotes(tight.gitlabId, 3), ...qualorNotes(tight.gitlabId, 4)]).toHaveLength(
        1,
      );
      expect(
        h.ctx.logs.some(
          (line) =>
            line.includes('GitLab decoration stopped') &&
            line.includes(`More than ${maxRequests} GitLab requests in one job`),
        ),
      ).toBe(true);
    });
  });

  describe('answers to the people’s notes (6I-4)', () => {
    let llm: FakeLlm;
    const DAY = 86_400_000;
    const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

    const branchOf = async (projectId: string) =>
      first(
        await h.ctx.db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.projectId, projectId), eq(branches.kind, 'merge_request'))),
      ).id;
    /** The issue a thread of Qualor's is for: the marker of its first note. */
    const issueOf = (thread: ReturnType<typeof threads>[number]): string => {
      const marker = thread.notes[0] === undefined ? null : markerOf(thread.notes[0].body);
      if (marker?.kind !== 'issue') throw new Error(`thread ${thread.id} is not an issue's`);
      return marker.issueId;
    };
    /**
     * A merge request with findings on `lines`, its analysis ingested and decorated once, so the
     * threads are there. AI review is off until a test switches it on: the ingestion makes no
     * review run.
     */
    const started = async (key: string, lines: number[], shared?: number) => {
      const s = await setup(key, shared);
      const analysisId = await s.ingest(lines);
      await runDecorations(h, decorationDeps(h));
      return { ...s, analysisId, branchId: await branchOf(s.project.id) };
    };
    type Started = Awaited<ReturnType<typeof started>>;
    /** Another decoration of the merge request's analysis. */
    const decorate = async (
      s: Started,
      gitlab: Parameters<typeof enqueueDecoration>[1]['gitlab'] = null,
    ) => {
      await enqueueDecoration(h.ctx.db, { analysisId: s.analysisId, branchId: s.branchId, gitlab });
      await runDecorations(h, decorationDeps(h));
    };
    /** What a person says: a note by the person the tests call HUMAN. */
    const whoSaid = (body: string) => ({ body, authorId: HUMAN });
    /** The note made `days` days ago. */
    const backdated = <T extends { createdAt?: string }>(note: T, days: number): T =>
      Object.assign(note, { createdAt: daysAgo(days).toISOString() });
    const requestsOf = () =>
      fake.requests.map((r) => `${r.method} ${r.path}${r.query === '' ? '' : `?${r.query}`}`);
    /** The ledger's rows of the branch as [kind, note id], the oldest note first. */
    const queuedNotes = async (branchId: string) =>
      (await queuedAnswers(h.ctx.db, branchId)).rows.map((row) => [row.kind, row.noteId]);

    beforeAll(async () => {
      llm = await createFakeLlm();
    });
    afterAll(async () => {
      await llm.close();
    });
    // AI review is off for every other test of this file, and for the next of these.
    afterEach(() => reviewOff(h));

    it('a reply in an analyzer thread is queued too', async () => {
      const s = await started('replies/analyzer', [3, 4]);
      await reviewOn(h, llm);
      const thread = threadAt(s.gitlabId, 3);
      // Nobody has written in a thread yet: nothing is queued.
      await decorate(s);
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual({ rows: [], jobs: [] });

      // Two notes of a person are one round, keyed by the newest. Qualor's own note after them is
      // no reply.
      fake.reply(s.gitlabId, 7, thread.id, whoSaid('This is intended.'));
      const newest = fake.reply(s.gitlabId, 7, thread.id, whoSaid('It is a cache.'));
      fake.reply(s.gitlabId, 7, thread.id, {
        body: 'A note by the bot.',
        authorId: fake.botUserId,
      });
      await decorate(s);
      const queued = await queuedAnswers(h.ctx.db, s.branchId);
      expect(queued.rows).toMatchObject([
        {
          projectId: s.project.id,
          branchId: s.branchId,
          provider: 'gitlab',
          kind: 'reply',
          noteId: newest.id,
          threadId: thread.id,
          issueId: issueOf(thread),
          command: null,
          author: 'user5',
          status: 'queued',
        },
      ]);
      expect(queued.jobs).toEqual([answerJob(s.branchId, queued.rows[0]!.id)]);

      // Decorating again finds nothing new.
      await decorate(s);
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual(queued);
      // Another person writes in the thread, and a person in the other thread: a round each.
      const again = fake.reply(s.gitlabId, 7, thread.id, { body: 'Still intended.', authorId: 6 });
      const other = fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 4).id, whoSaid('And here?'));
      await decorate(s);
      const next = await queuedAnswers(h.ctx.db, s.branchId);
      expect(next.rows.map((row) => [row.noteId, row.author])).toEqual([
        [newest.id, 'user5'],
        [again.id, 'user6'],
        [other.id, 'user5'],
      ]);
      expect(next.jobs).toEqual(next.rows.map((row) => answerJob(s.branchId, row.id)));
    });

    it('nothing is queued when AI review is off for the project', async () => {
      const s = await started('replies/off', [3]);
      fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 3).id, whoSaid('This is intended.'));
      fake.addNote(s.gitlabId, 7, whoSaid('qualor review'));
      const nothing = { rows: [], jobs: [] };

      // AI review was never switched on.
      await decorate(s);
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual(nothing);
      // It is on for the organisation, which has not selected this project.
      await reviewOn(h, llm);
      await reviewScope(h, 'selected');
      await decorate(s);
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual(nothing);
      // The control: with the project in its scope, the same two notes are queued.
      await reviewScope(h, 'all');
      await decorate(s);
      expect((await queuedAnswers(h.ctx.db, s.branchId)).rows.map((row) => row.kind)).toEqual([
        'reply',
        'command',
      ]);
    });

    it('a command note is queued once', async () => {
      const s = await started('replies/command', [3]);
      await reviewOn(h, llm);
      const command = fake.addNote(s.gitlabId, 7, whoSaid('Qualor review'));
      // Notes that give no command: words before it, Qualor's own user, a longer word.
      fake.addNote(s.gitlabId, 7, whoSaid('please qualor review'));
      fake.addNote(s.gitlabId, 7, { body: 'qualor review', authorId: fake.botUserId });
      fake.addNote(s.gitlabId, 7, whoSaid('qualor reviewer'));
      await decorate(s);
      const queued = await queuedAnswers(h.ctx.db, s.branchId);
      expect(queued.rows).toMatchObject([
        {
          provider: 'gitlab',
          kind: 'command',
          command: 'review',
          // The answer goes into the discussion the note opened.
          noteId: command.notes[0]!.id,
          threadId: command.id,
          issueId: null,
          author: 'user5',
          status: 'queued',
        },
      ]);
      expect(queued.jobs).toEqual([answerJob(s.branchId, queued.rows[0]!.id)]);
      // The next decoration sees the same note and queues nothing.
      await decorate(s);
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual(queued);
      // A command written in a thread of Qualor's is a reply, never a command.
      const reply = fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 3).id, whoSaid('qualor stop'));
      await decorate(s);
      expect(await queuedNotes(s.branchId)).toEqual([
        ['command', command.notes[0]!.id],
        ['reply', reply.id],
      ]);
    });

    it('decoration makes no request it did not make before', async () => {
      const s = await started('replies/requests', [3, 4]);
      // Settled: another decoration of the same state writes nothing.
      await decorate(s);
      for (const line of [3, 4]) {
        fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, line).id, whoSaid('This is intended.'));
      }
      fake.addNote(s.gitlabId, 7, whoSaid('qualor review'));

      fake.clearRequests();
      await decorate(s);
      const before = requestsOf();
      expect(before.length).toBeGreaterThan(0);
      expect(before.filter((request) => !request.startsWith('GET '))).toEqual([]);
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual({ rows: [], jobs: [] });

      // The same decoration with AI review on queues the two replies and the command, and asks GitLab
      // for nothing more: the notes it answers are the listing it reads anyway.
      await reviewOn(h, llm);
      fake.clearRequests();
      await decorate(s);
      expect(requestsOf()).toEqual(before);
      expect((await queuedAnswers(h.ctx.db, s.branchId)).rows).toHaveLength(3);
    });

    it(`queues at most ${MAX_QUEUED_ROUNDS} rounds in a decoration, and the one left in the next`, async () => {
      const s = await setup('replies/cap');
      const lines = Array.from({ length: MAX_QUEUED_ROUNDS + 1 }, (_, i) => i + 1);
      const analysisId = await s.ingest(lines);
      const branchId = await branchOf(s.project.id);
      // A decoration comments fifty issues at most: the threads of all fifty-one are made by hand,
      // each with a reply of a person.
      const ids = await h.ctx.db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, s.project.id))
        .orderBy(issues.startLine);
      expect(ids).toHaveLength(MAX_QUEUED_ROUNDS + 1);
      const replies = ids.map(({ id }, i) => {
        const thread = fake.addNote(s.gitlabId, 7, {
          body: `${issueMarker(id)}\n**Medium** · finding ${i + 1}`,
          authorId: fake.botUserId,
        });
        return fake.reply(s.gitlabId, 7, thread.id, whoSaid(`Reply ${i + 1}`));
      });
      await reviewOn(h, llm);
      await runDecorations(h, decorationDeps(h));
      const first = await queuedAnswers(h.ctx.db, branchId);
      expect(first.rows.map((row) => row.noteId)).toEqual(
        replies.slice(0, MAX_QUEUED_ROUNDS).map((reply) => reply.id),
      );
      expect(first.jobs).toEqual(first.rows.map((row) => answerJob(branchId, row.id)));
      // The next decoration queues the reply the cap left, and no other.
      await decorate({ ...s, analysisId, branchId });
      const second = await queuedAnswers(h.ctx.db, branchId);
      expect(second.rows.map((row) => row.noteId)).toEqual(replies.map((reply) => reply.id));
      expect(second.rows.slice(0, MAX_QUEUED_ROUNDS)).toEqual(first.rows);
      expect(second.jobs).toEqual(second.rows.map((row) => answerJob(branchId, row.id)));
    });

    it('offers a reply skipped for the day’s budget again on a later day, once', async () => {
      const s = await started('replies/budget', [3]);
      await reviewOn(h, llm);
      fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 3).id, whoSaid('This is intended.'));
      await decorate(s);
      const [row] = (await queuedAnswers(h.ctx.db, s.branchId)).rows;
      expect(row).toMatchObject({ status: 'queued' });

      // The answer job ran: it skipped the reply for the budget, two days ago.
      await h.ctx.db
        .update(jobs)
        .set({ status: 'succeeded' })
        .where(eq(jobs.concurrencyKey, replyKey(s.branchId)));
      await endReply(h.ctx.db, row!.id, { status: 'skipped', reason: 'budget_spent' });
      await h.ctx.db
        .update(reviewReplies)
        .set({ finishedAt: daysAgo(2), startedAt: daysAgo(2) })
        .where(eq(reviewReplies.id, row!.id));
      await decorate(s);
      const queued = await queuedAnswers(h.ctx.db, s.branchId);
      expect(queued.rows).toMatchObject([
        {
          id: row!.id,
          status: 'queued',
          reason: null,
          outcome: null,
          startedAt: expect.any(Date) as Date,
          finishedAt: null,
        },
      ]);
      expect(queued.jobs).toEqual([
        { ...answerJob(s.branchId, row!.id), status: 'succeeded' },
        answerJob(s.branchId, row!.id),
      ]);
      // Once: the row is queued now, so another decoration offers nothing.
      await decorate(s);
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual(queued);
    });

    it('leaves a reply skipped for the budget alone once its row is older than a note may be', async () => {
      // The consent was given 60 days ago: a note counts for 30 days.
      const s = await started('replies/budget-window', [3]);
      await reviewOn(h, llm, daysAgo(60));
      fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 3).id, whoSaid('This is intended.'));
      await decorate(s);
      const [row] = (await queuedAnswers(h.ctx.db, s.branchId)).rows;
      // Its job skipped it for the budget two days ago, and the row was made 40 days ago.
      const finishedAt = daysAgo(2);
      await h.ctx.db
        .update(jobs)
        .set({ status: 'succeeded' })
        .where(eq(jobs.concurrencyKey, replyKey(s.branchId)));
      await endReply(h.ctx.db, row!.id, { status: 'skipped', reason: 'budget_spent' });
      await h.ctx.db
        .update(reviewReplies)
        .set({ createdAt: daysAgo(40), finishedAt })
        .where(eq(reviewReplies.id, row!.id));
      await decorate(s);
      // It stays as the skip left it, its end where housekeeping finds it; no job is queued.
      const aged = await queuedAnswers(h.ctx.db, s.branchId);
      expect(aged.rows).toMatchObject([
        { id: row!.id, status: 'skipped', reason: 'budget_spent', finishedAt },
      ]);
      expect(aged.jobs).toEqual([{ ...answerJob(s.branchId, row!.id), status: 'succeeded' }]);
      // The control: made 10 days ago, the row is inside the window and is queued again.
      await h.ctx.db
        .update(reviewReplies)
        .set({ createdAt: daysAgo(10) })
        .where(eq(reviewReplies.id, row!.id));
      await decorate(s);
      expect((await queuedAnswers(h.ctx.db, s.branchId)).rows).toMatchObject([
        { id: row!.id, status: 'queued', finishedAt: null },
      ]);
    });

    it('offers at most the room the caps leave, the oldest first, and the rest in a later decoration', async () => {
      const s = await started('replies/budget-caps', [3]);
      await reviewOn(h, llm);
      // Sixty replies that were skipped for the budget two days ago, each in a thread of its own
      // made newest first, the newer the note the smaller its thread's id: neither the order of the
      // rows nor the order of the threads is the order of the notes.
      const notes = Array.from({ length: MAX_QUEUED_ROUNDS + 10 }, (_, i) => 700_000 + i);
      const ids = await insertReplies(
        h.ctx.db,
        notes.toReversed().map((noteId) => ({
          projectId: s.project.id,
          branchId: s.branchId,
          provider: 'gitlab' as const,
          noteId,
          threadId: (0xfffff - noteId).toString(16).padStart(8, '0'),
          kind: 'reply' as const,
          author: 'jane',
        })),
      );
      await h.ctx.db
        .update(reviewReplies)
        .set({ status: 'skipped', reason: 'budget_spent', finishedAt: daysAgo(2) })
        .where(inArray(reviewReplies.id, ids));
      const state = async () => {
        const { rows, jobs: queued } = await queuedAnswers(h.ctx.db, s.branchId);
        return { statuses: rows.map((row) => [row.noteId, row.status]), jobs: queued.length };
      };

      // The fifty oldest notes are queued again, one job each; the ten newest wait.
      await decorate(s);
      expect(await state()).toEqual({
        statuses: notes.map((noteId, i) => [noteId, i < MAX_QUEUED_ROUNDS ? 'queued' : 'skipped']),
        jobs: MAX_QUEUED_ROUNDS,
      });
      // A later decoration queues the rest, and the first fifty are not offered a second time.
      await decorate(s);
      expect(await state()).toEqual({
        statuses: notes.map((noteId) => [noteId, 'queued']),
        jobs: MAX_QUEUED_ROUNDS + 10,
      });
    });

    it('ignores a note from before the consent, and one from more than 30 days ago', async () => {
      const noteAt = (s: Started, line: number, days: number) =>
        backdated(
          fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, line).id, whoSaid('Is it?')),
          days,
        );
      const commandAt = (s: Started, days: number) =>
        backdated(fake.addNote(s.gitlabId, 7, whoSaid('qualor review')).notes[0]!, days);

      // The consent was given 60 days ago: only the 30 days count.
      const old = await started('replies/old', [3, 4]);
      await reviewOn(h, llm, daysAgo(60));
      noteAt(old, 3, 40);
      commandAt(old, 40);
      const recent = noteAt(old, 4, 20);
      await decorate(old);
      expect(await queuedNotes(old.branchId)).toEqual([['reply', recent.id]]);

      // The consent was given 10 days ago: what was written before it is never answered.
      await reviewOff(h);
      const switched = await started('replies/switch-on', [3, 4]);
      await reviewOn(h, llm, daysAgo(10));
      noteAt(switched, 3, 20);
      commandAt(switched, 20);
      const after = noteAt(switched, 4, 5);
      await decorate(switched);
      expect(await queuedNotes(switched.branchId)).toEqual([['reply', after.id]]);
    });

    it('queues a reply for the project its thread’s issue belongs to, and for no other project of the merge request', async () => {
      const a = await started('replies/mono-a', [3]);
      const b = await started('replies/mono-b', [4], a.gitlabId);
      await reviewOn(h, llm);
      // Each project made a thread for its own issue, and a person replies in both.
      const forA = fake.reply(a.gitlabId, 7, threadAt(a.gitlabId, 3).id, whoSaid('A, please?'));
      const forB = fake.reply(a.gitlabId, 7, threadAt(a.gitlabId, 4).id, whoSaid('And B?'));
      await decorate(a);
      await decorate(b);
      expect(await queuedNotes(a.branchId)).toEqual([['reply', forA.id]]);
      expect(await queuedNotes(b.branchId)).toEqual([['reply', forB.id]]);
    });

    it('queues the replies and commands it saw when the discussions run past the page bound', async () => {
      // The first page of the cut listing shows Qualor's summary, or does not: with the summary out
      // of sight no second one is posted, and what was seen is queued all the same.
      for (const seesSummary of [true, false]) {
        const s = await started(`replies/cut-${seesSummary}`, [3, 4]);
        await reviewOn(h, llm);
        const reply = fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 3).id, whoSaid('Is it?'));
        const command = fake.addNote(s.gitlabId, 7, whoSaid('qualor review'));
        // The listing is cut: its first page is the discussions as GitLab has them, and every page
        // up to the bound has another after it.
        const listing = await fetch(
          `${fake.url}/api/v4/projects/${s.gitlabId}/merge_requests/7/discussions`,
          { headers: { 'PRIVATE-TOKEN': fake.token } },
        );
        const page = (await listing.json()) as { notes: { body: string }[] }[];
        fake.inject(
          'GET',
          new RegExp(`^/projects/${s.gitlabId}/merge_requests/7/discussions$`),
          {
            status: 200,
            body: seesSummary
              ? page
              : page.filter((d) => markerOf(d.notes[0]?.body ?? '')?.kind !== 'summary'),
            headers: { 'x-next-page': '2' },
          },
          ...Array.from({ length: MAX_DISCUSSION_PAGES - 1 }, (_, i) => ({
            status: 200,
            body: [],
            headers: { 'x-next-page': String(i + 3) },
          })),
        );
        fake.clearRequests();
        await decorate(s);
        expect(await queuedNotes(s.branchId), String(seesSummary)).toEqual([
          ['reply', reply.id],
          ['command', command.notes[0]!.id],
        ]);
        expect(
          fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/notes')),
          String(seesSummary),
        ).toEqual([]);
        await reviewOff(h);
      }
    });

    it('writes its threads and its summary before it queues, so a failed queue write does not cost them', async () => {
      const s = await started('replies/queue-fails', [3]);
      await reviewOn(h, llm);
      const reply = fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 3).id, whoSaid('Is it?'));
      // A new finding: the decoration has a thread to make and a summary to change, and a reply to
      // queue, whose job the database refuses.
      const allow = await refuseAnswerJobs(h.ctx.db, s.branchId);
      try {
        await s.ingest([3, 4]);
        await runDecorations(h, decorationDeps(h));
      } finally {
        await allow();
      }
      expect(threads(s.gitlabId)).toHaveLength(2);
      expect(summary(s.gitlabId)).toContain('2 new issues are commented inline.');
      expect(await queuedAnswers(h.ctx.db, s.branchId)).toEqual({ rows: [], jobs: [] });
      // The job is tried again, and queues the reply.
      await runDecorations(h, decorationDeps(h));
      expect(await queuedNotes(s.branchId)).toEqual([['reply', reply.id]]);
    });

    it('queues the notes of a merged-results pipeline too, whose analyzer threads are left alone', async () => {
      const s = await started('replies/merged-results', [3]);
      await reviewOn(h, llm);
      const reply = fake.reply(s.gitlabId, 7, threadAt(s.gitlabId, 3).id, whoSaid('Is it?'));
      const command = fake.addNote(s.gitlabId, 7, whoSaid('qualor review'));
      // The analyzers' threads follow the report's lines, which a merge commit's are not; the people's
      // notes do not follow lines.
      await decorate(s, { mergeRequestEventType: 'merged_result' });
      expect(summary(s.gitlabId)).toContain('merged-results pipeline');
      expect(await queuedNotes(s.branchId)).toEqual([
        ['reply', reply.id],
        ['command', command.notes[0]!.id],
      ]);
    });

    it(`queues ${MAX_QUEUED_COMMANDS} commands in a decoration, the next in the following one, and nothing after`, async () => {
      const s = await started('replies/commands-cap', [3]);
      await reviewOn(h, llm);
      const notes = Array.from(
        { length: MAX_QUEUED_COMMANDS + 1 },
        () => fake.addNote(s.gitlabId, 7, whoSaid('qualor review')).notes[0]!.id,
      );
      const state = async () => {
        const { rows, jobs: queued } = await queuedAnswers(h.ctx.db, s.branchId);
        return { notes: rows.map((row) => row.noteId), jobs: queued.length };
      };
      // Every decoration finds all 21 commands: the 20 the ledger holds take no place of the cap.
      await decorate(s);
      expect(await state()).toEqual({
        notes: notes.slice(0, MAX_QUEUED_COMMANDS),
        jobs: MAX_QUEUED_COMMANDS,
      });
      await decorate(s);
      expect(await state()).toEqual({ notes, jobs: MAX_QUEUED_COMMANDS + 1 });
      await decorate(s);
      expect(await state()).toEqual({ notes, jobs: MAX_QUEUED_COMMANDS + 1 });
    });

    it('offers a command skipped for the budget again on a later day, while 20 older commands are held', async () => {
      const s = await started('replies/command-budget', [3]);
      await reviewOn(h, llm);
      const notes = Array.from(
        { length: MAX_QUEUED_COMMANDS + 1 },
        () => fake.addNote(s.gitlabId, 7, whoSaid('qualor review')).notes[0]!.id,
      );
      await decorate(s);
      await decorate(s);
      const { rows } = await queuedAnswers(h.ctx.db, s.branchId);
      expect(rows.map((row) => row.noteId)).toEqual(notes);
      const newest = rows.at(-1)!;

      // The answer jobs ran, the newest skipped for the budget two days ago.
      await h.ctx.db
        .update(jobs)
        .set({ status: 'succeeded' })
        .where(eq(jobs.concurrencyKey, replyKey(s.branchId)));
      await endReply(h.ctx.db, newest.id, { status: 'skipped', reason: 'budget_spent' });
      await h.ctx.db
        .update(reviewReplies)
        .set({ finishedAt: daysAgo(2) })
        .where(eq(reviewReplies.id, newest.id));
      await decorate(s);
      const queued = await queuedAnswers(h.ctx.db, s.branchId);
      // The twenty held commands are as they were, and the skipped one is queued again with a job.
      expect(queued.rows.map((row) => [row.noteId, row.status])).toEqual(
        notes.map((note) => [note, 'queued']),
      );
      expect(queued.rows.at(-1)).toMatchObject({ id: newest.id, reason: null, finishedAt: null });
      expect(queued.jobs.filter((job) => job.status === 'queued')).toEqual([
        answerJob(s.branchId, newest.id),
      ]);
    });

    it('two projects of one merge request queue each its own row for one command, once', async () => {
      const a = await started('replies/mono-command-a', [3]);
      const b = await started('replies/mono-command-b', [4], a.gitlabId);
      await reviewOn(h, llm);
      const command = fake.addNote(a.gitlabId, 7, whoSaid('qualor review'));
      await decorate(a);
      await decorate(b);
      for (const project of [a, b]) {
        expect(await queuedNotes(project.branchId)).toEqual([['command', command.notes[0]!.id]]);
      }
      // Decorating again queues nothing more, for either project.
      await decorate(a);
      await decorate(b);
      for (const project of [a, b]) {
        const queued = await queuedAnswers(h.ctx.db, project.branchId);
        expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(project.branchId, row.id)));
        expect(queued.rows).toHaveLength(1);
      }
    });
  });
});
