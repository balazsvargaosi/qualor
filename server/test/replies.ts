import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { jobs, reviewReplies } from '../src/db/schema';
import { DEFAULT_LLM_SETTINGS, readLlmSettings, writeLlmSettings } from '../src/llm/settings';
import { AI_REPLY_QUEUE, replyKey } from '../src/review/reply-job';
import type { FakeLlm } from './fake-llm';
import type { IngestHarness } from './ingest';
import { switchReviewOn } from './review';

/*
 * What the decoration tests of the replies and commands (6I-4) share: AI review switched on and off
 * for the harness's organisation, and what a decoration queued for a branch.
 */

/**
 * AI review on for every project of the harness's organisation, against the fake provider. The
 * consent was given an hour ago unless `consentAt` says otherwise, so a note made now is after it:
 * GitHub dates a note to the second, which a consent given this second could postdate.
 */
export function reviewOn(
  h: IngestHarness,
  llm: FakeLlm,
  consentAt: Date = new Date(Date.now() - 3_600_000),
): Promise<void> {
  return switchReviewOn(h.ctx.db, {
    secretKey: h.ctx.config.secretKey,
    fake: llm,
    organizationId: h.organizationId,
    userId: h.ctx.adminId,
    consentAt,
  });
}

/** The instance's AI settings as a new server has them: no provider, so AI review is off for everyone. */
export function reviewOff(h: IngestHarness): Promise<void> {
  return writeLlmSettings(h.ctx.db, DEFAULT_LLM_SETTINGS);
}

/**
 * The scope of the organisation's AI review, which {@link reviewOn} set to every project:
 * `selected` lists no project, so none is in it.
 */
export async function reviewScope(h: IngestHarness, scope: 'all' | 'selected'): Promise<void> {
  const settings = await readLlmSettings(h.ctx.db);
  const organization = settings.organizations[h.organizationId];
  if (organization === undefined) throw new Error('AI review is not on for the organisation');
  await writeLlmSettings(h.ctx.db, {
    ...settings,
    organizations: {
      ...settings.organizations,
      [h.organizationId]: { ...organization, review: { ...organization.review, scope } },
    },
  });
}

/**
 * What decoration queued for a branch: the ledger's rows, the oldest note first, and the
 * `ai-reply` jobs of the branch in the order they were queued.
 */
export async function queuedAnswers(db: Db, branchId: string) {
  const rows = await db
    .select()
    .from(reviewReplies)
    .where(eq(reviewReplies.branchId, branchId))
    .orderBy(asc(reviewReplies.noteId));
  const queued = await db
    .select({
      payload: jobs.payload,
      key: jobs.concurrencyKey,
      maxAttempts: jobs.maxAttempts,
      status: jobs.status,
    })
    .from(jobs)
    .where(and(eq(jobs.queue, AI_REPLY_QUEUE), eq(jobs.concurrencyKey, replyKey(branchId))))
    .orderBy(asc(jobs.id));
  return { rows, jobs: queued };
}

/** The job that answers the ledger's row `replyId`, as decoration queues it. */
export function answerJob(branchId: string, replyId: string) {
  return {
    payload: { kind: 'answer', replyId },
    key: replyKey(branchId),
    maxAttempts: 2,
    status: 'queued',
  };
}
