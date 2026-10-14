/**
 * SPDX licence expressions: `WITH` binds tighter than `AND`, which binds tighter than `OR`;
 * parentheses group; keywords are case-insensitive; a `+` suffix on an id means `-or-later`.
 * An id that is not on the SPDX list stays in the tree as written.
 */
import { canonicalException, COMMONS_CLAUSE, resolveLicenseId } from './spdx';

export type LicenseExpr =
  | { kind: 'id'; id: string } // canonical SPDX id, or an unrecognised raw string
  | { kind: 'with'; id: string; exception: string }
  | { kind: 'and' | 'or'; left: LicenseExpr; right: LicenseExpr };

const KEYWORDS = new Set(['and', 'or', 'with']);

function resolveException(token: string): string {
  if (token.toLowerCase() === COMMONS_CLAUSE.toLowerCase()) return COMMONS_CLAUSE;
  return canonicalException(token) ?? token;
}

/** Null when the text is malformed (empty, dangling operator, unbalanced parentheses, stray words). */
export function parseLicenseExpression(text: string): LicenseExpr | null {
  const tokens = text.match(/[()]|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const isKeyword = (t: string | undefined, kw: string): boolean => t?.toLowerCase() === kw;

  function parseOr(): LicenseExpr | null {
    let left = parseAnd();
    while (left !== null && isKeyword(peek(), 'or')) {
      pos++;
      const right = parseAnd();
      if (right === null) return null;
      left = { kind: 'or', left, right };
    }
    return left;
  }
  function parseAnd(): LicenseExpr | null {
    let left = parseWith();
    while (left !== null && isKeyword(peek(), 'and')) {
      pos++;
      const right = parseWith();
      if (right === null) return null;
      left = { kind: 'and', left, right };
    }
    return left;
  }
  function parseWith(): LicenseExpr | null {
    const t = peek();
    if (t === undefined) return null;
    if (t === '(') {
      pos++;
      const inner = parseOr();
      if (inner === null || peek() !== ')') return null;
      pos++;
      return inner;
    }
    if (t === ')' || KEYWORDS.has(t.toLowerCase())) return null;
    pos++;
    const id = resolveLicenseId(t);
    if (!isKeyword(peek(), 'with')) return { kind: 'id', id };
    pos++;
    const exc = peek();
    if (exc === undefined || exc === '(' || exc === ')' || KEYWORDS.has(exc.toLowerCase()))
      return null;
    pos++;
    return { kind: 'with', id, exception: resolveException(exc) };
  }

  const expr = parseOr();
  return expr !== null && pos === tokens.length ? expr : null;
}

/** The leaf terms of an expression, each an id or "id WITH exception", in reading order. */
export function licenseTerms(expr: LicenseExpr): string[] {
  if (expr.kind === 'id') return [expr.id];
  if (expr.kind === 'with') return [`${expr.id} WITH ${expr.exception}`];
  return [...licenseTerms(expr.left), ...licenseTerms(expr.right)];
}

/** The expression as canonical text, parenthesising an OR inside an AND. */
export function formatLicenseExpression(expr: LicenseExpr): string {
  if (expr.kind === 'id') return expr.id;
  if (expr.kind === 'with') return `${expr.id} WITH ${expr.exception}`;
  const side = (e: LicenseExpr): string =>
    expr.kind === 'and' && e.kind === 'or'
      ? `(${formatLicenseExpression(e)})`
      : formatLicenseExpression(e);
  return `${side(expr.left)} ${expr.kind === 'and' ? 'AND' : 'OR'} ${side(expr.right)}`;
}
