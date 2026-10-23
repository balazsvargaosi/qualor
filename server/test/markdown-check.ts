/**
 * The checks of scm.md §6 on a comment body GitLab or GitHub renders as Markdown, shared by the
 * rendering tests (server/src/scm/render.test.ts) and the AI assistant's end-to-end test.
 */

import { AI_SECTION_FIXED_TEXT } from '../src/review/render';

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
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\u115f\u1160\u2800\u3164\uffa0\ufeff\ud800-\udfff]|[\u{e0000}-\u{e007f}]/u;

/**
 * What a model's prose may keep outside code spans (`safeProse`): letters, digits, spaces
 * and the punctuation of ordinary sentences, including the quotes and the bracket a word may
 * open with or end in. No character that GitLab or GitHub gives a meaning to is among them.
 */
export const PROSE_TEXT = /^[\p{L}\p{N} .,;:!?'\u2019"\u201c\u201d\u2018()-]*$/u;
/** A list marker at the start of a line, as `safeProse` writes it. */
const LIST_MARKER = /^(?:- |\d+\. )/;
/** Qualor's own link in the section: fixed text, and an address Qualor built from ids. */
const SECTION_LINK = /\[(?:View in Qualor| )\]\(https?:\/\/[^\s()]+\)/g;

/** A fence line of the section's prompt block: backticks, and the language on the opening one. */
const FENCE_LINE = /^`{3,}(?:text)?$/;

/**
 * Whether one line of the AI review section, or of `safeProse`'s output, is only ordinary words: once the
 * code spans, Qualor's own links, the list marker at its start and the section's `fixed` texts are
 * taken out, only ordinary words and their punctuation are left. `fixed` texts are compared as
 * they read with their code spans taken out, the way the line does.
 */
export function checkProse(line: string, fixed: readonly string[] = []): boolean {
  let rest = outsideCodeSpans(line).replace(SECTION_LINK, ' ');
  rest = rest.replace(LIST_MARKER, '');
  const known = fixed.map(outsideCodeSpans).sort((a, b) => b.length - a.length);
  for (const text of known) if (text !== '') rest = rest.split(text).join(' ');
  return PROSE_TEXT.test(rest);
}

/**
 * Whether one line of the AI review section is only ordinary words: a fence line of its prompt block, or
 * prose besides the section's own fixed texts (the sentences of review/render.ts).
 */
export function checkSectionLine(line: string): boolean {
  return FENCE_LINE.test(line) || checkProse(line, AI_SECTION_FIXED_TEXT);
}
