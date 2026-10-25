import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, waitForLockWaiters } from '../../test/db';
import { answerJob, queuedAnswers, refuseAnswerJobs, scanJob } from '../../test/replies';
import { seedAiIssue } from '../../test/review';
import { uuidv7 } from '../db/ids';
import { first } from '../db/rows';
import {
  branches,
  jobs,
  organizations,
  projects,
  reviewReplies,
  type ReplyKind,
} from '../db/schema';
import type { GitHubComment } from '../scm/github/client';
import type { GitLabDiscussion } from '../scm/gitlab/client';
import { issueMarker } from '../scm/markdown';
import {
  claimReply,
  endReply,
  insertReplies,
  type NewReply,
  type ReplyEnd,
  type ReplyRow,
} from './replies';
import type { CommandNote, Round } from './reply-detect';
import {
  AI_REPLY_MAX_ATTEMPTS,
  AI_REPLY_QUEUE,
  MAX_QUEUED_COMMANDS,
  MAX_QUEUED_ROUNDS,
  queueGitHubAnswers,
  queueGitLabAnswers,
  queueReplies,
  queueScan,
  queueScanAfterCircuit,
  repliesSince,
  replyKey,
  replyPayload,
  utcDayStart,
  type ReplyContext,
} from './reply-queue';

const THREAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_THREAD = '0123456789abcdef0123456789abcdef01234567';
/** The moment of the passes below, unless a test says another: the day began at midnight. */
const NOW = new Date('2026-10-24T10:00:00.000Z');
/** A window that reaches back to the beginning: no row is too old for it. */
const EVER = { since: new Date(0) };

describe('the queue of the answers (6I-4)', () => {
  let t: TestDatabase;
  let projectId: string;
  let otherProjectId: string;
  /** A branch to seed the issues on, and the rows the helpers make by default. */
  let seedBranchId: string;
  /** An issue of the project, and one of another project. */
  let issueId: string;
  let otherIssueId: string;
  let noteSequence = 1_000;

  const newBranch = async (name: string, project = projectId) =>
    first(
      await t.db
        .insert(branches)
        .values({ projectId: project, kind: 'merge_request', name })
        .returning(),
    ).id;
  const contextOf = (
    branch: string,
    provider: ReplyContext['provider'] = 'gitlab',
  ): ReplyContext => ({ projectId, branchId: branch, provider });
  /** The round of a thread whose newest note is `newest`, for an issue of the project. */
  const round = (newest: number, over: Partial<Round> = {}): Round => ({
    threadId: THREAD,
    issueId,
    noteIds: [newest],
    newest,
    author: 'jane',
    ...over,
  });
  const command = (noteId: number, over: Partial<CommandNote> = {}): CommandNote => ({
    noteId,
    threadId: THREAD,
    command: 'review',
    author: 'jane',
    ...over,
  });
  /** A row of the ledger as the answer job finds it, with a note of its own unless `over` says otherwise. */
  const reply = (over: Partial<NewReply> = {}): NewReply => {
    noteSequence += 1;
    return {
      projectId,
      branchId: seedBranchId,
      provider: 'gitlab',
      noteId: noteSequence,
      threadId: THREAD,
      kind: 'reply',
      author: 'jane',
      ...over,
    };
  };
  const stored = async (id: string): Promise<ReplyRow> =>
    first(await t.db.select().from(reviewReplies).where(eq(reviewReplies.id, id)));
  /**
   * One pass of the queue on `branch`: what detection `found`, at `NOW` and in a window with no
   * limit, unless `over` says otherwise. Answers how many jobs it queued.
   */
  const pass = (
    branch: string,
    found: { rounds?: Round[]; commands?: CommandNote[] } = {},
    over: { window?: { since: Date }; now?: Date; provider?: ReplyContext['provider'] } = {},
  ) =>
    queueReplies(
      t.db,
      contextOf(branch, over.provider),
      over.window ?? EVER,
      { rounds: found.rounds ?? [], commands: found.commands ?? [] },
      over.now ?? NOW,
    );
  /**
   * A row the answer job skipped for the day's budget (or ended as `end` says), at `finishedAt`,
   * in a thread of its own unless `threadId` says another.
   */
  const skippedForBudget = async (
    branch: string,
    noteId: number,
    finishedAt: Date,
    over: { end?: ReplyEnd; threadId?: string } = {},
  ): Promise<string> => {
    const { end = { status: 'skipped', reason: 'budget_spent' }, threadId = noteId.toString(16) } =
      over;
    const [id] = await insertReplies(t.db, [reply({ branchId: branch, noteId, threadId })]);
    await claimReply(t.db, id!);
    await endReply(t.db, id!, end);
    await t.db
      .update(reviewReplies)
      .set({ finishedAt, startedAt: new Date(finishedAt.getTime() - 60_000) })
      .where(eq(reviewReplies.id, id!));
    return id!;
  };
  /**
   * Rows of `kind` for `notes`, made in that order, that the answer job skipped for the day's
   * budget at `finishedAt`: answers their ids in the same order. Each is in a thread of its own,
   * whose id is the smaller the newer the note: the order of the threads is not the order of the
   * notes either.
   */
  const manySkipped = async (
    branch: string,
    kind: ReplyKind,
    notes: readonly number[],
    finishedAt: Date,
  ): Promise<string[]> => {
    const ids = await insertReplies(
      t.db,
      notes.map((noteId) =>
        reply({
          branchId: branch,
          noteId,
          kind,
          threadId: (0xfffff - noteId).toString(16).padStart(8, '0'),
          ...(kind === 'command' ? { command: 'review' as const } : {}),
        }),
      ),
    );
    await t.db
      .update(reviewReplies)
      .set({ status: 'skipped', reason: 'budget_spent', finishedAt })
      .where(inArray(reviewReplies.id, ids));
    return ids;
  };
  /** The notes of the branch's rows of this kind that have this status, the oldest first. */
  const notesWhere = async (branch: string, kind: ReplyKind, status: ReplyRow['status']) =>
    (await queuedAnswers(t.db, branch)).rows
      .filter((row) => row.kind === kind && row.status === status)
      .map((row) => row.noteId);

  beforeAll(async () => {
    t = await createTestDatabase();
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'queue', name: 'Queue' }).returning(),
    ).id;
    const projectOf = async (key: string) =>
      first(
        await t.db
          .insert(projects)
          .values({ organizationId, key: `queue/${key}`, name: key })
          .returning(),
      ).id;
    projectId = await projectOf('api');
    otherProjectId = await projectOf('web');
    seedBranchId = await newBranch('seed');
    const seed = { category: 'logic', path: 'src/a.ts', line: 3 } as const;
    issueId = await seedAiIssue(t.db, { ...seed, branchId: seedBranchId });
    otherIssueId = await seedAiIssue(t.db, {
      ...seed,
      branchId: await newBranch('seed-web', otherProjectId),
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('names its queue, its key and its payloads', () => {
    expect(AI_REPLY_QUEUE).toBe('ai-reply');
    expect(AI_REPLY_MAX_ATTEMPTS).toBe(2);
    const id = uuidv7();
    expect(replyKey(id)).toBe(`ai-reply:branch:${id}`);
    expect(replyPayload.parse({ kind: 'answer', replyId: id })).toEqual({
      kind: 'answer',
      replyId: id,
    });
    expect(replyPayload.parse({ kind: 'scan', branchId: id })).toEqual({
      kind: 'scan',
      branchId: id,
    });
    const refused = [
      { kind: 'answer' },
      { kind: 'answer', replyId: 'not-a-uuid' },
      { kind: 'scan', replyId: id },
      { kind: 'other', branchId: id },
      { replyId: id },
      null,
    ];
    for (const payload of refused) {
      expect(replyPayload.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });

  it('queues a row and one answer job for each new round, and none for a round it holds', async () => {
    const branch = await newBranch('queue-rounds');
    const rounds = [
      // Two notes of one thread are one round: the newest note's row.
      round(10_021, { noteIds: [10_011, 10_021], author: 'jane' }),
      round(10_030, { threadId: OTHER_THREAD, author: 'omar' }),
    ];
    expect(await pass(branch, { rounds })).toBe(2);
    const queued = await queuedAnswers(t.db, branch);
    expect(queued.rows).toMatchObject([
      {
        projectId,
        branchId: branch,
        provider: 'gitlab',
        kind: 'reply',
        noteId: 10_021,
        threadId: THREAD,
        issueId,
        command: null,
        author: 'jane',
        status: 'queued',
      },
      { noteId: 10_030, threadId: OTHER_THREAD, issueId, author: 'omar', status: 'queued' },
    ]);
    expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(branch, row.id)));

    // The same rounds again: the ledger holds them, so no row and no job is made.
    expect(await pass(branch, { rounds })).toBe(0);
    expect(await queuedAnswers(t.db, branch)).toEqual(queued);
    // A newer round of a thread it holds is new.
    expect(await pass(branch, { rounds: [round(10_040)] })).toBe(1);
    expect((await queuedAnswers(t.db, branch)).jobs).toHaveLength(3);
  });

  it('queues the rounds of a GitHub pull request by the id of the first comment of each thread', async () => {
    const branch = await newBranch('queue-github-rounds');
    const github = round(3_000_000_010, { threadId: '3000000001', author: 'octocat' });
    expect(await pass(branch, { rounds: [github] }, { provider: 'github' })).toBe(1);
    expect((await queuedAnswers(t.db, branch)).rows).toMatchObject([
      { provider: 'github', kind: 'reply', noteId: 3_000_000_010, threadId: '3000000001' },
    ]);
    // Rows of GitHub and of GitLab are apart: the same number on the other provider is another note.
    const gitlab = await newBranch('queue-gitlab-rounds');
    expect(await pass(gitlab, { rounds: [round(3_000_000_010)] })).toBe(1);
  });

  it(`queues at most ${MAX_QUEUED_ROUNDS} rounds, the oldest note first, and the next ones in the next pass`, async () => {
    expect(MAX_QUEUED_ROUNDS).toBe(50);
    const branch = await newBranch('rounds-cap');
    const notes = Array.from({ length: MAX_QUEUED_ROUNDS + 1 }, (_, i) => 20_000 + i);
    // Handed over newest first: the cap and the order are the queue's, not the caller's.
    const rounds = notes.map((note) => round(note, { threadId: `a${note}` })).reverse();
    expect(await pass(branch, { rounds })).toBe(MAX_QUEUED_ROUNDS);
    const queued = await queuedAnswers(t.db, branch);
    expect(queued.rows.map((row) => row.noteId)).toEqual(notes.slice(0, MAX_QUEUED_ROUNDS));
    // The jobs are in the order of the notes: the oldest reply is answered first.
    expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(branch, row.id)));
    // The same rounds again: the fifty are held and take no place of the cap, so the one it left is
    // queued now, and then there is nothing.
    expect(await pass(branch, { rounds })).toBe(1);
    expect(await pass(branch, { rounds })).toBe(0);
    expect((await queuedAnswers(t.db, branch)).rows).toHaveLength(MAX_QUEUED_ROUNDS + 1);
  });

  it('leaves out a round whose thread the ledger cannot hold, and cuts a long author name', async () => {
    const branch = await newBranch('rounds-unfit');
    const rounds = [
      // A thread id is a GitLab discussion's lower-case hexadecimal id or a GitHub comment's digits.
      round(30_001, { threadId: 'not-a-thread' }),
      round(30_002, { threadId: 'ABCDEF' }),
      round(30_003, { threadId: 'a'.repeat(65) }),
      round(30_004, { threadId: '' }),
      round(30_005, { author: 'x'.repeat(300) }),
    ];
    expect(await pass(branch, { rounds })).toBe(1);
    const { rows } = await queuedAnswers(t.db, branch);
    expect(rows.map((row) => row.noteId)).toEqual([30_005]);
    expect(rows[0]?.author).toBe('x'.repeat(255));
    // The cap counts the rounds that fit: those it left out take none of its places.
    const many = Array.from({ length: MAX_QUEUED_ROUNDS }, (_, i) => round(31_000 + i));
    const unfit = Array.from({ length: 5 }, (_, i) => round(30_900 + i, { threadId: 'no' }));
    expect(await pass(branch, { rounds: [...unfit, ...many] })).toBe(MAX_QUEUED_ROUNDS);
  });

  it('queues no round for an issue the project does not have, and such a round takes no place of the cap', async () => {
    const branch = await newBranch('rounds-foreign');
    const rounds = [
      round(11_001),
      // A thread of another Qualor project's issue (a monorepo), and of an issue that is gone.
      round(11_002, { threadId: OTHER_THREAD, issueId: otherIssueId }),
      round(11_003, { threadId: 'b003', issueId: uuidv7() }),
    ];
    expect(await pass(branch, { rounds })).toBe(1);
    expect((await queuedAnswers(t.db, branch)).rows.map((row) => row.noteId)).toEqual([11_001]);
    // Fifty of its own after ten that are not: the ten take no place.
    const foreign = Array.from({ length: 10 }, (_, i) =>
      round(12_000 + i, { threadId: `f${i}`, issueId: otherIssueId }),
    );
    const own = Array.from({ length: MAX_QUEUED_ROUNDS }, (_, i) => round(12_100 + i));
    expect(await pass(branch, { rounds: [...foreign, ...own] })).toBe(MAX_QUEUED_ROUNDS);
  });

  it('queues a row and one answer job for each new command, with the discussion it was written in', async () => {
    const gitlab = await newBranch('queue-gitlab-commands');
    const asked = [
      command(50_001, { command: 'review', author: 'jane' }),
      command(50_002, { threadId: OTHER_THREAD, command: 'stop', author: 'omar' }),
    ];
    expect(await pass(gitlab, { commands: asked })).toBe(2);
    const queued = await queuedAnswers(t.db, gitlab);
    expect(queued.rows).toMatchObject([
      {
        provider: 'gitlab',
        kind: 'command',
        command: 'review',
        noteId: 50_001,
        threadId: THREAD,
        issueId: null,
        author: 'jane',
        status: 'queued',
      },
      { kind: 'command', command: 'stop', noteId: 50_002, threadId: OTHER_THREAD, author: 'omar' },
    ]);
    expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(gitlab, row.id)));
    // Again: nothing new.
    expect(await pass(gitlab, { commands: asked })).toBe(0);
    expect(await queuedAnswers(t.db, gitlab)).toEqual(queued);

    // A comment on a GitHub pull request's page is in no thread, and the id of a command and of a
    // reply of that number are two notes.
    const github = await newBranch('queue-github-commands');
    const page = command(50_003, { threadId: null, command: 'fix', author: 'octocat' });
    expect(await pass(github, { commands: [page] }, { provider: 'github' })).toBe(1);
    expect((await queuedAnswers(t.db, github)).rows).toMatchObject([
      { provider: 'github', kind: 'command', command: 'fix', noteId: 50_003, threadId: null },
    ]);
    const asReply = round(50_003, { threadId: '50000' });
    expect(await pass(github, { rounds: [asReply] }, { provider: 'github' })).toBe(1);
  });

  it(`queues at most ${MAX_QUEUED_COMMANDS} commands, counting only the commands the ledger does not hold`, async () => {
    expect(MAX_QUEUED_COMMANDS).toBe(20);
    const branch = await newBranch('commands-cap');
    const notes = Array.from({ length: MAX_QUEUED_COMMANDS + 1 }, (_, i) => 60_000 + i);
    // Detection hands over every command in the window each time, the held ones too.
    const asked = notes.map((note) => command(note)).reverse();
    expect(await pass(branch, { commands: asked })).toBe(MAX_QUEUED_COMMANDS);
    const queued = await queuedAnswers(t.db, branch);
    expect(queued.rows.map((row) => row.noteId)).toEqual(notes.slice(0, MAX_QUEUED_COMMANDS));
    expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(branch, row.id)));
    // The next pass: the twenty are held and take no place of the cap, so the 21st is queued now,
    // and the one after has nothing to queue.
    expect(await pass(branch, { commands: asked })).toBe(1);
    expect(await notesWhere(branch, 'command', 'queued')).toEqual(notes);
    expect(await pass(branch, { commands: asked })).toBe(0);
    expect((await queuedAnswers(t.db, branch)).jobs).toHaveLength(MAX_QUEUED_COMMANDS + 1);
  });

  it('queues each note once when two passes find the same notes at the same time', async () => {
    const branch = await newBranch('queue-race');
    const notes = Array.from({ length: 30 }, (_, i) => 96_000 + i);
    const rounds = notes.map((note) => round(note, { threadId: `b${note}` }));
    const asked = notes.slice(0, 10).map((note) => command(note + 1_000));
    // A decoration and a webhook's scan, the second with the notes the other way round.
    const both = await Promise.all([
      pass(branch, { rounds, commands: asked }),
      pass(branch, { rounds: rounds.toReversed(), commands: asked.toReversed() }),
    ]);
    expect(both[0]! + both[1]!).toBe(40);
    const queued = await queuedAnswers(t.db, branch);
    expect(queued.rows).toHaveLength(40);
    // One job for each row, and none twice.
    expect(queued.jobs).toHaveLength(40);
    expect(new Set(queued.jobs.map((job) => JSON.stringify(job.payload))).size).toBe(40);
    expect(queued.jobs.map((job) => (job.payload as { replyId: string }).replyId).sort()).toEqual(
      queued.rows.map((row) => row.id).sort(),
    );
  });

  it('queues the replies skipped for the day’s budget again once their day is over', async () => {
    const branch = await newBranch('requeue');
    const day = new Date('2026-10-20T12:00:00.000Z');
    const yesterday = await skippedForBudget(branch, 80_001, new Date('2026-10-19T23:59:59.999Z'));
    // The newer note's row is made first, in the thread that comes first: neither the order the
    // rows were made in nor the order of their threads is the order of the notes.
    const today = await skippedForBudget(branch, 80_003, new Date('2026-10-20T12:00:00.000Z'), {
      threadId: 'aaaa',
    });
    const startOfDay = await skippedForBudget(
      branch,
      80_002,
      new Date('2026-10-20T00:00:00.000Z'),
      {
        threadId: 'bbbb',
      },
    );
    // What no new day gives another try: another reason to skip, a failure, an answered note,
    // and a skip of another merge request.
    const earlier = new Date('2026-10-19T10:00:00.000Z');
    const inactive = await skippedForBudget(branch, 80_004, earlier, {
      end: { status: 'skipped', reason: 'inactive' },
    });
    const failed = await skippedForBudget(branch, 80_005, earlier, {
      end: { status: 'failed', reason: 'provider_error' },
    });
    const answered = await skippedForBudget(branch, 80_006, earlier, {
      end: { status: 'done', outcome: 'answered' },
    });
    const elsewhere = await skippedForBudget(await newBranch('requeue-elsewhere'), 80_007, earlier);
    const ids = [yesterday, startOfDay, today, inactive, failed, answered, elsewhere];
    const before = await Promise.all(ids.map(stored));

    // Only a skip that ended before the day began: the row is queued again, with nothing else changed.
    expect(await pass(branch, {}, { now: day })).toBe(1);
    const after = await Promise.all(ids.map(stored));
    expect(after[0]).toEqual({
      ...before[0],
      status: 'queued',
      outcome: null,
      reason: null,
      finishedAt: null,
    });
    expect(after[0]?.startedAt).toEqual(before[0]?.startedAt);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect((await queuedAnswers(t.db, branch)).jobs).toEqual([answerJob(branch, yesterday)]);
    // Once: the row is queued now, and a second look finds nothing to offer.
    expect(await pass(branch, {}, { now: day })).toBe(0);
    // It is a queued row like any other: the job takes it.
    expect(await claimReply(t.db, yesterday)).toMatchObject({ id: yesterday, status: 'running' });

    // The next day's start is past the others' skips: they are offered, the oldest note first. A
    // moment of that day in another time zone is the same UTC day.
    const next = new Date('2026-10-21T02:30:00.000+03:00');
    expect(await pass(branch, {}, { now: next })).toBe(0);
    const later = new Date('2026-10-21T10:00:00.000+03:00');
    expect(await pass(branch, {}, { now: later })).toBe(2);
    const jobs = (await queuedAnswers(t.db, branch)).jobs;
    expect(jobs.slice(1)).toEqual([startOfDay, today].map((id) => answerJob(branch, id)));
  });

  it('leaves a skip alone whose row is older than the window, so that it ages out', async () => {
    const branch = await newBranch('requeue-window');
    const skippedAt = new Date('2026-10-23T09:00:00.000Z');
    const since = new Date('2026-09-25T12:00:00.000Z');
    const made = async (noteId: number, at: string) => {
      const id = await skippedForBudget(branch, noteId, skippedAt);
      await t.db
        .update(reviewReplies)
        .set({ createdAt: new Date(at) })
        .where(eq(reviewReplies.id, id));
      return id;
    };
    // A row made a millisecond before the window, one made at its first moment, one well inside.
    const aged = await made(81_001, '2026-09-25T11:59:59.999Z');
    const edge = await made(81_002, since.toISOString());
    const inside = await made(81_003, '2026-10-10T00:00:00.000Z');
    const before = await stored(aged);
    expect(before).toMatchObject({
      status: 'skipped',
      reason: 'budget_spent',
      finishedAt: skippedAt,
    });

    expect(await pass(branch, {}, { window: { since } })).toBe(2);
    expect(await notesWhere(branch, 'reply', 'queued')).toEqual([81_002, 81_003]);
    expect((await stored(edge)).status).toBe('queued');
    expect((await stored(inside)).status).toBe('queued');
    // The aged row is as its skip left it, its end where housekeeping finds it, however often it
    // is looked at.
    expect(await stored(aged)).toEqual(before);
    expect(await pass(branch, {}, { window: { since } })).toBe(0);
    expect(await stored(aged)).toEqual(before);
  });

  it('queues skipped replies again in the room the caps have left, the oldest note first, and the rest in a later pass', async () => {
    const branch = await newBranch('requeue-room');
    const skippedAt = new Date('2026-10-23T09:00:00.000Z');
    const replyNotes = Array.from({ length: 60 }, (_, i) => 82_000 + i);
    const commandNotes = Array.from({ length: 25 }, (_, i) => 82_500 + i);
    // Made newest first: the order of the rows is not the order of the notes.
    await manySkipped(branch, 'reply', replyNotes.toReversed(), skippedAt);
    await manySkipped(branch, 'command', commandNotes.toReversed(), skippedAt);

    // Fifty replies and twenty commands, the oldest of each; the rest wait.
    expect(await pass(branch)).toBe(MAX_QUEUED_ROUNDS + MAX_QUEUED_COMMANDS);
    expect(await notesWhere(branch, 'reply', 'queued')).toEqual(
      replyNotes.slice(0, MAX_QUEUED_ROUNDS),
    );
    expect(await notesWhere(branch, 'command', 'queued')).toEqual(
      commandNotes.slice(0, MAX_QUEUED_COMMANDS),
    );
    expect(await notesWhere(branch, 'reply', 'skipped')).toEqual(
      replyNotes.slice(MAX_QUEUED_ROUNDS),
    );
    expect(await notesWhere(branch, 'command', 'skipped')).toEqual(
      commandNotes.slice(MAX_QUEUED_COMMANDS),
    );
    // A later pass takes what is left of both, and the next finds nothing.
    expect(await pass(branch)).toBe(10 + 5);
    expect(await notesWhere(branch, 'reply', 'skipped')).toEqual([]);
    expect(await notesWhere(branch, 'command', 'skipped')).toEqual([]);
    expect(await pass(branch)).toBe(0);
    // One job each, in the order the rows were queued again.
    expect((await queuedAnswers(t.db, branch)).jobs).toHaveLength(60 + 25);
  });

  it('counts the new notes against the caps first, and queues skipped replies again in what they leave', async () => {
    const branch = await newBranch('queue-replies-caps');
    const skippedAt = new Date('2026-10-23T09:00:00.000Z');
    const replyNotes = Array.from({ length: 60 }, (_, i) => 83_000 + i);
    const commandNotes = Array.from({ length: 25 }, (_, i) => 83_500 + i);
    const skippedReplies = await manySkipped(branch, 'reply', replyNotes, skippedAt);
    await manySkipped(branch, 'command', commandNotes, skippedAt);

    // Three new rounds and two new commands take their places in the caps first: the oldest of
    // the skipped replies and commands share what is left, and the others wait.
    const rounds = [84_001, 84_002, 84_003].map((note) =>
      round(note, { threadId: note.toString(16) }),
    );
    const asked = [84_501, 84_502].map((note) => command(note));
    expect(await pass(branch, { rounds, commands: asked })).toBe(
      MAX_QUEUED_ROUNDS + MAX_QUEUED_COMMANDS,
    );
    expect(await notesWhere(branch, 'reply', 'queued')).toEqual([
      ...replyNotes.slice(0, MAX_QUEUED_ROUNDS - 3),
      84_001,
      84_002,
      84_003,
    ]);
    expect(await notesWhere(branch, 'command', 'queued')).toEqual([
      ...commandNotes.slice(0, MAX_QUEUED_COMMANDS - 2),
      84_501,
      84_502,
    ]);
    // One job for each of them, the skipped replies' first and the oldest of those first.
    const { jobs: queued } = await queuedAnswers(t.db, branch);
    expect(queued).toHaveLength(MAX_QUEUED_ROUNDS + MAX_QUEUED_COMMANDS);
    expect(queued[0]).toEqual(answerJob(branch, skippedReplies[0]!));

    // A pass that finds as many new notes as the caps take queues no skipped reply at all.
    const full = {
      rounds: Array.from({ length: MAX_QUEUED_ROUNDS }, (_, i) =>
        round(85_000 + i, { threadId: (85_000 + i).toString(16) }),
      ),
      commands: Array.from({ length: MAX_QUEUED_COMMANDS }, (_, i) => command(85_500 + i)),
    };
    expect(await pass(branch, full)).toBe(MAX_QUEUED_ROUNDS + MAX_QUEUED_COMMANDS);
    expect(await notesWhere(branch, 'reply', 'skipped')).toEqual(
      replyNotes.slice(MAX_QUEUED_ROUNDS - 3),
    );
    expect(await notesWhere(branch, 'command', 'skipped')).toEqual(
      commandNotes.slice(MAX_QUEUED_COMMANDS - 2),
    );
  });

  it('queues again only the newest row of a thread: its round reads the older notes too', async () => {
    const branch = await newBranch('requeue-newest');
    const skippedAt = new Date('2026-10-23T09:00:00.000Z');
    // A skip, and a newer round of its thread that was answered, is still waiting, or was skipped too.
    const answeredAfter = await skippedForBudget(branch, 13_001, skippedAt, { threadId: 'a001' });
    await skippedForBudget(branch, 13_005, skippedAt, {
      threadId: 'a001',
      end: { status: 'done', outcome: 'answered' },
    });
    const waitingAfter = await skippedForBudget(branch, 13_011, skippedAt, { threadId: 'a002' });
    const [queuedAfter] = await insertReplies(t.db, [
      reply({ branchId: branch, noteId: 13_015, threadId: 'a002' }),
    ]);
    const skippedTwice = await skippedForBudget(branch, 13_021, skippedAt, { threadId: 'a003' });
    const newest = await skippedForBudget(branch, 13_025, skippedAt, { threadId: 'a003' });
    // A skip with no newer row in its thread is queued again; so is each skip that is in no thread.
    const alone = await skippedForBudget(branch, 13_031, skippedAt, { threadId: 'a004' });
    const [noThread, noThreadToo] = await insertReplies(t.db, [
      reply({
        branchId: branch,
        noteId: 13_041,
        kind: 'command',
        command: 'review',
        threadId: null,
      }),
      reply({ branchId: branch, noteId: 13_042, kind: 'command', command: 'fix', threadId: null }),
    ]);
    await t.db
      .update(reviewReplies)
      .set({ status: 'skipped', reason: 'budget_spent', finishedAt: skippedAt })
      .where(inArray(reviewReplies.id, [noThread!, noThreadToo!]));
    // And a skip whose thread gets a new round in this very pass: the new round reads it.
    const withNewRound = await skippedForBudget(branch, 13_051, skippedAt, { threadId: 'a005' });

    const rounds = [round(13_055, { threadId: 'a005' })];
    expect(await pass(branch, { rounds })).toBe(1 + 4);
    const status = async (...ids: string[]) =>
      (await Promise.all(ids.map(stored))).map((row) => row.status);
    expect(await status(answeredAfter, waitingAfter, skippedTwice, withNewRound)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(await status(newest, alone, noThread!, noThreadToo!)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
    expect((await stored(queuedAfter!)).status).toBe('queued');
    expect(await notesWhere(branch, 'reply', 'queued')).toEqual([13_015, 13_025, 13_031, 13_055]);
    expect(await notesWhere(branch, 'command', 'queued')).toEqual([13_041, 13_042]);
  });

  it('queues a skipped reply again once when two passes choose it at the same time', async () => {
    const branch = await newBranch('requeue-race');
    const notes = Array.from({ length: 5 }, (_, i) => 86_000 + i);
    await manySkipped(branch, 'reply', notes, new Date('2026-10-23T09:00:00.000Z'));
    // Writing a job takes a moment, so that the first pass holds the rows it chose, locked, while
    // the second pass chooses the same ones and waits for it.
    await t.db.execute(
      sql.raw(`CREATE FUNCTION slow_reply_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`),
    );
    await t.db.execute(
      sql.raw(`CREATE TRIGGER slow_reply_jobs BEFORE INSERT ON jobs FOR EACH ROW
        WHEN (NEW.concurrency_key = '${replyKey(branch)}') EXECUTE FUNCTION slow_reply_jobs()`),
    );
    try {
      const firstPass = pass(branch);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const counts = await Promise.all([firstPass, pass(branch)]);
      // Each row is queued again by one pass, never by both: one job each, not two.
      expect(counts.toSorted((a, b) => a - b)).toEqual([0, 5]);
    } finally {
      await t.db.execute(sql.raw('DROP TRIGGER slow_reply_jobs ON jobs'));
      await t.db.execute(sql.raw('DROP FUNCTION slow_reply_jobs()'));
    }
    const queued = await queuedAnswers(t.db, branch);
    expect(queued.jobs).toHaveLength(5);
    expect(await notesWhere(branch, 'reply', 'queued')).toEqual(notes);
  });

  it('queues the rounds, the commands and the skipped replies in one transaction, the skipped first', async () => {
    const branch = await newBranch('queue-replies');
    const skipped = await skippedForBudget(branch, 90_001, new Date('2026-10-23T09:00:00.000Z'));
    const found = { rounds: [round(90_010)], commands: [command(90_020)] };
    expect(await pass(branch, found)).toBe(3);
    const queued = await queuedAnswers(t.db, branch);
    expect(queued.rows.map((row) => [row.noteId, row.kind, row.status])).toEqual([
      [90_001, 'reply', 'queued'],
      [90_010, 'reply', 'queued'],
      [90_020, 'command', 'queued'],
    ]);
    // The re-offered row's job first, then the round's, then the command's.
    expect(queued.jobs).toEqual(
      [skipped, queued.rows[1]!.id, queued.rows[2]!.id].map((id) => answerJob(branch, id)),
    );
    // A decoration with nothing new has nothing to queue.
    expect(await pass(branch)).toBe(0);
    // And one with nothing new still gives a skip of an earlier day its second try.
    const later = await skippedForBudget(branch, 90_002, new Date('2026-10-22T09:00:00.000Z'));
    expect(await pass(branch)).toBe(1);
    expect((await queuedAnswers(t.db, branch)).jobs.at(-1)).toEqual(answerJob(branch, later));
  });

  it('writes no row without its job: a pass whose job cannot be written leaves nothing', async () => {
    const branch = await newBranch('queue-no-job');
    const skipped = await skippedForBudget(branch, 91_001, new Date('2026-10-23T09:00:00.000Z'));
    // The database refuses every job of this merge request.
    const allow = await refuseAnswerJobs(t.db, branch);
    try {
      // The new round and command are written, and the skipped reply is queued again, before the
      // first job fails: none of it stays.
      await expect(
        pass(branch, { rounds: [round(91_010)], commands: [command(91_020)] }),
      ).rejects.toThrow();
    } finally {
      await allow();
    }
    expect(await queuedAnswers(t.db, branch)).toMatchObject({
      rows: [{ id: skipped, status: 'skipped' }],
      jobs: [],
    });
  });

  describe('a scan of the notes (a webhook’s job)', () => {
    /** The `ai-reply` jobs of the branch: their kind and their state. */
    const jobsOf = async (branch: string) =>
      (await queuedAnswers(t.db, branch)).jobs.map((job) => [
        (job.payload as { kind: string }).kind,
        job.status,
      ]);
    const everyJobOf = (branch: string) =>
      t.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.queue, AI_REPLY_QUEUE), eq(jobs.concurrencyKey, replyKey(branch))));

    it('queues one scan for a merge request, with its key and its two tries, and no second while it waits', async () => {
      const branch = await newBranch('scan-once');
      expect(await queueScan(t.db, branch)).toBe(true);
      expect((await queuedAnswers(t.db, branch)).jobs).toEqual([scanJob(branch)]);
      expect(await queueScan(t.db, branch)).toBe(false);
      expect(await queueScan(t.db, branch)).toBe(false);
      expect(await jobsOf(branch)).toEqual([['scan', 'queued']]);
      // Due now: a webhook's scan is not delayed (both times are the database's clock).
      const [queued] = await everyJobOf(branch);
      expect(queued!.runAt.getTime() - queued!.createdAt.getTime()).toBeLessThanOrEqual(1_000);
    });

    it('counts only a queued scan of the branch: not one that runs or ended, an answer job, or another branch’s scan', async () => {
      const branch = await newBranch('scan-counts');
      await queueScan(t.db, branch);
      // The scan that runs may have listed the notes before the one this delivery is about.
      await t.db
        .update(jobs)
        .set({ status: 'running' })
        .where(eq(jobs.concurrencyKey, replyKey(branch)));
      expect(await queueScan(t.db, branch)).toBe(true);
      expect(await jobsOf(branch)).toEqual([
        ['scan', 'running'],
        ['scan', 'queued'],
      ]);
      // A scan that ended, whatever way, is none either.
      await t.db
        .update(jobs)
        .set({ status: 'succeeded' })
        .where(eq(jobs.concurrencyKey, replyKey(branch)));
      expect(await queueScan(t.db, branch)).toBe(true);
      await t.db
        .update(jobs)
        .set({ status: 'dead' })
        .where(and(eq(jobs.concurrencyKey, replyKey(branch)), eq(jobs.status, 'queued')));
      expect(await queueScan(t.db, branch)).toBe(true);
      expect(await jobsOf(branch)).toEqual([
        ['scan', 'succeeded'],
        ['scan', 'succeeded'],
        ['scan', 'dead'],
        ['scan', 'queued'],
      ]);

      // An answer job waiting for the branch is not a scan: the notes it answers are queued already.
      const answering = await newBranch('scan-after-answer');
      expect(await pass(answering, { rounds: [round(60_001)] })).toBe(1);
      expect(await queueScan(t.db, answering)).toBe(true);
      expect(await jobsOf(answering)).toEqual([
        ['answer', 'queued'],
        ['scan', 'queued'],
      ]);

      // Another merge request has its own.
      const other = await newBranch('scan-other');
      expect(await queueScan(t.db, other)).toBe(true);
      expect(await queueScan(t.db, branch)).toBe(false);
    });

    it('queues none for a branch that is gone, and writes nothing', async () => {
      const gone = uuidv7();
      expect(await queueScan(t.db, gone)).toBe(false);
      expect(await everyJobOf(gone)).toEqual([]);
    });

    it('queues a scan due when it is told to, and again after the circuit, which is the queued one when there is one', async () => {
      const branch = await newBranch('scan-circuit');
      expect(await queueScanAfterCircuit(t.db, branch, 90)).toBe(true);
      const [waiting] = await everyJobOf(branch);
      expect(waiting).toMatchObject({ status: 'queued', attempts: 0, maxAttempts: 2 });
      const wait = (waiting!.runAt.getTime() - waiting!.createdAt.getTime()) / 1000;
      expect(Math.abs(wait - 90)).toBeLessThan(5);
      // The scan that waits is the branch's queued one: neither a delivery nor a second wait adds one.
      expect(await queueScan(t.db, branch)).toBe(false);
      expect(await queueScanAfterCircuit(t.db, branch, 30)).toBe(false);
      expect(await jobsOf(branch)).toEqual([['scan', 'queued']]);
    });

    it('queues one scan for two requests at once, whichever the branch’s row makes wait', async () => {
      const branch = await newBranch('scan-concurrent');
      const queued: Promise<boolean>[] = [];
      await t.db.transaction(async (tx) => {
        await tx
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.id, branch))
          .for('update');
        queued.push(queueScan(t.db, branch));
        await waitForLockWaiters(t.db, 1);
        queued.push(queueScan(t.db, branch));
        await waitForLockWaiters(t.db, 2);
      });
      expect((await Promise.all(queued)).toSorted()).toEqual([false, true]);
      expect(await jobsOf(branch)).toEqual([['scan', 'queued']]);
    });
  });

  describe('the answers a decoration and a scan queue', () => {
    /** Everything counts: no note is too old, and the ledger holds nothing yet. */
    const window = () => ({ largestNoteIds: new Map<string, number>(), since: new Date(0) });
    const ids = (branch: string) => ({ projectId, branchId: branch });
    const person = { id: 7, username: 'ann' };
    const bot = { id: 900, username: 'qualor-bot' };
    const at = '2026-10-10T08:30:00.000Z';
    /** A thread of Qualor's with a reply, and a command, whose notes are numbered from `base`. */
    const discussions = (base = 0): GitLabDiscussion[] => [
      {
        id: THREAD,
        individual_note: false,
        notes: [
          {
            id: base + 10,
            body: `${issueMarker(issueId)}\n**Medium** · a finding`,
            author: bot,
            created_at: at,
            system: false,
            resolvable: true,
            resolved: false,
          },
          {
            id: base + 11,
            body: 'This is intended.',
            author: person,
            created_at: at,
            system: false,
            resolvable: true,
            resolved: false,
          },
        ],
      },
      {
        id: OTHER_THREAD,
        individual_note: true,
        notes: [
          {
            id: base + 20,
            body: 'qualor review',
            author: person,
            created_at: at,
            system: false,
            resolvable: false,
          },
        ],
      },
    ];

    it('queues a GitLab merge request’s new reply and command, and none without a window', async () => {
      const branch = await newBranch('answers-gitlab');
      expect(await queueGitLabAnswers(t.db, ids(branch), null, bot.id, discussions())).toBe(0);
      expect((await queuedAnswers(t.db, branch)).rows).toEqual([]);
      expect(await queueGitLabAnswers(t.db, ids(branch), window(), bot.id, discussions())).toBe(2);
      expect((await queuedAnswers(t.db, branch)).rows).toMatchObject([
        { provider: 'gitlab', kind: 'reply', noteId: 11, threadId: THREAD, issueId, author: 'ann' },
        {
          provider: 'gitlab',
          kind: 'command',
          command: 'review',
          noteId: 20,
          threadId: OTHER_THREAD,
        },
      ]);
      // The same notes again are the ledger's: nothing more.
      expect(await queueGitLabAnswers(t.db, ids(branch), window(), bot.id, discussions())).toBe(0);
      // Under another user it finds no thread of Qualor's, so no reply, but the command is found.
      const unknown = await newBranch('answers-gitlab-unknown');
      expect(await queueGitLabAnswers(t.db, ids(unknown), window(), 12_345, discussions(100))).toBe(
        1,
      );
    });

    it('queues a GitHub pull request’s rounds as given and the commands among its page’s comments, and none without a window', async () => {
      const branch = await newBranch('answers-github');
      const comments: GitHubComment[] = [
        {
          id: 72_070,
          body: 'qualor stop',
          user: { login: 'octocat', type: 'User' },
          created_at: at,
        },
        {
          id: 72_071,
          body: 'qualor stop',
          user: { login: 'qualor-acme[bot]', type: 'Bot' },
          created_at: at,
        },
        {
          id: 72_072,
          body: 'looks fine',
          user: { login: 'octocat', type: 'User' },
          created_at: at,
        },
      ];
      const rounds = [round(72_010, { threadId: '72001', author: 'octocat' })];
      const found = { rounds, comments };
      expect(await queueGitHubAnswers(t.db, ids(branch), null, 'qualor-acme[bot]', found)).toBe(0);
      expect((await queuedAnswers(t.db, branch)).rows).toEqual([]);
      expect(await queueGitHubAnswers(t.db, ids(branch), window(), 'qualor-acme[bot]', found)).toBe(
        2,
      );
      expect((await queuedAnswers(t.db, branch)).rows).toMatchObject([
        { provider: 'github', kind: 'reply', noteId: 72_010, threadId: '72001' },
        {
          provider: 'github',
          kind: 'command',
          command: 'stop',
          noteId: 72_070,
          threadId: null,
          author: 'octocat',
        },
      ]);
    });
  });

  it('counts a note from the later of the consent and 30 days before now', () => {
    const now = new Date('2026-10-25T12:00:00.000Z');
    // A recent consent bounds it, a consent from long ago leaves the 30 days, and so does a consent
    // exactly 30 days old.
    expect(repliesSince('2026-10-20T08:00:00.000Z', now)).toEqual(
      new Date('2026-10-20T08:00:00.000Z'),
    );
    expect(repliesSince('2026-08-01T08:00:00.000Z', now)).toEqual(
      new Date('2026-09-25T12:00:00.000Z'),
    );
    expect(repliesSince('2026-09-25T12:00:00.000Z', now)).toEqual(
      new Date('2026-09-25T12:00:00.000Z'),
    );
    // The consent's own time zone does not matter.
    expect(repliesSince('2026-10-20T11:00:00.000+03:00', now)).toEqual(
      new Date('2026-10-20T08:00:00.000Z'),
    );
  });

  it('starts the UTC day at midnight', () => {
    expect(utcDayStart(new Date('2026-10-25T23:59:59.999Z'))).toEqual(
      new Date('2026-10-25T00:00:00.000Z'),
    );
    expect(utcDayStart(new Date('2026-10-26T00:00:00.000Z'))).toEqual(
      new Date('2026-10-26T00:00:00.000Z'),
    );
    expect(utcDayStart(new Date('2026-10-26T02:30:00.000+03:00'))).toEqual(
      new Date('2026-10-25T00:00:00.000Z'),
    );
  });
});
