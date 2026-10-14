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
 * The deprecated `GPL-x.y-with-*-exception` ids and their SPDX replacements (an id WITH an
 * exception). Like the bare GNU ids they mean the "only" form.
 */
const DEPRECATED_WITH: Readonly<Record<string, string>> = {
  'gpl-2.0-with-autoconf-exception': 'GPL-2.0-only WITH Autoconf-exception-2.0',
  'gpl-2.0-with-bison-exception': 'GPL-2.0-only WITH Bison-exception-2.2',
  'gpl-2.0-with-classpath-exception': 'GPL-2.0-only WITH Classpath-exception-2.0',
  'gpl-2.0-with-font-exception': 'GPL-2.0-only WITH Font-exception-2.0',
  'gpl-2.0-with-gcc-exception': 'GPL-2.0-only WITH GCC-exception-2.0',
  'gpl-3.0-with-autoconf-exception': 'GPL-3.0-only WITH Autoconf-exception-3.0',
  'gpl-3.0-with-gcc-exception': 'GPL-3.0-only WITH GCC-exception-3.1',
};
export const DEPRECATED_WITH_IDS: readonly string[] = Object.values(DEPRECATED_WITH);

/**
 * A licence id as written in a manifest to its canonical form: any case, the deprecated GNU ids
 * mapped to `-only`, the deprecated `-with-` ids to `id WITH exception`, and a `+` suffix to
 * `-or-later` (`GPL-2.0+`) or, where the id has no such form, to the id itself (`EUPL-1.2+` is
 * EUPL-1.2). An id that cannot be resolved comes back unchanged. The result is an id, or for a
 * deprecated `-with-` id an "id WITH exception" term.
 */
export function resolveLicenseId(token: string): string {
  if (token.endsWith('+')) {
    const base = canonicalId(token.slice(0, -1));
    if (base === null || base.toLowerCase() in DEPRECATED_WITH) return token;
    if (DEPRECATED_BARE.has(base)) return `${base}-or-later`;
    return canonicalId(`${base}-or-later`) ?? base;
  }
  const canon = canonicalId(token);
  if (canon === null) return token;
  const withTerm = DEPRECATED_WITH[canon.toLowerCase()];
  if (withTerm !== undefined) return withTerm;
  return DEPRECATED_BARE.has(canon) ? `${canon}-only` : canon;
}

/**
 * A group member that is not an SPDX id. The Commons Clause is a condition added to another
 * licence ('Apache-2.0 WITH Commons-Clause' in the wild), not an SPDX exception.
 */
export const COMMONS_CLAUSE = 'Commons-Clause';

const WITH_TERM = /^(\S+)\s+WITH\s+(\S+)$/i;
const isCommonsClause = (s: string): boolean => s.toLowerCase() === COMMONS_CLAUSE.toLowerCase();

/**
 * Splits a term into its id and exception ("GPL-2.0-only WITH X" gives the id and X; a plain id has
 * no exception). The one place a term is taken apart: only call it on a term from the parser or the
 * canonical form, never on free text.
 */
export function splitTerm(term: string): { id: string; exception: string | null } {
  const m = WITH_TERM.exec(term.trim());
  return m === null
    ? { id: term.trim(), exception: null }
    : { id: m[1] ?? '', exception: m[2] ?? '' };
}

/** The canonical spelling of a term: an id, or "id WITH exception". Unresolved parts stay as written. */
export function canonicalTerm(term: string): string {
  const { id, exception } = splitTerm(term);
  if (exception === null) return isCommonsClause(id) ? COMMONS_CLAUSE : resolveLicenseId(id);
  const exc = isCommonsClause(exception)
    ? COMMONS_CLAUSE
    : (canonicalException(exception) ?? exception);
  return `${resolveLicenseId(id)} WITH ${exc}`;
}
