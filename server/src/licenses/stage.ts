import {
  computeFingerprints,
  EMPTY_LICENSE_POLICY,
  filelessHash,
  LICENSE_GROUPS,
  licenseClassifier,
  validateRepoPath,
  type IssueKind,
  type Quality,
  type Severity,
} from '@qualor/shared';
import { inArray } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { uuidv7 } from '../db/ids';
import { rules } from '../db/schema';
import type { IngestionStage } from '../ingest/process';
import {
  requireState,
  type AcceptedFinding,
  type IngestedFinding,
  type ResolvedRule,
} from '../ingest/state';
import { mergeDependencyEntries, type DependencyRowInput } from '../measures/store';
import { LICENSE_ENGINE } from '../tracking/plan';
import { policyFor } from './settings';

export const FORBIDDEN_RULE_KEY = `${LICENSE_ENGINE}:forbidden`;
export const UNKNOWN_RULE_KEY = `${LICENSE_ENGINE}:unknown`;

interface BuiltinRule {
  key: string;
  engineRuleId: string;
  name: string;
  description: string;
  severity: Severity;
}

/** 6M §6: the built-in rules of the licence policy, with Qualor's own descriptions. */
const LICENSE_RULES: readonly BuiltinRule[] = [
  {
    key: FORBIDDEN_RULE_KEY,
    engineRuleId: 'forbidden',
    name: 'Forbidden licence',
    description: "A dependency's licence is forbidden by the organisation's licence policy.",
    severity: 'high',
  },
  {
    key: UNKNOWN_RULE_KEY,
    engineRuleId: 'unknown',
    name: 'Unknown licence',
    description: 'A dependency has no licence Qualor could read.',
    severity: 'info',
  },
];

const QUALITY: Quality = 'licensing';
const KIND: IssueKind = 'issue';

/**
 * Creates the two licence rules when they are missing and reads them back. A rule that exists is
 * left as it is (`ON CONFLICT DO NOTHING`, so no row lock), as the rules stage leaves a built-in
 * rule (data-model.md §4.4).
 */
export async function ensureLicenseRules(tx: Executor): Promise<Map<string, ResolvedRule>> {
  await tx
    .insert(rules)
    .values(
      LICENSE_RULES.map((r) => ({
        id: uuidv7(),
        key: r.key,
        engineId: LICENSE_ENGINE,
        engineRuleId: r.engineRuleId,
        name: r.name,
        descriptionMd: r.description,
        defaultSeverity: r.severity,
        quality: QUALITY,
        kind: KIND,
        origin: 'builtin' as const,
      })),
    )
    .onConflictDoNothing({ target: rules.key });
  const rows = await tx
    .select({
      id: rules.id,
      key: rules.key,
      engineId: rules.engineId,
      defaultSeverity: rules.defaultSeverity,
      quality: rules.quality,
      kind: rules.kind,
      cwe: rules.cwe,
    })
    .from(rules)
    .where(
      inArray(
        rules.key,
        LICENSE_RULES.map((r) => r.key),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.key,
      {
        ...r,
        defaultSeverity: r.defaultSeverity as Severity,
        quality: r.quality as Quality,
      },
    ]),
  );
}

const GROUP_LABELS = new Map(LICENSE_GROUPS.map((g) => [g.id, g.label]));

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareEntries(a: DependencyRowInput, b: DependencyRowInput): number {
  return (
    byCodeUnits(a.path, b.path) ||
    byCodeUnits(a.ecosystem, b.ecosystem) ||
    byCodeUnits(a.name, b.name) ||
    byCodeUnits(a.version, b.version)
  );
}

/** The finding of one inventory entry under one rule: the package in its lockfile. */
function licenseFinding(
  entry: DependencyRowInput,
  rule: ResolvedRule,
  message: string,
): IngestedFinding {
  // The package's identity, as Trivy's findings use it (sarif/normalize.ts): stable when the
  // lockfile is re-ordered or the entry moves; a version bump is another package.
  const hash = filelessHash(rule.key, `${entry.name}@${entry.version}`, entry.path);
  // A path a report could not carry as a location (a foreign scanner's absolute path, say) keeps
  // the finding, file-less: its identity still names the lockfile.
  const placed = validateRepoPath(entry.path) === null;
  return {
    engineId: LICENSE_ENGINE,
    ruleId: rule.key.slice(LICENSE_ENGINE.length + 1),
    message,
    severity: rule.defaultSeverity,
    location: !placed
      ? null
      : entry.line === null
        ? { path: entry.path }
        : { path: entry.path, startLine: entry.line, endLine: entry.line },
    lineHash: hash,
    contextHash: hash,
  };
}

/**
 * 6M §6: judges the report's dependency inventory against the organisation's licence policy and
 * adds a finding of engine `license` per forbidden entry (and per unknown one when the policy
 * warns on unknown licences), before tracking, so they become ordinary issues.
 *
 * It runs only when the feature is licensed and the report carries an inventory. Then it tells
 * tracking that the `license` engine ran (`serverOkEngines`), which closes the licence issues not
 * found again: without a policy, every one of them. Otherwise it does nothing, and tracking leaves
 * every open licence issue as it is (a lapsed licence, an older CLI, a failed or timed-out pass).
 */
export const licensePolicyStage: IngestionStage = {
  name: 'license-policy',
  async run(ctx) {
    // Licence findings are the server's alone: a report's findings of engine `license` (a
    // hand-made report) are dropped, so they can neither open nor keep a licence issue.
    const reported = requireState(ctx.state, 'findings');
    const findings = reported.filter((f) => f.rule.engineId !== LICENSE_ENGINE);
    if (findings.length !== reported.length) {
      ctx.logger.debug(
        { analysisId: ctx.analysisId, dropped: reported.length - findings.length },
        'dropped report findings of the server-only licence engine',
      );
      ctx.state.findings = findings;
    }
    const entries = ctx.report.dependencies;
    if (!ctx.limits.licenses.policy || entries === undefined) return;

    const policy = (await policyFor(ctx.tx, ctx.project.organizationId)) ?? EMPTY_LICENSE_POLICY;
    const resolved = await ensureLicenseRules(ctx.tx);
    const forbiddenRule = resolved.get(FORBIDDEN_RULE_KEY);
    const unknownRule = resolved.get(UNKNOWN_RULE_KEY);
    if (!forbiddenRule || !unknownRule) throw new Error('the licence rules were not created');

    const classify = licenseClassifier(policy);
    const made: { finding: IngestedFinding; rule: ResolvedRule }[] = [];
    // Merged as the inventory store merges them: one finding per (path, ecosystem, name, version).
    for (const entry of mergeDependencyEntries(entries).sort(compareEntries)) {
      const verdict = classify(entry.licenses);
      const version = entry.version || 'unknown version';
      if (verdict.verdict === 'forbidden') {
        const group = verdict.group === null ? undefined : GROUP_LABELS.get(verdict.group);
        made.push({
          rule: forbiddenRule,
          finding: licenseFinding(
            entry,
            forbiddenRule,
            `${entry.name} ${version} is licensed ${entry.licenses.join(' AND ')}, which the organisation's licence policy forbids${group ? ` (${group})` : ''}.`,
          ),
        });
      } else if (verdict.verdict === 'unknown' && policy.warnUnknown) {
        made.push({
          rule: unknownRule,
          finding: licenseFinding(
            entry,
            unknownRule,
            `${entry.name} ${version} has no licence Qualor could read.`,
          ),
        });
      }
    }

    const fingerprints = computeFingerprints(
      made.map(({ finding, rule }) => ({
        ruleKey: rule.key,
        path: finding.location?.path ?? null,
        lineHash: finding.lineHash,
        contextHash: finding.contextHash,
        startLine: finding.location?.startLine ?? 0,
        startColumn: 0,
      })),
    );
    const base = ctx.report.findings.length;
    const accepted: AcceptedFinding[] = made.map(({ finding, rule }, i) => ({
      index: base + i,
      finding,
      rule,
      severity: rule.defaultSeverity,
      fingerprint: fingerprints[i] ?? '',
    }));
    ctx.state.findings = [...findings, ...accepted];
    ctx.state.serverOkEngines = [LICENSE_ENGINE];
    ctx.logger.debug(
      { analysisId: ctx.analysisId, entries: entries.length, findings: accepted.length },
      'judged the dependency licences',
    );
  },
};
