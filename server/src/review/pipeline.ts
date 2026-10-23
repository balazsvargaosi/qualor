import { parseModelJson } from '@qualor/shared';
import type { z } from 'zod';
import type { ReviewFailureReason, ReviewPhase, ReviewTier } from '../db/schema';
import { SENSITIVE_PATH, type ReviewableChange, type ReviewContext } from './context';
import type { ConversationResult } from './conversation';
import { envelope, newNonce } from './envelope';
import { scrubKeyDeep } from './key-scrub';
import {
  judgeData,
  RETRY_TEXT,
  SPECIALISTS,
  specialistData,
  verifyData,
  type LabelledFinding,
  type ReviewRole,
  type Specialist,
} from './prompts';
import {
  judgeAnswerSchema,
  reviewFindingOf,
  specialistAnswerSchema,
  verifyAnswerSchema,
  type JudgeAnswer,
  type PriorStatus,
  type ReviewFinding,
  type VerifyVerdict,
} from './schemas';

export type { ReviewRole, Specialist } from './prompts';
export type { ReviewFinding } from './schemas';

/*
 * The review of a merge request, from its context to the findings it stores (spec §6.3). The size
 * of the change picks the specialist reviewers; they report with recall first, one after the other;
 * a judge reads the code behind their findings and keeps, merges or drops each with a reason,
 * re-checks what an earlier review raised and writes the summary; and every serious security
 * finding it keeps is checked again by a conversation given that finding alone.
 *
 * Every answer is read with parseModelJson, has the provider's key taken out, and must match its
 * strict schema (schemas.ts); one that does not is asked for once more. A reviewer that still does
 * not answer in its JSON adds nothing, and a judge that does not fails the review (fail closed).
 *
 * The review's token budget is shared out between the stages: 55 % for the specialists, each in
 * turn given an even part of what is left of it; 35 % for the judge, which what the specialists
 * spent past their share does not touch; 10 % for the verification, within what is left of the
 * whole budget. What a conversation spent is taken from its stage's share, whichever way it ended.
 * A conversation that used up its part answers through its wrap-up, and one with nothing left does
 * not run; the review goes on, with `tokenLimitReached`. Only a judge cannot be done without.
 *
 * Nothing here calls a provider: `deps.converse` does, with the role's system prompt, the tools and
 * the first message it is given.
 */

/** The tiers by size: lines added plus removed over the reviewed changes, and their files. */
export const TIER_LIMITS = { trivialLines: 10, liteLines: 300, liteFiles: 20 } as const;
const TIER_SPECIALISTS: Readonly<Record<ReviewTier, readonly Specialist[]>> = {
  trivial: ['quality'],
  lite: ['quality', 'tests'],
  full: SPECIALISTS,
};

/** Percent of the review's token budget each stage may spend. */
export const STAGE_SHARES = { specialists: 55, judge: 35, verification: 10 } as const;
/** The serious security findings verified in one review, at most. */
export const MAX_VERIFICATIONS = 5;

export interface JudgedFinding extends ReviewFinding {
  /** The ids of the specialist findings it comes from (`s1`, `s2`, …). */
  sources: string[];
  /** The prior finding it is, re-emitted; only an id the judge was given. */
  priorId: string | null;
  /** The independent verification of a serious security finding; null when it was not verified. */
  verification: 'confirmed' | 'needs_validation' | null;
}

export interface PriorVerdict {
  id: string;
  status: PriorStatus;
  reason: string;
}

/**
 * What the review says of itself in the summary: a reviewer whose answers could not be read, a
 * stage that reached its share of the tokens, more serious security findings than are verified.
 */
export type ReviewNote = 'reviewer_unreadable' | 'token_limit_reached' | 'verification_capped';

export type PipelineOutcome =
  | {
      kind: 'reviewed';
      tier: ReviewTier;
      /** The specialists that ran, in their order: one with no tokens left does not run. */
      specialists: Specialist[];
      findings: JudgedFinding[];
      prior: PriorVerdict[];
      summary: { verdict: string; walkthrough: string[] };
      tokenLimitReached: boolean;
      notes: ReviewNote[];
    }
  | { kind: 'failed'; reason: ReviewFailureReason }
  | { kind: 'stopped' };

export interface PipelineDeps {
  /**
   * One conversation of a role over the tools. `user` is the envelope built with `nonce` (with the
   * retry sentence after it when an answer is asked for again); the job's implementation runs
   * `runConversation` with that nonce for the tool results, and with `tokenBudget`, which is more
   * than 0.
   */
  converse(
    role: ReviewRole,
    user: string,
    nonce: string,
    tokenBudget: number,
  ): Promise<ConversationResult>;
  /** The provider's API key, taken out of every answer before it is used; null when there is none. */
  providerKey: string | null;
}

/**
 * The tier of a review and its specialists, in their order: by the lines the reviewed changes add
 * and remove, and their number. A reviewed path that looks security-sensitive adds the security
 * reviewer at any tier.
 */
export function planReview(reviewed: readonly ReviewableChange[]): {
  tier: ReviewTier;
  specialists: Specialist[];
  changedLines: number;
  files: number;
} {
  const changedLines = reviewed.reduce((sum, change) => sum + change.changedLines, 0);
  const files = reviewed.length;
  const tier: ReviewTier =
    changedLines <= TIER_LIMITS.trivialLines
      ? 'trivial'
      : changedLines <= TIER_LIMITS.liteLines && files <= TIER_LIMITS.liteFiles
        ? 'lite'
        : 'full';
  const chosen = new Set<Specialist>(TIER_SPECIALISTS[tier]);
  if (reviewed.some((change) => SENSITIVE_PATH.test(change.path))) chosen.add('security');
  return { tier, specialists: SPECIALISTS.filter((s) => chosen.has(s)), changedLines, files };
}

/** `percent` of the budget, in whole tokens; nothing of a budget that is not a positive number. */
function shareOf(budget: number, percent: number): number {
  return Number.isFinite(budget) && budget > 0
    ? Math.floor((Math.floor(budget) * percent) / 100)
    : 0;
}

/** What a stage may still spend. */
interface Share {
  left: number;
}

/** How one conversation slot ended. */
type Asked<T> =
  | { kind: 'answer'; value: T }
  /** It ran and gave nothing usable: no answer, or none of its schema after the retry. */
  | { kind: 'unread' }
  /** It had no tokens to start with, and did not run. */
  | { kind: 'no_tokens' }
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: 'provider_error' | 'provider_no_tools' };

/** The state of one review: what it has noted of itself. */
class Review {
  tokenLimitReached = false;
  readonly notes: ReviewNote[] = [];
  /** Tokens spent by every conversation so far, however it ended. */
  spent = 0;

  constructor(private readonly deps: PipelineDeps) {}

  note(note: ReviewNote): void {
    if (!this.notes.includes(note)) this.notes.push(note);
  }

  limitReached(): void {
    this.tokenLimitReached = true;
    this.note('token_limit_reached');
  }

  /**
   * One slot of a stage: a conversation of `role` over `data` with `tokens` to spend, and when its
   * answer does not match `schema`, one more with what is left of them, the same data under a new
   * nonce and the retry sentence after it. A conversation that ends without an answer (the loop's
   * bad answer) is not asked again. What each conversation spent is taken from `share`.
   */
  async ask<T>(
    role: ReviewRole,
    data: unknown,
    schema: z.ZodType<T>,
    tokens: number,
    share: Share,
  ): Promise<Asked<T>> {
    let left = tokens;
    for (const retry of [false, true]) {
      if (left <= 0) {
        this.limitReached();
        return retry ? { kind: 'unread' } : { kind: 'no_tokens' };
      }
      const nonce = newNonce();
      const first = envelope(data, nonce);
      const result = await this.deps.converse(
        role,
        retry ? `${first}\n\n${RETRY_TEXT}` : first,
        nonce,
        left,
      );
      const used = result.inputTokens + result.outputTokens;
      left -= used;
      share.left -= used;
      this.spent += used;
      if (result.kind === 'stopped') return { kind: 'stopped' };
      if (result.kind === 'failed') {
        return result.reason === 'bad_answer'
          ? { kind: 'unread' }
          : { kind: 'failed', reason: result.reason };
      }
      if (result.budgetReached) this.limitReached();
      const value = this.read(result.text, schema);
      if (value !== undefined) return { kind: 'answer', value };
    }
    return { kind: 'unread' };
  }

  /** The answer as its schema reads it, with the provider's key taken out first; or undefined. */
  private read<T>(text: string, schema: z.ZodType<T>): T | undefined {
    const parsed = parseModelJson(text);
    if (parsed === undefined) return undefined;
    const checked = schema.safeParse(scrubKeyDeep(parsed, this.deps.providerKey));
    return checked.success ? checked.data : undefined;
  }
}

const STOPPED = { kind: 'stopped' } as const;
const NOT_JUDGED = { kind: 'failed', reason: 'bad_answer' } as const;

/** An even part of what is left of a share, for the `index`th of `count` slots. */
const evenPart = (share: Share, index: number, count: number): number =>
  Math.floor(share.left / (count - index));

/**
 * A finding of the judge as the outcome holds it: its sources are the specialist ids it was given,
 * each once, and its prior id is one it was given, or null.
 */
function judged(
  found: JudgeAnswer['findings'][number],
  sources: ReadonlySet<string>,
  priors: ReadonlySet<string>,
): JudgedFinding {
  const priorId = found.priorId ?? null;
  return {
    ...reviewFindingOf(found),
    sources: [...new Set(found.sources)].filter((id) => sources.has(id)),
    priorId: priorId !== null && priors.has(priorId) ? priorId : null,
    verification: null,
  };
}

/** The judge's verdicts on the prior findings it was given, the first for each. */
function priorVerdicts(given: JudgeAnswer['prior'], priors: ReadonlySet<string>): PriorVerdict[] {
  const verdicts = new Map<string, PriorVerdict>();
  for (const { id, status, reason } of given) {
    if (priors.has(id) && !verdicts.has(id)) verdicts.set(id, { id, status, reason });
  }
  return [...verdicts.values()];
}

const isSerious = (finding: JudgedFinding): boolean =>
  finding.category === 'security' &&
  (finding.severity === 'critical' || finding.severity === 'major');

/**
 * Reviews the merge request the context is of, with `budget` tokens shared out between its stages:
 * each conversation is given what is left of its part, and may go past it only through its wrap-up
 * (so the judge, whose share the specialists cannot spend, can take the review past `budget` by what
 * they overspent). `onPhase` is told each stage as it starts. The outcome is `stopped` as soon as a
 * conversation is, and `failed` when the provider fails or the judge gives no answer of its schema:
 * nothing of a failed review is stored.
 */
export async function runReviewPipeline(
  context: ReviewContext,
  budget: number,
  deps: PipelineDeps,
  onPhase: (phase: ReviewPhase) => Promise<void>,
): Promise<PipelineOutcome> {
  const plan = planReview(context.reviewed);
  const review = new Review(deps);
  const judgeTokens = shareOf(budget, STAGE_SHARES.judge);
  // Without a judge nothing can be kept: a budget too small for its share is not spent at all.
  if (judgeTokens <= 0) return NOT_JUDGED;

  // The specialists, one after the other, each with an even part of what is left of their share.
  await onPhase('specialists');
  const specialists: Share = { left: shareOf(budget, STAGE_SHARES.specialists) };
  const ran: Specialist[] = [];
  const labelled: LabelledFinding[] = [];
  const shown = specialistData(context);
  for (const [index, specialist] of plan.specialists.entries()) {
    const tokens = evenPart(specialists, index, plan.specialists.length);
    const asked = await review.ask(specialist, shown, specialistAnswerSchema, tokens, specialists);
    if (asked.kind === 'stopped') return STOPPED;
    if (asked.kind === 'failed') return { kind: 'failed', reason: asked.reason };
    if (asked.kind === 'no_tokens') continue;
    ran.push(specialist);
    if (asked.kind === 'unread') {
      review.note('reviewer_unreadable');
      continue;
    }
    for (const found of asked.value.findings) {
      labelled.push({
        id: `s${labelled.length + 1}`,
        reviewer: specialist,
        finding: reviewFindingOf(found),
      });
    }
  }

  // The judge, with its own share: what the specialists spent past theirs is not taken from it.
  await onPhase('judge');
  const judgeShown = judgeData(context, labelled);
  const asked = await review.ask('judge', judgeShown, judgeAnswerSchema, judgeTokens, {
    left: judgeTokens,
  });
  if (asked.kind === 'stopped') return STOPPED;
  if (asked.kind === 'failed') return { kind: 'failed', reason: asked.reason };
  if (asked.kind !== 'answer') return NOT_JUDGED;
  const answer = asked.value;
  const sources = new Set(labelled.map((finding) => finding.id));
  const priors = new Set(judgeShown.priorFindings.map((finding) => finding.id));
  // A low-confidence finding is never stored, so it is not verified either.
  const kept = answer.findings
    .map((found) => judged(found, sources, priors))
    .filter((finding) => finding.confidence !== 'low');

  // The serious security findings, critical first, each verified alone. The verification has its
  // share, and no more than what is left of the whole budget.
  const verdicts = new Map<JudgedFinding, VerifyVerdict>();
  const serious = kept
    .filter(isSerious)
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  if (serious.length > 0) {
    await onPhase('verification');
    if (serious.length > MAX_VERIFICATIONS) review.note('verification_capped');
    const checked = serious.slice(0, MAX_VERIFICATIONS);
    const verification: Share = {
      left: Math.min(shareOf(budget, STAGE_SHARES.verification), Math.floor(budget) - review.spent),
    };
    for (const [index, finding] of checked.entries()) {
      const tokens = evenPart(verification, index, checked.length);
      const told = await review.ask(
        'verify',
        verifyData(finding),
        verifyAnswerSchema,
        tokens,
        verification,
      );
      if (told.kind === 'stopped') return STOPPED;
      if (told.kind === 'failed') return { kind: 'failed', reason: told.reason };
      // Not verified: the finding stays as the judge left it.
      if (told.kind === 'unread') review.note('reviewer_unreadable');
      if (told.kind === 'answer') verdicts.set(finding, told.value.verdict);
    }
  }

  const findings = kept.flatMap((finding): JudgedFinding[] => {
    const verdict = verdicts.get(finding);
    if (verdict === undefined) return [finding];
    if (verdict === 'rejected') return [];
    return [
      verdict === 'needs_validation'
        ? { ...finding, confidence: 'medium', verification: verdict }
        : { ...finding, verification: verdict },
    ];
  });
  return {
    kind: 'reviewed',
    tier: plan.tier,
    specialists: ran,
    findings,
    prior: priorVerdicts(answer.prior, priors),
    summary: { verdict: answer.summary.verdict, walkthrough: [...answer.summary.walkthrough] },
    tokenLimitReached: review.tokenLimitReached,
    notes: [...review.notes],
  };
}
