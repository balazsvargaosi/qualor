import { z } from 'zod';

/*
 * The `ai-reply` queue (6I-4): the jobs that answer what people write in a merge request, on the
 * review worker beside the reviews. Decoration and the webhooks queue them; the ledger's row for a
 * note (replies.ts) holds what an answer job needs to know and what it has done.
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
