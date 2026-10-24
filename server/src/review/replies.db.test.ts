import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { first } from '../db/rows';
import { branches, organizations, projects, reviewReplies } from '../db/schema';
import {
  claimReply,
  endReply,
  insertReplies,
  largestNoteIds,
  type NewReply,
  recordAnswerNote,
  recordDecision,
  REPLY_TOKEN_BUDGET,
  type ReplyRow,
} from './replies';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const THREAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

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
    expect(
      await insertReplies(t.db, [
        { ...note, author: 'mallory', threadId: '1234', kind: 'command', command: 'stop' },
      ]),
    ).toEqual([]);
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

  it('a note is the project and provider’s, not the branch’s', async () => {
    const note = reply({ noteId: 600 });
    expect(await insertReplies(t.db, [note])).toHaveLength(1);
    // The same note on another branch is the same note; on the other provider, another one.
    expect(await insertReplies(t.db, [{ ...note, branchId: otherBranchId }])).toEqual([]);
    expect(await insertReplies(t.db, [{ ...note, provider: 'github' }])).toHaveLength(1);
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
});
