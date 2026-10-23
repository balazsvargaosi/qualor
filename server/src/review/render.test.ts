import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { checkSectionLine, FORBIDDEN_ANYWHERE, outsideCodeSpans } from '../../test/markdown-check';
import { markerOf } from '../scm/markdown';
import {
  AI_SECTION_MAX_BYTES,
  aiSummarySection,
  withMergeRequestHead,
  type ReviewSummaryState,
} from './render';

type Done = Extract<ReviewSummaryState, { kind: 'done' }>;

const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

const done = (over: Partial<Done> = {}): Done => ({
  kind: 'done',
  verdict: 'The change adds refunds; one path can fail silently.',
  walkthrough: ['Adds a refund endpoint', 'Validates the amount'],
  counts: { high: 1, medium: 2, low: 0 },
  unplaced: [],
  moreUnplaced: 0,
  reviewedSha: SHA,
  mergeRequestHeadSha: null,
  tokenLimitReached: false,
  snapshotPartial: false,
  fixPrompt: [],
  ...over,
});
const section = (
  state: ReviewSummaryState,
  provider: 'gitlab' | 'github' = 'gitlab',
  maxBytes: number = AI_SECTION_MAX_BYTES,
): string[] => aiSummarySection(state, provider, maxBytes);
const bytesOf = (lines: readonly string[]): number => Buffer.byteLength(lines.join('\n'), 'utf8');

const finding = (n: number, over: Partial<Done['unplaced'][number]> = {}) => ({
  severity: 'medium',
  path: `src/file${n}.ts`,
  line: n,
  title: `Finding number ${n}`,
  url: `https://q.example/projects/p/issues/i${n}`,
  ...over,
});
const promptFinding = (n: number, over: Partial<Done['fixPrompt'][number]> = {}) => ({
  path: `src/file${n}.ts`,
  line: n,
  title: `Finding number ${n}`,
  body: `The call in file ${n} can fail when the input is empty, so check it first.`,
  ...over,
});

describe('the AI review section', () => {
  it('each section state renders its fixed text', () => {
    // In progress.
    expect(section({ kind: 'pending' })).toEqual(['#### AI review', '', 'AI review in progress…']);

    // Skipped: a sentence for each reason; a missing snapshot points to the job log and fetch-depth.
    const skipped = {
      no_snapshot:
        'AI review did not run: no repository snapshot came for this commit. See the CI job’s log and the guide’s `fetch-depth` note.',
      snapshot_rejected:
        'AI review did not run: the server refused the repository snapshot of this commit.',
      draft:
        'AI review is skipped while this merge request is a draft; the next pipeline after it is ready reviews it.',
      closed: 'AI review did not run because this merge request is merged or closed.',
      inactive: 'AI review is switched off for this project.',
      empty_diff: 'AI review found nothing to review in the changed files.',
      unchanged:
        'AI review did not repeat: the changes it reviews are the same as in its last review, whose findings stay open.',
      budget_spent: 'AI review did not run because its token budget for today is spent.',
    } as const;
    for (const [reason, sentence] of Object.entries(skipped)) {
      expect(
        section({ kind: 'skipped', reason: reason as keyof typeof skipped, detail: null }),
      ).toEqual(['#### AI review', '', sentence]);
    }

    // Failed: a sentence for each reason, then that the next push reviews again.
    const failed = {
      provider_error:
        'AI review failed: the model provider returned an error or could not be reached.',
      provider_no_tools:
        'AI review failed: the model provider does not support the tool calls the review needs.',
      bad_answer: 'AI review failed: the model’s answers could not be read.',
      internal: 'AI review failed because of an error in Qualor.',
    } as const;
    for (const [reason, sentence] of Object.entries(failed)) {
      expect(section({ kind: 'failed', reason: reason as keyof typeof failed })).toEqual([
        '#### AI review',
        '',
        `${sentence} The next push reviews again.`,
      ]);
    }

    // Done: the verdict, the counts, the walkthrough and the commit.
    expect(section(done())).toEqual([
      '#### AI review',
      '',
      'The change adds refunds; one path can fail silently.',
      '',
      '**Findings:** 1 high · 2 medium · 0 low',
      '',
      '- Adds a refund endpoint',
      '- Validates the amount',
      '',
      'Reviewed commit: ` aaaaaaaaaaaa `',
    ]);
  });

  it('says it in GitHub’s words for GitHub', () => {
    const skipped = (reason: 'draft' | 'closed') =>
      section({ kind: 'skipped', reason, detail: null }, 'github')[2];
    expect(skipped('draft')).toBe(
      'AI review is skipped while this pull request is a draft; the next workflow run after it is ready reviews it.',
    );
    expect(skipped('closed')).toBe(
      'AI review did not run because this pull request is merged or closed.',
    );
  });

  it('names the code a skip or a refusal carries, in a code span, and nothing else', () => {
    expect(
      section({ kind: 'skipped', reason: 'snapshot_rejected', detail: 'SNAPSHOT_INVALID' })[2],
    ).toBe(
      'AI review did not run: the server refused the repository snapshot of this commit. Reason: ` SNAPSHOT_INVALID `.',
    );
    expect(section({ kind: 'skipped', reason: 'inactive', detail: 'consent_outdated' })[2]).toBe(
      'AI review is switched off for this project. Reason: ` consent_outdated `.',
    );
    // A detail that is not a code of Qualor's own is left out: it is never content.
    for (const detail of [
      '',
      'a b',
      '<b>x</b>',
      '@all',
      '/close',
      'x'.repeat(65),
      'SNAPSHOT_INVALID\n/merge',
    ]) {
      expect(section({ kind: 'skipped', reason: 'snapshot_rejected', detail })[2], detail).toBe(
        'AI review did not run: the server refused the repository snapshot of this commit.',
      );
    }
  });

  it('falls back to a plain sentence for a reason it does not know, and shows nothing for a state it does not know', () => {
    expect(section({ kind: 'skipped', reason: 'weird' as never, detail: null })[2]).toBe(
      'AI review did not run.',
    );
    expect(section({ kind: 'failed', reason: 'weird' as never })[2]).toBe(
      'AI review failed. The next push reviews again.',
    );
    expect(section({ kind: 'bogus' } as never)).toEqual([]);
  });

  it('says there are no findings, and leaves out what there is none of', () => {
    const lines = section(
      done({ counts: { high: 0, medium: 0, low: 0 }, verdict: '', walkthrough: [] }),
    );
    expect(lines).toEqual([
      '#### AI review',
      '',
      'No findings.',
      '',
      'Reviewed commit: ` aaaaaaaaaaaa `',
    ]);
    // A walkthrough item that is nothing once cleaned is not listed.
    expect(section(done({ walkthrough: ['\u200b', '  ', 'Real item'] }))).toContain('- Real item');
    expect(section(done({ walkthrough: ['\u200b', '  '] })).join('\n')).not.toContain('- ');
  });

  it('lists the findings that are not on changed lines, with a link, and says how many more there are', () => {
    const lines = section(
      done({
        unplaced: [
          finding(1, { severity: 'high' }),
          finding(2, { severity: 'low', url: null }),
          finding(3, { severity: 'blocker', title: '' }),
        ],
        moreUnplaced: 4,
      }),
    );
    expect(lines.slice(9)).toEqual([
      '**Not on changed lines:**',
      '',
      '- **High** · ` src/file1.ts:1 ` · Finding number 1 · [View in Qualor](https://q.example/projects/p/issues/i1)',
      '- **Low** · ` src/file2.ts:2 ` · Finding number 2',
      '- **Unknown** · ` src/file3.ts:3 ` · [View in Qualor](https://q.example/projects/p/issues/i3)',
      '',
      '…and 4 more in Qualor',
      '',
      'Reviewed commit: ` aaaaaaaaaaaa `',
    ]);
  });

  it('lists ten of the findings that are not on changed lines at most, and counts the rest as more', () => {
    const lines = section(
      done({ unplaced: Array.from({ length: 13 }, (_, i) => finding(i + 1)), moreUnplaced: 2 }),
    );
    expect(lines.filter((line) => line.startsWith('- **Medium**'))).toHaveLength(10);
    expect(lines).toContain('…and 5 more in Qualor');
  });

  it('reads a severity that is not one of the three as unknown, whatever its name', () => {
    for (const severity of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'info', '']) {
      const lines = section(done({ unplaced: [finding(1, { severity })] }));
      expect(lines.join('\n'), severity).toContain('- **Unknown** · ` src/file1.ts:1 ` · ');
    }
  });

  it('adds the notes, each a sentence of its own, after the findings', () => {
    const lines = section(
      done({
        tokenLimitReached: true,
        snapshotPartial: true,
        notes: ['reviewer_unreadable', 'token_limit_reached', 'verification_capped'],
      }),
    );
    expect(lines.slice(9)).toEqual([
      'The review reached its token limit, so it may have missed problems. The scanner left some files out of the repository snapshot to stay within its limits, so the review did not see all of them. A reviewer’s answer could not be read, so part of the review is missing. There were more serious security findings than the review verifies, so the rest were not checked a second time.',
      '',
      'Reviewed commit: ` aaaaaaaaaaaa `',
    ]);
    // The token limit is said once, whether the run or its summary tells it.
    for (const over of [{ tokenLimitReached: true }, { notes: ['token_limit_reached' as const] }]) {
      const text = section(done(over)).join('\n');
      expect(text.match(/reached its token limit/g)).toHaveLength(1);
    }
    expect(section(done()).join('\n')).not.toContain('token limit');
  });

  it('says when the merge request has moved on, and what the next pipeline does', () => {
    const moved = (provider: 'gitlab' | 'github', head: string | null) =>
      section(done({ mergeRequestHeadSha: head }), provider).at(-1);
    expect(moved('gitlab', NEWER)).toBe(
      'Reviewed commit: ` aaaaaaaaaaaa `; the merge request is now at ` bbbbbbbbbbbb `; the next pipeline reviews the new commits.',
    );
    expect(moved('github', NEWER)).toBe(
      'Reviewed commit: ` aaaaaaaaaaaa `; the pull request is now at ` bbbbbbbbbbbb `; the next workflow run reviews the new commits.',
    );
    // Not when it is the commit that was reviewed (in either case), or when it is not known.
    expect(moved('gitlab', SHA)).toBe('Reviewed commit: ` aaaaaaaaaaaa `');
    expect(moved('gitlab', SHA.toUpperCase())).toBe('Reviewed commit: ` aaaaaaaaaaaa `');
    expect(moved('gitlab', null)).toBe('Reviewed commit: ` aaaaaaaaaaaa `');
    // No commit to name, none named.
    expect(section(done({ reviewedSha: '' })).join('\n')).not.toContain('Reviewed commit');
  });

  it('puts the live head on a finished review only', () => {
    const state = done();
    expect(withMergeRequestHead(state, NEWER)).toEqual({ ...state, mergeRequestHeadSha: NEWER });
    expect(withMergeRequestHead(state, null)).toEqual(state);
    expect(state.mergeRequestHeadSha).toBeNull();
    for (const other of [{ kind: 'pending' }, { kind: 'failed', reason: 'internal' }] as const) {
      expect(withMergeRequestHead(other, NEWER)).toBe(other);
    }
    expect(withMergeRequestHead(null, NEWER)).toBeNull();
  });
});

describe('the prompt for an AI agent', () => {
  const prompt = (state: Done, maxBytes?: number): string[] => {
    const lines = section(state, 'gitlab', maxBytes);
    const from = lines.indexOf('<details><summary>Prompt for an AI agent</summary>');
    return from < 0 ? [] : lines.slice(from);
  };

  it('lists the open findings in a fenced text block inside a details block, last', () => {
    const lines = section(
      done({
        counts: { high: 1, medium: 1, low: 0 },
        fixPrompt: [promptFinding(1), promptFinding(2, { title: 'Second `thing`' })],
      }),
    );
    expect(lines.slice(-14)).toEqual([
      '<details><summary>Prompt for an AI agent</summary>',
      '',
      '```text',
      'Fix the problems below, which an AI review found in this merge request.',
      'The review can be wrong: read the code first and skip a finding that does not hold.',
      'Keep each change small and run the tests afterwards.',
      '',
      '1. ` src/file1.ts:1 ` Finding number 1',
      '   The call in file 1 can fail when the input is empty, so check it first.',
      '2. ` src/file2.ts:2 ` Second ` thing `',
      '   The call in file 2 can fail when the input is empty, so check it first.',
      '```',
      '',
      '</details>',
    ]);
    // It follows the commit line after a blank line.
    expect(lines.at(-15)).toBe('');
    expect(lines.at(-16)).toBe('Reviewed commit: ` aaaaaaaaaaaa `');
    // The block is opened and closed, and the fence is a block of its own.
    expect(lines.filter((line) => line === '```text')).toHaveLength(1);
    expect(lines.filter((line) => line === '```')).toHaveLength(1);
  });

  it('says it in GitHub’s words for GitHub', () => {
    const lines = section(done({ fixPrompt: [promptFinding(1)] }), 'github');
    expect(lines).toContain(
      'Fix the problems below, which an AI review found in this pull request.',
    );
  });

  it('uses a fence longer than any run of backticks inside it', () => {
    const lines = prompt(
      done({
        fixPrompt: [
          promptFinding(1, { body: `Use \`${'`'.repeat(5)}\` and ${'`'.repeat(7)} here` }),
          promptFinding(2, { path: `src/${'`'.repeat(40)}.ts`, title: '```' }),
        ],
      }),
    );
    const content = lines.slice(3, lines.lastIndexOf('</details>') - 2);
    const longest = Math.max(
      ...content.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = lines[2]!;
    expect(fence).toMatch(/^`+text$/);
    expect(fence.length - 'text'.length).toBeGreaterThan(longest);
    expect(lines.at(-3)).toBe('`'.repeat(fence.length - 'text'.length));
  });

  it('says how many open findings it leaves out, when it lists fewer than there are', () => {
    const lines = prompt(
      done({
        counts: { high: 2, medium: 2, low: 1 },
        fixPrompt: [promptFinding(1), promptFinding(2)],
      }),
    );
    expect(lines).toContain('And 3 more open findings are in Qualor.');
    const one = prompt(
      done({ counts: { high: 1, medium: 1, low: 0 }, fixPrompt: [promptFinding(1)] }),
    );
    expect(one).toContain('And 1 more open finding is in Qualor.');
    expect(
      prompt(
        done({
          counts: { high: 1, medium: 1, low: 0 },
          fixPrompt: [promptFinding(1), promptFinding(2)],
        }),
      ).join('\n'),
    ).not.toContain('more open');
  });

  it('has no block at all without a finding to list', () => {
    expect(section(done()).join('\n')).not.toContain('<details>');
  });

  it('is cut down to the findings that fit, and left out when none does', () => {
    const state = done({
      counts: { high: 4, medium: 8, low: 0 },
      fixPrompt: Array.from({ length: 12 }, (_, i) =>
        promptFinding(i + 1, { body: 'word '.repeat(150) }),
      ),
    });
    const whole = section(state);
    expect(bytesOf(whole)).toBeLessThanOrEqual(AI_SECTION_MAX_BYTES);
    const listed = whole.filter((line) => /^\d+\. ` src\//.test(line)).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(12);
    // The ones it lists are the first, and it says how many it leaves out.
    for (let n = 1; n <= listed; n += 1)
      expect(whole.join('\n')).toContain(`${n}. \` src/file${n}.ts:${n} \``);
    expect(whole).toContain(`And ${12 - listed} more open findings are in Qualor.`);
    // With less room than the first finding takes, the whole block goes and the rest stays.
    const withoutPrompt = section({ ...state, fixPrompt: [] });
    expect(section(state, 'gitlab', bytesOf(withoutPrompt) + 200)).toEqual(withoutPrompt);
    expect(withoutPrompt.join('\n')).not.toContain('<details>');
  });
});

describe('what the section drops when space runs out', () => {
  const full = done({
    verdict:
      'The verdict of this review is a long sentence about many things the change does and breaks.',
    walkthrough: Array.from(
      { length: 6 },
      (_, i) => `Walkthrough item number ${i + 1} describes a part of the change`,
    ),
    unplaced: Array.from({ length: 10 }, (_, i) => finding(i + 1)),
    moreUnplaced: 3,
    fixPrompt: Array.from({ length: 3 }, (_, i) => promptFinding(i + 1)),
    snapshotPartial: true,
    mergeRequestHeadSha: NEWER,
  });

  /** What of the section there is at `maxBytes`. */
  const parts = (maxBytes: number) => {
    const lines = section(full, 'gitlab', maxBytes);
    const text = lines.join('\n');
    return {
      lines,
      prompt: text.includes('<details>'),
      walkthrough: text.includes('- Walkthrough item number 6'),
      anyWalkthrough: text.includes('- Walkthrough item'),
      unplaced: lines.filter((line) => line.startsWith('- **Medium**')).length,
      verdict: text.includes(
        'The verdict of this review is a long sentence about many things the change does and breaks.',
      ),
      anyVerdict: text.includes('The verdict'),
      commit: text.includes('Reviewed commit'),
    };
  };

  it('drops the prompt, then the walkthrough, then the tail of the list, then cuts the verdict', () => {
    const fullBytes = bytesOf(section(full));
    expect(fullBytes).toBeLessThanOrEqual(AI_SECTION_MAX_BYTES);
    let previous = parts(fullBytes);
    expect(previous).toMatchObject({
      prompt: true,
      walkthrough: true,
      unplaced: 10,
      verdict: true,
      commit: true,
    });
    const seen = new Set<string>();
    for (let maxBytes = fullBytes; maxBytes >= 0; maxBytes -= 7) {
      const now = parts(maxBytes);
      expect(bytesOf(now.lines), `${maxBytes}`).toBeLessThanOrEqual(maxBytes);
      if (now.lines.length === 0) break;
      // Each part is there only while every part dropped before it is.
      if (now.prompt) expect(now.walkthrough, `${maxBytes}`).toBe(true);
      if (now.walkthrough) expect(now.unplaced, `${maxBytes}`).toBe(10);
      if (now.anyWalkthrough) expect(now.unplaced, `${maxBytes}`).toBe(10);
      if (now.unplaced === 10 || now.unplaced > 0)
        expect(now.verdict || now.anyVerdict, `${maxBytes}`).toBe(true);
      if (now.unplaced > 0 && now.unplaced < 10)
        expect(now.anyWalkthrough, `${maxBytes}`).toBe(false);
      // The list only gets shorter, and what is left of it is its head.
      expect(now.unplaced, `${maxBytes}`).toBeLessThanOrEqual(previous.unplaced);
      expect(now.commit, `${maxBytes}`).toBe(true);
      seen.add(`${now.prompt}|${now.anyWalkthrough}|${now.unplaced === 10}|${now.verdict}`);
      previous = now;
    }
    // Every step of the order was passed through.
    expect([...seen]).toEqual(
      expect.arrayContaining([
        'true|true|true|true',
        'false|true|true|true',
        'false|false|true|true',
        'false|false|false|true',
        'false|false|false|false',
      ]),
    );
  });

  it('counts the findings it no longer lists among the ones in Qualor', () => {
    const fullBytes = bytesOf(section(full));
    for (let maxBytes = fullBytes; maxBytes >= 0; maxBytes -= 25) {
      const lines = section(full, 'gitlab', maxBytes);
      if (lines.length === 0) break;
      const listed = lines.filter((line) => line.startsWith('- **Medium**')).length;
      const more = Number(
        /^…and (\d+) more in Qualor$/.exec(
          lines.find((line) => line.startsWith('…and')) ?? '',
        )?.[1] ?? 0,
      );
      expect(listed + more, `${maxBytes}`).toBe(13);
    }
  });

  it('shows nothing, rather than a cut section, when even the least of it does not fit', () => {
    expect(section(full, 'gitlab', 20)).toEqual([]);
    expect(section({ kind: 'pending' }, 'gitlab', 10)).toEqual([]);
    expect(section(full, 'gitlab', -1)).toEqual([]);
  });

  it('stays within the bound it is given, whatever the section is made of', () => {
    const hostile = done({
      verdict: '界'.repeat(500),
      walkthrough: Array.from({ length: 6 }, () => '😀'.repeat(300)),
      unplaced: Array.from({ length: 10 }, (_, i) =>
        finding(i, { path: `src/${'界'.repeat(300)}`, title: '界'.repeat(300) }),
      ),
      moreUnplaced: 200,
      fixPrompt: Array.from({ length: 20 }, (_, i) =>
        promptFinding(i, { body: '界'.repeat(3_000), title: '界'.repeat(300) }),
      ),
      notes: ['reviewer_unreadable', 'token_limit_reached', 'verification_capped'],
      snapshotPartial: true,
      mergeRequestHeadSha: NEWER,
    });
    for (const maxBytes of [AI_SECTION_MAX_BYTES, 4_096, 3_000, 2_000, 1_500, 1_000, 700]) {
      const lines = section(hostile, 'github', maxBytes);
      expect(bytesOf(lines), `${maxBytes}`).toBeLessThanOrEqual(maxBytes);
    }
    expect(section(hostile).length).toBeGreaterThan(0);
  });
});

describe('model text in the section is inert', () => {
  const HOSTILE: readonly (readonly [string, string])[] = [
    ['a link', '[x](https://e.example)'],
    ['a mention', '@all and @group/sub'],
    ['references', '#12 !12 ~label %milestone &epic $snippet'],
    ['HTML', '<img src=x onerror=y> <details></details> <script>alert(1)</script>'],
    ['a quick action', '/close\n/merge'],
    ['a heading and a quote', '# heading\n> quote\n| a | b |'],
    ['fences', '```\n~~~\n````'],
    ['a forged marker', '<!-- qualor:summary 01920000-0000-7000-8000-000000000000 -->'],
    ['invisible and bidirectional characters', 'a\u200bb\u202ec\u2028d\u0000e\ufeff'],
    ['backtick runs', '`'.repeat(300)],
    ['an end of the block', '</details>\n```\n</details>'],
    ['a hash and a key', 'deadbeef0123 GH-26 JIRA-12'],
    ['long words', 'w'.repeat(3_000)],
  ];

  it.each(HOSTILE)('keeps %s inert in every slot', (_name, value) => {
    const lines = section(
      done({
        verdict: value,
        walkthrough: [value, `- ${value}`],
        unplaced: [finding(1, { title: value, path: value, severity: value })],
        fixPrompt: [promptFinding(1, { title: value, body: value, path: value })],
        notes: [],
        reviewedSha: value,
        mergeRequestHeadSha: value,
      }),
    );
    const body = lines.join('\n');
    expect(body).not.toMatch(FORBIDDEN_ANYWHERE);
    expect(markerOf(body)).toBeNull();
    expect(bytesOf(lines)).toBeLessThanOrEqual(AI_SECTION_MAX_BYTES);
    for (const line of lines) {
      expect(line, line).not.toMatch(/^\s*\//);
      expect(checkSectionLine(line), line).toBe(true);
    }
    // Nothing is a link but Qualor's own, and the details block is the one block there is.
    const html = marked.parse(body, { async: false, gfm: true, breaks: false });
    for (const [, href] of html.matchAll(/<a [^>]*href="([^"]*)"/g)) {
      expect(href).toMatch(/^https:\/\/q\.example\//);
    }
    expect(html).not.toMatch(/<(?:img|script|style|iframe|input|blockquote|table)\b/);
    // The one heading is the section's own.
    expect(html.match(/<h[1-6]\b/g) ?? []).toHaveLength(1);
    expect(html.match(/<details>/g) ?? []).toHaveLength(1);
    expect(html.match(/<\/details>/g) ?? []).toHaveLength(1);
  });

  it('holds only fixed text and Qualor’s links outside what the model wrote', () => {
    for (const provider of ['gitlab', 'github'] as const) {
      const lines = section(
        done({
          unplaced: [finding(1)],
          moreUnplaced: 1,
          fixPrompt: [promptFinding(1)],
          tokenLimitReached: true,
          snapshotPartial: true,
          notes: ['reviewer_unreadable', 'verification_capped'],
          mergeRequestHeadSha: NEWER,
        }),
        provider,
      );
      for (const line of lines) {
        expect(checkSectionLine(line), line).toBe(true);
      }
    }
    for (const state of [
      { kind: 'pending' },
      { kind: 'skipped', reason: 'no_snapshot', detail: null },
      { kind: 'skipped', reason: 'snapshot_rejected', detail: 'SNAPSHOT_INVALID' },
      { kind: 'failed', reason: 'bad_answer' },
    ] as const) {
      for (const line of section(state)) {
        expect(checkSectionLine(line), line).toBe(true);
      }
    }
    // The check has teeth: a link, a mention or a heading outside a code span is refused.
    for (const bad of [
      '[x](https://e.example)',
      '@all',
      '# heading',
      'see https://e.example',
      'a * b',
    ]) {
      expect(checkSectionLine(bad), bad).toBe(false);
    }
    expect(outsideCodeSpans('` @all `')).not.toContain('@');
  });

  it('accepts a fixed text that holds markup only as a whole line or where it belongs', () => {
    const base = 'https://q.example/projects/p/issues/i';
    // The lines the section writes, each in its place.
    for (const good of [
      '#### AI review',
      'AI review in progress…',
      '**Not on changed lines:**',
      '<details><summary>Prompt for an AI agent</summary>',
      '</details>',
      '```text',
      '`````text',
      '```',
      '**Findings:** 1 high · 2 medium · 0 low',
      '…and 3 more in Qualor',
      '- **High** · ` src/a.ts:1 `',
      '- **Medium** · ` src/a.ts:1 ` · Some title words',
      `- **Low** · \` src/a.ts:1 \` · [View in Qualor](${base})`,
      `- **Unknown** · \` a \` · A title · [View in Qualor](${base}1)`,
      '- **High** · ` a · b ` · A title with ` code · spans `',
    ]) {
      expect(checkSectionLine(good), good).toBe(true);
    }
    // The same texts anywhere else in a line are model text out of its code spans. (The ellipsis
    // and the dashes are ordinary text now, so a line with one is no markup.)
    for (const bad of [
      'see </details> here',
      '</details> x',
      'x </details>',
      'text <details><summary>Prompt for an AI agent</summary>',
      '<details><summary>Prompt for an AI agent</summary> x',
      'foo #### AI review',
      '#### AI review x',
      '#### AI review #### AI review',
      'a **Not on changed lines:** b',
      'x **Findings:** 1 high · 2 medium · 0 low',
      '**Findings:** 1 high · 2 medium · 0 low x',
      '**Findings:** 1 high · 2 medium',
      'a **High** b',
      'x - **High** · ` a `',
      '- x **High** · ` a `',
      '- **High** x ` a `',
      '- **High** · a · b',
      '- **High** · ` a ` · one · two',
      '- **High** · ` a ` · title · **High** · ` b `',
      '- **High** · ` a ` extra',
      '- **Critical** · ` a `',
      '1. **High** · ` a `',
    ]) {
      expect(checkSectionLine(bad), bad).toBe(false);
    }
    // A link is Qualor's: the test's base, over https, and nothing but a path after it.
    for (const bad of [
      '- **High** · ` a ` · [View in Qualor](https://evil.example/x)',
      '- **High** · ` a ` · [View in Qualor](http://q.example/x)',
      '- **High** · ` a ` · [View in Qualor](https://q.example.evil.example/x)',
      '- **High** · ` a ` · [View in Qualor](https://q.example/x?y=1)',
      '- **High** · ` a ` · [View in Qualor](https://q.example/x) more',
      '- **High** · ` a ` · [Click](https://q.example/x)',
      '- **High** · ` a ` · [View in Qualor](https://q.example/x) · [View in Qualor](https://q.example/y)',
      '[View in Qualor](https://q.example/x)',
    ]) {
      expect(checkSectionLine(bad), bad).toBe(false);
    }
  });

  it('shows the verdict, the notes and the commit of an older analysis, and none of the branch’s findings', () => {
    // The findings of the branch are the current ones: an analysis that is no longer the newest
    // is not given them, whatever the state holds.
    const lines = section(
      done({
        latest: false,
        counts: { high: 2, medium: 1, low: 0 },
        unplaced: [finding(1)],
        moreUnplaced: 3,
        fixPrompt: [promptFinding(1)],
        tokenLimitReached: true,
        notes: ['reviewer_unreadable'],
        mergeRequestHeadSha: NEWER,
      }),
    );
    expect(lines).toEqual([
      '#### AI review',
      '',
      'The change adds refunds; one path can fail silently.',
      '',
      'The review reached its token limit, so it may have missed problems. A reviewer’s answer could not be read, so part of the review is missing.',
      '',
      'Reviewed commit: ` aaaaaaaaaaaa `',
    ]);
    const text = lines.join('\n');
    for (const gone of [
      'Findings',
      'No findings',
      'Not on changed lines',
      '<details>',
      '- ',
      'now at',
    ]) {
      expect(text, gone).not.toContain(gone);
    }
    // Nothing else of it changes: the newest analysis shows it all, whether `latest` is true or left out.
    expect(section(done({ latest: true }))).toEqual(section(done()));
    expect(section(done()).join('\n')).toContain('**Findings:**');
    // A review that is not done has no findings to leave out.
    expect(section({ kind: 'pending' })).toEqual(['#### AI review', '', 'AI review in progress…']);
  });
});
