import { REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { ReviewPhase } from '../db/schema';
import {
  CONTEXT_MAXIMA,
  SENSITIVE_PATH,
  type ContextShape,
  type ReviewableChange,
  type ReviewContext,
} from './context';
import type { ConversationResult } from './conversation';
import { envelope, newNonce } from './envelope';
import {
  CHARS_PER_TOKEN,
  planReview,
  REVIEW_OUTPUT_TOKENS,
  reviewFits,
  reviewLimits,
  runReviewPipeline,
  STAGE_SHARES,
  type PipelineDeps,
  type PipelineOutcome,
  type ReviewRole,
} from './pipeline';
import { specialistData, SYSTEM_PROMPTS } from './prompts';

/** The fake provider key of a test is built at run time, so no scanner takes it for a real one. */
const j = (...parts: string[]) => parts.join('');

function change(path: string, changedLines = 1): ReviewableChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    since: null,
    hasPatch: true,
    patchUsable: true,
    lines: 40,
    text: null,
    added: new Set([3]),
    removalPoints: [],
    changedLines,
    sensitive: SENSITIVE_PATH.test(path),
    removed: [],
    unshown: null,
  };
}

const META: ReviewContext['meta'] = {
  snapshotId: null,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  sinceSha: null,
  targetBranch: 'main',
  mrTitle: 'Add a cart total',
  mrDescription: null,
  instructions: [],
  partial: false,
};

function contextOf(reviewed: ReviewableChange[], over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    meta: META,
    reviewed,
    skipped: [],
    slices:
      '@@ src/cart.ts lines 1–3 of 40 @@\n 1 const a = 1;\n 2 const b = 2;\n 3+const total = a + b;',
    omittedFromSlices: [],
    analyzer: [],
    prior: [],
    redactions: 0,
    ...over,
  };
}

/** One conversation the pipeline asked for, with the data its first message carried. */
interface Call {
  role: ReviewRole;
  user: string;
  nonce: string;
  tokenBudget: number;
  data: Record<string, unknown>;
  /** The check of an answer the pipeline gave the conversation. */
  accept: (text: string) => boolean;
  /** What the check said of each answer a scripted model gave (see `texts`). */
  accepted: boolean[];
}
/**
 * A model that answers these texts in turn, each for `tokens`: the conversation asks again once
 * when the check refuses an answer and ends as a bad answer at the second refusal, as
 * runConversation does.
 */
interface Texts {
  texts: string[];
  tokens: [number, number];
}
type Reply = ConversationResult | Texts | ((call: Call) => ConversationResult);
const texts = (...answers: string[]): Texts => ({ texts: answers, tokens: [100, 10] });

/** The data of a first message: the envelope's line between its markers, and nothing after them. */
function opened(user: string, nonce: string): Record<string, unknown> {
  const lines = user.split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain(nonce);
  expect(lines[1]).toBe(`<<<QUALOR-DATA-${nonce}`);
  expect(lines[3]).toBe(`QUALOR-DATA-${nonce}>>>`);
  return JSON.parse(lines[2] ?? '') as Record<string, unknown>;
}

const spent = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  turns: 1,
  toolCalls: 0,
});

function asked({ texts: answers, tokens: [input, output] }: Texts, call: Call): ConversationResult {
  for (const [index, text] of answers.slice(0, 2).entries()) {
    const ok = call.accept(text);
    call.accepted.push(ok);
    if (ok) {
      return {
        kind: 'answer',
        text,
        budgetReached: false,
        ...spent(input * (index + 1), output * (index + 1)),
      };
    }
  }
  return { kind: 'failed', reason: 'bad_answer', ...spent(input * 2, output * 2) };
}

/** Deps that answer each role from its list in turn, and record every call. */
function scripted(
  replies: Partial<Record<ReviewRole, Reply[]>>,
  providerKey: string | null = null,
) {
  const calls: Call[] = [];
  const left = new Map<string, Reply[]>(
    Object.entries(replies).map(([role, list]) => [role, [...(list ?? [])]]),
  );
  const deps: PipelineDeps = {
    providerKey,
    converse: (role, user, nonce, tokenBudget, accept) => {
      const call: Call = {
        role,
        user,
        nonce,
        tokenBudget,
        data: opened(user, nonce),
        accept,
        accepted: [],
      };
      calls.push(call);
      const reply = left.get(role)?.shift();
      if (reply === undefined) throw new Error(`no reply left for ${role}`);
      if (typeof reply === 'function') return Promise.resolve(reply(call));
      return Promise.resolve('texts' in reply ? asked(reply, call) : reply);
    },
  };
  return { deps, calls };
}

const answer = (
  value: unknown,
  [input, output]: [number, number] = [100, 10],
  budgetReached = false,
): ConversationResult => ({
  kind: 'answer',
  text: JSON.stringify(value),
  budgetReached,
  ...spent(input, output),
});
/** An answer that is not JSON, as a conversation that did not check it would give it back. */
const prose = (
  text: string,
  [input, output]: [number, number] = [100, 10],
): ConversationResult => ({
  kind: 'answer',
  text,
  budgetReached: false,
  ...spent(input, output),
});
const stopped = (): ConversationResult => ({ kind: 'stopped', ...spent(50, 0) });
const failed = (
  reason: 'provider_error' | 'provider_no_tools' | 'bad_answer',
  [input, output]: [number, number] = [50, 0],
): ConversationResult => ({ kind: 'failed', reason, ...spent(input, output) });

/** A finding as a specialist writes it. */
const found = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: 'logic',
  severity: 'major',
  confidence: 'high',
  path: 'src/cart.ts',
  line: 3,
  endLine: 3,
  title: 'The total skips the last item',
  body: 'The loop bound is one short. Use `i < n`.',
  assumption: null,
  suggestion: null,
  ...over,
});
/** A finding as the judge writes it. */
const judgedAs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...found(),
  sources: [],
  priorId: null,
  ...over,
});
const judgeSays = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  findings: [],
  dropped: [],
  prior: [],
  summary: { verdict: 'One major problem in the cart total.', walkthrough: ['Totals the cart.'] },
  ...over,
});
/** A judged finding as the outcome holds it. */
const outcomeFinding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...found(),
  sources: [],
  priorId: null,
  verification: null,
  ...over,
});

async function review(context: ReviewContext, budget: number, deps: PipelineDeps) {
  const phases: ReviewPhase[] = [];
  const outcome: PipelineOutcome = await runReviewPipeline(context, budget, deps, (phase) => {
    phases.push(phase);
    return Promise.resolve();
  });
  return { outcome, phases };
}

const titles = (outcome: PipelineOutcome): unknown[] =>
  outcome.kind === 'reviewed' ? outcome.findings.map((f) => f.title) : [];

const prior = (
  id: string,
  status: 'open' | 'false_positive' | 'wont_fix',
  severity = 'medium',
) => ({
  id,
  category: 'logic' as const,
  severity,
  status,
  path: 'src/cart.ts',
  line: 3,
  endLine: 3,
  title: `Prior ${id}`,
  body: 'The total skips the last item.',
  fingerprint: 'f'.repeat(32),
});

describe('planReview', () => {
  it('planReview picks trivial, lite and full by lines and files', () => {
    const plan = (lines: number[]) => planReview(lines.map((n, i) => change(`src/f${i}.ts`, n)));
    expect(plan([4, 6])).toEqual({
      tier: 'trivial',
      specialists: ['quality'],
      changedLines: 10,
      files: 2,
    });
    // Many files of few lines in all are still trivial.
    expect(plan(Array.from({ length: 10 }, () => 1))).toMatchObject({ tier: 'trivial', files: 10 });
    expect(plan([])).toEqual({
      tier: 'trivial',
      specialists: ['quality'],
      changedLines: 0,
      files: 0,
    });
    expect(plan([11])).toEqual({
      tier: 'lite',
      specialists: ['quality', 'tests'],
      changedLines: 11,
      files: 1,
    });
    expect(plan(Array.from({ length: 20 }, () => 15))).toEqual({
      tier: 'lite',
      specialists: ['quality', 'tests'],
      changedLines: 300,
      files: 20,
    });
    // Security runs first, then the others.
    const full = ['security', 'quality', 'tests', 'performance'];
    expect(plan([301])).toEqual({ tier: 'full', specialists: full, changedLines: 301, files: 1 });
    expect(plan(Array.from({ length: 21 }, () => 1))).toEqual({
      tier: 'full',
      specialists: full,
      changedLines: 21,
      files: 21,
    });
  });

  it('a sensitive path adds security at trivial', () => {
    // The security reviewer runs first, with its whole part, whatever the others spend.
    expect(planReview([change('src/auth/login.ts', 2)]).specialists).toEqual([
      'security',
      'quality',
    ]);
    expect(planReview([change('src/main.ts'), change('lib/bcrypt.ts')])).toMatchObject({
      tier: 'trivial',
      specialists: ['security', 'quality'],
    });
    expect(planReview([change('src/session.ts', 50)]).specialists).toEqual([
      'security',
      'quality',
      'tests',
    ]);
    // A full review has the security reviewer already, once.
    expect(planReview([change('src/session.ts', 301)]).specialists).toEqual([
      'security',
      'quality',
      'tests',
      'performance',
    ]);
    // A short word inside a longer one is no sensitive path.
    expect(planReview([change('src/tokenizer.ts', 2)]).specialists).toEqual(['quality']);
    // What decides is the change's `sensitive`, which the context set from the path.
    expect(planReview([{ ...change('src/main.ts'), sensitive: true }]).specialists).toEqual([
      'security',
      'quality',
    ]);
    expect(planReview([{ ...change('src/auth.ts'), sensitive: false }]).specialists).toEqual([
      'quality',
    ]);
  });
});

describe('runReviewPipeline', () => {
  it('specialists run in order and the judge sees their findings with ids', async () => {
    const { deps, calls } = scripted({
      quality: [
        answer({
          findings: [found({ title: 'Q1' }), found({ title: 'Q2', confidence: 'low', line: 1 })],
        }),
      ],
      tests: [answer({ findings: [found({ category: 'tests', title: 'T1', endLine: null })] })],
      security: [answer({ findings: [] })],
      performance: [
        answer({
          findings: [
            found({
              category: 'performance',
              title: 'P1',
              suggestion: { startLine: 3, endLine: 3, lines: ['const total = sum(items);'] },
            }),
          ],
        }),
      ],
      judge: [
        answer(
          judgeSays({
            findings: [
              judgedAs({ title: 'Q1 and T1', sources: ['s1', 's3'] }),
              judgedAs({ category: 'performance', title: 'P1', sources: ['s4'] }),
            ],
            dropped: [{ source: 's2', reason: 'Checked before.' }],
          }),
        ),
      ],
    });
    const { outcome, phases } = await review(
      contextOf([change('src/cart.ts', 301)]),
      100_000,
      deps,
    );

    expect(calls.map((c) => c.role)).toEqual([
      'security',
      'quality',
      'tests',
      'performance',
      'judge',
    ]);
    expect(phases).toEqual(['specialists', 'judge']);
    // Every reviewer is given the same data, without anyone's findings.
    const [first] = calls;
    for (const call of calls.slice(0, 4)) {
      expect(call.data).toEqual(first?.data);
      expect(call.data).not.toHaveProperty('specialistFindings');
    }
    // Every conversation has a nonce of its own.
    expect(new Set(calls.map((c) => c.nonce)).size).toBe(calls.length);
    // The judge is given every finding, numbered in the order of the reviewers.
    expect(calls[4]?.data.specialistFindings).toEqual([
      { id: 's1', reviewer: 'quality', ...found({ title: 'Q1' }) },
      { id: 's2', reviewer: 'quality', ...found({ title: 'Q2', confidence: 'low', line: 1 }) },
      { id: 's3', reviewer: 'tests', ...found({ category: 'tests', title: 'T1' }) },
      {
        id: 's4',
        reviewer: 'performance',
        ...found({
          category: 'performance',
          title: 'P1',
          suggestion: { startLine: 3, endLine: 3, lines: ['const total = sum(items);'] },
        }),
      },
    ]);
    expect(outcome).toEqual({
      kind: 'reviewed',
      tier: 'full',
      specialists: ['security', 'quality', 'tests', 'performance'],
      findings: [
        outcomeFinding({ title: 'Q1 and T1', sources: ['s1', 's3'] }),
        outcomeFinding({ category: 'performance', title: 'P1', sources: ['s4'] }),
      ],
      prior: [],
      shownPriorIds: [],
      namedPriorIds: [],
      summary: {
        verdict: 'One major problem in the cart total.',
        walkthrough: ['Totals the cart.'],
      },
      tokenLimitReached: false,
      notes: [],
    });
  });

  it('an unreadable specialist after one retry contributes nothing and notes it', async () => {
    const { deps, calls } = scripted({
      quality: [
        texts(
          'I found no problems worth reporting.',
          // JSON, but not of the schema.
          JSON.stringify({ findings: [found({ category: 'style' })] }),
        ),
      ],
      tests: [answer({ findings: [found({ category: 'tests', title: 'T1' })] })],
      judge: [answer(judgeSays())],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 50)]), 100_000, deps);

    // One conversation for each: the retry is a turn of its conversation.
    expect(calls.map((c) => c.role)).toEqual(['quality', 'tests', 'judge']);
    expect(calls[0]?.accepted).toEqual([false, false]);
    expect(calls[2]?.data.specialistFindings).toEqual([
      { id: 's1', reviewer: 'tests', ...found({ category: 'tests', title: 'T1' }) },
    ]);
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      specialists: ['quality', 'tests'],
      tokenLimitReached: false,
      notes: ['reviewer_unreadable'],
    });
  });

  it('a specialist that answers in its JSON on the retry contributes its findings', async () => {
    const { deps, calls } = scripted({
      quality: [
        texts(
          '```json\n{"findings": [\n```',
          JSON.stringify({ findings: [found({ title: 'Q1' })] }),
        ),
      ],
      judge: [answer(judgeSays())],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    expect(calls[0]?.accepted).toEqual([false, true]);
    expect(calls[1]?.data.specialistFindings).toEqual([
      { id: 's1', reviewer: 'quality', ...found({ title: 'Q1' }) },
    ]);
    expect(outcome).toMatchObject({ kind: 'reviewed', notes: [] });
  });

  it('an answer a conversation did not check is checked all the same', async () => {
    const { deps, calls } = scripted({
      // Given back as an answer by a conversation that ignored its check: still not used.
      quality: [prose('No problems.')],
      tests: [answer({ findings: [found({ category: 'tests', title: 'T1' })] })],
      judge: [answer(judgeSays())],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 50)]), 100_000, deps);
    expect(calls.map((c) => c.role)).toEqual(['quality', 'tests', 'judge']);
    expect(outcome).toMatchObject({ kind: 'reviewed', notes: ['reviewer_unreadable'] });
  });

  it('an unreadable judge after one retry fails with bad_answer', async () => {
    const first = scripted({
      quality: [answer({ findings: [found()] })],
      judge: [texts('Looks good to me.', JSON.stringify({ ...judgeSays(), approved: true }))],
    });
    const { outcome, phases } = await review(
      contextOf([change('src/cart.ts', 2)]),
      100_000,
      first.deps,
    );
    expect(outcome).toEqual({ kind: 'failed', reason: 'bad_answer' });
    expect(first.calls.map((c) => c.role)).toEqual(['quality', 'judge']);
    expect(first.calls[1]?.accepted).toEqual([false, false]);
    expect(phases).toEqual(['specialists', 'judge']);

    // A judge whose conversation ends without an answer fails the review at once.
    const second = scripted({
      quality: [answer({ findings: [] })],
      judge: [failed('bad_answer', [500, 0])],
    });
    expect(
      (await review(contextOf([change('src/cart.ts', 2)]), 100_000, second.deps)).outcome,
    ).toEqual({ kind: 'failed', reason: 'bad_answer' });
    expect(second.calls.map((c) => c.role)).toEqual(['quality', 'judge']);
  });

  it("a conversation's check takes only its role's JSON, within the role's output, without the key", async () => {
    expect(REVIEW_OUTPUT_TOKENS).toEqual({
      quality: 12_288,
      tests: 12_288,
      security: 12_288,
      performance: 12_288,
      judge: 16_384,
      verify: 2_048,
    });
    const key = j('sk-test-', '0123456789abcdef');
    const { deps, calls } = scripted(
      {
        quality: [answer({ findings: [] })],
        judge: [
          answer(
            judgeSays({ findings: [judgedAs({ category: 'security', severity: 'critical' })] }),
          ),
        ],
        verify: [answer({ verdict: 'confirmed', reason: 'Input reaches it.' })],
      },
      key,
    );
    await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    const [quality, judge, verify] = calls;
    if (quality === undefined || judge === undefined || verify === undefined) {
      throw new Error('a conversation is missing');
    }
    expect(quality.accept('Here you go.')).toBe(false);
    expect(quality.accept(JSON.stringify({ findings: [found({ category: 'style' })] }))).toBe(
      false,
    );
    expect(quality.accept(JSON.stringify({ findings: [found()] }))).toBe(true);
    // Each role has its own schema.
    expect(quality.accept(JSON.stringify(judgeSays()))).toBe(false);
    expect(judge.accept(JSON.stringify(judgeSays()))).toBe(true);
    expect(verify.accept(JSON.stringify({ verdict: 'confirmed', reason: 'r' }))).toBe(true);
    expect(verify.accept(JSON.stringify({ findings: [] }))).toBe(false);
    // The key is taken out before the schema is checked: an answer with it is read without it.
    expect(quality.accept(JSON.stringify({ findings: [found({ title: `Key ${key}` })] }))).toBe(
      true,
    );
    // An answer is read up to four characters for each token the role may write.
    const padded = (value: unknown, length: number): string => {
      const json = JSON.stringify(value);
      return `${json}${' '.repeat(length - json.length)}`;
    };
    for (const [call, role, valid] of [
      [quality, 'quality', { findings: [] }],
      [judge, 'judge', judgeSays()],
      [verify, 'verify', { verdict: 'rejected', reason: 'r' }],
    ] as const) {
      const limit = 4 * REVIEW_OUTPUT_TOKENS[role];
      expect(call.accept(padded(valid, limit)), role).toBe(true);
      expect(call.accept(padded(valid, limit + 1)), role).toBe(false);
    }
  });

  it('verification drops rejected, downgrades needs_validation, marks confirmed, and stops after 5', async () => {
    const security = (title: string, severity: string) =>
      judgedAs({ category: 'security', severity, title, sources: ['s1'] });
    const verdicts: Record<string, string> = {
      B: 'rejected',
      E: 'needs_validation',
      A: 'confirmed',
      F: 'confirmed',
      G: 'rejected',
    };
    const byTitle = (call: Call): ConversationResult => {
      const { title } = call.data.finding as { title: string };
      return answer({ verdict: verdicts[title], reason: 'The query is built from the request.' });
    };
    const { deps, calls } = scripted({
      quality: [answer({ findings: [found()] })],
      security: [answer({ findings: [] })],
      judge: [
        answer(
          judgeSays({
            findings: [
              security('A', 'major'),
              security('B', 'critical'),
              judgedAs({ severity: 'critical', title: 'C', sources: ['s1'] }),
              security('D', 'minor'),
              security('E', 'critical'),
              security('F', 'major'),
              security('G', 'major'),
              security('H', 'major'),
              security('I', 'major'),
            ],
          }),
        ),
      ],
      verify: Array.from({ length: 5 }, () => byTitle),
    });
    const { outcome, phases } = await review(contextOf([change('src/auth.ts', 2)]), 100_000, deps);

    expect(phases).toEqual(['specialists', 'judge', 'verification']);
    // The critical ones first, then the major ones in the judge's order, five in all.
    const verified = calls.filter((c) => c.role === 'verify');
    expect(verified.map((c) => (c.data.finding as { title: string }).title)).toEqual([
      'B',
      'E',
      'A',
      'F',
      'G',
    ]);
    // A verifier is given its finding and nothing else.
    for (const call of verified) {
      expect(Object.keys(call.data)).toEqual(['finding']);
      expect(Object.keys(call.data.finding as object)).toEqual([
        'category',
        'severity',
        'path',
        'line',
        'endLine',
        'title',
        'body',
        'assumption',
      ]);
    }
    const sec = (title: string, severity: string, over: Record<string, unknown> = {}) =>
      outcomeFinding({ category: 'security', severity, title, sources: ['s1'], ...over });
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      findings: [
        sec('A', 'major', { verification: 'confirmed' }),
        outcomeFinding({ severity: 'critical', title: 'C', sources: ['s1'] }),
        sec('D', 'minor'),
        sec('E', 'critical', { verification: 'needs_validation', confidence: 'medium' }),
        sec('F', 'major', { verification: 'confirmed' }),
        sec('H', 'major'),
        sec('I', 'major'),
      ],
      tokenLimitReached: false,
      notes: ['verification_capped'],
    });
  });

  it('a verification that cannot be read keeps its finding unverified and says so', async () => {
    const { deps, calls } = scripted({
      quality: [answer({ findings: [] })],
      judge: [
        answer(
          judgeSays({
            findings: [judgedAs({ category: 'security', severity: 'critical', title: 'S' })],
          }),
        ),
      ],
      verify: [texts('It is real.', JSON.stringify({ verdict: 'maybe', reason: 'r' }))],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    expect(calls.map((c) => c.role)).toEqual(['quality', 'judge', 'verify']);
    expect(calls[2]?.accepted).toEqual([false, false]);
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      findings: [outcomeFinding({ category: 'security', severity: 'critical', title: 'S' })],
      notes: ['reviewer_unreadable'],
    });
  });

  it('low-confidence judged findings are dropped', async () => {
    const { deps, calls } = scripted({
      quality: [answer({ findings: [found({ confidence: 'low' })] })],
      judge: [
        answer(
          judgeSays({
            findings: [
              judgedAs({ title: 'High' }),
              judgedAs({ title: 'Medium', confidence: 'medium' }),
              judgedAs({ title: 'Low', confidence: 'low' }),
              judgedAs({
                title: 'Low security',
                category: 'security',
                severity: 'critical',
                confidence: 'low',
              }),
            ],
          }),
        ),
      ],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    expect(titles(outcome)).toEqual(['High', 'Medium']);
    // A low-confidence finding is not verified either: it is gone before.
    expect(calls.map((c) => c.role)).toEqual(['quality', 'judge']);
  });

  it("a specialist cannot spend the judge's share, nor another specialist's part", async () => {
    // Of 10 000 tokens the specialists have 5 500, a part of 2 750 for each of the two of a lite
    // review; the judge 3 500 and the verification 1 000.
    const context = contextOf([change('src/cart.ts', 50)]);
    for (const spent of [
      [400, 100],
      [4_000, 1_000],
      // Past the whole of the specialists' share, and past what the judge's would leave.
      [6_500, 500],
    ] as [number, number][]) {
      const { deps, calls } = scripted({
        quality: [answer({ findings: [] }, spent)],
        tests: [answer({ findings: [] }, [400, 100])],
        judge: [answer(judgeSays())],
      });
      const { outcome } = await review(context, 10_000, deps);
      expect(
        calls.map((c) => [c.role, c.tokenBudget]),
        String(spent),
      ).toEqual([
        ['quality', 2_750],
        ['tests', 2_750],
        ['judge', 3_500],
      ]);
      expect(outcome).toMatchObject({
        kind: 'reviewed',
        specialists: ['quality', 'tests'],
        tokenLimitReached: false,
        notes: [],
      });
    }

    // What a conversation that ended without an answer spent is charged all the same.
    const failing = scripted({
      quality: [failed('bad_answer', [2_000, 0])],
      tests: [answer({ findings: [] }, [400, 100])],
      judge: [answer(judgeSays())],
    });
    const three = await review(context, 10_000, failing.deps);
    expect(failing.calls.map((c) => [c.role, c.tokenBudget])).toEqual([
      ['quality', 2_750],
      ['tests', 2_750],
      ['judge', 3_500],
    ]);
    expect(three.outcome).toMatchObject({ kind: 'reviewed', notes: ['reviewer_unreadable'] });

    // A part that rounds to nothing is not run, and the review says the limit was reached.
    const none = scripted({ judge: [answer(judgeSays())] });
    const tiny = await review(context, 3, none.deps);
    expect(none.calls.map((c) => [c.role, c.tokenBudget])).toEqual([['judge', 1]]);
    expect(tiny.outcome).toMatchObject({
      kind: 'reviewed',
      specialists: [],
      tokenLimitReached: true,
      notes: ['token_limit_reached'],
    });
  });

  it('an answer given after the wrap-up says that the token limit was reached', async () => {
    const { deps } = scripted({
      quality: [answer({ findings: [found()] }, [900, 100], true)],
      judge: [answer(judgeSays({ findings: [judgedAs()] }))],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      findings: [outcomeFinding()],
      tokenLimitReached: true,
      notes: ['token_limit_reached'],
    });
  });

  it('verification has a share of its own, shared between the findings it checks', async () => {
    const serious = judgeSays({
      findings: [
        judgedAs({ category: 'security', title: 'A' }),
        judgedAs({ category: 'security', title: 'B' }),
      ],
    });
    const confirmed = (): ConversationResult =>
      answer({ verdict: 'confirmed', reason: 'r' }, [200, 50]);
    // Of 10 000 tokens the verification has 1 000: half for the first, what is left for the second.
    const shared = scripted({
      quality: [answer({ findings: [] })],
      judge: [answer(serious)],
      verify: [confirmed(), confirmed()],
    });
    await review(contextOf([change('src/cart.ts', 2)]), 10_000, shared.deps);
    expect(shared.calls.filter((c) => c.role === 'verify').map((c) => c.tokenBudget)).toEqual([
      500, 750,
    ]);

    // What the judge spent past its share is not taken from it: the findings are verified still.
    const overspent = scripted({
      quality: [answer({ findings: [] })],
      judge: [answer(serious, [9_800, 200])],
      verify: [confirmed(), confirmed()],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 10_000, overspent.deps);
    expect(overspent.calls.filter((c) => c.role === 'verify').map((c) => c.tokenBudget)).toEqual([
      500, 750,
    ]);
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      findings: [
        outcomeFinding({ category: 'security', title: 'A', verification: 'confirmed' }),
        outcomeFinding({ category: 'security', title: 'B', verification: 'confirmed' }),
      ],
      tokenLimitReached: false,
    });

    // A share that rounds to nothing verifies nothing, and the review says so.
    const none = scripted({ quality: [answer({ findings: [] })], judge: [answer(serious)] });
    const tiny = await review(contextOf([change('src/cart.ts', 2)]), 9, none.deps);
    expect(none.calls.map((c) => c.role)).toEqual(['quality', 'judge']);
    expect(tiny.outcome).toMatchObject({
      kind: 'reviewed',
      tokenLimitReached: true,
      notes: ['token_limit_reached'],
    });
  });

  it('a budget too small to give the judge a share runs nothing', async () => {
    const { deps, calls } = scripted({});
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 2, deps);
    expect(outcome).toEqual({ kind: 'failed', reason: 'bad_answer' });
    expect(calls).toEqual([]);
  });

  it('a stopped conversation stops the pipeline', async () => {
    const context = contextOf([change('src/auth.ts', 50)]);
    const serious = judgeSays({ findings: [judgedAs({ category: 'security', title: 'S' })] });
    const cases: [Partial<Record<ReviewRole, Reply[]>>, ReviewRole[]][] = [
      [{ security: [stopped()] }, ['security']],
      [{ security: [answer({ findings: [] })], quality: [stopped()] }, ['security', 'quality']],
      [
        {
          security: [answer({ findings: [] })],
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          judge: [stopped()],
        },
        ['security', 'quality', 'tests', 'judge'],
      ],
      [
        {
          security: [answer({ findings: [] })],
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          judge: [answer(serious)],
          verify: [stopped()],
        },
        ['security', 'quality', 'tests', 'judge', 'verify'],
      ],
    ];
    for (const [replies, roles] of cases) {
      const { deps, calls } = scripted(replies);
      const { outcome } = await review(context, 100_000, deps);
      expect(outcome).toEqual({ kind: 'stopped' });
      expect(calls.map((c) => c.role)).toEqual(roles);
    }
  });

  it('a provider that fails ends the review with its reason', async () => {
    const context = contextOf([change('src/auth.ts', 50)]);
    const serious = judgeSays({ findings: [judgedAs({ category: 'security', title: 'S' })] });
    const cases: [Partial<Record<ReviewRole, Reply[]>>, string, ReviewRole[]][] = [
      [{ security: [failed('provider_no_tools')] }, 'provider_no_tools', ['security']],
      [
        { security: [answer({ findings: [] })], quality: [failed('provider_error')] },
        'provider_error',
        ['security', 'quality'],
      ],
      [
        {
          security: [answer({ findings: [] })],
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          judge: [failed('provider_error')],
        },
        'provider_error',
        ['security', 'quality', 'tests', 'judge'],
      ],
      [
        {
          security: [answer({ findings: [] })],
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          judge: [answer(serious)],
          verify: [failed('provider_error')],
        },
        'provider_error',
        ['security', 'quality', 'tests', 'judge', 'verify'],
      ],
    ];
    for (const [replies, reason, roles] of cases) {
      const { deps, calls } = scripted(replies);
      const { outcome } = await review(context, 100_000, deps);
      expect(outcome).toEqual({ kind: 'failed', reason });
      expect(calls.map((c) => c.role)).toEqual(roles);
    }
  });

  it('the provider key is taken out of every answer before it is used', async () => {
    const key = j('sk-test-', '0123456789abcdef');
    // The key as JSON escapes spell it: a parser reads it back.
    const escaped = [...key]
      .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    const quality = JSON.stringify({ findings: [found({ title: `Key ${key} in code` })] });
    const judge = JSON.stringify(
      judgeSays({ findings: [judgedAs({ body: 'Rotate KEY now.' })] }),
    ).replace('KEY', escaped);
    const { deps, calls } = scripted({ quality: [texts(quality)], judge: [texts(judge)] }, key);
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    const judgeCall = calls.find((c) => c.role === 'judge');
    expect(JSON.stringify(judgeCall?.data)).not.toContain(key);
    expect(judgeCall?.data.specialistFindings).toEqual([
      { id: 's1', reviewer: 'quality', ...found({ title: `Key ${REDACTED} in code` }) },
    ]);
    expect(JSON.stringify(outcome)).not.toContain(key);
    expect(outcome).toMatchObject({
      findings: [outcomeFinding({ body: `Rotate ${REDACTED} now.` })],
    });
  });

  it('the judge keeps only the sources, prior findings and verdicts it was given', async () => {
    const context = contextOf([change('src/cart.ts', 2)], {
      prior: [prior('issue-1', 'open'), prior('issue-2', 'wont_fix')],
    });
    const { deps, calls } = scripted({
      quality: [answer({ findings: [found()] })],
      judge: [
        answer(
          judgeSays({
            findings: [
              judgedAs({ title: 'Kept', sources: ['s1', 's9', 's1'], priorId: 'issue-1' }),
              judgedAs({ title: 'Forged', priorId: 'issue-9' }),
            ],
            prior: [
              { id: 'issue-1', status: 'present', reason: 'Still one short.' },
              { id: 'issue-9', status: 'fixed', reason: 'Gone.' },
              { id: 'issue-1', status: 'fixed', reason: 'Said twice.' },
              // A verdict on a finding a person dismissed changes nothing.
              { id: 'issue-2', status: 'fixed', reason: 'Gone.' },
            ],
          }),
        ),
      ],
    });
    const { outcome } = await review(context, 100_000, deps);
    const judgeCall = calls.find((c) => c.role === 'judge');
    expect((judgeCall?.data.priorFindings as { id: string }[]).map((p) => p.id)).toEqual([
      'issue-1',
      'issue-2',
    ]);
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      findings: [
        outcomeFinding({ title: 'Kept', sources: ['s1'], priorId: 'issue-1' }),
        outcomeFinding({ title: 'Forged' }),
      ],
      prior: [{ id: 'issue-1', status: 'present', reason: 'Still one short.' }],
      // The prior findings the judge was shown: only those can be closed for being left out.
      shownPriorIds: ['issue-1', 'issue-2'],
    });
  });

  it('lists the prior findings the judge named, once each, also in findings the review drops itself', async () => {
    const context = contextOf([change('src/cart.ts', 2)], {
      prior: [
        prior('issue-1', 'open'),
        prior('issue-2', 'open'),
        prior('issue-3', 'open'),
        prior('issue-4', 'wont_fix'),
      ],
    });
    const { deps } = scripted({
      quality: [answer({ findings: [found()] })],
      judge: [
        answer(
          judgeSays({
            findings: [
              judgedAs({ title: 'Kept', priorId: 'issue-1' }),
              // Dropped by the review: of low confidence, and rejected by the verification.
              judgedAs({ title: 'Doubtful', confidence: 'low', priorId: 'issue-2' }),
              judgedAs({
                title: 'Rejected',
                category: 'security',
                severity: 'critical',
                priorId: 'issue-3',
              }),
              judgedAs({ title: 'Again', priorId: 'issue-1' }),
              // An id the judge was not given names nothing.
              judgedAs({ title: 'Forged', priorId: 'issue-9' }),
              judgedAs({ title: 'Of a dismissed one', priorId: 'issue-4' }),
              judgedAs({ title: 'Of none' }),
            ],
          }),
        ),
      ],
      verify: [answer({ verdict: 'rejected', reason: 'It is not reachable.' })],
    });
    const { outcome } = await review(context, 100_000, deps);
    if (outcome.kind !== 'reviewed') throw new Error(outcome.kind);
    expect(titles(outcome)).toEqual(['Kept', 'Again', 'Forged', 'Of a dismissed one', 'Of none']);
    expect(outcome.namedPriorIds).toEqual(['issue-1', 'issue-2', 'issue-3', 'issue-4']);
  });

  it('names the prior findings the judge was shown: the open ones first, at most 50', async () => {
    const context = contextOf([change('src/cart.ts', 2)], {
      prior: [
        ...Array.from({ length: 60 }, (_, i) => prior(`dismissed-${i}`, 'false_positive', 'high')),
        prior('open-1', 'open', 'low'),
      ],
    });
    const { deps } = scripted({
      quality: [answer({ findings: [] })],
      judge: [answer(judgeSays())],
    });
    const { outcome } = await review(context, 100_000, deps);
    if (outcome.kind !== 'reviewed') throw new Error(outcome.kind);
    expect(outcome.shownPriorIds).toHaveLength(50);
    expect(outcome.shownPriorIds[0]).toBe('open-1');
    expect(outcome.shownPriorIds).not.toContain('dismissed-49');
  });

  it("cuts the bodies of the specialists' findings when the judge's data would take more than a third of its share", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      found({ title: `F${i}`, body: 'b'.repeat(1_200) }),
    );
    const bodies = async (budget: number): Promise<number[]> => {
      const { deps, calls } = scripted({
        quality: [answer({ findings: many })],
        judge: [answer(judgeSays())],
      });
      await review(contextOf([change('src/cart.ts', 2)]), budget, deps);
      const judgeCall = calls.find((c) => c.role === 'judge');
      const message = SYSTEM_PROMPTS.judge.length + (judgeCall?.user.length ?? 0);
      const third =
        Math.floor(Math.floor((budget * STAGE_SHARES.judge) / 100) / 3) * CHARS_PER_TOKEN;
      if (budget < 1_000_000) expect(message).toBeLessThanOrEqual(third);
      return (judgeCall?.data.specialistFindings as { body: string }[]).map((f) => f.body.length);
    };
    // With room, the bodies are whole; with less, each is cut, and every finding is still there.
    expect(new Set(await bodies(10_000_000))).toEqual(new Set([1_200]));
    const cut = await bodies(100_000);
    expect(cut).toHaveLength(30);
    expect(Math.max(...cut)).toBeLessThan(1_200);
  });
});

describe('reviewLimits', () => {
  const RULE = 'typescript:S1854';
  const MESSAGE =
    'Remove this useless assignment to variable "total"; it is overwritten before it is read.';
  const TITLE = 'Fix the cart total';
  // As long as a description is shown: what it takes counts.
  const DESCRIPTION = 'd'.repeat(4_000);
  const SKIPPED = Array.from({ length: 5 }, (_, i) => ({
    path: `vendor/lib-${i}.min.js`,
    why: 'minified' as const,
  }));
  /** The instructions files as the snapshot holds them: their names and lengths. */
  type Instructions = [name: string, chars: number][];

  /** A context as buildReviewContext makes it under `limits`, with ordinary lists. */
  function sizedContext(
    reviewed: ReviewableChange[],
    limits: ReturnType<typeof reviewLimits>,
    analyzer: number,
    instructions: Instructions,
  ): ReviewContext {
    const row =
      '  12+    const total = items.reduce((sum, item) => sum + item.price * item.count, 0);';
    const rows: string[] = [];
    for (let size = row.length; size <= limits.sliceChars; size += row.length + 1) rows.push(row);
    const cut = (name: string, text: string) => ({
      name,
      text:
        text.length <= limits.instructionsChars
          ? text
          : `${text.slice(0, limits.instructionsChars)}\n[cut: the text has ${text.length} characters, only the first ${limits.instructionsChars} are shown]`,
    });
    return contextOf(reviewed, {
      meta: {
        ...META,
        mrTitle: TITLE,
        mrDescription: DESCRIPTION,
        instructions: instructions.map(([name, chars]) => cut(name, 'a'.repeat(chars))),
      },
      skipped: SKIPPED,
      slices: rows.join('\n'),
      omittedFromSlices: reviewed.map(
        (c) => `${c.path} (${c.changedLines} changed lines): read it with read_file`,
      ),
      analyzer: Array.from({ length: analyzer }, (_, i) => ({
        ruleKey: RULE,
        severity: 'medium',
        message: MESSAGE,
        path: reviewed[i % reviewed.length]?.path ?? 'src/a.ts',
        line: 120,
      })),
    });
  }
  /** The shape the context would ask its limits with, from the same things. */
  const shapeOf = (
    reviewed: ReviewableChange[],
    analyzer: number,
    instructions: Instructions,
  ): ContextShape => ({
    reviewed,
    skipped: SKIPPED,
    analyzerChars: Array.from(
      { length: analyzer },
      (_, i) => (reviewed[i % reviewed.length]?.path.length ?? 0) + RULE.length + MESSAGE.length,
    ),
    wordsChars: TITLE.length + DESCRIPTION.length,
    instructionChars: instructions.map(([, chars]) => chars),
  });
  const changes = (count: number, lines: number, sensitive = false) =>
    Array.from({ length: count }, (_, i) =>
      change(`server/src/${sensitive ? 'auth' : 'module'}${i}/handlers/some-file-${i}.ts`, lines),
    );
  /** The characters a first message of each specialist may take: a third of its part, and of half the judge's share. */
  const thirdOf = (budget: number, specialists: number): number => {
    const part = Math.floor(Math.floor((budget * STAGE_SHARES.specialists) / 100) / specialists);
    const judgeHalf = Math.floor(Math.floor((budget * STAGE_SHARES.judge) / 100) / 2);
    return Math.floor(Math.min(part, judgeHalf) / 3) * CHARS_PER_TOKEN;
  };

  it("sizes a reviewer's first message to a third of its part, keeping half of the judge's third for the findings", () => {
    const agents: Instructions = [['AGENTS.md', 8_000]];
    for (const budget of [300_000, 1_000_000]) {
      for (const reviewed of [
        changes(2, 2),
        changes(10, 20),
        changes(30, 40),
        changes(2, 2, true),
      ]) {
        for (const analyzer of [0, 10]) {
          const plan = planReview(reviewed);
          const shape = shapeOf(reviewed, analyzer, agents);
          const limits = reviewLimits(shape, budget);
          const data = specialistData(sizedContext(reviewed, limits, analyzer, agents));
          const name = `${budget} ${plan.tier} ${analyzer}`;
          for (const role of plan.specialists) {
            const message = SYSTEM_PROMPTS[role].length + envelope(data, newNonce()).length;
            expect(message, `${name} ${role}`).toBeLessThanOrEqual(
              thirdOf(budget, plan.specialists.length),
            );
          }
          // The instructions are shown whole, and there is room for code still.
          expect(limits.instructionsChars, name).toBeGreaterThanOrEqual(8_000);
          expect(limits.sliceChars, name).toBeGreaterThan(5_000);
        }
      }
    }
  });

  it('counts the lists as the change has them: a small change shows its instructions and its code, whatever the analyzers found', () => {
    // One file of six changed lines with a hundred findings of the analyzers on it, a description
    // as long as one is shown and an AGENTS.md of 8 000 characters: all of them fit its third, and
    // code besides.
    const reviewed = changes(1, 6);
    const agents: Instructions = [['AGENTS.md', 8_000]];
    const limits = reviewLimits(shapeOf(reviewed, 100, agents), 300_000);
    expect(limits.instructionsChars).toBeGreaterThanOrEqual(8_000);
    expect(limits.sliceChars).toBeGreaterThan(5_000);
    // And it is sized to its third, not past it.
    const data = specialistData(sizedContext(reviewed, limits, 100, agents));
    expect(SYSTEM_PROMPTS.quality.length + envelope(data, newNonce()).length).toBeLessThanOrEqual(
      thirdOf(300_000, 1),
    );
  });

  it('gives the instructions files the first claim, at least 16 000 characters each, and the slices what is left', () => {
    const long: Instructions = [
      ['AGENTS.md', 8_000],
      ['REVIEW.md', 40_000],
    ];
    // Plenty of room: each part as large as it may be.
    expect(reviewLimits(shapeOf(changes(30, 40), 10, long), 10_000_000)).toEqual(CONTEXT_MAXIMA);
    // Room for the instructions whole: they take it before the slices.
    const ample = reviewLimits(shapeOf(changes(30, 40), 10, long), 1_000_000);
    expect(ample.instructionsChars).toBe(CONTEXT_MAXIMA.instructionsChars);
    expect(ample.sliceChars).toBeGreaterThan(0);
    // Too little room for them: still 16 000 characters each, and no slices.
    for (const budget of [300_000, 60_000, 0, Number.NaN]) {
      expect(reviewLimits(shapeOf(changes(30, 40), 10, long), budget), String(budget)).toEqual({
        sliceChars: 0,
        instructionsChars: 16_000,
      });
    }
    // Without instructions the slices have the room.
    const none = reviewLimits(shapeOf(changes(30, 40), 10, []), 1_000_000);
    expect(none.sliceChars).toBeGreaterThan(ample.sliceChars);
  });

  it('reviewFits: the smallest share has room before the instructions floors, as reviewLimits counts it', () => {
    // Without instructions files the room is what the slices get: it fits exactly when they get some.
    const bare = shapeOf(changes(1, 6), 0, []);
    for (let budget = 10_000; budget <= 120_000; budget += 2_500) {
      expect(reviewFits(bare, budget), String(budget)).toBe(
        reviewLimits(bare, budget).sliceChars > 0,
      );
    }
    expect(reviewFits(bare, 10_000)).toBe(false);
    expect(reviewFits(bare, 120_000)).toBe(true);
    // The floors of the instructions files are not counted: a long AGENTS.md changes nothing.
    const instructed = shapeOf(changes(1, 6), 0, [['AGENTS.md', 40_000]]);
    for (const budget of [10_000, 60_000, 120_000]) {
      expect(reviewFits(instructed, budget), String(budget)).toBe(reviewFits(bare, budget));
    }
    // The lists count: a hundred findings of the analyzers need a larger budget.
    const listed = shapeOf(changes(1, 6), 100, []);
    const smallest = (shape: ContextShape) => {
      let budget = 0;
      while (!reviewFits(shape, budget)) budget += 1_000;
      return budget;
    };
    expect(smallest(listed)).toBeGreaterThan(smallest(bare));
    // Nothing to spend fits nothing; a full tier needs more than a trivial one.
    for (const budget of [0, -1, Number.NaN]) expect(reviewFits(bare, budget)).toBe(false);
    expect(smallest(shapeOf(changes(30, 40), 0, []))).toBeGreaterThan(smallest(bare));
  });
});
