import type { MaskResult } from './masker';
import type { SnapshotChange } from './snapshot-reader';

/*
 * The patch of a changed file: read as a unified diff, with the lines of the new side numbered, and
 * its removed lines masked. The numbers (which lines the change adds, where it removes lines from)
 * are read from the snapshot's patch as it is: they hold no text of the repository. The removed
 * lines are text of the merge base, which the scan never read, so they are shown only as a masker
 * has masked them with the whole patch (never a line at a time): `removedLines`, with the masking
 * handed to it.
 */

/** A marker line stands for this many removed lines at most: a number in a patch is not trusted. */
const MAX_MARKER_LINES = 1_000_000;

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

/** A line the change removed: the new-side line it follows (0: before the first), as the model sees it. */
export interface RemovedLine {
  after: number;
  /** The masked line, or a fixed note for lines that could not be masked. */
  text: string;
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
export interface Removal {
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

/**
 * What the structure of a change says. Its `removals` hold the text of the removed rows as the
 * snapshot has them, to count them and to know where they were: they are shown only through
 * `removedLines`.
 */
export interface PatchFacts {
  added: Set<number>;
  removals: Removal[];
  changedLines: number;
  /** False when the change has a patch that cannot be read. */
  readable: boolean;
}

/**
 * The lines a change adds and removes, given the lines its head file has (null: no text). With no
 * patch, or one that does not parse or does not fit the file, the file is all there is: a new file
 * is all added, any other counts as long as the file is and adds nothing that can be named.
 */
export function patchFacts(
  change: Pick<SnapshotChange, 'status' | 'patch'>,
  lines: number | null,
): PatchFacts {
  const parsed = change.patch === null ? null : parsePatch(change.patch);
  if (parsed !== null) {
    const removals = removalsOf(parsed);
    if (lines === null || !reachesPast(parsed, removals, lines)) {
      const removed = removals.reduce((sum, removal) => sum + linesRemoved(removal), 0);
      return {
        added: parsed.added,
        removals,
        changedLines: parsed.added.size + removed,
        readable: true,
      };
    }
  }
  const length = lines ?? 0;
  const added = new Set<number>();
  if (change.status === 'added') for (let line = 1; line <= length; line += 1) added.add(line);
  return { added, removals: [], changedLines: length, readable: change.patch === null };
}

// ─── Masking the removed lines ───────────────────────────────────────────────

/** Why a text is not shown: the fixed wording of every note that stands for one. */
export const WHY = {
  timeout: 'it could not be masked in time',
  budget: 'the review has used up the time it may spend masking',
  unreadable: 'its masked text could not be read',
} as const;
export type NoteReason = keyof typeof WHY;

const removedNote = (lines: number, why: NoteReason): string =>
  `[${lines} removed line${lines === 1 ? '' : 's'} not shown: ${WHY[why]}]`;

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

/** Masks a text as a whole; the review's masker, with whatever it is charged. */
export type Mask = (text: string) => Promise<MaskResult>;

/**
 * The removed rows of a change as the model may see them: the patch masked as a whole text, and
 * read the way the original was; or, when that is not possible, a note for each run of rows. A
 * patch that removes nothing the scanner sent is not masked: its marker lines are the scanner's text.
 */
export async function removedLines(
  patch: string,
  facts: PatchFacts,
  mask: Mask,
): Promise<{ removed: RemovedLine[]; redactions: number }> {
  if (!facts.removals.some((removal) => removal.kind === '-')) {
    return {
      removed: facts.removals.map(({ after, text }) => ({ after, text })),
      redactions: 0,
    };
  }
  const result = await mask(patch);
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
