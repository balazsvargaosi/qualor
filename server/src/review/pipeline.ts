import { parseModelJson } from '@qualor/shared';
import type { z } from 'zod';
import type { ReviewFailureReason, ReviewPhase, ReviewTier } from '../db/schema';
import {
  CONTEXT_MAXIMA,
  type ContextLimits,
  type ContextShape,
  type ReviewableChange,
  type ReviewContext,
} from './context';
import type { ConversationResult } from './conversation';
import { envelope, newNonce } from './envelope';
import { scrubKeyDeep } from './key-scrub';
import {
  judgeData,
  listedDataChars,
  SPECIALISTS,
  specialistData,
  SYSTEM_PROMPTS,
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
 * of the change picks the specialist reviewers; they report with recall first, one after the other
 * (security first when it is one of them); a judge reads the code behind their findings and keeps,
 * merges or drops each with a reason, re-checks what an earlier review raised and writes the
 * summary; and every serious security finding it keeps is checked again by a conversation given
 * that finding alone.
 *
 * Every conversation is given a check of its answers: parseModelJson, the provider's key taken out,
 * then the role's strict schema (schemas.ts). The conversation asks once more for an answer that
 * does not pass. A reviewer that still does not answer in its JSON adds nothing, and a judge that
 * does not fails the review (fail closed).
 *
 * The review's token budget is shared out between the stages, each of which spends from its own
 * share whichever way its conversations end: 55 % for the specialists, an even part for each that
 * the others' spending does not touch; 35 % for the judge; 10 % for the verification, each in turn
 * given an even part of what is left of it. A conversation that used up its part answers through
 * its wrap-up, and one with nothing to spend does not run; the review goes on, with
 * `tokenLimitReached`. Only a judge cannot be done without. What a first message holds is sized to
 * a third of its conversation's tokens (`reviewLimits`, and the judge's data): every call sends it
 * again, and a third leaves room for a turn of tools, what the tools answer, and the wrap-up.
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

/**
 * The tokens each role may write in one answer (the conversation's `maxOutputTokens`). Its answer is
 * read up to four characters for each of them.
 */
export const REVIEW_OUTPUT_TOKENS: Readonly<Record<ReviewRole, number>> = Object.freeze({
  quality: 12_288,
  tests: 12_288,
  security: 12_288,
  performance: 12_288,
  judge: 16_384,
  verify: 2_048,
});
const ANSWER_CHARS_PER_TOKEN = 4;

/**
 * The characters a token of code or JSON stands for, at the least: what a first message may hold is
 * counted with it, so that its tokens are fewer, not more.
 */
export const CHARS_PER_TOKEN = 3;
/** A first message holds at most this part of its conversation's tokens. */
const FIRST_MESSAGE_PARTS = 3;
/** What an envelope and the keys of its data object add to the data, at most. */
const ENVELOPE_CHARS = 600;
/** A text in JSON takes a tenth more for its escapes (more with many quotes; the token count's slack covers it). */
const JSON_ALLOWANCE = 1.1;
/** The label of an instructions file that is cut. */
const CUT_LABEL_CHARS = 80;
/** Characters of each instructions file shown whatever the budget (or all of it, if it is shorter). */
const INSTRUCTIONS_MIN_CHARS = 16_000;

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
export const REVIEW_NOTES = [
  'reviewer_unreadable',
  'token_limit_reached',
  'verification_capped',
] as const;
export type ReviewNote = (typeof REVIEW_NOTES)[number];

export type PipelineOutcome =
  | {
      kind: 'reviewed';
      tier: ReviewTier;
      /** The specialists that ran, in their order: one with no tokens left does not run. */
      specialists: Specialist[];
      findings: JudgedFinding[];
      /** The judge's verdicts on the open prior findings it was shown. */
      prior: PriorVerdict[];
      /**
       * The prior findings the judge was shown (at most 50, the open ones first): only these may
       * be closed for being left out of the findings.
       */
      shownPriorIds: string[];
      summary: { verdict: string; walkthrough: string[] };
      tokenLimitReached: boolean;
      notes: ReviewNote[];
    }
  | { kind: 'failed'; reason: ReviewFailureReason }
  | { kind: 'stopped' };

export interface PipelineDeps {
  /**
   * One conversation of a role over the tools. `user` is the envelope built with `nonce`; the
   * job's implementation runs `runConversation` with that nonce for the tool results, with
   * `tokenBudget` (more than 0) and REVIEW_OUTPUT_TOKENS of the role, and with `accept` as its
   * check of an answer.
   */
  converse(
    role: ReviewRole,
    user: string,
    nonce: string,
    tokenBudget: number,
    accept: (text: string) => boolean,
  ): Promise<ConversationResult>;
  /** The provider's API key, taken out of every answer before it is used; null when there is none. */
  providerKey: string | null;
}

/**
 * The tier of a review and its specialists, in their order: by the lines the reviewed changes add
 * and remove, and their number. A reviewed change that looks security-sensitive adds the security
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
  if (reviewed.some((change) => change.sensitive)) chosen.add('security');
  return { tier, specialists: SPECIALISTS.filter((s) => chosen.has(s)), changedLines, files };
}

/** `percent` of the budget, in whole tokens; nothing of a budget that is not a positive number. */
function shareOf(budget: number, percent: number): number {
  return Number.isFinite(budget) && budget > 0
    ? Math.floor((Math.floor(budget) * percent) / 100)
    : 0;
}

/** The characters a first message may take in a conversation of `tokens`. */
const firstMessageChars = (tokens: number): number =>
  Math.floor(tokens / FIRST_MESSAGE_PARTS) * CHARS_PER_TOKEN;

/**
 * The largest length every text may be cut to, at most `max`, for the texts of these lengths to
 * take at most `total` characters together: a short text keeps all of itself and leaves the rest
 * to the long ones.
 */
function evenCut(lengths: readonly number[], total: number, max: number): number {
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = Math.max(0, total);
  for (const [index, length] of sorted.entries()) {
    const even = Math.floor(left / (sorted.length - index));
    if (length > even) return Math.min(max, even);
    left -= length;
  }
  return max;
}

/**
 * How much of the slices and of the instructions a review of `budget` tokens shows of a change of
 * this shape: what buildReviewContext's `limits` answers (the job passes it this, bound to the
 * budget). The data the specialists share is sized so that a specialist's first message takes at
 * most a third of its part, and half of the judge's third (the judge keeps the other half for the
 * findings). What is left after the system prompt and the lists, counted as the change has them,
 * goes first to the instructions files, which no tool can stand in for: each at least
 * INSTRUCTIONS_MIN_CHARS (or all of it, if shorter) even past that room, the long ones cut evenly
 * when they do not all fit. The slices have the rest. Each part is at most CONTEXT_MAXIMA.
 */
export function reviewLimits(shape: ContextShape, budget: number): ContextLimits {
  const { specialists } = planReview(shape.reviewed);
  const part = Math.floor(shareOf(budget, STAGE_SHARES.specialists) / specialists.length);
  const judgeHalf = Math.floor(shareOf(budget, STAGE_SHARES.judge) / 2);
  const prompt = Math.max(...specialists.map((role) => SYSTEM_PROMPTS[role].length));
  const room = Math.floor(
    (firstMessageChars(Math.min(part, judgeHalf)) -
      prompt -
      ENVELOPE_CHARS -
      listedDataChars(shape)) /
      JSON_ALLOWANCE,
  );
  const labels = shape.instructionChars.length * CUT_LABEL_CHARS;
  const instructionsChars = Math.max(
    INSTRUCTIONS_MIN_CHARS,
    evenCut(shape.instructionChars, room - labels, CONTEXT_MAXIMA.instructionsChars),
  );
  const instructions = shape.instructionChars.reduce(
    (sum, chars) =>
      sum + Math.min(chars, instructionsChars) + (chars > instructionsChars ? CUT_LABEL_CHARS : 0),
    0,
  );
  return {
    sliceChars: Math.min(CONTEXT_MAXIMA.sliceChars, Math.max(0, room - instructions)),
    instructionsChars,
  };
}

/** What a stage may still spend. */
interface Share {
  left: number;
}

/** How one conversation slot ended. */
type Asked<T> =
  | { kind: 'answer'; value: T }
  /** It ran and gave nothing usable: no answer, or none of its schema when asked again. */
  | { kind: 'unread' }
  /** It had no tokens to start with, and did not run. */
  | { kind: 'no_tokens' }
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: 'provider_error' | 'provider_no_tools' };

/** The state of one review: what it has noted of itself. */
class Review {
  tokenLimitReached = false;
  readonly notes: ReviewNote[] = [];

  constructor(private readonly deps: PipelineDeps) {}

  note(note: ReviewNote): void {
    if (!this.notes.includes(note)) this.notes.push(note);
  }

  limitReached(): void {
    this.tokenLimitReached = true;
    this.note('token_limit_reached');
  }

  /**
   * One slot of a stage: a conversation of `role` over `data` with `tokens` to spend, which asks
   * once more for an answer that does not match `schema` (runConversation's `accept`). What it
   * spent is taken from `share`. Its answer is checked again here: a conversation that gave one
   * back without checking it is not believed.
   */
  async ask<T>(
    role: ReviewRole,
    data: unknown,
    schema: z.ZodType<T>,
    tokens: number,
    share: Share,
  ): Promise<Asked<T>> {
    if (tokens <= 0) {
      this.limitReached();
      return { kind: 'no_tokens' };
    }
    /** What the check read of the answers it took, by their text. */
    const accepted = new Map<string, T>();
    const accept = (text: string): boolean => {
      const value = this.read(role, text, schema);
      if (value !== undefined) accepted.set(text, value);
      return value !== undefined;
    };
    const nonce = newNonce();
    const result = await this.deps.converse(role, envelope(data, nonce), nonce, tokens, accept);
    share.left -= result.inputTokens + result.outputTokens;
    if (result.kind === 'stopped') return { kind: 'stopped' };
    if (result.kind === 'failed') {
      return result.reason === 'bad_answer'
        ? { kind: 'unread' }
        : { kind: 'failed', reason: result.reason };
    }
    if (result.budgetReached) this.limitReached();
    const value = accepted.get(result.text) ?? this.read(role, result.text, schema);
    return value === undefined ? { kind: 'unread' } : { kind: 'answer', value };
  }

  /**
   * The answer as its schema reads it, with the provider's key taken out first; or undefined. An
   * answer is read up to four characters for each token the role may write.
   */
  private read<T>(role: ReviewRole, text: string, schema: z.ZodType<T>): T | undefined {
    const parsed = parseModelJson(text, ANSWER_CHARS_PER_TOKEN * REVIEW_OUTPUT_TOKENS[role]);
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

/** The judge's verdicts on the open prior findings it was given, the first for each. */
function priorVerdicts(given: JudgeAnswer['prior'], open: ReadonlySet<string>): PriorVerdict[] {
  const verdicts = new Map<string, PriorVerdict>();
  for (const { id, status, reason } of given) {
    if (open.has(id) && !verdicts.has(id)) verdicts.set(id, { id, status, reason });
  }
  return [...verdicts.values()];
}

const isSerious = (finding: JudgedFinding): boolean =>
  finding.category === 'security' &&
  (finding.severity === 'critical' || finding.severity === 'major');

/**
 * Reviews the merge request the context is of, with `budget` tokens shared out between its stages:
 * each conversation is given what is left of its part, and keeps room in it for its wrap-up: it
 * goes past it only by as much as the loop's guesses fell short, or when its first turn of tools
 * already left no room (conversation.ts). A stage, whose share the others cannot spend, can still
 * take the review past `budget` by what the stages before it overspent. `onPhase` is told each
 * stage as it starts. The outcome is `stopped`
 * as soon as a conversation is, and `failed` when the provider fails or the judge gives no answer
 * of its schema: nothing of a failed review is stored.
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

  // The specialists, one after the other, each with an even part of their share, whatever the
  // others spent: one that overshoots its part takes nothing from the next.
  await onPhase('specialists');
  const part = Math.floor(shareOf(budget, STAGE_SHARES.specialists) / plan.specialists.length);
  const ran: Specialist[] = [];
  const labelled: LabelledFinding[] = [];
  const shown = specialistData(context);
  for (const specialist of plan.specialists) {
    const asked = await review.ask(specialist, shown, specialistAnswerSchema, part, { left: part });
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
  // Its data takes a third of it at most: the bodies of the findings are cut to fit.
  await onPhase('judge');
  const judgeRoom = firstMessageChars(judgeTokens) - SYSTEM_PROMPTS.judge.length - ENVELOPE_CHARS;
  const judgeShown = judgeData(context, labelled, judgeRoom);
  const asked = await review.ask('judge', judgeShown, judgeAnswerSchema, judgeTokens, {
    left: judgeTokens,
  });
  if (asked.kind === 'stopped') return STOPPED;
  if (asked.kind === 'failed') return { kind: 'failed', reason: asked.reason };
  if (asked.kind !== 'answer') return NOT_JUDGED;
  const answer = asked.value;
  const sources = new Set(labelled.map((finding) => finding.id));
  const shownPriorIds = judgeShown.priorFindings.map((finding) => finding.id);
  const openPriors = new Set(
    judgeShown.priorFindings.filter((finding) => finding.status === 'open').map((f) => f.id),
  );
  // A low-confidence finding is never stored, so it is not verified either.
  const kept = answer.findings
    .map((found) => judged(found, sources, new Set(shownPriorIds)))
    .filter((finding) => finding.confidence !== 'low');

  // The serious security findings, critical first, each verified alone, with the verification's
  // own share: what the stages before it overspent is not taken from it.
  const verdicts = new Map<JudgedFinding, VerifyVerdict>();
  const serious = kept
    .filter(isSerious)
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  if (serious.length > 0) {
    await onPhase('verification');
    if (serious.length > MAX_VERIFICATIONS) review.note('verification_capped');
    const checked = serious.slice(0, MAX_VERIFICATIONS);
    const verification: Share = { left: shareOf(budget, STAGE_SHARES.verification) };
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
    prior: priorVerdicts(answer.prior, openPriors),
    shownPriorIds,
    summary: { verdict: answer.summary.verdict, walkthrough: [...answer.summary.walkthrough] },
    tokenLimitReached: review.tokenLimitReached,
    notes: [...review.notes],
  };
}
