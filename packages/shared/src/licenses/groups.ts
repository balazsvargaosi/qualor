/**
 * Licence groups for the policy: families of licences with similar obligations, each written from
 * the licences' own terms. The member lists name SPDX ids (and `id WITH exception` terms); the
 * integrity test fails when a member is missing from the vendored SPDX list.
 */
import { canonicalTerm, COMMONS_CLAUSE, SPDX_LICENSE_IDS, splitTerm } from './spdx';

export type LicenseGroupId =
  'network-copyleft' | 'strong-copyleft' | 'weak-copyleft' | 'non-commercial-or-source-available';

export interface LicenseGroup {
  id: LicenseGroupId;
  label: string;
  description: string;
  members: readonly string[];
}

/** Every version of these ids on the vendored list belongs to the non-commercial group. */
const NON_COMMERCIAL_WILDCARDS = /^CC-BY-NC-(ND|SA)-/;

export const LICENSE_GROUPS: readonly LicenseGroup[] = [
  {
    id: 'network-copyleft',
    label: 'Network copyleft',
    description:
      'Licences whose source-sharing duty also applies when the software is only offered over a network.',
    members: [
      'AGPL-1.0-only',
      'AGPL-1.0-or-later',
      'AGPL-3.0-only',
      'AGPL-3.0-or-later',
      'SSPL-1.0',
      'OSL-1.0',
      'OSL-1.1',
      'OSL-2.0',
      'OSL-2.1',
      'OSL-3.0',
      'EUPL-1.1',
      'EUPL-1.2',
      'CPAL-1.0',
      'RPL-1.1',
      'RPL-1.5',
    ],
  },
  {
    id: 'strong-copyleft',
    label: 'Strong copyleft',
    description:
      'Licences that require software combined with the code to be released under the same terms.',
    members: [
      'GPL-1.0-only',
      'GPL-1.0-or-later',
      'GPL-2.0-only',
      'GPL-2.0-or-later',
      'GPL-3.0-only',
      'GPL-3.0-or-later',
      'Sleepycat',
      'QPL-1.0',
    ],
  },
  {
    id: 'weak-copyleft',
    label: 'Weak copyleft',
    description:
      'Licences that require changes to the licensed files or library to be shared, but not the programs that use them.',
    members: [
      'LGPL-2.0-only',
      'LGPL-2.0-or-later',
      'LGPL-2.1-only',
      'LGPL-2.1-or-later',
      'LGPL-3.0-only',
      'LGPL-3.0-or-later',
      'MPL-1.0',
      'MPL-1.1',
      'MPL-2.0',
      'MPL-2.0-no-copyleft-exception',
      'EPL-1.0',
      'EPL-2.0',
      'CDDL-1.0',
      'CDDL-1.1',
      'CPL-1.0',
      'MS-RL',
      'GPL-2.0-only WITH Classpath-exception-2.0',
      'GPL-2.0-or-later WITH Classpath-exception-2.0',
    ],
  },
  {
    id: 'non-commercial-or-source-available',
    label: 'Non-commercial or source-available',
    description:
      'Licences that restrict commercial use or competing services, so they are not open source in the usual sense.',
    members: [
      'CC-BY-NC-1.0',
      'CC-BY-NC-2.0',
      'CC-BY-NC-2.5',
      'CC-BY-NC-3.0',
      'CC-BY-NC-4.0',
      ...SPDX_LICENSE_IDS.filter((id) => NON_COMMERCIAL_WILDCARDS.test(id)),
      'BUSL-1.1',
      'Elastic-2.0',
      COMMONS_CLAUSE,
      'PolyForm-Noncommercial-1.0.0',
      'PolyForm-Small-Business-1.0.0',
    ],
  },
];

const GROUP_BY_TERM = new Map<string, LicenseGroupId>(
  LICENSE_GROUPS.flatMap((g) => g.members.map((m) => [canonicalTerm(m), g.id] as const)),
);

/**
 * The group of a term (an id, or "id WITH exception"), or null. A `WITH` term's own group wins over
 * its id's (the Classpath exception lifts GPL into weak copyleft); the Commons Clause as an
 * exception puts any licence into the non-commercial group.
 */
export function groupOf(term: string): LicenseGroupId | null {
  const canon = canonicalTerm(term);
  const direct = GROUP_BY_TERM.get(canon);
  if (direct !== undefined) return direct;
  const { id, exception } = splitTerm(canon);
  if (exception === null) return null;
  if (exception === COMMONS_CLAUSE) return GROUP_BY_TERM.get(COMMONS_CLAUSE) ?? null;
  return GROUP_BY_TERM.get(id) ?? null;
}
