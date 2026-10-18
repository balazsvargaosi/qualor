import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProject,
  createTestContext,
  createUser,
  login,
  organizationId,
  type TestContext,
} from '../../test/app';
import { mainBranchId, seedIssue, seedRule } from '../../test/issues';
import { callTool } from '../../test/mcp';
import { oauthTokens as runOAuth } from '../../test/oauth';
import { analyses, branchFiles, branches, measures } from '../db/schema';

const DONE = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const RUNNING = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
const BROKEN = 'dddd4444dddd4444dddd4444dddd4444dddd4444';

describe('MCP read tools', () => {
  let ctx: TestContext;
  let token: string;
  let outsiderToken: string;
  let mainId: string;
  let mrId: string;
  let newIssueId: string;

  beforeAll(async () => {
    ctx = await createTestContext({ config: { publicUrl: 'https://q.example' } });
    const admin = await login(ctx, 'admin', 'correct horse battery staple');
    const a = await createUser(ctx, { username: 'alice' });
    const alice = await login(ctx, a.username, a.password);
    const o = await createUser(ctx, { username: 'olga' });
    const olga = await login(ctx, o.username, o.password);
    const org = await organizationId(ctx, 'default');
    await addMember(ctx, org, a.id, 'member');
    const project = await createProject(ctx, admin, { organizationId: org, key: 'shop' });
    mainId = await mainBranchId(ctx.db, project.id);
    const [mr] = await ctx.db
      .insert(branches)
      .values({
        projectId: project.id,
        kind: 'merge_request',
        name: '42',
        mrSourceBranch: 'feature/x',
        mrUrl: 'https://git.example/shop/-/merge_requests/42',
      })
      .returning({ id: branches.id });
    mrId = mr?.id ?? '';

    const ruleId = await seedRule(ctx.db, {
      key: 'eslint:no-eval',
      name: 'No eval',
      quality: 'security',
      defaultSeverity: 'high',
      cwe: [95],
    });
    newIssueId = await seedIssue(ctx.db, {
      projectId: project.id,
      branchId: mainId,
      ruleId,
      message: 'eval is evil',
      path: 'src/a.ts',
      startLine: 3,
      severity: 'high',
      quality: 'security',
      inNewCode: true,
      snippet: { startLine: 2, lines: ['const x = 1;', 'eval(x);', 'done();'] },
    });
    await seedIssue(ctx.db, {
      projectId: project.id,
      branchId: mainId,
      ruleId,
      message: 'old eval',
      path: 'src/b.ts',
      startLine: 9,
      inNewCode: false,
    });

    const gateResult = {
      status: 'failed',
      gate: { id: '00000000-0000-4000-8000-000000000001', name: 'Default' },
      conditions: [
        { metric: 'new_violations', operator: 'gt', threshold: 0, value: 1, status: 'failed' },
        { metric: 'new_coverage', operator: 'lt', threshold: 80, value: 90, status: 'passed' },
      ],
      ignoredConditions: [],
      warnings: [],
    };
    const [done] = await ctx.db
      .insert(analyses)
      .values({
        projectId: project.id,
        branchId: mainId,
        status: 'succeeded',
        baselineStatus: 'ok',
        scannerVersion: '1.0.0',
        analysisDate: new Date('2026-10-01T10:00:00Z'),
        revision: DONE,
        gateStatus: 'failed',
        gateResult,
      })
      .returning({ id: analyses.id });
    const doneId = done?.id ?? '';
    await ctx.db
      .update(branches)
      .set({ lastAnalysisId: doneId, lastAnalyzedAt: new Date('2026-10-01T10:00:00Z') })
      .where(eq(branches.id, mainId));
    await ctx.db.insert(analyses).values({
      projectId: project.id,
      branchId: mainId,
      status: 'processing',
      revision: RUNNING,
    });
    await ctx.db.insert(analyses).values({
      projectId: project.id,
      branchId: mainId,
      status: 'failed',
      revision: BROKEN,
      error: { code: 'REPORT_INVALID', message: 'The report could not be read' },
    });
    await ctx.db.insert(measures).values([
      { analysisId: doneId, metricKey: 'coverage', scope: 'overall', value: 72.5 },
      { analysisId: doneId, metricKey: 'coverage', scope: 'new', value: 61.5 },
      { analysisId: doneId, metricKey: 'ncloc', scope: 'overall', value: 1200 },
    ]);
    await ctx.db.insert(branchFiles).values({
      branchId: mainId,
      path: 'src/a.ts',
      language: 'typescript',
      kind: 'main',
      sha256: 'a'.repeat(64),
      coverage: {
        covered: [[1, 2]],
        uncovered: [
          [3, 3],
          [7, 9],
        ],
        branches: [],
      },
      newLines: 'all',
      duplications: [],
      analysisId: doneId,
    });
    token = (await runOAuth(ctx, alice, ['mcp:read'])).accessToken;
    outsiderToken = (await runOAuth(ctx, olga, ['mcp:read'])).accessToken;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('qualor_gate_status: the main branch by default, with the failed condition', async () => {
    const r = await callTool(ctx, token, 'qualor_gate_status', { project: 'shop' });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      branch: { name: 'main', kind: 'branch' },
      gate: 'failed',
      failedConditions: [{ metric: 'new_violations', value: 1, threshold: 0 }],
      analysis: { revision: DONE },
    });
    expect(r.structured?.failedConditions).toHaveLength(1);
    expect(r.text).toContain('new_violations is 1, must not be above 0');
    expect(r.text).not.toContain('new_coverage');
  });

  it('qualor_gate_status: a merge request by number', async () => {
    const r = await callTool(ctx, token, 'qualor_gate_status', {
      project: 'shop',
      mergeRequest: '42',
    });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      branch: {
        id: mrId,
        kind: 'merge_request',
        mrUrl: 'https://git.example/shop/-/merge_requests/42',
      },
      gate: null,
      analysis: null,
    });
    expect(r.text).toContain('merge request 42: gate not computed');
  });

  it.each([
    ['aaaa111', 'analyzed'],
    [RUNNING, 'in_progress'],
    [BROKEN, 'failed'],
    ['cccc333', 'not_yet'],
  ])('qualor_gate_status with commit %s -> %s (ruling R3)', async (commit, state) => {
    const r = await callTool(ctx, token, 'qualor_gate_status', { project: 'shop', commit });
    expect(r.structured).toMatchObject({ commit: { state } });
  });

  it('qualor_gate_status: an analysed commit carries its gate, a missing one the latest analysed', async () => {
    const hit = await callTool(ctx, token, 'qualor_gate_status', {
      project: 'shop',
      commit: DONE.slice(0, 10),
    });
    expect(hit.structured).toMatchObject({ gate: 'failed', analysis: { revision: DONE } });
    const failed = await callTool(ctx, token, 'qualor_gate_status', {
      project: 'shop',
      commit: BROKEN,
    });
    expect(failed.text).toContain('The analysis failed: The report could not be read');
    const miss = await callTool(ctx, token, 'qualor_gate_status', {
      project: 'shop',
      commit: 'cccc333',
    });
    expect(miss.structured).toMatchObject({ gate: null, commit: { latestRevision: DONE } });
    expect(miss.text).toContain(`the latest analysed is ${DONE}`);
  });

  it('qualor_gate_status: a clear error for an unknown project or branch', async () => {
    const p = await callTool(ctx, token, 'qualor_gate_status', { project: 'nope' });
    expect([p.isError, p.text]).toEqual([true, expect.stringContaining('nope')]);
    const b = await callTool(ctx, token, 'qualor_gate_status', {
      project: 'shop',
      branch: 'feature/x',
    });
    expect([b.isError, b.text]).toEqual([true, expect.stringContaining('feature/x')]);
    const both = await callTool(ctx, token, 'qualor_gate_status', {
      project: 'shop',
      branch: 'main',
      mergeRequest: '42',
    });
    expect([both.isError, both.text]).toEqual([true, expect.stringContaining('not both')]);
  });

  it('qualor_gate_status: a project the user cannot see is as missing as an absent one', async () => {
    const r = await callTool(ctx, outsiderToken, 'qualor_gate_status', { project: 'shop' });
    expect([r.isError, r.text]).toEqual([true, expect.stringContaining('No project with key')]);
  });

  it('qualor_issues: new code only by default', async () => {
    const r = await callTool(ctx, token, 'qualor_issues', { project: 'shop' });
    expect(r.text).toContain('src/a.ts:3 [high security] eslint:no-eval — eval is evil');
    expect(r.text).not.toContain('old eval');
    expect(r.structured).toMatchObject({
      issues: [{ id: newIssueId, path: 'src/a.ts', line: 3, rule: 'eslint:no-eval' }],
      nextCursor: null,
    });
    const all = await callTool(ctx, token, 'qualor_issues', {
      project: 'shop',
      newCodeOnly: false,
    });
    expect(all.text).toContain('old eval');
  });

  it('qualor_issues: filters by severity and path with repeated query keys, and pages', async () => {
    const high = await callTool(ctx, token, 'qualor_issues', {
      project: 'shop',
      newCodeOnly: false,
      severity: ['high', 'blocker'],
      path: ['src/a'],
    });
    expect(high.isError).toBe(false);
    expect(high.structured?.issues).toHaveLength(1);
    const first = await callTool(ctx, token, 'qualor_issues', {
      project: 'shop',
      newCodeOnly: false,
      limit: 1,
    });
    const cursor = (first.structured as { nextCursor: string | null }).nextCursor;
    expect(cursor).toEqual(expect.any(String));
    expect(first.text).toContain(cursor ?? '');
    const second = await callTool(ctx, token, 'qualor_issues', {
      project: 'shop',
      newCodeOnly: false,
      limit: 1,
      cursor: cursor ?? undefined,
    });
    expect(second.structured?.issues).toHaveLength(1);
    expect(second.structured?.issues).not.toEqual(first.structured?.issues);
  });

  it('qualor_issues: an empty merge request says so', async () => {
    const r = await callTool(ctx, token, 'qualor_issues', { project: 'shop', mergeRequest: '42' });
    expect(r.text).toBe('0 issue(s) on merge request 42 (new code):');
  });

  it('qualor_issue: the detail with the numbered snippet, the rule and its history', async () => {
    const r = await callTool(ctx, token, 'qualor_issue', { issueId: newIssueId });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      issue: { id: newIssueId, rule: { key: 'eslint:no-eval' } },
      history: [],
    });
    expect(r.text).toContain('CWE: CWE-95');
    expect(r.text).toContain('  2 | const x = 1;\n> 3 | eval(x);\n  4 | done();');
  });

  it('qualor_issue: an unknown issue is a tool error', async () => {
    const r = await callTool(ctx, token, 'qualor_issue', {
      issueId: '00000000-0000-4000-8000-000000000000',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('(NOT_FOUND)');
  });

  it('qualor_rule: by key in the organisation of the project', async () => {
    const r = await callTool(ctx, token, 'qualor_rule', {
      project: 'shop',
      rule: 'eslint:no-eval',
    });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ rule: { key: 'eslint:no-eval', name: 'No eval' } });
    expect(r.text).toContain('eslint:no-eval — No eval [high security]');
    const none = await callTool(ctx, token, 'qualor_rule', {
      project: 'shop',
      rule: 'eslint:nope',
    });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('(NOT_FOUND)');
  });

  it('qualor_measures: metric: value lines for the branch', async () => {
    const r = await callTool(ctx, token, 'qualor_measures', { project: 'shop' });
    expect(r.isError).toBe(false);
    expect(r.structured?.measures).toEqual(
      expect.arrayContaining([{ metric: 'coverage', overall: 72.5, new: 61.5 }]),
    );
    expect(r.text).toContain('coverage: 72.5 (new code: 61.5)');
    expect(r.text).toContain('ncloc: 1200');
    expect(r.structured).toMatchObject({ file: null });
  });

  it('qualor_measures: the uncovered lines of a file', async () => {
    const r = await callTool(ctx, token, 'qualor_measures', { project: 'shop', file: 'src/a.ts' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('uncovered lines: 3, 7–9');
    expect(r.text).toContain('covered lines: 1–2');
    expect(r.text).toContain('new lines: all');
    const missing = await callTool(ctx, token, 'qualor_measures', {
      project: 'shop',
      file: 'src/none.ts',
    });
    expect(missing.isError).toBe(true);
  });

  it('qualor_measures: a branch never analysed has no measures', async () => {
    const r = await callTool(ctx, token, 'qualor_measures', {
      project: 'shop',
      mergeRequest: '42',
    });
    expect(r.text).toBe('shop merge request 42 has no measures yet.');
  });
});
