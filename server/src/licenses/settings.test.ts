import { EMPTY_LICENSE_POLICY, type LicensePolicy } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LICENSE_POLICY_SETTINGS,
  LICENSE_POLICY_SETTINGS_KEY,
  licensePolicySettingsSchema,
  normalizeLicensePolicy,
  sameLicensePolicy,
} from './settings';

const ORG = '0190a6c2-0000-7000-8000-000000000001';
const OTHER = '0190a6c2-0000-7000-8000-000000000002';
const policy: LicensePolicy = {
  mode: 'denylist',
  forbiddenGroups: ['strong-copyleft'],
  forbidden: ['SSPL-1.0'],
  allowed: [],
  warnUnknown: false,
};

describe('the licence policy settings (6M §4)', () => {
  it('is the licensePolicy row, empty by default', () => {
    expect(LICENSE_POLICY_SETTINGS_KEY).toBe('licensePolicy');
    expect(DEFAULT_LICENSE_POLICY_SETTINGS).toEqual({ organizations: {} });
    expect(licensePolicySettingsSchema.parse({})).toEqual({ organizations: {} });
    expect(licensePolicySettingsSchema.parse({ organizations: {} })).toEqual({
      organizations: {},
    });
  });

  it('reads the stored policies, and drops only an entry that does not parse', () => {
    expect(
      licensePolicySettingsSchema.parse({
        organizations: {
          [ORG]: policy,
          [OTHER]: { ...policy, mode: 'open' },
        },
      }),
    ).toEqual({ organizations: { [ORG]: policy } });
    expect(licensePolicySettingsSchema.safeParse({ organizations: [] }).success).toBe(false);
    expect(licensePolicySettingsSchema.safeParse('x').success).toBe(false);
  });
});

describe('normalizeLicensePolicy (6M §5)', () => {
  it('canonicalises the ids, then sorts and dedupes every list', () => {
    expect(
      normalizeLicensePolicy({
        mode: 'allowlist',
        forbiddenGroups: ['weak-copyleft', 'network-copyleft', 'weak-copyleft'],
        forbidden: ['gpl-3.0', 'GPL-3.0-only', 'agpl-3.0+', 'sspl-1.0'],
        allowed: ['mit', 'Apache-2.0', 'MIT', 'gpl-2.0-with-classpath-exception'],
        warnUnknown: true,
      }),
    ).toEqual({
      mode: 'allowlist',
      forbiddenGroups: ['network-copyleft', 'weak-copyleft'],
      forbidden: ['AGPL-3.0-or-later', 'GPL-3.0-only', 'SSPL-1.0'],
      allowed: ['Apache-2.0', 'GPL-2.0-only WITH Classpath-exception-2.0', 'MIT'],
      warnUnknown: true,
    });
    expect(normalizeLicensePolicy(EMPTY_LICENSE_POLICY)).toEqual(EMPTY_LICENSE_POLICY);
  });

  it('compares two policies by value', () => {
    expect(sameLicensePolicy(null, null)).toBe(true);
    expect(sameLicensePolicy(policy, null)).toBe(false);
    expect(sameLicensePolicy(policy, { ...policy, forbidden: ['SSPL-1.0'] })).toBe(true);
    expect(sameLicensePolicy(policy, { ...policy, warnUnknown: true })).toBe(false);
    expect(sameLicensePolicy(policy, { ...policy, forbidden: [] })).toBe(false);
  });
});
