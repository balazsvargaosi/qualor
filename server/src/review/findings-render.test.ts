import {
  contextHash,
  filelessHash,
  lineHash,
  normalizeSarif,
  REDACTED,
  type NormalizeOptions,
} from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { ReviewableChange } from './context';
import { fingerprintOf, placeFinding, reviewScope, type PlannedFinding } from './findings';
import { renderFinding, reviewSummary, reviewSummarySchema } from './findings-render';
import { lineCountOf, MaskedText } from './masked-files';
import type { JudgedFinding, PipelineOutcome } from './pipeline';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function change(path: string, over: Partial<ReviewableChange> = {}): ReviewableChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    since: null,
    hasPatch: true,
    patchUsable: true,
    lines: 100,
    text: null,
    added: new Set(range(10, 20)),
    removalPoints: [],
    changedLines: 11,
    sensitive: false,
    removed: [],
    unshown: null,
    ...over,
  };
}

function judged(over: Partial<JudgedFinding> = {}): JudgedFinding {
  return {
    category: 'logic',
    severity: 'major',
    confidence: 'high',
    path: 'src/a.ts',
    line: 12,
    endLine: 12,
    title: 'Total skips the last item',
    body: 'The loop stops one item early.',
    assumption: null,
    suggestion: null,
    sources: [],
    priorId: null,
    verification: null,
    ...over,
  };
}

type Reviewed = Extract<PipelineOutcome, { kind: 'reviewed' }>;
const outcomeOf = (over: Partial<Reviewed> = {}): Reviewed => ({
  kind: 'reviewed',
  tier: 'lite',
  specialists: ['quality'],
  findings: [],
  prior: [],
  shownPriorIds: [],
  namedPriorIds: [],
  summary: { verdict: 'One problem.', walkthrough: ['The cart.'] },
  tokenLimitReached: false,
  notes: [],
  ...over,
});

describe('renderFinding', () => {
  /** A file of 60 lines `line N;`, masked as a whole, with `over` for some of its lines. */
  const file = (over: Record<number, string> = {}): MaskedText => {
    const text = `${range(1, 60)
      .map((n) => over[n] ?? `line ${n};`)
      .join('\n')}\n`;
    return MaskedText.of(text, lineCountOf(text));
  };
  const planned = (
    finding: JudgedFinding,
    over: Partial<ReviewableChange> = {},
  ): PlannedFinding => {
    const ch = change('src/a.ts', { lines: 60, added: new Set(range(10, 30)), ...over });
    const { anchorLine } = placeFinding(finding, ch, reviewScope([ch]));
    return { finding, change: ch, anchorLine };
  };

  it('maps the severity and keeps the confidence, the verification and the lines', () => {
    for (const [severity, expected] of [
      ['critical', 'high'],
      ['major', 'medium'],
      ['minor', 'low'],
    ] as const) {
      const rendered = renderFinding(planned(judged({ severity })), 'logic', file());
      expect(rendered.severity).toBe(expected);
    }
    const rendered = renderFinding(
      planned(
        judged({ confidence: 'medium', verification: 'needs_validation', line: 14, endLine: 16 }),
      ),
      'logic',
      file(),
    );
    expect(rendered).toMatchObject({
      category: 'logic',
      path: 'src/a.ts',
      startLine: 14,
      endLine: 16,
      confidence: 'medium',
      verification: 'needs_validation',
      anchorLine: 14,
    });
  });

  it('cuts the texts to their columns and replaces what a text column cannot hold', () => {
    const rendered = renderFinding(
      planned(
        judged({
          title: `  A\u0000title ${'t'.repeat(300)}  `,
          body: `Body\u0000${'b'.repeat(2500)}`,
          assumption: `Assumes\u0000${'a'.repeat(400)}`,
        }),
      ),
      'logic',
      file(),
    );
    expect(rendered.message.startsWith('A\uFFFDtitle t')).toBe(true);
    expect([...rendered.message]).toHaveLength(120);
    expect(rendered.message.endsWith('…')).toBe(true);
    expect(rendered.body.startsWith('Body\uFFFDb')).toBe(true);
    expect([...rendered.body]).toHaveLength(2000);
    expect(rendered.assumption?.startsWith('Assumes\uFFFDa')).toBe(true);
    expect([...(rendered.assumption ?? '')]).toHaveLength(300);
    for (const text of [rendered.message, rendered.body, rendered.assumption ?? '']) {
      expect(text).not.toContain('\u0000');
    }
    // No assumption, or a blank one, is none.
    expect(
      renderFinding(planned(judged({ assumption: '  ' })), 'logic', file()).assumption,
    ).toBeNull();
    expect(
      renderFinding(planned(judged({ assumption: null })), 'logic', file()).assumption,
    ).toBeNull();
  });

  it('replaces a lone surrogate in model text, which a jsonb value cannot hold', () => {
    const lone = String.fromCharCode(0xd800);
    const replacement = String.fromCodePoint(0xfffd);
    const rendered = renderFinding(
      planned(judged({ title: `A${lone}B`, body: `Body${lone}`, assumption: `${lone}Assumes` })),
      'logic',
      file(),
    );
    expect(rendered.message).toBe(`A${replacement}B`);
    expect(rendered.body).toBe(`Body${replacement}`);
    expect(rendered.assumption).toBe(`${replacement}Assumes`);
  });

  it('makes the fingerprint of the category given, the path and the title', () => {
    const f = judged({ category: 'security', title: 'Total skips the last item' });
    const rendered = renderFinding(planned(f), 'logic', file());
    expect(rendered.fingerprint).toBe(fingerprintOf('logic', 'src/a.ts', f.title));
    expect(rendered.category).toBe('logic');
  });

  it("makes the snippet and the hashes of the masked head file, as ingestion makes a report's", () => {
    // Line 14 is longer than a snippet line may be.
    const all = range(1, 60).map((n) => (n === 14 ? 'y'.repeat(1000) : `line ${n};`));
    const text = `${all.join('\n')}\n`;
    const head = MaskedText.of(text, lineCountOf(text));

    const ingestion = (startLine: number, endLine: number) => {
      const out = normalizeSarif(
        {
          version: '2.1.0',
          runs: [
            {
              tool: { driver: { name: 'ESLint', rules: [{ id: 'r' }] } },
              results: [
                {
                  ruleId: 'r',
                  message: { text: 'm' },
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: 'src/a.ts' },
                        region: { startLine, endLine },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        { engineId: 'eslint', repoRoot: '/repo', readLines: () => all } satisfies NormalizeOptions,
      );
      return out.findings[0];
    };
    for (const [startLine, endLine] of [
      [1, 1],
      [2, 2],
      [14, 14],
      [30, 33],
      [30, 40],
      [57, 60],
      [58, 60],
      [60, 60],
    ] as const) {
      const rendered = renderFinding(
        planned(judged({ line: startLine, endLine }), { added: new Set(range(1, 60)) }),
        'logic',
        head,
      );
      const reported = ingestion(startLine, endLine);
      const where = `${startLine}-${endLine}`;
      expect(rendered.snippet, where).toEqual(reported?.snippet);
      expect([rendered.lineHash, rendered.contextHash], where).toEqual([
        reported?.lineHash,
        reported?.contextHash,
      ]);
      expect(rendered.lineHash, where).toBe(lineHash(all, startLine, endLine));
      expect(rendered.contextHash, where).toBe(contextHash(all, startLine, endLine));
    }
    // A long line is cut as a report's snippet cuts it.
    const cut = renderFinding(planned(judged({ line: 14, endLine: 14 })), 'logic', head);
    expect(cut.snippet?.lines[3]).toHaveLength(400);
    expect(cut.snippet?.lines[3]?.endsWith('…')).toBe(true);
  });

  it('cuts a long snippet line before a character outside the basic plane, never through it', () => {
    // The 399th unit would be half of the emoji: jsonb refuses a lone surrogate.
    const wide = `${'a'.repeat(398)}${String.fromCodePoint(0x1f600)}${'b'.repeat(10)}`;
    const lines = range(1, 20).map((n) => (n === 5 ? wide : `line ${n};`));
    const text = `${lines.join('\n')}\n`;
    const head = MaskedText.of(text, lineCountOf(text));
    const rendered = renderFinding(planned(judged({ line: 5, endLine: 5 })), 'logic', head);
    const cut = rendered.snippet?.lines[3];
    expect(cut).toBe(`${'a'.repeat(398)}…`);
    expect(JSON.stringify(rendered.snippet)).not.toMatch(/ud[89a-f][0-9a-f]{2}/i);
  });

  it('keeps a suggestion that starts or ends within three lines of the finding, and no other', () => {
    const suggestionAt = (startLine: number, endLine: number) =>
      renderFinding(
        planned(
          judged({
            line: 15,
            endLine: 15,
            suggestion: { startLine, endLine, lines: ['x;'] },
          }),
        ),
        'logic',
        file(),
      ).suggestion;
    expect(suggestionAt(18, 18)).not.toBeNull();
    expect(suggestionAt(19, 19)).toBeNull();
    expect(suggestionAt(12, 12)).not.toBeNull();
    expect(suggestionAt(11, 11)).toBeNull();
    expect(suggestionAt(11, 12)).not.toBeNull();
  });

  it('shows lines without their carriage returns, and hashes them as the same lines', () => {
    const body = range(1, 60).map((n) => `line ${n};`);
    const crlfText = `${body.join('\r\n')}\r\n`;
    const crlf = MaskedText.of(crlfText, lineCountOf(crlfText));
    const find = planned(judged({ line: 15, endLine: 15 }));
    const lf = renderFinding(find, 'logic', file());
    const windows = renderFinding(find, 'logic', crlf);
    expect(windows.snippet).toEqual(lf.snippet);
    expect(windows.snippet?.lines.some((line) => line.includes('\r'))).toBe(false);
    expect([windows.lineHash, windows.contextHash]).toEqual([lf.lineHash, lf.contextHash]);
  });

  it('shows the masked lines, and hashes them as masked', () => {
    const secret = `const key = "${REDACTED}";`;
    const head = file({ 15: secret });
    const rendered = renderFinding(planned(judged({ line: 15, endLine: 15 })), 'logic', head);
    expect(rendered.snippet?.lines).toContain(secret);
    expect(rendered.snippet?.startLine).toBe(12);
    const lines = range(1, 60).map((n) => (n === 15 ? secret : `line ${n};`));
    expect(rendered.lineHash).toBe(lineHash(lines, 15, 15));
  });

  it("hashes the finding's own words and gives no snippet where it has no masked text to read", () => {
    const f = judged({ title: 'Total skips the last item', line: 15, endLine: 15 });
    const expected = filelessHash('ai:logic', f.title, 'src/a.ts');
    const unread = renderFinding(planned(f), 'logic', null);
    expect(unread.snippet).toBeNull();
    expect([unread.lineHash, unread.contextHash]).toEqual([expected, expected]);
    // A place past the end of the file the text holds is no place to read.
    const past = renderFinding(
      planned(judged({ title: f.title, line: 75, endLine: 75 })),
      'logic',
      file(),
    );
    expect(past.snippet).toBeNull();
    expect(past.lineHash).toBe(expected);
  });

  it("keeps a suggestion that passes the checks, and anchors the finding at the suggestion's first line", () => {
    const suggestion = { startLine: 13, endLine: 14, lines: ['const total = items.length;'] };
    const rendered = renderFinding(
      planned(judged({ line: 15, endLine: 15, suggestion })),
      'logic',
      file(),
    );
    expect(rendered.suggestion).toEqual(suggestion);
    expect(rendered.anchorLine).toBe(13);
    // The finding lies within three lines of the suggestion, beyond them it is no suggestion for it.
    const near = renderFinding(
      planned(judged({ line: 17, endLine: 17, suggestion })),
      'logic',
      file(),
    );
    expect(near.suggestion).toEqual(suggestion);
    const far = renderFinding(
      planned(judged({ line: 18, endLine: 18, suggestion })),
      'logic',
      file(),
    );
    expect(far.suggestion).toBeNull();
    expect(far.anchorLine).toBe(18);
  });

  it('drops a suggestion that fails a check, and the finding stays where the nearest added line puts it', () => {
    const over = (suggestion: JudgedFinding['suggestion'], head: MaskedText | null = file()) =>
      renderFinding(planned(judged({ line: 12, endLine: 12, suggestion })), 'logic', head);
    // Over a context line, over 16 lines, a fence, unchanged, and with no text to compare.
    for (const suggestion of [
      { startLine: 8, endLine: 12, lines: ['x;'] },
      { startLine: 10, endLine: 25, lines: ['x;'] },
      { startLine: 10, endLine: 12, lines: ['```'] },
      { startLine: 11, endLine: 12, lines: ['line 11;', 'line 12;'] },
    ]) {
      const rendered = over(suggestion);
      expect(rendered.suggestion, JSON.stringify(suggestion)).toBeNull();
      expect(rendered.anchorLine).toBe(12);
    }
    expect(over({ startLine: 11, endLine: 12, lines: ['x;'] }, null).suggestion).toBeNull();
    // A finding on a file the review has no change of has no lines a suggestion could replace.
    const withoutChange: PlannedFinding = {
      finding: judged({ suggestion: { startLine: 12, endLine: 12, lines: ['x;'] } }),
      change: undefined,
      anchorLine: null,
    };
    const rendered = renderFinding(withoutChange, 'logic', file());
    expect(rendered.suggestion).toBeNull();
    expect(rendered.anchorLine).toBeNull();
  });

  it('checks a suggestion against the masked text it is given, not the change text', () => {
    // The change has no masked text of the file; the caller had one made.
    const suggestion = { startLine: 11, endLine: 12, lines: ['x;'] };
    const f = judged({ line: 12, endLine: 12, suggestion });
    const bare = planned(f, { text: null });
    expect(renderFinding(bare, 'logic', file()).suggestion).toEqual(suggestion);
    expect(renderFinding(bare, 'logic', null).suggestion).toBeNull();
  });
});

describe('reviewSummary', () => {
  const summaryOf = (summary: Reviewed['summary'], notes: Reviewed['notes'] = []) =>
    reviewSummary(outcomeOf({ summary, notes }));

  it('keeps a clean summary and its notes, and passes the schema', () => {
    const summary = summaryOf(
      { verdict: 'One problem, a missing check.', walkthrough: ['The cart.', 'The tests.'] },
      ['token_limit_reached', 'reviewer_unreadable'],
    );
    expect(summary).toEqual({
      verdict: 'One problem, a missing check.',
      walkthrough: ['The cart.', 'The tests.'],
      notes: ['token_limit_reached', 'reviewer_unreadable'],
    });
    expect(reviewSummarySchema.parse(summary)).toEqual(summary);
  });

  it('makes the model text plain text for people: one line each, no control or hidden characters', () => {
    const summary = summaryOf({
      verdict: '  Fine\u0000but\n a second line\u202e  ',
      walkthrough: ['  A\u200bB  ', '\u0000\u0007', '   ', 'x'.repeat(300)],
    });
    expect(summary.verdict).toBe('Fine but');
    expect(summary.walkthrough[0]).toBe('AB');
    // Items that come to nothing are left out; a long one is cut.
    expect(summary.walkthrough).toHaveLength(2);
    expect([...(summary.walkthrough[1] ?? '')]).toHaveLength(200);
    expect(reviewSummarySchema.safeParse(summary).success).toBe(true);
    const hidden = [0x200b, 0x202e].map((code) => String.fromCharCode(code));
    for (const text of [summary.verdict, ...summary.walkthrough]) {
      expect([...text].filter((c) => c.charCodeAt(0) < 0x20 || hidden.includes(c))).toEqual([]);
    }
  });

  it('cuts an over-long verdict and keeps at most six points', () => {
    const summary = summaryOf({
      verdict: 'v'.repeat(500),
      walkthrough: range(1, 9).map((n) => `Point ${n}.`),
    });
    expect([...summary.verdict]).toHaveLength(200);
    expect(summary.walkthrough).toHaveLength(6);
    expect(reviewSummarySchema.safeParse(summary).success).toBe(true);
    // Characters outside the basic plane count once, as the cut does.
    const astral = summaryOf({ verdict: '😀'.repeat(150), walkthrough: [] });
    expect(astral.verdict).toBe('😀'.repeat(150));
    expect(reviewSummarySchema.safeParse(astral).success).toBe(true);
  });

  it('reads a verdict and a point that start with blank lines', () => {
    const summary = summaryOf({
      verdict: '\n\n  One problem.',
      walkthrough: ['\n Point.'],
    });
    expect(summary.verdict).toBe('One problem.');
    expect(summary.walkthrough).toEqual(['Point.']);
  });

  it('the schema refuses what a summary is not', () => {
    const ok = { verdict: 'v', walkthrough: ['w'], notes: [] };
    expect(reviewSummarySchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, notes: ['made_up'] },
      { ...ok, verdict: 'v'.repeat(201) },
      { ...ok, walkthrough: ['w'.repeat(201)] },
      { ...ok, walkthrough: range(1, 7).map(String) },
      { ...ok, walkthrough: [''] },
      { verdict: 'v', walkthrough: [] },
      { ...ok, verdict: 3 },
      null,
      'text',
    ]) {
      expect(reviewSummarySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
