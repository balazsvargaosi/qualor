import { describe, expect, it } from 'vitest';
import {
  canonicalException,
  canonicalId,
  canonicalTerm,
  DEPRECATED_WITH_IDS,
  resolveLicenseId,
  splitTerm,
  isSpdxException,
  isSpdxId,
  SPDX_LICENSE_IDS,
  SPDX_LIST_DATE,
  SPDX_LIST_VERSION,
} from './spdx';

describe('spdx', () => {
  it('knows the list version and date', () => {
    expect(SPDX_LIST_VERSION).toMatch(/^\d+\.\d+/);
    expect(SPDX_LIST_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SPDX_LICENSE_IDS.length).toBeGreaterThan(600);
  });

  it('looks ids up case-insensitively', () => {
    expect(isSpdxId('MIT')).toBe(true);
    expect(isSpdxId('mit')).toBe(true);
    expect(isSpdxId('Weird-Licence')).toBe(false);
    expect(canonicalId('apache-2.0')).toBe('Apache-2.0');
    expect(canonicalId('nope')).toBeNull();
  });

  it('looks exceptions up case-insensitively', () => {
    expect(isSpdxException('classpath-exception-2.0')).toBe(true);
    expect(canonicalException('classpath-exception-2.0')).toBe('Classpath-exception-2.0');
    expect(isSpdxException('MIT')).toBe(false);
    expect(canonicalException('nope')).toBeNull();
  });

  it('canonicalises a term', () => {
    expect(canonicalTerm(' gpl-2.0-only with classpath-exception-2.0 ')).toBe(
      'GPL-2.0-only WITH Classpath-exception-2.0',
    );
    expect(canonicalTerm('gpl-3.0')).toBe('GPL-3.0-only');
    expect(canonicalTerm('Weird')).toBe('Weird');
  });

  it('resolves each deprecated -with- id to its id WITH exception', () => {
    const cases: [string, string][] = [
      ['GPL-2.0-with-classpath-exception', 'GPL-2.0-only WITH Classpath-exception-2.0'],
      ['GPL-2.0-with-GCC-exception', 'GPL-2.0-only WITH GCC-exception-2.0'],
      ['GPL-2.0-with-autoconf-exception', 'GPL-2.0-only WITH Autoconf-exception-2.0'],
      ['GPL-2.0-with-bison-exception', 'GPL-2.0-only WITH Bison-exception-2.2'],
      ['GPL-2.0-with-font-exception', 'GPL-2.0-only WITH Font-exception-2.0'],
      ['GPL-3.0-with-GCC-exception', 'GPL-3.0-only WITH GCC-exception-3.1'],
      ['GPL-3.0-with-autoconf-exception', 'GPL-3.0-only WITH Autoconf-exception-3.0'],
    ];
    for (const [old, term] of cases) {
      expect(resolveLicenseId(old)).toBe(term);
      expect(resolveLicenseId(old.toLowerCase())).toBe(term);
      expect(canonicalTerm(old)).toBe(term);
    }
    // every deprecated -with- id on the vendored list is covered, and every target is real
    expect(SPDX_LICENSE_IDS.filter((id) => /^GPL-\d\.0-with-/.test(id)).length).toBe(cases.length);
    for (const term of DEPRECATED_WITH_IDS) {
      const { id, exception } = splitTerm(term);
      expect(isSpdxId(id)).toBe(true);
      expect(isSpdxException(exception ?? '')).toBe(true);
    }
  });

  it('resolves X+ to X-or-later, or to X when there is no later form', () => {
    expect(resolveLicenseId('GPL-2.0+')).toBe('GPL-2.0-or-later');
    expect(resolveLicenseId('EUPL-1.2+')).toBe('EUPL-1.2');
    expect(resolveLicenseId('mpl-1.1+')).toBe('MPL-1.1');
    expect(resolveLicenseId('EPL-1.0+')).toBe('EPL-1.0');
    expect(resolveLicenseId('Weird+')).toBe('Weird+');
  });

  it('splits a term in one place', () => {
    expect(splitTerm('A WITH B')).toEqual({ id: 'A', exception: 'B' });
    expect(splitTerm('A')).toEqual({ id: 'A', exception: null });
    expect(splitTerm('A WITH B C').exception).toBeNull();
  });
});
