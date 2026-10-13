// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STANDARDS } from '../../src/compliance/standard';
import { generateAll } from './generate';

describe('the committed standards data (4E-1 §2.2)', () => {
  it('equals what the generator makes of the committed sources', () => {
    const generated = generateAll(new URL('../../', import.meta.url));
    expect(Object.keys(generated).sort()).toEqual(STANDARDS.map((s) => `${s.id}.json`).sort());
    for (const [file, text] of Object.entries(generated)) {
      expect(
        readFileSync(new URL(`../../src/compliance/standards/${file}`, import.meta.url), 'utf8'),
        file,
      ).toBe(text);
    }
  });

  it('has the expected shape per family', () => {
    const count = Object.fromEntries(STANDARDS.map((s) => [s.id, s.categories.length]));
    expect(count).toEqual({
      'owasp-top10-2021': 10,
      'owasp-top10-2025': 10,
      'cwe-top25-2025': 25,
      'asvs-4.0.3': 14,
      'pci-dss-4.0.1-6.2.4': 6,
    });
  });

  it('maps the spot checks', () => {
    const cat = (id: string, cwe: number) =>
      STANDARDS.find((s) => s.id === id)!
        .categories.filter((c) => c.cwe.includes(cwe))
        .map((c) => c.id);
    expect(cat('owasp-top10-2021', 89)).toEqual(['A03']);
    expect(cat('owasp-top10-2021', 798)).toEqual(['A07']);
    expect(cat('owasp-top10-2025', 89).length).toBe(1);
    expect(cat('cwe-top25-2025', 79)).toEqual(['1']);
  });
});
