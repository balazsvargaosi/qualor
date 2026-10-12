import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createProject,
  createTestContext,
  login,
  type TestContext,
} from '../../test/app';
import { mainBranchId, seedIssue, seedRule } from '../../test/issues';
import { analyses, branches, complianceReports, issueChanges, measures, users } from '../db/schema';
import { collectCompliance, ComplianceCollectError } from './collect';

describe('collectCompliance (4E-1 §2.1, §2.3)', () => {
  let ctx: TestContext;
  let org: string;
  let alpha: { id: string; key: string };
  let beta: { id: string; key: string };
  let alphaMain: string;
  let alphaOther: string;
  let userB: string;
  let multiTriage: string;
  let sqli: string, secret: string, dep: string, lint: string, hotspot: string;

  /** Inserts a pending report; the previous pending rows are finished first (one per scope). */
  const newReport = async (values: Partial<typeof complianceReports.$inferInsert>) => {
    await ctx.db.execute(
      sql`UPDATE compliance_reports SET status = 'failed', error = 'x' WHERE status = 'pending'`,
    );
    const [r] = await ctx.db
      .insert(complianceReports)
      .values({
        organizationId: org,
        scope: 'organization',
        createdByName: 'A',
        standards: [],
        ...values,
      })
      .returning({ id: complianceReports.id });
    return r!.id;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/organizations',
      headers: admin.headers,
      payload: { key: 'acme', name: 'Acme' },
    });
    org = (res.json() as { id: string }).id;
    alpha = await createProject(ctx, admin, { organizationId: org, key: 'alpha' });
    beta = await createProject(ctx, admin, { organizationId: org, key: 'beta' }); // never analysed
    alphaMain = await mainBranchId(ctx.db, alpha.id);
    // two succeeded analyses with security measures, the last one with a failed gate
    for (const [i, rating] of [
      [1, 3],
      [2, 4],
    ] as const) {
      const [a] = await ctx.db
        .insert(analyses)
        .values({
          projectId: alpha.id,
          branchId: alphaMain,
          status: 'succeeded',
          baselineStatus: 'ok',
          scannerVersion: '1.0.0',
          analysisDate: new Date(`2026-10-0${i}T00:00:00Z`),
          revision: String(i).repeat(40),
          gateStatus: i === 2 ? 'failed' : 'passed',
          gateResult:
            i === 2
              ? {
                  status: 'failed',
                  gate: null,
                  ignoredConditions: [],
                  warnings: [],
                  conditions: [
                    {
                      metric: 'new_issues',
                      operator: 'gt',
                      threshold: 0,
                      value: 3,
                      status: 'failed',
                    },
                    {
                      metric: 'new_coverage',
                      operator: 'lt',
                      threshold: 80,
                      value: 90,
                      status: 'passed',
                    },
                  ],
                }
              : null,
        })
        .returning({ id: analyses.id });
      await ctx.db.insert(measures).values([
        { analysisId: a!.id, metricKey: 'security_issues', scope: 'overall', value: i * 2 },
        { analysisId: a!.id, metricKey: 'security_rating', scope: 'overall', value: rating },
      ]);
      await ctx.db.execute(
        sql`UPDATE branches SET last_analysis_id = ${a!.id} WHERE id = ${alphaMain}`,
      );
    }
    const [other] = await ctx.db
      .insert(branches)
      .values({ projectId: alpha.id, kind: 'branch', name: 'feature' })
      .returning({ id: branches.id });
    alphaOther = other!.id;
    sqli = await seedRule(ctx.db, { key: 'semgrep:sqli', cwe: [89], quality: 'security' });
    secret = await seedRule(ctx.db, { key: 'gitleaks:aws-key', quality: 'security' }); // cwe [] → 798 by engine
    dep = await seedRule(ctx.db, { key: 'trivy:CVE-2026-1', cwe: [502], quality: 'security' });
    lint = await seedRule(ctx.db, { key: 'eslint:no-unused-vars' }); // not security
    hotspot = await seedRule(ctx.db, { key: 'spotbugs:SPRING_ENDPOINT', kind: 'hotspot' });
    const b = { projectId: alpha.id, branchId: alphaMain };
    const s1 = await seedIssue(ctx.db, {
      ...b,
      ruleId: sqli,
      severity: 'high',
      quality: 'security',
      path: 'src/db.ts',
      startLine: 10,
      inNewCode: true,
    });
    await seedIssue(ctx.db, {
      ...b,
      ruleId: sqli,
      severity: 'high',
      quality: 'security',
      duplicateOfIssueId: s1,
    });
    await seedIssue(ctx.db, {
      ...b,
      ruleId: secret,
      severity: 'blocker',
      quality: 'security',
      path: '.env',
    });
    await seedIssue(ctx.db, {
      ...b,
      ruleId: dep,
      severity: 'medium',
      quality: 'security',
      path: 'package-lock.json',
      startLine: null,
    });
    await seedIssue(ctx.db, { ...b, ruleId: lint, severity: 'low' });
    await seedIssue(ctx.db, { ...b, ruleId: hotspot, kind: 'hotspot', severity: 'medium' });
    // CWE-only relevance: a CWE rule, but rule and issue quality are maintainability.
    const traversal = await seedRule(ctx.db, { key: 'semgrep:path-traversal', cwe: [22] });
    await seedIssue(ctx.db, { ...b, ruleId: traversal, severity: 'low', path: 'src/z.ts' });
    // The same kind of finding on another branch is out of scope for a main-branch report.
    await seedIssue(ctx.db, {
      projectId: alpha.id,
      branchId: alphaOther,
      ruleId: sqli,
      quality: 'security',
      severity: 'blocker',
    });
    await seedIssue(ctx.db, { ...b, ruleId: sqli, status: 'resolved' });
    const fp = await seedIssue(ctx.db, {
      ...b,
      ruleId: sqli,
      status: 'false_positive',
      severity: 'high',
    });
    const [admin_] = await ctx.db
      .select()
      .from(users)
      .where(sql`username = 'admin'`);
    await ctx.db.insert(issueChanges).values([
      {
        issueId: fp,
        userId: admin_!.id,
        field: 'status',
        oldValue: 'open',
        newValue: 'false_positive',
        comment: 'x'.repeat(1500),
      },
    ]);
    // Attribution: the newest change with field = status and new_value = the current status.
    const [ub] = await ctx.db
      .insert(users)
      .values({ username: 'bob', displayName: null })
      .returning({ id: users.id });
    userB = ub!.id;
    multiTriage = await seedIssue(ctx.db, {
      ...b,
      ruleId: sqli,
      status: 'false_positive',
      severity: 'low',
      quality: 'security',
    });
    const change = (
      userId: string,
      field: 'status' | 'comment',
      newValue: string,
      comment: string,
      at: string,
    ) => ({
      issueId: multiTriage,
      userId,
      field,
      oldValue: null,
      newValue,
      comment,
      createdAt: new Date(at),
    });
    await ctx.db
      .insert(issueChanges)
      .values([
        change(admin_!.id, 'status', 'false_positive', 'old', '2026-01-01T00:00:00Z'),
        change(userB, 'status', 'false_positive', 'new', '2026-01-02T00:00:00Z'),
        change(admin_!.id, 'comment', 'false_positive', 'later comment', '2026-01-03T00:00:00Z'),
        change(admin_!.id, 'status', 'open', 'reopened?', '2026-01-04T00:00:00Z'),
      ]);
  });
  afterAll(() => ctx.close());

  it('reads an organisation scope: projects, gate, trend, groups, findings, triage', async () => {
    const id = await newReport({});
    const s = await collectCompliance(ctx.db, id, { limit: 50_000 });
    expect(s.scope.kind).toBe('organization');
    expect(s.createdBy).toBe('A');
    expect(s.projects.map((p) => p.key)).toEqual(['alpha', 'beta']);
    const a = s.projects[0]!;
    expect(a.gate).toEqual({
      status: 'failed',
      failedConditions: [{ metric: 'new_issues', op: 'gt', threshold: 0, actual: 3 }],
    });
    expect(a.trend.map((t) => t.security_rating)).toEqual([3, 4]);
    expect(s.projects[1]).toMatchObject({ analysis: null, gate: null, trend: [] });
    expect(s.projects[1]).toMatchObject({ id: beta.id, branch: { name: 'main' }, analysis: null });
    // open: sqli (dup excluded), secret, dep, hotspot, CWE-only traversal; not lint, not resolved.
    // Order: severity rank, project key, path NULLS FIRST, line, id.
    expect(s.findings.map((f) => f.rule)).toEqual([
      'gitleaks:aws-key',
      'semgrep:sqli',
      'trivy:CVE-2026-1',
      'spotbugs:SPRING_ENDPOINT',
      'semgrep:path-traversal',
    ]);
    expect(s.findings.find((f) => f.rule === 'gitleaks:aws-key')).toMatchObject({
      section: 'secret',
      cwe: [798],
    });
    expect(s.findings.find((f) => f.rule === 'trivy:CVE-2026-1')).toMatchObject({
      section: 'dependency',
      line: null,
    });
    expect(s.triage).toHaveLength(2);
    expect(s.triage[0]).toMatchObject({
      status: 'false_positive',
      section: 'code',
      by: 'Administrator',
    });
    expect([...s.triage[0]!.comment!].length).toBe(1000);
    // the newest matching status change decides by / at / comment
    const multi = s.triage.find((t) => t.id === multiTriage);
    expect(multi).toMatchObject({
      by: 'bob',
      at: '2026-01-02T00:00:00.000Z',
      comment: 'new',
    });
    const open = s.groups.filter((g) => g.status === 'open').reduce((n, g) => n + g.count, 0);
    expect(open).toBe(5);
  });

  it('truncates the detail lists at limit + 1 while the groups stay exact', async () => {
    const id = await newReport({});
    const s = await collectCompliance(ctx.db, id, { limit: 1 });
    expect(s.findings).toHaveLength(2);
    expect(s.groups.filter((g) => g.status === 'open').reduce((n, g) => n + g.count, 0)).toBe(5);
  });

  it('reads a project scope on its branch', async () => {
    const id = await newReport({ scope: 'project', projectId: alpha.id, branchId: alphaMain });
    const s = await collectCompliance(ctx.db, id, { limit: 50_000 });
    expect(s.projects).toHaveLength(1);
    expect(s.scope.project?.key).toBe('alpha');
    expect(s.scope.branch?.name).toBe('main');
    // the feature-branch blocker is not in the report
    expect(s.findings.some((f) => f.severity === 'blocker' && f.rule === 'semgrep:sqli')).toBe(
      false,
    );
    expect(s.groups.some((g) => g.severity === 'blocker' && g.rule === 'semgrep:sqli')).toBe(false);
    expect(s.groups.filter((g) => g.status === 'open').reduce((n, g) => n + g.count, 0)).toBe(5);
  });

  it('fails cleanly for a report that no longer exists', async () => {
    await expect(
      collectCompliance(ctx.db, '00000000-0000-7000-8000-000000000000', { limit: 1 }),
    ).rejects.toBeInstanceOf(ComplianceCollectError);
  });

  it('refuses a report that is no longer pending, before any work', async () => {
    const id = await newReport({});
    await ctx.db.execute(
      sql`UPDATE compliance_reports SET status = 'failed', error = 'the build did not finish' WHERE id = ${id}`,
    );
    const refused = collectCompliance(ctx.db, id, { limit: 1 });
    await expect(refused).rejects.toBeInstanceOf(ComplianceCollectError);
    await expect(refused).rejects.toThrow('the report is no longer pending');
  });

  it('stops when aborted', async () => {
    const id = await newReport({});
    const ac = new AbortController();
    ac.abort(new Error('timeout'));
    await expect(collectCompliance(ctx.db, id, { limit: 1, signal: ac.signal })).rejects.toThrow(
      'timeout',
    );
  });
});
