import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { seedIssue, seedRule } from '../../test/issues';
import { seedAiIssue } from '../../test/review';
import { first } from '../db/rows';
import {
  analyses,
  branches,
  issues,
  organizations,
  projects,
  reviewFindings,
  type AiCategory,
} from '../db/schema';
import { analyzerFindings, priorAiFindings } from './context';

const HEAD = 'a'.repeat(40);

describe('the findings a review is given (6I-3)', () => {
  let t: TestDatabase;
  let projectId: string;
  let eslint: string;
  let opengrep: string;

  const newBranch = async (name: string) =>
    first(
      await t.db.insert(branches).values({ projectId, kind: 'merge_request', name }).returning(),
    ).id;
  const newAnalysis = async (branchId: string | null) =>
    first(await t.db.insert(analyses).values({ projectId, branchId }).returning()).id;
  /** An AI issue and, unless `body` is null, the finding row beside it. */
  const aiIssue = async (
    branchId: string,
    over: {
      category?: AiCategory;
      path?: string;
      line?: number;
      status?: 'open' | 'resolved' | 'wont_fix' | 'false_positive' | 'closed';
      severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
      body?: string | null;
    } = {},
  ) => {
    const category = over.category ?? 'logic';
    const id = await seedAiIssue(t.db, {
      branchId,
      category,
      path: over.path ?? 'src/a.ts',
      line: over.line ?? 1,
      status: over.status ?? 'open',
      ...(over.severity === undefined ? {} : { severity: over.severity }),
    });
    if (over.body !== null) {
      await t.db.insert(reviewFindings).values({
        issueId: id,
        category,
        body: over.body ?? `Body of ${id}`,
        reviewedHeadSha: HEAD,
      });
    }
    return id;
  };
  const row = async (id: string) =>
    first(await t.db.select().from(issues).where(eq(issues.id, id)));

  beforeAll(async () => {
    t = await createTestDatabase();
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'ctx', name: 'Ctx' }).returning(),
    ).id;
    projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'ctx/api', name: 'api' })
        .returning(),
    ).id;
    eslint = await seedRule(t.db, { key: 'eslint:no-eval' });
    opengrep = await seedRule(t.db, { key: 'opengrep:sql-injection', kind: 'hotspot' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('analyzerFindings', () => {
    it('leaves out ai, duplicates and other paths', async () => {
      const branchId = await newBranch('analyzer-1');
      const otherBranch = await newBranch('analyzer-2');
      const analysisId = await newAnalysis(branchId);
      const base = { projectId, branchId };

      const eval1 = await seedIssue(t.db, {
        ...base,
        ruleId: eslint,
        path: 'src/a.ts',
        startLine: 3,
        severity: 'high',
        message: 'Avoid eval',
      });
      // What the review must not be given: a duplicate, its own kind of finding, a path it does
      // not review, a status that is not open, and another branch's issue.
      await seedIssue(t.db, {
        ...base,
        ruleId: eslint,
        path: 'src/a.ts',
        startLine: 3,
        duplicateOfIssueId: eval1,
      });
      await seedAiIssue(t.db, { branchId, category: 'logic', path: 'src/a.ts', line: 3 });
      await seedIssue(t.db, { ...base, ruleId: eslint, path: 'src/other.ts', startLine: 1 });
      for (const status of ['resolved', 'closed', 'false_positive', 'wont_fix'] as const) {
        await seedIssue(t.db, { ...base, ruleId: eslint, path: 'src/a.ts', startLine: 4, status });
      }
      await seedIssue(t.db, {
        projectId,
        branchId: otherBranch,
        ruleId: eslint,
        path: 'src/a.ts',
        startLine: 3,
      });
      // A hotspot, a finding with no line, and a message past the cut.
      await seedIssue(t.db, {
        ...base,
        ruleId: opengrep,
        kind: 'hotspot',
        path: 'src/b.ts',
        startLine: 7,
        severity: 'blocker',
        message: 'SQL built from input',
      });
      await seedIssue(t.db, {
        ...base,
        ruleId: eslint,
        path: 'src/b.ts',
        startLine: null,
        severity: 'medium',
        message: 'No line',
      });
      await seedIssue(t.db, {
        ...base,
        ruleId: eslint,
        path: 'src/a.ts',
        startLine: 20,
        severity: 'medium',
        message: 'm'.repeat(400),
      });

      const found = await analyzerFindings(t.db, analysisId, ['src/a.ts', 'src/b.ts']);
      // Most severe first, then by path and line, a finding with no line last.
      expect(found).toEqual([
        {
          ruleKey: 'opengrep:sql-injection',
          severity: 'blocker',
          message: 'SQL built from input',
          path: 'src/b.ts',
          line: 7,
        },
        {
          ruleKey: 'eslint:no-eval',
          severity: 'high',
          message: 'Avoid eval',
          path: 'src/a.ts',
          line: 3,
        },
        {
          ruleKey: 'eslint:no-eval',
          severity: 'medium',
          message: `${'m'.repeat(299)}…`,
          path: 'src/a.ts',
          line: 20,
        },
        {
          ruleKey: 'eslint:no-eval',
          severity: 'medium',
          message: 'No line',
          path: 'src/b.ts',
          line: null,
        },
      ]);
      // Only the paths asked for; none asked for, none read.
      expect((await analyzerFindings(t.db, analysisId, ['src/b.ts'])).map((f) => f.path)).toEqual([
        'src/b.ts',
        'src/b.ts',
      ]);
      expect(await analyzerFindings(t.db, analysisId, [])).toEqual([]);
    });

    it('answers nothing for an analysis with no branch or none at all', async () => {
      const noBranch = await newAnalysis(null);
      expect(await analyzerFindings(t.db, noBranch, ['src/a.ts'])).toEqual([]);
      expect(
        await analyzerFindings(t.db, '00000000-0000-7000-8000-000000000000', ['src/a.ts']),
      ).toEqual([]);
    });

    it('gives the 100 most severe findings, and takes the paths as one value however many there are', async () => {
      const branchId = await newBranch('analyzer-cap');
      const analysisId = await newAnalysis(branchId);
      await seedIssue(t.db, {
        projectId,
        branchId,
        ruleId: eslint,
        path: 'src/z.ts',
        startLine: 1,
        severity: 'blocker',
        message: 'the one that matters',
      });
      for (let line = 1; line <= 120; line += 1) {
        await seedIssue(t.db, {
          projectId,
          branchId,
          ruleId: eslint,
          path: 'src/many.ts',
          startLine: line,
          severity: 'low',
        });
      }
      // More paths than a statement can bind values for.
      const paths = Array.from({ length: 70_000 }, (_, i) => `gen/file-${i}.ts`);
      const found = await analyzerFindings(t.db, analysisId, [...paths, 'src/many.ts', 'src/z.ts']);
      expect(found).toHaveLength(100);
      expect(found[0]?.message).toBe('the one that matters');
      expect(found.slice(1).map((f) => f.line)).toEqual(
        Array.from({ length: 99 }, (_, i) => i + 1),
      );
    });
  });

  describe('priorAiFindings', () => {
    it('returns open and dismissed AI issues with their bodies', async () => {
      const branchId = await newBranch('prior-1');
      const otherBranch = await newBranch('prior-2');

      const open = await aiIssue(branchId, {
        category: 'logic',
        path: 'src/a.ts',
        line: 5,
        severity: 'medium',
        body: 'Off by one in the loop.',
      });
      await t.db.update(issues).set({ endLine: 12 }).where(eq(issues.id, open));
      const falsePositive = await aiIssue(branchId, {
        category: 'security',
        path: 'src/a.ts',
        line: 9,
        status: 'false_positive',
        severity: 'high',
        body: 'The query is built from input.',
      });
      const wontFix = await aiIssue(branchId, {
        category: 'docs',
        path: 'src/b.ts',
        line: 2,
        status: 'wont_fix',
        body: 'b'.repeat(700),
      });
      // One that has no finding row beside it still counts, with no body.
      const noRow = await aiIssue(branchId, { category: 'tests', path: 'src/c.ts', body: null });
      // What a re-review must not be given: fixed and resolved issues, another branch's, and an
      // analyzer's.
      await aiIssue(branchId, { status: 'resolved', path: 'src/d.ts' });
      await aiIssue(branchId, { status: 'closed', path: 'src/d.ts' });
      await aiIssue(otherBranch, { path: 'src/a.ts' });
      await seedIssue(t.db, {
        projectId,
        branchId,
        ruleId: eslint,
        path: 'src/a.ts',
        startLine: 5,
      });
      // An analyzer's rule named like a category of the AI review is not the AI review's.
      const lookalike = await seedRule(t.db, { key: 'eslint:logic' });
      await seedIssue(t.db, {
        projectId,
        branchId,
        ruleId: lookalike,
        path: 'src/a.ts',
        startLine: 6,
      });
      // An issue that cannot be placed (no path, no line) is no use to a re-review.
      const noPath = await aiIssue(branchId, { path: 'src/e.ts' });
      await t.db.update(issues).set({ path: null }).where(eq(issues.id, noPath));
      const noLine = await aiIssue(branchId, { path: 'src/f.ts' });
      await t.db.update(issues).set({ startLine: null }).where(eq(issues.id, noLine));

      const found = await priorAiFindings(t.db, branchId);
      const openRow = await row(open);
      const falseRow = await row(falsePositive);
      const wontRow = await row(wontFix);
      const noRowRow = await row(noRow);
      expect(found).toEqual([
        {
          id: open,
          category: 'logic',
          severity: 'medium',
          status: 'open',
          path: 'src/a.ts',
          line: 5,
          endLine: 12,
          title: openRow.message,
          body: 'Off by one in the loop.',
          fingerprint: openRow.fingerprint,
        },
        {
          id: falsePositive,
          category: 'security',
          severity: 'high',
          status: 'false_positive',
          path: 'src/a.ts',
          line: 9,
          endLine: 9,
          title: falseRow.message,
          body: 'The query is built from input.',
          fingerprint: falseRow.fingerprint,
        },
        {
          id: wontFix,
          category: 'docs',
          severity: 'low',
          status: 'wont_fix',
          path: 'src/b.ts',
          line: 2,
          endLine: 2,
          title: wontRow.message,
          body: `${'b'.repeat(499)}…`,
          fingerprint: wontRow.fingerprint,
        },
        {
          id: noRow,
          category: 'tests',
          severity: 'low',
          status: 'open',
          path: 'src/c.ts',
          line: 1,
          endLine: 1,
          title: noRowRow.message,
          body: '',
          fingerprint: noRowRow.fingerprint,
        },
      ]);
      expect(openRow.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    });

    it('answers nothing for a branch with no AI issue', async () => {
      const branchId = await newBranch('prior-none');
      await seedIssue(t.db, { projectId, branchId, ruleId: eslint, path: 'src/a.ts' });
      expect(await priorAiFindings(t.db, branchId)).toEqual([]);
    });
  });
});
