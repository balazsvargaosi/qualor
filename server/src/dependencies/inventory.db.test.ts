import { and, asc, eq } from 'drizzle-orm';
import type { DependencyEntry, Report } from '@qualor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { reportWith, type ReportParts } from '../../test/reports';
import { branchDependencies, branches } from '../db/schema';

/**
 * 6M §4: the dependency inventory of a branch is the latest report's `dependencies`, replaced in
 * the measures stage's transaction. A report without the field (an older CLI, a disabled pass)
 * keeps the previous snapshot; an empty array clears it.
 */
describe('the branch dependency inventory (6M)', () => {
  let h: IngestHarness;
  let minute = 0;
  const report = (p: IngestProject, parts: ReportParts): Report =>
    reportWith({
      projectKey: p.key,
      analysisDate: new Date(Date.UTC(2026, 9, 14, 10, minute++)).toISOString(),
      ...parts,
    });
  const dep = (name: string, overrides: Partial<DependencyEntry> = {}): DependencyEntry => ({
    ecosystem: 'npm',
    path: 'package-lock.json',
    name,
    version: '1.0.0',
    licenses: ['MIT'],
    ...overrides,
  });
  const branchOf = async (p: IngestProject, kind: 'branch' | 'merge_request') => {
    const [row] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, p.id), eq(branches.kind, kind)));
    return row!;
  };
  const inventory = (branchId: string) =>
    h.ctx.db
      .select()
      .from(branchDependencies)
      .where(eq(branchDependencies.branchId, branchId))
      .orderBy(asc(branchDependencies.name), asc(branchDependencies.version));

  beforeAll(async () => {
    h = await createIngestHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('stores the entries as given, replaces them, keeps them without the field and clears them on []', async () => {
    const p = await h.project('deps/inventory');
    const first = await p.ingestOk(
      report(p, {
        dependencies: [
          dep('lodash', { line: 12, direct: true }),
          dep('gpl-thing', { version: '2.0.0', licenses: ['GPL-3.0-only', 'MIT OR Apache-2.0'] }),
          dep('mystery', { path: 'vendor/go.sum', ecosystem: 'gomod', licenses: [] }),
        ],
      }),
    );
    const main = await branchOf(p, 'branch');
    expect(await inventory(main.id)).toEqual([
      {
        branchId: main.id,
        path: 'package-lock.json',
        ecosystem: 'npm',
        name: 'gpl-thing',
        version: '2.0.0',
        licenses: ['GPL-3.0-only', 'MIT OR Apache-2.0'],
        direct: null,
        line: null,
        analysisId: first,
      },
      {
        branchId: main.id,
        path: 'package-lock.json',
        ecosystem: 'npm',
        name: 'lodash',
        version: '1.0.0',
        licenses: ['MIT'],
        direct: true,
        line: 12,
        analysisId: first,
      },
      {
        branchId: main.id,
        path: 'vendor/go.sum',
        ecosystem: 'gomod',
        name: 'mystery',
        version: '1.0.0',
        licenses: [],
        direct: null,
        line: null,
        analysisId: first,
      },
    ]);

    const second = await p.ingestOk(report(p, { dependencies: [dep('left-pad')] }));
    expect((await inventory(main.id)).map((r) => [r.name, r.analysisId])).toEqual([
      ['left-pad', second],
    ]);

    await p.ingestOk(report(p, {}));
    expect((await inventory(main.id)).map((r) => [r.name, r.analysisId])).toEqual([
      ['left-pad', second],
    ]);

    await p.ingestOk(report(p, { dependencies: [] }));
    expect(await inventory(main.id)).toEqual([]);
  });

  it('merges duplicate keys, also keys equal once NUL is stripped, instead of failing the analysis', async () => {
    const p = await h.project('deps/duplicates');
    const analysisId = await p.ingestOk(
      report(p, {
        dependencies: [
          dep('dup', { licenses: ['MIT'], line: 5 }),
          dep('dup', { licenses: ['Apache-2.0', 'MIT'], direct: true, line: 9 }),
          dep('nul', { licenses: ['ISC'], direct: false }),
          dep('n\u0000ul', { licenses: ['BSD-3-Clause'], line: 3 }),
        ],
      }),
    );
    const main = await branchOf(p, 'branch');
    expect(await inventory(main.id)).toEqual([
      {
        branchId: main.id,
        path: 'package-lock.json',
        ecosystem: 'npm',
        name: 'dup',
        version: '1.0.0',
        licenses: ['Apache-2.0', 'MIT'],
        direct: true,
        line: 5,
        analysisId,
      },
      {
        branchId: main.id,
        path: 'package-lock.json',
        ecosystem: 'npm',
        name: 'nul',
        version: '1.0.0',
        licenses: ['BSD-3-Clause', 'ISC'],
        direct: false,
        line: 3,
        analysisId,
      },
    ]);
  });

  it('writes a large inventory in batches', async () => {
    const p = await h.project('deps/large');
    const entries = Array.from({ length: 2_345 }, (_, i) => dep(`pkg-${i}`));
    await p.ingestOk(report(p, { dependencies: entries }));
    const main = await branchOf(p, 'branch');
    expect(await inventory(main.id)).toHaveLength(2_345);
  });

  it('gives a merge request its own snapshot, deleted with the merge request', async () => {
    const p = await h.project('deps/mr');
    await p.ingestOk(report(p, { dependencies: [dep('on-main')] }));
    await p.ingestOk(
      report(p, {
        branch: 'feature',
        mergeRequest: { id: '7', sourceBranch: 'feature', targetBranch: 'main' },
        dependencies: [dep('on-main'), dep('added-by-mr')],
      }),
    );
    const main = await branchOf(p, 'branch');
    const mr = await branchOf(p, 'merge_request');
    expect((await inventory(main.id)).map((r) => r.name)).toEqual(['on-main']);
    expect((await inventory(mr.id)).map((r) => r.name)).toEqual(['added-by-mr', 'on-main']);

    const res = await h.ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/branches/${mr.id}`,
      headers: h.orgAdmin.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(await inventory(mr.id)).toEqual([]);
    expect((await inventory(main.id)).map((r) => r.name)).toEqual(['on-main']);
  });
});
