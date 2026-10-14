/**
 * The SPDX licence and exception identifiers (spdx-ids.json, from the CC0 SPDX license-list-data;
 * `pnpm spdx:update` refreshes it). Lookups are case-insensitive and return the canonical spelling.
 */
import list from './spdx-ids.json' with { type: 'json' };

export const SPDX_LIST_VERSION: string = list.version;
export const SPDX_LIST_DATE: string = list.date;

function lowerMap(ids: readonly string[]): Map<string, string> {
  return new Map(ids.map((id) => [id.toLowerCase(), id]));
}
const LICENSES = lowerMap(list.licenses);
const EXCEPTIONS = lowerMap(list.exceptions);

/** Every identifier of the vendored list, in list order. */
export const SPDX_LICENSE_IDS: readonly string[] = list.licenses;
export const SPDX_EXCEPTION_IDS: readonly string[] = list.exceptions;

export function isSpdxId(id: string): boolean {
  return LICENSES.has(id.toLowerCase());
}

/** The canonical spelling of an SPDX licence id (any case), or null when it is not on the list. */
export function canonicalId(id: string): string | null {
  return LICENSES.get(id.toLowerCase()) ?? null;
}

export function isSpdxException(id: string): boolean {
  return EXCEPTIONS.has(id.toLowerCase());
}

/** The canonical spelling of an SPDX exception id (any case), or null. */
export function canonicalException(id: string): string | null {
  return EXCEPTIONS.get(id.toLowerCase()) ?? null;
}

/** SPDX deprecated the bare GNU ids; the bare id means the 'only' form, the `+` form 'or later'. */
const DEPRECATED_BARE = new Set([
  'GPL-1.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'AGPL-1.0',
  'AGPL-3.0',
]);

/**
 * A licence id as written in a manifest to the canonical SPDX id: any case, the deprecated GNU ids
 * mapped to `-only`, and a `+` suffix to `-or-later` (`GPL-2.0+`). A `+` on an id with no
 * 'or later' form stays as written. An id that cannot be resolved comes back unchanged.
 */
export function resolveLicenseId(token: string): string {
  if (token.endsWith('+')) {
    const base = canonicalId(token.slice(0, -1));
    if (base !== null) {
      if (DEPRECATED_BARE.has(base)) return `${base}-or-later`;
      const later = canonicalId(`${base}-or-later`);
      if (later !== null) return later;
    }
    return token;
  }
  const canon = canonicalId(token);
  if (canon === null) return token;
  return DEPRECATED_BARE.has(canon) ? `${canon}-only` : canon;
}

/**
 * A group member that is not an SPDX id. The Commons Clause is a condition added to another
 * licence ('Apache-2.0 WITH Commons-Clause' in the wild), not an SPDX exception.
 */
export const COMMONS_CLAUSE = 'Commons-Clause';

const WITH_TERM = /^(\S+)\s+WITH\s+(\S+)$/i;
const isCommonsClause = (s: string): boolean => s.toLowerCase() === COMMONS_CLAUSE.toLowerCase();

/** The licence id of a term: 'GPL-2.0-only WITH X' gives 'GPL-2.0-only'. */
export function termId(term: string): string {
  return term.split(' WITH ')[0] ?? term;
}

/** The canonical spelling of a term: an id, or 'id WITH exception'. Unresolved parts stay as written. */
export function canonicalTerm(term: string): string {
  const trimmed = term.trim();
  const m = WITH_TERM.exec(trimmed);
  if (m === null) return isCommonsClause(trimmed) ? COMMONS_CLAUSE : resolveLicenseId(trimmed);
  const [, id = trimmed, exc = ''] = m;
  const exception = isCommonsClause(exc) ? COMMONS_CLAUSE : (canonicalException(exc) ?? exc);
  return `${resolveLicenseId(id)} WITH ${exception}`;
}
