import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { answerJob, queuedAnswers } from '../../test/replies';
import { seedAiIssue } from '../../test/review';
import { uuidv7 } from '../db/ids';
import { first } from '../db/rows';
import { branches, organizations, projects, reviewReplies, type ReplyKind } from '../db/schema';
import {
  claimReply,
  endReply,
  insertReplies,
  largestNoteIds,
  MAX_QUEUED_COMMANDS,
  MAX_QUEUED_ROUNDS,
  type NewReply,
  queueCommands,
  queueReplies,
  queueRounds,
  recordAnswerNote,
  recordDecision,
  repliesSince,
  REPLY_TOKEN_BUDGET,
  type ReplyContext,
  type ReplyDecision,
  type ReplyEnd,
  type ReplyRow,
  type RequeueBounds,
  requeueBudgetSkips,
  utcDayStart,
} from './replies';
import type { CommandNote, Round } from './reply-detect';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const THREAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_THREAD = '0123456789abcdef0123456789abcdef01234567';

describe('the replies ledger (6I-4)', () => {
  let t: TestDatabase;
  let projectId: string;
  let branchId: string;
  let otherBranchId: string;
  let noteSequence = 1_000;

  const newBranch = async (name: string) =>
    first(
      await t.db.insert(branches).values({ projectId, kind: 'merge_request', name }).returning(),
    ).id;
  /** A reply in the thread `THREAD` of the merge request, with a note of its own, unless `over` says otherwise. */
  const reply = (over: Partial<NewReply> = {}): NewReply => {
    noteSequence += 1;
    return {
      projectId,
      branchId,
      provider: 'gitlab',
      noteId: noteSequence,
      threadId: THREAD,
      kind: 'reply',
      author: 'jane',
      ...over,
    };
  };
  /** The new row of a note, which must be one. */
  const insertOne = async (over: Partial<NewReply> = {}): Promise<string> => {
    const ids = await insertReplies(t.db, [reply(over)]);
    expect(ids).toHaveLength(1);
    return ids[0]!;
  };
  const stored = async (id: string): Promise<ReplyRow> =>
    first(await t.db.select().from(reviewReplies).where(eq(reviewReplies.id, id)));
  const rowsOfNote = (noteId: number) =>
    t.db.select().from(reviewReplies).where(eq(reviewReplies.noteId, noteId));

  beforeAll(async () => {
    t = await createTestDatabase();
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'ledger', name: 'Ledger' }).returning(),
    ).id;
    projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'ledger/api', name: 'Api' })
        .returning(),
    ).id;
    branchId = await newBranch('7');
    otherBranchId = await newBranch('8');
  });
  afterAll(async () => {
    await t.close();
  });

  it('a second insert of the same note is ignored', async () => {
    const note = reply({ noteId: 500, author: 'jane' });
    const ids = await insertReplies(t.db, [note]);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(UUID);

    // The note again, however it is written this time: nothing new, and the first row stands.
    expect(await insertReplies(t.db, [{ ...note, author: 'mallory', threadId: '1234' }])).toEqual(
      [],
    );
    expect(await rowsOfNote(500)).toEqual([await stored(ids[0]!)]);
    expect(await stored(ids[0]!)).toMatchObject({
      author: 'jane',
      threadId: THREAD,
      kind: 'reply',
    });

    // A batch of a known note and a new one: only the new one comes back.
    const fresh = reply({ noteId: 501 });
    const next = await insertReplies(t.db, [note, fresh]);
    expect(next).toHaveLength(1);
    expect(await stored(next[0]!)).toMatchObject({ noteId: 501 });

    // The same note twice in one batch: one row, the first one written.
    const twice = await insertReplies(t.db, [
      reply({ noteId: 502, author: 'first' }),
      reply({ noteId: 502, author: 'second' }),
    ]);
    expect(twice).toHaveLength(1);
    expect(await stored(twice[0]!)).toMatchObject({ noteId: 502, author: 'first' });

    // Several new notes: one id each, in rows of their own.
    const several = await insertReplies(t.db, [
      reply({ noteId: 503 }),
      reply({ noteId: 504 }),
      reply({ noteId: 505 }),
    ]);
    expect(new Set(several).size).toBe(3);
    expect((await Promise.all(several.map(stored))).map((row) => row.noteId).sort()).toEqual([
      503, 504, 505,
    ]);

    // The same note from two connections at once, as decoration and a webhook would find it: one
    // of them has the new row, the other none.
    const raced = reply({ noteId: 506 });
    const both = await Promise.all([insertReplies(t.db, [raced]), insertReplies(t.db, [raced])]);
    expect(both.map((ids) => ids.length).sort()).toEqual([0, 1]);
    expect(await rowsOfNote(506)).toHaveLength(1);

    // Nothing to insert is not an error.
    expect(await insertReplies(t.db, [])).toEqual([]);
  });

  it('a note is the project’s, the provider’s and the kind’s, not the branch’s', async () => {
    const note = reply({ noteId: 600 });
    expect(await insertReplies(t.db, [note])).toHaveLength(1);
    // The same note on another branch is the same note; on the other provider, another one.
    expect(await insertReplies(t.db, [{ ...note, branchId: otherBranchId }])).toEqual([]);
    expect(await insertReplies(t.db, [{ ...note, provider: 'github' }])).toHaveLength(1);
  });

  it('a reply and a command with the same note id are two notes', async () => {
    // On GitHub a reply is a review comment and a command an issue comment: two id spaces that can
    // share a number.
    const asReply = reply({ provider: 'github', noteId: 700, threadId: '699' });
    const asCommand = reply({
      provider: 'github',
      noteId: 700,
      threadId: null,
      kind: 'command',
      command: 'review',
    });
    expect(await insertReplies(t.db, [asReply, asCommand])).toHaveLength(2);
    expect((await rowsOfNote(700)).map((row) => row.kind).sort()).toEqual(['command', 'reply']);
    // Each of them once: a second reply of that number is still ignored, and so is a second command.
    expect(await insertReplies(t.db, [asReply, asCommand])).toEqual([]);
    expect(await insertReplies(t.db, [{ ...asReply, author: 'mallory' }])).toEqual([]);
    expect(await insertReplies(t.db, [{ ...asCommand, command: 'stop' }])).toEqual([]);
    // Either one first.
    const commandFirst = reply({
      provider: 'github',
      noteId: 701,
      threadId: null,
      kind: 'command',
      command: 'fix',
    });
    expect(await insertReplies(t.db, [commandFirst])).toHaveLength(1);
    expect(await insertReplies(t.db, [reply({ provider: 'github', noteId: 701 })])).toHaveLength(1);
  });

  it('claim takes a queued row once', async () => {
    const id = await insertOne();
    const claimed = await claimReply(t.db, id);
    expect(claimed).toMatchObject({ id, status: 'running', author: 'jane', kind: 'reply' });
    expect(claimed?.startedAt).toBeInstanceOf(Date);
    expect(await stored(id)).toEqual(claimed);
    // It is running now, so nobody else takes it.
    expect(await claimReply(t.db, id)).toBeNull();

    // A row that is not there is not taken either, nor is one that has ended.
    expect(await claimReply(t.db, '01900000-0000-7000-8000-000000000000')).toBeNull();
    const ended = await insertOne();
    await endReply(t.db, ended, { status: 'done', outcome: 'answered' });
    expect(await claimReply(t.db, ended)).toBeNull();

    // Of two claims at once, one wins.
    const contested = await insertOne();
    const results = await Promise.all([claimReply(t.db, contested), claimReply(t.db, contested)]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
  });

  it('largestNoteIds gives each thread’s largest note id', async () => {
    const branch = await newBranch('thread-notes');
    const other = '1234567';
    const onBranch = (over: Partial<NewReply>) => reply({ branchId: branch, ...over });
    await insertReplies(t.db, [
      onBranch({ noteId: 10, threadId: THREAD }),
      onBranch({ noteId: 30, threadId: THREAD }),
      onBranch({ noteId: 20, threadId: THREAD }),
      // A thread of GitHub: its first comment's id, and a note past 2^31.
      onBranch({ noteId: 3_000_000_005, threadId: other, provider: 'github' }),
      onBranch({ noteId: 3_000_000_001, threadId: other, provider: 'github' }),
      // A note that is no reply of a thread has none to count in: a GitHub top-level command.
      onBranch({ noteId: 9_999, threadId: null, kind: 'command', command: 'review' }),
      // The notes of another merge request are another ledger.
      reply({ branchId: otherBranchId, noteId: 5_000, threadId: THREAD }),
    ]);
    const largest = await largestNoteIds(t.db, branch);
    expect(largest).toEqual(
      new Map([
        [THREAD, 30],
        [other, 3_000_000_005],
      ]),
    );
    for (const noteId of largest.values()) expect(typeof noteId).toBe('number');

    // A note counts whatever became of it: one that failed, or was skipped, was handled.
    const failedId = await insertOne({ branchId: branch, noteId: 40, threadId: THREAD });
    await endReply(t.db, failedId, { status: 'failed', reason: 'bad_answer' });
    expect((await largestNoteIds(t.db, branch)).get(THREAD)).toBe(40);

    expect(await largestNoteIds(t.db, await newBranch('no-notes'))).toEqual(new Map());
  });

  it('the decision and the answer note are recorded once', async () => {
    const id = await insertOne();
    await recordDecision(t.db, id, {
      verdict: 'wont_fix',
      answer: 'Understood: this is not worth fixing now.',
      model: 'model-1',
      inputTokens: 12_000,
      outputTokens: 480,
      costMicroUsd: 3_100,
    });
    // A retry that decides again changes nothing: the model is never asked twice.
    await recordDecision(t.db, id, {
      verdict: 'keep',
      answer: 'Something else.',
      model: 'model-2',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: null,
    });
    expect(await stored(id)).toMatchObject({
      verdict: 'wont_fix',
      answer: 'Understood: this is not worth fixing now.',
      model: 'model-1',
      inputTokens: 12_000,
      outputTokens: 480,
      costMicroUsd: 3_100,
      answerNoteId: null,
    });

    await recordAnswerNote(t.db, id, 7_001);
    await recordAnswerNote(t.db, id, 7_002);
    expect(await stored(id)).toMatchObject({ verdict: 'wont_fix', answerNoteId: 7_001 });

    // A decision that keeps the issue, with no words and no price, is a decision too.
    const silent = await insertOne();
    await recordDecision(t.db, silent, {
      verdict: 'keep',
      answer: '',
      model: 'model-1',
      inputTokens: 900,
      outputTokens: 0,
      costMicroUsd: null,
    });
    await recordDecision(t.db, silent, {
      verdict: 'false_positive',
      answer: 'It does not hold.',
      model: 'model-1',
      inputTokens: 5,
      outputTokens: 5,
      costMicroUsd: 1,
    });
    expect(await stored(silent)).toMatchObject({
      verdict: 'keep',
      answer: '',
      inputTokens: 900,
      outputTokens: 0,
      costMicroUsd: null,
    });

    // A note id that is past 2^31 comes back as it went in.
    const github = await insertOne({ provider: 'github', threadId: '2999999999' });
    await recordAnswerNote(t.db, github, 3_000_000_123);
    expect((await stored(github)).answerNoteId).toBe(3_000_000_123);
  });

  it('a decision writes its own columns and nothing else', async () => {
    const decision: ReplyDecision = {
      verdict: 'false_positive',
      answer: 'It does not hold.',
      model: 'model-1',
      inputTokens: 900,
      outputTokens: 60,
      costMicroUsd: 250,
    };
    // An object that carries more than a decision does, as one made from the model's answer by a
    // spread could: whatever else is in it changes no other column of the row.
    const extras = [
      { status: 'running' },
      { status: 'done' },
      { outcome: 'answered', answerNoteId: 99, author: 'mallory', finishedAt: new Date() },
    ];
    for (const extra of extras) {
      const id = await insertOne();
      const before = await stored(id);
      const carrying = { ...decision, ...extra };
      await recordDecision(t.db, id, carrying);
      expect(await stored(id), JSON.stringify(Object.keys(extra))).toEqual({
        ...before,
        ...decision,
      });
    }
  });

  it('endReply ends a row once and sets finished_at', async () => {
    const answered = await insertOne();
    await claimReply(t.db, answered);
    await endReply(t.db, answered, { status: 'done', outcome: 'answered' });
    const done = await stored(answered);
    expect(done).toMatchObject({ status: 'done', outcome: 'answered', reason: null });
    expect(done.startedAt).toBeInstanceOf(Date);
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.finishedAt!.getTime()).toBeGreaterThanOrEqual(done.startedAt!.getTime());

    // The end is final: a late second end changes nothing, not even the time.
    await endReply(t.db, answered, { status: 'failed', reason: 'internal' });
    expect(await stored(answered)).toEqual(done);

    // A row that was never claimed can be skipped, with its reason; no start is made up.
    const skipped = await insertOne();
    await endReply(t.db, skipped, { status: 'skipped', reason: 'closed' });
    expect(await stored(skipped)).toMatchObject({
      status: 'skipped',
      outcome: null,
      reason: 'closed',
      startedAt: null,
    });
    expect((await stored(skipped)).finishedAt).toBeInstanceOf(Date);

    const failed = await insertOne();
    await endReply(t.db, failed, { status: 'failed', reason: 'provider_error' });
    expect(await stored(failed)).toMatchObject({ status: 'failed', reason: 'provider_error' });

    // Both are optional.
    const plain = await insertOne();
    await endReply(t.db, plain, { status: 'done' });
    expect(await stored(plain)).toMatchObject({ status: 'done', outcome: null, reason: null });
  });

  it('keeps the budget of one reply at 60 000 tokens', () => {
    expect(REPLY_TOKEN_BUDGET).toBe(60_000);
  });

  describe('queueing the answers (decoration, 6I-4)', () => {
    let issueId: string;

    const contextOf = (branch: string, provider: ReplyContext['provider'] = 'gitlab') => ({
      projectId,
      branchId: branch,
      provider,
    });
    /** The round of a thread whose newest note is `newest`. */
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
    /** A window that reaches back to the beginning: no row is too old for it. */
    const EVER = { since: new Date(0) };
    /**
     * What the re-offer may take back: the skips before 20 October, none too old, and as many as
     * the caps allow, unless `over` says otherwise.
     */
    const bounds = (over: Partial<RequeueBounds> = {}): RequeueBounds => ({
      dayStart: new Date('2026-10-20T00:00:00.000Z'),
      since: EVER.since,
      rounds: MAX_QUEUED_ROUNDS,
      commands: MAX_QUEUED_COMMANDS,
      ...over,
    });
    /**
     * A row the answer job skipped for the day's budget (or ended as `end` says), at `finishedAt`,
     * in the thread `threadId`.
     */
    const skippedForBudget = async (
      branch: string,
      noteId: number,
      finishedAt: Date,
      over: { end?: ReplyEnd; threadId?: string } = {},
    ): Promise<string> => {
      const { end = { status: 'skipped', reason: 'budget_spent' }, threadId = THREAD } = over;
      const id = await insertOne({ branchId: branch, noteId, threadId });
      await claimReply(t.db, id);
      await endReply(t.db, id, end);
      await t.db
        .update(reviewReplies)
        .set({ finishedAt, startedAt: new Date(finishedAt.getTime() - 60_000) })
        .where(eq(reviewReplies.id, id));
      return id;
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
    /** The kind and the note of each of the rows `ids`, in that order. */
    const notesOf = async (ids: readonly string[]) =>
      (await Promise.all(ids.map(stored))).map((row) => [row.kind, row.noteId]);

    beforeAll(async () => {
      issueId = await seedAiIssue(t.db, {
        branchId,
        category: 'logic',
        path: 'src/a.ts',
        line: 3,
      });
    });

    it('queues a row and one answer job for each new round, and none for a round it holds', async () => {
      const branch = await newBranch('queue-rounds');
      const rounds = [
        // Two notes of one thread are one round: the newest note's row.
        round(10_021, { noteIds: [10_011, 10_021], author: 'jane' }),
        round(10_030, { threadId: OTHER_THREAD, author: 'omar' }),
      ];
      expect(await queueRounds(t.db, contextOf(branch), rounds)).toBe(2);
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
      expect(await queueRounds(t.db, contextOf(branch), rounds)).toBe(0);
      expect(await queuedAnswers(t.db, branch)).toEqual(queued);
      // A newer round of a thread it holds is new.
      expect(await queueRounds(t.db, contextOf(branch), [round(10_040)])).toBe(1);
      expect((await queuedAnswers(t.db, branch)).jobs).toHaveLength(3);
    });

    it('queues the rounds of a GitHub pull request by the id of the first comment of each thread', async () => {
      const branch = await newBranch('queue-github-rounds');
      const github = round(3_000_000_010, { threadId: '3000000001', author: 'octocat' });
      expect(await queueRounds(t.db, contextOf(branch, 'github'), [github])).toBe(1);
      const { rows } = await queuedAnswers(t.db, branch);
      expect(rows).toMatchObject([
        { provider: 'github', kind: 'reply', noteId: 3_000_000_010, threadId: '3000000001' },
      ]);
      // Rows of GitHub and of GitLab are apart: the same number on the other provider is another note.
      expect(
        await queueRounds(t.db, contextOf(await newBranch('queue-gitlab-rounds')), [
          round(3_000_000_010),
        ]),
      ).toBe(1);
    });

    it(`queues at most ${MAX_QUEUED_ROUNDS} rounds, the oldest note first, and the next ones later`, async () => {
      expect(MAX_QUEUED_ROUNDS).toBe(50);
      const branch = await newBranch('rounds-cap');
      const notes = Array.from({ length: MAX_QUEUED_ROUNDS + 1 }, (_, i) => 20_000 + i);
      // Handed over the newest first: the cap and the order are the queue's, not the caller's.
      const rounds = notes.map((note) => round(note, { threadId: `a${note}` })).reverse();
      expect(await queueRounds(t.db, contextOf(branch), rounds)).toBe(MAX_QUEUED_ROUNDS);
      const queued = await queuedAnswers(t.db, branch);
      expect(queued.rows.map((row) => row.noteId)).toEqual(notes.slice(0, MAX_QUEUED_ROUNDS));
      // The jobs are in the order of the notes: the oldest reply is answered first.
      expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(branch, row.id)));
      // The next decoration finds the round the cap left (the ledger holds the others).
      const left = round(notes[MAX_QUEUED_ROUNDS]!, { threadId: `a${notes[MAX_QUEUED_ROUNDS]}` });
      expect(await queueRounds(t.db, contextOf(branch), [left])).toBe(1);
      expect(await queueRounds(t.db, contextOf(branch), [left])).toBe(0);
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
      expect(await queueRounds(t.db, contextOf(branch), rounds)).toBe(1);
      const { rows } = await queuedAnswers(t.db, branch);
      expect(rows.map((row) => row.noteId)).toEqual([30_005]);
      expect(rows[0]?.author).toBe('x'.repeat(255));
      // The cap counts the rounds that fit: those it left out take none of its places.
      const many = Array.from({ length: MAX_QUEUED_ROUNDS }, (_, i) => round(31_000 + i));
      const unfit = Array.from({ length: 5 }, (_, i) => round(30_900 + i, { threadId: 'no' }));
      expect(await queueRounds(t.db, contextOf(branch), [...unfit, ...many])).toBe(
        MAX_QUEUED_ROUNDS,
      );
    });

    it('queues a row and one answer job for each new command, with the discussion it was written in', async () => {
      const gitlab = await newBranch('queue-gitlab-commands');
      expect(
        await queueCommands(t.db, contextOf(gitlab), [
          command(50_001, { command: 'review', author: 'jane' }),
          command(50_002, { threadId: OTHER_THREAD, command: 'stop', author: 'omar' }),
        ]),
      ).toBe(2);
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
        {
          kind: 'command',
          command: 'stop',
          noteId: 50_002,
          threadId: OTHER_THREAD,
          author: 'omar',
        },
      ]);
      expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(gitlab, row.id)));
      // Again: nothing new.
      expect(await queueCommands(t.db, contextOf(gitlab), [command(50_001), command(50_002)])).toBe(
        0,
      );
      expect(await queuedAnswers(t.db, gitlab)).toEqual(queued);

      // A comment on a GitHub pull request's page is in no thread, and the id of a command and of
      // a reply of that number are two notes.
      const github = await newBranch('queue-github-commands');
      const page = command(50_003, { threadId: null, command: 'fix', author: 'octocat' });
      expect(await queueCommands(t.db, contextOf(github, 'github'), [page])).toBe(1);
      expect((await queuedAnswers(t.db, github)).rows).toMatchObject([
        { provider: 'github', kind: 'command', command: 'fix', noteId: 50_003, threadId: null },
      ]);
      expect(
        await queueRounds(t.db, contextOf(github, 'github'), [
          round(50_003, { threadId: '50000' }),
        ]),
      ).toBe(1);
    });

    it(`queues at most ${MAX_QUEUED_COMMANDS} commands, the oldest note first, and the next ones later`, async () => {
      expect(MAX_QUEUED_COMMANDS).toBe(20);
      const branch = await newBranch('commands-cap');
      const notes = Array.from({ length: MAX_QUEUED_COMMANDS + 1 }, (_, i) => 60_000 + i);
      const commands = notes.map((note) => command(note)).reverse();
      expect(await queueCommands(t.db, contextOf(branch), commands)).toBe(MAX_QUEUED_COMMANDS);
      const queued = await queuedAnswers(t.db, branch);
      expect(queued.rows.map((row) => row.noteId)).toEqual(notes.slice(0, MAX_QUEUED_COMMANDS));
      expect(queued.jobs).toEqual(queued.rows.map((row) => answerJob(branch, row.id)));
      expect(
        await queueCommands(t.db, contextOf(branch), [command(notes[MAX_QUEUED_COMMANDS]!)]),
      ).toBe(1);
    });

    it('writes its rows and jobs in the transaction it is given', async () => {
      const branch = await newBranch('queue-rollback');
      await expect(
        t.db.transaction(async (tx) => {
          expect(await queueRounds(tx, contextOf(branch), [round(70_001)])).toBe(1);
          expect(await queueCommands(tx, contextOf(branch), [command(70_002)])).toBe(1);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await queuedAnswers(t.db, branch)).toEqual({ rows: [], jobs: [] });
    });

    it('queues each note once when two transactions find the same notes at the same time', async () => {
      const branch = await newBranch('queue-race');
      const notes = Array.from({ length: 30 }, (_, i) => 96_000 + i);
      const rounds = notes.map((note) => round(note, { threadId: `b${note}` }));
      const commands = notes.slice(0, 10).map((note) => command(note + 1_000));
      // A decoration and a webhook's scan, the second with the notes the other way round.
      const both = await Promise.all([
        queueReplies(t.db, contextOf(branch), EVER, { rounds, commands }),
        queueReplies(t.db, contextOf(branch), EVER, {
          rounds: rounds.toReversed(),
          commands: commands.toReversed(),
        }),
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
      const day = new Date('2026-10-20T00:00:00.000Z');
      const yesterday = await skippedForBudget(
        branch,
        80_001,
        new Date('2026-10-19T23:59:59.999Z'),
      );
      // The newer note's row is made first, in the thread that comes first: neither the order the
      // rows were made in nor the order of their threads is the order of the notes.
      const today = await skippedForBudget(branch, 80_003, new Date('2026-10-20T12:00:00.000Z'), {
        threadId: 'aaaa',
      });
      const startOfDay = await skippedForBudget(branch, 80_002, day, { threadId: 'bbbb' });
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
      const elsewhere = await skippedForBudget(
        await newBranch('requeue-elsewhere'),
        80_007,
        earlier,
      );
      const ids = [yesterday, startOfDay, today, inactive, failed, answered, elsewhere];
      const before = await Promise.all(ids.map(stored));

      // Only a skip that ended before the day began: the row is queued again, with nothing else changed.
      expect(await requeueBudgetSkips(t.db, branch, bounds({ dayStart: day }))).toEqual([
        yesterday,
      ]);
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
      // Once: the row is queued now, and a second look finds nothing to offer.
      expect(await requeueBudgetSkips(t.db, branch, bounds({ dayStart: day }))).toEqual([]);
      // It is a queued row like any other: the job takes it.
      expect(await claimReply(t.db, yesterday)).toMatchObject({ id: yesterday, status: 'running' });

      // The next day's start is past the others' skips: they are offered, the oldest note first.
      const next = new Date('2026-10-21T00:00:00.000Z');
      expect(await requeueBudgetSkips(t.db, branch, bounds({ dayStart: next }))).toEqual([
        startOfDay,
        today,
      ]);
    });

    it('leaves a skip alone whose row is older than the window, so that it ages out', async () => {
      const branch = await newBranch('requeue-window');
      const day = new Date('2026-10-24T00:00:00.000Z');
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

      const within = bounds({ dayStart: day, since });
      expect(await requeueBudgetSkips(t.db, branch, within)).toEqual([edge, inside]);
      // The aged row is as its skip left it, its end where housekeeping finds it, however often
      // it is looked at.
      expect(await stored(aged)).toEqual(before);
      expect(await requeueBudgetSkips(t.db, branch, within)).toEqual([]);
      expect(await stored(aged)).toEqual(before);
    });

    it('queues again at most the room each kind has left, the oldest note first, and the rest in a later pass', async () => {
      const branch = await newBranch('requeue-room');
      const skippedAt = new Date('2026-10-19T09:00:00.000Z');
      const replyNotes = Array.from({ length: 60 }, (_, i) => 82_000 + i);
      const commandNotes = Array.from({ length: 25 }, (_, i) => 82_500 + i);
      // Made newest first: the order of the rows is not the order of the notes.
      await manySkipped(branch, 'reply', replyNotes.toReversed(), skippedAt);
      await manySkipped(branch, 'command', commandNotes.toReversed(), skippedAt);
      const pass = async (over: Partial<RequeueBounds>) =>
        notesOf(await requeueBudgetSkips(t.db, branch, bounds(over)));
      const replies = (notes: readonly number[]) => notes.map((note) => ['reply', note]);
      const commands = (notes: readonly number[]) => notes.map((note) => ['command', note]);

      // No room, or less than none, queues nothing.
      expect(await pass({ rounds: 0, commands: 0 })).toEqual([]);
      expect(await pass({ rounds: -5, commands: -1 })).toEqual([]);
      // Room for three replies and no command.
      expect(await pass({ rounds: 3, commands: 0 })).toEqual(replies(replyNotes.slice(0, 3)));
      // The full room: fifty replies and twenty commands, the oldest of each.
      expect(await pass({})).toEqual([
        ...replies(replyNotes.slice(3, 53)),
        ...commands(commandNotes.slice(0, 20)),
      ]);
      // A later pass takes what is left of both, and the next finds nothing.
      expect(await pass({})).toEqual([
        ...replies(replyNotes.slice(53)),
        ...commands(commandNotes.slice(20)),
      ]);
      expect(await pass({})).toEqual([]);
    });

    it('queues a skipped reply again once when two writers choose it at the same time', async () => {
      const branch = await newBranch('requeue-race');
      const notes = Array.from({ length: 5 }, (_, i) => 86_000 + i);
      await manySkipped(branch, 'reply', notes, new Date('2026-10-19T09:00:00.000Z'));
      // The first writer queues them again and holds its transaction open, so that the rows stay
      // locked; the second chooses the same rows, and waits for the first to end.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let queuedByFirst!: () => void;
      const firstQueued = new Promise<void>((resolve) => (queuedByFirst = resolve));
      const first = t.db.transaction(async (tx) => {
        const ids = await requeueBudgetSkips(tx, branch, bounds());
        queuedByFirst();
        await held;
        return ids;
      });
      await firstQueued;
      const second = requeueBudgetSkips(t.db, branch, bounds());
      for (let tries = 0; ; tries++) {
        const waiting = await t.db.execute(
          sql`SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (waiting.rows.length > 0) break;
        if (tries > 200) throw new Error('the second writer never waited for the first');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      const [firstIds, secondIds] = await Promise.all([first, second]);
      // Each row is queued again by one writer, never by both: one job each, not two.
      expect(await notesOf(firstIds)).toEqual(notes.map((note) => ['reply', note]));
      expect(secondIds).toEqual([]);
    });

    it('queues the rounds, the commands and the skipped replies in one transaction, the skipped first', async () => {
      const branch = await newBranch('queue-replies');
      const now = new Date('2026-10-24T10:00:00.000Z');
      const skipped = await skippedForBudget(branch, 90_001, new Date('2026-10-23T09:00:00.000Z'));
      const found = { rounds: [round(90_010)], commands: [command(90_020)] };
      expect(await queueReplies(t.db, contextOf(branch), EVER, found, now)).toBe(3);
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
      const nothing = { rounds: [], commands: [] };
      expect(await queueReplies(t.db, contextOf(branch), EVER, nothing, now)).toBe(0);
      // And one with nothing new still gives a skip of an earlier day its second try.
      const later = await skippedForBudget(branch, 90_002, new Date('2026-10-22T09:00:00.000Z'));
      expect(await queueReplies(t.db, contextOf(branch), EVER, nothing, now)).toBe(1);
      expect((await queuedAnswers(t.db, branch)).jobs.at(-1)).toEqual(answerJob(branch, later));
    });

    it('queues nothing of a decoration whose write fails: the skipped replies stay skipped', async () => {
      const branch = await newBranch('queue-replies-rollback');
      const now = new Date('2026-10-24T10:00:00.000Z');
      const skipped = await skippedForBudget(branch, 91_001, new Date('2026-10-23T09:00:00.000Z'));
      // A round for an issue the database does not have: its row cannot be written.
      const stray = round(91_010, { issueId: uuidv7() });
      await expect(
        queueReplies(
          t.db,
          contextOf(branch),
          EVER,
          { rounds: [stray], commands: [command(91_020)] },
          now,
        ),
      ).rejects.toThrow();
      expect((await stored(skipped)).status).toBe('skipped');
      expect(await queuedAnswers(t.db, branch)).toMatchObject({
        rows: [{ id: skipped, status: 'skipped' }],
        jobs: [],
      });
    });

    it('counts the new notes against the caps first, and queues skipped replies again in what they leave', async () => {
      const branch = await newBranch('queue-replies-caps');
      const now = new Date('2026-10-24T10:00:00.000Z');
      const skippedAt = new Date('2026-10-23T09:00:00.000Z');
      const replyNotes = Array.from({ length: 60 }, (_, i) => 83_000 + i);
      const commandNotes = Array.from({ length: 25 }, (_, i) => 83_500 + i);
      const skippedReplies = await manySkipped(branch, 'reply', replyNotes, skippedAt);
      await manySkipped(branch, 'command', commandNotes, skippedAt);
      const queuedNotes = async (kind: ReplyKind, status: string) =>
        (await queuedAnswers(t.db, branch)).rows
          .filter((row) => row.kind === kind && row.status === status)
          .map((row) => row.noteId);

      // Three new rounds and two new commands take their places in the caps first: the oldest of
      // the skipped replies and commands share what is left, and the others wait.
      const found = {
        rounds: [84_001, 84_002, 84_003].map((note) =>
          round(note, { threadId: note.toString(16) }),
        ),
        commands: [84_501, 84_502].map((note) => command(note)),
      };
      expect(await queueReplies(t.db, contextOf(branch), EVER, found, now)).toBe(
        MAX_QUEUED_ROUNDS + MAX_QUEUED_COMMANDS,
      );
      expect(await queuedNotes('reply', 'queued')).toEqual([
        ...replyNotes.slice(0, MAX_QUEUED_ROUNDS - 3),
        84_001,
        84_002,
        84_003,
      ]);
      expect(await queuedNotes('command', 'queued')).toEqual([
        ...commandNotes.slice(0, MAX_QUEUED_COMMANDS - 2),
        84_501,
        84_502,
      ]);
      expect(await queuedNotes('reply', 'skipped')).toEqual(
        replyNotes.slice(MAX_QUEUED_ROUNDS - 3),
      );
      expect(await queuedNotes('command', 'skipped')).toEqual(
        commandNotes.slice(MAX_QUEUED_COMMANDS - 2),
      );
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
      expect(await queueReplies(t.db, contextOf(branch), EVER, full, now)).toBe(
        MAX_QUEUED_ROUNDS + MAX_QUEUED_COMMANDS,
      );
      expect(await queuedNotes('reply', 'skipped')).toEqual(
        replyNotes.slice(MAX_QUEUED_ROUNDS - 3),
      );
      expect(await queuedNotes('command', 'skipped')).toEqual(
        commandNotes.slice(MAX_QUEUED_COMMANDS - 2),
      );
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
});
