import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../../test/db';
import { PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION } from '../db/errors';
import { complianceReports, organizations, projects } from '../db/schema';

describe('compliance_reports (4E-1 §1)', () => {
  let tdb: TestDatabase;
  let org: string;
  let project: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const [o] = await tdb.db
      .insert(organizations)
      .values({ key: 'acme', name: 'Acme' })
      .returning();
    org = o!.id;
    const [p] = await tdb.db
      .insert(projects)
      .values({ organizationId: org, key: 'alpha', name: 'Alpha' })
      .returning();
    project = p!.id;
  });
  afterAll(() => tdb.close());

  const row = (over: Partial<typeof complianceReports.$inferInsert> = {}) => ({
    organizationId: org,
    scope: 'organization' as const,
    createdByName: 'Admin',
    standards: [],
    ...over,
  });

  it('allows one pending report per scope', async () => {
    await tdb.db.insert(complianceReports).values(row());
    expect(await sqlStateOf(tdb.db.insert(complianceReports).values(row()))).toBe(
      PG_UNIQUE_VIOLATION,
    );
    // a project scope of the same organisation is another scope
    await tdb.db.insert(complianceReports).values(row({ scope: 'project', projectId: project }));
    expect(
      await sqlStateOf(
        tdb.db.insert(complianceReports).values(row({ scope: 'project', projectId: project })),
      ),
    ).toBe(PG_UNIQUE_VIOLATION);
  });

  it('allows several finished reports per scope', async () => {
    await tdb.db.execute(sql`UPDATE compliance_reports SET status = 'failed', error = 'x'`);
    await tdb.db.insert(complianceReports).values(row());
    await tdb.db.execute(sql`UPDATE compliance_reports SET status = 'failed', error = 'x'`);
    await tdb.db.insert(complianceReports).values(row());
    const [{ n }] = (await tdb.db.execute(sql`SELECT count(*)::int AS n FROM compliance_reports`))
      .rows as [{ n: number }];
    expect(n).toBe(4);
  });

  it('checks scope against project_id, the status, and what ready needs', async () => {
    expect(
      await sqlStateOf(tdb.db.insert(complianceReports).values(row({ scope: 'project' }))),
    ).toBe(PG_CHECK_VIOLATION);
    expect(
      await sqlStateOf(tdb.db.insert(complianceReports).values(row({ projectId: project }))),
    ).toBe(PG_CHECK_VIOLATION);
    expect(
      await sqlStateOf(tdb.db.insert(complianceReports).values(row({ status: 'ready' }))),
    ).toBe(PG_CHECK_VIOLATION);
    expect(
      await sqlStateOf(
        tdb.db.insert(complianceReports).values(row({ status: 'failed', sha256: 'XYZ' })),
      ),
    ).toBe(PG_CHECK_VIOLATION);
  });

  it('is deleted with its project', async () => {
    await tdb.db.execute(sql`DELETE FROM projects WHERE id = ${project}`);
    const [{ n }] = (
      await tdb.db.execute(
        sql`SELECT count(*)::int AS n FROM compliance_reports WHERE project_id IS NOT NULL`,
      )
    ).rows as [{ n: number }];
    expect(n).toBe(0);
  });
});
