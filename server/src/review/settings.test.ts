import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGETS,
  DEFAULT_LLM_SETTINGS,
  MAX_ORGANIZATION_PROJECT_IDS,
  MODEL_PATTERN,
  storedLlmSettingsSchema,
  type OrgLlmSettings,
  type StoredLlmSettings,
  type StoredProvider,
} from '../llm/settings';
import {
  acknowledgesProvider,
  consentCurrent,
  consentModels,
  dataSharingNotice,
  DEFAULT_REVIEW,
  effectiveReviewBudgets,
  isDefaultReview,
  MAX_REVIEW_PROJECT_IDS,
  MODEL_NAME_PATTERN,
  organizationReviewInactive,
  projectAiReview,
  REVIEW_INACTIVE_REASONS,
  reviewActive,
  reviewBudgetsSchema,
  reviewConsentSchema,
  reviewProvider,
  reviewSettingsOf,
  reviewSettingsSchema,
  sameReview,
  withOrganizationReview,
  type ReviewInactiveReason,
  type ReviewSettings,
} from './settings';

const ORG = '00000000-0000-7000-8000-000000000001';
const OTHER_ORG = '00000000-0000-7000-8000-000000000002';
const PROJECT = '00000000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT = '00000000-0000-7000-8000-0000000000a2';
const USER = '00000000-0000-7000-8000-0000000000b1';
const CONNECTION = '00000000-0000-7000-8000-0000000000c1';

const PROVIDER: StoredProvider = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-x',
  strongModel: null,
  fastModel: null,
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_tokens',
  temperature: null,
  api: 'chat_completions',
  workspaceId: null,
  timeoutSeconds: 60,
  apiKeyEnc: null,
};

/** A consent as it was stored before the tiers: it names one model and no list of models. */
const CONSENT = {
  providerUrl: 'https://api.openai.com/v1',
  providerHost: 'api.openai.com',
  model: 'gpt-x',
  userId: USER,
  at: '2027-01-01T00:00:00.000Z',
};

const ON: ReviewSettings = {
  ...DEFAULT_REVIEW,
  enabled: true,
  scope: 'selected',
  projectIds: [PROJECT],
  consent: CONSENT,
};

const ORG_ON: OrgLlmSettings = {
  enabled: true,
  features: { explain: false, triage: false, fix: false },
  excludedProjectIds: [],
  autoFix: { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
  autoFixDisabledProjectIds: [],
  review: ON,
};

const settingsWith = (
  review: Partial<ReviewSettings> = {},
  org: Partial<OrgLlmSettings> = {},
  provider: StoredProvider | null = PROVIDER,
): StoredLlmSettings => ({
  ...DEFAULT_LLM_SETTINGS,
  provider,
  organizations: { [ORG]: { ...ORG_ON, ...org, review: { ...ON, ...review } } },
});

const mapped = { id: PROJECT, organizationId: ORG, scmConnectionId: CONNECTION };
const unmapped = { ...mapped, scmConnectionId: null };

describe('the review settings (6I-2, llm.md §3.3)', () => {
  it('defaults to off, selected projects only, no project, no consent', () => {
    expect(DEFAULT_REVIEW).toEqual({
      enabled: false,
      scope: 'selected',
      projectIds: [],
      budgets: {
        tokensPerDay: 2_000_000,
        costPerDayUsd: null,
        perProjectTokensPerDay: null,
        maxTokensPerReview: 300_000,
      },
      consent: null,
    });
    expect(reviewSettingsSchema.safeParse(DEFAULT_REVIEW).success).toBe(true);
  });

  it('reads a stored row written before them with the defaults', () => {
    const old = {
      v: 1,
      provider: null,
      organizations: {
        [ORG]: {
          enabled: true,
          features: { explain: true, triage: true, fix: true },
          excludedProjectIds: [PROJECT],
          autoFix: { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
          autoFixDisabledProjectIds: [],
        },
      },
      excludePaths: [],
      budgets: {
        explainPerDay: 200,
        triagePerDay: 100,
        fixPerDay: 25,
        tokensPerDay: 1_000_000,
        costPerDayUsd: null,
        perUserPerHour: 30,
      },
      pricing: null,
      storePrompts: false,
      promptRetentionDays: 7,
    };
    const parsed = storedLlmSettingsSchema.parse(old);
    expect(parsed.organizations[ORG]!.review).toEqual(DEFAULT_REVIEW);
    // The instance ceiling: none until the instance administrator sets one.
    expect(parsed.budgets.reviewTokensPerOrganizationPerDay).toBeNull();
    expect(DEFAULT_BUDGETS.reviewTokensPerOrganizationPerDay).toBeNull();
  });

  it('gives every parsed organisation its own default objects', () => {
    const org = {
      enabled: false,
      features: { explain: false, triage: false, fix: false },
      excludedProjectIds: [],
    };
    const parsed = storedLlmSettingsSchema.parse({
      ...DEFAULT_LLM_SETTINGS,
      organizations: { [ORG]: org, [OTHER_ORG]: org },
    });
    const a = parsed.organizations[ORG]!.review;
    const b = parsed.organizations[OTHER_ORG]!.review;
    expect(a).not.toBe(b);
    expect(a.projectIds).not.toBe(b.projectIds);
    expect(a.budgets).not.toBe(b.budgets);
    expect(a).not.toBe(DEFAULT_REVIEW);
  });

  it('keeps the shared defaults frozen', () => {
    expect(Object.isFrozen(DEFAULT_REVIEW)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REVIEW.projectIds)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REVIEW.budgets)).toBe(true);
  });

  it('bounds the project list as the other organisation lists', () => {
    expect(MAX_REVIEW_PROJECT_IDS).toBe(MAX_ORGANIZATION_PROJECT_IDS);
    const ids = Array.from(
      { length: 1_001 },
      (_, i) => `00000000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
    );
    expect(reviewSettingsSchema.safeParse({ ...ON, projectIds: ids }).success).toBe(false);
    expect(reviewSettingsSchema.safeParse({ ...ON, projectIds: ids.slice(0, 1_000) }).success).toBe(
      true,
    );
  });

  it('names a model as the provider settings do: by the one pattern', () => {
    expect(MODEL_PATTERN).toBe(MODEL_NAME_PATTERN);
  });

  it.each<[string, unknown]>([
    ['an unknown scope', { ...ON, scope: 'some' }],
    ['an unknown field', { ...ON, extra: 1 }],
    ['a project id that is not a UUID', { ...ON, projectIds: ['p1'] }],
    ['negative daily tokens', { ...ON, budgets: { ...ON.budgets, tokensPerDay: -1 } }],
    ['fractional daily tokens', { ...ON, budgets: { ...ON.budgets, tokensPerDay: 1.5 } }],
    ['a negative cost', { ...ON, budgets: { ...ON.budgets, costPerDayUsd: -0.01 } }],
    ['no tokens per review', { ...ON, budgets: { ...ON.budgets, maxTokensPerReview: 0 } }],
    ['a budget field missing', { ...ON, budgets: { tokensPerDay: 1 } }],
  ])('refuses %s', (_name, value) => {
    expect(reviewSettingsSchema.safeParse(value).success).toBe(false);
  });

  it('accepts the bounds of the budgets', () => {
    for (const budgets of [
      { tokensPerDay: 0, costPerDayUsd: 0, perProjectTokensPerDay: 0, maxTokensPerReview: 1 },
      {
        tokensPerDay: 1_000_000_000,
        costPerDayUsd: 1_000_000,
        perProjectTokensPerDay: 1_000_000_000,
        maxTokensPerReview: 10_000_000,
      },
    ]) {
      expect(reviewBudgetsSchema.safeParse(budgets).success, JSON.stringify(budgets)).toBe(true);
    }
    expect(reviewBudgetsSchema.safeParse({ ...DEFAULT_REVIEW.budgets, extra: 1 }).success).toBe(
      false,
    );
    // A consent stored before the tiers names no list of models, and still parses.
    expect(reviewConsentSchema.safeParse(CONSENT).success).toBe(true);
    for (const models of [['gpt-x'], ['gpt-x', 'gpt-x-big', 'gpt-x-mini']]) {
      expect(reviewConsentSchema.safeParse({ ...CONSENT, models }).success, models.join()).toBe(
        true,
      );
    }
  });

  it.each<[string, unknown]>([
    [
      'one without the base URL (stored before the consent named it)',
      Object.fromEntries(Object.entries(CONSENT).filter(([key]) => key !== 'providerUrl')),
    ],
    ['one without a user', { ...CONSENT, userId: undefined }],
    ['one with a time that is not a time', { ...CONSENT, at: 'yesterday' }],
    ['one with a base URL that is empty', { ...CONSENT, providerUrl: '' }],
    ['one with a field of its own', { ...CONSENT, extra: 1 }],
    ['one that is not an object', 'yes'],
    ['one that lists no model', { ...CONSENT, models: [] }],
    ['one that lists four models', { ...CONSENT, models: ['a', 'b', 'c', 'd'] }],
    ['one that lists a model that is not a model name', { ...CONSENT, models: ['bad model'] }],
    ['one whose models are not a list', { ...CONSENT, models: 'gpt-x' }],
  ])('reads %s as no consent, and keeps the rest of the block (fail closed)', (_name, consent) => {
    expect(reviewConsentSchema.safeParse(consent).success).toBe(false);
    expect(reviewSettingsSchema.parse({ ...ON, consent })).toEqual({ ...ON, consent: null });
  });

  it('reads a stored organisation whose consent lacks the base URL as having none, and keeps the provider', () => {
    const old = Object.fromEntries(
      Object.entries(CONSENT).filter(([key]) => key !== 'providerUrl'),
    );
    const row = {
      ...settingsWith(),
      organizations: { [ORG]: { ...ORG_ON, review: { ...ON, consent: old } } },
    };
    const parsed = storedLlmSettingsSchema.parse(row);
    expect(parsed.provider).toEqual(PROVIDER);
    expect(parsed.organizations[ORG]!.review).toEqual({ ...ON, consent: null });
    // Reviews stop until the organisation admin acknowledges again.
    expect(reviewActive(parsed, mapped)).toEqual({ active: false, reason: 'consent_outdated' });
  });

  it('refuses a stored instance ceiling that is negative or fractional', () => {
    const row = (ceiling: unknown) => ({
      ...DEFAULT_LLM_SETTINGS,
      budgets: { ...DEFAULT_BUDGETS, reviewTokensPerOrganizationPerDay: ceiling },
    });
    expect(storedLlmSettingsSchema.safeParse(row(1_000)).success).toBe(true);
    expect(storedLlmSettingsSchema.safeParse(row(null)).success).toBe(true);
    expect(storedLlmSettingsSchema.safeParse(row(-1)).success).toBe(false);
    expect(storedLlmSettingsSchema.safeParse(row(1.5)).success).toBe(false);
  });
});

describe('reviewSettingsOf and withOrganizationReview', () => {
  it('reads an organisation absent from the map with the defaults', () => {
    expect(reviewSettingsOf(DEFAULT_LLM_SETTINGS, ORG)).toEqual(DEFAULT_REVIEW);
    expect(reviewSettingsOf(settingsWith(), OTHER_ORG)).toEqual(DEFAULT_REVIEW);
    expect(reviewSettingsOf(settingsWith(), ORG)).toEqual(ON);
  });

  it('replaces only the organisation’s review block', () => {
    const before = settingsWith({}, { excludedProjectIds: [OTHER_PROJECT] });
    const next: ReviewSettings = { ...ON, enabled: false, projectIds: [] };
    const after = withOrganizationReview(before, ORG, next);
    expect(after.organizations[ORG]).toEqual({ ...before.organizations[ORG], review: next });
    expect(after.provider).toBe(before.provider);
    expect(reviewSettingsOf(before, ORG)).toEqual(ON);
  });

  it('adds a disabled entry for an organisation absent from the map', () => {
    const after = withOrganizationReview(DEFAULT_LLM_SETTINGS, ORG, ON);
    expect(after.organizations[ORG]).toEqual({
      enabled: false,
      features: { explain: false, triage: false, fix: false },
      excludedProjectIds: [],
      autoFix: { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
      autoFixDisabledProjectIds: [],
      review: ON,
    });
    expect(DEFAULT_LLM_SETTINGS.organizations).toEqual({});
  });
});

describe('the provider, its consent and the data-sharing notice (R10)', () => {
  it('names the provider by its normalised address, the host of it (port included) and its model', () => {
    expect(reviewProvider(settingsWith())).toEqual({
      url: 'https://api.openai.com/v1',
      host: 'api.openai.com',
      model: 'gpt-x',
      models: ['gpt-x'],
    });
    const local = { ...PROVIDER, baseUrl: 'https://llm.example:8443/v1/' };
    expect(reviewProvider(settingsWith({}, {}, local))).toEqual({
      url: 'https://llm.example:8443/v1',
      host: 'llm.example:8443',
      model: 'gpt-x',
      models: ['gpt-x'],
    });
    expect(reviewProvider(settingsWith({}, {}, null))).toBeNull();
  });

  it('names every model of the provider, once and sorted, the standard model among them', () => {
    const tiers: StoredProvider = {
      ...PROVIDER,
      strongModel: 'gpt-x-big',
      fastModel: 'gpt-x-mini',
    };
    expect(reviewProvider(settingsWith({}, {}, tiers))).toMatchObject({
      model: 'gpt-x',
      models: ['gpt-x', 'gpt-x-big', 'gpt-x-mini'],
    });
    // A tier set to the standard model names nothing more.
    const same: StoredProvider = { ...PROVIDER, strongModel: 'gpt-x', fastModel: 'gpt-x' };
    expect(reviewProvider(settingsWith({}, {}, same))!.models).toEqual(['gpt-x']);
    // Sorted, not in the order of the tiers.
    const first: StoredProvider = { ...PROVIDER, strongModel: 'a-model', fastModel: 'z-model' };
    expect(reviewProvider(settingsWith({}, {}, first))!.models).toEqual([
      'a-model',
      'gpt-x',
      'z-model',
    ]);
  });

  it('is current while the consent names the configured address, host and model', () => {
    expect(consentCurrent(settingsWith(), ON)).toBe(true);
  });

  describe('the models of a consent', () => {
    const TIERS: StoredProvider = { ...PROVIDER, fastModel: 'gpt-x-mini' };
    const consentOf = (models: string[]): ReviewSettings => ({
      ...ON,
      consent: { ...CONSENT, models },
    });

    it('a consent stored without models reads as the standard model alone', () => {
      expect(consentModels(CONSENT)).toEqual(['gpt-x']);
      expect(consentModels({ ...CONSENT, model: 'other' })).toEqual(['other']);
      // So it still covers a provider that has no model of its own for a tier ...
      expect(consentCurrent(settingsWith(), ON)).toBe(true);
      // ... and covers none that has.
      expect(consentCurrent(settingsWith({}, {}, TIERS), ON)).toBe(false);
      expect(reviewActive(settingsWith({}, {}, TIERS), mapped)).toEqual({
        active: false,
        reason: 'consent_outdated',
      });
    });

    it('reads the models of a consent as a set: sorted, each once', () => {
      expect(consentModels({ ...CONSENT, models: ['b', 'a', 'b'] })).toEqual(['a', 'b']);
    });

    it('is current while the consent names the models the provider has now', () => {
      expect(consentCurrent(settingsWith({}, {}, TIERS), consentOf(['gpt-x', 'gpt-x-mini']))).toBe(
        true,
      );
      // The order and repeats of the list do not matter.
      expect(
        consentCurrent(settingsWith({}, {}, TIERS), consentOf(['gpt-x-mini', 'gpt-x', 'gpt-x'])),
      ).toBe(true);
      // A tier set to the standard model adds none.
      const same: StoredProvider = { ...PROVIDER, strongModel: 'gpt-x' };
      expect(consentCurrent(settingsWith({}, {}, same), consentOf(['gpt-x']))).toBe(true);
      expect(consentCurrent(settingsWith(), consentOf(['gpt-x']))).toBe(true);
    });

    it('changing the fast model makes the consent outdated', () => {
      const consent = consentOf(['gpt-x', 'gpt-x-mini']);
      expect(consentCurrent(settingsWith({}, {}, TIERS), consent)).toBe(true);
      const other: StoredProvider = { ...TIERS, fastModel: 'gpt-x-nano' };
      expect(consentCurrent(settingsWith({}, {}, other), consent)).toBe(false);
      expect(reviewActive(settingsWith({ consent: consent.consent }, {}, other), mapped)).toEqual({
        active: false,
        reason: 'consent_outdated',
      });
    });

    it('changing the strong model, adding or removing a tier model makes it outdated too', () => {
      const both: StoredProvider = {
        ...PROVIDER,
        strongModel: 'gpt-x-big',
        fastModel: 'gpt-x-mini',
      };
      const consent = consentOf(['gpt-x', 'gpt-x-big', 'gpt-x-mini']);
      expect(consentCurrent(settingsWith({}, {}, both), consent)).toBe(true);
      for (const over of [
        { strongModel: 'gpt-x-huge' },
        { strongModel: null },
        { fastModel: null },
        { model: 'gpt-y' },
      ]) {
        const changed = { ...both, ...over };
        expect(consentCurrent(settingsWith({}, {}, changed), consent), JSON.stringify(over)).toBe(
          false,
        );
      }
      // A consent for one model does not cover a provider that gained one.
      expect(consentCurrent(settingsWith({}, {}, TIERS), consentOf(['gpt-x']))).toBe(false);
      // Nor one for two a provider that lost one.
      expect(consentCurrent(settingsWith(), consentOf(['gpt-x', 'gpt-x-mini']))).toBe(false);
    });

    it('a swap of two models between the tiers makes it outdated, though no model is new', () => {
      const consent = consentOf(['gpt-x', 'gpt-x-mini']);
      const swapped: StoredProvider = { ...PROVIDER, model: 'gpt-x-mini', strongModel: 'gpt-x' };
      expect(reviewProvider(settingsWith({}, {}, swapped))!.models).toEqual([
        'gpt-x',
        'gpt-x-mini',
      ]);
      expect(consentCurrent(settingsWith({}, {}, swapped), consent)).toBe(false);
    });

    it('a permutation of the strong and the fast model keeps it current: no model is sent what it was not', () => {
      const both: StoredProvider = {
        ...PROVIDER,
        strongModel: 'gpt-x-big',
        fastModel: 'gpt-x-mini',
      };
      const permuted: StoredProvider = {
        ...PROVIDER,
        strongModel: 'gpt-x-mini',
        fastModel: 'gpt-x-big',
      };
      const consent = consentOf(['gpt-x', 'gpt-x-big', 'gpt-x-mini']);
      expect(consentCurrent(settingsWith({}, {}, both), consent)).toBe(true);
      expect(consentCurrent(settingsWith({}, {}, permuted), consent)).toBe(true);
      // The provider a run compares with the one it started on (`sameProvider`) is the same too.
      expect(reviewProvider(settingsWith({}, {}, permuted))).toEqual(
        reviewProvider(settingsWith({}, {}, both)),
      );
      expect(
        reviewActive(settingsWith({ consent: consent.consent }, {}, permuted), mapped),
      ).toEqual({ active: true });
    });
  });

  it.each<[string, Partial<StoredProvider>]>([
    ['the model changes', { model: 'gpt-y' }],
    ['the host changes', { baseUrl: 'https://api.other.example/v1' }],
    ['the port changes', { baseUrl: 'https://api.openai.com:8443/v1' }],
    ['the scheme changes', { baseUrl: 'http://api.openai.com/v1' }],
    ['the base path changes (same host)', { baseUrl: 'https://api.openai.com/other/v2' }],
    [
      'the base path gains a segment (same host)',
      { baseUrl: 'https://api.openai.com/v1/tenant-b' },
    ],
    ['the base path is gone (same host)', { baseUrl: 'https://api.openai.com' }],
  ])('is outdated when %s', (_name, over) => {
    expect(consentCurrent(settingsWith({}, {}, { ...PROVIDER, ...over }), ON)).toBe(false);
  });

  it('is outdated when the consent names another address of the same host and model', () => {
    const consent = { ...CONSENT, providerUrl: 'https://api.openai.com/tenant-a/v1' };
    expect(consentCurrent(settingsWith(), { ...ON, consent })).toBe(false);
  });

  it('survives a change of anything else about the provider: the key, the temperature, the kind', () => {
    const changed: StoredProvider = {
      ...PROVIDER,
      temperature: 0.2,
      timeoutSeconds: 120,
      kind: 'anthropic',
      auth: 'api-key',
      apiKeyEnc: { v: 1, iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' },
    };
    expect(consentCurrent(settingsWith({}, {}, changed), ON)).toBe(true);
  });

  it('compares the address as /system/llm stores it: a trailing slash, a default port or a capital is no change', () => {
    const spelled: StoredProvider = { ...PROVIDER, baseUrl: 'HTTPS://API.OpenAI.com:443/v1/' };
    expect(reviewProvider(settingsWith({}, {}, spelled))).toEqual({
      url: 'https://api.openai.com/v1',
      host: 'api.openai.com',
      model: 'gpt-x',
      models: ['gpt-x'],
    });
    expect(consentCurrent(settingsWith({}, {}, spelled), ON)).toBe(true);
  });

  it('knows no provider whose address does not parse', () => {
    const broken: StoredProvider = { ...PROVIDER, baseUrl: 'not an address' };
    expect(reviewProvider(settingsWith({}, {}, broken))).toBeNull();
    expect(consentCurrent(settingsWith({}, {}, broken), ON)).toBe(false);
    expect(reviewActive(settingsWith({}, {}, broken), mapped)).toEqual({
      active: false,
      reason: 'no_provider',
    });
  });

  it('is outdated without a consent or without a provider', () => {
    expect(consentCurrent(settingsWith(), { ...ON, consent: null })).toBe(false);
    expect(consentCurrent(settingsWith({}, {}, null), ON)).toBe(false);
  });

  describe('acknowledgesProvider (the acknowledgement names the provider the admin was shown)', () => {
    const provider = {
      url: 'https://llm.example:8443/v1',
      host: 'llm.example:8443',
      model: 'Gpt-X',
      models: ['Gpt-X'],
    };

    it('is true for the host and the model the notice named', () => {
      expect(acknowledgesProvider(provider, { host: 'llm.example:8443', model: 'Gpt-X' })).toBe(
        true,
      );
    });

    it('takes the host in any case, as hosts are, but the model as it is written', () => {
      expect(acknowledgesProvider(provider, { host: 'LLM.Example:8443', model: 'Gpt-X' })).toBe(
        true,
      );
      expect(acknowledgesProvider(provider, { host: 'llm.example:8443', model: 'gpt-x' })).toBe(
        false,
      );
    });

    it.each<[string, { host: string; model: string }]>([
      ['another host', { host: 'llm.elsewhere.example:8443', model: 'Gpt-X' }],
      ['the host without its port', { host: 'llm.example', model: 'Gpt-X' }],
      ['another port', { host: 'llm.example:9443', model: 'Gpt-X' }],
      ['another model', { host: 'llm.example:8443', model: 'Gpt-Y' }],
      ['nothing', { host: '', model: '' }],
    ])('is false for %s', (_name, acknowledged) => {
      expect(acknowledgesProvider(provider, acknowledged)).toBe(false);
    });

    it('takes an acknowledgement without models as naming the model alone', () => {
      const old = { host: 'llm.example:8443', model: 'Gpt-X' };
      expect(acknowledgesProvider(provider, old)).toBe(true);
      expect(acknowledgesProvider(provider, { ...old, models: ['Gpt-X'] })).toBe(true);
      // The models it lists are the ones that count, not the model beside them.
      expect(acknowledgesProvider(provider, { ...old, models: ['Gpt-Y'] })).toBe(false);
      expect(acknowledgesProvider(provider, { ...old, models: ['Gpt-X', 'Gpt-Y'] })).toBe(false);
      expect(acknowledgesProvider(provider, { ...old, models: [] })).toBe(false);
    });

    describe('with models of its own for the tiers', () => {
      const tiered = { ...provider, models: ['Gpt-X', 'Gpt-X-big', 'Gpt-X-mini'] };
      const shown = { host: 'llm.example:8443', model: 'Gpt-X' };

      it('is true for the same set of models, in any order and each listed once', () => {
        for (const models of [
          ['Gpt-X', 'Gpt-X-big', 'Gpt-X-mini'],
          ['Gpt-X-mini', 'Gpt-X', 'Gpt-X-big'],
          ['Gpt-X-big', 'Gpt-X-big', 'Gpt-X-mini', 'Gpt-X'],
        ]) {
          expect(acknowledgesProvider(tiered, { ...shown, models }), models.join()).toBe(true);
        }
      });

      it.each<[string, string[] | undefined]>([
        ['no models (an acknowledgement of the model alone)', undefined],
        ['the standard model alone', ['Gpt-X']],
        ['a subset', ['Gpt-X', 'Gpt-X-mini']],
        ['a model more', ['Gpt-X', 'Gpt-X-big', 'Gpt-X-mini', 'Gpt-X-huge']],
        ['another model in place of one', ['Gpt-X', 'Gpt-X-big', 'Gpt-X-nano']],
        ['the models in another case', ['gpt-x', 'gpt-x-big', 'gpt-x-mini']],
        ['an empty list', []],
      ])('is false for %s', (_name, models) => {
        const acknowledged = models === undefined ? shown : { ...shown, models };
        expect(acknowledgesProvider(tiered, acknowledged)).toBe(false);
      });

      it('still needs the host and the model to be those of the provider', () => {
        const models = tiered.models;
        expect(
          acknowledgesProvider(tiered, { host: 'other.example', model: 'Gpt-X', models }),
        ).toBe(false);
        expect(
          acknowledgesProvider(tiered, { host: 'llm.example:8443', model: 'Gpt-X-big', models }),
        ).toBe(false);
      });
    });
  });

  it('writes the notice exactly', () => {
    expect(dataSharingNotice('api.openai.com', ['gpt-x'], 14)).toBe(
      "AI review sends the merge request's diff and any repository file the model chooses to read to api.openai.com (gpt-x). The scanner uploads a copy of the repository to this Qualor server for each merge request; Qualor keeps it until the merge request is closed (at most 14 days). Secrets the analyzers found are masked; credentials files are never sent.",
    );
    expect(dataSharingNotice('llm.example:8443', ['m/1'], 3)).toContain(
      'to llm.example:8443 (m/1). ',
    );
    expect(dataSharingNotice('llm.example:8443', ['m/1'], 3)).toContain('(at most 3 days)');
  });

  it('the notice names every distinct model', () => {
    expect(dataSharingNotice('api.openai.com', ['gpt-x', 'gpt-x-big', 'gpt-x-mini'], 14)).toBe(
      "AI review sends the merge request's diff and any repository file the model chooses to read to api.openai.com (gpt-x, gpt-x-big, gpt-x-mini). The scanner uploads a copy of the repository to this Qualor server for each merge request; Qualor keeps it until the merge request is closed (at most 14 days). Secrets the analyzers found are masked; credentials files are never sent.",
    );
    expect(dataSharingNotice('llm.example:8443', ['a/1', 'b/2'], 3)).toContain(
      'to llm.example:8443 (a/1, b/2). ',
    );
    // The notice of the provider, as the answers write it.
    const tiers: StoredProvider = {
      ...PROVIDER,
      strongModel: 'gpt-x-big',
      fastModel: 'gpt-x-mini',
    };
    const provider = reviewProvider(settingsWith({}, {}, tiers))!;
    expect(dataSharingNotice(provider.host, provider.models, 14)).toContain(
      'to api.openai.com (gpt-x, gpt-x-big, gpt-x-mini). ',
    );
  });
});

describe('reviewActive (llm.md §3.3, spec C1, R10)', () => {
  it('lists the reasons in the order they are checked', () => {
    expect(REVIEW_INACTIVE_REASONS).toEqual([
      'no_provider',
      'organization_disabled',
      'review_disabled',
      'consent_outdated',
      'project_not_selected',
      'not_mapped',
    ]);
  });

  it('is active when every condition holds', () => {
    expect(reviewActive(settingsWith(), mapped)).toEqual({ active: true });
  });

  it('gives each reason, the first condition that fails', () => {
    // Every condition fails; each step below fixes the one the previous answer named.
    const failing: Partial<ReviewSettings> = { enabled: false, consent: null, projectIds: [] };
    const verdict = (
      review: Partial<ReviewSettings>,
      org: Partial<OrgLlmSettings>,
      provider: StoredProvider | null,
    ) => reviewActive(settingsWith(review, org, provider), unmapped);

    expect(verdict(failing, { enabled: false }, null)).toEqual({
      active: false,
      reason: 'no_provider',
    });
    expect(verdict(failing, { enabled: false }, PROVIDER)).toEqual({
      active: false,
      reason: 'organization_disabled',
    });
    expect(verdict(failing, {}, PROVIDER)).toEqual({ active: false, reason: 'review_disabled' });
    expect(verdict({ ...failing, enabled: true }, {}, PROVIDER)).toEqual({
      active: false,
      reason: 'consent_outdated',
    });
    expect(verdict({ ...failing, enabled: true, consent: CONSENT }, {}, PROVIDER)).toEqual({
      active: false,
      reason: 'project_not_selected',
    });
    expect(
      verdict({ enabled: true, consent: CONSENT, projectIds: [PROJECT] }, {}, PROVIDER),
    ).toEqual({ active: false, reason: 'not_mapped' });
    expect(reviewActive(settingsWith({ projectIds: [PROJECT] }), mapped)).toEqual({ active: true });
  });

  it.each<[string, StoredLlmSettings, string]>([
    ['no provider is configured', settingsWith({}, {}, null), 'no_provider'],
    [
      'the organisation is AI-disabled',
      settingsWith({}, { enabled: false }),
      'organization_disabled',
    ],
    ['review is off', settingsWith({ enabled: false }), 'review_disabled'],
    [
      'the consent names another model',
      settingsWith({}, {}, { ...PROVIDER, model: 'z' }),
      'consent_outdated',
    ],
    [
      'the project is not in the list',
      settingsWith({ projectIds: [OTHER_PROJECT] }),
      'project_not_selected',
    ],
  ])('is inactive when %s', (_name, settings, reason) => {
    expect(reviewActive(settings, mapped)).toEqual({ active: false, reason });
  });

  it('does not let the project’s mapping hide a reason that comes before it', () => {
    expect(reviewActive(settingsWith({ enabled: false }), unmapped)).toEqual({
      active: false,
      reason: 'review_disabled',
    });
    expect(reviewActive(settingsWith(), unmapped)).toEqual({ active: false, reason: 'not_mapped' });
  });

  it('selects every project with the scope all, and only the listed ones with selected', () => {
    const all = settingsWith({ scope: 'all', projectIds: [] });
    expect(reviewActive(all, mapped)).toEqual({ active: true });
    expect(reviewActive(all, { ...mapped, id: OTHER_PROJECT })).toEqual({ active: true });
    const some = settingsWith({ scope: 'selected', projectIds: [PROJECT] });
    expect(reviewActive(some, mapped)).toEqual({ active: true });
    expect(reviewActive(some, { ...mapped, id: OTHER_PROJECT })).toEqual({
      active: false,
      reason: 'project_not_selected',
    });
  });

  it('never reviews a project the organisation excludes from the AI assistant', () => {
    // The scope all and a listed project both give way to the instance administrator’s exclusion.
    for (const review of [{ scope: 'all' as const }, { scope: 'selected' as const }]) {
      const settings = settingsWith(review, { excludedProjectIds: [PROJECT] });
      expect(reviewActive(settings, mapped)).toEqual({
        active: false,
        reason: 'project_not_selected',
      });
    }
  });

  it('reads only the project’s own organisation', () => {
    const settings = settingsWith({ scope: 'all' });
    expect(reviewActive(settings, { ...mapped, organizationId: OTHER_ORG })).toEqual({
      active: false,
      reason: 'organization_disabled',
    });
  });

  it('asks the organisation-level reasons alone', () => {
    expect(organizationReviewInactive(settingsWith(), ORG)).toBeNull();
    expect(organizationReviewInactive(settingsWith({ projectIds: [] }), ORG)).toBeNull();
    expect(organizationReviewInactive(settingsWith({ enabled: false }), ORG)).toBe(
      'review_disabled',
    );
    expect(organizationReviewInactive(settingsWith(), OTHER_ORG)).toBe('organization_disabled');
    expect(organizationReviewInactive(DEFAULT_LLM_SETTINGS, ORG)).toBe('no_provider');
  });
});

describe('effectiveReviewBudgets (the instance ceiling)', () => {
  const withCeiling = (ceiling: number | null, tokensPerDay: number): StoredLlmSettings => {
    const settings = settingsWith({ budgets: { ...ON.budgets, tokensPerDay } });
    return {
      ...settings,
      budgets: { ...settings.budgets, reviewTokensPerOrganizationPerDay: ceiling },
    };
  };

  it('caps the organisation’s tokens per day at the ceiling', () => {
    expect(effectiveReviewBudgets(withCeiling(500_000, 2_000_000), ORG).tokensPerDay).toBe(500_000);
  });

  it('keeps the organisation’s own budget when it is smaller, or there is no ceiling', () => {
    expect(effectiveReviewBudgets(withCeiling(500_000, 100_000), ORG).tokensPerDay).toBe(100_000);
    expect(effectiveReviewBudgets(withCeiling(null, 2_000_000), ORG).tokensPerDay).toBe(2_000_000);
    expect(effectiveReviewBudgets(withCeiling(0, 2_000_000), ORG).tokensPerDay).toBe(0);
  });

  it('changes no other budget, and reads the defaults for an organisation without entry', () => {
    const settings = withCeiling(1, 2_000_000);
    expect(effectiveReviewBudgets(settings, ORG)).toEqual({ ...ON.budgets, tokensPerDay: 1 });
    expect(effectiveReviewBudgets(settings, OTHER_ORG)).toEqual({
      ...DEFAULT_REVIEW.budgets,
      tokensPerDay: 1,
    });
    expect(effectiveReviewBudgets(DEFAULT_LLM_SETTINGS, ORG)).toEqual(DEFAULT_REVIEW.budgets);
  });
});

describe('projectAiReview (the project DTO)', () => {
  const dtoOf = (settings: StoredLlmSettings, id = PROJECT, organizationId = ORG) =>
    projectAiReview(settings, { id, organizationId, scmConnectionId: CONNECTION });

  it('is on for a selected project of an organisation that has review on', () => {
    expect(dtoOf(settingsWith())).toEqual({
      enabled: true,
      organizationEnabled: true,
      reason: null,
    });
  });

  it('is off for a project the organisation does not select, but says the organisation has it on', () => {
    expect(dtoOf(settingsWith(), OTHER_PROJECT)).toEqual({
      enabled: false,
      organizationEnabled: true,
      reason: 'project_not_selected',
    });
    expect(dtoOf(settingsWith({ scope: 'all' }), OTHER_PROJECT)).toEqual({
      enabled: true,
      organizationEnabled: true,
      reason: null,
    });
  });

  it.each<[string, StoredLlmSettings, ReviewInactiveReason]>([
    ['there is no provider', settingsWith({}, {}, null), 'no_provider'],
    [
      'the organisation is AI-disabled',
      settingsWith({}, { enabled: false }),
      'organization_disabled',
    ],
    ['review is off', settingsWith({ enabled: false }), 'review_disabled'],
    [
      'the consent is outdated',
      settingsWith({}, {}, { ...PROVIDER, model: 'other' }),
      'consent_outdated',
    ],
  ])('is off for every project while %s', (_name, settings, reason) => {
    expect(dtoOf(settings)).toEqual({ enabled: false, organizationEnabled: false, reason });
    expect(dtoOf(settingsWith({ scope: 'all' }, { enabled: false }))).toEqual({
      enabled: false,
      organizationEnabled: false,
      reason: 'organization_disabled',
    });
  });

  it('leaves out an excluded project, and reads only the project’s own organisation', () => {
    expect(dtoOf(settingsWith({}, { excludedProjectIds: [PROJECT] }))).toEqual({
      enabled: false,
      organizationEnabled: true,
      reason: 'project_not_selected',
    });
    expect(dtoOf(settingsWith(), PROJECT, OTHER_ORG)).toEqual({
      enabled: false,
      organizationEnabled: false,
      reason: 'organization_disabled',
    });
  });

  it('keeps a selected project that is not mapped on, and says it is not mapped', () => {
    // The mapping is the one condition `enabled` leaves out; the reason says it.
    expect(projectAiReview(settingsWith(), unmapped)).toEqual({
      enabled: true,
      organizationEnabled: true,
      reason: 'not_mapped',
    });
    expect(projectAiReview(settingsWith(), mapped)).toEqual({
      enabled: true,
      organizationEnabled: true,
      reason: null,
    });
  });

  it('gives the reason reviewActive gives', () => {
    // The settings that make review fail at each step and at none before it; the record is
    // complete while every reason has an entry.
    const failing: Record<ReviewInactiveReason, StoredLlmSettings> = {
      no_provider: settingsWith({}, {}, null),
      organization_disabled: settingsWith({}, { enabled: false }),
      review_disabled: settingsWith({ enabled: false }),
      consent_outdated: settingsWith({}, {}, { ...PROVIDER, model: 'other' }),
      project_not_selected: settingsWith({ projectIds: [OTHER_PROJECT] }),
      not_mapped: settingsWith(),
    };
    for (const reason of REVIEW_INACTIVE_REASONS) {
      // The mapping is the last condition: a project that is not mapped has the reason of the
      // step that fails before it, and `not_mapped` only when none does.
      for (const project of reason === 'not_mapped' ? [unmapped] : [mapped, unmapped]) {
        expect(reviewActive(failing[reason], project), reason).toEqual({ active: false, reason });
        expect(projectAiReview(failing[reason], project).reason, reason).toBe(reason);
      }
    }
    // Where review runs there is no reason.
    expect(reviewActive(settingsWith(), mapped)).toEqual({ active: true });
    expect(projectAiReview(settingsWith(), mapped).reason).toBeNull();
  });
});

describe('sameReview and isDefaultReview', () => {
  it('equals a block with the same values, copied', () => {
    expect(sameReview(ON, ON)).toBe(true);
    expect(
      sameReview(ON, {
        ...ON,
        projectIds: [...ON.projectIds],
        budgets: { ...ON.budgets },
        consent: { ...CONSENT },
      }),
    ).toBe(true);
    expect(sameReview(DEFAULT_REVIEW, { ...DEFAULT_REVIEW })).toBe(true);
  });

  it.each<[string, Partial<ReviewSettings>]>([
    ['enabled', { enabled: false }],
    ['the scope', { scope: 'all' }],
    ['a project', { projectIds: [OTHER_PROJECT] }],
    ['more projects', { projectIds: [PROJECT, OTHER_PROJECT] }],
    ['no consent', { consent: null }],
    [
      'the consent’s base URL',
      { consent: { ...CONSENT, providerUrl: 'https://other.example/v1' } },
    ],
    ['the consent’s host', { consent: { ...CONSENT, providerHost: 'other.example' } }],
    ['the consent’s model', { consent: { ...CONSENT, model: 'other' } }],
    ['the consent’s models', { consent: { ...CONSENT, models: ['gpt-x', 'gpt-x-mini'] } }],
    ['the consent’s user', { consent: { ...CONSENT, userId: OTHER_PROJECT } }],
    ['the consent’s time', { consent: { ...CONSENT, at: '2027-01-02T00:00:00.000Z' } }],
    ['the daily tokens', { budgets: { ...ON.budgets, tokensPerDay: 1 } }],
    ['the cost', { budgets: { ...ON.budgets, costPerDayUsd: 1 } }],
    ['the project budget', { budgets: { ...ON.budgets, perProjectTokensPerDay: 1 } }],
    ['the tokens per review', { budgets: { ...ON.budgets, maxTokensPerReview: 1 } }],
  ])('differs in %s', (_name, over) => {
    expect(sameReview(ON, { ...ON, ...over })).toBe(false);
    expect(sameReview({ ...ON, ...over }, ON)).toBe(false);
  });

  it('reads a consent without models as one that names the model alone', () => {
    const named = { ...ON, consent: { ...CONSENT, models: ['gpt-x'] } };
    expect(sameReview(ON, named)).toBe(true);
    expect(sameReview(named, ON)).toBe(true);
    // The models are a set: order and repeats do not matter.
    const two = { ...ON, consent: { ...CONSENT, models: ['gpt-x', 'gpt-x-mini'] } };
    const reordered = { ...ON, consent: { ...CONSENT, models: ['gpt-x-mini', 'gpt-x', 'gpt-x'] } };
    expect(sameReview(two, reordered)).toBe(true);
  });

  it('compares the project lists in order, and a consent with none', () => {
    const two = { ...ON, projectIds: [PROJECT, OTHER_PROJECT] };
    expect(sameReview(two, { ...two, projectIds: [OTHER_PROJECT, PROJECT] })).toBe(false);
    expect(sameReview({ ...ON, consent: null }, { ...ON, consent: null })).toBe(true);
  });

  it('knows the defaults, and any value that is not one', () => {
    expect(isDefaultReview(DEFAULT_REVIEW)).toBe(true);
    expect(isDefaultReview({ ...DEFAULT_REVIEW, budgets: { ...DEFAULT_REVIEW.budgets } })).toBe(
      true,
    );
    for (const over of [
      { enabled: true },
      { scope: 'all' as const },
      { projectIds: [PROJECT] },
      { consent: CONSENT },
      { budgets: { ...DEFAULT_REVIEW.budgets, tokensPerDay: 1 } },
      { budgets: { ...DEFAULT_REVIEW.budgets, costPerDayUsd: 5 } },
      { budgets: { ...DEFAULT_REVIEW.budgets, perProjectTokensPerDay: 5 } },
      { budgets: { ...DEFAULT_REVIEW.budgets, maxTokensPerReview: 5 } },
    ]) {
      expect(isDefaultReview({ ...DEFAULT_REVIEW, ...over }), JSON.stringify(over)).toBe(false);
    }
  });
});
