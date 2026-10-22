import { describe, expect, it } from 'vitest';
import { communityLimits, type Limits } from '../limits';
import { defaultReview } from '../review/settings';
import { effectiveAutoFix, withOrganizationAutoFix, withProjectAutoFix } from './auto-fix-settings';
import {
  DEFAULT_AUTO_FIX,
  DEFAULT_LLM_SETTINGS,
  storedLlmSettingsSchema,
  type OrgLlmSettings,
  type StoredLlmSettings,
} from './settings';

const ORG = '00000000-0000-7000-8000-000000000001';
const OTHER_ORG = '00000000-0000-7000-8000-000000000002';
const PROJECT = '00000000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT = '00000000-0000-7000-8000-0000000000a2';

const LICENSED: Limits = {
  ...communityLimits(),
  llm: { ...communityLimits().llm, automaticFixSuggestions: true },
};

const provider = {
  kind: 'openai' as const,
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  auth: 'bearer' as const,
  jsonMode: 'json_object' as const,
  maxTokensField: 'max_tokens' as const,
  temperature: null,
  timeoutSeconds: 60,
  apiKeyEnc: null,
};

const ON: OrgLlmSettings = {
  enabled: true,
  features: { explain: false, triage: false, fix: true },
  excludedProjectIds: [],
  autoFix: { enabled: true, minSeverity: 'medium', maxPerAnalysis: 5 },
  autoFixDisabledProjectIds: [],
  review: defaultReview(),
};

const settingsWith = (org: Partial<OrgLlmSettings> = {}): StoredLlmSettings => ({
  ...DEFAULT_LLM_SETTINGS,
  provider,
  organizations: { [ORG]: { ...ON, ...org } },
});

const project = { id: PROJECT, organizationId: ORG };

describe('the automatic fix suggestion settings (4E-3a §2)', () => {
  it('reads a stored row written before them with the defaults', () => {
    const old = {
      v: 1,
      provider: null,
      organizations: {
        [ORG]: {
          enabled: true,
          features: { explain: true, triage: true, fix: true },
          excludedProjectIds: [PROJECT],
        },
      },
      excludePaths: [],
      budgets: DEFAULT_LLM_SETTINGS.budgets,
      pricing: null,
      storePrompts: false,
      promptRetentionDays: 7,
    };
    const parsed = storedLlmSettingsSchema.parse(old);
    expect(parsed.organizations[ORG]).toEqual({
      ...old.organizations[ORG],
      autoFix: { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
      autoFixDisabledProjectIds: [],
      review: defaultReview(),
    });
    expect(DEFAULT_AUTO_FIX).toEqual({ enabled: false, minSeverity: 'high', maxPerAnalysis: 10 });
  });

  it('gives every parsed organisation its own default objects', () => {
    const org = { enabled: false, features: { explain: false, triage: false, fix: false } };
    const parsed = storedLlmSettingsSchema.parse({
      ...DEFAULT_LLM_SETTINGS,
      organizations: {
        [ORG]: { ...org, excludedProjectIds: [] },
        [OTHER_ORG]: { ...org, excludedProjectIds: [] },
      },
    });
    const a = parsed.organizations[ORG]!;
    const b = parsed.organizations[OTHER_ORG]!;
    expect(a.autoFix).not.toBe(b.autoFix);
    expect(a.autoFixDisabledProjectIds).not.toBe(b.autoFixDisabledProjectIds);
  });

  it.each([
    ['a severity outside the five', { minSeverity: 'critical' }],
    ['a maximum of 0', { maxPerAnalysis: 0 }],
    ['a maximum of 26', { maxPerAnalysis: 26 }],
    ['a fractional maximum', { maxPerAnalysis: 2.5 }],
    ['an unknown field', { extra: true }],
  ])('refuses a stored autoFix with %s', (_name, over) => {
    const row = settingsWith({ autoFix: { ...ON.autoFix, ...over } as never });
    expect(storedLlmSettingsSchema.safeParse(row).success).toBe(false);
  });

  it('refuses more than 1 000 opted-out projects', () => {
    const ids = Array.from(
      { length: 1_001 },
      (_, i) => `00000000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
    );
    expect(
      storedLlmSettingsSchema.safeParse(settingsWith({ autoFixDisabledProjectIds: ids })).success,
    ).toBe(false);
    expect(
      storedLlmSettingsSchema.safeParse(
        settingsWith({ autoFixDisabledProjectIds: ids.slice(0, 1_000) }),
      ).success,
    ).toBe(true);
  });
});

describe('effectiveAutoFix (4E-3a §2, the effective rule)', () => {
  it('allows a project when every condition holds, with the organisation’s bounds', () => {
    expect(effectiveAutoFix(settingsWith(), LICENSED, project)).toEqual({
      allowed: true,
      minSeverity: 'medium',
      maxPerAnalysis: 5,
    });
  });

  it.each<[string, StoredLlmSettings, Limits]>([
    ['the feature is not licensed (community limits)', settingsWith(), communityLimits()],
    ['no provider is configured', { ...settingsWith(), provider: null }, LICENSED],
    ['the organisation is AI-disabled', settingsWith({ enabled: false }), LICENSED],
    [
      'the fix feature is off',
      settingsWith({ features: { explain: true, triage: true, fix: false } }),
      LICENSED,
    ],
    ['auto-fix is off', settingsWith({ autoFix: { ...ON.autoFix, enabled: false } }), LICENSED],
    ['the project is excluded from AI', settingsWith({ excludedProjectIds: [PROJECT] }), LICENSED],
    ['the project opted out', settingsWith({ autoFixDisabledProjectIds: [PROJECT] }), LICENSED],
    ['the organisation is absent from the map', DEFAULT_LLM_SETTINGS, LICENSED],
  ])('refuses when %s', (_name, settings, limits) => {
    expect(effectiveAutoFix(settings, limits, project).allowed).toBe(false);
  });

  it('reads only the project’s own organisation and its own opt-out', () => {
    const settings = settingsWith({
      excludedProjectIds: [OTHER_PROJECT],
      autoFixDisabledProjectIds: [OTHER_PROJECT],
    });
    expect(effectiveAutoFix(settings, LICENSED, project).allowed).toBe(true);
    expect(
      effectiveAutoFix(settings, LICENSED, { id: PROJECT, organizationId: OTHER_ORG }).allowed,
    ).toBe(false);
  });
});

describe('the auto-fix mutations', () => {
  it('replaces only the organisation’s autoFix block', () => {
    const before = settingsWith({ excludedProjectIds: [OTHER_PROJECT] });
    const next = { enabled: false, minSeverity: 'blocker' as const, maxPerAnalysis: 25 };
    const after = withOrganizationAutoFix(before, ORG, next);
    expect(after.organizations[ORG]).toEqual({ ...before.organizations[ORG], autoFix: next });
    expect(after.provider).toBe(before.provider);
    expect(before.organizations[ORG]!.autoFix).toEqual(ON.autoFix);
  });

  it('adds a disabled entry for an organisation absent from the map', () => {
    const next = { enabled: false, minSeverity: 'low' as const, maxPerAnalysis: 3 };
    const after = withOrganizationAutoFix(DEFAULT_LLM_SETTINGS, ORG, next);
    expect(after.organizations[ORG]).toEqual({
      enabled: false,
      features: { explain: false, triage: false, fix: false },
      excludedProjectIds: [],
      autoFix: next,
      autoFixDisabledProjectIds: [],
      review: defaultReview(),
    });
    expect(DEFAULT_LLM_SETTINGS.organizations).toEqual({});
  });

  it('opts a project out once and back in', () => {
    const out = withProjectAutoFix(settingsWith(), ORG, PROJECT, false);
    expect(out.organizations[ORG]!.autoFixDisabledProjectIds).toEqual([PROJECT]);
    const twice = withProjectAutoFix(out, ORG, PROJECT, false);
    expect(twice.organizations[ORG]!.autoFixDisabledProjectIds).toEqual([PROJECT]);
    const back = withProjectAutoFix(twice, ORG, PROJECT, true);
    expect(back.organizations[ORG]!.autoFixDisabledProjectIds).toEqual([]);
    expect(back.organizations[ORG]!.autoFix).toEqual(ON.autoFix);
  });
});
