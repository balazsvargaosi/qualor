import { REDACTED } from '../sarif/normalize';
import { keyBlockLines, REDACT_MAX_CHARS, redactText } from './redact';

/*
 * The secret redaction of llm.md §5.2 for a text of any length. A file of the review snapshot is
 * up to 1 MiB and `redactText` masks a text over 64 KiB as a whole, so the text is masked in
 * windows. The scanner masks every text it uploads with it (the CLI's review snapshot), and the
 * server masks a file again, whole, before the review tools show or search any line of it: what
 * decides whether a line is secret can lie far from it (a private key's BEGIN line), so the lines
 * of a file are never masked on their own.
 */

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
 * line after it, as far as they look like a PEM body once their decoration is off, and the short
 * last line of the key (a key whose END line is missing or mistyped, over a window's edge). That
 * BEGIN line itself is left to the windows. The lines masked here are no run for the windows'
 * own rule for base64 lines to extend to a short line beside them, which is why that last line is
 * marked here.
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
 * were. `count` is the number of replacements.
 */
export function redactLongText(text: string): { text: string; count: number } {
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
