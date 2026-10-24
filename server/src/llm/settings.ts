import { SEVERITIES } from '@qualor/shared';
import { sql } from 'drizzle-orm';
import picomatch from 'picomatch';
import { z } from 'zod';
import { decryptSecret, encryptionKey } from '../crypto/secrets';
import type { Executor } from '../db/client';
import { uuidList } from '../db/bulk';
import { instanceSettings, projects } from '../db/schema';
import type { ModelTier } from '../review/model-tiers';
import { defaultReview, reviewSettingsSchema } from '../review/schema';
import { instanceSetting } from '../settings';
import { PROVIDER_KINDS, type ProviderConfig } from './providers';

export const LLM_SETTINGS_KEY = 'llm';
/** llm.md §3.2: the key's envelope decrypts only under this AAD. */
export const LLM_API_KEY_AAD = 'instance_settings.llm.apiKey';

const encrypted = z.strictObject({
  v: z.literal(1),
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
});

export const budgetsSchema = z.strictObject({
  explainPerDay: z.number().int().min(0).max(100_000),
  triagePerDay: z.number().int().min(0).max(100_000),
  fixPerDay: z.number().int().min(0).max(100_000),
  tokensPerDay: z.number().int().min(0).max(1_000_000_000),
  costPerDayUsd: z.number().min(0).max(1_000_000).nullable(),
  perUserPerHour: z.number().int().min(1).max(10_000),
  /**
   * 6I-2: the instance ceiling on an organisation's AI review tokens per UTC day; the effective
   * budget of an organisation is the smaller of this and its own. Null: no ceiling. A row stored
   * before it reads with null.
   */
  reviewTokensPerOrganizationPerDay: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .nullable()
    .default(null),
});
export type Budgets = z.infer<typeof budgetsSchema>;
export const DEFAULT_BUDGETS: Budgets = {
  explainPerDay: 200,
  triagePerDay: 100,
  fixPerDay: 25,
  tokensPerDay: 1_000_000,
  costPerDayUsd: null,
  perUserPerHour: 30,
  reviewTokensPerOrganizationPerDay: null,
};

/** 4E-3a §2: at most this many automatic fix suggestions per analysis. */
export const MAX_AUTO_FIX_PER_ANALYSIS = 25;
/** llm.md §3.3: at most this many ids in an organisation's project lists. */
export const MAX_ORGANIZATION_PROJECT_IDS = 1_000;

/**
 * 4E-3a §2 (llm.md §3.3): the organisation's automatic fix suggestions, for its new findings of
 * a merge request at or above `minSeverity`.
 */
export const autoFixSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  minSeverity: z.enum(SEVERITIES),
  maxPerAnalysis: z.number().int().min(1).max(MAX_AUTO_FIX_PER_ANALYSIS),
});
export type AutoFixSettings = z.infer<typeof autoFixSettingsSchema>;
export const DEFAULT_AUTO_FIX: Readonly<AutoFixSettings> = Object.freeze({
  enabled: false,
  minSeverity: 'high',
  maxPerAnalysis: 10,
});

const projectIds = z.array(z.uuid()).max(MAX_ORGANIZATION_PROJECT_IDS);

/**
 * llm.md §3.3: an organisation's switches; at most 1 000 excluded and 1 000 opted-out projects. A
 * row stored before 4E-3 has neither auto-fix field and reads with the defaults, and one stored
 * before 6I-2 has no `review` block (its AI review: off, no consent).
 */
export const orgLlmSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  features: z.strictObject({ explain: z.boolean(), triage: z.boolean(), fix: z.boolean() }),
  excludedProjectIds: projectIds,
  autoFix: autoFixSettingsSchema.default(() => ({ ...DEFAULT_AUTO_FIX })),
  autoFixDisabledProjectIds: projectIds.default(() => []),
  review: reviewSettingsSchema.default(() => defaultReview()),
});
export type OrgLlmSettings = z.infer<typeof orgLlmSettingsSchema>;
export const DISABLED_ORGANIZATION: OrgLlmSettings = {
  enabled: false,
  features: { explain: false, triage: false, fix: false },
  excludedProjectIds: [],
  autoFix: { ...DEFAULT_AUTO_FIX },
  autoFixDisabledProjectIds: [],
  review: defaultReview(),
};

/** llm.md §3.3: at most this many organisations in the map. */
export const MAX_LLM_ORGANIZATIONS = 1_000;

export const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;

/** llm.md §3.2: the Anthropic Messages API takes a temperature of 0–1, OpenAI's 0–2. */
export const MAX_TEMPERATURE = { openai: 2, anthropic: 1 } as const;
export const ANTHROPIC_TEMPERATURE_TEXT = 'Anthropic takes a temperature of 0 to 1';

export const storedProviderSchema = z
  .strictObject({
    kind: z.enum(PROVIDER_KINDS),
    baseUrl: z.string().min(1).max(2_048),
    /** The standard model: explain, triage and fix use it, and so does a tier without a model of its own. */
    model: z.string().regex(MODEL_PATTERN),
    /**
     * The model of the review's strong tier (the judge and the verification), and of its fast tier
     * (the specialist of a trivial review). Null: the tier uses `model`. A row stored before the
     * tiers reads with null.
     */
    strongModel: z.string().regex(MODEL_PATTERN).nullable().default(null),
    fastModel: z.string().regex(MODEL_PATTERN).nullable().default(null),
    auth: z.enum(['bearer', 'api-key']),
    jsonMode: z.enum(['json_object', 'none']),
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']),
    temperature: z.number().min(0).max(2).nullable(),
    timeoutSeconds: z.number().int().min(5).max(600),
    apiKeyEnc: encrypted.nullable(),
  })
  .refine((p) => p.temperature === null || p.temperature <= MAX_TEMPERATURE[p.kind], {
    message: ANTHROPIC_TEMPERATURE_TEXT,
    path: ['temperature'],
  });
export type StoredProvider = z.infer<typeof storedProviderSchema>;

/**
 * The model a tier has of its own: the strong or fast model when it is set and is not the
 * standard model. Null for the standard tier, and for a tier that uses the standard model, whether
 * it is empty or set to it: such a tier has the standard model's prices too.
 */
export function ownModel(
  provider: Pick<StoredProvider, 'model' | 'strongModel' | 'fastModel'>,
  tier: ModelTier,
): string | null {
  const model =
    tier === 'strong' ? provider.strongModel : tier === 'fast' ? provider.fastModel : null;
  return model === null || model === provider.model ? null : model;
}

/** An `excludePaths` entry: a picomatch glob relative to the repository root. */
export const globSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (g) => !g.includes('\u0000') && !g.startsWith('/'),
    'A glob relative to the repository root',
  );

/** A model's prices: US dollars for a million tokens of input and of output. */
export const pricePairSchema = z.strictObject({
  inputUsdPerMTok: z.number().min(0).max(10_000),
  outputUsdPerMTok: z.number().min(0).max(10_000),
});
export type PricePair = z.infer<typeof pricePairSchema>;

/**
 * The instance's prices: the standard model's, and, with their own models, the strong and the fast
 * model's. Null: no prices, so no costs. A row stored before the tiers reads with none for them.
 */
export const pricingSchema = pricePairSchema
  .extend({
    strong: pricePairSchema.nullable().default(null),
    fast: pricePairSchema.nullable().default(null),
  })
  .nullable();
export type StoredPricing = z.infer<typeof pricingSchema>;

export const storedLlmSettingsSchema = z.strictObject({
  v: z.literal(1),
  provider: storedProviderSchema.nullable(),
  organizations: z.record(z.uuid(), orgLlmSettingsSchema),
  excludePaths: z.array(globSchema).max(100),
  budgets: budgetsSchema,
  pricing: pricingSchema,
  storePrompts: z.boolean(),
  promptRetentionDays: z.number().int().min(1).max(90),
});
export type StoredLlmSettings = z.infer<typeof storedLlmSettingsSchema>;

export const DEFAULT_LLM_SETTINGS: StoredLlmSettings = {
  v: 1,
  provider: null,
  organizations: {},
  excludePaths: [],
  budgets: DEFAULT_BUDGETS,
  pricing: null,
  storePrompts: false,
  promptRetentionDays: 7,
};

/** A row that does not parse reads as "not configured" (fail closed, llm.md §11.2). */
export function readLlmSettings(db: Executor): Promise<StoredLlmSettings> {
  return instanceSetting(db, LLM_SETTINGS_KEY, storedLlmSettingsSchema, DEFAULT_LLM_SETTINGS);
}

export async function writeLlmSettings(tx: Executor, value: StoredLlmSettings): Promise<void> {
  await tx
    .insert(instanceSettings)
    .values({ key: LLM_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: sql`now()` } });
}

/** The stored key: `key: null` for a provider without one; `ok: false` when it no longer decrypts. */
export function providerApiKey(
  settings: StoredLlmSettings,
  secretKey: string,
): { ok: true; key: string | null } | { ok: false } {
  const enc = settings.provider?.apiKeyEnc ?? null;
  if (enc === null) return { ok: true, key: null };
  const key = decryptSecret(encryptionKey(secretKey), enc, LLM_API_KEY_AAD);
  return key === null ? { ok: false } : { ok: true, key };
}

/** What a provider call needs, without the key's envelope. */
export function providerConfig(stored: StoredProvider): ProviderConfig {
  return {
    kind: stored.kind,
    baseUrl: stored.baseUrl,
    model: stored.model,
    auth: stored.auth,
    jsonMode: stored.jsonMode,
    maxTokensField: stored.maxTokensField,
    temperature: stored.temperature,
    timeoutSeconds: stored.timeoutSeconds,
  };
}

/**
 * The prices a call of the tier is costed at: the standard pair for the standard tier and for
 * a tier that uses the standard model, a tier's own pair for a tier with a model of its own. Null
 * without prices, and for a model of its own that has none (a row the API does not store): never
 * the standard pair, which is another model's price.
 */
export function pricingFor(
  pricing: StoredPricing,
  provider: Pick<StoredProvider, 'model' | 'strongModel' | 'fastModel'>,
  tier: ModelTier,
): PricePair | null {
  if (pricing === null) return null;
  if (tier === 'standard' || ownModel(provider, tier) === null) {
    return { inputUsdPerMTok: pricing.inputUsdPerMTok, outputUsdPerMTok: pricing.outputUsdPerMTok };
  }
  return pricing[tier];
}

/** Every tier a call may run on (review/model-tiers.ts lists them too, and imports this module). */
const PRICED_TIERS: readonly ModelTier[] = ['standard', 'strong', 'fast'];

/**
 * The dearest prices a call of the provider may be costed at: the highest input price and the
 * highest output price among the tiers' pairs (`pricingFor`), each from whichever tier has it. A
 * cost that is left to spend is turned into tokens at this price, since the cost of a call is not
 * known before it is made and any tier's may be the next. Every tier counts, though two may name
 * the same model: a call is costed at the pair of its tier. A tier with no pair is left out, and
 * with no pair at all, or no prices, there is none.
 */
export function dearestPrice(
  pricing: StoredPricing,
  provider: Pick<StoredProvider, 'model' | 'strongModel' | 'fastModel'>,
): PricePair | null {
  const pairs = PRICED_TIERS.flatMap((tier) => {
    const pair = pricingFor(pricing, provider, tier);
    return pair === null ? [] : [pair];
  });
  if (pairs.length === 0) return null;
  return {
    inputUsdPerMTok: Math.max(...pairs.map((pair) => pair.inputUsdPerMTok)),
    outputUsdPerMTok: Math.max(...pairs.map((pair) => pair.outputUsdPerMTok)),
  };
}

/** llm.md §3.3: an organisation absent from the map is disabled. */
export function organizationSettings(
  settings: StoredLlmSettings,
  organizationId: string,
): OrgLlmSettings {
  return Object.hasOwn(settings.organizations, organizationId)
    ? (settings.organizations[organizationId] ?? DISABLED_ORGANIZATION)
    : DISABLED_ORGANIZATION;
}

/**
 * The owner of each project id still in the database (a deleted project is absent). Used to drop
 * the excluded and opted-out ids of projects deleted since the settings were saved (llm.md §3.3):
 * an id that no longer exists changes nothing, and must not stop anyone from saving.
 */
export async function projectOwners(
  db: Executor,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (ids.length === 0) return owners;
  const rows = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(sql`${projects.id} IN ${uuidList([...new Set(ids)])}`);
  for (const r of rows) owners.set(r.id, r.organizationId);
  return owners;
}

/**
 * llm.md §3.2: the matcher of `excludePaths`, picomatch with dotfiles, for code that tests many
 * paths against one list.
 */
export function excludedPathMatcher(excludePaths: readonly string[]): (path: string) => boolean {
  if (excludePaths.length === 0) return () => false;
  return picomatch([...excludePaths], { dot: true });
}

/** llm.md §3.2: `excludePaths`, picomatch with dotfiles. */
export function pathExcluded(settings: StoredLlmSettings, path: string | null): boolean {
  return path !== null && excludedPathMatcher(settings.excludePaths)(path);
}
