import { ApiError } from '../api/errors';
import type { ItemOf, RequestBody, ResponseBody } from '../api/types';
import { formatMoney, formatWhole, parseMoney, parseWhole } from '../shared/numbers';

/**
 * 6I-2: an organisation's AI review as its admin reads it (`GET /organizations/{id}/ai/review`):
 * whether it can be switched on, the provider and the data-sharing notice to show, the stored
 * switch, scope, projects and budgets, whether the consent covers the provider now, and what the
 * instance admin's last Test found of its models.
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
/**
 * The organisation's assistant as the instance admin set it up (`GET /organizations/{id}/ai`,
 * `org.read`): the features on, today's use and the daily limits.
 */
export type OrgAi = ResponseBody<'/api/v0/organizations/{id}/ai', 'get'>;

/** The bounds the server stores for the budgets (6I-2 Task 4, D6). */
export const MAX_REVIEW_TOKENS_PER_DAY = 1_000_000_000;
export const MAX_REVIEW_COST_PER_DAY_USD = 1_000_000;
export const MAX_REVIEW_TOKENS_PER_REVIEW = 10_000_000;

/**
 * The budgets as the Budgets fold holds them: the text of each number field, and the switches of
 * the two optional limits. A limit switched off is none; its text is kept, and comes back when it
 * is switched on again.
 */
export interface AiReviewBudgetsDraft {
  tokensPerDay: string;
  maxTokensPerReview: string;
  perProjectLimited: boolean;
  perProjectTokensPerDay: string;
  costLimited: boolean;
  costPerDayUsd: string;
}
/** The budgets that have a field, which a refusal can name. */
export type AiReviewBudgetField =
  'tokensPerDay' | 'maxTokensPerReview' | 'perProjectTokensPerDay' | 'costPerDayUsd';
export type AiReviewBudgetErrors = Partial<Record<AiReviewBudgetField, string>>;

/** The budget fields in the order the page shows them, and the input each one is. */
export const AI_REVIEW_BUDGET_FIELDS: readonly AiReviewBudgetField[] = [
  'tokensPerDay',
  'maxTokensPerReview',
  'perProjectTokensPerDay',
  'costPerDayUsd',
];
export const AI_REVIEW_BUDGET_INPUT: Readonly<Record<AiReviewBudgetField, string>> = {
  tokensPerDay: 'ai-review-tokens',
  maxTokensPerReview: 'ai-review-max-per-review',
  perProjectTokensPerDay: 'ai-review-per-project',
  costPerDayUsd: 'ai-review-cost',
};

/** What an organisation without a stored block has (llm.md §3.3): the server's defaults. */
export const DEFAULT_AI_REVIEW_BUDGETS: Readonly<AiReviewBudgets> = Object.freeze({
  tokensPerDay: 2_000_000,
  costPerDayUsd: null,
  perProjectTokensPerDay: null,
  maxTokensPerReview: 300_000,
});

/** The fields of stored budgets, grouped as the locale writes numbers ("2,000,000", "12.50"). */
export function budgetsDraftOf(budgets: AiReviewBudgets, locale: string): AiReviewBudgetsDraft {
  return {
    tokensPerDay: formatWhole(budgets.tokensPerDay, locale),
    maxTokensPerReview: formatWhole(budgets.maxTokensPerReview, locale),
    perProjectLimited: budgets.perProjectTokensPerDay !== null,
    perProjectTokensPerDay:
      budgets.perProjectTokensPerDay === null
        ? ''
        : formatWhole(budgets.perProjectTokensPerDay, locale),
    costLimited: budgets.costPerDayUsd !== null,
    costPerDayUsd: budgets.costPerDayUsd === null ? '' : formatMoney(budgets.costPerDayUsd, locale),
  };
}

export function budgetRefusal(field: AiReviewBudgetField): string {
  switch (field) {
    case 'tokensPerDay':
      return $localize`:@@aiReview.badTokens:Use a whole number from 0 to 1,000,000,000.`;
    case 'maxTokensPerReview':
      return $localize`:@@aiReview.badPerReview:Use a whole number from 1 to 10,000,000.`;
    case 'perProjectTokensPerDay':
      return $localize`:@@aiReview.badPerProject:Use a whole number from 0 to 1,000,000,000.`;
    case 'costPerDayUsd':
      return $localize`:@@aiReview.badCost:Use an amount in US dollars from 0 to 1,000,000, with at most two decimals.`;
  }
}

/**
 * The typed budgets as the `PUT` body wants them (a limit switched off is `null`), or the fields
 * refused with the page's own words.
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
    parseWhole(draft.tokensPerDay, 0, MAX_REVIEW_TOKENS_PER_DAY) ?? refuse('tokensPerDay');
  const maxTokensPerReview =
    parseWhole(draft.maxTokensPerReview, 1, MAX_REVIEW_TOKENS_PER_REVIEW) ??
    refuse('maxTokensPerReview');
  const perProjectTokensPerDay = draft.perProjectLimited
    ? (parseWhole(draft.perProjectTokensPerDay, 0, MAX_REVIEW_TOKENS_PER_DAY) ??
      refuse('perProjectTokensPerDay'))
    : null;
  const costPerDayUsd = draft.costLimited
    ? (parseMoney(draft.costPerDayUsd, MAX_REVIEW_COST_PER_DAY_USD) ?? refuse('costPerDayUsd'))
    : null;
  if (Object.keys(errors).length > 0 || tokensPerDay === null || maxTokensPerReview === null) {
    return { errors };
  }
  return { budgets: { tokensPerDay, costPerDayUsd, perProjectTokensPerDay, maxTokensPerReview } };
}

/** The number a budget's text stands for, whatever its bounds; null when it is not one. */
export function budgetNumber(field: AiReviewBudgetField, text: string): number | null {
  return field === 'costPerDayUsd'
    ? parseMoney(text, Number.MAX_SAFE_INTEGER)
    : parseWhole(text, 0, Number.MAX_SAFE_INTEGER);
}

/**
 * How many budgets the draft changes from those stored. A limit switched off stands for none, and
 * a text that is no number changes its budget; digits only grouped otherwise change nothing.
 */
export function changedBudgets(draft: AiReviewBudgetsDraft, stored: AiReviewBudgets): number {
  const value = (field: AiReviewBudgetField, text: string) =>
    budgetNumber(field, text) ?? Number.NaN;
  const pairs: [number | null, number | null][] = [
    [value('tokensPerDay', draft.tokensPerDay), stored.tokensPerDay],
    [value('maxTokensPerReview', draft.maxTokensPerReview), stored.maxTokensPerReview],
    [
      draft.perProjectLimited
        ? value('perProjectTokensPerDay', draft.perProjectTokensPerDay)
        : null,
      stored.perProjectTokensPerDay,
    ],
    [draft.costLimited ? value('costPerDayUsd', draft.costPerDayUsd) : null, stored.costPerDayUsd],
  ];
  return pairs.filter(([typed, saved]) => typed !== saved).length;
}

/** The server's 422 paths of the budgets (`body.budgets.<field>`) and the field each one refuses. */
export function budgetFieldOfPath(path: string): AiReviewBudgetField | null {
  const field = /^body\.budgets\.(\w+)$/.exec(path)?.[1];
  return AI_REVIEW_BUDGET_FIELDS.find((f) => f === field) ?? null;
}

/** Why the picker cannot add a project to AI review: an instance admin excluded it from AI. */
export function pickerUnavailable(project: ItemOf<'/api/v0/projects'>): string | null {
  return project.autoFix.excludedFromAi
    ? $localize`:@@orgAi.picker.excluded:Excluded from AI by an instance admin`
    : null;
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
    return $localize`:@@aiReview.aiDisabled:AI review needs AI set up on this server and allowed for this organization. An instance admin sets that up in Settings → AI provider.`;
  }
  if (err.status === 422 && err.code === 'PROJECT_NOT_IN_ORGANIZATION') {
    return $localize`:@@aiReview.foreignProject:A selected project belongs to another organization. Reload the page and select the projects again.`;
  }
  return null;
}
