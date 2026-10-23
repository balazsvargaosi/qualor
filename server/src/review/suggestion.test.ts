import { REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { ReviewableChange } from './context';
import { lineCountOf, MaskedText } from './masked-files';
import { ANSWER_LIMITS } from './schemas';
import { checkReviewSuggestion, type ReviewSuggestion } from './suggestion';

const j = (...parts: string[]) => parts.join('');

/** The head file: `const line<N> = <N>;`, 40 lines, with `over` replacing some of them. */
function head(over: Record<number, string> = {}): string[] {
  return Array.from({ length: 40 }, (_, i) => over[i + 1] ?? `const line${i + 1} = ${i + 1};`);
}

const maskedText = (lines: readonly string[], eol = '\n'): MaskedText => {
  const text = `${lines.join(eol)}${eol}`;
  return MaskedText.of(text, lineCountOf(text));
};

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A change that added lines 5 to 24 of a file of 40 lines whose masked text is at hand. */
function change(over: Partial<ReviewableChange> = {}): ReviewableChange {
  return {
    path: 'src/cart.ts',
    oldPath: null,
    status: 'modified',
    since: null,
    hasPatch: true,
    patchUsable: true,
    lines: 40,
    text: maskedText(head()),
    added: new Set(range(5, 24)),
    removalPoints: [],
    changedLines: 20,
    sensitive: false,
    removed: [],
    unshown: null,
    ...over,
  };
}

const suggest = (startLine: number, endLine: number, lines: string[]): ReviewSuggestion => ({
  startLine,
  endLine,
  lines,
});
const problem = (s: ReviewSuggestion, c: ReviewableChange = change()) => {
  const result = checkReviewSuggestion(s, c);
  return result.ok ? null : result.problem;
};

describe('checkReviewSuggestion', () => {
  it('accepts a replacement that differs from the added lines it replaces', () => {
    const s = suggest(6, 7, ['const total = items.length;', 'const done = true;']);
    expect(checkReviewSuggestion(s, change())).toEqual({ ok: true });
    // A different number of lines, and no lines at all (the lines are deleted).
    expect(checkReviewSuggestion(suggest(6, 7, ['const both = 6 + 7;']), change())).toEqual({
      ok: true,
    });
    expect(checkReviewSuggestion(suggest(6, 7, []), change())).toEqual({ ok: true });
    // A replacement may add lines to one.
    expect(checkReviewSuggestion(suggest(6, 6, ['a;', 'b;']), change())).toEqual({ ok: true });
  });

  it('accepts the bounds: 15 lines replaced and 30 written, and refuses one more of either', () => {
    expect(ANSWER_LIMITS.suggestionReplacedLines).toBe(15);
    expect(ANSWER_LIMITS.suggestionLines).toBe(30);
    const thirty = Array.from({ length: 30 }, (_, i) => `const w${i} = ${i};`);
    expect(problem(suggest(5, 19, thirty))).toBeNull();
    expect(problem(suggest(5, 20, ['const x = 1;']))).toBe('range');
    expect(problem(suggest(5, 6, [...thirty, 'const w30 = 30;']))).toBe('size');
  });

  it('refuses a replacement over a line the change did not add: a context line', () => {
    // Line 4 is unchanged context just above the added lines, 25 just below; 1 is far away.
    expect(problem(suggest(4, 6, ['x;']))).toBe('not_added');
    expect(problem(suggest(23, 25, ['x;']))).toBe('not_added');
    expect(problem(suggest(1, 1, ['x;']))).toBe('not_added');
    // A change that added scattered lines: a gap between two of them is a context line.
    const scattered = change({ added: new Set([10, 11, 13]) });
    expect(problem(suggest(10, 13, ['x;']), scattered)).toBe('not_added');
    expect(problem(suggest(10, 11, ['x;']), scattered)).toBeNull();
    // A file the change did not add anything to.
    expect(problem(suggest(10, 10, ['x;']), change({ added: new Set() }))).toBe('not_added');
  });

  it('refuses a replacement over a masked line', () => {
    const masked = change({ text: maskedText(head({ 7: `const key = "${REDACTED}";` })) });
    expect(problem(suggest(6, 8, ['x;']), masked)).toBe('masked_line');
    // Beside it, not over it.
    expect(problem(suggest(8, 9, ['x;']), masked)).toBeNull();
  });

  it('refuses a replacement that is not a range of at least one line within the file', () => {
    for (const [start, end] of [
      [8, 7],
      [0, 3],
      [-2, 3],
      [5.5, 7],
      [6, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(problem(suggest(start, end, ['x;'])), `${start}-${end}`).toBe('range');
    }
    // Added lines past the end of the text the change holds are not lines of it.
    const short = change({ text: maskedText(head().slice(0, 10)), added: new Set(range(5, 24)) });
    expect(problem(suggest(9, 12, ['x;']), short)).toBe('range');
    expect(problem(suggest(9, 10, ['x;']), short)).toBeNull();
  });

  it('refuses a replacement of lines the review could not see whole: one cut at 400 characters', () => {
    const wide = change({ text: maskedText(head({ 7: `const wide = "${'w'.repeat(500)}";` })) });
    expect(problem(suggest(7, 7, ['x;']), wide)).toBe('source_line_unusable');
    expect(problem(suggest(8, 8, ['x;']), wide)).toBeNull();
  });

  it('refuses a replacement it cannot compare with the lines it replaces: no masked text of the file', () => {
    expect(problem(suggest(6, 7, ['x;']), change({ text: null }))).toBe('no_text');
  });

  it('refuses a replacement that is the lines it replaces, whatever their line ends', () => {
    expect(problem(suggest(6, 7, ['const line6 = 6;', 'const line7 = 7;']))).toBe('unchanged');
    const windows = change({ text: maskedText(head(), '\r\n') });
    expect(problem(suggest(6, 7, ['const line6 = 6;', 'const line7 = 7;']), windows)).toBe(
      'unchanged',
    );
    // A change of indentation, or of one line of two, is a change.
    expect(problem(suggest(6, 7, ['const line6 = 6;', ' const line7 = 7;']))).toBeNull();
    expect(problem(suggest(6, 7, ['const line6 = 6;']))).toBeNull();
  });

  it('refuses a written line that opens a fence', () => {
    expect(problem(suggest(6, 6, ['```']))).toBe('fence');
    expect(problem(suggest(6, 6, ['x;', 'a ~~~ b']))).toBe('fence');
  });

  it('refuses a written line that starts a quick action', () => {
    expect(problem(suggest(6, 6, ['/close']))).toBe('quick_action');
    expect(problem(suggest(6, 6, ['  /assign @someone']))).toBe('quick_action');
    // Code that merely starts with a slash is code.
    expect(problem(suggest(6, 6, ['// a comment']))).toBeNull();
    expect(problem(suggest(6, 6, ['/* a comment */']))).toBeNull();
  });

  it('refuses a written line with a masked secret, a control or hidden character, or too many characters', () => {
    expect(problem(suggest(6, 6, [`const key = "${REDACTED}";`]))).toBe('redacted');
    expect(problem(suggest(6, 6, ['a\u0000b']))).toBe('control_character');
    expect(problem(suggest(6, 6, ['a\u202eb']))).toBe('control_character');
    expect(problem(suggest(6, 6, ['a\u200bb']))).toBe('control_character');
    expect(problem(suggest(6, 6, ['x'.repeat(401)]))).toBe('size');
    expect(problem(suggest(6, 6, ['x'.repeat(400)]))).toBeNull();
    // A tab is indentation.
    expect(problem(suggest(6, 6, ['\treturn 1;']))).toBeNull();
  });

  it('refuses a replacement that holds a secret, also one split over two lines', () => {
    const password = j('const password = "', 'hunter2', '-very-secret";');
    expect(problem(suggest(6, 6, [password]))).toBe('secret');
    // Each line passes alone; the two together are a token.
    const first = j('const t = "gh', 'p_', 'a1b2c3d4e5f6a1b2c3d4"');
    const second = j('  + "e5f6a1b2c3d4e5f6', '"');
    expect(problem(suggest(6, 6, [first]))).toBeNull();
    expect(problem(suggest(6, 6, [second]))).toBeNull();
    expect(problem(suggest(6, 7, [first, second]))).toBe('secret');
  });

  it('reports the first rule a replacement breaks: its place before its text', () => {
    const fenced = ['```'];
    expect(problem(suggest(4, 6, fenced))).toBe('not_added');
    expect(problem(suggest(5, 21, fenced))).toBe('range');
    expect(problem(suggest(6, 7, fenced), change({ text: null }))).toBe('no_text');
  });
});
