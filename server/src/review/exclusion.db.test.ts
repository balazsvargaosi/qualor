import type { Report } from '@qualor/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { seedAiIssue } from '../../test/review';
import { engine, file, finding, type ReportParts } from '../../test/reports';
import { mappedProject, mergeRequestReport, PUBLIC_URL, scmTestConfig } from '../../test/scm';
import { analyses, issueChanges, issues, measures, rules } from '../db/schema';
import { reevaluateBranch } from '../gates/reevaluate';
import { autoFixCandidates } from '../llm/auto-fix';
import { readLlmSettings } from '../llm/settings';
import { fileDetail, fileTree } from '../measures/read';
import { desiredInlineIssues, loadDecoration, summaryData } from '../scm/decoration-data';
import { loadCandidates } from '../tracking/writes';

const HEAD = '1'.repeat(40);
const GITLAB_PROJECT = 301;
const SNIPPET = { startLine: 1, lines: ['const a = 1;', 'if (a == 1) {}', 'if (a == 2) {}'] };

/**
 * The issues of engine `ai` belong to review runs. They are listed with every other issue, but no
 * number of the analyzers counts them, and ingestion never touches them.
 */
describe('issues of engine ai stay out of the analyzers’ numbers', () => {
  let h: IngestHarness;
  let fake: FakeGitLab;
  let minute = 0;

  /** A merge request report of the three files, each with its lines all in new code. */
  const mrReport = (iid: number, p: IngestProject, parts: ReportParts = {}): Report =>
    mergeRequestReport(iid, HEAD, {
      projectKey: p.key,
      analysisDate: new Date(Date.UTC(2026, 9, 22, 10, minute++)).toISOString(),
      files: ['src/a.ts', 'src/b.ts', 'lib/c.ts'].map((path) =>
        file(path, { lines: 10, newLines: [[1, 10]] }),
      ),
      gitlab: { projectId: String(GITLAB_PROJECT) },
      ...parts,
    });
  const branchOf = async (analysisId: string): Promise<string> => {
    const [row] = await h.ctx.db
      .select({ branchId: analyses.branchId })
      .from(analyses)
      .where(eq(analyses.id, analysisId));
    if (!row?.branchId) throw new Error(`analysis ${analysisId} has no branch`);
    return row.branchId;
  };
  const aiIssue = async (id: string) =>
    (await h.ctx.db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const changesOf = (issueId: string) =>
    h.ctx.db.select().from(issueChanges).where(eq(issueChanges.issueId, issueId));
  /** The branch's issues of a rule engine, oldest first. */
  const issuesOf = (branchId: string, engineId: string) =>
    h.ctx.db
      .select({ issue: issues, ruleKey: rules.key })
      .from(issues)
      .innerJoin(rules, eq(rules.id, issues.ruleId))
      .where(and(eq(issues.branchId, branchId), eq(rules.engineId, engineId)))
      .orderBy(asc(issues.id));
  const aiRules = () =>
    h.ctx.db.select().from(rules).where(eq(rules.engineId, 'ai')).orderBy(asc(rules.key));

  beforeAll(async () => {
    fake = await createFakeGitLab();
    fake.addProject({ id: GITLAB_PROJECT, path: 'acme/exclusion' });
    h = await createIngestHarness({ config: scmTestConfig(fake) });
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  it('an open ai issue on a merge request branch changes no measure, no gate result, no summary list and no analyzer inline thread', async () => {
    const project = await mappedProject(h, fake, 'exclusion/numbers', GITLAB_PROJECT);
    // One merge request with two analyzer issues (its gate fails), one with none (its gate holds).
    const cases = [
      {
        iid: 7,
        findings: [finding({ path: 'src/a.ts', line: 3 }), finding({ path: 'lib/c.ts', line: 2 })],
        gate: 'failed',
        newIssues: 2,
        inline: ['lib/c.ts:2', 'src/a.ts:3'],
        issuesIn: { 'src/a.ts': 1, 'src/b.ts': 0, 'lib/c.ts': 1 },
      },
      {
        iid: 8,
        findings: [],
        gate: 'passed',
        newIssues: 0,
        inline: [],
        issuesIn: { 'src/a.ts': 0, 'src/b.ts': 0, 'lib/c.ts': 0 },
      },
    ];
    for (const c of cases) {
      const analysisId = await project.ingestOk(mrReport(c.iid, project, { findings: c.findings }));
      const loaded = await loadDecoration(h.ctx.db, analysisId);
      if (typeof loaded === 'string') throw new Error(loaded);
      const branchId = loaded.branch.id;

      /** Everything the analyzers' numbers show of this merge request. */
      const numbers = async () => ({
        measures: await h.ctx.db
          .select({ scope: measures.scope, key: measures.metricKey, value: measures.value })
          .from(measures)
          .where(eq(measures.analysisId, analysisId))
          .orderBy(asc(measures.scope), asc(measures.metricKey)),
        gate: (
          await h.ctx.db
            .select({ status: analyses.gateStatus, result: analyses.gateResult })
            .from(analyses)
            .where(eq(analyses.id, analysisId))
        )[0],
        summary: await summaryData(h.ctx.db, loaded, PUBLIC_URL),
        inline: await desiredInlineIssues(h.ctx.db, branchId, 50),
        tree: {
          root: await fileTree(h.ctx.db, branchId, '', undefined, 100),
          src: await fileTree(h.ctx.db, branchId, 'src', undefined, 100),
          lib: await fileTree(h.ctx.db, branchId, 'lib', undefined, 100),
        },
        details: {
          'src/a.ts': await fileDetail(h.ctx.db, branchId, 'src/a.ts'),
          'src/b.ts': await fileDetail(h.ctx.db, branchId, 'src/b.ts'),
          'lib/c.ts': await fileDetail(h.ctx.db, branchId, 'lib/c.ts'),
        },
      });
      const before = await numbers();
      expect(before.gate?.status).toBe(c.gate);

      // Three open AI issues in new code (one on the analyzer's own line, the worst of all), and
      // two a person triaged: each would count if it were an analyzer's.
      await seedAiIssue(h.ctx.db, {
        branchId,
        category: 'security',
        path: 'src/a.ts',
        line: 3,
        severity: 'blocker',
      });
      await seedAiIssue(h.ctx.db, { branchId, category: 'logic', path: 'src/b.ts', line: 5 });
      await seedAiIssue(h.ctx.db, { branchId, category: 'docs', path: 'lib/c.ts', line: 1 });
      await seedAiIssue(h.ctx.db, {
        branchId,
        category: 'performance',
        path: 'src/b.ts',
        line: 7,
        status: 'false_positive',
      });
      await seedAiIssue(h.ctx.db, {
        branchId,
        category: 'tests',
        path: 'src/b.ts',
        line: 8,
        status: 'wont_fix',
      });
      expect((await issuesOf(branchId, 'ai')).map((r) => r.issue.status).sort()).toEqual([
        'false_positive',
        'open',
        'open',
        'open',
        'wont_fix',
      ]);

      expect(await reevaluateBranch(h.ctx.db, branchId)).toBe('unchanged');
      const after = await numbers();
      expect(after.measures).toEqual(before.measures);
      expect(after.gate).toEqual(before.gate);
      expect(after.summary).toEqual(before.summary);
      expect(after.inline).toEqual(before.inline);
      expect(after.tree).toEqual(before.tree);
      expect(after.details).toEqual(before.details);

      // The values themselves: what the analyzers found, and no more.
      const value = (scope: string, key: string) =>
        after.measures.find((m) => m.scope === scope && m.key === key)?.value;
      expect(value('new', 'issues')).toBe(c.newIssues);
      expect(value('overall', 'issues')).toBe(c.newIssues);
      expect(value('overall', 'security_issues')).toBe(0);
      expect(value('overall', 'blocker_issues')).toBe(0);
      expect(value('overall', 'accepted_issues')).toBe(0);
      expect(value('overall', 'false_positive_issues')).toBe(0);
      expect(after.gate?.status).toBe(c.gate);
      expect(after.summary.total).toBe(c.newIssues);
      expect(after.summary.top.map((i) => i.ruleKey)).toEqual(
        c.findings.map(() => 'eslint:no-console'),
      );
      expect(after.summary.newIssues.total).toBe(c.newIssues);
      expect(after.inline.map((i) => `${i.path}:${i.line}`)).toEqual(c.inline);
      expect(after.tree.src.map((i) => [i.name, i.measures.issues])).toEqual([
        ['a.ts', c.issuesIn['src/a.ts']],
        ['b.ts', c.issuesIn['src/b.ts']],
      ]);
      expect(after.tree.root.map((i) => [i.name, i.measures.issues])).toEqual([
        ['lib', c.issuesIn['lib/c.ts']],
        ['src', c.issuesIn['src/a.ts'] + c.issuesIn['src/b.ts']],
      ]);
      for (const [path, expected] of Object.entries(c.issuesIn)) {
        expect(after.details[path as keyof typeof after.details]?.measures.issues, path).toBe(
          expected,
        );
      }

      // They are still issues: the list shows them, and the engine facet filters them.
      const list = (query: string) =>
        h.ctx.app.inject({
          method: 'GET',
          url: `/api/v0/issues?branchId=${branchId}${query}`,
          headers: h.orgAdmin.headers,
        });
      const aiOnly = (await list('&engine=ai')).json() as { items: { id: string }[] };
      expect(aiOnly.items).toHaveLength(3);
      const everything = (await list('')).json() as { items: { id: string }[] };
      expect(everything.items).toHaveLength(3 + c.newIssues);
      for (const item of aiOnly.items) {
        expect(everything.items.map((i) => i.id)).toContain(item.id);
      }
    }
  });

  it('a later ingestion of the branch never closes, matches or deduplicates an ai issue', async () => {
    const p = await h.project('exclusion/later');
    const analyzerFinding = finding({ path: 'src/a.ts', line: 3 });
    const branchId = await branchOf(
      await p.ingestOk(mrReport(7, p, { findings: [analyzerFinding] })),
    );
    // On the very line of the analyzer's issue, so that any pairing would pick them.
    const aiId = await seedAiIssue(h.ctx.db, {
      branchId,
      category: 'logic',
      path: 'src/a.ts',
      line: 3,
    });
    const kept = await aiIssue(aiId);
    const stillUntouched = async () => {
      expect(await aiIssue(aiId)).toEqual(kept);
      expect(await changesOf(aiId)).toEqual([]);
    };
    // Tracking does not even load it: the analyzer's issue is its only candidate.
    const [analyzerIssue] = await issuesOf(branchId, 'eslint');
    expect((await loadCandidates(h.ctx.db, branchId)).map((c) => c.id)).toEqual([
      analyzerIssue?.issue.id,
    ]);
    // A report may say whatever it likes about itself: here, that engine ai ran and found nothing.
    const claimingAi = [engine('eslint'), engine('ai')];

    // The analyzer reports its issue again: it is matched, the AI issue is not.
    await p.ingestOk(mrReport(7, p, { findings: [analyzerFinding], engines: claimingAi }));
    expect((await issuesOf(branchId, 'eslint')).map((r) => r.issue)).toEqual([
      expect.objectContaining({
        id: analyzerIssue?.issue.id,
        status: 'open',
        duplicateOfIssueId: null,
      }),
    ]);
    await stillUntouched();

    // The analyzer finds nothing any more: its issue closes, and engine ai "finding nothing" does
    // not close the AI issue.
    await p.ingestOk(mrReport(7, p, { findings: [], engines: claimingAi }));
    expect((await issuesOf(branchId, 'eslint')).map((r) => r.issue.status)).toEqual(['closed']);
    await stillUntouched();

    // A finding that copies the AI issue's rule, place and hashes cannot keep or update it.
    const forged = {
      engineId: 'ai',
      ruleId: 'logic',
      message: 'Forged to look like the real one',
      severity: 'blocker',
      location: { path: 'src/a.ts', startLine: 3, endLine: 3 },
      lineHash: kept.lineHash,
      contextHash: kept.contextHash,
    } satisfies Report['findings'][number];
    await p.ingestOk(mrReport(7, p, { findings: [forged], engines: claimingAi }));
    await stillUntouched();
    // Nor does it make an issue of its own.
    expect((await issuesOf(branchId, 'ai')).map((r) => r.issue.id)).toEqual([aiId]);
    expect(await issuesOf(branchId, 'eslint')).toHaveLength(1);
  });

  it('autoFixCandidates leaves ai issues out', async () => {
    const p = await h.project('exclusion/fix');
    const branchId = await branchOf(
      await p.ingestOk(
        mrReport(7, p, {
          findings: [finding({ path: 'src/a.ts', line: 3, severity: 'high', snippet: SNIPPET })],
        }),
      ),
    );
    const [analyzerIssue] = await issuesOf(branchId, 'eslint');
    // Open, in new code, with a place and a snippet, as high as the analyzer's: all the conditions
    // but the engine.
    for (const [category, path, line] of [
      ['logic', 'src/a.ts', 2],
      ['security', 'src/b.ts', 4],
    ] as const) {
      await seedAiIssue(h.ctx.db, {
        branchId,
        category,
        path,
        line,
        severity: 'high',
        snippet: SNIPPET,
      });
    }
    const settings = await readLlmSettings(h.ctx.db);
    expect(await autoFixCandidates(h.ctx.db, branchId, settings, 'info')).toEqual([
      analyzerIssue?.issue.id,
    ]);
  });

  it('a report that declares engine ai rules or findings is refused as for license', async () => {
    const p = await h.project('exclusion/forged');
    const forgedRule = {
      id: 'logic',
      name: 'Forged',
      quality: 'security' as const,
      kind: 'hotspot' as const,
      defaultSeverity: 'blocker' as const,
      cwe: [79],
    };
    const builtinBefore = await aiRules();

    // As a builtin engine, it is taken for what it is not: its rules and findings are dropped.
    const accepted = await p.ingestOk(
      mrReport(7, p, {
        engines: [engine('eslint'), engine('ai', [forgedRule])],
        findings: [
          finding({ path: 'src/a.ts', line: 3 }),
          finding({ engineId: 'ai', ruleId: 'logic', path: 'src/a.ts', line: 4 }),
          finding({ engineId: 'ai', ruleId: 'made-up', path: 'src/b.ts', line: 2 }),
        ],
      }),
    );
    const branchId = await branchOf(accepted);
    expect(await issuesOf(branchId, 'ai')).toEqual([]);
    expect((await issuesOf(branchId, 'eslint')).map((r) => r.issue.startLine)).toEqual([3]);
    expect(await aiRules()).toEqual(builtinBefore);
    expect(
      await h.ctx.db
        .select()
        .from(rules)
        .where(and(eq(rules.engineId, 'ai'), eq(rules.origin, 'reported'))),
    ).toEqual([]);

    // As an external engine, it is refused with the report: the id is reserved.
    const refused = await p.ingest(
      mrReport(7, p, {
        engines: [engine('eslint'), { ...engine('ai'), kind: 'external' as const }],
        findings: [],
      }),
    );
    const [row] = await h.ctx.db.select().from(analyses).where(eq(analyses.id, refused));
    expect(row).toMatchObject({
      status: 'failed',
      error: {
        code: 'REPORT_INVALID',
        errors: [
          { path: 'engines.1.id', message: 'engine id "ai" is reserved for built-in analyzers' },
        ],
      },
    });
  });
});
