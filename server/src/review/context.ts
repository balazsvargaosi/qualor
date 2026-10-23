import { cutAtGrapheme } from '@qualor/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import {
  AI_CATEGORIES,
  analyses,
  issues,
  reviewFindings,
  rules,
  type AiCategory,
} from '../db/schema';
import type { MaskedFiles, MaskedText } from './masked-files';
import type { Masker } from './masker';
import { AI_ENGINE } from './rules';
import type { SnapshotChange, SnapshotMeta } from './snapshot-reader';

/*
 * What a review is shown of a merge request: which of its changes are reviewed, the diff slices
 * printed with the real new-side line numbers (so that the model copies a number instead of
 * counting lines), the findings the analyzers already made and the ones an earlier review made,
 * and the merge request's own words and instructions files.
 *
 * Every text of the repository that reaches a prompt through here is masked as a whole text (llm.md
 * §5.2) before any of it is cut: a file through the review's MaskedFiles, the same instance the
 * tools read, so that it is masked once and the lines the slices print are the lines read_file
 * shows; the patches, the instructions, the title, the description and the findings through the
 * review's Masker, off the thread that serves requests. A text the Masker gives up on (it took too
 * long, or the review has spent its time for masking) is left out with a fixed note; nothing is
 * ever masked a slice at a time. The raw patch stays in a change for the digest of the diff and is
 * never printed.
 */

// ─── What is read, and how much of it ────────────────────────────────────────

/** Lines of context kept on each side of a change. */
const CONTEXT_LINES = 40;
/** The most characters of slices in a prompt. */
const SLICE_BUDGET_CHARS = 120_000;
/** The most changes listed as having no slices; a merge request can change tens of thousands. */
const MAX_OMITTED_LISTED = 200;
/** A line is cut here, with `…`. */
const MAX_LINE_CHARS = 400;
const MAX_ANALYZER_FINDINGS = 100;
const ANALYZER_MESSAGE_CHARS = 300;
const PRIOR_BODY_CHARS = 500;
const INSTRUCTIONS_CHARS = 32_000;
const TITLE_CHARS = 255;
const DESCRIPTION_CHARS = 4_000;
/** A marker line stands for this many removed lines at most: a number in a patch is not trusted. */
const MAX_MARKER_LINES = 1_000_000;
/** The lines at the head of a file that say it is generated, and the ones that say it is minified. */
const GENERATED_HEAD_LINES = 5;
const MINIFIED_HEAD_LINES = 50;
const MINIFIED_AVERAGE_CHARS = 300;
const MINIFIED_LONG_LINE_CHARS = 1_000;

/**
 * A path with one of these words in a segment, in any case, looks like security-sensitive code.
 * Deliberately loose (`processor` has `sso` in it): a hit only adds a reviewer, and a miss costs more.
 */
export const SENSITIVE_PATH =
  /(?:auth|authn|authz|oauth|saml|sso|jwt|token|secret|passw|credential|crypt|cipher|permission|acl|rbac|session|login|csrf|saniti[sz]|escap)/i;

const LOCK_FILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'go.sum',
  'packages.lock.json',
  'gradle.lockfile',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
  'Podfile.lock',
]);
const MINIFIED_NAME = /\.(?:min\.js|min\.css|bundle\.js)$/i;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Why a change is not reviewed. A change with no patch and no text is read as `binary`. */
export type SkipReason = 'lock' | 'generated' | 'minified' | 'binary';
export interface SkippedChange {
  path: string;
  why: SkipReason;
}

/**
 * Why the slices of a reviewed change are not cut: the change deleted the file (no slices by
 * design), the snapshot has no text of the file, the patch does not parse or does not fit the
 * file, or the file could not be masked (it took too long, or the review has no time left for it).
 */
export type Unshown = 'deleted' | 'no_text' | 'unreadable' | 'timeout' | 'budget';

/** A line the change removed: the new-side line it follows (0: before the first), as the model sees it. */
export interface RemovedLine {
  after: number;
  /** The masked line, or a fixed note for lines that could not be masked. */
  text: string;
}

/**
 * A change that is reviewed. Everything in it that is text of the repository, the head file and
 * the removed lines, is masked; `patch` is the snapshot's, for the digest of the diff, and is
 * never shown.
 */
export interface ReviewableChange extends SnapshotChange {
  /** The head file masked as a whole, the text read_file shows; null when there is none to show. */
  text: MaskedText | null;
  /** The new-side lines the change adds. */
  added: ReadonlySet<number>;
  /** Lines added plus lines removed; the file's length when the patch says nothing. */
  changedLines: number;
  sensitive: boolean;
  /** The lines the change removed, in the order of the patch. */
  removed: readonly RemovedLine[];
  /** Why there are no slices of it, or null. */
  unshown: Unshown | null;
}

export interface AnalyzerFinding {
  ruleKey: string;
  severity: string;
  message: string;
  path: string;
  line: number | null;
}

export interface PriorFinding {
  id: string;
  category: AiCategory;
  severity: string;
  status: 'open' | 'false_positive' | 'wont_fix';
  path: string;
  line: number;
  endLine: number;
  title: string;
  body: string;
  fingerprint: string;
}

export interface ContextOptions {
  /**
   * The administrator's "never send these paths" (llm.md §3.2), as the tools apply it. A change,
   * a finding or an instructions file on one is left out of what the model is shown, and its
   * file is not read.
   */
  excluded?: (path: string) => boolean;
}

export interface ReviewContext {
  /**
   * The snapshot's meta with what the prompt may show of it: `mrTitle`, `mrDescription` and
   * `instructions` are masked, cut and labelled (the raw texts are in the reader only).
   */
  meta: SnapshotMeta;
  reviewed: ReviewableChange[];
  skipped: SkippedChange[];
  /** The slices of the reviewed changes that fit, the most important first. */
  slices: string;
  /** The changes with no slices in `slices`, each with what to do about it. */
  omittedFromSlices: string[];
  analyzer: AnalyzerFinding[];
  prior: PriorFinding[];
  /**
   * Secrets replaced in what the prompt shows. Only for the record of the spend: it depends on what
   * the tools masked, and is never shown to a person.
   */
  redactions: number;
}

// ─── Notes for what could not be shown ───────────────────────────────────────

const WHY = {
  timeout: 'it could not be masked in time',
  budget: 'the review has used up the time it may spend masking',
  unreadable: 'its masked text could not be read',
} as const;
type NoteReason = keyof typeof WHY;

const notShown = (why: NoteReason): string => `[not shown: ${WHY[why]}]`;
const removedNote = (lines: number, why: NoteReason): string =>
  `[${lines} removed line${lines === 1 ? '' : 's'} not shown: ${WHY[why]}]`;
const linesOf = (count: number): string => `${count} line${count === 1 ? '' : 's'}`;

// ─── Unified diffs ───────────────────────────────────────────────────────────

export interface PatchRow {
  /** `removed-marker` is the scanner's line for removed lines it did not send (`-[3 removed lines not sent]`). */
  kind: '+' | '-' | ' ' | 'removed-marker';
  /** The line on the new side; null for a removed row. */
  newLine: number | null;
  text: string;
}
export interface PatchHunk {
  oldStart: number;
  newStart: number;
  rows: PatchRow[];
}
export interface ParsedPatch {
  hunks: PatchHunk[];
  /** The new-side lines the patch adds. */
  added: Set<number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const REMOVED_MARKER = /^\[(\d+) removed lines? not sent\]$/;

/** A number of a hunk header, or `missing` when it was left out; null when it is too large to count with. */
function headerNumber(digits: string | undefined, missing: number): number | null {
  if (digits === undefined) return missing;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads the patch of one file (`git diff -U3`: the header lines, then hunks), numbering the rows
 * of the new side: an added or a context row has its line, a removed row none. The lines outside
 * a hunk (the headers, a second piece of a type change) are not read. A line that is empty where
 * a context line is due is a blank context line: that is how git writes it with
 * `diff.suppressBlankEmpty`, which the scanner's git may have set. Null when the text is not a
 * unified diff: a hunk header that does not parse, a row that is not a row, or a hunk shorter than
 * its header says.
 */
export function parsePatch(patch: string): ParsedPatch | null {
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunks: PatchHunk[] = [];
  const added = new Set<number>();
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? '';
    at += 1;
    if (!line.startsWith('@@')) continue;
    const header = HUNK_HEADER.exec(line);
    if (header === null) return null;
    const oldStart = headerNumber(header[1], 0);
    const oldCount = headerNumber(header[2], 1);
    const newStart = headerNumber(header[3], 0);
    const newCount = headerNumber(header[4], 1);
    if (oldStart === null || oldCount === null || newStart === null || newCount === null) {
      return null;
    }
    // Lines are numbered from 1: only a hunk with no new line is placed at 0 (`+0,0`).
    if (newStart === 0 && newCount > 0) return null;
    let oldLeft = oldCount;
    let newLeft = newCount;
    let newLine = newStart;
    const rows: PatchRow[] = [];
    while (oldLeft > 0 || newLeft > 0) {
      const body = lines[at];
      if (body === undefined) return null;
      at += 1;
      const mark = body.charAt(0);
      const text = body.endsWith('\r') ? body.slice(1, -1) : body.slice(1);
      if (mark === '\\') continue;
      if (mark === '+') {
        if (newLeft === 0) return null;
        newLeft -= 1;
        rows.push({ kind: '+', newLine, text });
        added.add(newLine);
        newLine += 1;
      } else if (mark === '-') {
        if (oldLeft === 0) return null;
        oldLeft -= 1;
        rows.push({
          kind: REMOVED_MARKER.test(text) ? 'removed-marker' : '-',
          newLine: null,
          text,
        });
      } else if (mark === ' ' || body === '') {
        if (oldLeft === 0 || newLeft === 0) return null;
        oldLeft -= 1;
        newLeft -= 1;
        rows.push({ kind: ' ', newLine, text });
        newLine += 1;
      } else {
        return null;
      }
    }
    hunks.push({ oldStart, newStart, rows });
  }
  return { hunks, added };
}

/** A removed row, where it was, and what it says. */
interface Removal {
  after: number;
  kind: '-' | 'removed-marker';
  text: string;
}

/**
 * The removed rows of a patch, each with the new-side line it follows. A hunk that has no new-side
 * line (`+4,0`) names that line itself; any other starts after the line before its first.
 */
function removalsOf(patch: ParsedPatch): Removal[] {
  const removals: Removal[] = [];
  for (const hunk of patch.hunks) {
    let after = hunk.rows.some((row) => row.newLine !== null) ? hunk.newStart - 1 : hunk.newStart;
    for (const row of hunk.rows) {
      if (row.newLine !== null) after = row.newLine;
      else if (row.kind === '-' || row.kind === 'removed-marker') {
        removals.push({ after, kind: row.kind, text: row.text });
      }
    }
  }
  return removals;
}

/** The lines a removed row stands for: one, or the number a marker line names. */
function linesRemoved(removal: Removal): number {
  if (removal.kind === '-') return 1;
  return Math.min(Number(/\d+/.exec(removal.text)?.[0] ?? 1), MAX_MARKER_LINES);
}

/** Whether a patch has a row on a line past the end of a file of `lines` lines. */
function reachesPast(patch: ParsedPatch, removals: readonly Removal[], lines: number): boolean {
  for (const hunk of patch.hunks) {
    for (const row of hunk.rows) if (row.newLine !== null && row.newLine > lines) return true;
  }
  return removals.some((removal) => removal.after > lines);
}

/** What the structure of a change says: independent of any masking, as it holds numbers only. */
interface PatchFacts {
  added: Set<number>;
  removals: Removal[];
  changedLines: number;
  /** False when the change has a patch that cannot be read. */
  readable: boolean;
}

/**
 * The lines a change adds and removes. With no patch, or one that does not parse or does not fit
 * the file, the file is all there is: a new file is all added, any other counts as long as the file
 * is and adds nothing that can be named.
 */
function readPatch(change: SnapshotChange, text: MaskedText | null): PatchFacts {
  const parsed = change.patch === null ? null : parsePatch(change.patch);
  if (parsed !== null) {
    const removals = removalsOf(parsed);
    if (text === null || !reachesPast(parsed, removals, text.lineCount)) {
      const removed = removals.reduce((sum, removal) => sum + linesRemoved(removal), 0);
      return {
        added: parsed.added,
        removals,
        changedLines: parsed.added.size + removed,
        readable: true,
      };
    }
  }
  const lines = text?.lineCount ?? 0;
  const added = new Set<number>();
  if (change.status === 'added') for (let line = 1; line <= lines; line += 1) added.add(line);
  return { added, removals: [], changedLines: lines, readable: change.patch === null };
}

// ─── Masking the patch ───────────────────────────────────────────────────────

/**
 * The patch as masked, with each row's diff prefix put back where the masking took it with the
 * line (a private key's lines are replaced whole, `-` included), so that it parses as the original
 * does. Null when the masking did not keep the lines.
 */
function withDiffPrefixes(patch: string, masked: string): string | null {
  const original = patch.split('\n');
  const shown = masked.split('\n');
  if (shown.length < original.length) return null;
  return original
    .map((line, i) => {
      const out = shown[i] ?? '';
      const mark = line.charAt(0);
      return (mark === '+' || mark === '-' || mark === ' ') && !out.startsWith(mark)
        ? `${mark}${out}`
        : out;
    })
    .join('\n');
}

/** A run of removed rows that could not be shown as one note; a marker line is the scanner's own text. */
function noteRuns(removals: readonly Removal[], why: NoteReason): RemovedLine[] {
  const out: RemovedLine[] = [];
  /** Where the note of the run being counted is in `out` (-1 when there is none), and what it counts. */
  let runAt = -1;
  let runAfter = 0;
  let runLines = 0;
  for (const removal of removals) {
    if (removal.kind === 'removed-marker') {
      out.push({ after: removal.after, text: removal.text });
      runAt = -1;
    } else if (runAt >= 0 && runAfter === removal.after) {
      runLines += 1;
      out[runAt] = { after: runAfter, text: removedNote(runLines, why) };
    } else {
      runAt = out.length;
      runAfter = removal.after;
      runLines = 1;
      out.push({ after: removal.after, text: removedNote(1, why) });
    }
  }
  return out;
}

/**
 * The removed rows of a change as the model may see them: the patch masked as a whole text, and
 * read the way the original was; or, when that is not possible, a note for each run of rows. A
 * patch that removes nothing the scanner sent is not masked: its marker lines are the scanner's text.
 */
async function removedLines(
  patch: string,
  facts: PatchFacts,
  masker: Masker,
): Promise<{ removed: RemovedLine[]; redactions: number }> {
  if (!facts.removals.some((removal) => removal.kind === '-')) {
    return {
      removed: facts.removals.map(({ after, text }) => ({ after, text })),
      redactions: 0,
    };
  }
  const result = await masker.mask(patch);
  let why: NoteReason;
  if (result.kind === 'masked') {
    const restored = withDiffPrefixes(patch, result.text);
    const shown = restored === null ? null : parsePatch(restored);
    if (shown !== null) {
      // Masking changes the rows' text (their prefixes are back) or takes a hunk header with it and
      // loses the hunk's rows: with as many removed rows as the patch has, each is the one it came from.
      const removals = removalsOf(shown);
      if (removals.length === facts.removals.length) {
        return {
          removed: removals.map(({ after, text }) => ({ after, text })),
          redactions: result.count,
        };
      }
    }
    why = 'unreadable';
  } else {
    why = result.kind;
  }
  return { removed: noteRuns(facts.removals, why), redactions: 0 };
}

// ─── Which changes are reviewed ──────────────────────────────────────────────

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A change skipped for its name alone: its file is not read at all. */
function skippedByName(path: string): SkipReason | null {
  if (LOCK_FILES.has(baseName(path))) return 'lock';
  if (MINIFIED_NAME.test(path)) return 'minified';
  return null;
}

/** The first lines of the masked file say a tool wrote it. */
function isGenerated(text: MaskedText): boolean {
  const head: string[] = [];
  for (let i = 0; i < Math.min(GENERATED_HEAD_LINES, text.lineCount); i += 1)
    head.push(text.line(i));
  const joined = head.join('\n');
  return (
    joined.includes('@generated') ||
    (joined.includes('Code generated') && joined.includes('DO NOT EDIT'))
  );
}

/** The first lines of the masked file are long on average, and one of them is very long. */
function isMinified(text: MaskedText): boolean {
  const lines = Math.min(MINIFIED_HEAD_LINES, text.lineCount);
  if (lines === 0) return false;
  let total = 0;
  let longest = 0;
  for (let i = 0; i < lines; i += 1) {
    const length = text.lineLength(i);
    total += length;
    if (length > longest) longest = length;
  }
  return total / lines > MINIFIED_AVERAGE_CHARS && longest > MINIFIED_LONG_LINE_CHARS;
}

/** The ranges of lines changed since the last review, cut to the lines the file has. */
function clipSince(
  since: readonly [number, number][] | null,
  lines: number,
): [number, number][] | null {
  if (since === null) return null;
  const clipped: [number, number][] = [];
  for (const [start, end] of since) {
    const last = Math.min(end, lines);
    if (start <= last) clipped.push([start, last]);
  }
  return clipped;
}

const isExcluded = (change: SnapshotChange, options: ContextOptions): boolean =>
  options.excluded?.(change.path) === true ||
  (change.oldPath !== null && options.excluded?.(change.oldPath) === true);

/**
 * The changes of a merge request that are reviewed, and the ones that are not, with why. Reviewed
 * is everything but the lock files, the generated and the minified files, and the changes with
 * neither a patch nor a text; migrations and deleted files are kept (a deleted file has no
 * slices). A path the administrator keeps from the model is in neither list, and its file is not
 * read. The head files are read masked, through `files`, so that what is detected here is what the
 * model could read; once the masker has no time left, no file is read, and each is not shown.
 *
 * Defensive reading: a `renamed` change that does not say what it was renamed from is `added`; the
 * ranges changed since the last review are cut to the file; a patch that does not parse, or has a
 * row past the end of the file, drops that file's slices and nothing else.
 */
export async function reviewableChanges(
  changes: readonly SnapshotChange[],
  files: MaskedFiles,
  masker: Masker,
  options: ContextOptions = {},
): Promise<{ reviewed: ReviewableChange[]; skipped: SkippedChange[]; redactions: number }> {
  const reviewed: ReviewableChange[] = [];
  const skipped: SkippedChange[] = [];
  let redactions = 0;
  /** Set by the first file the masker had no time for: every other would answer the same. */
  let outOfTime = false;
  for (const given of changes) {
    if (isExcluded(given, options)) continue;
    const change: SnapshotChange =
      given.status === 'renamed' && given.oldPath === null ? { ...given, status: 'added' } : given;
    const byName = skippedByName(change.path);
    if (byName !== null) {
      skipped.push({ path: change.path, why: byName });
      continue;
    }
    const file =
      change.status === 'deleted'
        ? ({ kind: 'absent' } as const)
        : outOfTime
          ? ({ kind: 'budget' } as const)
          : await files.file(change.path);
    if (file.kind === 'budget') outOfTime = true;

    let text: MaskedText | null = null;
    let unshown: Unshown | null = null;
    switch (file.kind) {
      case 'text':
        redactions += file.redactions;
        if (isGenerated(file.text)) {
          skipped.push({ path: change.path, why: 'generated' });
          continue;
        }
        if (isMinified(file.text)) {
          skipped.push({ path: change.path, why: 'minified' });
          continue;
        }
        text = file.text;
        break;
      case 'omitted':
        if (file.reason === 'binary') {
          skipped.push({ path: change.path, why: 'binary' });
          continue;
        }
        unshown = 'no_text';
        break;
      case 'absent':
        unshown = change.status === 'deleted' ? 'deleted' : 'no_text';
        break;
      case 'budget':
      case 'timeout':
        unshown = file.kind;
        break;
    }
    if (change.patch === null && (file.kind === 'omitted' || file.kind === 'absent')) {
      skipped.push({ path: change.path, why: 'binary' });
      continue;
    }

    const facts = readPatch(change, text);
    if (unshown === null && !facts.readable) unshown = 'unreadable';
    let removed: readonly RemovedLine[] = [];
    if (unshown === null && change.patch !== null) {
      const masked = await removedLines(change.patch, facts, masker);
      removed = masked.removed;
      redactions += masked.redactions;
    }
    reviewed.push({
      ...change,
      since: text === null ? change.since : clipSince(change.since, text.lineCount),
      text,
      added: facts.added,
      changedLines: facts.changedLines,
      sensitive: SENSITIVE_PATH.test(change.path),
      removed,
      unshown,
    });
  }
  return { reviewed, skipped, redactions };
}

// ─── Slices ──────────────────────────────────────────────────────────────────

/** A line as the model sees it: without its carriage return, and cut with `…`. */
function cutLine(line: string): string {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text.length <= MAX_LINE_CHARS) return text;
  // Enough for the cut to land on the right character, and a minified line is not taken apart.
  return cutAtGrapheme(text.slice(0, 2 * MAX_LINE_CHARS + 2), MAX_LINE_CHARS);
}

/**
 * The windows of lines to print: `context` lines around every added line and every place lines
 * were removed from (the lines before it and the lines after), cut to the file, and merged when
 * they overlap or touch. A file the change emptied has the window 0 to 0, to show what it removed.
 */
function windowsOf(change: ReviewableChange, total: number, context: number): [number, number][] {
  if (total === 0) return change.removed.some((line) => line.after === 0) ? [[0, 0]] : [];
  const spans: [number, number][] = [];
  for (const line of change.added) spans.push([line - context, line + context]);
  for (const after of new Set(change.removed.map((line) => line.after))) {
    spans.push([after - context + 1, after + context]);
  }
  const windows: [number, number][] = [];
  for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
    const lo = Math.max(1, from);
    const hi = Math.min(total, to);
    if (lo > hi) continue;
    const last = windows[windows.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else windows.push([lo, hi]);
  }
  return windows;
}

/**
 * The slices of one change, printed with the real new-side line numbers: a header
 * `@@ <path> lines a–b of T @@` for each window, then its rows. A row is the line number right-aligned,
 * then `+` for an added line or a space for an unchanged one, then the text; a row for a removed
 * line has no number and a `-`. The text of the rows is the masked head file's (the lines read_file
 * shows) and the removed lines' (masked with the patch). Empty when there is nothing to print.
 */
export function slicesOf(change: ReviewableChange, contextLines: number = CONTEXT_LINES): string {
  const { text } = change;
  if (text === null || change.unshown !== null) return '';
  const total = text.lineCount;
  const windows = windowsOf(change, total, Math.max(1, Math.floor(contextLines)));
  const removedAfter = new Map<number, RemovedLine[]>();
  for (const line of change.removed) {
    const same = removedAfter.get(line.after);
    if (same === undefined) removedAfter.set(line.after, [line]);
    else same.push(line);
  }
  const width = String(total).length;
  const blank = ' '.repeat(width);
  const rows: string[] = [];
  const removedRows = (after: number) => {
    for (const line of removedAfter.get(after) ?? []) rows.push(`${blank}-${cutLine(line.text)}`);
  };
  for (const [lo, hi] of windows) {
    rows.push(`@@ ${change.path} lines ${lo}–${hi} of ${total} @@`);
    if (lo <= 1) removedRows(0);
    for (let n = Math.max(lo, 1); n <= hi; n += 1) {
      const mark = change.added.has(n) ? '+' : ' ';
      rows.push(`${String(n).padStart(width)}${mark}${cutLine(text.line(n - 1))}`);
      removedRows(n);
    }
  }
  return rows.join('\n');
}

/** Sensitive files first, then the most changed lines, then by path. */
function bySlicePriority(a: ReviewableChange, b: ReviewableChange): number {
  if (a.sensitive !== b.sensitive) return a.sensitive ? -1 : 1;
  if (a.changedLines !== b.changedLines) return b.changedLines - a.changedLines;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The slices that fit in SLICE_BUDGET_CHARS, in order of importance, and what is left out: a file
 * that does not fit is left out whole, and the files after it that do fit are still shown. Every
 * change that has no slices is listed, with the reason, except a deleted file: the first
 * MAX_OMITTED_LISTED in order of importance, then the number of the others.
 */
function cutSlices(reviewed: readonly ReviewableChange[]): { slices: string; omitted: string[] } {
  const parts: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const change of [...reviewed].sort(bySlicePriority)) {
    const lines = change.text === null ? '' : ` (${linesOf(change.text.lineCount)})`;
    const toRead = `${change.path}${lines}: changed, read it with read_file`;
    switch (change.unshown) {
      case 'deleted':
        continue;
      case 'no_text':
      case 'unreadable':
        omitted.push(toRead);
        continue;
      case 'timeout':
      case 'budget':
        omitted.push(`${change.path}: not shown: ${WHY[change.unshown]}`);
        continue;
      case null:
        break;
    }
    const text = change.text;
    if (text === null) continue;
    const slice = slicesOf(change);
    if (slice === '') {
      // A patch too large to send says nothing of what changed: a file to read. One with no line
      // in it (a rename, a mode) has nothing to show.
      if (change.patch === null) omitted.push(toRead);
      continue;
    }
    const cost = slice.length + (parts.length === 0 ? 0 : 1);
    if (used + cost > SLICE_BUDGET_CHARS) {
      omitted.push(`${change.path} (${linesOf(text.lineCount)}): read it with read_file`);
      continue;
    }
    parts.push(slice);
    used += cost;
  }
  const listed = omitted.slice(0, MAX_OMITTED_LISTED);
  const more = omitted.length - listed.length;
  if (more > 0) {
    listed.push(`… ${more} more changed files are not in the slices; read them with read_file`);
  }
  return { slices: parts.join('\n'), omitted: listed };
}

// ─── The findings a review is given ──────────────────────────────────────────

/**
 * The open issues of the analysis' branch that the analyzers made (not engine `ai`, not duplicates)
 * on `paths`, the most severe first and at most 100. The paths go to the database as one value,
 * as a merge request can change more paths than a statement can bind values for.
 */
export async function analyzerFindings(
  db: Executor,
  analysisId: string,
  paths: readonly string[],
): Promise<AnalyzerFinding[]> {
  if (paths.length === 0) return [];
  const found = await db
    .select({
      ruleKey: rules.key,
      severity: issues.severity,
      message: issues.message,
      path: issues.path,
      line: issues.startLine,
    })
    .from(analyses)
    .innerJoin(issues, eq(issues.branchId, analyses.branchId))
    .innerJoin(rules, eq(rules.id, issues.ruleId))
    .where(
      and(
        eq(analyses.id, analysisId),
        eq(issues.status, 'open'),
        isNull(issues.duplicateOfIssueId),
        ne(rules.engineId, AI_ENGINE),
        sql`${issues.path} = ANY(${sql.param([...paths])}::text[])`,
      ),
    )
    .orderBy(
      asc(issues.severityRank),
      asc(issues.path),
      sql`${issues.startLine} ASC NULLS LAST`,
      asc(issues.id),
    )
    .limit(MAX_ANALYZER_FINDINGS);
  return found.flatMap(({ path, message, ...rest }) =>
    path === null
      ? []
      : [{ ...rest, path, message: cutAtGrapheme(message, ANALYZER_MESSAGE_CHARS) }],
  );
}

const PRIOR_STATUSES = ['open', 'false_positive', 'wont_fix'] as const;
const isPriorStatus = (status: string): status is PriorFinding['status'] =>
  PRIOR_STATUSES.some((known) => known === status);
const isAiCategory = (category: string): category is AiCategory =>
  AI_CATEGORIES.some((known) => known === category);

/**
 * The AI issues of the branch that are open or that a person dismissed (a false positive, or one
 * that will not be fixed), with the body of their finding: what a re-review re-checks, and does
 * not raise again. An issue with no place in a file is of no use to either and is left out.
 */
export async function priorAiFindings(db: Executor, branchId: string): Promise<PriorFinding[]> {
  const found = await db
    .select({
      id: issues.id,
      category: rules.engineRuleId,
      severity: issues.severity,
      status: issues.status,
      path: issues.path,
      line: issues.startLine,
      endLine: issues.endLine,
      title: issues.message,
      body: reviewFindings.body,
      fingerprint: issues.fingerprint,
    })
    .from(issues)
    .innerJoin(rules, eq(rules.id, issues.ruleId))
    .leftJoin(reviewFindings, eq(reviewFindings.issueId, issues.id))
    .where(
      and(
        eq(issues.branchId, branchId),
        eq(rules.engineId, AI_ENGINE),
        inArray(issues.status, [...PRIOR_STATUSES]),
      ),
    )
    .orderBy(asc(issues.path), asc(issues.startLine), asc(issues.id));
  return found.flatMap((row) => {
    const { path, line, category, status } = row;
    if (path === null || line === null || !isAiCategory(category) || !isPriorStatus(status)) {
      return [];
    }
    return [
      {
        id: row.id,
        category,
        severity: row.severity,
        status,
        path,
        line,
        endLine: row.endLine ?? line,
        title: row.title,
        body: cutAtGrapheme(row.body ?? '', PRIOR_BODY_CHARS),
        fingerprint: row.fingerprint,
      },
    ];
  });
}

// ─── The review's context ────────────────────────────────────────────────────

/** The secrets replaced so far in the texts the prompt shows. */
interface Tally {
  redactions: number;
}

/** A text masked as a whole by the review's masker, or the fixed note for one it gave up on. */
async function shownText(masker: Masker, text: string, tally: Tally): Promise<string> {
  if (text === '') return text;
  const result = await masker.mask(text);
  switch (result.kind) {
    case 'masked':
      tally.redactions += result.count;
      return result.text;
    case 'timeout':
    case 'budget':
      return notShown(result.kind);
  }
}

/** `text` cut to `max` characters, with a label that says it was and how long it is. */
function cutWithLabel(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}\n[cut: the text has ${chars.length} characters, only the first ${max} are shown]`;
}

/** The meta of the snapshot with the texts the prompt may show: masked, cut, and labelled. */
async function shownMeta(
  meta: SnapshotMeta,
  masker: Masker,
  tally: Tally,
  options: ContextOptions,
): Promise<SnapshotMeta> {
  const instructions: { name: string; text: string }[] = [];
  for (const file of meta.instructions) {
    if (options.excluded?.(file.name) === true) continue;
    instructions.push({
      name: file.name,
      text: cutWithLabel(await shownText(masker, file.text, tally), INSTRUCTIONS_CHARS),
    });
  }
  const mrTitle =
    meta.mrTitle === null
      ? null
      : cutAtGrapheme(await shownText(masker, meta.mrTitle, tally), TITLE_CHARS);
  const mrDescription =
    meta.mrDescription === null
      ? null
      : cutWithLabel(await shownText(masker, meta.mrDescription, tally), DESCRIPTION_CHARS);
  return { ...meta, mrTitle, mrDescription, instructions };
}

/**
 * The findings with their texts masked. The analyzers' are kept for the reviewed changes only (so
 * not for a lock file, nor for a path the administrator keeps out); an earlier review's, for any
 * path but the ones the administrator keeps out.
 */
async function shownFindings(
  findings: { analyzer: AnalyzerFinding[]; prior: PriorFinding[] },
  reviewed: readonly ReviewableChange[],
  masker: Masker,
  tally: Tally,
  options: ContextOptions,
): Promise<{ analyzer: AnalyzerFinding[]; prior: PriorFinding[] }> {
  const reviewedPaths = new Set(reviewed.map((change) => change.path));
  const analyzer: AnalyzerFinding[] = [];
  for (const finding of findings.analyzer) {
    if (!reviewedPaths.has(finding.path)) continue;
    analyzer.push({ ...finding, message: await shownText(masker, finding.message, tally) });
  }
  const prior: PriorFinding[] = [];
  for (const finding of findings.prior) {
    if (options.excluded?.(finding.path) === true) continue;
    prior.push({
      ...finding,
      title: await shownText(masker, finding.title, tally),
      body: await shownText(masker, finding.body, tally),
    });
  }
  return { analyzer, prior };
}

/**
 * What a review is given, read from the snapshot `files` is of: the reviewed changes and their
 * slices, and the snapshot's words, masked, cut and labelled. The job passes the findings
 * `analyzerFindings` (it can ask for the paths of all the changes: only those of reviewed changes
 * are kept) and `priorAiFindings` read; the evaluation passes empty lists. `masker` is the
 * review's, which `files` and the tools use too, and its caller closes: it rejects here once it is
 * closed or its signal has aborted. The administrator's excluded paths are `options.excluded`.
 */
export async function buildReviewContext(
  files: MaskedFiles,
  masker: Masker,
  findings: { analyzer: AnalyzerFinding[]; prior: PriorFinding[] },
  options: ContextOptions = {},
): Promise<ReviewContext> {
  const { reader } = files;
  const { reviewed, skipped, redactions } = await reviewableChanges(
    await reader.changes(),
    files,
    masker,
    options,
  );
  const tally: Tally = { redactions };
  const meta = await shownMeta(reader.meta, masker, tally, options);
  const { slices, omitted } = cutSlices(reviewed);
  const { analyzer, prior } = await shownFindings(findings, reviewed, masker, tally, options);
  return {
    meta,
    reviewed,
    skipped,
    slices,
    omittedFromSlices: omitted,
    analyzer,
    prior,
    redactions: tally.redactions,
  };
}
