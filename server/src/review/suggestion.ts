import {
  FIX_BOUNDS,
  REDACTED,
  redactText,
  suggestionLineProblem,
  type FixProblem,
} from '@qualor/shared';
import type { ReviewableChange } from './context';
import { ANSWER_LIMITS } from './schemas';

/*
 * Whether a finding's one-click suggestion may be posted: a replacement of added lines of the head
 * file. A wrong suggestion is worse than none, so the checks are strict and a suggestion that fails
 * one is dropped whole (the finding stays, and its body says how to fix it). The checks are the ones
 * of an AI fix suggestion (llm.md §9.5, `checkFix`), made for a review: the lines replaced must be
 * lines this merge request added, read from the head file as the model saw it, masked.
 */

/** A replacement of the head lines `startLine` to `endLine` by `lines`. */
export interface ReviewSuggestion {
  startLine: number;
  endLine: number;
  lines: string[];
}

/**
 * Why a suggestion does not pass. The fix suggestion's reasons, and: `not_added`, a line it replaces
 * is not one the merge request added; `masked_line`, a line it replaces holds a masked secret;
 * `no_text`, there is no masked text of the file to read the lines it replaces from.
 */
export type SuggestionProblem = FixProblem | 'not_added' | 'masked_line' | 'no_text';

const lineWithoutCarriageReturn = (line: string): string =>
  line.endsWith('\r') ? line.slice(0, -1) : line;

/**
 * Checks `s` against the head file of `change`: its masked text (`change.text`) and the lines the
 * merge request added. The first rule it breaks is the answer, in this order: the range and the size,
 * the lines replaced (added, readable, not masked), whether anything changes, the lines written.
 */
export function checkReviewSuggestion(
  s: ReviewSuggestion,
  change: ReviewableChange,
): { ok: true } | { ok: false; problem: SuggestionProblem } {
  const fail = (problem: SuggestionProblem) => ({ ok: false as const, problem });
  const { startLine, endLine } = s;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return fail('range');
  if (startLine < 1 || endLine < startLine) return fail('range');
  if (endLine - startLine + 1 > ANSWER_LIMITS.suggestionReplacedLines) return fail('range');
  if (s.lines.length > ANSWER_LIMITS.suggestionLines) return fail('size');
  for (let line = startLine; line <= endLine; line += 1) {
    if (!change.added.has(line)) return fail('not_added');
  }
  const { text } = change;
  if (text === null) return fail('no_text');
  if (endLine > text.lineCount) return fail('range');

  const original: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    original.push(lineWithoutCarriageReturn(text.line(line - 1)));
  }
  if (original.some((line) => line.includes(REDACTED))) return fail('masked_line');
  // The model was shown such a line cut, and may write no line this long: it cannot be put back whole.
  if (original.some((line) => line.length > FIX_BOUNDS.maxLineChars)) {
    return fail('source_line_unusable');
  }
  if (s.lines.length === original.length && s.lines.every((line, i) => line === original[i])) {
    return fail('unchanged');
  }
  for (const line of s.lines) {
    const problem = suggestionLineProblem(line);
    if (problem !== null) return fail(problem);
  }
  // Line by line misses a secret split over lines; the redaction of the whole text catches it.
  if (redactText(s.lines.join('\n')).count > 0) return fail('secret');
  return { ok: true };
}

/**
 * Whether a stored suggestion still applies to the provider's diff of the merge request as it is
 * now, when a decoration posts it: every line it replaces is an added line of that diff (`added`:
 * new line number → text, `addedLineTexts` of scm/inline.ts) and holds the text the review read in
 * the snapshot (`reviewed`, the lines `startLine` to `endLine`; null when the snapshot is gone).
 * Anything else would replace other code than the model was shown: the suggestion is left out.
 */
export function suggestionApplies(
  s: ReviewSuggestion,
  added: ReadonlyMap<number, string>,
  reviewed: readonly string[] | null,
): boolean {
  if (reviewed === null || reviewed.length !== s.endLine - s.startLine + 1) return false;
  return reviewed.every((text, i) => added.get(s.startLine + i) === text);
}
