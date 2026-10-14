import { and, eq } from 'drizzle-orm';
import type { DependencyEntry, Report } from '@qualor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createUser, login, type Session } from '../../test/app';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { engine, file, finding, reportWith, type ReportParts } from '../../test/reports';
import { branches } from '../db/schema';

/** 6M §8: the community dependency inventory API, `GET /projects/{key}/dependencies`. */
describe('GET /projects/{key}/dependencies (6M)', () => {
  let h: IngestHarness;
  let p: IngestProject;
  let minute = 0;
  const report = (project: IngestProject, parts: ReportParts): Report =>
    reportWith({
      projectKey: project.key,
      analysisDate: new Date(Date.UTC(2026, 9, 14, 11, minute++)).toISOString(),
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
  const get = (url: string, session: Session | null = h.orgAdmin) =>
    h.ctx.app.inject({
      method: 'GET',
      url: `/api/v0${url}`,
      ...(session === null ? {} : { headers: session.headers }),
    });
  const url = (project: IngestProject, query = '') =>
    `/projects/${encodeURIComponent(project.key)}/dependencies${query === '' ? '' : `?${query}`}`;
  const names = async (query: string) => {
    const res = await get(url(p, query));
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { rows: { name: string }[] }).rows.map((r) => r.name);
  };

  const MAIN = [
    dep('lodash', { version: '4.17.21', line: 10, direct: true }),
    dep('gpl-lib', { licenses: ['GPL-3.0-only'], direct: false }),
    dep('agpl-db', { version: '2.0.0', licenses: ['AGPL-3.0-only'] }),
    dep('dual', { licenses: ['MIT OR Apache-2.0'] }),
    dep('mystery', { version: '0.1.0', ecosystem: 'gomod', path: 'go.sum', licenses: [] }),
    dep('classpath', {
      ecosystem: 'maven',
      path: 'pom.xml',
      licenses: ['GPL-2.0-only WITH Classpath-exception-2.0'],
    }),
    dep('apache-lib', {
      version: '3.0.0',
      ecosystem: 'maven',
      path: 'pom.xml',
      licenses: ['Apache-2.0', 'MIT'],
    }),
  ];

  beforeAll(async () => {
    h = await createIngestHarness();
    p = await h.project('deps/route');
    await p.ingestOk(report(p, { dependencies: MAIN }));
    await p.ingestOk(
      report(p, {
        branch: 'feature',
        mergeRequest: { id: '7', sourceBranch: 'feature', targetBranch: 'main' },
        dependencies: [dep('only-in-mr', { licenses: ['BSD-3-Clause'] })],
      }),
    );
  });
  afterAll(async () => {
    await h.close();
  });

  it('lists the main branch inventory in name order with its summary', async () => {
    const res = await get(url(p));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ page: 1, pageSize: 50, total: 7, inventory: true });
    expect(body.rows.map((r: { name: string }) => r.name)).toEqual([
      'agpl-db',
      'apache-lib',
      'classpath',
      'dual',
      'gpl-lib',
      'lodash',
      'mystery',
    ]);
    expect(body.rows[5]).toEqual({
      ecosystem: 'npm',
      path: 'package-lock.json',
      line: 10,
      name: 'lodash',
      version: '4.17.21',
      licenses: ['MIT'],
      direct: true,
    });
    expect(body.rows[0]).toMatchObject({ name: 'agpl-db', line: null, direct: null });
    expect(body.summary).toEqual({
      total: 7,
      known: 6,
      unknown: 1,
      byLicense: [
        { license: 'MIT', count: 2 },
        { license: 'AGPL-3.0-only', count: 1 },
        { license: 'Apache-2.0', count: 1 },
        { license: 'GPL-2.0-only WITH Classpath-exception-2.0', count: 1 },
        { license: 'GPL-3.0-only', count: 1 },
        { license: 'MIT OR Apache-2.0', count: 1 },
      ],
    });
    expect((await get(url(p, 'branch=main'))).json()).toEqual(body);
  });

  it('filters by licence, group, ecosystem, unknown, direct and text', async () => {
    expect(await names('license=MIT')).toEqual(['apache-lib', 'lodash']);
    expect(await names('group=strong-copyleft')).toEqual(['gpl-lib']);
    expect(await names('group=weak-copyleft')).toEqual(['classpath']);
    expect(await names('group=network-copyleft')).toEqual(['agpl-db']);
    expect(await names('group=non-commercial-or-source-available')).toEqual([]);
    expect(await names('ecosystem=maven')).toEqual(['apache-lib', 'classpath']);
    expect(await names('unknown=true')).toEqual(['mystery']);
    expect(await names('unknown=false')).toHaveLength(6);
    expect(await names('direct=true')).toEqual(['lodash']);
    expect(await names('direct=false')).toHaveLength(6);
    expect(await names('q=LIB')).toEqual(['apache-lib', 'gpl-lib']);
    expect(await names('q=100%25')).toEqual([]);
    expect(await names('ecosystem=npm&direct=false&license=MIT')).toEqual([]);

    const filtered = (await get(url(p, 'ecosystem=maven'))).json();
    expect(filtered.total).toBe(2);
    // The summary describes the whole inventory, whatever the filters.
    expect(filtered.summary).toMatchObject({ total: 7, known: 6, unknown: 1 });
  });

  it('pages with page and pageSize', async () => {
    const second = (await get(url(p, 'page=2&pageSize=2'))).json();
    expect(second).toMatchObject({ page: 2, pageSize: 2, total: 7 });
    expect(second.rows.map((r: { name: string }) => r.name)).toEqual(['classpath', 'dual']);
    expect(await names('page=4&pageSize=2')).toEqual(['mystery']);
    expect(await names('page=5&pageSize=2')).toEqual([]);
  });

  it('answers a merge request’s own snapshot', async () => {
    const res = (await get(url(p, 'mr=7'))).json();
    expect(res.rows.map((r: { name: string }) => r.name)).toEqual(['only-in-mr']);
    expect(res.summary).toEqual({
      total: 1,
      known: 1,
      unknown: 0,
      byLicense: [{ license: 'BSD-3-Clause', count: 1 }],
    });
  });

  it('validates the query (422)', async () => {
    for (const query of [
      'branch=main&mr=7',
      'group=permissive',
      'pageSize=501',
      'page=0',
      'unknown=yes',
      'ecosystem=NPM',
      'mr=abc',
      'license=a%00b',
      'extra=1',
    ]) {
      expect((await get(url(p, query))).statusCode, query).toBe(422);
    }
  });

  it('answers 404 for an unknown project, branch or merge request', async () => {
    expect((await get('/projects/no-such-project/dependencies')).statusCode).toBe(404);
    expect((await get(url(p, 'branch=nope'))).statusCode).toBe(404);
    expect((await get(url(p, 'mr=99'))).statusCode).toBe(404);
    // A merge request is not found by its name as a branch.
    expect((await get(url(p, 'branch=7'))).statusCode).toBe(404);
  });

  it('says inventory: false until a report carried one, and true for an empty one', async () => {
    const fresh = await h.project('deps/fresh');
    const empty = {
      rows: [],
      page: 1,
      pageSize: 50,
      total: 0,
      summary: { total: 0, known: 0, unknown: 0, byLicense: [] },
      inventory: false,
    };
    // No analysis yet: there is no main branch row.
    expect((await get(url(fresh))).json()).toEqual(empty);
    // An analysis without the field (an older CLI, a disabled pass).
    await fresh.ingestOk(report(fresh, {}));
    expect((await get(url(fresh))).json()).toEqual(empty);

    // The licence pass ran and found no dependencies.
    const sampleEngines = report(fresh, {}).engines;
    await fresh.ingestOk(
      report(fresh, {
        engines: [...sampleEngines, engine('trivy-licenses')],
        dependencies: [],
      }),
    );
    expect((await get(url(fresh))).json()).toEqual({ ...empty, inventory: true });
  });

  it('needs project.read: 401 without a session, 404 outside the organisation, 200 for a viewer', async () => {
    expect((await get(url(p), null)).statusCode).toBe(401);

    const outsider = await createUser(h.ctx, { username: 'deps-outsider' });
    const outsiderSession = await login(h.ctx, outsider.username, outsider.password);
    expect((await get(url(p), outsiderSession)).statusCode).toBe(404);

    const viewer = await createUser(h.ctx, { username: 'deps-viewer' });
    await addMember(h.ctx, h.organizationId, viewer.id, 'viewer');
    const viewerSession = await login(h.ctx, viewer.username, viewer.password);
    expect((await get(url(p), viewerSession)).statusCode).toBe(200);
  });
});

/** 6M: the `licensing` quality is accepted by the rules and issues CHECKs and the issue filters. */
describe('the licensing quality (6M)', () => {
  let h: IngestHarness;

  beforeAll(async () => {
    h = await createIngestHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('stores a licensing issue and filters and facets by quality=licensing', async () => {
    const p = await h.project('deps/quality');
    await p.ingestOk(
      reportWith({
        projectKey: p.key,
        engines: [
          engine('acme-licenses', [
            { id: 'forbidden', quality: 'licensing', kind: 'issue', defaultSeverity: 'high' },
          ]),
        ],
        files: [file('package-lock.json', { language: 'other', lines: 20 })],
        findings: [
          finding({ engineId: 'acme-licenses', ruleId: 'forbidden', path: 'package-lock.json' }),
        ],
      }),
    );
    const [main] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, p.id), eq(branches.isMain, true)));
    const res = await h.ctx.app.inject({
      method: 'GET',
      url: `/api/v0/issues?branchId=${main!.id}&quality=licensing&facets=quality`,
      headers: h.orgAdmin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { quality: string }) => i.quality)).toEqual(['licensing']);
    expect(body.facets.quality).toEqual([{ value: 'licensing', count: 1 }]);

    const rules = await h.ctx.app.inject({
      method: 'GET',
      url: `/api/v0/rules?organizationId=${h.organizationId}&quality=licensing`,
      headers: h.orgAdmin.headers,
    });
    expect(rules.statusCode, rules.body).toBe(200);
    expect(rules.json().items.map((r: { key: string }) => r.key)).toEqual([
      'acme-licenses:forbidden',
    ]);
  });
});
