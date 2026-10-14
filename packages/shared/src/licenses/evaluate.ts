/**
 * The licence policy and its evaluator: classifies the licences of one dependency (an AND of the
 * entries, each an SPDX expression after normalisation) as allowed, forbidden or unknown.
 */
import { z } from 'zod';
import { licenseTerms, parseLicenseExpression, type LicenseExpr } from './expression';
import { groupOf, type LicenseGroupId } from './groups';
import { normalizeLicense } from './normalize';
import { canonicalTerm, COMMONS_CLAUSE, isSpdxException, isSpdxId, termId } from './spdx';

export interface LicensePolicy {
  mode: 'denylist' | 'allowlist';
  forbiddenGroups: LicenseGroupId[];
  forbidden: string[]; // canonical ids or "id WITH exception"
  allowed: string[];
  warnUnknown: boolean;
}

export const EMPTY_LICENSE_POLICY: LicensePolicy = {
  mode: 'denylist',
  forbiddenGroups: [],
  forbidden: [],
  allowed: [],
  warnUnknown: false,
};

export type LicenseVerdict = 'allowed' | 'forbidden' | 'unknown';
export interface Classification {
  verdict: LicenseVerdict;
  culprits: string[];
  group: LicenseGroupId | null;
}

const WITH_SEP = ' WITH ';

/** A term is recognised when its id is on the SPDX list or it belongs to a licence group. */
function isRecognised(term: string): boolean {
  const base = termId(term);
  return isSpdxId(base) || groupOf(term) !== null;
}

interface Node {
  forbidden: boolean;
  allUnrecognised: boolean;
  culprits: string[];
}

function evaluateExpr(expr: LicenseExpr, forbidsLeaf: (term: string) => boolean): Node {
  if (expr.kind === 'id' || expr.kind === 'with') {
    const term = licenseTerms(expr)[0] ?? '';
    const forbidden = forbidsLeaf(term);
    return {
      forbidden,
      allUnrecognised: !isRecognised(term),
      culprits: forbidden ? [term] : [],
    };
  }
  const left = evaluateExpr(expr.left, forbidsLeaf);
  const right = evaluateExpr(expr.right, forbidsLeaf);
  const forbidden =
    expr.kind === 'and' ? left.forbidden || right.forbidden : left.forbidden && right.forbidden;
  return {
    forbidden,
    allUnrecognised: left.allUnrecognised && right.allUnrecognised,
    culprits: forbidden ? [...left.culprits, ...right.culprits] : [],
  };
}

export function classify(licenses: readonly string[], policy: LicensePolicy): Classification {
  const allowed = new Set(policy.allowed.map(canonicalTerm));
  const forbiddenTerms = new Set(policy.forbidden.map(canonicalTerm));
  const groups = new Set<LicenseGroupId>(policy.forbiddenGroups);

  const forbidsLeaf =
    policy.mode === 'allowlist'
      ? (term: string): boolean => {
          const base = termId(term);
          return !(allowed.has(term) || allowed.has(base));
        }
      : (term: string): boolean => {
          // The exact rule on the whole term first, then the rule of its id, then the groups.
          const base = termId(term);
          if (allowed.has(term)) return false;
          if (forbiddenTerms.has(term)) return true;
          if (base !== term) {
            if (allowed.has(base)) return false;
            if (forbiddenTerms.has(base)) return true;
          }
          const group = groupOf(term);
          return group !== null && groups.has(group);
        };

  let forbidden = false;
  let allUnrecognised = true;
  let parsed = 0;
  const culprits = new Set<string>();
  for (const entry of licenses) {
    const expr = parseLicenseExpression(normalizeLicense(entry));
    if (expr === null) continue; // malformed: it names no licence
    parsed++;
    const node = evaluateExpr(expr, forbidsLeaf);
    if (node.forbidden) forbidden = true;
    if (!node.allUnrecognised) allUnrecognised = false;
    for (const c of node.culprits) culprits.add(c);
  }

  if (parsed === 0) return { verdict: 'unknown', culprits: [], group: null };
  if (forbidden) {
    const sorted = [...culprits].sort();
    return { verdict: 'forbidden', culprits: sorted, group: groupOf(sorted[0] ?? '') };
  }
  return { verdict: allUnrecognised ? 'unknown' : 'allowed', culprits: [], group: null };
}

const GROUP_IDS = [
  'network-copyleft',
  'strong-copyleft',
  'weak-copyleft',
  'non-commercial-or-source-available',
] as const satisfies readonly LicenseGroupId[];

const policyList = z.array(z.string().trim().min(1).max(256)).max(500);

export const licensePolicySchema: z.ZodType<LicensePolicy> = z.object({
  mode: z.enum(['denylist', 'allowlist']),
  forbiddenGroups: z.array(z.enum(GROUP_IDS)).max(GROUP_IDS.length),
  forbidden: policyList,
  allowed: policyList,
  warnUnknown: z.boolean(),
});

function isKnownTerm(entry: string): boolean {
  const term = canonicalTerm(entry);
  const i = term.indexOf(WITH_SEP);
  if (i < 0) return isSpdxId(term) || groupOf(term) !== null;
  const exception = term.slice(i + WITH_SEP.length);
  return isSpdxId(term.slice(0, i)) && (isSpdxException(exception) || exception === COMMONS_CLAUSE);
}

/** The entries of the policy's `forbidden` and `allowed` lists that are not SPDX ids or terms. */
export function invalidLicenseIds(policy: LicensePolicy): string[] {
  return [...policy.forbidden, ...policy.allowed].filter((e) => !isKnownTerm(e));
}
