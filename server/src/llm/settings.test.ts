import { describe, expect, it } from 'vitest';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { defaultReview } from '../review/settings';
import {
  DEFAULT_LLM_SETTINGS,
  excludedPathMatcher,
  LLM_API_KEY_AAD,
  organizationSettings,
  pathExcluded,
  pricePairSchema,
  pricingFor,
  pricingSchema,
  providerApiKey,
  providerConfig,
  storedLlmSettingsSchema,
  storedProviderSchema,
  type StoredLlmSettings,
  type StoredProvider,
} from './settings';

const SECRET = 'test-secret-key-that-is-at-least-32-characters';
/** What a provider call receives. */
const CALL = {
  kind: 'openai' as const,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  auth: 'bearer' as const,
  jsonMode: 'json_object' as const,
  maxTokensField: 'max_tokens' as const,
  temperature: null,
  timeoutSeconds: 60,
};
/** The provider as stored, without its key. */
const provider = { ...CALL, strongModel: null, fastModel: null };

describe('LLM settings (llm.md §3)', () => {
  it('reads the defaults as not configured', () => {
    expect(storedLlmSettingsSchema.parse(DEFAULT_LLM_SETTINGS).provider).toBeNull();
  });

  it('decrypts the key only under its own AAD', () => {
    const key = encryptionKey(SECRET);
    const s: StoredLlmSettings = {
      ...DEFAULT_LLM_SETTINGS,
      provider: { ...provider, apiKeyEnc: encryptSecret(key, 'k-1', LLM_API_KEY_AAD) },
    };
    expect(providerApiKey(s, SECRET)).toEqual({ ok: true, key: 'k-1' });
    const other: StoredLlmSettings = {
      ...s,
      provider: {
        ...provider,
        apiKeyEnc: encryptSecret(key, 'k-1', 'webhook_subscriptions.secret_enc'),
      },
    };
    expect(providerApiKey(other, SECRET)).toEqual({ ok: false });
    expect(providerApiKey(s, `${SECRET}-rotated`)).toEqual({ ok: false });
    expect(providerApiKey({ ...s, provider: { ...provider, apiKeyEnc: null } }, SECRET)).toEqual({
      ok: true,
      key: null,
    });
  });

  it('keeps the key out of the provider config', () => {
    const key = encryptionKey(SECRET);
    const config = providerConfig({
      ...provider,
      apiKeyEnc: encryptSecret(key, 'k-1', LLM_API_KEY_AAD),
    });
    expect(config).toEqual(CALL);
    expect(JSON.stringify(config)).not.toContain('"ct"');
  });

  it('keeps the tier models out of what a provider call receives', () => {
    const config = providerConfig({
      ...provider,
      strongModel: 'big',
      fastModel: 'small',
      apiKeyEnc: null,
    });
    expect(config).toEqual(CALL);
    expect(config).not.toHaveProperty('strongModel');
    expect(config).not.toHaveProperty('fastModel');
  });

  it('a stored provider without tier fields still parses', () => {
    // The row as it was stored before the tiers: no tier model, and prices without tier prices.
    // A row that did not parse would read as "no provider" for the whole instance.
    const old = {
      v: 1,
      provider: { ...CALL, apiKeyEnc: null },
      organizations: {},
      excludePaths: [],
      budgets: {
        explainPerDay: 200,
        triagePerDay: 100,
        fixPerDay: 25,
        tokensPerDay: 1_000_000,
        costPerDayUsd: null,
        perUserPerHour: 30,
      },
      pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
      storePrompts: false,
      promptRetentionDays: 7,
    };
    const parsed = storedLlmSettingsSchema.parse(old);
    expect(parsed.provider).toMatchObject({ model: 'm', strongModel: null, fastModel: null });
    expect(parsed.pricing).toEqual({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      strong: null,
      fast: null,
    });
    // Without prices, as before.
    expect(storedLlmSettingsSchema.parse({ ...old, pricing: null }).pricing).toBeNull();
  });

  it('reads the tier models and their prices as stored', () => {
    const row = {
      ...DEFAULT_LLM_SETTINGS,
      provider: { ...provider, strongModel: 'big', fastModel: 'small', apiKeyEnc: null },
      pricing: {
        inputUsdPerMTok: 3,
        outputUsdPerMTok: 15,
        strong: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
        fast: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
      },
    };
    expect(storedLlmSettingsSchema.parse(row)).toEqual(row);
  });

  it.each([
    ['empty', ''],
    ['not a model name', 'bad model'],
    ['over 200 characters', 'm'.repeat(201)],
  ])('refuses a stored tier model that is %s', (_name, model) => {
    const stored = { ...provider, apiKeyEnc: null };
    expect(storedProviderSchema.safeParse({ ...stored, strongModel: model }).success).toBe(false);
    expect(storedProviderSchema.safeParse({ ...stored, fastModel: model }).success).toBe(false);
    expect(
      storedProviderSchema.safeParse({ ...stored, strongModel: 'm'.repeat(200) }).success,
    ).toBe(true);
  });

  it.each([
    ['a negative price', { inputUsdPerMTok: -1, outputUsdPerMTok: 5 }],
    ['a price over 10 000', { inputUsdPerMTok: 1, outputUsdPerMTok: 10_001 }],
    ['a field of its own', { inputUsdPerMTok: 1, outputUsdPerMTok: 5, extra: 1 }],
    ['one price only', { inputUsdPerMTok: 1 }],
  ])('refuses a stored tier price with %s', (_name, pair) => {
    const standard = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
    expect(pricingSchema.safeParse({ ...standard, strong: pair }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...standard, fast: pair }).success).toBe(false);
    expect(pricePairSchema.safeParse(pair).success).toBe(false);
  });

  it('keeps the stored prices strict: a field of its own is refused', () => {
    const standard = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
    expect(pricingSchema.safeParse({ ...standard, extra: 1 }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...standard, medium: standard }).success).toBe(false);
  });

  it('refuses a stored Anthropic temperature above 1 (fails closed as not configured)', () => {
    const anthropic = { ...provider, kind: 'anthropic' as const, apiKeyEnc: null };
    const ok = { ...DEFAULT_LLM_SETTINGS, provider: { ...anthropic, temperature: 1 } };
    expect(storedLlmSettingsSchema.safeParse(ok).success).toBe(true);
    const hot = { ...DEFAULT_LLM_SETTINGS, provider: { ...anthropic, temperature: 1.5 } };
    expect(storedLlmSettingsSchema.safeParse(hot).success).toBe(false);
    const openai = {
      ...DEFAULT_LLM_SETTINGS,
      provider: { ...provider, temperature: 1.5, apiKeyEnc: null },
    };
    expect(storedLlmSettingsSchema.safeParse(openai).success).toBe(true);
  });

  it('reads an organisation absent from the map as disabled', () => {
    const id = '00000000-0000-7000-8000-000000000001';
    expect(organizationSettings(DEFAULT_LLM_SETTINGS, id)).toEqual({
      enabled: false,
      features: { explain: false, triage: false, fix: false },
      excludedProjectIds: [],
      autoFix: { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
      autoFixDisabledProjectIds: [],
      review: defaultReview(),
    });
  });

  it('matches excluded paths, dotfiles included', () => {
    const s = { ...DEFAULT_LLM_SETTINGS, excludePaths: ['secrets/**', '**/*.gen.ts'] };
    expect(pathExcluded(s, 'secrets/a/b.ts')).toBe(true);
    expect(pathExcluded(s, 'src/.hidden/x.gen.ts')).toBe(true);
    expect(pathExcluded(s, 'src/a.ts')).toBe(false);
    expect(pathExcluded(s, null)).toBe(false);
  });

  it('compiles the excluded paths once for many paths, as pathExcluded reads them', () => {
    const globs = ['secrets/**', '**/*.gen.ts', '.env*'];
    const excluded = excludedPathMatcher(globs);
    const s = { ...DEFAULT_LLM_SETTINGS, excludePaths: globs };
    for (const path of [
      'secrets',
      'secrets/a/b.ts',
      'src/.hidden/x.gen.ts',
      '.env.local',
      'src/a.ts',
    ]) {
      expect(excluded(path), path).toBe(pathExcluded(s, path));
    }
    expect(excluded('secrets/a/b.ts')).toBe(true);
    expect(excluded('src/a.ts')).toBe(false);
    // No globs exclude nothing.
    expect(excludedPathMatcher([])('anything/at/all')).toBe(false);
  });
});

describe('pricingFor', () => {
  const standard = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
  const strong = { inputUsdPerMTok: 15, outputUsdPerMTok: 75 };
  const fast = { inputUsdPerMTok: 1, outputUsdPerMTok: 5 };
  const pricing = { ...standard, strong, fast };
  const withModels = (strongModel: string | null, fastModel: string | null): StoredProvider => ({
    ...provider,
    strongModel,
    fastModel,
    apiKeyEnc: null,
  });

  it('takes the price pair of the model of the tier', () => {
    const tiers = withModels('big', 'small');
    expect(pricingFor(pricing, tiers, 'standard')).toEqual(standard);
    expect(pricingFor(pricing, tiers, 'strong')).toEqual(strong);
    expect(pricingFor(pricing, tiers, 'fast')).toEqual(fast);
  });

  it('prices a tier that falls back to the standard model at the standard pair', () => {
    expect(pricingFor(pricing, withModels(null, null), 'strong')).toEqual(standard);
    expect(pricingFor(pricing, withModels(null, null), 'fast')).toEqual(standard);
    // Only the empty tier falls back.
    expect(pricingFor(pricing, withModels('big', null), 'fast')).toEqual(standard);
    expect(pricingFor(pricing, withModels('big', null), 'strong')).toEqual(strong);
  });

  it('prices a tier model set to the standard model at the standard pair', () => {
    expect(pricingFor(pricing, withModels('m', 'small'), 'strong')).toEqual(standard);
  });

  it('answers the pair alone, never the tier prices beside it', () => {
    expect(Object.keys(pricingFor(pricing, withModels('big', 'small'), 'standard')!)).toEqual([
      'inputUsdPerMTok',
      'outputUsdPerMTok',
    ]);
  });

  it('is null without prices', () => {
    for (const tier of ['strong', 'standard', 'fast'] as const) {
      expect(pricingFor(null, withModels('big', 'small'), tier)).toBeNull();
    }
  });

  it('is null for a model of its own that has no prices, not the standard pair', () => {
    // The API refuses to store this; a row that holds it must not cost a call at another model's price.
    const unpriced = { ...standard, strong: null, fast: null };
    expect(pricingFor(unpriced, withModels('big', 'small'), 'strong')).toBeNull();
    expect(pricingFor(unpriced, withModels('big', 'small'), 'fast')).toBeNull();
    expect(pricingFor(unpriced, withModels('big', 'small'), 'standard')).toEqual(standard);
  });
});
