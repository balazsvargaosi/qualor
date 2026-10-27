import type { RequestBody, ResponseBody } from '../../api/types';
import type { OrgEntry } from './organizations-section';

/** The AI provider's settings as `GET /system/llm` answers them: never the API key. */
export type LlmSettings = ResponseBody<'/api/v0/system/llm', 'get'>;
/** The replace-all body of `PUT /system/llm`, which every section of the instance page saves. */
export type LlmBody = RequestBody<'/api/v0/system/llm', 'put'>;

/** What one section of the instance page saves: its own fields, in place of the stored ones. */
export type SectionChange =
  | { section: 'provider'; provider: LlmBody['provider']; pricing: LlmBody['pricing'] }
  | { section: 'organization'; id: string; entry: OrgEntry }
  | { section: 'limits'; budgets: LlmBody['budgets'] }
  | { section: 'data'; excludePaths: string[]; storePrompts: boolean; promptRetentionDays: number };

/**
 * The whole `PUT` body for one section's change: the settings as last saved, with that section's
 * fields replaced (spec §3.3). The other sections go as stored, so their unsaved drafts stay
 * theirs:
 *
 * - every stored organisation, as its switches and exclusions only: its admins' automatic fix
 *   suggestions and opted-out projects, which the server keeps when they are left out, never go,
 *   nor does the read-only review state;
 * - the provider without a key, so the stored one stays: a key goes only with the provider's own
 *   change, as that change holds it, and a change without one keeps it missing;
 * - the AI review ceiling always, null for none: a body without it would keep a ceiling another
 *   admin stored meanwhile;
 * - never the read-only last Test.
 */
export function bodyFrom(saved: LlmSettings, change: SectionChange): LlmBody {
  const organizations: LlmBody['organizations'] = Object.fromEntries(
    Object.entries(saved.organizations).map(([id, o]) => [
      id,
      {
        enabled: o.enabled,
        features: { ...o.features },
        excludedProjectIds: [...o.excludedProjectIds],
      },
    ]),
  );
  if (change.section === 'organization') organizations[change.id] = change.entry;
  return {
    provider:
      change.section === 'provider'
        ? change.provider
        : saved.provider && storedProviderBody(saved.provider),
    organizations,
    excludePaths: change.section === 'data' ? change.excludePaths : [...saved.excludePaths],
    budgets: change.section === 'limits' ? change.budgets : { ...saved.budgets },
    pricing: change.section === 'provider' ? change.pricing : saved.pricing,
    storePrompts: change.section === 'data' ? change.storePrompts : saved.storePrompts,
    promptRetentionDays:
      change.section === 'data' ? change.promptRetentionDays : saved.promptRetentionDays,
  };
}

/**
 * The stored provider as a body sends it back unchanged: its kind's own fields, without a key, so
 * the stored key stays. The context window goes always, null for none, so that a save never
 * resets a window another admin set through the API. Anthropic's current models take no temperature, and none of the
 * OpenAI-compatible options; an OpenAI-compatible provider has no workspace.
 */
export function storedProviderBody(
  p: NonNullable<LlmSettings['provider']>,
): NonNullable<LlmBody['provider']> {
  const { kind, baseUrl, model, strongModel, fastModel, timeoutSeconds, contextWindowTokens } = p;
  return kind === 'openai'
    ? {
        kind,
        api: p.api,
        baseUrl,
        model,
        strongModel,
        fastModel,
        auth: p.auth,
        jsonMode: p.jsonMode,
        maxTokensField: p.maxTokensField,
        temperature: p.temperature,
        timeoutSeconds,
        contextWindowTokens,
      }
    : {
        kind,
        baseUrl,
        model,
        strongModel,
        fastModel,
        workspaceId: p.workspaceId,
        temperature: null,
        timeoutSeconds,
        contextWindowTokens,
      };
}
