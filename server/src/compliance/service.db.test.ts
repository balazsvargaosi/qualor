import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  addMember,
  createProject,
  createUser,
  login,
  type Session,
  type TestContext,
} from '../../test/app';
import { mainBranchId } from '../../test/issues';
import { AFTER_GRACE, grantProject, rbacContext } from '../../test/rbac';
import { analyses, auditEvents, branches, complianceReports, projects } from '../db/schema';
import type { ComplianceReportView, PluginCompliance, QualorPlugin } from '../plugins/contract';

const LICENSED = new Date('2027-01-01T00:00:00Z');
const STANDARDS = [{ id: 'cwe-top25-2025', version: '2025', sourceSha256: 'a'.repeat(64) }];
const CANONICAL = '{"a":1}';
const SHA = createHash('sha256').update(CANONICAL).digest('hex');

/** The service the plugin's context holds: the routes below and the job-side calls use it. */
let compliance: PluginCompliance;

const FIXTURE: QualorPlugin = {
  name: 'compliance-fixture',
  apiVersion: 1,
  features: ['compliance-export', 'audit-log'],
  register(ctx) {
    compliance = ctx.compliance;
    ctx.routes('compliance-export', async (app) => {
      app.post('/t/reports', async (req, reply) =>
        reply.code(202).send(await ctx.compliance.create(req, req.body as never, STANDARDS)),
      );
      app.get('/t/reports', async (req) => {
        const { limit, cursor, ...filter } = req.query as Record<string, string>;
        return ctx.compliance.list(req, filter as never, {
          limit: limit === undefined ? 100 : Number(limit),
          ...(cursor === undefined ? {} : { cursor }),
        });
      });
      app.get('/t/reports/:id', async (req) =>
        ctx.compliance.get(req, (req.params as { id: string }).id),
      );
      app.get('/t/reports/:id/download', async (req) => {
        const r = await ctx.compliance.download(req, (req.params as { id: string }).id, 'json');
        return { sha256: r.view.sha256, text: r.canonical.toString('utf8') };
      });
      app.delete('/t/reports/:id', async (req, reply) => {
        await ctx.compliance.remove(req, (req.params as { id: string }).id);
        return reply.code(204).send();
      });
    });
  },
};

describe('ctx.compliance (4E-1 §1.1, §2.4, §3)', () => {
  let now = LICENSED;
  let ctx: TestContext;
  let root: Session;
  let orgAdmin: Session;
  let projAdmin: Session;
  let member: Session;
  let viewer: Session;
  let grantOnly: Session;
  let outsider: Session;
  let org: string;
  let app: { id: string; key: string };
  let foreignBranch: string;
  let mrBranch: string;
  let orgReport: string;
  let projReport: string;
  let pendingOrg: string;
  let oversized: string;

  const post = (session: Session, payload: object) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v0/ee/t/reports',
      headers: session.headers,
      payload,
    });
  const get = (session: Session, url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v0/ee/t/reports${url}`, headers: session.headers });
  const del = (session: Session, id: string) =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/ee/t/reports/${id}`,
      headers: session.headers,
    });
  const auditOf = (action: string) =>
    ctx.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const statusOf = async (id: string) => {
    const [row] = await ctx.db
      .select({ status: complianceReports.status, error: complianceReports.error })
      .from(complianceReports)
      .where(eq(complianceReports.id, id));
    return row;
  };
  const succeededAnalysis = async (projectId: string) => {
    await ctx.db.insert(analyses).values({
      projectId,
      branchId: await mainBranchId(ctx.db, projectId),
      status: 'succeeded',
      revision: 'a'.repeat(40),
      baselineStatus: 'ok',
      scannerVersion: '1.0.0',
      analysisDate: new Date('2026-10-01T00:00:00Z'),
    });
  };
  const complete = (id: string) =>
    compliance.complete(id, { canonical: Buffer.from(CANONICAL), sha256: SHA, summary: { s: 1 } });

  beforeAll(async () => {
    ctx = await rbacContext({
      now: () => now,
      features: ['compliance-export', 'audit-log'],
      plugin: FIXTURE,
    });
    expect(ctx.edition?.plugins()).toEqual([
      {
        name: 'compliance-fixture',
        state: 'loaded',
        features: ['compliance-export', 'audit-log'],
        error: null,
      },
    ]);
    root = await login(ctx, 'admin', ADMIN_PASSWORD);
    const newOrg = async (key: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v0/organizations',
        headers: root.headers,
        payload: { key, name: key },
      });
      expect(res.statusCode).toBe(201);
      return (res.json() as { id: string }).id;
    };
    org = await newOrg('org-a');
    const otherOrg = await newOrg('org-b');
    app = await createProject(ctx, root, { organizationId: org, key: 'app' });
    const foreign = await createProject(ctx, root, { organizationId: otherOrg, key: 'foreign' });
    foreignBranch = await mainBranchId(ctx.db, foreign.id);
    const [mr] = await ctx.db
      .insert(branches)
      .values({ projectId: app.id, kind: 'merge_request', name: '7' })
      .returning({ id: branches.id });
    mrBranch = mr!.id;
    const session = async (
      username: string,
      role?: 'admin' | 'project_admin' | 'member' | 'viewer',
    ) => {
      const user = await createUser(ctx, { username });
      if (role) await addMember(ctx, org, user.id, role);
      return { user, session: await login(ctx, user.username, user.password) };
    };
    orgAdmin = (await session('org-a-admin', 'admin')).session;
    projAdmin = (await session('org-a-padmin', 'project_admin')).session;
    member = (await session('org-a-member', 'member')).session;
    viewer = (await session('org-a-viewer', 'viewer')).session;
    const granted = await session('grant-only');
    await grantProject(ctx, app.id, granted.user.id, 'viewer');
    grantOnly = granted.session;
    outsider = (await session('outsider')).session;
  });
  afterAll(async () => ctx.close());

  it('creates an organisation report for an org admin, once while it is pending', async () => {
    const res = await post(orgAdmin, { organizationId: org });
    expect(res.statusCode, res.body).toBe(202);
    const view = res.json() as ComplianceReportView;
    expect(view).toMatchObject({
      scope: 'organization',
      status: 'pending',
      createdBy: 'org-a-admin',
      organization: { id: org, key: 'org-a', name: 'org-a' },
      project: null,
      branch: null,
      standards: STANDARDS,
      sha256: null,
      sizeBytes: null,
      error: null,
      summary: null,
      completedAt: null,
      canDelete: true,
    });
    orgReport = view.id;
    const again = await post(orgAdmin, { organizationId: org });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'REPORT_PENDING' });
    const events = await auditOf('compliance.report.created');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: org,
      organizationKey: 'org-a',
      projectId: null,
      targetType: 'compliance_report',
      targetId: orgReport,
      targetLabel: 'org-a',
      details: { scope: 'organization', branch: null },
    });
  });

  it('creates a project report for a project admin once the branch has an analysis', async () => {
    const early = await post(projAdmin, { projectId: app.id });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'NO_ANALYSIS' });
    await succeededAnalysis(app.id);
    const res = await post(projAdmin, { projectId: app.id });
    expect(res.statusCode, res.body).toBe(202);
    const view = res.json() as ComplianceReportView;
    expect(view).toMatchObject({
      scope: 'project',
      status: 'pending',
      createdBy: 'org-a-padmin',
      project: { id: app.id, key: 'app', name: 'app' },
      branch: { name: 'main' },
      // A project admin holds no org.compliance.manage.
      canDelete: false,
    });
    projReport = view.id;
    const [event] = (await auditOf('compliance.report.created')).filter(
      (e) => e.targetId === projReport,
    );
    expect(event).toMatchObject({
      projectId: app.id,
      projectKey: 'app',
      targetLabel: 'app',
      details: { scope: 'project', branch: 'main' },
    });
    for (const branchId of [foreignBranch, mrBranch]) {
      const wrong = await post(projAdmin, { projectId: app.id, branchId });
      expect(wrong.statusCode).toBe(404);
      expect(wrong.json()).toMatchObject({ code: 'NOT_FOUND', title: 'Branch not found' });
    }
  });

  it('refuses a member and a viewer with 403, and hides the scope from an outsider', async () => {
    const byMember = await post(member, { projectId: app.id });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json()).toMatchObject({ code: 'FORBIDDEN' });
    const byViewer = await post(viewer, { organizationId: org });
    expect(byViewer.statusCode).toBe(403);
    expect(byViewer.json()).toMatchObject({ code: 'FORBIDDEN' });
    for (const payload of [{ organizationId: org }, { projectId: app.id }]) {
      const hidden = await post(outsider, payload);
      expect(hidden.statusCode).toBe(404);
    }
  });

  it('completes a pending row once, and fails only a pending one', async () => {
    await expect(complete(orgReport)).resolves.toBe(true);
    const [row] = await ctx.db
      .select()
      .from(complianceReports)
      .where(eq(complianceReports.id, orgReport));
    expect(row).toMatchObject({ status: 'ready', sha256: SHA, sizeBytes: 7, summary: { s: 1 } });
    expect(row!.completedAt).toBeInstanceOf(Date);
    await expect(complete(orgReport)).resolves.toBe(false);
    await expect(compliance.fail(orgReport, 'late')).resolves.toBe(false);
    expect(await statusOf(orgReport)).toEqual({ status: 'ready', error: null });
  });

  it('downloads a ready report to whoever may read its scope, and records it', async () => {
    const res = await get(viewer, `/${orgReport}/download`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ sha256: SHA, text: CANONICAL });
    const events = await auditOf('compliance.report.downloaded');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: orgReport,
      organizationKey: 'org-a',
      details: { format: 'json', sha256: SHA },
    });
    // A project grant does not read the organisation's reports: it is not there for them.
    const hidden = await get(grantOnly, `/${orgReport}/download`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'NOT_FOUND', title: 'Report not found' });
    expect((await get(grantOnly, `/${orgReport}`)).statusCode).toBe(404);
    expect((await get(outsider, `/${orgReport}`)).statusCode).toBe(404);
    await expect(complete(projReport)).resolves.toBe(true);
    const own = await get(grantOnly, `/${projReport}/download`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({ sha256: SHA, text: CANONICAL });
    const view = (await get(grantOnly, `/${projReport}`)).json() as ComplianceReportView;
    expect(view).toMatchObject({ id: projReport, status: 'ready', canDelete: false });
  });

  it('answers 409 REPORT_NOT_READY to the download of a pending report', async () => {
    const res = await post(orgAdmin, { organizationId: org });
    expect(res.statusCode, res.body).toBe(202);
    pendingOrg = (res.json() as ComplianceReportView).id;
    const early = await get(viewer, `/${pendingOrg}/download`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'REPORT_NOT_READY' });
  });

  it('lists the organisation reports to its members only, newest first, without data', async () => {
    const refused = await get(grantOnly, `?organizationId=${org}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'FORBIDDEN' });
    const res = await get(viewer, `?organizationId=${org}`);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as { items: (ComplianceReportView & { data?: unknown })[] };
    expect(page.items.map((r) => r.id)).toEqual([pendingOrg, orgReport]);
    expect(page.items.every((r) => !('data' in r) && r.canDelete === false)).toBe(true);
    expect(res.json()).toMatchObject({ nextCursor: null });
    const admins = (await get(orgAdmin, `?organizationId=${org}`)).json() as {
      items: ComplianceReportView[];
    };
    expect(admins.items.every((r) => r.canDelete)).toBe(true);
    const projectList = await get(grantOnly, `?projectId=${app.id}`);
    expect(projectList.statusCode).toBe(200);
    expect(
      (projectList.json() as { items: ComplianceReportView[] }).items.map((r) => r.id),
    ).toEqual([projReport]);
    const first = (await get(viewer, `?organizationId=${org}&limit=1`)).json() as {
      items: ComplianceReportView[];
      nextCursor: string | null;
    };
    expect(first.items.map((r) => r.id)).toEqual([pendingOrg]);
    expect(first.nextCursor).toBe(pendingOrg);
    const next = await get(viewer, `?organizationId=${org}&limit=1&cursor=${pendingOrg}`);
    expect(next.json()).toEqual({
      items: [expect.objectContaining({ id: orgReport })],
      nextCursor: null,
    });
    for (const query of ['limit=0', 'limit=101', 'cursor=nope']) {
      const bad = await get(viewer, `?organizationId=${org}&${query}`);
      expect(bad.statusCode).toBe(422);
    }
  });

  it('deletes a finished report for an org admin only, never a pending one', async () => {
    const byProjectAdmin = await del(projAdmin, orgReport);
    expect(byProjectAdmin.statusCode).toBe(403);
    expect(byProjectAdmin.json()).toMatchObject({ code: 'FORBIDDEN' });
    const ok = await del(orgAdmin, orgReport);
    expect(ok.statusCode, ok.body).toBe(204);
    const events = await auditOf('compliance.report.deleted');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetId: orgReport, details: { scope: 'organization' } });
    expect((await get(orgAdmin, `/${orgReport}`)).statusCode).toBe(404);
    const pending = await del(orgAdmin, pendingOrg);
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ code: 'REPORT_PENDING' });
  });

  it('writes nothing when the project went away during the build', async () => {
    const doomed = await createProject(ctx, root, { organizationId: org, key: 'doomed' });
    await succeededAnalysis(doomed.id);
    const res = await post(projAdmin, { projectId: doomed.id });
    expect(res.statusCode, res.body).toBe(202);
    const id = (res.json() as ComplianceReportView).id;
    await ctx.db.delete(projects).where(eq(projects.id, doomed.id));
    await expect(complete(id)).resolves.toBe(false);
    await expect(compliance.fail(id, 'gone')).resolves.toBe(false);
    expect(await statusOf(id)).toBeUndefined();
  });

  it('fails a summary over 64 KiB instead of storing it', async () => {
    await ctx.db.execute(
      sql`UPDATE compliance_reports SET status = 'failed', error = 'x' WHERE status = 'pending'`,
    );
    const res = await post(orgAdmin, { organizationId: org });
    expect(res.statusCode, res.body).toBe(202);
    const id = (res.json() as ComplianceReportView).id;
    const done = await compliance.complete(id, {
      canonical: Buffer.from(CANONICAL),
      sha256: SHA,
      summary: { s: 'x'.repeat(65_536) },
    });
    expect(done).toBe(false);
    expect(await statusOf(id)).toEqual({
      status: 'failed',
      error: 'the report summary is too large',
    });
    // Under the bound as JSON.stringify writes it, over it as the stored jsonb text.
    const reset = () =>
      ctx.db
        .update(complianceReports)
        .set({ status: 'pending', error: null, completedAt: null })
        .where(eq(complianceReports.id, id));
    await reset();
    const spread = Array.from({ length: 30_000 }, () => 1);
    expect(Buffer.byteLength(JSON.stringify({ s: spread }))).toBeLessThan(65_536);
    await expect(
      compliance.complete(id, {
        canonical: Buffer.from(CANONICAL),
        sha256: SHA,
        summary: { s: spread },
      }),
    ).resolves.toBe(false);
    expect(await statusOf(id)).toEqual({
      status: 'failed',
      error: 'the report summary is too large',
    });
    // The reason is cut to 500 characters.
    await reset();
    await expect(compliance.fail(id, 'é'.repeat(600))).resolves.toBe(true);
    expect((await statusOf(id))!.error).toBe('é'.repeat(500));
    oversized = id;
  });

  it('turns a known collect failure into 422 REPORT_BUILD_FAILED with its reason', async () => {
    await expect(
      compliance.collect('00000000-0000-7000-8000-000000000000', { limit: 10 }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'REPORT_BUILD_FAILED',
      detail: 'the report no longer exists',
    });
  });

  it('fails stale pending rows and deletes finished rows past retention', async () => {
    const res = await post(orgAdmin, { organizationId: org });
    expect(res.statusCode, res.body).toBe(202);
    const stale = (res.json() as ComplianceReportView).id;
    await ctx.db.execute(
      sql`UPDATE compliance_reports SET created_at = now() - interval '2 hours' WHERE id = ${stale}`,
    );
    await expect(compliance.housekeeping()).resolves.toEqual({ deleted: 0, failed: 1 });
    expect(await statusOf(stale)).toEqual({
      status: 'failed',
      error: 'the build did not finish',
    });
    await ctx.db.execute(
      sql`UPDATE compliance_reports SET created_at = now() - interval '366 days' WHERE id = ${projReport}`,
    );
    await expect(compliance.housekeeping()).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(await statusOf(projReport)).toBeUndefined();
    const again = await post(orgAdmin, { organizationId: org });
    expect(again.statusCode, again.body).toBe(202);
    // Rows newer than the bounds stay.
    const left = await ctx.db
      .select({ id: complianceReports.id })
      .from(complianceReports)
      .where(eq(complianceReports.organizationId, org));
    expect(left.map((r) => r.id).sort()).toEqual(
      [pendingOrg, oversized, stale, (again.json() as ComplianceReportView).id].sort(),
    );
  });

  it('answers 403 FEATURE_NOT_LICENSED everywhere after the grace period', async () => {
    const [any] = await ctx.db.select({ id: complianceReports.id }).from(complianceReports);
    const id = any!.id;
    now = AFTER_GRACE;
    try {
      for (const res of [
        await post(orgAdmin, { organizationId: org }),
        await get(orgAdmin, `?organizationId=${org}`),
        await get(orgAdmin, `/${id}`),
        await get(orgAdmin, `/${id}/download`),
        await del(orgAdmin, id),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
      }
      const unlicensed = {
        status: 403,
        code: 'FEATURE_NOT_LICENSED',
        message: 'The enterprise feature "compliance-export" is not licensed',
      };
      await expect(compliance.get({} as FastifyRequest, id)).rejects.toMatchObject(unlicensed);
      await expect(complete(id)).rejects.toMatchObject(unlicensed);
      await expect(compliance.fail(id, 'x')).rejects.toMatchObject(unlicensed);
      await expect(compliance.collect(id, { limit: 1 })).rejects.toMatchObject(unlicensed);
      // Housekeeping is not gated (the job scheduler skips it while the licence has lapsed).
      await expect(compliance.housekeeping()).resolves.toEqual({ deleted: 0, failed: 0 });
    } finally {
      now = LICENSED;
    }
  });
});
