import { sql } from 'drizzle-orm';
import { requireOrganizationAccess, requireUser, type AccessContext } from '../auth/access';
import type { Db, Executor } from '../db/client';
import { pgErrorCode } from '../db/errors';
import { uuidv7Timestamp } from '../db/ids';
import { notFound, ProblemError, validationFailed } from '../http/problem';
import type { PluginPortfolio } from '../plugins/contract';
import { PluginError } from '../plugins/registry';
import { periods, type Granularity } from './periods';
import {
  activity,
  currentFindings,
  measuresOf,
  organizationOf,
  statesAt,
  transactionNow,
  visibleProjects,
  type BranchState,
  type MeasureValues,
  type VisibleProject,
} from './query';
import type {
  PortfolioAggregate,
  PortfolioOverview,
  PortfolioProjectRow,
  Rating,
  SeverityCounts,
} from './types';

export const FEATURE = 'portfolio';
/** 4E-2 §1: no succeeded main-branch analysis in this long, or never, is abandoned. */
const ABANDONED_MS = 30 * 86_400_000;
/** 4E-2 §1: each attention list holds this many projects. */
const ATTENTION_SIZE = 10;
/** 4E-2 §2: the statement budget of the reads. */
const STATEMENT_TIMEOUT_MS = 20_000;
const PG_QUERY_CANCELED = '57014';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATINGS: readonly Rating[] = ['A', 'B', 'C', 'D', 'E'];
const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'] as const;
const GATES = ['passed', 'failed', 'error', 'none'] as const;

/** A project's row at a time, with the quality sums the aggregates need besides the row. */
export interface ProjectState extends PortfolioProjectRow {
  organizationId: string;
  /** Each severity's measure, a missing one null (the row's `bySeverity` is all or nothing). */
  severities: Record<(typeof SEVERITIES)[number], number | null>;
  securityIssues: number | null;
  reliabilityIssues: number | null;
  maintainabilityIssues: number | null;
}

/** A rating 1–5 as A–E; anything else (a missing or a stray value) is null. */
export function ratingOf(value: number | null): Rating | null {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 5
    ? (RATINGS[value - 1] ?? null)
    : null;
}

/** A cancelled statement (57014: the budget ran out) is 503 PORTFOLIO_TIMEOUT; else as it came. */
export function translateTimeout(err: unknown): unknown {
  return pgErrorCode(err) === PG_QUERY_CANCELED
    ? new ProblemError(503, 'PORTFOLIO_TIMEOUT', 'The portfolio took too long to compute')
    : err;
}

/**
 * 4E-2 §2: one repeatable-read, read-only transaction, so every number comes from the same
 * moment, under a statement budget of `timeoutMs` local to it.
 */
export async function readSnapshot<T>(
  db: Db,
  timeoutMs: number,
  read: (tx: Executor) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(
      async (tx) => {
        // SET LOCAL statement_timeout = <ms>, with the value bound as a parameter.
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`);
        return read(tx);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (err) {
    throw translateTimeout(err);
  }
}

/** §1: the project's row from its state at `at` (absent: never analysed by then). */
function projectState(
  p: VisibleProject,
  branch: BranchState | undefined,
  values: MeasureValues | undefined,
  at: Date,
  findings: { secrets: number; vulnerableDependencies: number } | undefined,
): ProjectState {
  const last = branch === undefined ? null : uuidv7Timestamp(branch.analysisId);
  const m = (key: keyof MeasureValues): number | null =>
    branch === undefined ? null : (values?.[key] ?? null);
  const severities = {
    blocker: m('blocker_issues'),
    high: m('high_issues'),
    medium: m('medium_issues'),
    low: m('low_issues'),
    info: m('info_issues'),
  };
  const bySeverity: SeverityCounts | null = SEVERITIES.every((s) => severities[s] !== null)
    ? (severities as SeverityCounts)
    : null;
  const gate =
    branch === undefined ? null : (GATES.find((g) => g === branch.gateStatus) ?? ('none' as const));
  return {
    organizationId: p.organizationId,
    severities,
    organization: { key: p.organizationKey, name: p.organizationName },
    project: { id: p.id, key: p.key, name: p.name },
    lastAnalysisAt: last === null ? null : new Date(last).toISOString(),
    abandoned: last === null || last < at.getTime() - ABANDONED_MS,
    gate,
    securityRating: ratingOf(m('security_rating')),
    reliabilityRating: ratingOf(m('reliability_rating')),
    ncloc: m('ncloc'),
    coverage: m('coverage'),
    duplication: m('duplicated_lines_density'),
    issues: m('issues'),
    bySeverity,
    newIssues: m('new_issues'),
    secrets: findings?.secrets ?? 0,
    vulnerableDependencies: findings?.vulnerableDependencies ?? 0,
    securityIssues: m('security_issues'),
    reliabilityIssues: m('reliability_issues'),
    maintainabilityIssues: m('maintainability_issues'),
  };
}

const ratingCounts = (): Record<Rating, number> => ({ A: 0, B: 0, C: 0, D: 0, E: 0 });

/**
 * 4E-2 §1: the aggregates over a set of projects. Nulls are left out of every one; coverage and
 * duplication are weighted by ncloc over the projects that have both, and a share with nothing
 * to divide by is null.
 */
export function aggregate(rows: readonly ProjectState[]): PortfolioAggregate {
  const out: PortfolioAggregate = {
    projects: rows.length,
    analysed: 0,
    abandoned: 0,
    gate: { passed: 0, failed: 0, error: 0, none: 0 },
    passedShare: null,
    securityRating: ratingCounts(),
    reliabilityRating: ratingCounts(),
    ncloc: 0,
    coverage: null,
    duplication: null,
    issues: 0,
    bySeverity: { blocker: 0, high: 0, medium: 0, low: 0, info: 0 },
    securityIssues: 0,
    reliabilityIssues: 0,
    maintainabilityIssues: 0,
    newIssues: 0,
  };
  const weighted = { coverage: { sum: 0, weight: 0 }, duplication: { sum: 0, weight: 0 } };
  for (const r of rows) {
    if (r.lastAnalysisAt !== null) out.analysed += 1;
    if (r.abandoned) out.abandoned += 1;
    if (r.gate !== null) out.gate[r.gate] += 1;
    if (r.securityRating !== null) out.securityRating[r.securityRating] += 1;
    if (r.reliabilityRating !== null) out.reliabilityRating[r.reliabilityRating] += 1;
    out.ncloc += r.ncloc ?? 0;
    for (const key of ['coverage', 'duplication'] as const) {
      const value = r[key];
      if (value !== null && r.ncloc !== null) {
        weighted[key].sum += value * r.ncloc;
        weighted[key].weight += r.ncloc;
      }
    }
    out.issues += r.issues ?? 0;
    for (const s of SEVERITIES) out.bySeverity[s] += r.severities[s] ?? 0;
    out.securityIssues += r.securityIssues ?? 0;
    out.reliabilityIssues += r.reliabilityIssues ?? 0;
    out.maintainabilityIssues += r.maintainabilityIssues ?? 0;
    out.newIssues += r.newIssues ?? 0;
  }
  out.passedShare = out.analysed === 0 ? null : out.gate.passed / out.analysed;
  for (const key of ['coverage', 'duplication'] as const) {
    const { sum, weight } = weighted[key];
    out[key] = weight > 0 ? sum / weight : null;
  }
  return out;
}

/** The public row: the state without the fields only the aggregates read. */
function rowOf(s: ProjectState): PortfolioProjectRow {
  return {
    organization: s.organization,
    project: s.project,
    lastAnalysisAt: s.lastAnalysisAt,
    abandoned: s.abandoned,
    gate: s.gate,
    securityRating: s.securityRating,
    reliabilityRating: s.reliabilityRating,
    ncloc: s.ncloc,
    coverage: s.coverage,
    duplication: s.duplication,
    issues: s.issues,
    bySeverity: s.bySeverity,
    newIssues: s.newIssues,
    secrets: s.secrets,
    vulnerableDependencies: s.vulnerableDependencies,
  };
}

/** Descending, a missing value last. */
const desc = (a: number | null, b: number | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
const byKey = (a: ProjectState, b: ProjectState): number =>
  a.project.key < b.project.key ? -1 : a.project.key > b.project.key ? 1 : 0;
/** blocker_issues + high_issues, a missing one left out; null when both are missing. */
const severe = ({ severities: { blocker, high } }: ProjectState): number | null =>
  blocker === null && high === null ? null : (blocker ?? 0) + (high ?? 0);
const ratingRank = (r: Rating | null): number | null => (r === null ? null : RATINGS.indexOf(r));

function top(
  rows: readonly ProjectState[],
  keep: (s: ProjectState) => boolean,
  order: (a: ProjectState, b: ProjectState) => number,
): PortfolioProjectRow[] {
  return rows
    .filter(keep)
    .sort((a, b) => order(a, b) || byKey(a, b))
    .slice(0, ATTENTION_SIZE)
    .map(rowOf);
}

/** 4E-2 §1: the four attention lists, ties broken by project key. */
function attention(rows: readonly ProjectState[]): PortfolioOverview['attention'] {
  return {
    failingGates: top(
      rows,
      (s) => s.gate === 'failed',
      (a, b) => desc(severe(a), severe(b)),
    ),
    worstSecurity: top(
      rows,
      // R3: only projects rated B–E need attention.
      (s) => s.securityRating !== null && s.securityRating !== 'A',
      (a, b) =>
        desc(ratingRank(a.securityRating), ratingRank(b.securityRating)) ||
        desc(a.securityIssues, b.securityIssues),
    ),
    mostSevere: top(
      rows,
      // R3: only projects with a blocker or high finding.
      (s) => (severe(s) ?? 0) > 0,
      (a, b) => desc(severe(a), severe(b)),
    ),
    // Never analysed first, then the oldest last analysis.
    abandoned: top(
      rows,
      (s) => s.abandoned,
      (a, b) =>
        a.lastAnalysisAt === b.lastAnalysisAt
          ? 0
          : a.lastAnalysisAt === null
            ? -1
            : b.lastAnalysisAt === null
              ? 1
              : Date.parse(a.lastAnalysisAt) - Date.parse(b.lastAnalysisAt),
    ),
  };
}

/** The all scope's organisations: those with a visible project, sorted by key. */
function byOrganization(
  rows: readonly ProjectState[],
): NonNullable<PortfolioOverview['organizations']> {
  const groups = new Map<string, { key: string; name: string; rows: ProjectState[] }>();
  for (const r of rows) {
    const group = groups.get(r.organizationId) ?? { ...r.organization, rows: [] };
    group.rows.push(r);
    groups.set(r.organizationId, group);
  }
  return [...groups]
    .sort(([, a], [, b]) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(([id, g]) => ({ id, key: g.key, name: g.name, ...aggregate(g.rows) }));
}

/**
 * 4E-2 §2: the core service behind `ctx.portfolio`, computed on request over the projects the
 * caller can read (the filter of `GET /projects`). Every member answers 403 FEATURE_NOT_LICENSED
 * while the feature is inactive. `now` fixes the clock (tests); by default `generatedAt` is the
 * transaction's `now()`.
 */
export function createPortfolioService(deps: {
  db: Db;
  isFeatureActive: (feature: string) => boolean;
  now?: () => Date;
  statementTimeoutMs?: number;
}): PluginPortfolio {
  const { db } = deps;
  const access: AccessContext = { db };
  const timeoutMs = deps.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('statementTimeoutMs is a positive whole number of milliseconds');
  }

  const gate = (): void => {
    if (!deps.isFeatureActive(FEATURE)) {
      throw new ProblemError(
        403,
        'FEATURE_NOT_LICENSED',
        `The enterprise feature "${FEATURE}" is not licensed`,
      );
    }
  };

  const overview: PluginPortfolio['overview'] = async (request, input, options) => {
    gate();
    const principal = requireUser(request, 'read');
    const granularity = (options as Partial<{ granularity: Granularity }> | undefined)?.granularity;
    if (granularity !== 'week' && granularity !== 'month') {
      throw validationFailed([{ path: 'query.granularity', message: 'Use week or month' }]);
    }
    const scope = input as Partial<{ scope: string; organizationId: string }>;
    let organizationId: string | null = null;
    if (scope.scope === 'organization') {
      if (typeof scope.organizationId !== 'string' || !UUID.test(scope.organizationId)) {
        throw notFound('Organization');
      }
      await requireOrganizationAccess(access, principal, scope.organizationId, 'org.read');
      organizationId = scope.organizationId;
    } else if (scope.scope !== 'all') {
      throw validationFailed([{ path: 'query.scope', message: 'Use organization or all' }]);
    }

    return readSnapshot(db, timeoutMs, async (tx): Promise<PortfolioOverview> => {
      const generatedAt = deps.now ? deps.now() : await transactionNow(tx);
      const organization =
        organizationId === null ? null : await organizationOf(tx, organizationId);
      if (organizationId !== null && organization === null) throw notFound('Organization');
      const visible = await visibleProjects(tx, principal.user, organizationId);
      const ids = visible.map((p) => p.id);
      const buckets = periods(generatedAt, granularity);
      const ends = buckets.map((b) => b.end);
      const states = await statesAt(tx, ids, ends);
      const analysisIds = [
        ...new Set(states.flatMap((m) => [...m.values()].map((s) => s.analysisId))),
      ];
      const values = await measuresOf(tx, analysisIds);
      const findings = await currentFindings(tx, ids);
      const counts = await activity(tx, ids, [...buckets.map((b) => b.start), generatedAt]);

      /** The rows at bucket i's end; a trend point counts only the projects existing by then (R4). */
      const rowsAt = (i: number, existing: 'existing' | 'all' = 'existing'): ProjectState[] => {
        const end = ends[i] ?? generatedAt;
        return visible
          .filter((p) => existing === 'all' || p.createdAt.getTime() <= end.getTime())
          .map((p) => {
            const branch = states[i]?.get(p.id);
            return projectState(
              p,
              branch,
              branch === undefined ? undefined : values.get(branch.analysisId),
              end,
              findings.get(p.id),
            );
          });
      };
      // The last bucket ends at generatedAt: its state is the state now, over every visible project.
      const now = rowsAt(buckets.length - 1, 'all');
      const sum = (key: 'secrets' | 'vulnerableDependencies') =>
        now.reduce((n, r) => n + r[key], 0);
      return {
        generatedAt: generatedAt.toISOString(),
        scope: { kind: organization === null ? 'all' : 'organization', organization },
        granularity,
        totals: {
          ...aggregate(now),
          secrets: sum('secrets'),
          vulnerableDependencies: sum('vulnerableDependencies'),
        },
        organizations: organization === null ? byOrganization(now) : null,
        trend: buckets.map((b, i) => ({
          start: b.start.toISOString(),
          end: b.end.toISOString(),
          ...aggregate(rowsAt(i)),
          analyses: counts.analyses[i] ?? 0,
          triage: counts.triage[i] ?? 0,
        })),
        attention: attention(now),
      };
    });
  };

  // 4E-2 §2: paging and the export land in the next step.
  const notImplemented = (): never => {
    throw new PluginError('portfolio service not implemented');
  };

  return Object.freeze({
    overview,
    projects: notImplemented,
    exportRows: notImplemented,
  } satisfies PluginPortfolio);
}
