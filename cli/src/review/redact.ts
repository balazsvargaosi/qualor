import {
  cutAtGrapheme,
  keyBlockLines,
  LONE_SURROGATE_SOURCE,
  REDACT_MAX_CHARS,
  REDACTED,
  redactText,
} from '@qualor/shared';

/*
 * The masking of the repository snapshot of a merge request (6I-2): every text the snapshot sends
 * (files, patches, instructions files, the merge request's title and description) has the secrets
 * the analyzers found replaced with «redacted», then goes through the shared redaction that the
 * server also runs before a prompt leaves (llm.md §5.2).
 */

/** A shorter secret is too likely to be ordinary text: the bound the report's scrubbing uses. */
const MIN_SECRET_CHARS = 8;

export interface Redacted {
  text: string;
  /** Replacements made. */
  count: number;
}

const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** `secret` with its line ends as LF: a scan of a CRLF working tree, a commit that holds LF. */
const withLf = (secret: string): string => secret.split('\n').map(withoutCr).join('\n');

/**
 * The secrets worth masking: 8 characters or more, once each, the longest first. Each comes as
 * found and with its line ends as LF, since the analyzers read the working tree (CRLF in a
 * Windows checkout) and the snapshot the commit.
 */
export function prepareSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((s) => [s, withLf(s)]))]
    .filter((s) => s.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length);
}

/**
 * The lines of every multi-line secret, trimmed (so a copy indented anew matches too), each of 8
 * characters or more that are not blank (a run of spaces is no secret): a patch shows a secret's
 * lines apart, each behind its `+`, `-` or space, so the whole never occurs in it.
 */
export function secretLines(secrets: readonly string[]): string[] {
  const lines = secrets
    .filter((s) => s.includes('\n'))
    .flatMap((s) => s.split('\n').map((line) => line.trim()))
    .filter((line) => line.replace(/\s/g, '').length >= MIN_SECRET_CHARS);
  return [...new Set(lines)];
}

/**
 * Every occurrence of every secret replaced by «redacted». The occurrences are found in the text as
 * it is and merged where they overlap or touch, so two secrets that share characters leave no
 * piece of either behind (replacing one first would hide the other).
 */
export function maskSecrets(text: string, secrets: readonly string[]): Redacted {
  const spans: [number, number][] = [];
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      spans.push([at, at + secret.length]);
    }
  }
  if (spans.length === 0) return { text, count: 0 };
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let count = 0;
  let from = 0;
  let span: [number, number] = spans[0] ?? [0, 0];
  for (const next of spans.slice(1)) {
    if (next[0] <= span[1]) {
      span = [span[0], Math.max(span[1], next[1])];
      continue;
    }
    out += text.slice(from, span[0]) + REDACTED;
    count += 1;
    from = span[1];
    span = next;
  }
  out += text.slice(from, span[0]) + REDACTED + text.slice(span[1]);
  return { text: out, count: count + 1 };
}

/**
 * The lines of context a window takes on each side of its own lines: the shared redaction joins up
 * to four lines to find a secret split over them, and marks a key block from its BEGIN line to its
 * END line (or to the window's edge, failing closed), so a window looks this far past its own.
 */
const CONTEXT_LINES = 8;
/**
 * A window's own lines: at most this many, and at most half of what the shared redaction scans at
 * once (so its context fits around them). A whole key block is masked over the whole text first,
 * whatever its length (`maskKeyBlocks`), and so is the body that follows a BEGIN line with no END
 * line, while it looks like one; a window decides what a BEGIN or an END line without its pair
 * means for the lines it sees.
 */
const WINDOW_LINES = 200;
const CORE_CHARS = Math.floor(REDACT_MAX_CHARS / 2);

/**
 * Whether the shared redaction scans `chars` (a text's lines, each counted with its newline):
 * redactText masks a whole text, or all its lines, over REDACT_MAX_CHARS.
 */
const fits = (chars: number): boolean => chars <= REDACT_MAX_CHARS;

const lengthOf = (lines: readonly string[], i: number): number => (lines[i] ?? '').length + 1;

const markers = (lines: readonly string[]): number =>
  lines.reduce((n, line) => n + line.split(REDACTED).length - 1, 0);

/** The window of own lines from `start` (a line that fits the scan): at least that one line. */
function windowAt(lines: readonly string[], start: number): { end: number; size: number } {
  let end = start + 1;
  let size = lengthOf(lines, start);
  while (end < lines.length && end - start < WINDOW_LINES) {
    if (size + lengthOf(lines, end) > CORE_CHARS) break;
    size += lengthOf(lines, end);
    end += 1;
  }
  return { end, size };
}

/** What a window scans: its own lines, and up to CONTEXT_LINES lines on each side that fit. */
function viewOf(
  lines: readonly string[],
  window: { start: number; end: number; size: number },
): { from: number; to: number } {
  let { size } = window;
  let from = window.start;
  let to = window.end;
  for (let k = 0; k < CONTEXT_LINES; k++) {
    if (from > 0 && fits(size + lengthOf(lines, from - 1))) {
      from -= 1;
      size += lengthOf(lines, from);
    }
    if (to < lines.length && fits(size + lengthOf(lines, to))) {
      size += lengthOf(lines, to);
      to += 1;
    }
  }
  return { from, to };
}

/**
 * Every line of every key block that is whole in `lines` replaced by «redacted»: a BEGIN line to
 * the next END line after it (keyBlockLines), however many lines lie between and however they are
 * decorated (a comment's `# `, a string literal, a patch's `-`), which the shared rule for a key
 * body in clear base64 would miss. So are the lines of a body that follow a BEGIN line with no END
 * line after it, as far as they look like a PEM body once their decoration is off (a key whose END
 * line is missing or mistyped, over a window's edge). That BEGIN line itself is left to the
 * windows.
 */
function maskKeyBlocks(lines: readonly string[]): { lines: string[]; count: number } {
  const blocks = keyBlockLines(lines);
  let count = 0;
  const masked = lines.map((line, i) => {
    if (blocks[i] !== true || line === REDACTED) return line;
    count += 1;
    return REDACTED;
  });
  return { lines: masked, count };
}

/**
 * The shared redaction for a text of any length. First every key block whole in the text is
 * masked (`maskKeyBlocks`); then the text is redacted in windows of at most WINDOW_LINES lines,
 * each scanned with CONTEXT_LINES lines of context on both sides, so a secret over a window's edge
 * is still seen whole: redactText masks a text longer than it scans as a whole, and a file of the
 * snapshot is up to 1 MiB. A BEGIN line with no END after it is the shared rule's, which masks to
 * the end of the view: a file that only names a PEM header (a parser, a test) loses the rest of
 * that window, not the rest of the file. The body after such a line is masked beyond the view too
 * (`maskKeyBlocks`), up to the first line that is no PEM body line. A single line too long to scan
 * is replaced by «redacted», as a text redactText cannot scan is. The lines stay as many as they
 * were.
 */
export function redactLongText(text: string): Redacted {
  if (text.split('\n', WINDOW_LINES + 1).length <= WINDOW_LINES && fits(text.length + 1)) {
    return redactText(text);
  }
  const { lines, count: blocks } = maskKeyBlocks(text.split('\n'));
  const out: string[] = [];
  let count = blocks;
  let start = 0;
  while (start < lines.length) {
    if (!fits(lengthOf(lines, start))) {
      out.push(REDACTED);
      count += 1;
      start += 1;
      continue;
    }
    const { end, size } = windowAt(lines, start);
    const { from, to } = viewOf(lines, { start, end, size });
    const scanned = redactText(lines.slice(from, to).join('\n')).text.split('\n');
    const own = scanned.slice(start - from, end - from);
    out.push(...own);
    count += Math.max(0, markers(own) - markers(lines.slice(start, end)));
    start = end;
  }
  return { text: out.join('\n'), count };
}

/** The analyzers' secrets masked, then the shared redaction (over a text of any length). */
export function redactSnapshotText(text: string, secrets: readonly string[]): Redacted {
  const masked = maskSecrets(text, secrets);
  const redacted = redactLongText(masked.text);
  return { text: redacted.text, count: masked.count + redacted.count };
}

const LONE_SURROGATE = new RegExp(LONE_SURROGATE_SOURCE, 'g');

/**
 * The merge request's title or description as the header sends it: without NUL characters and
 * lone surrogates (neither can be stored), redacted, then cut to `maxChars` code points, after the
 * masking so no half of a secret is left at the cut.
 */
export function mergeRequestText(
  text: string | null,
  maxChars: number,
  secrets: readonly string[],
): { text: string | null; count: number } {
  if (text === null) return { text: null, count: 0 };
  const clean = text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '');
  const redacted = redactSnapshotText(clean, secrets);
  return { text: cutAtGrapheme(redacted.text, maxChars), count: redacted.count };
}
