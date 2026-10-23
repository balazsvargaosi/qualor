/**
 * The checks of scm.md §6 on a comment body GitLab or GitHub renders as Markdown, shared by the
 * rendering tests (server/src/scm/render.test.ts) and the AI assistant's end-to-end test.
 */

import { AI_SECTION_MARKUP_LINES } from '../src/review/render';

/**
 * CommonMark code spans of one line, removed: a backtick run opens a span that the next run of
 * the same length closes; an unmatched run is literal text. What is left is what GitLab renders
 * as Markdown.
 */
export function outsideCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    let n = 0;
    while (line[i + n] === '`') n++;
    const fence = '`'.repeat(n);
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      const at = line.indexOf(fence, j);
      if (at < 0) break;
      let m = 0;
      while (line[at + m] === '`') m++;
      if (m === n) {
        close = at;
        break;
      }
      j = at + m;
    }
    if (close < 0) {
      out += fence;
      i += n;
    } else {
      out += ' ';
      i = close + n;
    }
  }
  return out;
}

/** Characters Qualor's own fixed text may use outside code spans. */
export const FIXED_TEXT = /^[A-Za-z0-9 .,;:()’…*|\-<>·]*$/;
/**
 * {@link FIXED_TEXT} plus the fixed symbols of the summary comment: the status and severity
 * markers, the comparison signs of the Required column, the dash of a skipped row, the arrow of
 * its link, the percent sign of a value, the apostrophe of a catalog name (`Won't fix issues`)
 * and the backslash of a hard line break.
 */
export const SUMMARY_FIXED_TEXT = /^(?:[A-Za-z0-9 .,;:()’…*|\-<>·✅❌➖⛔🔴🟠🟡🔵≤≥—→%'\\]|⚠️)*$/u;
export const FORBIDDEN_ANYWHERE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\u115f\u1160\u2800\u3164\uffa0\ufeff\ufff0-\ufff8\ud800-\udfff]|[\u{e0000}-\u{e00ff}\u{e01f0}-\u{e0fff}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}]/u;

/**
 * What a model's prose may keep outside code spans (`safeProse`): letters with their combining
 * marks, decimal digits, spaces and the punctuation of ordinary sentences: the quotes and the
 * bracket a word may open with or end in, the ellipsis and the dashes. No character that GitLab or
 * GitHub gives a meaning to is among them.
 */
export const PROSE_TEXT = /^[\p{L}\p{M}\p{Nd} .,;:!?'’"“”‘()…—–-]*$/u;
/** A list marker at the start of a line, as `safeProse` writes it. */
const LIST_MARKER = /^(?:- |\d+\. )/;

/**
 * Whether one line of `safeProse`'s output is only ordinary words and their punctuation once its
 * code spans and the list marker at its start are taken out.
 */
export function checkProse(line: string): boolean {
  return PROSE_TEXT.test(outsideCodeSpans(line).replace(LIST_MARKER, ''));
}

// ─── The AI review section (server/src/review/render.ts) ─────────────────────
//
// Its fixed texts that are prose need no list: `checkProse` passes them. The ones that hold markup
// are accepted where they belong only: as a whole line, or as the shape of the line they are in.

/** A fence line of the prompt block: backticks, and the language on the opening one. */
const FENCE_LINE = /^`{3,}(?:text)?$/;
/** The count line: its markup and its separators are fixed text, and only here. */
const FINDINGS_LINE = /^\*\*Findings:\*\* \d+ high · \d+ medium · \d+ low$/;
/** A finding that sits on no changed line starts with its severity, at the start of the line. */
const FINDING_START = /^- \*\*(?:High|Medium|Low|Unknown)\*\* · /;
/** Qualor's link in the section: its fixed label, over https to the base the tests give Qualor. */
const SECTION_LINK = /^\[View in Qualor\]\(https:\/\/q\.example\/[A-Za-z0-9/-]*\)$/;
const MARKUP_LINES: ReadonlySet<string> = new Set(AI_SECTION_MARKUP_LINES);

/**
 * The line of a finding that sits on no changed line: after its severity, its place in a code span,
 * then (each after a separator) its title, which is prose, and its link, in this order.
 */
function checkFindingLine(line: string): boolean {
  const start = FINDING_START.exec(line);
  if (start === null) return false;
  const [place, ...parts] = outsideCodeSpans(line.slice(start[0].length)).split(' · ');
  if (place !== ' ') return false;
  const [first = '', second = ''] = parts;
  const isLink = (part: string): boolean => SECTION_LINK.test(part);
  const isTitle = (part: string): boolean => part !== '' && PROSE_TEXT.test(part);
  if (parts.length === 0) return true;
  if (parts.length === 1) return isLink(first) || isTitle(first);
  return parts.length === 2 && isTitle(first) && isLink(second);
}

/**
 * Whether one line of the AI review section keeps to the rule that model text is only ordinary
 * words outside code spans: a fence line of its prompt block, one of its fixed lines that hold
 * markup, its count line or the line of a finding in their shapes, or prose.
 */
export function checkSectionLine(line: string): boolean {
  if (FENCE_LINE.test(line) || MARKUP_LINES.has(line) || FINDINGS_LINE.test(line)) return true;
  if (line.startsWith('- **')) return checkFindingLine(line);
  return checkProse(line);
}

// ─── The first note of an AI review thread (server/src/review/render.ts) ─────

const ISSUE_MARKER_LINE =
  /^<!-- qualor:issue [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} -->$/;
/** The header: its fixed words, and the rule key in a code span. */
const THREAD_HEADER =
  /^\*\*AI review\*\* · (?:High|Medium|Low|Unknown) · [A-Z][a-z]+(?: [a-z]+)? · (?:likely|possible) · ` [a-z:-]+ `$/;
/** The opening line of a suggestion block: GitLab's `-0+N`, or GitHub's. */
const SUGGESTION_OPEN = /^```suggestion(?::-0\+\d+)?$/;
/** The labels of the lines that say what a finding assumes and that it needs validation. */
const THREAD_LABELS = ['Assumes: ', 'Needs validation: '] as const;
const THREAD_LINK = /^\[View in Qualor\]\(https:\/\/q\.example\/[A-Za-z0-9/-]*\)$/;

/**
 * Whether every line of an AI review thread's first note keeps to the rule that model text is only
 * ordinary words outside code spans: the marker on the first line and the header on the second;
 * then prose (the title in bold, the body, the labelled lines), Qualor's link, and the suggestion
 * block, whose lines are code a person applies (each with no fence run, and none a quick action).
 */
export function checkAiThreadLines(body: string): boolean {
  const lines = body.split('\n');
  if (!ISSUE_MARKER_LINE.test(lines[0] ?? '') || !THREAD_HEADER.test(lines[1] ?? '')) return false;
  let inSuggestion = false;
  for (const line of lines.slice(2)) {
    if (inSuggestion) {
      if (line === '```') inSuggestion = false;
      else if (/`{3,}|~{3,}/.test(line) || /^\s*\//.test(line)) return false;
      continue;
    }
    if (SUGGESTION_OPEN.test(line)) {
      inSuggestion = true;
      continue;
    }
    if (line === '' || THREAD_LINK.test(line)) continue;
    const bold = /^\*\*(.+)\*\*$/.exec(line);
    const label = THREAD_LABELS.find((l) => line.startsWith(l));
    const prose = bold?.[1] ?? (label === undefined ? line : line.slice(label.length));
    if (!checkProse(prose)) return false;
  }
  return !inSuggestion;
}
