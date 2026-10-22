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

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? (\+\d+(?:,(\d+))?) @@(.*)$/;

const marker = (n: number): string => `-[${n} removed ${n === 1 ? 'line' : 'lines'} not sent]`;

/**
 * The body of the hunk that starts at `lines[start]`, `oldLeft` and `newLeft` lines on each side,
 * with each run of removed lines as one marker line (a `\` line about a removed line goes with
 * it); `removed` and `markers` count them. A line that is empty where a context line is due is
 * one (`diff.suppressBlankEmpty`).
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
    if (line.startsWith('+')) left.new -= 1;
    else if (!line.startsWith('\\')) {
      left.old -= 1;
      left.new -= 1;
    }
    body.push(line);
    i += 1;
  }
  return { body, next: i, removed, markers };
}

/**
 * `patch` with every run of removed lines replaced by one line, `-[N removed lines not sent]`. A
 * hunk's header counts its old side again (one line per marker); its new side, which the review
 * anchors to, stays as it was. The file headers (`--- a/…`), the added lines and the context
 * lines stay.
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
    const counted = oldCount - hunk.removed + hunk.markers;
    out.push(
      counted === oldCount ? line : `@@ -${m[1] ?? ''},${counted} ${m[3] ?? ''} @@${m[5] ?? ''}`,
      ...hunk.body,
    );
    i = hunk.next;
  }
  return out.join('\n');
}

export interface Patch {
  text: string;
  /** Replacements the masking made. */
  redactions: number;
}

/**
 * A patch as sent, or null: over the bound, with a NUL, or not UTF-8. Its removed lines go only
 * when the scan of the merge base held its old side (`removedLinesScanned`); else each run of them
 * is a marker line. Then the secrets are masked (`secrets` with the lines of the multi-line ones,
 * which a patch shows apart) and the shared redaction runs.
 */
export function finishPatch(
  bytes: Buffer,
  o: { secrets: readonly string[]; removedLinesScanned: boolean },
): Patch | null {
  if (bytes.length > MAX_SNAPSHOT_PATCH_BYTES || bytes.includes(0)) return null;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return null;
  }
  const shown = o.removedLinesScanned ? text : withoutRemovedLines(text);
  const masked = maskSecrets(shown, o.secrets);
  const redacted = redactLongText(masked.text);
  const sent = keepPrefixes(masked.text.split('\n'), redacted.text.split('\n')).join('\n');
  if (Buffer.byteLength(sent, 'utf8') > MAX_SNAPSHOT_PATCH_BYTES) return null;
  return { text: sent, redactions: masked.count + redacted.count };
}

const HUNK_RANGE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * The lines the redaction masked whole (a key block, a secret split over lines) with the diff
 * prefix they had (`+`, `-` or a space), or a hunk header's range, so the patch is still one.
 * `before` and `after` are line for line: the redaction keeps the lines as many as they were.
 */
function keepPrefixes(before: readonly string[], after: readonly string[]): string[] {
  return after.map((line, i) => {
    const was = before[i] ?? '';
    if (line !== REDACTED || was === REDACTED) return line;
    const range = HUNK_RANGE.exec(was)?.[0];
    if (range !== undefined) return `${range} ${REDACTED}`;
    const prefix = was.charAt(0);
    return prefix === '+' || prefix === '-' || prefix === ' ' ? `${prefix}${REDACTED}` : line;
  });
}
