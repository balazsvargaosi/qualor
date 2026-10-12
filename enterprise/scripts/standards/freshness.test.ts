// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { describe, expect, it } from 'vitest';
import entries from '../../src/compliance/standards/freshness.json';
import { checkFreshness, type FreshnessEntry } from './freshness';

const E: FreshnessEntry[] = [
  { family: 'cwe-top25', current: 'cwe-top25-2025', nextCheck: '2027-01-31', note: '' },
];

describe('the standards freshness alarm (4E-1 §2.2.1)', () => {
  it('is quiet before nextCheck and stale on and after it', () => {
    expect(checkFreshness(E, new Date('2027-01-30T23:59:59Z')).stale).toEqual([]);
    expect(checkFreshness(E, new Date('2027-01-31T00:00:00Z')).stale).toEqual(E);
  });

  it('refuses a nextCheck that is not a date', () => {
    expect(() => checkFreshness([{ ...E[0]!, nextCheck: 'soon' }], new Date())).toThrow(/soon/);
  });

  it('covers every family the release ships, and warns (never fails) in regular runs', () => {
    expect(new Set((entries as FreshnessEntry[]).map((e) => e.family))).toEqual(
      new Set(['owasp-top10', 'cwe-top25', 'asvs', 'pci-dss']),
    );
    const { stale } = checkFreshness(entries as FreshnessEntry[], new Date());
    for (const e of stale) {
      // GitHub Actions turns this line into a warning annotation; the test still passes.
      console.warn(
        `::warning::Compliance standards: check whether a new edition of ${e.family} is out (nextCheck ${e.nextCheck})`,
      );
    }
  });
});
