import { ApiError } from '../api/errors';
import type { RequestBody, ResponseBody } from '../api/types';

/**
 * 6I-2: an organisation's AI review as its admin reads it (`GET /organizations/{id}/ai/review`):
 * whether it can be switched on, the provider and the data-sharing notice to show, the stored
 * switch, scope, projects and budgets, and whether the consent covers the provider now.
 */
export type OrgAiReview = ResponseBody<'/api/v0/organizations/{id}/ai/review', 'get'>;
/** What `PUT` stores: the switch, the scope, the projects, the budgets and the acknowledgement. */
export type AiReviewBody = RequestBody<'/api/v0/organizations/{id}/ai/review', 'put'>;
export type AiReviewBudgets = AiReviewBody['budgets'];
export type AiReviewScope = AiReviewBody['scope'];
/**
 * The provider the notice names, as the acknowledgement repeats it (R10): its host, its standard
 * model and every model it names (once each, sorted, the standard model among them).
 */
export type AiReviewProvider = NonNullable<OrgAiReview['provider']>;

/** The bounds the server stores for the budgets (6I-2 Task 4, D6). */
export const MAX_REVIEW_TOKENS_PER_DAY = 1_000_000_000;
export const MAX_REVIEW_COST_PER_DAY_USD = 1_000_000;
export const MAX_REVIEW_TOKENS_PER_REVIEW = 10_000_000;

/** The budgets as typed in their fields; an optional budget left empty means none. */
export interface AiReviewBudgetsDraft {
  tokensPerDay: string;
  costPerDayUsd: string;
  perProjectTokensPerDay: string;
  maxTokensPerReview: string;
}
export type AiReviewBudgetField = keyof AiReviewBudgetsDraft;
export type AiReviewBudgetErrors = Partial<Record<AiReviewBudgetField, string>>;

/** The budget fields in the order the page shows them, and the input each one is. */
export const AI_REVIEW_BUDGET_FIELDS: readonly AiReviewBudgetField[] = [
  'tokensPerDay',
  'costPerDayUsd',
  'perProjectTokensPerDay',
  'maxTokensPerReview',
];
export const AI_REVIEW_BUDGET_INPUT: Readonly<Record<AiReviewBudgetField, string>> = {
  tokensPerDay: 'ai-review-tokens',
  costPerDayUsd: 'ai-review-cost',
  perProjectTokensPerDay: 'ai-review-per-project',
  maxTokensPerReview: 'ai-review-max-per-review',
};

/** What an organisation without a stored block has (llm.md §3.3): the server's defaults. */
export const DEFAULT_AI_REVIEW_BUDGETS: Readonly<AiReviewBudgets> = Object.freeze({
  tokensPerDay: 2_000_000,
  costPerDayUsd: null,
  perProjectTokensPerDay: null,
  maxTokensPerReview: 300_000,
});

export function budgetsDraftOf(budgets: AiReviewBudgets): AiReviewBudgetsDraft {
  return {
    tokensPerDay: String(budgets.tokensPerDay),
    costPerDayUsd: budgets.costPerDayUsd === null ? '' : String(budgets.costPerDayUsd),
    perProjectTokensPerDay:
      budgets.perProjectTokensPerDay === null ? '' : String(budgets.perProjectTokensPerDay),
    maxTokensPerReview: String(budgets.maxTokensPerReview),
  };
}

/** A whole number from `min` to `max` as typed, or null. */
function wholeNumber(raw: string, min: number, max: number): number | null {
  const value = raw.trim();
  if (!/^\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** An amount from 0 to `max` as typed (a decimal point is allowed), or null. */
function amount(raw: string, max: number): number | null {
  const value = raw.trim();
  const n = value === '' ? Number.NaN : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

export function budgetRefusal(field: AiReviewBudgetField): string {
  switch (field) {
    case 'tokensPerDay':
      return $localize`:@@aiReview.badTokens:Use a whole number from 0 to 1 000 000 000.`;
    case 'costPerDayUsd':
      return $localize`:@@aiReview.badCost:Use an amount in US dollars from 0 to 1 000 000, or leave it empty for no cost limit.`;
    case 'perProjectTokensPerDay':
      return $localize`:@@aiReview.badPerProject:Use a whole number from 0 to 1 000 000 000, or leave it empty for no limit per project.`;
    case 'maxTokensPerReview':
      return $localize`:@@aiReview.badPerReview:Use a whole number from 1 to 10 000 000.`;
  }
}

/**
 * The typed budgets as the `PUT` body wants them (an empty optional budget is `null`), or the
 * fields refused with the page's own words.
 */
export function parseBudgets(
  draft: AiReviewBudgetsDraft,
): { budgets: AiReviewBudgets } | { errors: AiReviewBudgetErrors } {
  const errors: AiReviewBudgetErrors = {};
  const refuse = (field: AiReviewBudgetField): null => {
    errors[field] = budgetRefusal(field);
    return null;
  };
  const tokensPerDay =
    wholeNumber(draft.tokensPerDay, 0, MAX_REVIEW_TOKENS_PER_DAY) ?? refuse('tokensPerDay');
  const costPerDayUsd =
    draft.costPerDayUsd.trim() === ''
      ? null
      : (amount(draft.costPerDayUsd, MAX_REVIEW_COST_PER_DAY_USD) ?? refuse('costPerDayUsd'));
  const perProjectTokensPerDay =
    draft.perProjectTokensPerDay.trim() === ''
      ? null
      : (wholeNumber(draft.perProjectTokensPerDay, 0, MAX_REVIEW_TOKENS_PER_DAY) ??
        refuse('perProjectTokensPerDay'));
  const maxTokensPerReview =
    wholeNumber(draft.maxTokensPerReview, 1, MAX_REVIEW_TOKENS_PER_REVIEW) ??
    refuse('maxTokensPerReview');
  if (Object.keys(errors).length > 0 || tokensPerDay === null || maxTokensPerReview === null) {
    return { errors };
  }
  return { budgets: { tokensPerDay, costPerDayUsd, perProjectTokensPerDay, maxTokensPerReview } };
}

/** The server's 422 paths of the budgets (`body.budgets.<field>`) and the field each one refuses. */
export function budgetFieldOfPath(path: string): AiReviewBudgetField | null {
  const field = /^body\.budgets\.(\w+)$/.exec(path)?.[1];
  return AI_REVIEW_BUDGET_FIELDS.find((f) => f === field) ?? null;
}

/** Why AI review cannot be switched on, in the page's words; null while it can. */
export function unavailableText(settings: OrgAiReview): string | null {
  if (settings.available) return null;
  return settings.unavailableReason === 'no_provider'
    ? $localize`:@@aiReview.noProvider:The instance administrator has not configured an AI provider.`
    : $localize`:@@aiReview.organizationDisabled:AI assistant is not enabled for this organisation.`;
}

/**
 * The page's own words for a refusal of the organisation route (409 AI_DISABLED, 422
 * PROJECT_NOT_IN_ORGANIZATION), or null for any other problem. The two consent refusals
 * (AI_REVIEW_CONSENT_REQUIRED, AI_REVIEW_PROVIDER_CHANGED) are not shown as messages: the page
 * reads the settings again and asks in its dialog.
 */
export function aiReviewRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 409 && err.code === 'AI_DISABLED') {
    return $localize`:@@aiReview.aiDisabled:AI review needs the AI assistant configured and enabled for this organisation. An instance administrator sets that in the AI assistant settings.`;
  }
  if (err.status === 422 && err.code === 'PROJECT_NOT_IN_ORGANIZATION') {
    return $localize`:@@aiReview.foreignProject:A selected project belongs to another organisation. Reload the page and select the projects again.`;
  }
  return null;
}
