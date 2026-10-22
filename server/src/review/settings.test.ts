import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGETS,
  DEFAULT_LLM_SETTINGS,
  MAX_ORGANIZATION_PROJECT_IDS,
  storedLlmSettingsSchema,
  type OrgLlmSettings,
  type StoredLlmSettings,
  type StoredProvider,
} from '../llm/settings';
import {
  consentCurrent,
  dataSharingNotice,
  DEFAULT_REVIEW,
  effectiveReviewBudgets,
  isDefaultReview,
  MAX_REVIEW_PROJECT_IDS,
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
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_tokens',
  temperature: null,
  timeoutSeconds: 60,
  apiKeyEnc: null,
};

const CONSENT = {
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

  it.each<[string, unknown]>([
    ['an unknown scope', { ...ON, scope: 'some' }],
    ['an unknown field', { ...ON, extra: 1 }],
    ['a project id that is not a UUID', { ...ON, projectIds: ['p1'] }],
    ['a consent without a user', { ...ON, consent: { ...CONSENT, userId: undefined } }],
    ['a consent time that is not a time', { ...ON, consent: { ...CONSENT, at: 'yesterday' } }],
    ['a consent with an unknown field', { ...ON, consent: { ...CONSENT, extra: 1 } }],
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
    expect(reviewConsentSchema.safeParse(CONSENT).success).toBe(true);
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
  it('names the provider by the host of its address, port included, and its model', () => {
    expect(reviewProvider(settingsWith())).toEqual({ host: 'api.openai.com', model: 'gpt-x' });
    const local = { ...PROVIDER, baseUrl: 'https://llm.example:8443/v1/' };
    expect(reviewProvider(settingsWith({}, {}, local))).toEqual({
      host: 'llm.example:8443',
      model: 'gpt-x',
    });
    expect(reviewProvider(settingsWith({}, {}, null))).toBeNull();
  });

  it('is current while the consent names the configured host and model', () => {
    expect(consentCurrent(settingsWith(), ON)).toBe(true);
  });

  it.each<[string, Partial<StoredProvider>]>([
    ['the model changes', { model: 'gpt-y' }],
    ['the host changes', { baseUrl: 'https://api.other.example/v1' }],
    ['the port changes', { baseUrl: 'https://api.openai.com:8443/v1' }],
  ])('is outdated when %s', (_name, over) => {
    expect(consentCurrent(settingsWith({}, {}, { ...PROVIDER, ...over }), ON)).toBe(false);
  });

  it('survives a change of the path, the key or any other provider field', () => {
    const changed: StoredProvider = {
      ...PROVIDER,
      baseUrl: 'https://api.openai.com/other/v2',
      temperature: 0.2,
      timeoutSeconds: 120,
      kind: 'anthropic',
    };
    expect(consentCurrent(settingsWith({}, {}, changed), ON)).toBe(true);
  });

  it('is outdated without a consent or without a provider', () => {
    expect(consentCurrent(settingsWith(), { ...ON, consent: null })).toBe(false);
    expect(consentCurrent(settingsWith({}, {}, null), ON)).toBe(false);
  });

  it('writes the notice exactly', () => {
    expect(dataSharingNotice('api.openai.com', 'gpt-x', 14)).toBe(
      "AI review sends the merge request's diff and any repository file the model chooses to read to api.openai.com (gpt-x). The scanner uploads a copy of the repository to this Qualor server for each merge request; Qualor keeps it until the merge request is closed (at most 14 days). Secrets the analyzers found are masked; credentials files are never sent.",
    );
    expect(dataSharingNotice('llm.example:8443', 'm/1', 3)).toContain(
      'to llm.example:8443 (m/1). ',
    );
    expect(dataSharingNotice('llm.example:8443', 'm/1', 3)).toContain('(at most 3 days)');
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
    projectAiReview(settings, { id, organizationId });

  it('is on for a selected project of an organisation that has review on', () => {
    expect(dtoOf(settingsWith())).toEqual({ enabled: true, organizationEnabled: true });
  });

  it('is off for a project the organisation does not select, but says the organisation has it on', () => {
    expect(dtoOf(settingsWith(), OTHER_PROJECT)).toEqual({
      enabled: false,
      organizationEnabled: true,
    });
    expect(dtoOf(settingsWith({ scope: 'all' }), OTHER_PROJECT)).toEqual({
      enabled: true,
      organizationEnabled: true,
    });
  });

  it.each<[string, StoredLlmSettings]>([
    ['there is no provider', settingsWith({}, {}, null)],
    ['the organisation is AI-disabled', settingsWith({}, { enabled: false })],
    ['review is off', settingsWith({ enabled: false })],
    ['the consent is outdated', settingsWith({}, {}, { ...PROVIDER, model: 'other' })],
  ])('is off for every project while %s', (_name, settings) => {
    expect(dtoOf(settings)).toEqual({ enabled: false, organizationEnabled: false });
    expect(dtoOf(settingsWith({ scope: 'all' }, { enabled: false }))).toEqual({
      enabled: false,
      organizationEnabled: false,
    });
  });

  it('does not depend on the project’s mapping, and leaves out an excluded project', () => {
    expect(dtoOf(settingsWith({}, { excludedProjectIds: [PROJECT] }))).toEqual({
      enabled: false,
      organizationEnabled: true,
    });
    expect(dtoOf(settingsWith(), PROJECT, OTHER_ORG)).toEqual({
      enabled: false,
      organizationEnabled: false,
    });
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
    ['the consent’s host', { consent: { ...CONSENT, providerHost: 'other.example' } }],
    ['the consent’s model', { consent: { ...CONSENT, model: 'other' } }],
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
