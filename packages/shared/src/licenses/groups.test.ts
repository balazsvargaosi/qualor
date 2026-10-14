import { describe, expect, it } from 'vitest';
import { groupOf, LICENSE_GROUPS } from './groups';
import { canonicalTerm, isSpdxException, isSpdxId } from './spdx';

describe('LICENSE_GROUPS integrity', () => {
  it('has the four groups, in order', () => {
    expect(LICENSE_GROUPS.map((g) => g.id)).toEqual([
      'network-copyleft',
      'strong-copyleft',
      'weak-copyleft',
      'non-commercial-or-source-available',
    ]);
    expect(LICENSE_GROUPS.map((g) => g.label)).toEqual([
      'Network copyleft',
      'Strong copyleft',
      'Weak copyleft',
      'Non-commercial or source-available',
    ]);
    for (const g of LICENSE_GROUPS) expect(g.description).toMatch(/\.$/);
  });

  it('names only SPDX ids, `id WITH exception` terms of SPDX parts, and the Commons Clause', () => {
    const bad: string[] = [];
    for (const g of LICENSE_GROUPS)
      for (const m of g.members) {
        if (m === 'Commons-Clause') continue;
        const [lic, exc, ...rest] = m.split(' WITH ');
        const ok =
          isSpdxId(lic!) && (exc === undefined || isSpdxException(exc)) && rest.length === 0;
        if (!ok || canonicalTerm(m) !== m) bad.push(`${g.id}: ${m}`);
      }
    expect(bad).toEqual([]);
  });

  it('keeps no term in two groups', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const g of LICENSE_GROUPS)
      for (const m of g.members) {
        if (seen.has(m)) dup.push(`${m}: ${seen.get(m)} and ${g.id}`);
        seen.set(m, g.id);
      }
    expect(dup).toEqual([]);
  });

  it('includes every CC-BY-NC-ND and CC-BY-NC-SA version of the vendored list', () => {
    const nc = LICENSE_GROUPS.find((g) => g.id === 'non-commercial-or-source-available')!.members;
    for (const v of [
      'CC-BY-NC-ND-4.0',
      'CC-BY-NC-ND-3.0-IGO',
      'CC-BY-NC-SA-4.0',
      'CC-BY-NC-SA-2.0-FR',
    ])
      expect(nc).toContain(v);
    expect(nc.filter((m) => /^CC-BY-NC-(ND|SA)-/.test(m)).length).toBeGreaterThanOrEqual(14);
  });
});

describe('groupOf', () => {
  it('finds the group of an id, any case, deprecated spelling included', () => {
    expect(groupOf('GPL-3.0-only')).toBe('strong-copyleft');
    expect(groupOf('gpl-3.0')).toBe('strong-copyleft');
    expect(groupOf('AGPL-3.0-or-later')).toBe('network-copyleft');
    expect(groupOf('MPL-2.0')).toBe('weak-copyleft');
    expect(groupOf('BUSL-1.1')).toBe('non-commercial-or-source-available');
    expect(groupOf('Commons-Clause')).toBe('non-commercial-or-source-available');
  });

  it('returns null for permissive and unknown licences', () => {
    expect(groupOf('MIT')).toBeNull();
    expect(groupOf('Weird-Licence')).toBeNull();
  });

  it('lets a WITH term win over its id, and falls back to the id', () => {
    expect(groupOf('GPL-2.0-only WITH Classpath-exception-2.0')).toBe('weak-copyleft');
    expect(groupOf('GPL-3.0-only WITH GCC-exception-3.1')).toBe('strong-copyleft');
    expect(groupOf('Apache-2.0 WITH Commons-Clause')).toBe('non-commercial-or-source-available');
    expect(groupOf('MIT WITH Classpath-exception-2.0')).toBeNull();
  });
});
