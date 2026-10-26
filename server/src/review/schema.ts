import { z } from 'zod';

/**
 * The stored shape of an organisation's AI review settings (6I-2, llm.md §3.3). A module of its
 * own, with no import from `llm/settings.ts`, so that file can hold the shape inside the
 * organisation's entry without an import cycle; `review/settings.ts` re-exports everything here.
 */

/**
 * At most this many project ids in the list, as the organisation's other lists
 * (`MAX_ORGANIZATION_PROJECT_IDS` of llm/settings.ts, which a test keeps equal).
 */
export const MAX_REVIEW_PROJECT_IDS = 1_000;

/** `all`: every project of the organisation; `selected`: the listed projects only. */
export const REVIEW_SCOPES = ['all', 'selected'] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

/**
 * The organisation's own budgets for AI review (spec §10, C2): they are not the explain/triage
 * budgets. The instance ceiling (`budgets.reviewTokensPerOrganizationPerDay`) caps `tokensPerDay`.
 */
export const reviewBudgetsSchema = z.strictObject({
  /** Tokens (input and output) all the organisation's reviews may use per UTC day. */
  tokensPerDay: z.number().int().min(0).max(1_000_000_000),
  /** The cost per UTC day, which needs the instance's `pricing`; null: no cost budget. */
  costPerDayUsd: z.number().min(0).max(1_000_000).nullable(),
  /** Tokens one project's reviews may use per UTC day; null: no per-project budget. */
  perProjectTokensPerDay: z.number().int().min(0).max(1_000_000_000).nullable(),
  /** The most tokens one review may use; past it the review ends with what it has. */
  maxTokensPerReview: z.number().int().min(1).max(10_000_000),
});
export type ReviewBudgets = z.infer<typeof reviewBudgetsSchema>;

/** The default budgets (spec §10, proposed; the maintainer confirms at plan review). */
export const DEFAULT_REVIEW_BUDGETS: Readonly<ReviewBudgets> = Object.freeze({
  tokensPerDay: 2_000_000,
  costPerDayUsd: null,
  perProjectTokensPerDay: null,
  maxTokensPerReview: 300_000,
});

/**
 * A model name, as the provider settings store one: the settings' `MODEL_PATTERN` (llm/settings.ts)
 * is this pattern, which lives here because the settings import this module.
 */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;

/**
 * R10: who acknowledged the data-sharing notice, for which provider. The provider is named by its
 * normalised base URL (scheme, host, port and path, as `/system/llm` stores it: a gateway may put
 * the tenant in the path), its host (with its port, as `URL.host` gives it: the one the notice
 * names) and its models: `model` is the standard model, and `models` every model the notice
 * named, sorted and each once. A consent stored before the tiers has no `models` and names its
 * `model` alone (`consentModels`). When any of them changes, the consent no longer covers the
 * provider (`consentCurrent` is false) until it is given again.
 */
export const reviewConsentSchema = z.strictObject({
  providerUrl: z.string().min(1).max(2_048),
  providerHost: z.string().min(1).max(300),
  model: z.string().min(1).max(200),
  models: z.array(z.string().regex(MODEL_NAME_PATTERN)).min(1).max(3).optional(),
  userId: z.uuid(),
  at: z.iso.datetime(),
});
export type ReviewConsent = z.infer<typeof reviewConsentSchema>;

export const reviewSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  scope: z.enum(REVIEW_SCOPES),
  /** The projects of the scope `selected`; kept (and ignored) while the scope is `all`. */
  projectIds: z.array(z.uuid()).max(MAX_REVIEW_PROJECT_IDS),
  budgets: reviewBudgetsSchema,
  /**
   * A stored consent that does not parse (one written before it named the base URL, say) reads as
   * none, not as a row that does not parse: the rest of the `llm` settings stay in force, and the
   * review stops (`consent_outdated`) until the organisation admin acknowledges again. Fail closed.
   */
  consent: reviewConsentSchema.nullable().catch(null),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

/** A fresh, mutable copy of the defaults: off, selected projects only, none selected, no consent. */
export function defaultReview(): ReviewSettings {
  return {
    enabled: false,
    scope: 'selected',
    projectIds: [],
    budgets: { ...DEFAULT_REVIEW_BUDGETS },
    consent: null,
  };
}

/** The defaults, frozen all the way down: read them, never change them (`defaultReview()` for a copy). */
export const DEFAULT_REVIEW: Readonly<ReviewSettings> = (() => {
  const review = defaultReview();
  Object.freeze(review.projectIds);
  Object.freeze(review.budgets);
  return Object.freeze(review);
})();

const BUDGET_KEYS = Object.keys(DEFAULT_REVIEW_BUDGETS) as (keyof ReviewBudgets)[];

/** Whether two sets of budgets hold the same values. */
export function sameReviewBudgets(a: ReviewBudgets, b: ReviewBudgets): boolean {
  return BUDGET_KEYS.every((key) => a[key] === b[key]);
}

/** Whether `review` says no more than the defaults (an entry that only holds these changes nothing). */
export function isDefaultReview(review: ReviewSettings): boolean {
  return (
    !review.enabled &&
    review.scope === DEFAULT_REVIEW.scope &&
    review.projectIds.length === 0 &&
    review.consent === null &&
    sameReviewBudgets(review.budgets, DEFAULT_REVIEW_BUDGETS)
  );
}
