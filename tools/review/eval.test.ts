import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiCategory } from '../../server/src/db/schema';
import type { ConversationResult } from '../../server/src/review/conversation';
import type { PipelineDeps } from '../../server/src/review/pipeline';
import type { SnapshotReader } from '../../server/src/review/snapshot-reader';
import {
  EVAL_DIR,
  formatReport,
  loadCases,
  runEval,
  type EvalCase,
  type EvalDeps,
  type EvalReport,
  type ExpectedProblem,
  type Tally,
} from './eval';
// @ts-expect-error: a plain ES module of the repository's tooling, without type declarations
import { buildPatch } from './make-case.mjs';

/*
 * Plan 6I-3 Task 14: the evaluation set of the AI review and the harness that scores it. Nothing
 * here calls a model: the reviewer is a script, which answers each role of the pipeline as the
 * test says. The review itself (context, masking, pipeline, placement of the findings) is the
 * server's own.
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─── A scripted reviewer ─────────────────────────────────────────────────────

/** A finding a script reports: the judge's answer, which is what the review keeps. */
interface Said {
  category: AiCategory;
  path: string;
  line: number;
  endLine: number;
  severity?: 'critical' | 'major' | 'minor';
  title?: string;
  body?: string;
  suggestion?: { startLine: number; endLine: number; lines: string[] } | null;
}

const answer = (text: string, tokens: [number, number] = [1_000, 100]): ConversationResult => ({
  kind: 'answer',
  text,
  budgetReached: false,
  inputTokens: tokens[0],
  outputTokens: tokens[1],
  turns: 1,
  toolCalls: 0,
});

interface Script {
  /** What the judge reports for a case. */
  said: (c: EvalCase) => Said[];
  /** The judge's verdict and walkthrough. */
  summary?: { verdict: string; walkthrough: string[] };
  /** What the judge answers instead of its report. */
  judge?: (c: EvalCase) => ConversationResult;
  /** The tokens each call reports. */
  tokens?: [number, number];
}

/**
 * A reviewer made of a script: the specialists find nothing, the judge reports what `said` names
 * for the case, and a verification confirms. The conversation never calls a tool or a provider.
 * `roles` lists the roles that were asked, in order, across the cases.
 */
function scripted(script: Script): { deps: EvalDeps; roles: string[] } {
  const roles: string[] = [];
  const pipelineFor: EvalDeps['pipelineFor'] = ({ evalCase }) => {
    const converse: PipelineDeps['converse'] = (role) => {
      roles.push(role);
      if (role === 'judge') {
        if (script.judge !== undefined) return Promise.resolve(script.judge(evalCase));
        const findings = script.said(evalCase).map((said) => ({
          category: said.category,
          severity: said.severity ?? 'major',
          confidence: 'high',
          path: said.path,
          line: said.line,
          endLine: said.endLine,
          title: said.title ?? 'A problem',
          body: said.body ?? 'It is a problem.',
          suggestion: said.suggestion ?? null,
          sources: [],
        }));
        const summary = script.summary ?? { verdict: 'Reviewed.', walkthrough: [] };
        const report = { findings, dropped: [], prior: [], summary };
        return Promise.resolve(answer(JSON.stringify(report), script.tokens));
      }
      if (role === 'verify') {
        const verdict = { verdict: 'confirmed', reason: 'The code shows it.' };
        return Promise.resolve(answer(JSON.stringify(verdict), script.tokens));
      }
      return Promise.resolve(answer('{"findings":[]}', script.tokens));
    };
    return { converse, providerKey: null };
  };
  return { deps: { pipelineFor }, roles };
}

/** What the oracle says of a case: the problems it seeds. */
const seededIn = (c: EvalCase): Said[] =>
  c.expected.map((p) => ({
    category: p.category,
    path: p.path,
    line: p.lines[0],
    endLine: p.lines[1],
  }));

/** The reviewer that finds exactly the problems a case seeds. */
const oracle = () => scripted({ said: seededIn });

/** The reviewer that finds nothing. */
const nothing = () => scripted({ said: () => [] });

// ─── Small cases of our own ──────────────────────────────────────────────────

const SOURCE = 'src/app.ts';

/** The lines `const line1 = 1;` to `const lineN = N;`. */
const linesOf = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `const line${i + 1} = ${i + 1};`);

/**
 * A case of one modified file of `lines`, of which the lines numbered `added` are the merge
 * request's: its head file, and the patch that adds those lines with three lines of context.
 */
function synthetic(o: {
  id: string;
  language?: string;
  lines?: string[];
  added?: number[];
  expected?: ExpectedProblem[];
  source?: string;
  title?: string;
  description?: string;
}): EvalCase {
  const lines = o.lines ?? linesOf(30);
  const added = o.added ?? [10, 14];
  const source = o.source ?? SOURCE;
  const from = Math.max(1, Math.min(...added) - 3);
  const to = Math.min(lines.length, Math.max(...added) + 3);
  const rows: string[] = [];
  let oldCount = 0;
  for (let n = from; n <= to; n += 1) {
    if (added.includes(n)) rows.push(`+${lines[n - 1]}`);
    else {
      rows.push(` ${lines[n - 1]}`);
      oldCount += 1;
    }
  }
  const patch = [
    `diff --git a/${source} b/${source}`,
    `--- a/${source}`,
    `+++ b/${source}`,
    `@@ -${from},${oldCount} +${from},${to - from + 1} @@`,
    ...rows,
    '',
  ].join('\n');
  const expected = o.expected ?? [];
  return {
    id: o.id,
    language: o.language ?? 'typescript',
    title: o.title ?? 'A change',
    description: o.description ?? 'It changes things.',
    clean: expected.length === 0,
    expected,
    files: { [source]: lines.map((line) => `${line}\n`).join('') },
    changes: [{ path: source, oldPath: null, status: 'modified', patch, since: null }],
  };
}

/** A seeded problem on these lines of the synthetic file. */
const problem = (
  line: number,
  category: AiCategory = 'logic',
  endLine = line,
  source = SOURCE,
): ExpectedProblem => ({ category, path: source, lines: [line, endLine] });

// ─── Cases written to a directory ────────────────────────────────────────────

interface CaseDir {
  caseJson: unknown;
  base: Record<string, string>;
  head: Record<string, string>;
  patch: string | null;
}

/** A patch of these lines, one to a line. */
const piece = (...lines: string[]): string => `${lines.join('\n')}\n`;
const PATCH = piece(
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' one',
  ' two',
  '+three',
);
const PATCH_OF_B = piece(
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1,2 @@',
  ' x',
  '+y',
);
const PATCH_ADDING_NEW = piece(
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1 @@',
  '+fresh',
);
const PATCH_DELETING_OLD = piece(
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
);

/** A small case that loads; each test changes one thing about it. */
const valid = (): CaseDir => ({
  caseJson: {
    language: 'typescript',
    title: 'Add a line',
    description: 'It adds a line.',
    clean: false,
    expected: [{ category: 'logic', path: 'src/a.ts', lines: [3, 3] }],
  },
  base: { 'src/a.ts': 'one\ntwo\n' },
  head: { 'src/a.ts': 'one\ntwo\nthree\n' },
  patch: PATCH,
});

function write(dir: CaseDir): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qualor-review-eval-'));
  tempDirs.push(root);
  const caseDir = path.join(root, 'the-case');
  const put = (relative: string, text: string) => {
    const file = path.join(caseDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  mkdirSync(caseDir, { recursive: true });
  put('case.json', typeof dir.caseJson === 'string' ? dir.caseJson : JSON.stringify(dir.caseJson));
  for (const [file, text] of Object.entries(dir.base)) put(`base/${file}`, text);
  for (const [file, text] of Object.entries(dir.head)) put(`head/${file}`, text);
  if (dir.patch !== null) put('patch.diff', dir.patch);
  return root;
}

const expectedOf = (dir: CaseDir) =>
  (dir.caseJson as { expected: Record<string, unknown>[] }).expected;

// ─── Loading the set ─────────────────────────────────────────────────────────

describe('the evaluation set', () => {
  it('every case loads and its patch matches head/', () => {
    const cases = loadCases(EVAL_DIR);
    // At least 12 cases, 4 of them clean, each of 1 to 4 files, in the four languages.
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((c) => c.clean).length).toBeGreaterThanOrEqual(4);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.language))).toEqual(
      new Set(['typescript', 'python', 'java', 'go']),
    );
    for (const c of cases) {
      const files = Object.keys(c.files);
      expect(files.length, c.id).toBeGreaterThanOrEqual(1);
      expect(files.length, c.id).toBeLessThanOrEqual(4);
      expect(c.changes.length, c.id).toBeGreaterThanOrEqual(1);
      expect(c.title, c.id).not.toBe('');
      // A clean case seeds nothing, and every other seeds something.
      expect(c.clean, c.id).toBe(c.expected.length === 0);
      for (const change of c.changes) expect(change.patch, c.id).not.toBeNull();
    }
    // Each language has a clean change, and the problems the plan names are all there.
    for (const language of ['typescript', 'python', 'java', 'go']) {
      expect(
        cases.some((c) => c.language === language && c.clean),
        language,
      ).toBe(true);
    }
    const categories = new Set(cases.flatMap((c) => c.expected.map((p) => p.category)));
    for (const category of ['logic', 'error-handling', 'security', 'concurrency'] as const) {
      expect(categories.has(category), category).toBe(true);
    }
  });

  it('keeps patch.diff as make-case.mjs builds it from base/ and head/', () => {
    for (const c of loadCases(EVAL_DIR)) {
      const dir = path.join(EVAL_DIR, c.id);
      expect(buildPatch(dir), c.id).toBe(readFileSync(path.join(dir, 'patch.diff'), 'utf8'));
    }
  }, 120_000);

  describe('make-case.mjs', () => {
    const script = path.join(import.meta.dirname, 'make-case.mjs');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

    it('writes the patch.diff of the case it is given', () => {
      const dir = valid();
      dir.patch = null;
      const caseDir = path.join(write(dir), 'the-case');

      const result = run(caseDir);

      expect(result.status).toBe(0);
      expect(readFileSync(path.join(caseDir, 'patch.diff'), 'utf8')).toBe(PATCH);
    });

    it('reads a file added, a file deleted and a case with no base/ at all', () => {
      const dir = valid();
      dir.base = { 'old.ts': 'gone\n' };
      dir.head = { 'new.ts': 'fresh\n' };
      expect(buildPatch(path.join(write(dir), 'the-case'))).toBe(
        PATCH_ADDING_NEW + PATCH_DELETING_OLD,
      );
      dir.base = {};
      expect(buildPatch(path.join(write(dir), 'the-case'))).toBe(PATCH_ADDING_NEW);
    });

    it('writes the patch as the snapshot carries it: no index lines, no function context', () => {
      const body = Array.from({ length: 20 }, (_, i) => `  call${i}();`);
      const dir = valid();
      const changed = body.map((line) => line.replace('call14', 'call14(1)'));
      dir.base = { 'src/a.ts': ['function alpha() {', ...body, '}', ''].join('\n') };
      dir.head = { 'src/a.ts': ['function alpha() {', ...changed, '}', ''].join('\n') };
      const patch: string = buildPatch(path.join(write(dir), 'the-case'));
      const hunks = patch.split('\n').filter((line) => line.startsWith('@@'));
      expect(hunks).toEqual(['@@ -13,7 +13,7 @@']);
      expect(patch).not.toMatch(/^index /m);
      expect(patch).toContain('+  call14(1)();');
    });

    it('--check passes on a patch.diff that is current and fails, writing nothing, on a stale one', () => {
      const caseDir = path.join(write(valid()), 'the-case');
      expect(run('--check', caseDir).status).toBe(0);

      writeFileSync(path.join(caseDir, 'head', 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n');
      const stale = run('--check', caseDir);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('stale:');
      expect(readFileSync(path.join(caseDir, 'patch.diff'), 'utf8')).toBe(PATCH);

      expect(run(caseDir).status).toBe(0);
      expect(run('--check', caseDir).status).toBe(0);
    });
  });

  describe('refuses a case that is wrong', () => {
    it('loads the case the others are made from', () => {
      const [loaded, ...rest] = loadCases(write(valid()));
      expect(rest).toEqual([]);
      expect(loaded).toMatchObject({
        id: 'the-case',
        language: 'typescript',
        title: 'Add a line',
        description: 'It adds a line.',
        clean: false,
        expected: [{ category: 'logic', path: 'src/a.ts', lines: [3, 3] }],
        files: { 'src/a.ts': 'one\ntwo\nthree\n' },
      });
      expect(loaded?.changes).toEqual([
        { path: 'src/a.ts', oldPath: null, status: 'modified', patch: PATCH, since: null },
      ]);
    });

    it('reads a file the patch adds and a file it deletes as such', () => {
      const dir = valid();
      dir.base['old.ts'] = 'gone\n';
      dir.head['new.ts'] = 'fresh\n';
      dir.patch = PATCH + PATCH_ADDING_NEW + PATCH_DELETING_OLD;
      const [loaded] = loadCases(write(dir));
      expect(loaded?.changes.map(({ path: p, status }) => [p, status])).toEqual([
        ['new.ts', 'added'],
        ['old.ts', 'deleted'],
        ['src/a.ts', 'modified'],
      ]);
      // Each change holds the piece of the patch that is its own.
      expect(loaded?.changes.find((c) => c.path === 'old.ts')?.patch).toBe(PATCH_DELETING_OLD);
    });

    const BROKEN: [string, (dir: CaseDir) => void, RegExp][] = [
      [
        'a hunk whose new-side lines differ from head/',
        (d) => {
          d.patch = PATCH.replace('+three', '+THREE');
        },
        /line 3 of src\/a\.ts differs from head\//,
      ],
      [
        'a hunk whose context differs from base/',
        (d) => {
          d.patch = PATCH.replace(' two', ' TWO');
        },
        /line 2 of src\/a\.ts in patch\.diff differs from base\//,
      ],
      [
        'a patch that leaves out a change of head/',
        (d) => {
          d.head['src/a.ts'] = 'one\ntwo\nthree\nfour\n';
        },
        /line 4 of src\/a\.ts differs from head\//,
      ],
      [
        'a patched file that is in neither base/ nor head/',
        (d) => {
          d.patch = PATCH + PATCH_OF_B;
        },
        /patch\.diff changes src\/b\.ts, which neither base\/ nor head\/ has changed/,
      ],
      [
        'a patched file missing from head/',
        (d) => {
          d.base['src/b.ts'] = 'x\n';
          d.patch = PATCH + PATCH_OF_B;
        },
        /the patch of src\/b\.ts has lines of the new side, but head\/ has no such file/,
      ],
      [
        'a file that differs between base/ and head/ and has no piece in the patch',
        (d) => {
          d.head['src/b.ts'] = 'new\n';
        },
        /patch\.diff has no change for src\/b\.ts, which differs between base\/ and head\//,
      ],
      [
        'no patch.diff',
        (d) => {
          d.patch = null;
        },
        /patch\.diff is missing/,
      ],
      [
        'a patch that is not a unified diff',
        (d) => {
          d.patch = PATCH.replace('@@ -1,2 +1,3 @@', '@@ nonsense @@');
        },
        /the patch of src\/a\.ts is not a unified diff/,
      ],
      [
        'a case.json that is not JSON',
        (d) => {
          d.caseJson = '{ "language": ';
        },
        /case\.json is not JSON/,
      ],
      [
        'a case.json without a title',
        (d) => {
          delete (d.caseJson as Record<string, unknown>)['title'];
        },
        /case\.json.*title/,
      ],
      [
        'a case.json with a category the review does not have',
        (d) => {
          expectedOf(d)[0]!['category'] = 'style';
        },
        /case\.json.*category/,
      ],
      [
        'a case.json with a key it does not define',
        (d) => {
          (d.caseJson as Record<string, unknown>)['notes'] = 'x';
        },
        /case\.json.*notes/,
      ],
      [
        'lines that end before they start',
        (d) => {
          expectedOf(d)[0]!['lines'] = [3, 2];
        },
        /case\.json.*lines/,
      ],
      [
        'a clean case that expects a problem',
        (d) => {
          (d.caseJson as Record<string, unknown>)['clean'] = true;
        },
        /case\.json.*clean/,
      ],
      [
        'a case that is not clean and expects nothing',
        (d) => {
          (d.caseJson as Record<string, unknown>)['expected'] = [];
        },
        /case\.json.*clean/,
      ],
      [
        'an expected path that is not in head/',
        (d) => {
          expectedOf(d)[0]!['path'] = 'src/missing.ts';
        },
        /expected path src\/missing\.ts is not in head\//,
      ],
      [
        'expected lines outside the file',
        (d) => {
          expectedOf(d)[0]!['lines'] = [3, 4];
        },
        /expected lines 3-4 of src\/a\.ts are outside the file/,
      ],
      [
        'a head/ without files',
        (d) => {
          d.head = {};
          d.base = {};
          d.patch = '';
          d.caseJson = { ...(d.caseJson as object), clean: true, expected: [] };
        },
        /head\/ has no files/,
      ],
    ];

    it.each(BROKEN)('%s', (_name, change, message) => {
      const dir = valid();
      change(dir);
      const root = write(dir);
      expect(() => loadCases(root)).toThrow(message);
      // The error names the case it is about.
      expect(() => loadCases(root)).toThrow(/^the-case: /);
    });

    it('lets a patch delete a file that head/ no longer has', () => {
      const dir = valid();
      dir.base['old.ts'] = 'gone\n';
      dir.patch = PATCH + PATCH_DELETING_OLD;
      expect(
        loadCases(write(dir))[0]
          ?.changes.map((c) => c.status)
          .sort(),
      ).toEqual(['deleted', 'modified']);
    });

    it('ignores what is not a case directory', () => {
      const root = write(valid());
      writeFileSync(path.join(root, 'README.md'), 'notes\n');
      expect(loadCases(root).map((c) => c.id)).toEqual(['the-case']);
    });
  });
});

// ─── Scoring a review ────────────────────────────────────────────────────────

describe('runEval over the evaluation set', () => {
  it('an oracle reviewer that returns the expected findings scores recall 1 and no false findings', async () => {
    const cases = loadCases(EVAL_DIR);
    const seeded = cases.reduce((sum, c) => sum + c.expected.length, 0);
    const clean = cases.filter((c) => c.clean).length;
    expect(seeded).toBeGreaterThanOrEqual(10);

    const report = await runEval(cases, oracle().deps);

    expect(report.cases).toBe(cases.length);
    expect(report.clean).toBe(clean);
    expect(report.reviews).toBe(cases.length);
    expect(report.failed).toEqual({});
    // Every seeded problem is on lines the review may raise findings on (the oracle's findings
    // are on exactly the lines of case.json), found with its category and anchored on its lines.
    expect(report.total).toEqual({
      problems: seeded,
      found: seeded,
      rightCategory: seeded,
      anchored: seeded,
      suggestions: 0,
      applying: 0,
      cleanReviews: clean,
      flagged: 0,
      falseFindings: 0,
    });
    // Each language is scored on its own cases, and they add up to the total.
    expect(Object.keys(report.languages).sort()).toEqual(['go', 'java', 'python', 'typescript']);
    for (const key of Object.keys(report.total) as (keyof Tally)[]) {
      const sum = Object.values(report.languages).reduce((total, tally) => total + tally[key], 0);
      expect(sum, key).toBe(report.total[key]);
    }
    for (const tally of Object.values(report.languages)) {
      expect(tally.found).toBe(tally.problems);
      expect(tally.flagged).toBe(0);
    }
  }, 120_000);

  it('a reviewer that returns nothing scores recall 0', async () => {
    const cases = loadCases(EVAL_DIR);
    const seeded = cases.reduce((sum, c) => sum + c.expected.length, 0);

    const report = await runEval(cases, nothing().deps);

    expect(report.failed).toEqual({});
    expect(report.total).toEqual({
      problems: seeded,
      found: 0,
      rightCategory: 0,
      anchored: 0,
      suggestions: 0,
      applying: 0,
      cleanReviews: cases.filter((c) => c.clean).length,
      flagged: 0,
      falseFindings: 0,
    });
  }, 120_000);
});

describe('runEval scores', () => {
  it('a reviewer that flags a clean case scores its findings as false findings', async () => {
    const flagged = synthetic({ id: 'flagged' });
    const quiet = synthetic({ id: 'quiet', language: 'python' });
    const seeded = synthetic({ id: 'seeded', expected: [problem(10)] });
    const { deps } = scripted({
      said: (c) =>
        c.id === 'flagged'
          ? [
              { category: 'logic', path: SOURCE, line: 10, endLine: 10 },
              { category: 'error-handling', path: SOURCE, line: 14, endLine: 14 },
            ]
          : [],
    });

    const report = await runEval([flagged, quiet, seeded], deps);

    expect(report.total).toMatchObject({
      cleanReviews: 2,
      flagged: 1,
      falseFindings: 2,
      problems: 1,
      found: 0,
    });
    expect(report.languages['typescript']).toMatchObject({ cleanReviews: 1, flagged: 1 });
    expect(report.languages['python']).toMatchObject({ cleanReviews: 1, flagged: 0 });
  });

  it('a finding within 3 lines of a problem finds it, one further off does not', async () => {
    const cases = ['near', 'far', 'elsewhere'].map((id) =>
      synthetic({ id, expected: [problem(10)] }),
    );
    // Line 13 is 3 lines past line 10; line 14 is 4. The third is in a file with no change.
    const where: Record<string, { path: string; line: number }> = {
      near: { path: SOURCE, line: 13 },
      far: { path: SOURCE, line: 14 },
      elsewhere: { path: 'src/else.ts', line: 10 },
    };
    const { deps } = scripted({
      said: (c) => {
        const at = where[c.id] ?? { path: SOURCE, line: 1 };
        return [{ category: 'logic', path: at.path, line: at.line, endLine: at.line }];
      },
    });

    const report = await runEval(cases, deps);

    expect(report.total).toMatchObject({ problems: 3, found: 1 });
  });

  it('a finding in another changed file does not find the problem, whatever its line', async () => {
    const problemFile = synthetic({ id: 'two-files', expected: [problem(10)] });
    const otherFile = synthetic({ id: 'unused', source: 'src/other.ts' });
    const both: EvalCase = {
      ...problemFile,
      files: { ...problemFile.files, ...otherFile.files },
      changes: [...problemFile.changes, ...otherFile.changes],
    };
    const { deps } = scripted({
      said: () => [{ category: 'logic', path: 'src/other.ts', line: 10, endLine: 10 }],
    });

    const report = await runEval([both], deps);

    expect(report.total).toMatchObject({ problems: 1, found: 0 });
  });

  it('refuses a case whose change the review does not look at, naming the case', async () => {
    const lockOnly = synthetic({ id: 'lock-only', source: 'package-lock.json' });
    const { deps } = nothing();

    await expect(runEval([lockOnly], deps)).rejects.toThrow(
      'lock-only: nothing in the patch is reviewed',
    );
  });

  it('reports the category of the finding apart from finding the problem', async () => {
    const wrong = synthetic({ id: 'wrong', expected: [problem(10, 'security')] });
    const right = synthetic({ id: 'right', expected: [problem(10, 'security')] });
    const { deps } = scripted({
      said: (c) => [
        { category: c.id === 'right' ? 'security' : 'logic', path: SOURCE, line: 10, endLine: 10 },
      ],
    });

    const report = await runEval([wrong, right], deps);

    expect(report.total).toMatchObject({ problems: 2, found: 2, rightCategory: 1 });
  });

  it('counts a problem found with its category when any finding on its lines has it', async () => {
    const seeded = synthetic({ id: 'two', expected: [problem(10, 'security')] });
    const { deps } = scripted({
      said: () => [
        { category: 'logic', path: SOURCE, line: 10, endLine: 10, title: 'A' },
        { category: 'security', path: SOURCE, line: 11, endLine: 11, title: 'B' },
      ],
    });

    const report = await runEval([seeded], deps);

    expect(report.total).toMatchObject({ problems: 1, found: 1, rightCategory: 1 });
  });

  it('scores the anchor of a finding by the lines of the problem widened by 3', async () => {
    // Lines 10 and 14 are the merge request's. The problem is on line 10, so its anchors are
    // lines 7 to 13. A finding on lines 11 to 14 meets them (11 to 13), yet its thread sits on
    // line 14, the only added line among its own.
    const on = synthetic({ id: 'on', expected: [problem(10)] });
    const off = synthetic({ id: 'off', expected: [problem(10)] });
    const { deps } = scripted({
      said: (c) => [
        {
          category: 'logic',
          path: SOURCE,
          line: c.id === 'on' ? 10 : 11,
          endLine: c.id === 'on' ? 10 : 14,
        },
      ],
    });

    const report = await runEval([on, off], deps);

    expect(report.total).toMatchObject({ problems: 2, found: 2, anchored: 1 });
  });

  it('scores the suggestions that pass the checks out of all the suggestions made', async () => {
    const seeded = synthetic({ id: 'seeded', expected: [problem(10)] });
    const clean = synthetic({ id: 'clean' });
    const on = (line: number, suggestion: Said['suggestion'], title: string): Said => ({
      category: 'logic',
      path: SOURCE,
      line,
      endLine: line,
      title,
      suggestion,
    });
    const rewrite = (line: number) => ({
      startLine: line,
      endLine: line,
      lines: [`const line${line} = ${line * 10};`],
    });
    const { deps } = scripted({
      said: (c) =>
        c.id === 'seeded'
          ? [
              // Two that replace an added line with other text.
              on(10, rewrite(10), 'Passes'),
              on(14, rewrite(14), 'Passes too'),
              // One that replaces a line the merge request did not add.
              on(10, rewrite(11), 'Over a context line'),
              // One that writes the line as it is.
              on(14, { startLine: 14, endLine: 14, lines: ['const line14 = 14;'] }, 'Unchanged'),
              // And a finding with no suggestion at all.
              on(14, null, 'No suggestion'),
            ]
          : [on(10, rewrite(10), 'Clean but wrong')],
    });

    const report = await runEval([seeded, clean], deps);

    expect(report.total.suggestions).toBe(5);
    expect(report.total.applying).toBe(3);
  });

  it('scores what the job posts: a suggestion more than 3 lines from its finding does not apply, and one kept moves its thread', async () => {
    // Lines 10 and 14 are the merge request's, and each case seeds a problem on line 10.
    const far = synthetic({ id: 'far', expected: [problem(10)] });
    const moved = synthetic({ id: 'moved', expected: [problem(10)] });
    const rewrite = (line: number) => ({
      startLine: line,
      endLine: line,
      lines: [`const line${line} = ${line * 10};`],
    });
    const { deps } = scripted({
      said: (c) =>
        c.id === 'far'
          ? // A suggestion for line 14 that passes the checks, but 4 lines from its finding: the
            // job drops it.
            [{ category: 'logic', path: SOURCE, line: 10, endLine: 10, suggestion: rewrite(14) }]
          : // On lines 11 to 14, whose only added line is 14, with a suggestion for line 10 that the
            // job keeps: the thread sits on its first line, 10.
            [{ category: 'logic', path: SOURCE, line: 11, endLine: 14, suggestion: rewrite(10) }],
    });

    const report = await runEval([far, moved], deps);

    expect(report.total).toMatchObject({
      problems: 2,
      found: 2,
      anchored: 2,
      suggestions: 2,
      applying: 1,
    });
  });

  it('counts a review that failed as one that found nothing, and says why', async () => {
    const seeded = synthetic({ id: 'down', expected: [problem(10)] });
    const clean = synthetic({ id: 'clean' });
    const { deps } = scripted({
      said: () => [],
      judge: () => ({
        kind: 'failed',
        reason: 'provider_error',
        inputTokens: 50,
        outputTokens: 0,
        turns: 0,
        toolCalls: 0,
      }),
    });

    const report = await runEval([seeded, clean], deps);

    expect(report.reviews).toBe(2);
    expect(report.failed).toEqual({ provider_error: 2 });
    expect(report.total).toMatchObject({ problems: 1, found: 0, cleanReviews: 1, flagged: 0 });
    // What the failed calls spent is counted all the same.
    expect(report.tokens.input).toBeGreaterThan(0);
  });

  it('counts the tokens of every call, and prices them only when it is given prices', async () => {
    const cases = ['one', 'two'].map((id) => synthetic({ id, expected: [problem(10)] }));
    const free = scripted({ said: seededIn, tokens: [2_000, 500] });
    const told: { input: number; output: number }[] = [];
    const without = await runEval(cases, {
      ...free.deps,
      progress: (_done, _total, tokens) => told.push(tokens),
    });
    const calls = free.roles.length;
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(without.tokens).toEqual({ input: 2_000 * calls, output: 500 * calls });
    expect(without.costUsd).toBeNull();
    // After each review the progress is told what was spent so far: the last time, all of it.
    expect(told).toHaveLength(2);
    expect(told[0]?.input).toBeLessThan(told[1]?.input ?? 0);
    expect(told.at(-1)).toEqual(without.tokens);

    const priced = scripted({ said: seededIn, tokens: [2_000, 500] });
    const report = await runEval(cases, {
      ...priced.deps,
      prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    });
    expect(report.costUsd).toBeCloseTo((2_000 * calls * 3 + 500 * calls * 15) / 1_000_000, 9);
  });

  it('measures the time of each review, and reports its min, median and max', async () => {
    const cases = ['a', 'b', 'c'].map((id) => synthetic({ id }));
    // Two readings of the clock for each review: 100, 300 and 200 ms.
    const readings = [0, 100, 1_000, 1_300, 5_000, 5_200];
    const { deps } = nothing();

    const report = await runEval(cases, { ...deps, now: () => readings.shift() ?? 0 });

    expect(report.latencyMs).toEqual({ min: 100, median: 200, max: 300 });
  });

  it('reviews every case as many times as it is asked to, and scores each review', async () => {
    const cases = [synthetic({ id: 'one', expected: [problem(10)] }), synthetic({ id: 'two' })];
    const { deps, roles } = scripted({
      said: (c) =>
        c.id === 'one' ? [{ category: 'logic', path: SOURCE, line: 10, endLine: 10 }] : [],
    });

    const progress: [number, number][] = [];

    const report = await runEval(cases, {
      ...deps,
      runs: 3,
      progress: (done, total) => progress.push([done, total]),
    });

    expect(progress).toEqual([1, 2, 3, 4, 5, 6].map((done) => [done, 6]));
    expect(report.runs).toBe(3);
    expect(report.reviews).toBe(6);
    expect(report.total).toMatchObject({ problems: 3, found: 3, cleanReviews: 3, flagged: 0 });
    expect(roles.filter((role) => role === 'judge')).toHaveLength(6);
  });

  it('gives the review the case as a merge request: its words, its changes and its files', async () => {
    const c = synthetic({ id: 'seen', title: 'The title', description: 'The description' });
    const readers: SnapshotReader[] = [];
    const { deps } = nothing();

    await runEval([c], {
      pipelineFor: (run) => {
        readers.push(run.reader);
        return deps.pipelineFor(run);
      },
    });

    const [reader] = readers;
    expect(reader?.meta).toMatchObject({
      snapshotId: null,
      mrTitle: 'The title',
      mrDescription: 'The description',
      sinceSha: null,
    });
    expect((await reader?.changes())?.map((change) => change.path)).toEqual([SOURCE]);
    expect(await reader?.file(SOURCE)).toEqual({ kind: 'text', text: c.files[SOURCE] });
  });
});

// ─── The report ──────────────────────────────────────────────────────────────

describe('the report', () => {
  it('the report holds no fixture text and no model text', async () => {
    const FIXTURE = 'FIXTURE-MARKER';
    const MODEL = 'MODEL-MARKER';
    const lines = linesOf(30).map((line, i) => `${line} // ${FIXTURE}-line-${i + 1}`);
    const source = `src/${FIXTURE}-path.ts`;
    const seeded = synthetic({
      id: `${FIXTURE}-id`,
      lines,
      source,
      title: `${FIXTURE} title`,
      description: `${FIXTURE} description`,
      expected: [problem(10, 'logic', 10, source)],
    });
    const clean = synthetic({ id: `${FIXTURE}-clean-id`, lines, source });
    const { deps } = scripted({
      said: () => [
        {
          category: 'logic',
          path: source,
          line: 10,
          endLine: 10,
          title: `${MODEL} title`,
          body: `${MODEL} body`,
          suggestion: { startLine: 10, endLine: 10, lines: [`const fixed = "${MODEL}-fix";`] },
        },
      ],
      summary: { verdict: `${MODEL} verdict`, walkthrough: [`${MODEL} walkthrough`] },
    });

    const report = await runEval([seeded, clean], {
      ...deps,
      prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    });

    // The markers did flow through the review: it found the problem, flagged the clean case and
    // made suggestions that apply.
    expect(report.total).toMatchObject({
      problems: 1,
      found: 1,
      flagged: 1,
      suggestions: 2,
      applying: 2,
    });
    const data = JSON.stringify(report);
    const text = formatReport(report);
    expect(text.length).toBeGreaterThan(100);
    for (const forbidden of [FIXTURE, MODEL, source, 'src/', 'const line', 'const fixed']) {
      expect(data, forbidden).not.toContain(forbidden);
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  const REPORT: EvalReport = {
    cases: 14,
    clean: 4,
    runs: 2,
    reviews: 28,
    failed: { provider_error: 2, bad_answer: 1 },
    total: {
      problems: 20,
      found: 15,
      rightCategory: 12,
      anchored: 10,
      suggestions: 8,
      applying: 6,
      cleanReviews: 8,
      flagged: 3,
      falseFindings: 4,
    },
    languages: {
      python: {
        problems: 14,
        found: 12,
        rightCategory: 9,
        anchored: 8,
        suggestions: 8,
        applying: 6,
        cleanReviews: 6,
        flagged: 3,
        falseFindings: 4,
      },
      go: {
        problems: 6,
        found: 3,
        rightCategory: 3,
        anchored: 2,
        suggestions: 0,
        applying: 0,
        cleanReviews: 2,
        flagged: 0,
        falseFindings: 0,
      },
    },
    tokens: { input: 1_234_567, output: 89_000 },
    costUsd: 4.3281,
    latencyMs: { min: 4_100, median: 6_250, max: 12_000 },
  };

  /** The cells of the table row that starts with `label`. */
  function row(text: string, label: string): string[] {
    const line = text.split('\n').find((l) => l.startsWith(label));
    expect(line, label).toBeDefined();
    return (line ?? '').trim().split(/\s{2,}/);
  }

  it('prints each score as x/y (p%), by language and in total', () => {
    const text = formatReport(REPORT);
    // language, recall, category, anchors, suggestions, false findings
    expect(row(text, 'go')).toEqual([
      'go',
      '3/6 (50%)',
      '3/3 (100%)',
      '2/3 (67%)',
      '0/0 (-)',
      '0/2 (0%)',
    ]);
    expect(row(text, 'python')).toEqual([
      'python',
      '12/14 (86%)',
      '9/12 (75%)',
      '8/12 (67%)',
      '6/8 (75%)',
      '3/6 (50%)',
    ]);
    expect(row(text, 'total')).toEqual([
      'total',
      '15/20 (75%)',
      '12/15 (80%)',
      '10/15 (67%)',
      '6/8 (75%)',
      '3/8 (38%)',
    ]);
    // The languages come in order, the total last.
    expect(text.indexOf('\ngo ')).toBeLessThan(text.indexOf('\npython '));
    expect(text.indexOf('\npython ')).toBeLessThan(text.indexOf('\ntotal '));
  });

  it('prints the cases, the failed reviews, the tokens, the cost and the latency', () => {
    const text = formatReport(REPORT);
    expect(text).toContain('14 cases (4 clean), 2 runs each, 28 reviews');
    expect(text).toContain('failed reviews: 3 (bad_answer 1, provider_error 2)');
    expect(text).toContain('findings on clean cases: 4');
    expect(text).toContain('tokens: 1,234,567 in, 89,000 out');
    expect(text).toContain('cost: $4.3281');
    expect(text).toContain('latency per review: min 4.1 s, median 6.3 s, max 12.0 s');
  });

  it('prints no cost without prices, no failures when none failed, no latency without reviews', () => {
    const text = formatReport({ ...REPORT, failed: {}, costUsd: null, latencyMs: null });
    expect(text).not.toContain('cost');
    expect(text).not.toContain('failed reviews');
    expect(text).not.toContain('latency');
    expect(text).toContain('tokens: 1,234,567 in');
  });
});
