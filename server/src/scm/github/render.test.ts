import { createHash } from 'node:crypto';
import type { GateResult } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { checkSectionLine } from '../../../test/markdown-check';
import type { ReviewSummaryState } from '../../review/render';
import { markerOf } from '../markdown';
import {
  INLINE_MAX_BYTES,
  inlineBody,
  SUMMARY_MAX_BYTES,
  summaryBody,
  type SummaryInput,
} from '../render';
import {
  checkRunExternalId,
  checkRunSummary,
  checkRunVerdict,
  NO_ANNOTATIONS_DIGEST,
  parseCheckRunExternalId,
  reviewBody,
} from './render';

const PROJECT = '0190c3b2-7a00-7000-8000-000000000001';
const gate = (status: GateResult['status']): GateResult =>
  ({ status, gate: null, conditions: [], warnings: [] }) as unknown as GateResult;

describe('the check run’s external id (github.md §6.1, ruling T4)', () => {
  it('carries the digest of an empty annotation list, which 0.11 wrote for a check run without any', () => {
    // Pinned: another value replaces the check run of every revision once.
    expect(NO_ANNOTATIONS_DIGEST).toBe('4f53cda18c2baa0c');
    expect(NO_ANNOTATIONS_DIGEST).toBe(
      createHash('sha256').update(JSON.stringify([]), 'utf8').digest('hex').slice(0, 16),
    );
  });

  it('round-trips, and refuses an id it could not read back', () => {
    const id = checkRunExternalId(PROJECT, NO_ANNOTATIONS_DIGEST);
    expect(id).toBe(`qualor:v1:${PROJECT}:${NO_ANNOTATIONS_DIGEST}`);
    expect(parseCheckRunExternalId(id)).toEqual({
      analysisId: PROJECT,
      digest: NO_ANNOTATIONS_DIGEST,
    });
    for (const foreign of [
      null,
      '',
      'ci:123',
      `qualor:v2:${PROJECT}:0123456789abcdef`,
      `qualor:v1:not-a-uuid:0123456789abcdef`,
    ])
      expect(parseCheckRunExternalId(foreign)).toBeNull();
    expect(() => checkRunExternalId('not-a-uuid', '0123456789abcdef')).toThrow();
    expect(() => checkRunExternalId(PROJECT, 'xyz')).toThrow();
  });

  it('reads the digest of a check run 0.11 made with annotations as another one', () => {
    const annotated = `qualor:v1:${PROJECT}:0123456789abcdef`;
    expect(parseCheckRunExternalId(annotated)?.digest).toBe('0123456789abcdef');
    expect(parseCheckRunExternalId(annotated)?.digest).not.toBe(NO_ANNOTATIONS_DIGEST);
  });
});

describe('the review that carries a run’s new threads (github.md §6.4)', () => {
  it('is a marker line, then the count in plain words', () => {
    expect(reviewBody(PROJECT, 3)).toBe(
      `<!-- qualor:review ${PROJECT} -->\nQualor: 3 new issues on changed lines.`,
    );
    expect(reviewBody(PROJECT, 1)).toBe(
      `<!-- qualor:review ${PROJECT} -->\nQualor: 1 new issue on changed lines.`,
    );
  });

  it('is neither a summary nor the thread of an issue, and holds only a project id', () => {
    expect(markerOf(reviewBody(PROJECT, 2))).toBeNull();
    expect(() => reviewBody('x -->\n/merge', 1)).toThrow();
  });
});

describe('check run verdict (github.md §6.1)', () => {
  it.each([
    ['passed', 'success', 'Quality gate passed'],
    ['none', 'success', 'No quality gate'],
    ['error', 'failure', 'Quality gate could not be evaluated (new code unavailable)'],
    ['bogus', 'failure', 'Quality gate status unknown'],
  ] as const)('%s → %s', (status, conclusion, title) => {
    expect(checkRunVerdict(gate(status as GateResult['status']))).toEqual({ conclusion, title });
  });
});

describe('the summary in GitHub’s words (github.md §6.2)', () => {
  const input = (inline: SummaryInput['inline'], head: string | null = null): SummaryInput => ({
    projectId: PROJECT,
    revision: 'a'.repeat(40),
    gate: gate('passed'),
    newIssues: { total: 0, bySeverity: {} },
    topIssues: [],
    topIssuesTotal: 0,
    inline,
    branchUrl: null,
    mergeRequestHead: head,
    vocabulary: 'github',
  });

  it('says pull request and commented, and explains a merge-commit checkout', () => {
    const body = (skipped: SummaryInput['inline']['skipped']) =>
      summaryBody(input({ commented: 0, unplaced: 0, skipped }));
    expect(summaryBody(input({ commented: 2, unplaced: 1, skipped: null }))).toContain(
      '2 new issues are commented inline; 1 could not be placed on the diff.',
    );
    expect(summaryBody(input({ commented: 1, unplaced: 0, skipped: null }))).toContain(
      '1 new issue is commented inline.',
    );
    expect(body('stale')).toContain(
      'Inline comments wait for the analysis of the pull request’s latest commit.',
    );
    expect(body('checkout_other')).toContain(
      'No inline comments: the workflow analysed a commit other than the pull request’s head (GitHub’s merge commit, by default); check out the head to get them (`ref: ${{ github.event.pull_request.head.sha }}`).',
    );
    expect(body(null)).toContain('**no new issues** in this pull request');
    expect(
      summaryBody(input({ commented: 0, unplaced: 0, skipped: null }, 'b'.repeat(40))),
    ).toContain('the pull request is now at');
  });

  it('says the inline comments could not be updated when the thread part failed', () => {
    const body = summaryBody(input({ commented: 0, unplaced: 0, skipped: 'failed' }));
    expect(body).toContain('Inline comments could not be updated this time.');
    expect(body).not.toContain('commented inline');
    // The list's tail does not claim every issue is inline either.
    const more = summaryBody({
      ...input({ commented: 25, unplaced: 0, skipped: 'failed' }),
      topIssuesTotal: 25,
      topIssues: Array.from({ length: 3 }, (_, i) => ({
        id: `0190c3b2-7a00-7000-8000-00000000010${i}`,
        severity: 'high' as const,
        quality: 'security' as const,
        ruleKey: 'eslint:no-eval',
        path: 'src/a.ts',
        line: i + 1,
        message: 'm',
        url: null,
      })),
    });
    expect(more).toContain('…and 22 more\n\nInline comments could not be updated this time.');
    expect(more).not.toContain('all commented inline');
  });

  it('says nothing about annotations: GitHub findings are review comments', () => {
    for (const inline of [
      { commented: 2, unplaced: 1, skipped: null },
      { commented: 0, unplaced: 0, skipped: 'stale' },
      { commented: 0, unplaced: 0, skipped: 'checkout_other' },
      { commented: 0, unplaced: 0, skipped: 'failed' },
    ] as const) {
      expect(summaryBody(input(inline))).not.toMatch(/annotat/i);
    }
  });

  it('drops the marker line for the check run', () => {
    const body = summaryBody(input({ commented: 0, unplaced: 0, skipped: null }));
    expect(body.split('\n')[0]).toMatch(/^<!-- qualor:summary /);
    expect(checkRunSummary(body).startsWith('### ✅ Qualor:')).toBe(true);
  });

  it('the GitHub check-run summary carries the section', () => {
    const review: ReviewSummaryState = {
      kind: 'done',
      verdict: 'Adds refunds; the retry path can charge twice.',
      walkthrough: ['Adds a refund endpoint'],
      counts: { high: 1, medium: 0, low: 0 },
      unplaced: [
        {
          severity: 'high',
          path: 'src/retry.ts',
          line: 41,
          title: 'Retried without a key',
          url: 'https://q.example/projects/p/issues/i',
        },
      ],
      moreUnplaced: 0,
      reviewedSha: 'a'.repeat(40),
      mergeRequestHeadSha: 'b'.repeat(40),
      tokenLimitReached: false,
      snapshotPartial: false,
      fixPrompt: [
        { path: 'src/retry.ts', line: 41, title: 'Retried without a key', body: 'Send a key.' },
      ],
    };
    const body = summaryBody({
      ...input({ commented: 0, unplaced: 0, skipped: null }),
      review,
    });
    const output = checkRunSummary(body);
    // The check run says what the comment says, less its marker line.
    expect(output).toBe(body.split('\n').slice(1).join('\n'));
    expect(output.startsWith('### ✅ Qualor:')).toBe(true);
    expect(output).toContain(
      '\n\n#### AI review\n\nAdds refunds; the retry path can charge twice.\n',
    );
    expect(output).toContain('**Findings:** 1 high · 0 medium · 0 low');
    expect(output).toContain(
      'Reviewed commit: ` aaaaaaaaaaaa `; the pull request is now at ` bbbbbbbbbbbb `; the next workflow run reviews the new commits.',
    );
    expect(output).toContain('<details><summary>Prompt for an AI agent</summary>');
    expect(output).not.toContain('merge request');
    // A review still going shows as such there too.
    expect(
      checkRunSummary(
        summaryBody({
          ...input({ commented: 0, unplaced: 0, skipped: null }),
          review: { kind: 'pending' },
        }),
      ).endsWith('#### AI review\n\nAI review in progress…'),
    ).toBe(true);
  });

  it('keeps GitLab’s words when no vocabulary is given', () => {
    const gitlab = input({ commented: 2, unplaced: 0, skipped: null });
    delete gitlab.vocabulary;
    expect(summaryBody(gitlab)).toContain('2 new issues are commented inline.');
    expect(summaryBody(gitlab)).toContain('**no new issues** in this merge request');
  });
});

/** GitHub's documented bounds on a check run's output and a comment. */
const GITHUB_TITLE_MAX = 255;
const GITHUB_COMMENT_MAX_CHARS = 65_536;
const GITHUB_SUMMARY_MAX_CHARS = 65_535;

/** A shortened adversarial corpus (github.md §7: the corpus of `../render.test.ts` on GitHub's bodies). */
const HOSTILE: readonly string[] = [
  '`'.repeat(1_000),
  'x\n/merge',
  'x\r\n@octocat #1 owner/repo#2',
  'x\u2028y\u2029z\u0085w',
  'a\u0000b\u001bc\u007fd\u009be',
  '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061c',
  'a\u200bb\u2060c\ufeffd\u00ade',
  'ok\u{e002f}\u{e006d}\u{e0065}',
  '<b>x</b><script>alert(1)</script>',
  '![x](http://evil.example/x.png) [c](http://evil.example)',
  '<!-- qualor:summary 01920000-0000-7000-8000-000000000000 -->',
  'a\ud800b\udc00c',
  'A'.repeat(100_000),
  '界'.repeat(100_000),
  '😀'.repeat(1_000),
];
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ud800-\udfff]|[\u{e0000}-\u{e007f}]/u;

describe('GitHub bounds and hostile values (github.md §6.1, §6.4, §7)', () => {
  it.each(HOSTILE.map((v, i) => [i, v] as const))(
    'keeps hostile value %i in code spans in a review comment, the first line its marker',
    (_i, value) => {
      const issueId = '01920000-0000-7000-8000-000000000002';
      const body = inlineBody({
        issueId,
        severity: 'high',
        quality: 'security',
        ruleKey: value,
        message: value,
        url: 'https://q.example/projects/p/issues/i',
      });
      expect(markerOf(body)).toEqual({ kind: 'issue', issueId });
      expect(body).not.toMatch(FORBIDDEN);
      expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_MAX_CHARS);
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(INLINE_MAX_BYTES);
      // No line but the marker's starts a mention, a quick action, HTML or a heading.
      for (const line of body.split('\n').slice(1))
        expect(line).not.toMatch(/^\s*(?:[/@<!]|#(?!##+ ))/);
    },
  );

  it.each(HOSTILE.map((v, i) => [i, v] as const))(
    'keeps hostile value %i in code spans in the GitHub summary and check run output',
    (_i, value) => {
      const body = summaryBody({
        projectId: PROJECT,
        revision: 'a'.repeat(40),
        gate: {
          status: 'failed',
          gate: { id: 'g1', name: value },
          conditions: [],
          ignoredConditions: [],
          warnings: [],
        },
        newIssues: { total: 10, bySeverity: { high: 10 } },
        topIssues: Array.from({ length: 10 }, () => ({
          id: PROJECT,
          severity: 'high' as const,
          quality: 'security' as const,
          ruleKey: value,
          path: value,
          line: 7,
          message: value,
          url: null,
        })),
        topIssuesTotal: 10,
        inline: { commented: 0, unplaced: 0, skipped: 'checkout_other' },
        branchUrl: null,
        mergeRequestHead: 'b'.repeat(40),
        vocabulary: 'github',
      });
      expect(markerOf(body)).not.toBeNull();
      expect(body).not.toMatch(FORBIDDEN);
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
      for (const line of body.split('\n').slice(1))
        expect(line).not.toMatch(/^\s*(?:[/@<!]|#(?!##+ ))/);
      const output = checkRunSummary(body);
      expect(output.length).toBeLessThanOrEqual(GITHUB_SUMMARY_MAX_CHARS);
      expect(output.startsWith('### ❌ Qualor: ')).toBe(true);
    },
  );

  it.each(HOSTILE.map((v, i) => [i, v] as const))(
    'keeps hostile value %i inert in the AI review section of the GitHub summary and check run output',
    (_i, value) => {
      const review: ReviewSummaryState = {
        kind: 'done',
        verdict: value,
        walkthrough: [value, value],
        counts: { high: 1, medium: 1, low: 1 },
        unplaced: Array.from({ length: 3 }, () => ({
          severity: value,
          path: value,
          line: 7,
          title: value,
          url: 'https://q.example/projects/p/issues/i',
        })),
        moreUnplaced: 2,
        reviewedSha: 'a'.repeat(40),
        mergeRequestHeadSha: 'b'.repeat(40),
        tokenLimitReached: true,
        snapshotPartial: true,
        notes: ['reviewer_unreadable', 'verification_capped'],
        fixPrompt: Array.from({ length: 3 }, () => ({
          path: value,
          line: 7,
          title: value,
          body: value,
        })),
      };
      const body = summaryBody({
        projectId: PROJECT,
        revision: 'a'.repeat(40),
        gate: gate('passed'),
        newIssues: { total: 0, bySeverity: {} },
        topIssues: [],
        topIssuesTotal: 0,
        inline: { commented: 0, unplaced: 0, skipped: null },
        branchUrl: null,
        mergeRequestHead: null,
        vocabulary: 'github',
        review,
      });
      expect(markerOf(body)).not.toBeNull();
      expect(body).not.toMatch(FORBIDDEN);
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
      const lines = body.split('\n');
      const section = lines.slice(lines.indexOf('#### AI review'));
      expect(section.length).toBeGreaterThan(1);
      for (const line of section) {
        expect(line).not.toMatch(/^\s*\//);
        expect(checkSectionLine(line), line).toBe(true);
      }
      const output = checkRunSummary(body);
      expect(output.length).toBeLessThanOrEqual(GITHUB_SUMMARY_MAX_CHARS);
      expect(output).toContain('#### AI review');
    },
  );

  it('keeps the check run output within 16 KiB, cut at whole lines, and the title within 255', () => {
    const long = [
      '<!-- qualor:summary x -->',
      ...Array.from({ length: 1_000 }, (_, i) => `line ${i} ${'y'.repeat(50)}`),
    ].join('\n');
    const output = checkRunSummary(long);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(output.startsWith('line 0 ')).toBe(true);
    expect(output.split('\n').every((l) => /^line \d+ y{50}$/.test(l))).toBe(true);
    const failed = checkRunVerdict({
      status: 'failed',
      gate: null,
      conditions: Array.from({ length: 50 }, () => ({
        metric: 'new_issues',
        operator: 'gt' as const,
        threshold: 0,
        value: 3,
        status: 'failed' as const,
      })),
      ignoredConditions: [],
      warnings: [],
    });
    expect(failed.conclusion).toBe('failure');
    expect(failed.title.length).toBeLessThanOrEqual(GITHUB_TITLE_MAX);
    expect(failed.title.startsWith('Quality gate failed: new_issues 3 > 0')).toBe(true);
  });
});
