import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SNAPSHOT_PATCH_BYTES } from '@qualor/shared';
import { diffHeaderLine, DiffSplitter } from '../../cli/src/git/diff';
import { AI_CATEGORIES, type AiCategory } from '../../server/src/db/schema';
import { buildReviewContext, type ReviewableChange } from '../../server/src/review/context';
import { planFindings, type PlannedFinding } from '../../server/src/review/findings';
import { MaskedFiles, type MaskBudget } from '../../server/src/review/masked-files';
import { Masker } from '../../server/src/review/masker';
import { parsePatch } from '../../server/src/review/patch';
import {
  reviewLimits,
  runReviewPipeline,
  type PipelineDeps,
} from '../../server/src/review/pipeline';
import { DEFAULT_REVIEW_BUDGETS } from '../../server/src/review/schema';
import {
  linesOf,
  memorySnapshotReader,
  type SnapshotChange,
  type SnapshotReader,
} from '../../server/src/review/snapshot-reader';
import { checkReviewSuggestion } from '../../server/src/review/suggestion';
import { newToolPolicy } from '../../server/src/review/tool-conversation';
import type { ToolPolicy } from '../../server/src/review/tools';

/*
 * Plan 6I-3 Task 14 (spec §12): the evaluation set of the AI review, and the harness that scores
 * a reviewer on it. A case is a small merge request written for this set: the files of the merge
 * base (`base/`) and of the head (`head/`), the patch between them (`patch.diff`, made from the two
 * by make-case.mjs), and `case.json`: what the merge request is called and says, whether it is
 * clean, and the problems it seeds.
 *
 * A review of a case is the server's own, minus the database: the case becomes a snapshot in memory,
 * the context is built from it (masked as the job masks it), the pipeline runs with the reviewer
 * the caller supplies (a script in the tests; the provider through pnpm review:live), and the
 * findings are placed as the job places them (planFindings). The scores are counts, never texts: a
 * report holds no line of a fixture and nothing a model said.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The evaluation set, as it is committed. */
export const EVAL_DIR = path.join(root, 'fixtures', 'review-eval');

/**
 * How far from the lines of a seeded problem a finding, or the thread of a finding, may be and
 * still be on it: the margin the review itself allows a finding around the lines it may raise
 * findings on.
 */
const TOLERANCE = 3;

/** The tokens one review may use: the default ceiling of a review in the AI review settings. */
const REVIEW_TOKENS = DEFAULT_REVIEW_BUDGETS.maxTokensPerReview;

// ─── The cases ───────────────────────────────────────────────────────────────

/** A problem a case seeds: its category, and the lines (inclusive, of the head file) it is on. */
export interface ExpectedProblem {
  category: AiCategory;
  path: string;
  lines: [number, number];
}

export interface EvalCase {
  /** The name of the case's directory. */
  id: string;
  language: string;
  /** What the merge request is called and says. */
  title: string;
  description: string;
  /** Nothing is wrong with it: any finding on it is a false one. */
  clean: boolean;
  expected: ExpectedProblem[];
  /** The head tree: the text of each file, by path. */
  files: Readonly<Record<string, string>>;
  /** What the merge request changed, one change for each file that differs, with its patch. */
  changes: SnapshotChange[];
}

type Fail = (message: string) => never;

interface CaseFile {
  language: string;
  title: string;
  description: string;
  clean: boolean;
  expected: ExpectedProblem[];
}

const CASE_KEYS: readonly string[] = ['language', 'title', 'description', 'clean', 'expected'];
const PROBLEM_KEYS: readonly string[] = ['category', 'path', 'lines'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCategory = (value: unknown): value is AiCategory =>
  AI_CATEGORIES.some((category) => category === value);

function textOf(raw: Record<string, unknown>, key: string, where: string, fail: Fail): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(`case.json: ${where}${key} must be a non-empty string`);
  }
  return value;
}

function problemOf(raw: unknown, index: number, fail: Fail): ExpectedProblem {
  const where = `expected[${index}]`;
  if (!isRecord(raw)) return fail(`case.json: ${where} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!PROBLEM_KEYS.includes(key)) fail(`case.json: ${where}.${key} is not a key of a problem`);
  }
  const { category, lines } = raw;
  if (!isCategory(category)) {
    return fail(`case.json: ${where}.category must be one of ${AI_CATEGORIES.join(', ')}`);
  }
  const wholeLine = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
  const [from, to] = Array.isArray(lines) && lines.length === 2 ? (lines as unknown[]) : [];
  if (!wholeLine(from) || !wholeLine(to) || to < from) {
    return fail(
      `case.json: ${where}.lines must be two line numbers from 1, the second not before the first`,
    );
  }
  return { category, path: textOf(raw, 'path', `${where}.`, fail), lines: [from, to] };
}

function parseCaseFile(text: string, fail: Fail): CaseFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('case.json is not JSON');
  }
  if (!isRecord(raw)) return fail('case.json must be an object');
  for (const key of Object.keys(raw)) {
    if (!CASE_KEYS.includes(key)) fail(`case.json: ${key} is not a key of a case`);
  }
  const { description, clean, expected } = raw;
  if (typeof description !== 'string') return fail('case.json: description must be a string');
  if (typeof clean !== 'boolean') return fail('case.json: clean must be true or false');
  if (!Array.isArray(expected)) return fail('case.json: expected must be a list');
  const problems = expected.map((item, index) => problemOf(item, index, fail));
  if (clean !== (problems.length === 0)) {
    return fail(
      'case.json: clean must be true for a case that expects nothing, false for any other',
    );
  }
  return {
    language: textOf(raw, 'language', '', fail),
    title: textOf(raw, 'title', '', fail),
    description,
    clean,
    expected: problems,
  };
}

/** The text files under `dir`, by path with `/`; none when there is no such directory. */
function readTree(dir: string): Map<string, string> {
  const tree = new Map<string, string>();
  if (!existsSync(dir)) return tree;
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    const relative = path.relative(dir, file).split(path.sep).join('/');
    tree.set(relative, readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
  }
  return tree;
}

/** A file that differs between base/ and head/, or is in only one of them. */
interface Changed {
  path: string;
  status: 'added' | 'deleted' | 'modified';
}

function changedFiles(base: ReadonlyMap<string, string>, head: ReadonlyMap<string, string>) {
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  return paths.flatMap((p): Changed[] => {
    const before = base.get(p);
    const after = head.get(p);
    if (before === undefined) return [{ path: p, status: 'added' }];
    if (after === undefined) return [{ path: p, status: 'deleted' }];
    return before === after ? [] : [{ path: p, status: 'modified' }];
  });
}

/** patch.diff cut into the piece of each file, by its `diff --git` line. */
function piecesOf(patch: string, fail: Fail): Map<string, string> {
  const pieces = new Map<string, string>();
  const splitter = new DiffSplitter(MAX_SNAPSHOT_PATCH_BYTES, (header, bytes) => {
    if (bytes === null) fail(`patch.diff: the piece for ${header} is over the snapshot's limit`);
    if (pieces.has(header)) fail(`patch.diff has two pieces for ${header}`);
    pieces.set(header, bytes.toString('utf8'));
  });
  splitter.push(Buffer.from(patch.replaceAll('\r\n', '\n'), 'utf8'));
  splitter.end();
  return pieces;
}

/**
 * Applies the patch of one file to its base/ lines, and compares what it makes with the head/ file
 * (null: no such file, as when the patch deletes it). The server's parser reads the patch.
 */
function checkPatchOf(
  p: string,
  piece: string,
  base: readonly string[] | null,
  head: readonly string[] | null,
  fail: Fail,
): void {
  const parsed = parsePatch(piece);
  if (parsed === null) return fail(`the patch of ${p} is not a unified diff`);
  const before = base ?? [];
  const made: string[] = [];
  let at = 0;
  for (const hunk of parsed.hunks) {
    // A hunk with no old line (`-5,0`) goes after the line its start names; any other starts at it.
    const oldRows = hunk.rows.filter((row) => row.kind !== '+').length;
    const copyTo = oldRows === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (copyTo < at || copyTo > before.length) {
      return fail(`the hunks of ${p} do not follow its lines in base/`);
    }
    for (const line of before.slice(at, copyTo)) made.push(line);
    at = copyTo;
    for (const row of hunk.rows) {
      if (row.kind === 'removed-marker') {
        return fail(`the patch of ${p} holds a removed-line marker`);
      }
      if (row.kind !== '+') {
        if (before[at] !== row.text) {
          return fail(`line ${at + 1} of ${p} in patch.diff differs from base/`);
        }
        at += 1;
      }
      if (row.kind !== '-') made.push(row.text);
    }
  }
  for (const line of before.slice(at)) made.push(line);
  if (head === null) {
    if (made.length > 0) {
      fail(`the patch of ${p} has lines of the new side, but head/ has no such file`);
    }
    return;
  }
  for (let i = 0; i < Math.max(made.length, head.length); i += 1) {
    if (made[i] !== head[i]) return fail(`line ${i + 1} of ${p} differs from head/`);
  }
}

function readCase(dir: string, id: string): EvalCase {
  const fail: Fail = (message) => {
    throw new Error(`${id}: ${message}`);
  };
  const caseFile = path.join(dir, 'case.json');
  if (!existsSync(caseFile)) return fail('case.json is missing');
  const file = parseCaseFile(readFileSync(caseFile, 'utf8'), fail);

  const head = readTree(path.join(dir, 'head'));
  if (head.size === 0) return fail('head/ has no files');
  for (const problem of file.expected) {
    const text = head.get(problem.path);
    if (text === undefined) return fail(`expected path ${problem.path} is not in head/`);
    const count = linesOf(text).length;
    if (problem.lines[1] > count) {
      return fail(
        `expected lines ${problem.lines[0]}-${problem.lines[1]} of ${problem.path} are outside the file (${count} lines)`,
      );
    }
  }

  const patchFile = path.join(dir, 'patch.diff');
  if (!existsSync(patchFile)) return fail('patch.diff is missing');
  const base = readTree(path.join(dir, 'base'));
  const changed = changedFiles(base, head);
  const byHeader = new Map(changed.map((c) => [diffHeaderLine(c.path, c.path), c]));
  const changes = new Map<string, SnapshotChange>();
  for (const [header, piece] of piecesOf(readFileSync(patchFile, 'utf8'), fail)) {
    const c = byHeader.get(header);
    if (c === undefined) {
      const named = /^diff --git a\/(.+) b\/.+$/.exec(header)?.[1] ?? header;
      return fail(`patch.diff changes ${named}, which neither base/ nor head/ has changed`);
    }
    const before = base.get(c.path);
    const after = head.get(c.path);
    checkPatchOf(
      c.path,
      piece,
      before === undefined ? null : linesOf(before),
      after === undefined ? null : linesOf(after),
      fail,
    );
    changes.set(c.path, {
      path: c.path,
      oldPath: null,
      status: c.status,
      patch: piece,
      since: null,
    });
  }
  for (const c of changed) {
    if (!changes.has(c.path)) {
      return fail(`patch.diff has no change for ${c.path}, which differs between base/ and head/`);
    }
  }
  return {
    id,
    language: file.language,
    title: file.title,
    description: file.description,
    clean: file.clean,
    expected: file.expected,
    files: Object.fromEntries(head),
    changes: [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/**
 * The cases under `dir`, one for each directory, in the order of their names. A case that is wrong
 * fails the load, with its name: a `case.json` the schema does not accept, an
 * expected problem outside `head/`, a patch that does not make `head/` from `base/` (a hunk whose
 * lines differ from either, a changed file with no change in the patch, a patched file that
 * neither tree has changed), or no patch. A file the patch deletes needs no file in `head/`.
 */
export function loadCases(dir: string): EvalCase[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => readCase(path.join(dir, id), id));
}

// ─── Reviewing a case ────────────────────────────────────────────────────────

/** What a reviewer of one case is given besides the data of its conversations. */
export interface CaseRun {
  readonly evalCase: EvalCase;
  /** The case as a snapshot: what the review's tools read. */
  readonly reader: SnapshotReader;
  /** The tools' policy and budget, shared by every conversation of the review. */
  readonly policy: ToolPolicy;
}

export interface EvalDeps {
  /**
   * The pipeline's dependencies for one case: `converse` is one conversation of a role. The
   * evaluation counts the tokens of every conversation it returns.
   */
  pipelineFor(run: CaseRun): PipelineDeps;
  /** Times each case is reviewed; 1 when left out. */
  runs?: number;
  /** USD for a million tokens; the report has a cost only with prices. */
  prices?: { inputUsdPerMTok: number; outputUsdPerMTok: number } | null;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** Told after each review: how many are done, of how many. */
  progress?: (done: number, total: number) => void;
}

/** A finding the review would store, as the evaluation reads it. */
interface Found {
  category: AiCategory;
  path: string;
  line: number;
  endLine: number;
  /** The added line its thread sits on; null when none is near. */
  anchorLine: number | null;
  suggested: boolean;
  /** Its suggestion passes the review's checks against the masked head file. */
  applies: boolean;
}

type Review =
  | { kind: 'reviewed'; found: Found[]; input: number; output: number }
  | { kind: 'failed'; reason: string; input: number; output: number };

/** The merge request's meta: the case's words, and no earlier review. */
const metaOf = (c: EvalCase) => ({
  snapshotId: null,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  sinceSha: null,
  targetBranch: 'main',
  mrTitle: c.title,
  mrDescription: c.description === '' ? null : c.description,
  instructions: [],
  partial: false,
});

/** The masked text of a head file, as the job reads it when the context did not keep it. */
async function maskedText(files: MaskedFiles, filePath: string, budget: MaskBudget) {
  const file = await files.file(filePath, budget);
  return file.kind === 'text' ? file.text : null;
}

async function foundOf(
  planned: PlannedFinding,
  files: MaskedFiles,
  budget: MaskBudget,
): Promise<Found> {
  const { finding, change, anchorLine } = planned;
  const suggestion = finding.suggestion;
  let applies = false;
  if (suggestion !== null && change !== undefined) {
    const head: ReviewableChange['text'] =
      change.text ?? (await maskedText(files, finding.path, budget));
    applies = checkReviewSuggestion(suggestion, { ...change, text: head }).ok;
  }
  return {
    category: finding.category,
    path: finding.path,
    line: finding.line,
    endLine: finding.endLine,
    anchorLine,
    suggested: suggestion !== null,
    applies,
  };
}

const NO_FINDINGS = { analyzer: () => Promise.resolve([]), prior: [] };

/**
 * One review of a case, as the job makes one without a database: the snapshot in memory, its files
 * masked by a masker of the review's own, the context, the pipeline, and the findings it would
 * store (planFindings).
 */
async function reviewCase(c: EvalCase, deps: EvalDeps): Promise<Review> {
  const reader = memorySnapshotReader({
    meta: metaOf(c),
    changes: c.changes,
    files: Object.fromEntries(
      Object.entries(c.files).map(([p, text]) => [p, { kind: 'text' as const, text }]),
    ),
  });
  const masker = new Masker();
  try {
    const files = new MaskedFiles(reader, { masker });
    const policy = newToolPolicy({ excludePaths: [], masked: files, masker });
    const context = await buildReviewContext(files, masker, NO_FINDINGS, {
      excluded: () => false,
      budget: policy.budget,
      limits: (shape) => {
        if (shape.reviewed.length === 0) {
          throw new Error(`${c.id}: nothing in the patch is reviewed`);
        }
        return reviewLimits(shape, REVIEW_TOKENS);
      },
    });
    const pipeline = deps.pipelineFor({ evalCase: c, reader, policy });
    const spent = { input: 0, output: 0 };
    const outcome = await runReviewPipeline(
      context,
      REVIEW_TOKENS,
      {
        providerKey: pipeline.providerKey,
        converse: async (...args) => {
          const result = await pipeline.converse(...args);
          spent.input += result.inputTokens;
          spent.output += result.outputTokens;
          return result;
        },
      },
      () => Promise.resolve(),
    );
    if (outcome.kind !== 'reviewed') {
      const reason = outcome.kind === 'failed' ? outcome.reason : outcome.kind;
      return { kind: 'failed', reason, ...spent };
    }
    const found: Found[] = [];
    for (const planned of planFindings(context, outcome).creates) {
      found.push(await foundOf(planned, files, policy.budget));
    }
    return { kind: 'reviewed', found, ...spent };
  } finally {
    await masker.close();
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * The counts a score is made of, for the reviews of some cases. Each metric is a ratio of two of
 * them, `x/y`.
 */
export interface Tally {
  /** Seeded problems, in all the reviews. */
  problems: number;
  /** ...with a finding on their lines (widened by 3) in the review of their case. */
  found: number;
  /** ...of those found, with a finding of their category. */
  rightCategory: number;
  /** ...of those found, with a finding whose thread sits on their lines (widened by 3). */
  anchored: number;
  /** Suggestions the review made, in findings it would store. */
  suggestions: number;
  /** ...of them, the ones that pass the review's checks. */
  applying: number;
  /** Reviews of clean cases. */
  cleanReviews: number;
  /** ...of them, the ones that raised a finding. */
  flagged: number;
  /** The findings raised on clean cases. */
  falseFindings: number;
}

const emptyTally = (): Tally => ({
  problems: 0,
  found: 0,
  rightCategory: 0,
  anchored: 0,
  suggestions: 0,
  applying: 0,
  cleanReviews: 0,
  flagged: 0,
  falseFindings: 0,
});

function addTally(into: Tally, from: Tally): void {
  for (const key of Object.keys(into) as (keyof Tally)[]) into[key] += from[key];
}

/** A finding is on a problem when it is in its file and its lines meet the problem's, widened. */
const onProblem = (f: Found, p: ExpectedProblem): boolean =>
  f.path === p.path && f.line <= p.lines[1] + TOLERANCE && f.endLine >= p.lines[0] - TOLERANCE;

const nearProblem = (line: number, p: ExpectedProblem): boolean =>
  line >= p.lines[0] - TOLERANCE && line <= p.lines[1] + TOLERANCE;

/** What one review of `c` scores, given the findings it would store. */
function scoreReview(c: EvalCase, found: readonly Found[]): Tally {
  const tally = emptyTally();
  for (const problem of c.expected) {
    tally.problems += 1;
    const hits = found.filter((f) => onProblem(f, problem));
    if (hits.length === 0) continue;
    tally.found += 1;
    if (hits.some((f) => f.category === problem.category)) tally.rightCategory += 1;
    if (hits.some((f) => f.anchorLine !== null && nearProblem(f.anchorLine, problem))) {
      tally.anchored += 1;
    }
  }
  if (c.clean) {
    tally.cleanReviews = 1;
    tally.flagged = found.length > 0 ? 1 : 0;
    tally.falseFindings = found.length;
  }
  for (const f of found) {
    if (!f.suggested) continue;
    tally.suggestions += 1;
    if (f.applies) tally.applying += 1;
  }
  return tally;
}

export interface EvalReport {
  cases: number;
  clean: number;
  /** Times each case was reviewed. */
  runs: number;
  /** Reviews made: cases times runs. */
  reviews: number;
  /** Reviews that failed and so found nothing, by the reason the pipeline gave. */
  failed: Record<string, number>;
  total: Tally;
  /** The same counts for the cases of each language. */
  languages: Record<string, Tally>;
  tokens: { input: number; output: number };
  /** USD; null without prices. */
  costUsd: number | null;
  /** Milliseconds a review took; null without reviews. */
  latencyMs: { min: number; median: number; max: number } | null;
}

function spread(values: readonly number[]): EvalReport['latencyMs'] {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    median: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Reviews every case `deps.runs` times, one after the other, and scores the reviews: how many
 * seeded problems have a finding on them, with their category and with their thread on their lines;
 * how many suggestions pass the checks; how many clean cases got a finding; and what the reviews
 * spent. A review that fails finds nothing, and is counted as failed with the reason.
 */
export async function runEval(cases: readonly EvalCase[], deps: EvalDeps): Promise<EvalReport> {
  const runs = deps.runs ?? 1;
  const now = deps.now ?? (() => performance.now());
  const report: EvalReport = {
    cases: cases.length,
    clean: cases.filter((c) => c.clean).length,
    runs,
    reviews: cases.length * runs,
    failed: {},
    total: emptyTally(),
    languages: {},
    tokens: { input: 0, output: 0 },
    costUsd: null,
    latencyMs: null,
  };
  const latencies: number[] = [];
  let done = 0;
  for (let run = 0; run < runs; run += 1) {
    for (const c of cases) {
      const started = now();
      const review = await reviewCase(c, deps);
      latencies.push(now() - started);
      report.tokens.input += review.input;
      report.tokens.output += review.output;
      if (review.kind === 'failed') {
        report.failed[review.reason] = (report.failed[review.reason] ?? 0) + 1;
      }
      const score = scoreReview(c, review.kind === 'reviewed' ? review.found : []);
      addTally(report.total, score);
      addTally((report.languages[c.language] ??= emptyTally()), score);
      done += 1;
      deps.progress?.(done, report.reviews);
    }
  }
  report.latencyMs = spread(latencies);
  if (deps.prices !== undefined && deps.prices !== null) {
    report.costUsd =
      (report.tokens.input * deps.prices.inputUsdPerMTok +
        report.tokens.output * deps.prices.outputUsdPerMTok) /
      1_000_000;
  }
  return report;
}

// ─── Printing ────────────────────────────────────────────────────────────────

/** `x/y (p%)`; `(-)` without a y. */
const ratio = (x: number, y: number): string =>
  `${x}/${y} (${y === 0 ? '-' : `${Math.round((100 * x) / y)}%`})`;

const COLUMNS = ['recall', 'category', 'anchors', 'suggestions', 'false findings'];

const cellsOf = (t: Tally): string[] => [
  ratio(t.found, t.problems),
  ratio(t.rightCategory, t.found),
  ratio(t.anchored, t.found),
  ratio(t.applying, t.suggestions),
  ratio(t.flagged, t.cleanReviews),
];

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const count = (n: number): string => n.toLocaleString('en-US');

/**
 * The report as text, aggregates only: the scores by language and in total, the tokens, the cost
 * when there are prices, and the time of a review. It holds no line of a fixture, no path of a
 * seeded problem and nothing a model said; the report it is made from holds none either.
 */
export function formatReport(report: EvalReport): string {
  const rows: string[][] = [
    ['', ...COLUMNS],
    ...Object.keys(report.languages)
      .sort()
      .map((language) => [language, ...cellsOf(report.languages[language] ?? emptyTally())]),
    ['total', ...cellsOf(report.total)],
  ];
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0)));
  const table = rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd(),
  );
  const failed = Object.entries(report.failed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const failedCount = failed.reduce((sum, [, n]) => sum + n, 0);
  const failedWhy = failed.map(([reason, n]) => `${reason} ${n}`).join(', ');
  const latency = report.latencyMs;
  const lines = [
    'AI review evaluation',
    `${report.cases} cases (${report.clean} clean), ${report.runs} run${report.runs === 1 ? '' : 's'} each, ${report.reviews} reviews`,
    ...(failedCount === 0 ? [] : [`failed reviews: ${failedCount} (${failedWhy})`]),
    '',
    ...table,
    '',
    `findings on clean cases: ${report.total.falseFindings}`,
    `tokens: ${count(report.tokens.input)} in, ${count(report.tokens.output)} out`,
    ...(report.costUsd === null ? [] : [`cost: $${report.costUsd.toFixed(4)}`]),
    ...(latency === null
      ? []
      : [
          `latency per review: min ${seconds(latency.min)}, median ${seconds(latency.median)}, max ${seconds(latency.max)}`,
        ]),
    '',
    `recall: seeded problems with a finding on their lines, or within ${TOLERANCE} lines of them`,
    'category: of those, the problems with a finding of their category',
    `anchors: of those, the problems with a finding whose thread sits on their lines, or within ${TOLERANCE} lines`,
    'suggestions: suggestions that pass the review checks, of all those made',
    'false findings: reviews of a clean case that raised a finding',
  ];
  return lines.join('\n');
}
