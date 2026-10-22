import { MAX_SNAPSHOT_PATCH_BYTES, REDACTED } from '@qualor/shared';
import { diffHeaderLine, DiffSplitter } from '../git/diff';
import type { Git } from '../git/git';
import type { Logger } from '../log';
import { maskSecrets, redactLongText } from './redact';

/*
 * The patches of the review snapshot: the merge request's diff against the merge base, one patch
 * per changed path. A patch's removed lines are the merge base's, which the scan never read: they
 * are sent only when the scan of the merge base's files held them (ruling R13), else each run of
 * them is one marker line.
 */

/** Options of every diff: the bytes as committed, the scan root's paths, `a/` and `b/`. */
export const DIFF_OPTIONS: readonly string[] = [
  '-M',
  '--relative',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A changed path and the path git compared it with (a rename's or a copy's source, else itself). */
export interface PatchPair {
  path: string;
  from: string;
}

/**
 * The most bytes of patches the scanner holds at once (M4), whatever inflated size the server
 * accepts (up to 500 MiB): the raw patches are kept as buffers and then decoded and masked as
 * strings, so the peak is about twice this, and a runner that runs out of memory ends the job.
 * 64 MiB of diffs is already more than a review can use. A merge request with more is `too_large`,
 * as one over the server's limits is.
 */
export const MAX_PATCH_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * The patch of each pair as git wrote it, from one `git diff` against the merge base read as a
 * stream and cut per `diff --git` header (a type change has two pieces, joined here). A patch over
 * MAX_SNAPSHOT_PATCH_BYTES is never held and has no entry; the patches held stay within `budget`,
 * or the snapshot is too large (they always go in). A diff that fails gives no patches.
 */
export async function readRawPatches(
  git: Git,
  range: { base: string; head: string },
  pairs: readonly PatchPair[],
  o: { budget: number; log: Logger },
): Promise<Map<string, Buffer> | 'too_large'> {
  const byHeader = new Map(pairs.map((p) => [diffHeaderLine(p.from, p.path), p.path]));
  /** A path's pieces, or null once they are over the bound. */
  const pieces = new Map<string, Buffer[] | null>();
  let held = 0;
  const splitter = new DiffSplitter(MAX_SNAPSHOT_PATCH_BYTES, (header, patch) => {
    const p = byHeader.get(header);
    if (p === undefined) return;
    const before = pieces.get(p);
    if (before === null) return;
    if (patch === null) {
      pieces.set(p, null);
      return;
    }
    held += patch.length;
    pieces.set(p, [...(before ?? []), patch]);
  });
  const r = await git(['diff', '-U3', ...DIFF_OPTIONS, range.base, range.head, '--'], {
    onStdout: (chunk) => {
      splitter.push(chunk);
      return held <= o.budget;
    },
  });
  if (held > o.budget) return 'too_large';
  const patches = new Map<string, Buffer>();
  if (r.code !== 0) {
    o.log.warn(
      `AI review: the merge request's diff could not be read, so the snapshot has no patches: ${r.stderr.trim()}`,
    );
    return patches;
  }
  splitter.end();
  for (const [p, parts] of pieces) {
    const bytes = parts === null ? null : Buffer.concat(parts);
    if (bytes !== null && bytes.length <= MAX_SNAPSHOT_PATCH_BYTES) patches.set(p, bytes);
  }
  return patches;
}

/**
 * A hunk header's ranges, from the start of the line. After them git writes the hunk's function
 * context: the nearest line above the hunk in the OLD file that looks like a function's start (by
 * default any line beginning with a letter, `_` or `$`), cut at 80 bytes. That is text of the
 * merge base, which can be a line the merge request removed in an earlier hunk, and a secret on it
 * no longer matches the masking once cut (nor one of the head's, on a line it kept). So no header
 * is sent with it: each is rebuilt from its ranges alone (`rangesOnly`).
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MARKER = /^-\[\d+ removed lines? not sent\]$/;

const marker = (n: number): string => `-[${n} removed ${n === 1 ? 'line' : 'lines'} not sent]`;

/** A side's range as git writes it: a count of 1 is left out (`-20`, `-20,2`, `-0,0`). */
const sideRange = (start: string, count: number): string =>
  count === 1 ? start : `${start},${count}`;

/** The header of the hunk `m` reads, from its ranges alone: its old side counting `oldCount`. */
const rangesOnly = (m: RegExpExecArray, oldCount = Number(m[2] ?? '1')): string =>
  `@@ -${sideRange(m[1] ?? '', oldCount)} +${sideRange(m[3] ?? '', Number(m[4] ?? '1'))} @@`;

/** One line of a hunk's body counted off its sides: `-` the old, `+` the new, `\` neither. */
function countOff(line: string, left: { old: number; new: number }): void {
  if (line.startsWith('-')) left.old -= 1;
  else if (line.startsWith('+')) left.new -= 1;
  else if (!line.startsWith('\\')) {
    left.old -= 1;
    left.new -= 1;
  }
}

/**
 * The body of the hunk that starts at `lines[start]`, `left` lines on each side, with each run of
 * removed lines as one marker line (a `\` line about a removed line goes with it); `removed` and
 * `markers` count them. A line that is empty where a context line is due is one
 * (`diff.suppressBlankEmpty`). A removed line past the old side's count ends the hunk: it is in
 * none, and the patch is then not sent (`onlyMarkersRemoved`).
 */
function hunkBody(
  lines: readonly string[],
  start: number,
  left: { old: number; new: number },
): { body: string[]; next: number; removed: number; markers: number } {
  const body: string[] = [];
  let i = start;
  let removed = 0;
  let markers = 0;
  while (i < lines.length && (left.old > 0 || left.new > 0)) {
    const line = lines[i] ?? '';
    if (line.startsWith('-')) {
      if (left.old <= 0) break;
      let run = 0;
      while (i < lines.length && (lines[i] ?? '').startsWith('-') && left.old > 0) {
        run += 1;
        left.old -= 1;
        i += 1;
        while ((lines[i] ?? '').startsWith('\\')) i += 1;
      }
      body.push(marker(run));
      removed += run;
      markers += 1;
      continue;
    }
    countOff(line, left);
    body.push(line);
    i += 1;
  }
  return { body, next: i, removed, markers };
}

/**
 * `patch` with every run of removed lines replaced by one line, `-[N removed lines not sent]`. A
 * hunk's header is rebuilt from its ranges, its old side counted again (one line per marker); its
 * new side, which the review anchors to, stays as it was. The file headers (`--- a/…`), the added
 * lines and the context lines stay.
 */
export function withoutRemovedLines(patch: string): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = HUNK_HEADER.exec(line);
    if (m === null) {
      out.push(line);
      i += 1;
      continue;
    }
    const oldCount = Number(m[2] ?? '1');
    const hunk = hunkBody(lines, i + 1, { old: oldCount, new: Number(m[4] ?? '1') });
    out.push(rangesOnly(m, oldCount - hunk.removed + hunk.markers), ...hunk.body);
    i = hunk.next;
  }
  return out.join('\n');
}

/**
 * `patch` with every hunk header rebuilt from its ranges alone, without the function context git
 * writes after them (`HUNK_HEADER`); null when a line that starts with `@@` is no header it reads.
 * A hunk's body never starts a line with `@`.
 */
export function withoutFunctionContext(patch: string): string | null {
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? '').startsWith('@@')) continue;
    const m = HUNK_HEADER.exec(lines[i] ?? '');
    if (m === null) return null;
    lines[i] = rangesOnly(m);
  }
  return lines.join('\n');
}

/**
 * Whether `patch` holds no removed line but markers: each `@@` line is a hunk header it reads,
 * each hunk's `-` lines are markers, and a `-` line outside the hunks is a file header (`--- `,
 * followed by its `+++ ` line). A patch it cannot read so is not sent: it fails closed.
 */
function onlyMarkersRemoved(patch: string): boolean {
  const lines = patch.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line);
      if (m === null) return false;
      const left = { old: Number(m[2] ?? '1'), new: Number(m[4] ?? '1') };
      for (i += 1; i < lines.length && (left.old > 0 || left.new > 0); i++) {
        const body = lines[i] ?? '';
        if (body.startsWith('-') && !MARKER.test(body)) return false;
        countOff(body, left);
      }
      continue;
    }
    const fileHeader = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (line.startsWith('-') && !fileHeader) return false;
    i += 1;
  }
  return true;
}

/** git's `index <old>..<new> [mode]` line: the abbreviated ids of the blobs of both sides. */
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/;

/**
 * `patch` without git's `index` lines. Each names the ids of both blobs (7 to 12 digits, or more
 * with many objects): whoever holds the snapshot could hash guesses of a secret that is masked
 * in it, or of a removed line that is not sent, as git blobs and compare the first digits. A
 * review gains nothing from the ids. A line is git's only in the header part of a piece, from its
 * `diff --git` line to its first hunk (a type change has two pieces): every line of a hunk starts
 * with ` `, `+`, `-` or `\`, so one that reads like an index line there is the file's own.
 */
export function withoutIndexLines(patch: string): string {
  let header = true;
  return patch
    .split('\n')
    .filter((line) => {
      if (line.startsWith('diff --git ')) header = true;
      else if (line.startsWith('@@')) header = false;
      return !(header && INDEX_LINE.test(line));
    })
    .join('\n');
}

export interface Patch {
  text: string;
  /** Replacements the masking made. */
  redactions: number;
}

/**
 * A patch as sent, or null: over the bound, with a NUL, or not UTF-8. It carries no `index` line
 * (`withoutIndexLines`). Its removed lines go only when the scan of the merge base held its old
 * side (`removedLinesScanned`); else each run of them is a marker line, and a patch where one
 * could still be left (a hunk it cannot read) is not sent. Every hunk header goes as its ranges
 * alone, scanned or not; a patch with one it cannot rebuild is not sent either. Then the secrets
 * are masked (`secrets` with the lines of the multi-line ones, which a patch shows apart) and the
 * shared redaction runs.
 */
export function finishPatch(
  bytes: Buffer,
  o: { secrets: readonly string[]; removedLinesScanned: boolean },
): Patch | null {
  if (bytes.length > MAX_SNAPSHOT_PATCH_BYTES || bytes.includes(0)) return null;
  let decoded: string;
  try {
    decoded = UTF8.decode(bytes);
  } catch {
    return null;
  }
  const text = withoutIndexLines(decoded);
  const shown = withoutFunctionContext(o.removedLinesScanned ? text : withoutRemovedLines(text));
  if (shown === null) return null;
  if (!o.removedLinesScanned && !onlyMarkersRemoved(shown)) return null;
  const masked = maskSecrets(shown, o.secrets);
  const redacted = redactLongText(masked.text);
  const sent = keepPrefixes(masked.text.split('\n'), redacted.text.split('\n')).join('\n');
  if (Buffer.byteLength(sent, 'utf8') > MAX_SNAPSHOT_PATCH_BYTES) return null;
  return { text: sent, redactions: masked.count + redacted.count };
}

/**
 * The lines the redaction masked whole (a key block, a secret split over lines) with the diff
 * prefix they had (`+`, `-` or a space), so the patch is still one; a hunk header, which holds
 * its ranges alone by then (`withoutFunctionContext`), is given back as it was. `before` and
 * `after` are line for line: the redaction keeps the lines as many as they were.
 */
function keepPrefixes(before: readonly string[], after: readonly string[]): string[] {
  return after.map((line, i) => {
    const was = before[i] ?? '';
    if (line !== REDACTED || was === REDACTED) return line;
    if (HUNK_HEADER.test(was)) return was;
    const prefix = was.charAt(0);
    return prefix === '+' || prefix === '-' || prefix === ' ' ? `${prefix}${REDACTED}` : line;
  });
}
