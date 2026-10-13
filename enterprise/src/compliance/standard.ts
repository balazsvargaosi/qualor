// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import owasp2021 from './standards/owasp-top10-2021.json';
import owasp2025 from './standards/owasp-top10-2025.json';
import cwe2025 from './standards/cwe-top25-2025.json';
import asvs403 from './standards/asvs-4.0.3.json';
import pci401 from './standards/pci-dss-4.0.1-6.2.4.json';

/**
 * 4E-1 §2.2: the standards a compliance report maps findings to. The data files are generated
 * offline from committed sources (scripts/standards/generate.ts); the server never fetches them.
 */
export interface StandardCategory {
  id: string;
  title: string;
  cwe: number[];
  /** Matches every finding of these severities, whatever its CWE (PCI 6.2.4 high-risk only). */
  severities?: string[];
}

export interface StandardData {
  id: string;
  family: 'owasp-top10' | 'cwe-top25' | 'asvs' | 'pci-dss';
  version: string;
  title: string;
  source: string;
  licence: string;
  sourceSha256: string;
  categories: StandardCategory[];
}

/** The standards every new report uses, in report order (4E-1 §2.2). */
export const STANDARDS: readonly StandardData[] = Object.freeze([
  owasp2021,
  owasp2025,
  cwe2025,
  asvs403,
  pci401,
] as StandardData[]);

export function standardRefs(): { id: string; version: string; sourceSha256: string }[] {
  return STANDARDS.map((s) => ({ id: s.id, version: s.version, sourceSha256: s.sourceSha256 }));
}
