import { describe, expect, it } from 'vitest';
import {
  canonicalException,
  canonicalId,
  canonicalTerm,
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
});
