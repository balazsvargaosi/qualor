import { organizationSettings, type StoredLlmSettings } from '../llm/settings';
import { normalBaseUrl } from '../scm/url';
import { sameReviewBudgets, type ReviewBudgets, type ReviewSettings } from './schema';

export {
  DEFAULT_REVIEW,
  DEFAULT_REVIEW_BUDGETS,
  defaultReview,
  isDefaultReview,
  MAX_REVIEW_PROJECT_IDS,
  REVIEW_SCOPES,
  reviewBudgetsSchema,
  reviewConsentSchema,
  reviewSettingsSchema,
  sameReviewBudgets,
  type ReviewBudgets,
  type ReviewConsent,
  type ReviewScope,
  type ReviewSettings,
} from './schema';

/**
 * Why AI review does not run for a project (6I-2, llm.md §3.3), in the order the conditions are
 * checked: the first that fails is the reason.
 */
export const REVIEW_INACTIVE_REASONS = [
  'no_provider',
  'organization_disabled',
  'review_disabled',
  'consent_outdated',
  'project_not_selected',
  'not_mapped',
] as const;
export type ReviewInactiveReason = (typeof REVIEW_INACTIVE_REASONS)[number];

/** The provider as a consent names it (R10). */
export interface ReviewProvider {
  /** The normalised base URL: scheme, host, port and path, as `/system/llm` stores it. */
  url: string;
  /** The host of the address (`URL.host`: with its port when it is not the scheme's default). */
  host: string;
  model: string;
}

/**
 * The configured provider, or null when there is none (an address that does not parse is none:
 * nothing could be sent to it, and a consent could not name it). The address is normalised again,
 * as `/system/llm` does on save, so a row written another way names the same address.
 */
export function reviewProvider(settings: StoredLlmSettings): ReviewProvider | null {
  if (settings.provider === null) return null;
  try {
    const url = normalBaseUrl(settings.provider.baseUrl);
    return { url, host: new URL(url).host, model: settings.provider.model };
  } catch {
    return null;
  }
}

/**
 * Whether an acknowledgement names the provider configured now: the host (a host has no case) and
 * the model the notice showed. The admin acknowledges what was shown; if the instance admin has
 * changed the provider since, the acknowledgement does not cover the new one (R10).
 */
export function acknowledgesProvider(
  provider: ReviewProvider,
  acknowledged: { host: string; model: string },
): boolean {
  return (
    acknowledged.host.toLowerCase() === provider.host.toLowerCase() &&
    acknowledged.model === provider.model
  );
}

/**
 * The organisation's review settings; an organisation absent from the map, and a row stored before
 * 6I-2, read with the defaults.
 */
export function reviewSettingsOf(
  settings: StoredLlmSettings,
  organizationId: string,
): ReviewSettings {
  return organizationSettings(settings, organizationId).review;
}

/**
 * The settings with the organisation's `review` block replaced and nothing else changed. An
 * organisation absent from the map gets the disabled entry (llm.md §3.3) holding the block.
 */
export function withOrganizationReview(
  settings: StoredLlmSettings,
  organizationId: string,
  next: ReviewSettings,
): StoredLlmSettings {
  const review: ReviewSettings = {
    ...next,
    projectIds: [...next.projectIds],
    budgets: { ...next.budgets },
    consent: next.consent === null ? null : { ...next.consent },
  };
  return {
    ...settings,
    organizations: {
      ...settings.organizations,
      [organizationId]: { ...organizationSettings(settings, organizationId), review },
    },
  };
}

/** Whether two review blocks hold the same values; the project lists are compared in order. */
export function sameReview(a: ReviewSettings, b: ReviewSettings): boolean {
  const consent = (x: ReviewSettings['consent'], y: ReviewSettings['consent']): boolean =>
    x === null || y === null
      ? x === y
      : x.providerUrl === y.providerUrl &&
        x.providerHost === y.providerHost &&
        x.model === y.model &&
        x.userId === y.userId &&
        x.at === y.at;
  return (
    a.enabled === b.enabled &&
    a.scope === b.scope &&
    a.projectIds.length === b.projectIds.length &&
    a.projectIds.every((id, i) => id === b.projectIds[i]) &&
    sameReviewBudgets(a.budgets, b.budgets) &&
    consent(a.consent, b.consent)
  );
}

/**
 * R10: whether the consent names the provider that is configured now, by its normalised base URL,
 * its host and its model. A consent given for another address (the path too), host or model, none,
 * or no provider at all, is not current.
 */
export function consentCurrent(settings: StoredLlmSettings, review: ReviewSettings): boolean {
  const provider = reviewProvider(settings);
  const consent = review.consent;
  return (
    provider !== null &&
    consent !== null &&
    consent.providerUrl === provider.url &&
    consent.providerHost === provider.host &&
    consent.model === provider.model
  );
}

/**
 * The organisation-level part of {@link reviewActive}: the reason review is off for the whole
 * organisation, or null when it is on (a project may still not be selected or mapped).
 */
export function organizationReviewInactive(
  settings: StoredLlmSettings,
  organizationId: string,
): ReviewInactiveReason | null {
  if (reviewProvider(settings) === null) return 'no_provider';
  const organization = organizationSettings(settings, organizationId);
  if (!organization.enabled) return 'organization_disabled';
  if (!organization.review.enabled) return 'review_disabled';
  if (!consentCurrent(settings, organization.review)) return 'consent_outdated';
  return null;
}

/**
 * Whether the organisation's scope selects the project: every project with `all`, the listed ones
 * with `selected`. A project the organisation excludes from the AI assistant (`excludedProjectIds`,
 * llm.md §3.3: its code is never sent) is never selected, whatever the scope says.
 */
export function projectReviewSelected(
  settings: StoredLlmSettings,
  project: { id: string; organizationId: string },
): boolean {
  const organization = organizationSettings(settings, project.organizationId);
  if (organization.excludedProjectIds.includes(project.id)) return false;
  return organization.review.scope === 'all' || organization.review.projectIds.includes(project.id);
}

/**
 * Whether AI review runs for a project (spec C1, R10): a provider is configured, the organisation
 * is enabled for the AI assistant and has switched review on with a consent that covers the
 * provider, the project is selected, and it is mapped to an SCM connection (the review is posted
 * there).
 */
export function reviewActive(
  settings: StoredLlmSettings,
  project: { id: string; organizationId: string; scmConnectionId: string | null },
): { active: true } | { active: false; reason: ReviewInactiveReason } {
  const reason = organizationReviewInactive(settings, project.organizationId);
  if (reason !== null) return { active: false, reason };
  if (!projectReviewSelected(settings, project)) {
    return { active: false, reason: 'project_not_selected' };
  }
  if (project.scmConnectionId === null) return { active: false, reason: 'not_mapped' };
  return { active: true };
}

/**
 * The project DTO's `aiReview`: whether review is on for the project, and whether the organisation
 * has it on (so a project that is off can say its organisation admin switches it on).
 */
export function projectAiReview(
  settings: StoredLlmSettings,
  project: { id: string; organizationId: string },
): { enabled: boolean; organizationEnabled: boolean } {
  const organizationEnabled = organizationReviewInactive(settings, project.organizationId) === null;
  return {
    enabled: organizationEnabled && projectReviewSelected(settings, project),
    organizationEnabled,
  };
}

/**
 * The organisation's budgets with the instance ceiling applied: its tokens per day are the smaller
 * of its own and `budgets.reviewTokensPerOrganizationPerDay`. Every other budget is its own.
 */
export function effectiveReviewBudgets(
  settings: StoredLlmSettings,
  organizationId: string,
): ReviewBudgets {
  const budgets = reviewSettingsOf(settings, organizationId).budgets;
  const ceiling = settings.budgets.reviewTokensPerOrganizationPerDay;
  return {
    ...budgets,
    tokensPerDay: ceiling === null ? budgets.tokensPerDay : Math.min(budgets.tokensPerDay, ceiling),
  };
}

/**
 * The warning (spec §5, D4) shown to whoever switches AI review on, and repeated in the API's
 * answers. `host` and `model` are the configured provider's, `days` the days a snapshot is kept
 * (`reviewSnapshotsDays`). The text is fixed: the guide says the same.
 */
export function dataSharingNotice(host: string, model: string, days: number): string {
  return (
    `AI review sends the merge request's diff and any repository file the model chooses to read to ${host} (${model}). ` +
    `The scanner uploads a copy of the repository to this Qualor server for each merge request; ` +
    `Qualor keeps it until the merge request is closed (at most ${days} days). ` +
    `Secrets the analyzers found are masked; credentials files are never sent.`
  );
}
