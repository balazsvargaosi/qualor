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
 * commands. A note is a row once (the project, the provider, the kind and the note's id), so
 * whichever of decoration and a webhook finds it first queues its answer, and the other finds it
 * there. The job that answers writes each step on the row as it is done, so a retry resumes after
 * the last one: the model's decision first, then the status the reply changed, then the id of the
 * note posted, then the end. A command makes no model call: its decision is the fixed text it is
 * answered with and the outcome, stored once the run it asked for is made. Every write here is made
 * once: a row that has its decision, its change, its answer note or its end keeps them, but for a
 * superseded row's decision, dropped with its end.
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

/**
 * Stores that the row's reply changed its issue's status to `status` (its `outcome`, which the end
 * keeps), for a running row that has none yet, in the transaction that changed the status: a job
 * that takes the row again knows it so, and changes nothing a second time.
 */
export async function recordStatusChange(
  db: Executor,
  id: string,
  status: 'wont_fix' | 'false_positive',
): Promise<void> {
  await db
    .update(reviewReplies)
    .set({ outcome: status })
    .where(
      and(
        eq(reviewReplies.id, id),
        eq(reviewReplies.status, 'running'),
        isNull(reviewReplies.outcome),
      ),
    );
}

/**
 * Stores what a command row is answered with, for a row that has no answer yet: the fixed text, and
 * the outcome its end keeps. It is written in the transaction that carried the decision out (the
 * run it made or restarted), so that a job that takes the row again posts this text and decides
 * nothing a second time.
 */
export async function recordCommandDecision(
  db: Executor,
  id: string,
  decision: { outcome: ReplyOutcome; text: string },
): Promise<void> {
  await db
    .update(reviewReplies)
    .set({ answer: decision.text, outcome: decision.outcome })
    .where(and(eq(reviewReplies.id, id), isNull(reviewReplies.answer)));
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
  /**
   * The row's decision (its verdict and answer) is dropped with the end, what it spent kept: a
   * superseded row's, which no older round may then take for a round that answers its notes.
   */
  dropDecision?: boolean;
}

/**
 * Ends a row that is queued or running, now. An ended row is left as it is. An outcome the row
 * recorded before its end (the status its reply changed, the decision of its command) stays when
 * the end names none: what the row did happened, whatever ended it afterwards.
 */
export async function endReply(db: Executor, id: string, end: ReplyEnd): Promise<void> {
  await db
    .update(reviewReplies)
    .set({
      status: end.status,
      ...(end.outcome === undefined ? {} : { outcome: end.outcome }),
      reason: end.reason ?? null,
      ...(end.dropDecision === true ? { verdict: null, answer: null } : {}),
      finishedAt: sql`now()`,
    })
    .where(and(eq(reviewReplies.id, id), inArray(reviewReplies.status, ['queued', 'running'])));
}
