import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ANSWER_LIMITS,
  judgeAnswerSchema,
  reviewFindingOf,
  specialistAnswerSchema,
  verifyAnswerSchema,
} from './schemas';

/** A finding as a specialist writes it, every key given. */
const finding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: 'logic',
  severity: 'major',
  confidence: 'high',
  path: 'src/cart.ts',
  line: 12,
  endLine: 14,
  title: 'The loop stops one item early',
  body: 'The bound is `i < n - 1`, so the last item is never added. Use `i < n`.',
  assumption: null,
  suggestion: { startLine: 12, endLine: 12, lines: ['for (let i = 0; i < n; i += 1) {'] },
  ...over,
});
const judged = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...finding(),
  sources: ['s1', 's3'],
  priorId: null,
  ...over,
});
const judgeAnswer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  findings: [judged()],
  dropped: [{ source: 's2', reason: 'The analyzers already report it.' }],
  prior: [{ id: 'issue-1', status: 'fixed', reason: 'The check is now on line 20.' }],
  summary: { verdict: 'One major logic error in the cart total.', walkthrough: ['Adds a total.'] },
  ...over,
});
const text = (length: number): string => 'x'.repeat(length);
const many = <T>(count: number, make: () => T): T[] => Array.from({ length: count }, make);

const passes = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

describe('the review answer schemas', () => {
  it('strict schemas refuse unknown keys, out-of-range lines, over-long text and more than 40 findings', () => {
    expect(passes(specialistAnswerSchema, { findings: [finding()] })).toBe(true);
    expect(passes(specialistAnswerSchema, { findings: [] })).toBe(true);
    expect(passes(judgeAnswerSchema, judgeAnswer())).toBe(true);
    expect(passes(verifyAnswerSchema, { verdict: 'confirmed', reason: 'Input reaches it.' })).toBe(
      true,
    );

    // Unknown keys, at every level.
    expect(passes(specialistAnswerSchema, { findings: [], notes: 'none' })).toBe(false);
    expect(passes(specialistAnswerSchema, { findings: [finding({ fix: 'x' })] })).toBe(false);
    expect(
      passes(specialistAnswerSchema, {
        findings: [finding({ suggestion: { startLine: 12, endLine: 12, lines: [], why: 'x' } })],
      }),
    ).toBe(false);
    // A judge's keys are not a specialist's.
    expect(passes(specialistAnswerSchema, { findings: [judged()] })).toBe(false);
    expect(passes(judgeAnswerSchema, judgeAnswer({ approved: true }))).toBe(false);
    expect(passes(judgeAnswerSchema, judgeAnswer({ findings: [judged({ reviewer: 'x' })] }))).toBe(
      false,
    );
    expect(
      passes(judgeAnswerSchema, judgeAnswer({ dropped: [{ source: 's1', reason: 'r', by: 'x' }] })),
    ).toBe(false);
    expect(
      passes(
        judgeAnswerSchema,
        judgeAnswer({ prior: [{ id: 'issue-1', status: 'fixed', reason: 'r', line: 3 }] }),
      ),
    ).toBe(false);
    expect(
      passes(
        judgeAnswerSchema,
        judgeAnswer({ summary: { verdict: 'v', walkthrough: [], approve: true } }),
      ),
    ).toBe(false);
    expect(
      passes(verifyAnswerSchema, { verdict: 'confirmed', reason: 'r', confidence: 'high' }),
    ).toBe(false);

    // Lines: whole numbers from 1, and a range that does not end before it starts.
    for (const lines of [
      { line: 0 },
      { line: -3 },
      { line: 2.5 },
      { line: '12' },
      { line: Number.MAX_SAFE_INTEGER + 1, endLine: null },
      { endLine: 0 },
      { endLine: 11 },
      { suggestion: { startLine: 0, endLine: 1, lines: [] } },
      { suggestion: { startLine: 13, endLine: 12, lines: [] } },
      { suggestion: { startLine: 12, endLine: 12.5, lines: [] } },
    ]) {
      expect(
        passes(specialistAnswerSchema, { findings: [finding(lines)] }),
        JSON.stringify(lines),
      ).toBe(false);
    }
    expect(passes(specialistAnswerSchema, { findings: [finding({ line: 12, endLine: 12 })] })).toBe(
      true,
    );

    // Text: at its bound it passes, one character over it is refused, and so is blank text.
    const bounded: [string, number, (value: string) => Record<string, unknown>][] = [
      ['title', 120, (value) => ({ findings: [finding({ title: value })] })],
      ['body', 1_200, (value) => ({ findings: [finding({ body: value })] })],
      ['assumption', 300, (value) => ({ findings: [finding({ assumption: value })] })],
      ['path', 1_024, (value) => ({ findings: [finding({ path: value })] })],
      [
        'suggestion line',
        400,
        (value) => ({
          findings: [finding({ suggestion: { startLine: 1, endLine: 1, lines: [value] } })],
        }),
      ],
    ];
    for (const [name, max, answer] of bounded) {
      expect(passes(specialistAnswerSchema, answer(text(max))), name).toBe(true);
      expect(passes(specialistAnswerSchema, answer(text(max + 1))), name).toBe(false);
    }
    for (const key of ['title', 'body', 'path']) {
      expect(passes(specialistAnswerSchema, { findings: [finding({ [key]: '' })] }), key).toBe(
        false,
      );
      expect(passes(specialistAnswerSchema, { findings: [finding({ [key]: ' \n ' })] }), key).toBe(
        false,
      );
    }
    const judgeBounded: [string, number, (value: string) => Record<string, unknown>][] = [
      ['verdict', 200, (value) => judgeAnswer({ summary: { verdict: value, walkthrough: [] } })],
      [
        'walkthrough',
        200,
        (value) => judgeAnswer({ summary: { verdict: 'v', walkthrough: [value] } }),
      ],
      // A few words: a judge drops many findings, and its answer must stay short.
      [
        'dropped reason',
        150,
        (value) => judgeAnswer({ dropped: [{ source: 's1', reason: value }] }),
      ],
      [
        'prior reason',
        300,
        (value) => judgeAnswer({ prior: [{ id: 'issue-1', status: 'present', reason: value }] }),
      ],
    ];
    for (const [name, max, answer] of judgeBounded) {
      expect(passes(judgeAnswerSchema, answer(text(max))), name).toBe(true);
      expect(passes(judgeAnswerSchema, answer(text(max + 1))), name).toBe(false);
    }
    expect(passes(verifyAnswerSchema, { verdict: 'rejected', reason: text(300) })).toBe(true);
    expect(passes(verifyAnswerSchema, { verdict: 'rejected', reason: text(301) })).toBe(false);
    expect(passes(verifyAnswerSchema, { verdict: 'rejected', reason: '' })).toBe(false);

    // Counts: 30 findings of a specialist, 40 of the judge, 6 walkthrough points, 30 lines written.
    expect(passes(specialistAnswerSchema, { findings: many(30, finding) })).toBe(true);
    expect(passes(specialistAnswerSchema, { findings: many(31, finding) })).toBe(false);
    expect(passes(judgeAnswerSchema, judgeAnswer({ findings: many(40, judged) }))).toBe(true);
    expect(passes(judgeAnswerSchema, judgeAnswer({ findings: many(41, judged) }))).toBe(false);
    const walkthrough = (count: number) =>
      judgeAnswer({ summary: { verdict: 'v', walkthrough: many(count, () => 'A step.') } });
    expect(passes(judgeAnswerSchema, walkthrough(6))).toBe(true);
    expect(passes(judgeAnswerSchema, walkthrough(7))).toBe(false);
    const written = (count: number) => ({
      findings: [
        finding({ suggestion: { startLine: 1, endLine: 2, lines: many(count, () => 'x();') } }),
      ],
    });
    expect(passes(specialistAnswerSchema, written(30))).toBe(true);
    expect(passes(specialistAnswerSchema, written(31))).toBe(false);

    // Values outside their lists.
    for (const over of [
      { category: 'style' },
      { severity: 'high' },
      { severity: 'blocker' },
      { confidence: 'certain' },
    ]) {
      expect(
        passes(specialistAnswerSchema, { findings: [finding(over)] }),
        JSON.stringify(over),
      ).toBe(false);
    }
    expect(
      passes(
        judgeAnswerSchema,
        judgeAnswer({ prior: [{ id: 'issue-1', status: 'open', reason: 'r' }] }),
      ),
    ).toBe(false);
    expect(passes(verifyAnswerSchema, { verdict: 'likely', reason: 'r' })).toBe(false);

    // Every key of an answer is there: none is left out.
    for (const key of ['findings', 'dropped', 'prior', 'summary']) {
      const answer = Object.fromEntries(
        Object.entries(judgeAnswer()).filter(([name]) => name !== key),
      );
      expect(passes(judgeAnswerSchema, answer), key).toBe(false);
    }
    expect(
      passes(judgeAnswerSchema, judgeAnswer({ findings: [judged({ sources: undefined })] })),
    ).toBe(false);
    expect(passes(verifyAnswerSchema, { verdict: 'confirmed' })).toBe(false);
  });

  it('an optional part may be left out or null, and reads as null', () => {
    for (const over of [
      { endLine: undefined, assumption: undefined, suggestion: undefined },
      { endLine: null, assumption: null, suggestion: null },
      // A blank assumption says nothing.
      { endLine: null, assumption: '  ', suggestion: null },
    ]) {
      const parsed = specialistAnswerSchema.parse({ findings: [finding(over)] });
      const [only] = parsed.findings;
      if (only === undefined) throw new Error('no finding');
      expect(reviewFindingOf(only)).toEqual({
        category: 'logic',
        severity: 'major',
        confidence: 'high',
        path: 'src/cart.ts',
        line: 12,
        endLine: 12,
        title: 'The loop stops one item early',
        body: 'The bound is `i < n - 1`, so the last item is never added. Use `i < n`.',
        assumption: null,
        suggestion: null,
      });
    }
    expect(
      passes(judgeAnswerSchema, judgeAnswer({ findings: [judged({ priorId: undefined })] })),
    ).toBe(true);
    // A suggestion of no lines deletes the lines it replaces.
    expect(
      passes(specialistAnswerSchema, {
        findings: [finding({ suggestion: { startLine: 12, endLine: 13, lines: [] } })],
      }),
    ).toBe(true);
  });
});

describe('ANSWER_LIMITS', () => {
  it('holds the values of the contract, which the prompts state and the storing of findings checks', () => {
    expect(ANSWER_LIMITS).toEqual({
      specialistFindings: 30,
      judgeFindings: 40,
      dropped: 120,
      sources: 120,
      priorVerdicts: 50,
      pathChars: 1_024,
      titleChars: 120,
      bodyChars: 1_200,
      assumptionChars: 300,
      reasonChars: 300,
      dropReasonChars: 150,
      verdictChars: 200,
      walkthroughItems: 6,
      walkthroughChars: 200,
      suggestionReplacedLines: 15,
      suggestionLines: 30,
      suggestionLineChars: 400,
      idChars: 64,
    });
  });
});
