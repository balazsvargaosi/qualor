import { LICENSE_GROUPS } from './groups';
import { describe, expect, it } from 'vitest';
import {
  classify,
  EMPTY_LICENSE_POLICY,
  invalidLicenseIds,
  licensePolicySchema,
  type LicensePolicy,
} from './evaluate';

const deny = (over: Partial<LicensePolicy> = {}): LicensePolicy => ({
  ...EMPTY_LICENSE_POLICY,
  ...over,
});
const strong = deny({ forbiddenGroups: ['strong-copyleft'] });
const weak = deny({ forbiddenGroups: ['weak-copyleft'] });

describe('classify, denylist', () => {
  it('EMPTY_LICENSE_POLICY is a denylist with nothing listed', () => {
    expect(EMPTY_LICENSE_POLICY).toEqual({
      mode: 'denylist',
      forbiddenGroups: [],
      forbidden: [],
      allowed: [],
      warnUnknown: false,
    });
  });

  it('is unknown for no licences', () => {
    expect(classify([], strong)).toEqual({ verdict: 'unknown', culprits: [], group: null });
  });

  it('allows a licence outside the forbidden groups', () => {
    expect(classify(['MIT'], strong).verdict).toBe('allowed');
  });

  it('forbids a member of a forbidden group', () => {
    expect(classify(['GPL-3.0-only'], strong)).toEqual({
      verdict: 'forbidden',
      culprits: ['GPL-3.0-only'],
      group: 'strong-copyleft',
    });
  });

  it('forbids by the explicit list, whatever the case', () => {
    expect(classify(['MIT'], deny({ forbidden: ['MIT'] }))).toEqual({
      verdict: 'forbidden',
      culprits: ['MIT'],
      group: null,
    });
    expect(classify(['mit'], deny({ forbidden: ['mit'] })).verdict).toBe('forbidden');
  });

  it('allows an OR with a permitted side', () => {
    expect(classify(['MIT OR GPL-3.0-only'], strong).verdict).toBe('allowed');
  });

  it('forbids an OR whose sides are all forbidden', () => {
    expect(classify(['GPL-2.0-only OR GPL-3.0-only'], strong)).toEqual({
      verdict: 'forbidden',
      culprits: ['GPL-2.0-only', 'GPL-3.0-only'],
      group: 'strong-copyleft',
    });
  });

  it('forbids an AND with a forbidden side, and the array is an AND', () => {
    expect(classify(['MIT AND GPL-3.0-only'], strong).verdict).toBe('forbidden');
    expect(classify(['LGPL-2.1-only', 'MIT'], weak)).toEqual({
      verdict: 'forbidden',
      culprits: ['LGPL-2.1-only'],
      group: 'weak-copyleft',
    });
  });

  it('lifts a forbidden term with `allowed`', () => {
    const policy = deny({ forbiddenGroups: ['weak-copyleft'], allowed: ['LGPL-2.1-only'] });
    expect(classify(['LGPL-2.1-only', 'MIT'], policy).verdict).toBe('allowed');
  });

  it('judges a WITH term by its own group first', () => {
    const term = ['GPL-2.0-only WITH Classpath-exception-2.0'];
    expect(classify(term, strong).verdict).toBe('allowed');
    expect(classify(term, weak)).toEqual({
      verdict: 'forbidden',
      culprits: ['GPL-2.0-only WITH Classpath-exception-2.0'],
      group: 'weak-copyleft',
    });
  });

  it('falls back to the rule of the id for a WITH term of no group', () => {
    expect(classify(['GPL-3.0-only WITH GCC-exception-3.1'], strong).verdict).toBe('forbidden');
    const p = deny({ forbiddenGroups: ['strong-copyleft'], allowed: ['GPL-3.0-only'] });
    expect(classify(['GPL-3.0-only WITH GCC-exception-3.1'], p).verdict).toBe('allowed');
    const exact = deny({ forbidden: ['MIT WITH Classpath-exception-2.0'] });
    expect(classify(['MIT WITH Classpath-exception-2.0'], exact).verdict).toBe('forbidden');
  });

  it('treats an unrecognised licence as allowed, but all-unrecognised as unknown', () => {
    expect(classify(['Public Domain'], strong).verdict).toBe('unknown');
    expect(classify(['Weird-Licence'], strong).verdict).toBe('unknown');
    expect(classify(['Weird-Licence', 'MIT'], strong).verdict).toBe('allowed');
    expect(classify(['Public Domain', 'GPL-3.0-only'], strong).verdict).toBe('forbidden');
  });

  it('sorts and de-duplicates the culprits', () => {
    const r = classify(['GPL-3.0-only AND GPL-2.0-only', 'GPL-3.0-only'], strong);
    expect(r.culprits).toEqual(['GPL-2.0-only', 'GPL-3.0-only']);
    expect(r.group).toBe('strong-copyleft');
  });

  it('normalises the manifest spellings before judging them', () => {
    expect(classify(['GPLv3'], strong).verdict).toBe('forbidden');
    expect(classify(['Apache License 2.0'], strong).verdict).toBe('allowed');
  });
});

describe('classify, unparseable entries', () => {
  it('denylist: counts them as unrecognised leaves', () => {
    expect(classify(['Public Domain'], strong).verdict).toBe('unknown');
    expect(classify(['Some Custom Licence v2'], strong).verdict).toBe('unknown');
    expect(classify(['MIT OR'], strong).verdict).toBe('unknown');
    expect(classify(['(MIT'], strong).verdict).toBe('unknown');
    expect(classify(['Public Domain', 'MIT'], strong).verdict).toBe('allowed');
    expect(classify(['Public Domain', 'GPL-3.0-only'], strong).verdict).toBe('forbidden');
  });

  it('allowlist: forbids them, naming the raw string', () => {
    const only = deny({ mode: 'allowlist', allowed: ['MIT'] });
    expect(classify(['MIT', 'Public Domain'], only)).toEqual({
      verdict: 'forbidden',
      culprits: ['Public Domain'],
      group: null,
    });
    expect(classify(['MIT OR'], only)).toEqual({
      verdict: 'forbidden',
      culprits: ['MIT OR'],
      group: null,
    });
    expect(classify(['Some Custom Licence v2'], only).culprits).toEqual(['Some Custom Licence v2']);
    expect(classify([], only).verdict).toBe('unknown');
  });
});

describe('classify, allowlist', () => {
  const allowOnly = (allowed: string[]) => deny({ mode: 'allowlist', allowed });

  it('allows what is listed and forbids the rest, unrecognised included', () => {
    expect(classify(['MIT'], allowOnly(['MIT'])).verdict).toBe('allowed');
    expect(classify(['Apache-2.0'], allowOnly(['MIT']))).toEqual({
      verdict: 'forbidden',
      culprits: ['Apache-2.0'],
      group: null,
    });
    expect(classify(['Weird-Licence'], allowOnly(['MIT'])).verdict).toBe('forbidden');
  });

  it('is unknown for no licences', () => {
    expect(classify([], allowOnly(['MIT'])).verdict).toBe('unknown');
  });

  it('combines like the denylist, and accepts a WITH term through its id', () => {
    expect(classify(['MIT OR Apache-2.0'], allowOnly(['MIT'])).verdict).toBe('allowed');
    expect(classify(['MIT AND Apache-2.0'], allowOnly(['MIT'])).verdict).toBe('forbidden');
    const gpl = allowOnly(['GPL-2.0-only']);
    expect(classify(['GPL-2.0-only WITH Classpath-exception-2.0'], gpl).verdict).toBe('allowed');
  });
});

describe('licensePolicySchema', () => {
  const ok: LicensePolicy = {
    mode: 'allowlist',
    forbiddenGroups: ['weak-copyleft'],
    forbidden: ['GPL-3.0-only'],
    allowed: ['MIT'],
    warnUnknown: true,
  };

  it('accepts a policy and the empty policy', () => {
    expect(licensePolicySchema.parse(ok)).toEqual(ok);
    expect(licensePolicySchema.parse(EMPTY_LICENSE_POLICY)).toEqual(EMPTY_LICENSE_POLICY);
  });

  it('rejects an unknown group, an unknown mode and over-long lists or entries', () => {
    expect(licensePolicySchema.safeParse({ ...ok, forbiddenGroups: ['nope'] }).success).toBe(false);
    expect(licensePolicySchema.safeParse({ ...ok, mode: 'other' }).success).toBe(false);
    expect(
      licensePolicySchema.safeParse({ ...ok, forbidden: Array(501).fill('MIT') }).success,
    ).toBe(false);
    expect(licensePolicySchema.safeParse({ ...ok, allowed: Array(500).fill('MIT') }).success).toBe(
      true,
    );
    expect(licensePolicySchema.safeParse({ ...ok, allowed: ['x'.repeat(257)] }).success).toBe(
      false,
    );
    expect(licensePolicySchema.safeParse({ ...ok, allowed: [''] }).success).toBe(false);
    expect(licensePolicySchema.safeParse({ ...ok, warnUnknown: undefined }).success).toBe(false);
  });
});

describe('invalidLicenseIds', () => {
  it('accepts every group member, the WITH terms and Commons-Clause included', () => {
    const members = LICENSE_GROUPS.flatMap((g) => g.members);
    expect(members).toContain('Commons-Clause');
    expect(invalidLicenseIds(deny({ forbidden: members, allowed: members }))).toEqual([]);
  });

  it('returns the entries that are not SPDX ids or terms', () => {
    const policy = deny({
      forbidden: ['GPL-3.0-only', 'Nope-1.0', 'GPL-2.0-only WITH Classpath-exception-2.0'],
      allowed: [
        'mit',
        'MIT WITH Not-An-Exception',
        'Commons-Clause',
        'Apache-2.0 WITH Commons-Clause',
      ],
    });
    expect(invalidLicenseIds(policy)).toEqual(['Nope-1.0', 'MIT WITH Not-An-Exception']);
    expect(invalidLicenseIds(EMPTY_LICENSE_POLICY)).toEqual([]);
  });
});
