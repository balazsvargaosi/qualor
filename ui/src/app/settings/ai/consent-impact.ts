import type { Organization } from '../../api/types';
import type { LlmSettings } from './llm-body';

/** The provider's fields an organisation's AI review confirmation names: its address and models. */
export interface ConsentInput {
  baseUrl: string;
  model: string;
  strongModel: string | null;
  fastModel: string | null;
}

/**
 * What an organisation's AI review confirmation names of a provider, as the server compares it:
 * the address without its trailing slashes (`normalBaseUrl`), its host, the standard model, and
 * every model once, sorted (`distinctModels`). An empty tier field is no model of its own, as the
 * body sends it (null). Throws for an address that does not parse.
 */
export function consentFields(p: ConsentInput): {
  url: string;
  host: string;
  model: string;
  models: string[];
} {
  const parsed = new URL(p.baseUrl.trim());
  const url = parsed.href.replace(/\/+$/, '');
  const models = [
    ...new Set([p.model, p.strongModel || p.model, p.fastModel || p.model].map((m) => m.trim())),
  ].sort();
  return { url, host: parsed.host, model: p.model.trim(), models };
}

/**
 * Whether saving `draft` in place of the saved provider pauses AI review where its admins
 * confirmed the saved one: another address (its path too), standard model or set of models.
 * Removing a saved provider (`draft` null) pauses it too. Nothing was confirmed without a saved
 * provider, so nothing pauses then. An address that does not parse pauses nothing here: the
 * page's own check refuses it first.
 */
export function pausesReview(saved: LlmSettings['provider'], draft: ConsentInput | null): boolean {
  if (saved === null) return false;
  if (draft === null) return true;
  let next: ReturnType<typeof consentFields>;
  try {
    next = consentFields(draft);
  } catch {
    return false;
  }
  const before = consentFields(saved);
  return (
    before.url !== next.url ||
    before.host !== next.host ||
    before.model !== next.model ||
    before.models.length !== next.models.length ||
    before.models.some((model, i) => model !== next.models[i])
  );
}

/**
 * The organisations whose AI review is on and confirmed for the provider saved now, in the order
 * given: those a provider change pauses. Only an organisation that may use AI reviews: one that
 * may not reviews nothing, whatever its admins switched on. An organisation the settings do not
 * hold has neither.
 */
export function reviewingOrganizations(
  settings: LlmSettings,
  organizations: readonly Organization[],
): { id: string; name: string }[] {
  return organizations
    .filter((o) => {
      const entry = settings.organizations[o.id];
      return entry !== undefined && reviewing(entry);
    })
    .map((o) => ({ id: o.id, name: o.name }));
}

/**
 * How many organisations a provider change pauses that `organizations` does not name: they may
 * use AI, their AI review is on and confirmed, and the list lacks them (it could not be read, or
 * ends before them). They are counted, so the question before the change is still asked.
 */
export function unnamedReviewing(
  settings: LlmSettings,
  organizations: readonly Organization[],
): number {
  const named = new Set(organizations.map((o) => o.id));
  return Object.entries(settings.organizations).filter(
    ([id, entry]) => !named.has(id) && reviewing(entry),
  ).length;
}

/** An organisation reviews: it may use AI, and its review is on and confirmed for the provider. */
function reviewing(entry: LlmSettings['organizations'][string]): boolean {
  return entry.enabled && entry.reviewStatus.enabled && entry.reviewStatus.consentCurrent;
}
