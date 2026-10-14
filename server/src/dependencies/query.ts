import { LICENSE_GROUPS, type LicenseGroupId } from '@qualor/shared';
import { and, asc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { analyses, branchDependencies } from '../db/schema';
import { containsPattern } from '../issues/query';

/** The filters of the inventory list (6M §8). Every filter narrows; none means the whole list. */
export interface DependencyFilter {
  /** Entries that carry this licence string as one of their licences (exact match). */
  license?: string;
  /** Entries with a licence string that is one of the group's members. */
  group?: LicenseGroupId;
  ecosystem?: string;
  /** `true`: no licence known; `false`: at least one. */
  unknown?: boolean;
  /** `true`: direct dependencies; `false`: the others (transitive, or not known to be direct). */
  direct?: boolean;
  /** A case-insensitive substring of the package name. */
  q?: string;
}

export interface DependencyPage {
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** One inventory entry as the API returns it. */
export interface DependencyRow {
  ecosystem: string;
  path: string;
  line: number | null;
  name: string;
  version: string;
  licenses: string[];
  direct: boolean | null;
}

export interface DependencySummary {
  total: number;
  /** Entries with at least one licence. */
  known: number;
  /** Entries without a licence (`licenses = {}`). */
  unknown: number;
  /** The most frequent licence strings, at most {@link SUMMARY_LICENSES}, by count then name. */
  byLicense: { license: string; count: number }[];
}

export const SUMMARY_LICENSES = 20;

/** The CLI's engine entry for its licence pass (cli/src/analyzers/trivy-licenses.ts). */
const LICENSE_ENGINE_ID = 'trivy-licenses';

const GROUP_MEMBERS = new Map<LicenseGroupId, readonly string[]>(
  LICENSE_GROUPS.map((g) => [g.id, g.members]),
);

function textArray(values: readonly string[]): SQL {
  return sql`(SELECT coalesce(array_agg(v), '{}'::text[]) FROM jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) AS v)`;
}

function dependencyFilter(branchId: string, f: DependencyFilter): SQL | undefined {
  const d = branchDependencies;
  return and(
    eq(d.branchId, branchId),
    f.license === undefined ? undefined : sql`${d.licenses} @> ARRAY[${f.license}]::text[]`,
    f.group === undefined
      ? undefined
      : sql`${d.licenses} && ${textArray(GROUP_MEMBERS.get(f.group) ?? [])}`,
    f.ecosystem === undefined ? undefined : eq(d.ecosystem, f.ecosystem),
    f.unknown === undefined
      ? undefined
      : f.unknown
        ? sql`cardinality(${d.licenses}) = 0`
        : sql`cardinality(${d.licenses}) > 0`,
    f.direct === undefined
      ? undefined
      : f.direct
        ? sql`${d.direct} IS TRUE`
        : sql`${d.direct} IS NOT TRUE`,
    f.q === undefined ? undefined : ilike(d.name, containsPattern(f.q)),
  );
}

function selectRows(db: Executor, where: SQL | undefined) {
  const d = branchDependencies;
  return db
    .select({
      ecosystem: d.ecosystem,
      path: d.path,
      line: d.line,
      name: d.name,
      version: d.version,
      licenses: d.licenses,
      direct: d.direct,
    })
    .from(d)
    .where(where)
    .orderBy(asc(d.name), asc(d.version), asc(d.path), asc(d.ecosystem));
}

/** One page of a branch's inventory, by name, version, lockfile and ecosystem, and the filtered total. */
export async function listDependencies(
  db: Executor,
  branchId: string,
  filter: DependencyFilter,
  page: DependencyPage,
): Promise<{ rows: DependencyRow[]; total: number }> {
  const d = branchDependencies;
  const where = dependencyFilter(branchId, filter);
  const [rows, [count]] = await Promise.all([
    selectRows(db, where)
      .limit(page.pageSize)
      .offset((page.page - 1) * page.pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(d)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Every entry of a branch's inventory that matches `filter`, in the list's order: for a filter
 * SQL cannot apply (the licence policy's verdict). A snapshot holds at most 50 000 entries.
 */
export async function listAllDependencies(
  db: Executor,
  branchId: string,
  filter: DependencyFilter,
): Promise<DependencyRow[]> {
  return selectRows(db, dependencyFilter(branchId, filter));
}

/** The whole inventory of a branch at a glance; filters do not apply. */
export async function dependencySummary(
  db: Executor,
  branchId: string,
): Promise<DependencySummary> {
  const d = branchDependencies;
  const [[counts], byLicense] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        unknown: sql<number>`count(*) FILTER (WHERE cardinality(${d.licenses}) = 0)::int`,
      })
      .from(d)
      .where(eq(d.branchId, branchId)),
    db.execute<{ license: string; count: number }>(sql`
      SELECT l.license, count(*)::int AS count
      FROM ${d}, unnest(${d.licenses}) AS l(license)
      WHERE ${d.branchId} = ${branchId}
      GROUP BY l.license
      ORDER BY count DESC, l.license
      LIMIT ${SUMMARY_LICENSES}`),
  ]);
  const total = counts?.total ?? 0;
  const unknown = counts?.unknown ?? 0;
  return {
    total,
    known: total - unknown,
    unknown,
    byLicense: byLicense.rows.map((r) => ({ license: r.license, count: r.count })),
  };
}

/**
 * Whether the branch has an inventory snapshot. Rows prove it; without rows, the latest snapshot
 * may still be an empty one: a succeeded analysis of the branch whose licence pass completed
 * (its `trivy-licenses` engine is `ok`, which is when the report carries `dependencies`).
 */
export async function hasInventory(
  db: Executor,
  branchId: string,
  rowCount: number,
): Promise<boolean> {
  if (rowCount > 0) return true;
  const [row] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(
      and(
        eq(analyses.branchId, branchId),
        eq(analyses.status, 'succeeded'),
        sql`${analyses.engines} @> ${JSON.stringify([{ id: LICENSE_ENGINE_ID, status: 'ok' }])}::jsonb`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
