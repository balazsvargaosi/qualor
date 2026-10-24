import { and, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import {
  reviewReplies,
  type ReplyOutcome,
  type ReplyReason,
  type ReplyVerdict,
} from '../db/schema';

export type { ReplyOutcome, ReplyReason } from '../db/schema';

/*
 * The ledger of the notes Qualor answers in a merge request (6I-4): replies in its threads and
 * commands. A note is a row once (the project, the provider and the note's id), so whichever of
 * decoration and a webhook finds it first queues its answer, and the other finds it there. The job
 * that answers writes each step on the row as it is done, so a retry resumes after the last one:
 * the model's decision first, then the id of the note posted, then the end. Every write here is
 * made once: a row that has its decision, its answer note or its end keeps them.
 */

/** The most tokens (input and output, over all its calls) the conversation of one reply may use. */
export const REPLY_TOKEN_BUDGET = 60_000;

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
      target: [reviewReplies.projectId, reviewReplies.provider, reviewReplies.noteId],
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

/** Stores the decision of a row that has none yet: a row decided once is never decided again. */
export async function recordDecision(
  db: Executor,
  id: string,
  decision: ReplyDecision,
): Promise<void> {
  await db
    .update(reviewReplies)
    .set(decision)
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
