import { CONFIGURED, EMPTY, KEY } from '../../../testing/ai-settings';
import { ORG_ID } from '../../../testing/fake-server';
import { bodyFrom, type LlmSettings, type SectionChange, storedProviderBody } from './llm-body';

const OTHER_ID = '0190a6c2-0000-7000-8000-000000000002';
const NEW_ID = '0190a6c2-0000-7000-8000-000000000003';

/**
 * Two organisations as `GET /system/llm` answers them: each with the fields its admins own (the
 * automatic fix suggestions, the projects opted out of them) and the read-only review state.
 */
const SAVED = {
  ...CONFIGURED,
  organizations: {
    [ORG_ID]: {
      ...CONFIGURED.organizations[ORG_ID],
      excludedProjectIds: ['p1'],
      autoFix: { enabled: true, minSeverity: 'medium', maxPerAnalysis: 5 },
      autoFixDisabledProjectIds: ['p2'],
      reviewStatus: { enabled: true, consentCurrent: true },
    },
    [OTHER_ID]: {
      enabled: false,
      features: { explain: false, triage: true, fix: false },
      excludedProjectIds: [],
      autoFix: { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
      autoFixDisabledProjectIds: [],
      reviewStatus: { enabled: false, consentCurrent: false },
    },
  },
  lastTest: {
    at: '2026-10-26T14:02:00.000Z',
    userId: '0190a6c2-0000-7000-8000-00000000000a',
    models: [
      {
        tier: 'standard',
        model: 'qwen2.5-coder',
        ok: true,
        toolCalling: 'supported',
        problemCode: null,
      },
    ],
  },
} as unknown as LlmSettings;

const ANTHROPIC = {
  ...CONFIGURED,
  provider: {
    ...CONFIGURED.provider,
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5-5',
    strongModel: 'claude-opus-5-5',
    workspaceId: 'wrkspc_01AbCdEf',
    timeoutSeconds: 120,
  },
} as unknown as LlmSettings;

const LIMITS: SectionChange = {
  section: 'limits',
  budgets: { ...EMPTY.budgets, explainPerDay: 300 },
};
const DATA: SectionChange = {
  section: 'data',
  excludePaths: ['legacy/**'],
  storePrompts: true,
  promptRetentionDays: 14,
};
const ENTRY = {
  enabled: true,
  features: { explain: true, triage: false, fix: true },
  excludedProjectIds: ['p9'],
};

/** Freezes a value and everything in it: a builder that changes its input throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('bodyFrom', () => {
  it('sends every stored organisation as switches and exclusions, never auto-fix or reviewStatus', () => {
    for (const change of [LIMITS, DATA]) {
      expect(bodyFrom(SAVED, change).organizations).toEqual({
        [ORG_ID]: {
          enabled: true,
          features: { explain: true, triage: true, fix: false },
          excludedProjectIds: ['p1'],
        },
        [OTHER_ID]: {
          enabled: false,
          features: { explain: false, triage: true, fix: false },
          excludedProjectIds: [],
        },
      });
    }
    // An organisation's change replaces its entry alone; one the settings lack is added.
    expect(
      bodyFrom(SAVED, { section: 'organization', id: OTHER_ID, entry: ENTRY }).organizations,
    ).toEqual({
      [ORG_ID]: {
        enabled: true,
        features: { explain: true, triage: true, fix: false },
        excludedProjectIds: ['p1'],
      },
      [OTHER_ID]: ENTRY,
    });
    const added = bodyFrom(SAVED, { section: 'organization', id: NEW_ID, entry: ENTRY });
    expect(Object.keys(added.organizations)).toEqual([ORG_ID, OTHER_ID, NEW_ID]);
    for (const entry of Object.values(added.organizations)) {
      expect(Object.keys(entry).sort()).toEqual(['enabled', 'excludedProjectIds', 'features']);
    }
  });

  it('sends the stored ceiling, and null for none', () => {
    const capped = {
      ...SAVED,
      budgets: { ...SAVED.budgets, reviewTokensPerOrganizationPerDay: 750_000 },
    };
    expect(bodyFrom(capped, DATA).budgets).toEqual({
      ...EMPTY.budgets,
      reviewTokensPerOrganizationPerDay: 750_000,
    });
    // Null, not left out: a body without it would keep a ceiling stored meanwhile.
    expect(bodyFrom(SAVED, DATA).budgets).toHaveProperty('reviewTokensPerOrganizationPerDay', null);
    // The Limits section's budgets are sent as it gives them.
    expect(bodyFrom(capped, LIMITS).budgets).toEqual(
      (LIMITS as Extract<SectionChange, { section: 'limits' }>).budgets,
    );
  });

  it('sends the other sections as stored, and what is read-only never', () => {
    const body = bodyFrom(SAVED, LIMITS);
    expect(body).toEqual({
      provider: storedProviderBody(SAVED.provider!),
      organizations: bodyFrom(SAVED, DATA).organizations,
      excludePaths: [],
      budgets: { ...EMPTY.budgets, explainPerDay: 300 },
      pricing: null,
      storePrompts: false,
      promptRetentionDays: 7,
    });
    expect(body).not.toHaveProperty('lastTest');
    expect(bodyFrom(SAVED, DATA)).toMatchObject({
      excludePaths: ['legacy/**'],
      storePrompts: true,
      promptRetentionDays: 14,
      budgets: EMPTY.budgets,
    });
    const pricing = { inputUsdPerMTok: 1, outputUsdPerMTok: 2, strong: null, fast: null };
    expect(bodyFrom(SAVED, { section: 'provider', provider: null, pricing })).toMatchObject({
      provider: null,
      pricing,
      excludePaths: [],
      storePrompts: false,
    });
  });

  it('never changes what it is given', () => {
    const saved = deepFreeze(structuredClone(SAVED));
    for (const change of [
      LIMITS,
      DATA,
      { section: 'organization', id: ORG_ID, entry: ENTRY } as const,
      {
        section: 'provider',
        provider: { ...storedProviderBody(SAVED.provider!), apiKey: KEY },
        pricing: null,
      } as const,
    ]) {
      const frozen = deepFreeze(structuredClone(change));
      expect(() => bodyFrom(saved, frozen)).not.toThrow();
    }
    // The body's lists are its own: changing them changes nothing stored.
    const body = bodyFrom(SAVED, LIMITS);
    expect(body.excludePaths).not.toBe(SAVED.excludePaths);
    expect(body.organizations[ORG_ID]!.excludedProjectIds).not.toBe(
      SAVED.organizations[ORG_ID]!.excludedProjectIds,
    );
  });

  it('never sends an API key unless the provider section changes', () => {
    for (const change of [
      LIMITS,
      DATA,
      { section: 'organization', id: ORG_ID, entry: ENTRY } as const,
    ]) {
      expect(bodyFrom(SAVED, change).provider).not.toHaveProperty('apiKey');
    }
    const provider = storedProviderBody(SAVED.provider!);
    // A key typed is sent once, with the provider's change; a key removed is null.
    expect(
      bodyFrom(SAVED, {
        section: 'provider',
        provider: { ...provider, apiKey: KEY },
        pricing: null,
      }).provider,
    ).toHaveProperty('apiKey', KEY);
    expect(
      bodyFrom(SAVED, {
        section: 'provider',
        provider: { ...provider, apiKey: null },
        pricing: null,
      }).provider,
    ).toHaveProperty('apiKey', null);
    // Without one, the key stays missing (never null, which would remove the stored key).
    expect(
      bodyFrom(SAVED, { section: 'provider', provider, pricing: null }).provider,
    ).not.toHaveProperty('apiKey');
    // The next save builds on the settings the server answered, which hold no key: nothing of the
    // provider's change, and so of its key, is kept for it.
    const answer = { ...SAVED, provider: { ...SAVED.provider!, apiKeySet: true } };
    const next = JSON.stringify(bodyFrom(answer, LIMITS));
    expect(next).not.toContain(KEY);
    expect(next).not.toContain('apiKey');
  });

  it('sends an Anthropic provider without the OpenAI fields', () => {
    expect(bodyFrom(ANTHROPIC, DATA).provider).toEqual({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5-5',
      strongModel: 'claude-opus-5-5',
      fastModel: null,
      workspaceId: 'wrkspc_01AbCdEf',
      temperature: null,
      timeoutSeconds: 120,
      contextWindowTokens: null,
    });
  });

  it('sends an OpenAI-compatible provider with its own fields and without the workspace', () => {
    const saved = {
      ...CONFIGURED,
      provider: {
        ...CONFIGURED.provider,
        api: 'responses',
        auth: 'api-key',
        jsonMode: 'none',
        maxTokensField: 'max_completion_tokens',
        temperature: 0.2,
        fastModel: 'qwen-small',
      },
    } as unknown as LlmSettings;
    expect(bodyFrom(saved, DATA).provider).toEqual({
      kind: 'openai',
      api: 'responses',
      baseUrl: 'http://ollama:11434/v1',
      model: 'qwen2.5-coder',
      strongModel: null,
      fastModel: 'qwen-small',
      auth: 'api-key',
      jsonMode: 'none',
      maxTokensField: 'max_completion_tokens',
      temperature: 0.2,
      timeoutSeconds: 60,
      contextWindowTokens: null,
    });
    expect(bodyFrom(EMPTY as unknown as LlmSettings, DATA).provider).toBeNull();
  });

  it("sends the stored context window with every section's save, null when none is set", () => {
    const window32k = {
      ...SAVED,
      provider: { ...SAVED.provider!, contextWindowTokens: 32_000 },
    } as unknown as LlmSettings;
    // A save that does not touch the field sends it back as stored, so an API-set window survives.
    expect(bodyFrom(window32k, LIMITS).provider).toMatchObject({ contextWindowTokens: 32_000 });
    expect(bodyFrom(window32k, DATA).provider).toMatchObject({ contextWindowTokens: 32_000 });
    expect(storedProviderBody(window32k.provider!)).toMatchObject({ contextWindowTokens: 32_000 });
    expect(bodyFrom(SAVED, LIMITS).provider).toMatchObject({ contextWindowTokens: null });
  });

  it("sends an Anthropic provider's context window, and null once the section clears it", () => {
    const anthropic = {
      ...ANTHROPIC,
      provider: { ...ANTHROPIC.provider!, contextWindowTokens: 200_000 },
    } as unknown as LlmSettings;
    expect(bodyFrom(anthropic, DATA).provider).toMatchObject({ contextWindowTokens: 200_000 });
    const cleared = bodyFrom(anthropic, {
      section: 'provider',
      provider: { ...storedProviderBody(anthropic.provider!), contextWindowTokens: null },
      pricing: null,
    });
    expect(cleared.provider).toMatchObject({ contextWindowTokens: null });
  });
});
