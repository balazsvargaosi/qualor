import { describe, expect, it } from 'vitest';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { defaultReview } from '../review/settings';
import {
  DEFAULT_LLM_SETTINGS,
  CACHE_WRITE_PRICE_FACTOR,
  dearestTokenPrice,
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
  api: 'chat_completions' as const,
  workspaceId: null,
  timeoutSeconds: 60,
};
/** The provider as stored, without its key. */
const provider = { ...CALL, strongModel: null, fastModel: null, contextWindowTokens: null };

/** The provider with these models for its strong and fast tiers. */
const withModels = (strongModel: string | null, fastModel: string | null): StoredProvider => ({
  ...provider,
  strongModel,
  fastModel,
  apiKeyEnc: null,
});

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
      cachedInputUsdPerMTok: null,
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
        cachedInputUsdPerMTok: 0.4,
        strong: { inputUsdPerMTok: 15, outputUsdPerMTok: 75, cachedInputUsdPerMTok: 2 },
        fast: { inputUsdPerMTok: 1, outputUsdPerMTok: 5, cachedInputUsdPerMTok: null },
      },
    };
    expect(storedLlmSettingsSchema.parse(row)).toEqual(row);
  });

  it('a stored price pair without cachedInputUsdPerMTok reads null, and one with it keeps it (R49)', () => {
    // Fictional prices: a row stored before the cached price has none in any pair.
    const before = {
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      strong: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
      fast: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
    };
    expect(pricingSchema.parse(before)).toEqual({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cachedInputUsdPerMTok: null,
      strong: { inputUsdPerMTok: 15, outputUsdPerMTok: 75, cachedInputUsdPerMTok: null },
      fast: { inputUsdPerMTok: 1, outputUsdPerMTok: 5, cachedInputUsdPerMTok: null },
    });
    expect(pricePairSchema.parse({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 })).toEqual({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cachedInputUsdPerMTok: null,
    });
    const kept = { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: 0 };
    expect(pricePairSchema.parse(kept)).toEqual(kept);
    // It is a price like the others: from 0 to 10 000.
    for (const cached of [-0.01, 10_001, '0.3']) {
      expect(
        pricePairSchema.safeParse({ ...kept, cachedInputUsdPerMTok: cached }).success,
        String(cached),
      ).toBe(false);
    }
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

  it('a stored Anthropic temperature is read and ignored: the settings still parse, and a call never receives it', () => {
    // Older settings may hold one (0 to 1 was Anthropic's range); a row that did not parse would
    // read as "no provider" for the whole instance.
    const anthropic = { ...provider, kind: 'anthropic' as const, apiKeyEnc: null };
    for (const temperature of [0, 0.7, 1, 1.5, 2]) {
      const row = { ...DEFAULT_LLM_SETTINGS, provider: { ...anthropic, temperature } };
      const parsed = storedLlmSettingsSchema.parse(row);
      expect(parsed.provider?.temperature, String(temperature)).toBe(temperature);
      expect(providerConfig(parsed.provider!).temperature, String(temperature)).toBeNull();
    }
    // OpenAI's keeps its range of 0 to 2, and is what a call receives.
    const openai = { ...provider, temperature: 1.5, apiKeyEnc: null };
    expect(providerConfig(storedProviderSchema.parse(openai)).temperature).toBe(1.5);
    for (const kind of ['openai', 'anthropic'] as const) {
      for (const temperature of [-0.1, 2.1]) {
        expect(storedProviderSchema.safeParse({ ...openai, kind, temperature }).success).toBe(
          false,
        );
      }
    }
  });

  describe('the API of an OpenAI provider', () => {
    const openai = { ...provider, apiKeyEnc: null };

    it('a stored provider without api reads as chat_completions (settings of an older version)', () => {
      const old = Object.fromEntries(Object.entries(openai).filter(([field]) => field !== 'api'));
      expect(old).not.toHaveProperty('api');
      const parsed = storedLlmSettingsSchema.parse({ ...DEFAULT_LLM_SETTINGS, provider: old });
      expect(parsed.provider?.api).toBe('chat_completions');
      expect(providerConfig(parsed.provider!).api).toBe('chat_completions');
    });

    it('is kept as stored, and a call receives it', () => {
      for (const api of ['chat_completions', 'responses'] as const) {
        const stored = storedProviderSchema.parse({ ...openai, api });
        expect(stored.api).toBe(api);
        expect(providerConfig(stored)).toEqual({ ...CALL, api });
      }
    });

    it.each([
      ['empty', ''],
      ['another API', 'completions'],
      ['the name of the endpoint', '/responses'],
      ['in another case', 'Responses'],
      ['null', null],
    ])('refuses a stored one that is %s', (_name, api) => {
      expect(storedProviderSchema.safeParse({ ...openai, api }).success).toBe(false);
    });
  });

  describe('the workspace id of an Anthropic provider', () => {
    const anthropic = { ...provider, kind: 'anthropic' as const, apiKeyEnc: null };

    it('a stored provider without workspaceId reads as null (settings of an older version)', () => {
      const old = Object.fromEntries(
        Object.entries(anthropic).filter(([field]) => field !== 'workspaceId'),
      );
      expect(old).not.toHaveProperty('workspaceId');
      const parsed = storedLlmSettingsSchema.parse({ ...DEFAULT_LLM_SETTINGS, provider: old });
      expect(parsed.provider?.workspaceId).toBeNull();
      expect(providerConfig(parsed.provider!).workspaceId).toBeNull();
    });

    it('is kept as entered, and a call receives it', () => {
      const stored = storedProviderSchema.parse({ ...anthropic, workspaceId: 'wrkspc_01AbCdEf' });
      expect(stored.workspaceId).toBe('wrkspc_01AbCdEf');
      expect(providerConfig(stored)).toEqual({
        ...CALL,
        kind: 'anthropic',
        workspaceId: 'wrkspc_01AbCdEf',
      });
      const longest = `wrkspc_${'a1'.repeat(32)}`;
      expect(storedProviderSchema.parse({ ...anthropic, workspaceId: longest }).workspaceId).toBe(
        longest,
      );
    });

    it.each([
      ['empty', ''],
      ['the prefix alone', 'wrkspc_'],
      ['without the prefix', '01AbCdEf'],
      ['another prefix', 'workspace_01AbCdEf'],
      ['a dash in it', 'wrkspc_01-AbCd'],
      ['a space in it', 'wrkspc_01 AbCd'],
      ['a line break after it', 'wrkspc_01AbCd\n'],
      ['over 64 characters after the prefix', `wrkspc_${'a'.repeat(65)}`],
    ])('refuses a stored one that is %s', (_name, workspaceId) => {
      expect(storedProviderSchema.safeParse({ ...anthropic, workspaceId }).success).toBe(false);
    });
  });

  describe('the context window of the provider (R46)', () => {
    const stored = { ...provider, apiKeyEnc: null };

    it('a stored provider without contextWindowTokens reads as null (settings of an older version)', () => {
      const old = Object.fromEntries(
        Object.entries(stored).filter(([field]) => field !== 'contextWindowTokens'),
      );
      expect(old).not.toHaveProperty('contextWindowTokens');
      const parsed = storedLlmSettingsSchema.parse({ ...DEFAULT_LLM_SETTINGS, provider: old });
      expect(parsed.provider).not.toBeNull();
      expect(parsed.provider?.contextWindowTokens).toBeNull();
    });

    it('takes a whole number of tokens from 8 000 to 10 000 000, and null', () => {
      for (const contextWindowTokens of [8_000, 32_000, 10_000_000, null]) {
        expect(
          storedProviderSchema.parse({ ...stored, contextWindowTokens }).contextWindowTokens,
        ).toBe(contextWindowTokens);
      }
      for (const contextWindowTokens of [7_999, 10_000_001, 32_000.5, 0, -1, '32000']) {
        expect(
          storedProviderSchema.safeParse({ ...stored, contextWindowTokens }).success,
          String(contextWindowTokens),
        ).toBe(false);
      }
      // A row with one out of bounds does not parse, and reads as not configured (fail closed).
      expect(
        storedLlmSettingsSchema.safeParse({
          ...DEFAULT_LLM_SETTINGS,
          provider: { ...stored, contextWindowTokens: 7_999 },
        }).success,
      ).toBe(false);
    });

    it('is no part of what a call receives', () => {
      const config = providerConfig({ ...stored, contextWindowTokens: 32_000 });
      expect(config).toEqual(CALL);
      expect(config).not.toHaveProperty('contextWindowTokens');
    });
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
  const standard = { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: 0.4 };
  const strong = { inputUsdPerMTok: 15, outputUsdPerMTok: 75, cachedInputUsdPerMTok: 2 };
  const fast = { inputUsdPerMTok: 1, outputUsdPerMTok: 5, cachedInputUsdPerMTok: null };
  const pricing = { ...standard, strong, fast };

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
      'cachedInputUsdPerMTok',
    ]);
  });

  it('carries the cached input price for each tier (R49), null where the pair has none', () => {
    const tiers = withModels('big', 'small');
    expect(pricingFor(pricing, tiers, 'standard')?.cachedInputUsdPerMTok).toBe(0.4);
    expect(pricingFor(pricing, tiers, 'strong')?.cachedInputUsdPerMTok).toBe(2);
    expect(pricingFor(pricing, tiers, 'fast')?.cachedInputUsdPerMTok).toBeNull();
    // A tier on the standard model has the standard model's cached price too.
    expect(pricingFor(pricing, withModels(null, null), 'strong')?.cachedInputUsdPerMTok).toBe(0.4);
    expect(pricingFor(pricing, withModels('m', null), 'strong')?.cachedInputUsdPerMTok).toBe(0.4);
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

describe('dearestTokenPrice', () => {
  const standard = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
  const strong = { inputUsdPerMTok: 15, outputUsdPerMTok: 75 };
  const fast = { inputUsdPerMTok: 1, outputUsdPerMTok: 5 };
  /** A stored pair, with the cached input price it may have (R49). */
  const stored = (pair: typeof standard, cached: number | null = null) => ({
    ...pair,
    cachedInputUsdPerMTok: cached,
  });
  /** A standard pair alone: no tier has prices of its own. */
  const alone = (pair: typeof standard, cached: number | null = null) => ({
    ...stored(pair, cached),
    strong: null,
    fast: null,
  });
  const pricing = {
    ...stored(standard, 0.4),
    strong: stored(strong, 2),
    fast: stored(fast),
  };

  it('is the dearest price of the standard pair while no tier has a model of its own', () => {
    // The tier prices are beside the pair, but no call is costed at them.
    expect(dearestTokenPrice(pricing, withModels(null, null))).toBe(15);
    expect(dearestTokenPrice(pricing, withModels('m', 'm'))).toBe(15);
  });

  it('takes the dearest price among the tiers in use', () => {
    expect(dearestTokenPrice(pricing, withModels('big', 'small'))).toBe(75);
    expect(dearestTokenPrice(pricing, withModels('big', null))).toBe(75);
    // A tier that is dearer than the standard model on one side only.
    const mixed = {
      ...stored(standard),
      strong: stored({ inputUsdPerMTok: 12, outputUsdPerMTok: 20 }),
      fast: stored({ inputUsdPerMTok: 1, outputUsdPerMTok: 40 }),
    };
    expect(dearestTokenPrice(mixed, withModels('big', 'small'))).toBe(40);
  });

  it('is the output price for mainstream prices, as before the cache: output at least 1.25 times input', () => {
    for (const [input, output] of [
      [3, 15],
      [15, 75],
      [1, 5],
      [2, 2.5],
    ] as const) {
      const pair = { inputUsdPerMTok: input, outputUsdPerMTok: output };
      expect(dearestTokenPrice(alone(pair, input), withModels(null, null))).toBe(
        Math.max(input, output),
      );
    }
  });

  it('is 1.25 times the input price when the output price is below that, for a cache write', () => {
    const pair = { inputUsdPerMTok: 20, outputUsdPerMTok: 10 };
    expect(dearestTokenPrice(alone(pair), withModels(null, null))).toBe(25);
    expect(CACHE_WRITE_PRICE_FACTOR).toBe(1.25);
  });

  it('is the cached input price when that is above the others', () => {
    expect(dearestTokenPrice(alone(standard, 40), withModels(null, null))).toBe(40);
    // And not when there is none.
    expect(dearestTokenPrice(alone(standard), withModels(null, null))).toBe(15);
  });

  it('counts the standard model even when every other tier is cheaper', () => {
    const cheaper = { ...stored(standard), strong: stored(fast), fast: stored(fast) };
    expect(dearestTokenPrice(cheaper, withModels('big', 'small'))).toBe(15);
  });

  it('leaves out the price of a tier that has no model of its own', () => {
    // The fast tier uses the standard model, and the fast pair is never read.
    expect(
      dearestTokenPrice(
        { ...pricing, fast: stored({ ...fast, outputUsdPerMTok: 900 }) },
        withModels('big', null),
      ),
    ).toBe(75);
  });

  it('counts the price of each tier that names a model, though two tiers name the same model', () => {
    // A call is costed at the pair of its tier, so the dearer of two pairs for one model counts.
    const same = { ...stored(standard), strong: stored(fast), fast: stored(strong) };
    expect(dearestTokenPrice(same, withModels('both', 'both'))).toBe(75);
  });

  it('is null without prices', () => {
    expect(dearestTokenPrice(null, withModels('big', 'small'))).toBeNull();
    expect(dearestTokenPrice(null, withModels(null, null))).toBeNull();
  });

  it('skips a model of its own that has no prices, and answers the pairs that are known', () => {
    // The API refuses to store this; the known pairs still bound the cost.
    const unpriced = { ...stored(standard), strong: null, fast: stored(fast) };
    expect(dearestTokenPrice(unpriced, withModels('big', 'small'))).toBe(15);
  });
});
