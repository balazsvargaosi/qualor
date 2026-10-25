import { and, asc, eq, gt, gte, inArray, lt, notExists, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db, Executor } from '../db/client';
import { issues, jobs, reviewReplies, THREAD_ID, type ReplyKind } from '../db/schema';
import { readLlmSettings } from '../llm/settings';
import { enqueue } from '../queue/queue';
import { insertReplies, largestNoteIds } from './replies';
import type { CommandNote, DetectOptions, Round } from './reply-detect';
import { REVIEW_AFTER_STOP_SECONDS } from './runs';
import { reviewActive, reviewSettingsOf } from './settings';

/*
 * The queue of the answers to what people write in a merge request (6I-4). Detection
 * (reply-detect.ts) finds the new replies in Qualor's threads and the notes that give a command;
 * `queueReplies` writes what it found, in one short transaction: a row of the replies ledger
 * (replies.ts) for each note that is new to the project, and the `ai-reply` job that answers it,
 * which the review worker runs beside the reviews (reply-job.ts). Nothing else writes these rows
 * and jobs (the job's own stop, and its wait for an SCM circuit, queue its row again here too), so
 * a row is queued exactly when its job is, and the sweep below ends a row its job left running.
 *
 * A pass is bounded: at most 50 rounds and 20 commands, new ones and notes queued again together,
 * the oldest first, and the rest wait for the next pass. The caps count only what the ledger does
 * not hold already: detection hands over every command in the window each time, and a note that
 * was queued takes no place of the cap that a note nobody queued yet could have.
 */

export const AI_REPLY_QUEUE = 'ai-reply';

/**
 * A job is tried twice at most: the second try is for an error before the answer was decided or
 * for a lease that expired, and resumes after the last step the row records.
 */
export const AI_REPLY_MAX_ATTEMPTS = 2;

/** The jobs of one merge request run one at a time, in the order they were queued. */
export function replyKey(branchId: string): string {
  return `ai-reply:branch:${branchId}`;
}

/**
 * What a job is for: answering the note a ledger row holds, or reading a merge request's notes
 * through the API for the ones nobody has queued yet (a webhook's, which never trusts the text it
 * carries).
 */
export const replyPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), replyId: z.uuid() }),
  z.object({ kind: z.literal('scan'), branchId: z.uuid() }),
]);
export type ReplyPayload = z.infer<typeof replyPayload>;

/**
 * The most rounds one pass queues, new ones and replies queued again together. The oldest go first
 * and the rest wait for the next pass, which bounds the statements that write them and the burst
 * of jobs.
 */
export const MAX_QUEUED_ROUNDS = 50;
/** The most commands one pass queues, as {@link MAX_QUEUED_ROUNDS} bounds the rounds. */
export const MAX_QUEUED_COMMANDS = 20;

/** A note older than this is never answered, whenever the consent was given: old threads are left alone. */
export const REPLY_MAX_AGE_DAYS = 30;

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

/** The longest author name the ledger keeps. */
const MAX_AUTHOR_CHARS = 255;

/**
 * The first `limit` of `items` by note id, the oldest first: what is left waits for the next
 * pass. Rows go in by note id, so two transactions that find the same notes take them in one
 * order, and neither can wait on a row the other takes later: they cannot deadlock.
 */
function oldest<T>(items: readonly T[], noteOf: (item: T) => number, limit: number): T[] {
  return items.toSorted((a, b) => noteOf(a) - noteOf(b)).slice(0, limit);
}

/**
 * Queues the job that answers each of the rows `replyIds`, after the jobs the branch has, due at
 * `runAt` (now when left out).
 */
async function enqueueAnswers(
  db: Executor,
  branchId: string,
  replyIds: readonly string[],
  runAt?: SQL,
): Promise<void> {
  for (const replyId of replyIds) {
    await enqueue(db, {
      queue: AI_REPLY_QUEUE,
      payload: { kind: 'answer', replyId } satisfies ReplyPayload,
      concurrencyKey: replyKey(branchId),
      maxAttempts: AI_REPLY_MAX_ATTEMPTS,
      ...(runAt === undefined ? {} : { runAt }),
    });
  }
}

/**
 * A running row queued again, its start kept (a queued row may have one), with a new job due in
 * `seconds`, in one transaction: the job that gave it back ends, and no try of the new one is
 * spent yet. Answers whether the row was still running.
 */
async function queueAgain(
  db: Db,
  reply: { id: string; branchId: string },
  seconds: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [queued] = await tx
      .update(reviewReplies)
      .set({ status: 'queued' })
      .where(and(eq(reviewReplies.id, reply.id), eq(reviewReplies.status, 'running')))
      .returning({ id: reviewReplies.id });
    if (queued === undefined) return false;
    await enqueueAnswers(
      tx,
      reply.branchId,
      [reply.id],
      sql`now() + make_interval(secs => ${seconds})`,
    );
    return true;
  });
}

/**
 * A running row whose answer the stopping server gave up before anything was decided: it is
 * queued again with a new job a few seconds on, for another replica or for this server once it is
 * up again (not at once, so that a worker of the stopping server that is still polling does not
 * take it straight back). Answers whether the row was still running.
 */
export async function queueAfterStop(
  db: Db,
  reply: { id: string; branchId: string },
): Promise<boolean> {
  return queueAgain(db, reply, REVIEW_AFTER_STOP_SECONDS);
}

/**
 * How long an answer waits for its SCM connection's circuit when the circuit cannot tell when it
 * lets a job through: it is half-open, and another job's probe has no answer yet.
 */
export const REPLY_CIRCUIT_WAIT_SECONDS = 60;

/**
 * A running row whose job found its SCM connection's circuit closed to it before its own requests
 * (reply-job.ts): it is queued again with a new job due in `waitSeconds`, when the circuit lets a
 * job through again. Nothing of the wait is written on the row. Answers whether the row was still
 * running.
 */
export async function queueAfterCircuit(
  db: Db,
  reply: { id: string; branchId: string },
  waitSeconds: number,
): Promise<boolean> {
  return queueAgain(db, reply, waitSeconds);
}

/**
 * The rows that are `running` with no `ai-reply` job queued or running for them: their job is gone
 * for good (its lease expired on both tries, or both tries failed), so nothing would ever end them.
 * After every reap of the review worker (main.ts) each ends `failed: internal` here, as the sweep of
 * the review runs ends a run without its job (runs.ts). Decided by whether a job is there, never by
 * the row's age: a job that runs keeps its lease. A row and its job are written together (above),
 * and a row is running only while a job has taken it, so one statement is enough. Answers how many
 * it ended.
 */
export async function reconcileStuckReplies(db: Executor): Promise<number> {
  const ended = await db
    .update(reviewReplies)
    .set({ status: 'failed', outcome: null, reason: 'internal', finishedAt: sql`now()` })
    .where(
      and(
        eq(reviewReplies.status, 'running'),
        // Compared as text, so that a malformed payload never fails the statement.
        sql`NOT EXISTS (SELECT 1 FROM ${jobs}
                         WHERE ${jobs.queue} = ${AI_REPLY_QUEUE}
                           AND ${jobs.status} IN ('queued', 'running')
                           AND ${jobs.payload} ->> 'replyId' = ${reviewReplies.id}::text)`,
      ),
    )
    .returning({ id: reviewReplies.id });
  return ended.length;
}

/**
 * The rounds that are for an issue of the project: a thread whose marker names the issue of
 * another Qualor project of a monorepo, or one that was deleted, is none of its answering.
 */
async function ownRounds(
  db: Executor,
  ctx: ReplyContext,
  rounds: readonly Round[],
): Promise<Round[]> {
  if (rounds.length === 0) return [];
  const ids = [...new Set(rounds.map((round) => round.issueId))];
  const found = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(inArray(issues.id, ids), eq(issues.projectId, ctx.projectId)));
  const own = new Set(found.map((issue) => issue.id));
  return rounds.filter((round) => own.has(round.issueId));
}

/**
 * The notes of the rounds and of the commands that the ledger holds already, whatever became of
 * them, by one read of its unique index (the project, the provider, the kind and the note).
 */
async function heldNotes(
  db: Executor,
  ctx: ReplyContext,
  notes: { rounds: readonly number[]; commands: readonly number[] },
): Promise<{ rounds: Set<number>; commands: Set<number> }> {
  const kinds = [
    ...(notes.rounds.length === 0
      ? []
      : [and(eq(reviewReplies.kind, 'reply'), inArray(reviewReplies.noteId, [...notes.rounds]))]),
    ...(notes.commands.length === 0
      ? []
      : [
          and(
            eq(reviewReplies.kind, 'command'),
            inArray(reviewReplies.noteId, [...notes.commands]),
          ),
        ]),
  ];
  const held = { rounds: new Set<number>(), commands: new Set<number>() };
  if (kinds.length === 0) return held;
  const rows = await db
    .select({ kind: reviewReplies.kind, noteId: reviewReplies.noteId })
    .from(reviewReplies)
    .where(
      and(
        eq(reviewReplies.projectId, ctx.projectId),
        eq(reviewReplies.provider, ctx.provider),
        or(...kinds),
      ),
    );
  for (const row of rows) (row.kind === 'reply' ? held.rounds : held.commands).add(row.noteId);
  return held;
}

/**
 * The rounds and commands of `found` that are the project's to queue and new to its ledger. The
 * ones detection handed over again are dropped before the caps count anything: detection has no
 * ledger bound for a command, and a round the ledger holds was queued by a pass that ran at the
 * same time.
 */
async function newNotes(
  db: Executor,
  ctx: ReplyContext,
  found: { rounds: readonly Round[]; commands: readonly CommandNote[] },
): Promise<{ rounds: Round[]; commands: CommandNote[] }> {
  const rounds = await ownRounds(db, ctx, found.rounds);
  const held = await heldNotes(db, ctx, {
    rounds: rounds.map((round) => round.newest),
    commands: found.commands.map((note) => note.noteId),
  });
  return {
    rounds: rounds.filter((round) => !held.rounds.has(round.newest)),
    commands: found.commands.filter((note) => !held.commands.has(note.noteId)),
  };
}

/**
 * Writes the rows of `rounds` (the ledger's row of a round is its newest note's), the first
 * {@link MAX_QUEUED_ROUNDS} by note id; a round the ledger cannot hold is left out and takes no
 * place. Answers the ids of the rows it made.
 */
function insertRounds(
  db: Executor,
  ctx: ReplyContext,
  rounds: readonly Round[],
): Promise<string[]> {
  const queued = oldest(
    rounds.filter((round) => THREAD_ID.test(round.threadId)),
    (round) => round.newest,
    MAX_QUEUED_ROUNDS,
  );
  return insertReplies(
    db,
    queued.map((round) => ({
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
}

/**
 * Writes the rows of the commands in `notes`, as {@link insertRounds} writes rounds, the first
 * {@link MAX_QUEUED_COMMANDS}. A GitLab command has the discussion it opened, which its answer goes
 * into; a GitHub one is in no thread.
 */
function insertCommands(
  db: Executor,
  ctx: ReplyContext,
  notes: readonly CommandNote[],
): Promise<string[]> {
  const queued = oldest(
    notes.filter((note) => note.threadId === null || THREAD_ID.test(note.threadId)),
    (note) => note.noteId,
    MAX_QUEUED_COMMANDS,
  );
  return insertReplies(
    db,
    queued.map((note) => ({
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
}

/** What {@link requeueBudgetSkips} may queue again. */
interface RequeueBounds {
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
 * than the window, the oldest note first up to the room of each kind. Only the newest row of a
 * thread: the newer round of a thread reads its older notes anyway. Their end is cleared and their
 * start is kept (a queued row may have one: the job that takes it starts it again). Answers their
 * ids, the oldest note first. The others stay as they are: a skip of the day itself until the day
 * is over, an aged row for housekeeping, a row with a newer one in its thread for good, the rest
 * for a later pass. A row that two writers choose at once is queued again by one of them.
 */
async function requeueBudgetSkips(
  db: Executor,
  branchId: string,
  bounds: RequeueBounds,
): Promise<string[]> {
  const skippedForBudget = and(
    eq(reviewReplies.status, 'skipped'),
    eq(reviewReplies.reason, 'budget_spent'),
  );
  const newer = alias(reviewReplies, 'newer');
  /** Whether the thread of the row has a row of a newer note; a row in no thread has none. */
  const hasNewerRow = () =>
    db
      .select({ one: sql`1` })
      .from(newer)
      .where(
        and(
          eq(newer.branchId, reviewReplies.branchId),
          eq(newer.threadId, reviewReplies.threadId),
          gt(newer.noteId, reviewReplies.noteId),
        ),
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
          notExists(hasNewerRow()),
        ),
      )
      .orderBy(asc(reviewReplies.noteId))
      .limit(room);
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
 * rounds and commands are the project's and new to its ledger (`newNotes`); their rows are written
 * first, within the caps; the replies skipped for the budget of an earlier day are queued again in
 * the room those leave (`requeueBudgetSkips`, within `window`: a row older than the window stays
 * as it is); and each row written or queued again has its answer job, the requeued ones first:
 * their notes are the older. A row and its job are written together or not at all. Answers how
 * many jobs it queued.
 */
export async function queueReplies(
  db: Db,
  ctx: ReplyContext,
  window: Pick<ReplyWindow, 'since'>,
  found: { rounds: readonly Round[]; commands: readonly CommandNote[] },
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const fresh = await newNotes(tx, ctx, found);
    const rounds = await insertRounds(tx, ctx, fresh.rounds);
    const commands = await insertCommands(tx, ctx, fresh.commands);
    const again = await requeueBudgetSkips(tx, ctx.branchId, {
      dayStart: utcDayStart(now),
      since: window.since,
      rounds: MAX_QUEUED_ROUNDS - rounds.length,
      commands: MAX_QUEUED_COMMANDS - commands.length,
    });
    const answered = [...again, ...rounds, ...commands];
    await enqueueAnswers(tx, ctx.branchId, answered);
    return answered.length;
  });
}
