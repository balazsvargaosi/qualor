import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AccessContext } from '../auth/access';
import { visibleProjectsCondition } from '../auth/facts';
import type { UserRow } from '../auth/sessions';
import type { Executor } from '../db/client';
import { organizations, projects } from '../db/schema';
import { uuidv7Floor } from './periods';

/**
 * 4E-2 §1, §2: the portfolio's reads. Each one is a single statement over a set of project ids,
 * so the number of round trips does not grow with the number of projects or buckets.
 */

/** A JS array as one bound parameter (a bare array would be spread into a value list). */
const uuidArray = (ids: readonly string[]) => sql`${sql.param(ids)}::uuid[]`;

/** The overall measures a project's state reads (§1); `issues` is also read in scope `new`. */
export const STATE_METRICS = [
  'security_rating',
  'reliability_rating',
  'ncloc',
  'coverage',
  'duplicated_lines_density',
  'issues',
  'blocker_issues',
  'high_issues',
  'medium_issues',
  'low_issues',
  'info_issues',
  'security_issues',
  'reliability_issues',
  'maintainability_issues',
] as const;

export type StateMetric = (typeof STATE_METRICS)[number] | 'new_issues';
export type MeasureValues = Partial<Record<StateMetric, number | null>>;

export interface VisibleProject {
  id: string;
  key: string;
  name: string;
  organizationId: string;
  organizationKey: string;
  organizationName: string;
  createdAt: Date;
}

export interface BranchState {
  analysisId: string;
  gateStatus: string | null;
}

/** The projects the user can read (as `GET /projects` lists them), in one organisation or all. */
export async function visibleProjects(
  tx: Executor,
  user: UserRow,
  organizationId: string | null,
): Promise<VisibleProject[]> {
  const access: AccessContext = { db: tx };
  const conditions: (SQL | undefined)[] = [visibleProjectsCondition(access, user)];
  if (organizationId !== null) conditions.push(eq(projects.organizationId, organizationId));
  return (
    tx
      .select({
        id: projects.id,
        key: projects.key,
        name: projects.name,
        organizationId: organizations.id,
        organizationKey: organizations.key,
        organizationName: organizations.name,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.organizationId))
      .where(and(...conditions))
      // R5: keys sort in code-unit (byte) order, as the TS comparisons do.
      .orderBy(sql`${projects.key} COLLATE "C"`)
  );
}

/**
 * The state of each project at each time in `ends` (§1): the newest succeeded analysis of its
 * main branch uploaded before that time (`id < uuidv7Floor(t)`, served by analyses_branch_idx).
 * One map per time, by project id; a project with no such analysis is absent.
 */
export async function statesAt(
  tx: Executor,
  projectIds: readonly string[],
  ends: readonly Date[],
): Promise<Map<string, BranchState>[]> {
  const out = ends.map(() => new Map<string, BranchState>());
  if (projectIds.length === 0 || ends.length === 0) return out;
  const { rows } = await tx.execute<{
    i: number;
    project_id: string;
    analysis_id: string;
    gate_status: string | null;
  }>(sql`
    SELECT f.i::int AS i, b.project_id, a.id AS analysis_id, a.gate_status
      FROM unnest(${uuidArray(ends.map(uuidv7Floor))}) WITH ORDINALITY AS f(floor, i)
     CROSS JOIN branches b
      JOIN LATERAL (
        SELECT id, gate_status FROM analyses
         WHERE branch_id = b.id AND status = 'succeeded' AND id < f.floor
         ORDER BY id DESC LIMIT 1) a ON true
     WHERE b.is_main AND b.project_id = ANY(${uuidArray(projectIds)})`);
  for (const r of rows) {
    out[r.i - 1]?.set(r.project_id, { analysisId: r.analysis_id, gateStatus: r.gate_status });
  }
  return out;
}

/** The state measures of the analyses, by analysis id; a missing measure is absent. */
export async function measuresOf(
  tx: Executor,
  analysisIds: readonly string[],
): Promise<Map<string, MeasureValues>> {
  const out = new Map<string, MeasureValues>();
  if (analysisIds.length === 0) return out;
  const { rows } = await tx.execute<{
    analysis_id: string;
    metric_key: string;
    scope: 'overall' | 'new';
    value: number | null;
  }>(sql`
    SELECT analysis_id, metric_key, scope, value FROM measures
     WHERE analysis_id = ANY(${uuidArray(analysisIds)})
       AND ((scope = 'overall' AND metric_key = ANY(${sql.param([...STATE_METRICS])}::text[]))
         OR (scope = 'new' AND metric_key = 'issues'))`);
  for (const r of rows) {
    const values = out.get(r.analysis_id) ?? {};
    const key = (r.scope === 'new' ? `new_${r.metric_key}` : r.metric_key) as StateMetric;
    values[key] = r.value === null ? null : Number(r.value);
    out.set(r.analysis_id, values);
  }
  return out;
}

/** §1 current-only facts: open, not duplicate issues of `gitleaks` and `trivy` on main branches. */
export async function currentFindings(
  tx: Executor,
  projectIds: readonly string[],
): Promise<Map<string, { secrets: number; vulnerableDependencies: number }>> {
  const out = new Map<string, { secrets: number; vulnerableDependencies: number }>();
  if (projectIds.length === 0) return out;
  const { rows } = await tx.execute<{ project_id: string; engine_id: string; count: number }>(sql`
    SELECT b.project_id, r.engine_id, count(*)::int AS count
      FROM branches b
      JOIN issues i ON i.branch_id = b.id
      JOIN rules r ON r.id = i.rule_id
     WHERE b.is_main AND b.project_id = ANY(${uuidArray(projectIds)})
       AND i.status = 'open' AND i.duplicate_of_issue_id IS NULL
       AND r.engine_id IN ('gitleaks', 'trivy')
     GROUP BY b.project_id, r.engine_id`);
  for (const r of rows) {
    const counts = out.get(r.project_id) ?? { secrets: 0, vulnerableDependencies: 0 };
    if (r.engine_id === 'gitleaks') counts.secrets = r.count;
    else counts.vulnerableDependencies = r.count;
    out.set(r.project_id, counts);
  }
  return out;
}

/**
 * §1 activity per period. `bounds` are the periods' starts and then the last one's end (n + 1
 * times for n periods); each count is per period, oldest first:
 * - `analyses`: succeeded analyses of any branch, uploaded in the period (by id);
 * - `triage`: status changes to false_positive or wont_fix, created in the period.
 */
export async function activity(
  tx: Executor,
  projectIds: readonly string[],
  bounds: readonly Date[],
): Promise<{ analyses: number[]; triage: number[] }> {
  const count = Math.max(bounds.length - 1, 0);
  const analysesOut = Array<number>(count).fill(0);
  const triageOut = Array<number>(count).fill(0);
  if (projectIds.length === 0 || count === 0) {
    return { analyses: analysesOut, triage: triageOut };
  }
  const floors = bounds.map(uuidv7Floor);
  const times = bounds.map((b) => b.toISOString());
  const ids = uuidArray(projectIds);
  const ran = await tx.execute<{ bucket: number; count: number }>(sql`
    SELECT width_bucket(a.id, ${uuidArray(floors)}) AS bucket, count(*)::int AS count
      FROM analyses a
     WHERE a.project_id = ANY(${ids}) AND a.status = 'succeeded'
       AND a.id >= ${floors[0]}::uuid AND a.id < ${floors[count]}::uuid
     GROUP BY 1`);
  const triaged = await tx.execute<{ bucket: number; count: number }>(sql`
    SELECT width_bucket(c.created_at, ${sql.param(times)}::timestamptz[]) AS bucket,
           count(*)::int AS count
      FROM issue_changes c
      JOIN issues i ON i.id = c.issue_id
     WHERE i.project_id = ANY(${ids})
       AND c.field = 'status' AND c.new_value IN ('false_positive', 'wont_fix')
       AND c.created_at >= ${times[0]}::timestamptz AND c.created_at < ${times[count]}::timestamptz
     GROUP BY 1`);
  // width_bucket numbers [bounds[k-1], bounds[k]) as k.
  for (const r of ran.rows) analysesOut[r.bucket - 1] = r.count;
  for (const r of triaged.rows) triageOut[r.bucket - 1] = r.count;
  return { analyses: analysesOut, triage: triageOut };
}

/** The organisation of the organisation scope, for the overview's `scope`. */
export async function organizationOf(
  tx: Executor,
  organizationId: string,
): Promise<{ id: string; key: string; name: string } | null> {
  const [row] = await tx
    .select({ id: organizations.id, key: organizations.key, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row ?? null;
}

/** The transaction's `now()`: the overview's `generatedAt`. */
export async function transactionNow(tx: Executor): Promise<Date> {
  const { rows } = await tx.execute<{ now: Date | string }>(sql`SELECT now() AS now`);
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('now() returned no row');
  return new Date(now);
}
