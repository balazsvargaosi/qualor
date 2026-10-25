import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, max, or, sql } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import {
  reviewReplies,
  type ReplyKind,
  type ReplyOutcome,
  type ReplyReason,
  type ReplyVerdict,
} from '../db/schema';
import { readLlmSettings } from '../llm/settings';
import { enqueue } from '../queue/queue';
import type { CommandNote, DetectOptions, Round } from './reply-detect';
import { AI_REPLY_MAX_ATTEMPTS, AI_REPLY_QUEUE, replyKey, type ReplyPayload } from './reply-job';
import { reviewActive, reviewSettingsOf } from './settings';

export type { ReplyOutcome, ReplyReason } from '../db/schema';

/*
 * The ledger of the notes Qualor answers in a merge request (6I-4): replies in its threads and
 * commands. A note is a row once (the project, the provider, the kind and the note's id), so
 * whichever of decoration and a webhook finds it first queues its answer, and the other finds it
 * there. The job that answers writes each step on the row as it is done, so a retry resumes after
 * the last one: the model's decision first, then the id of the note posted, then the end. Every
 * write here is made once: a row that has its decision, its answer note or its end keeps them.
 *
 * What detection found (reply-detect.ts) is queued by `queueReplies`, in one short transaction: a
 * row for each new round and command, the oldest note first and a few at a time (the rest wait for
 * the next decoration), a job for each new row, and a job again for a few of the replies that were
 * skipped for the day's budget on an earlier day: the room the caps leave, and only while their row
 * is as young as a note may be (a row queued again ends again, and would never age out).
 */

/** The most tokens (input and output, over all its calls) the conversation of one reply may use. */
export const REPLY_TOKEN_BUDGET = 60_000;

/**
 * The most rounds one decoration queues, new ones and replies queued again together. The oldest go
 * first and the rest wait for the next decoration, which bounds the statements that write them and
 * the burst of jobs.
 */
export const MAX_QUEUED_ROUNDS = 50;
/** The most commands one decoration queues, as {@link MAX_QUEUED_ROUNDS} bounds the rounds. */
export const MAX_QUEUED_COMMANDS = 20;

/** A note older than this is never answered, whenever the consent was given: old threads are left alone. */
export const REPLY_MAX_AGE_DAYS = 30;

export type ReplyRow = typeof reviewReplies.$inferSelect;
export type NewReply = typeof reviewReplies.$inferInsert;

/**
 * Inserts the rows of the notes the ledger does not hold yet, and answers the ids of the new rows.
 * A note it holds already is left as it is, however the new row writes it.
 */
export async function insertReplies(db: Executor, rows: NewReply[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(reviewReplies)
    .values(rows)
    .onConflictDoNothing({
      target: [
        reviewReplies.projectId,
        reviewReplies.provider,
        reviewReplies.kind,
        reviewReplies.noteId,
      ],
    })
    .returning({ id: reviewReplies.id });
  return inserted.map((row) => row.id);
}

/**
 * The newest note the ledger holds of each thread of the merge request's branch, by the thread's
 * id. A note counts whatever became of it; one outside any thread (GitHub's top-level comment)
 * belongs to none.
 */
export async function largestNoteIds(db: Executor, branchId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ threadId: reviewReplies.threadId, largest: max(reviewReplies.noteId) })
    .from(reviewReplies)
    .where(and(eq(reviewReplies.branchId, branchId), isNotNull(reviewReplies.threadId)))
    .groupBy(reviewReplies.threadId);
  const largest = new Map<string, number>();
  for (const row of rows) {
    if (row.threadId !== null && row.largest !== null) largest.set(row.threadId, row.largest);
  }
  return largest;
}

/**
 * Takes a queued row to run: it becomes `running`, started now, and is returned. Null when the
 * row is not queued (taken, ended, or not there). A running row is never taken again here: its
 * own job's retry reads it by its id, and the queue's lease keeps any other job away.
 */
export async function claimReply(db: Executor, id: string): Promise<ReplyRow | null> {
  const [claimed] = await db
    .update(reviewReplies)
    .set({ status: 'running', startedAt: sql`now()` })
    .where(and(eq(reviewReplies.id, id), eq(reviewReplies.status, 'queued')))
    .returning();
  return claimed ?? null;
}

/** What the model decided, and what deciding spent; `costMicroUsd` is null when no prices are set. */
export interface ReplyDecision {
  verdict: ReplyVerdict;
  answer: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
}

/**
 * Stores the decision of a row that has none yet: a row decided once is never decided again. Only
 * the decision's own columns are written, whatever else the object carries: it is made of what
 * the model said.
 */
export async function recordDecision(
  db: Executor,
  id: string,
  decision: ReplyDecision,
): Promise<void> {
  await db
    .update(reviewReplies)
    .set({
      verdict: decision.verdict,
      answer: decision.answer,
      model: decision.model,
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
      costMicroUsd: decision.costMicroUsd,
    })
    .where(and(eq(reviewReplies.id, id), isNull(reviewReplies.verdict)));
}

/** Stores the id of the note Qualor posted as its answer, for a row that has none yet. */
export async function recordAnswerNote(db: Executor, id: string, noteId: number): Promise<void> {
  await db
    .update(reviewReplies)
    .set({ answerNoteId: noteId })
    .where(and(eq(reviewReplies.id, id), isNull(reviewReplies.answerNoteId)));
}

/** How a row ends: `outcome` says how a note that was handled came out, `reason` why one was not. */
export interface ReplyEnd {
  status: 'done' | 'skipped' | 'failed';
  outcome?: ReplyOutcome;
  reason?: ReplyReason;
}

/** Ends a row that is queued or running, now. An ended row is left as it is. */
export async function endReply(db: Executor, id: string, end: ReplyEnd): Promise<void> {
  await db
    .update(reviewReplies)
    .set({
      status: end.status,
      outcome: end.outcome ?? null,
      reason: end.reason ?? null,
      finishedAt: sql`now()`,
    })
    .where(and(eq(reviewReplies.id, id), inArray(reviewReplies.status, ['queued', 'running'])));
}

// ─── What decoration queues ──────────────────────────────────────────────────

/** The merge request the notes are in, as a row of the ledger knows it. */
export interface ReplyContext {
  projectId: string;
  branchId: string;
  provider: 'gitlab' | 'github';
}

/**
 * Where decoration looks for notes to answer: the newest note the ledger holds of each thread of
 * the branch, and the earliest moment a note counts from.
 */
export type ReplyWindow = Pick<DetectOptions, 'largestNoteIds' | 'since'>;

/**
 * The later of the organisation's review consent and {@link REPLY_MAX_AGE_DAYS} days before `now`:
 * a note before it is never answered, so switching review on does not answer a project's old
 * threads.
 */
export function repliesSince(consentAt: string, now: Date): Date {
  const oldest = now.getTime() - REPLY_MAX_AGE_DAYS * 86_400_000;
  return new Date(Math.max(Date.parse(consentAt), oldest));
}

/**
 * The window of a decoration of the project's branch, or null when Qualor answers nothing there:
 * AI review is not active for the project.
 */
export async function replyWindow(
  db: Executor,
  project: { id: string; organizationId: string; scmConnectionId: string | null },
  branchId: string,
  now: Date = new Date(),
): Promise<ReplyWindow | null> {
  const settings = await readLlmSettings(db);
  const consent = reviewSettingsOf(settings, project.organizationId).consent;
  // An active review has a consent, which names the provider configured now.
  if (!reviewActive(settings, project).active || consent === null) return null;
  return {
    largestNoteIds: await largestNoteIds(db, branchId),
    since: repliesSince(consent.at, now),
  };
}

/** The start of the UTC day `now` is in, which the day's budget counts from. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The thread ids the ledger's CHECK takes and a reply can be posted to: a GitLab discussion's
 * lower-case hexadecimal id, or the digits of a GitHub comment's id.
 */
const THREAD_ID = /^[0-9a-f]{1,64}$|^[0-9]{1,20}$/;
/** The longest author name the ledger keeps. */
const MAX_AUTHOR_CHARS = 255;

/**
 * The first `limit` of `items` by note id, the oldest first: what is left waits for the next
 * decoration. Rows go in by note id, so two transactions that find the same notes take them in
 * one order, and neither can wait on a row the other takes later: they cannot deadlock.
 */
function oldest<T>(items: readonly T[], noteOf: (item: T) => number, limit: number): T[] {
  return items.toSorted((a, b) => noteOf(a) - noteOf(b)).slice(0, limit);
}

/** Queues the job that answers each of the rows `replyIds`, after the jobs the branch has. */
async function enqueueAnswers(
  db: Executor,
  branchId: string,
  replyIds: readonly string[],
): Promise<void> {
  for (const replyId of replyIds) {
    await enqueue(db, {
      queue: AI_REPLY_QUEUE,
      payload: { kind: 'answer', replyId } satisfies ReplyPayload,
      concurrencyKey: replyKey(branchId),
      maxAttempts: AI_REPLY_MAX_ATTEMPTS,
    });
  }
}

/** The rounds a pass queues: those the ledger can hold, the oldest {@link MAX_QUEUED_ROUNDS}. */
function roundsToQueue(rounds: readonly Round[]): Round[] {
  return oldest(
    rounds.filter((round) => THREAD_ID.test(round.threadId)),
    (round) => round.newest,
    MAX_QUEUED_ROUNDS,
  );
}

/**
 * The commands a pass queues, chosen as {@link roundsToQueue} chooses rounds: the oldest
 * {@link MAX_QUEUED_COMMANDS}.
 */
function commandsToQueue(notes: readonly CommandNote[]): CommandNote[] {
  return oldest(
    notes.filter((note) => note.threadId === null || THREAD_ID.test(note.threadId)),
    (note) => note.noteId,
    MAX_QUEUED_COMMANDS,
  );
}

/**
 * Queues the answers to `rounds` (reply-detect.ts): a row for each, which is its newest note's,
 * and a job for each new row. Given a transaction, it writes them in it. At most
 * {@link MAX_QUEUED_ROUNDS}, the oldest first; a round the ledger cannot hold is left out and takes
 * no place. A note the ledger holds already gets no new row and no new job. Answers how many jobs
 * it queued.
 */
export async function queueRounds(
  db: Executor,
  ctx: ReplyContext,
  rounds: readonly Round[],
): Promise<number> {
  const ids = await insertReplies(
    db,
    roundsToQueue(rounds).map((round) => ({
      projectId: ctx.projectId,
      branchId: ctx.branchId,
      provider: ctx.provider,
      noteId: round.newest,
      threadId: round.threadId,
      issueId: round.issueId,
      kind: 'reply',
      author: round.author.slice(0, MAX_AUTHOR_CHARS),
    })),
  );
  await enqueueAnswers(db, ctx.branchId, ids);
  return ids.length;
}

/**
 * Queues the answers to `notes`, the commands people gave (reply-detect.ts), as
 * {@link queueRounds} does for rounds, at most {@link MAX_QUEUED_COMMANDS} of them. A GitLab
 * command has the discussion it opened, which its answer goes into; a GitHub one is in no thread.
 */
export async function queueCommands(
  db: Executor,
  ctx: ReplyContext,
  notes: readonly CommandNote[],
): Promise<number> {
  const ids = await insertReplies(
    db,
    commandsToQueue(notes).map((note) => ({
      projectId: ctx.projectId,
      branchId: ctx.branchId,
      provider: ctx.provider,
      noteId: note.noteId,
      threadId: note.threadId,
      kind: 'command',
      command: note.command,
      author: note.author.slice(0, MAX_AUTHOR_CHARS),
    })),
  );
  await enqueueAnswers(db, ctx.branchId, ids);
  return ids.length;
}

/** What {@link requeueBudgetSkips} may queue again. */
export interface RequeueBounds {
  /** Only skips that ended before this: the start of the day, which has a budget of its own. */
  dayStart: Date;
  /**
   * Only rows made at or after this, as detection counts notes ({@link repliesSince}). An older
   * row has aged out: queued again it would end skipped again with a new end, and housekeeping,
   * which deletes a finished row by its end, would never reach it.
   */
  since: Date;
  /** The most replies, and the most commands, to queue again: the room the caps have left. */
  rounds: number;
  commands: number;
}

/**
 * Moves the branch's replies and commands that were skipped for the day's budget back to `queued`
 * (a new day has a new budget), within `bounds`: skips of an earlier day, whose row is no older
 * than the window, the oldest note first up to the room of each kind. Their end is cleared and
 * their start is kept (a queued row may have one: the job that takes it starts it again). Answers
 * their ids, the oldest note first. The others stay as they are: a skip of the day itself until
 * the day is over, an aged row for housekeeping, the rest for a later pass. A row that two writers
 * choose at once is queued again by one of them.
 */
export async function requeueBudgetSkips(
  db: Executor,
  branchId: string,
  bounds: RequeueBounds,
): Promise<string[]> {
  const skippedForBudget = and(
    eq(reviewReplies.status, 'skipped'),
    eq(reviewReplies.reason, 'budget_spent'),
  );
  const oldestSkips = (kind: ReplyKind, room: number) =>
    db
      .select({ id: reviewReplies.id })
      .from(reviewReplies)
      .where(
        and(
          eq(reviewReplies.branchId, branchId),
          eq(reviewReplies.kind, kind),
          skippedForBudget,
          lt(reviewReplies.finishedAt, bounds.dayStart),
          gte(reviewReplies.createdAt, bounds.since),
        ),
      )
      .orderBy(asc(reviewReplies.noteId))
      .limit(Math.max(0, room));
  const requeued = await db
    .update(reviewReplies)
    .set({ status: 'queued', outcome: null, reason: null, finishedAt: null })
    .where(
      and(
        eq(reviewReplies.branchId, branchId),
        // Again what makes a row a skip for the budget: one another writer queued meanwhile is no
        // longer one, and is left to that writer.
        skippedForBudget,
        or(
          inArray(reviewReplies.id, oldestSkips('reply', bounds.rounds)),
          inArray(reviewReplies.id, oldestSkips('command', bounds.commands)),
        ),
      ),
    )
    .returning({ id: reviewReplies.id, noteId: reviewReplies.noteId });
  return requeued.toSorted((a, b) => a.noteId - b.noteId).map((row) => row.id);
}

/**
 * What a decoration (or a webhook's scan) does with the notes it found, in one transaction. The
 * caps are the pass's, new notes and old together: the new rounds and commands count first, and
 * the replies skipped for the budget of an earlier day are queued again in the room that is left
 * (`requeueBudgetSkips`, within `window`: a row older than the window stays as it is). Each new or
 * requeued row has its answer job, the requeued ones first: their notes are the older. A row and
 * its job are written together or not at all. Answers how many jobs it queued.
 */
export async function queueReplies(
  db: Db,
  ctx: ReplyContext,
  window: Pick<ReplyWindow, 'since'>,
  found: { rounds: readonly Round[]; commands: readonly CommandNote[] },
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const rounds = roundsToQueue(found.rounds);
    const commands = commandsToQueue(found.commands);
    const again = await requeueBudgetSkips(tx, ctx.branchId, {
      dayStart: utcDayStart(now),
      since: window.since,
      rounds: MAX_QUEUED_ROUNDS - rounds.length,
      commands: MAX_QUEUED_COMMANDS - commands.length,
    });
    await enqueueAnswers(tx, ctx.branchId, again);
    const queuedRounds = await queueRounds(tx, ctx, rounds);
    const queuedCommands = await queueCommands(tx, ctx, commands);
    return again.length + queuedRounds + queuedCommands;
  });
}
