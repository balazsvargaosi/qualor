import { asc, eq } from 'drizzle-orm';
import type { Report } from '@qualor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { mainBranchId } from '../../test/issues';
import { engine, file, finding, reportWith, type ReportParts } from '../../test/reports';
import { issues } from '../db/schema';

/**
 * 6B-C# engine spec R-9: the confidence of Qualor's C# taint engine (`properties.confidence` of
 * its findings) is stored with the issue, follows it from analysis to analysis, and is returned by
 * the issue list, the issue detail and the file page; every other finding has none (null).
 */
describe('issue confidence (R-9)', () => {
  let h: IngestHarness;
  let minute = 0;
  const report = (p: IngestProject, parts: ReportParts): Report =>
    reportWith({
      projectKey: p.key,
      analysisDate: new Date(Date.UTC(2026, 9, 14, 10, minute++)).toISOString(),
      ...parts,
    });
  const qualor = engine('qualor', [
    { id: 'csharp/sql-injection', name: 'SQL injection', quality: 'security' },
  ]);
  const taint = (line: number, confidence?: 'high' | 'medium') =>
    finding({
      engineId: 'qualor',
      ruleId: 'csharp/sql-injection',
      path: 'src/A.cs',
      line,
      ...(confidence !== undefined && { properties: { confidence } }),
    });
  const parts = (findings: Report['findings']): ReportParts => ({
    engines: [engine('eslint'), qualor],
    files: [file('src/A.cs', { language: 'csharp' }), file('src/a.ts')],
    findings,
  });
  const get = (url: string) =>
    h.ctx.app.inject({ method: 'GET', url: `/api/v0${url}`, headers: h.orgAdmin.headers });

  beforeAll(async () => {
    h = await createIngestHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('stores the engine confidence, null for OpenGrep and other analyzers, and returns it', async () => {
    const p = await h.project('confidence/api');
    await p.ingestOk(
      report(
        p,
        parts([
          taint(3, 'medium'),
          taint(5, 'high'),
          taint(7),
          finding({ line: 2, properties: { confidence: 'medium' } }),
        ]),
      ),
    );
    const rows = await h.ctx.db
      .select({ path: issues.path, line: issues.startLine, confidence: issues.confidence })
      .from(issues)
      .where(eq(issues.projectId, p.id))
      .orderBy(asc(issues.path), asc(issues.startLine));
    expect(rows).toEqual([
      { path: 'src/A.cs', line: 3, confidence: 'medium' },
      { path: 'src/A.cs', line: 5, confidence: 'high' },
      { path: 'src/A.cs', line: 7, confidence: null },
      { path: 'src/a.ts', line: 2, confidence: null },
    ]);

    const branchId = await mainBranchId(h.ctx.db, p.id);
    const list = await get(`/issues?branchId=${branchId}`);
    expect(list.statusCode, list.body).toBe(200);
    const items = (
      list.json() as { items: { id: string; startLine: number; confidence: string | null }[] }
    ).items;
    expect(
      Object.fromEntries(items.map((i) => [i.startLine, i.confidence])) as Record<string, unknown>,
    ).toEqual({ 2: null, 3: 'medium', 5: 'high', 7: null });

    const possible = items.find((i) => i.startLine === 3)!;
    const detail = await get(`/issues/${possible.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as { confidence: string | null }).confidence).toBe('medium');

    const page = await get(`/branches/${branchId}/file?path=src/A.cs`);
    expect(page.statusCode, page.body).toBe(200);
    expect(
      (page.json() as { issues: { startLine: number; confidence: string | null }[] }).issues.map(
        (i) => [i.startLine, i.confidence],
      ),
    ).toEqual([
      [3, 'medium'],
      [5, 'high'],
      [7, null],
    ]);
  });

  it('follows the latest analysis: a possible finding the engine now reports with high confidence is high', async () => {
    const p = await h.project('confidence/tracked');
    await p.ingestOk(report(p, parts([taint(3, 'medium')])));
    const [before] = await h.ctx.db.select().from(issues).where(eq(issues.projectId, p.id));
    await p.ingestOk(report(p, parts([taint(3, 'high')])));
    const after = await h.ctx.db.select().from(issues).where(eq(issues.projectId, p.id));
    expect(after.map((i) => [i.id, i.confidence])).toEqual([[before!.id, 'high']]);
  });
});
