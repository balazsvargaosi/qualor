import { REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { ReviewPhase } from '../db/schema';
import { SENSITIVE_PATH, type ReviewableChange, type ReviewContext } from './context';
import type { ConversationResult } from './conversation';
import {
  planReview,
  runReviewPipeline,
  type PipelineDeps,
  type PipelineOutcome,
  type ReviewRole,
} from './pipeline';

/** The retry turn, as the brief spells it: a change here is a change of contract. */
const RETRY = 'Your answer did not match the required JSON; answer again with JSON only.';

function change(path: string, changedLines = 1): ReviewableChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    since: null,
    hasPatch: true,
    lines: 40,
    text: null,
    added: new Set([3]),
    changedLines,
    sensitive: SENSITIVE_PATH.test(path),
    removed: [],
    unshown: null,
  };
}

function contextOf(reviewed: ReviewableChange[], over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    meta: {
      snapshotId: null,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      sinceSha: null,
      targetBranch: 'main',
      mrTitle: 'Add a cart total',
      mrDescription: null,
      instructions: [],
      partial: false,
    },
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
  /** The retry sentence follows the data. */
  retry: boolean;
}
type Reply = ConversationResult | ((call: Call) => ConversationResult);

/** The data of a first message: the envelope's line between its markers, and what follows them. */
function opened(user: string, nonce: string): Pick<Call, 'data' | 'retry'> {
  const lines = user.split('\n');
  expect(lines[0]).toContain(nonce);
  expect(lines[1]).toBe(`<<<QUALOR-DATA-${nonce}`);
  expect(lines[3]).toBe(`QUALOR-DATA-${nonce}>>>`);
  const after = lines.slice(4);
  if (after.length > 0) expect(after).toEqual(['', RETRY]);
  return { data: JSON.parse(lines[2] ?? '') as Record<string, unknown>, retry: after.length > 0 };
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
    converse: (role, user, nonce, tokenBudget) => {
      const call: Call = { role, user, nonce, tokenBudget, ...opened(user, nonce) };
      calls.push(call);
      const reply = left.get(role)?.shift();
      if (reply === undefined) throw new Error(`no reply left for ${role}`);
      return Promise.resolve(typeof reply === 'function' ? reply(call) : reply);
    },
  };
  return { deps, calls };
}

const spent = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  turns: 1,
  toolCalls: 0,
});
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
/** An answer that is not JSON. */
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
    const full = ['quality', 'tests', 'security', 'performance'];
    expect(plan([301])).toEqual({ tier: 'full', specialists: full, changedLines: 301, files: 1 });
    expect(plan(Array.from({ length: 21 }, () => 1))).toEqual({
      tier: 'full',
      specialists: full,
      changedLines: 21,
      files: 21,
    });
  });

  it('a sensitive path adds security at trivial', () => {
    expect(planReview([change('src/auth/login.ts', 2)]).specialists).toEqual([
      'quality',
      'security',
    ]);
    expect(planReview([change('src/main.ts'), change('lib/bcrypt.ts')])).toMatchObject({
      tier: 'trivial',
      specialists: ['quality', 'security'],
    });
    expect(planReview([change('src/session.ts', 50)]).specialists).toEqual([
      'quality',
      'tests',
      'security',
    ]);
    // A full review has the security reviewer already, once.
    expect(planReview([change('src/session.ts', 301)]).specialists).toEqual([
      'quality',
      'tests',
      'security',
      'performance',
    ]);
    // A short word inside a longer one is no sensitive path.
    expect(planReview([change('src/tokenizer.ts', 2)]).specialists).toEqual(['quality']);
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
            dropped: [{ source: 's2', reason: 'Line 1 is checked before.' }],
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
      'quality',
      'tests',
      'security',
      'performance',
      'judge',
    ]);
    expect(phases).toEqual(['specialists', 'judge']);
    // Every reviewer is given the same data, without anyone's findings.
    const [first] = calls;
    for (const call of calls.slice(0, 4)) {
      expect(call.retry).toBe(false);
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
      specialists: ['quality', 'tests', 'security', 'performance'],
      findings: [
        outcomeFinding({ title: 'Q1 and T1', sources: ['s1', 's3'] }),
        outcomeFinding({ category: 'performance', title: 'P1', sources: ['s4'] }),
      ],
      prior: [],
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
        prose('I found no problems worth reporting.'),
        // JSON, but not of the schema.
        answer({ findings: [found({ category: 'style' })] }),
      ],
      tests: [answer({ findings: [found({ category: 'tests', title: 'T1' })] })],
      judge: [answer(judgeSays())],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 50)]), 100_000, deps);

    expect(calls.map((c) => [c.role, c.retry])).toEqual([
      ['quality', false],
      ['quality', true],
      ['tests', false],
      ['judge', false],
    ]);
    // The retry is a conversation of its own: the same data under a new nonce, then the sentence.
    expect(calls[1]?.data).toEqual(calls[0]?.data);
    expect(calls[1]?.nonce).not.toBe(calls[0]?.nonce);
    expect(calls[1]?.user.endsWith(`\n\n${RETRY}`)).toBe(true);
    expect(calls[3]?.data.specialistFindings).toEqual([
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
        prose('```json\n{"findings": [\n```'),
        answer({ findings: [found({ title: 'Q1' })] }),
      ],
      judge: [answer(judgeSays())],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    expect(calls.map((c) => [c.role, c.retry])).toEqual([
      ['quality', false],
      ['quality', true],
      ['judge', false],
    ]);
    expect(calls[2]?.data.specialistFindings).toEqual([
      { id: 's1', reviewer: 'quality', ...found({ title: 'Q1' }) },
    ]);
    expect(outcome).toMatchObject({ kind: 'reviewed', notes: [] });
  });

  it('a conversation that ends without an answer is not retried', async () => {
    const { deps, calls } = scripted({
      quality: [failed('bad_answer', [300, 0])],
      tests: [answer({ findings: [] })],
      judge: [answer(judgeSays())],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 50)]), 100_000, deps);
    expect(calls.map((c) => c.role)).toEqual(['quality', 'tests', 'judge']);
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      specialists: ['quality', 'tests'],
      notes: ['reviewer_unreadable'],
    });
  });

  it('an unreadable judge after one retry fails with bad_answer', async () => {
    const first = scripted({
      quality: [answer({ findings: [found()] })],
      judge: [prose('Looks good to me.'), answer({ ...judgeSays(), approved: true })],
    });
    const { outcome, phases } = await review(
      contextOf([change('src/cart.ts', 2)]),
      100_000,
      first.deps,
    );
    expect(outcome).toEqual({ kind: 'failed', reason: 'bad_answer' });
    expect(first.calls.map((c) => [c.role, c.retry])).toEqual([
      ['quality', false],
      ['judge', false],
      ['judge', true],
    ]);
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
      verify: [prose('It is real.'), answer({ verdict: 'maybe', reason: 'r' })],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 100_000, deps);
    expect(calls.map((c) => [c.role, c.retry])).toEqual([
      ['quality', false],
      ['judge', false],
      ['verify', false],
      ['verify', true],
    ]);
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

  it("a specialist cannot spend the judge's share", async () => {
    // Of 10 000 tokens the specialists have 5 500, split between the two of a lite review, the
    // judge 3 500 and the verification 1 000.
    const context = contextOf([change('src/cart.ts', 50)]);
    const over = scripted({
      // 5 000 of its 2 750: the next specialist has what is left of their share.
      quality: [answer({ findings: [] }, [4_000, 1_000])],
      tests: [answer({ findings: [] }, [400, 100])],
      judge: [answer(judgeSays())],
    });
    const one = await review(context, 10_000, over.deps);
    expect(over.calls.map((c) => [c.role, c.tokenBudget])).toEqual([
      ['quality', 2_750],
      ['tests', 500],
      ['judge', 3_500],
    ]);
    expect(one.outcome).toMatchObject({ kind: 'reviewed', tokenLimitReached: false, notes: [] });

    // One that spends all of their share leaves the next nothing: it does not run, and the review
    // says the limit was reached. The judge keeps its share, even when what the specialists spent
    // leaves less than that of the whole budget.
    const all = scripted({
      quality: [answer({ findings: [] }, [6_500, 500])],
      judge: [answer(judgeSays())],
    });
    const two = await review(context, 10_000, all.deps);
    expect(all.calls.map((c) => [c.role, c.tokenBudget])).toEqual([
      ['quality', 2_750],
      ['judge', 3_500],
    ]);
    expect(two.outcome).toMatchObject({
      kind: 'reviewed',
      specialists: ['quality'],
      tokenLimitReached: true,
      notes: ['token_limit_reached'],
    });

    // What an unreadable or failed conversation spent is taken too: the retry has what is left of
    // its reviewer's part, and the next reviewer what is left of their share.
    const failing = scripted({
      quality: [prose('Nothing.', [2_000, 0]), answer({ findings: [] })],
      tests: [failed('bad_answer', [1_000, 0])],
      judge: [prose('No.', [3_400, 100])],
    });
    const three = await review(context, 10_000, failing.deps);
    expect(failing.calls.map((c) => [c.role, c.tokenBudget])).toEqual([
      ['quality', 2_750],
      ['quality', 750],
      ['tests', 3_390],
      // The judge's retry has nothing left of its share: the judge failed.
      ['judge', 3_500],
    ]);
    expect(three.outcome).toEqual({ kind: 'failed', reason: 'bad_answer' });

    // A reviewer whose unreadable answer spent all of its part is not asked again: it adds
    // nothing, and both are noted.
    const spentPart = scripted({
      quality: [prose('Nothing.', [2_700, 50])],
      tests: [answer({ findings: [] })],
      judge: [answer(judgeSays())],
    });
    const four = await review(context, 10_000, spentPart.deps);
    expect(spentPart.calls.map((c) => [c.role, c.tokenBudget])).toEqual([
      ['quality', 2_750],
      ['tests', 2_750],
      ['judge', 3_500],
    ]);
    expect(four.outcome).toMatchObject({
      kind: 'reviewed',
      specialists: ['quality', 'tests'],
      tokenLimitReached: true,
      notes: ['token_limit_reached', 'reviewer_unreadable'],
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

  it("verification shares its part between the findings it checks, within the review's budget", async () => {
    const serious = judgeSays({
      findings: [
        judgedAs({ category: 'security', title: 'A' }),
        judgedAs({ category: 'security', title: 'B' }),
      ],
    });
    const shared = scripted({
      quality: [answer({ findings: [] })],
      judge: [answer(serious)],
      verify: [
        answer({ verdict: 'confirmed', reason: 'r' }, [200, 50]),
        answer({ verdict: 'confirmed', reason: 'r' }, [200, 50]),
      ],
    });
    await review(contextOf([change('src/cart.ts', 2)]), 10_000, shared.deps);
    expect(shared.calls.filter((c) => c.role === 'verify').map((c) => c.tokenBudget)).toEqual([
      500, 750,
    ]);

    // A review that has spent its whole budget verifies nothing, and says so.
    const spentAll = scripted({
      quality: [answer({ findings: [] })],
      judge: [answer(serious, [9_800, 200])],
    });
    const { outcome } = await review(contextOf([change('src/cart.ts', 2)]), 10_000, spentAll.deps);
    expect(spentAll.calls.map((c) => c.role)).toEqual(['quality', 'judge']);
    expect(outcome).toMatchObject({
      kind: 'reviewed',
      findings: [
        outcomeFinding({ category: 'security', title: 'A' }),
        outcomeFinding({ category: 'security', title: 'B' }),
      ],
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
      [{ quality: [stopped()] }, ['quality']],
      [{ quality: [prose('No JSON.'), stopped()] }, ['quality', 'quality']],
      [{ quality: [answer({ findings: [] })], tests: [stopped()] }, ['quality', 'tests']],
      [
        {
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          security: [answer({ findings: [] })],
          judge: [stopped()],
        },
        ['quality', 'tests', 'security', 'judge'],
      ],
      [
        {
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          security: [answer({ findings: [] })],
          judge: [answer(serious)],
          verify: [stopped()],
        },
        ['quality', 'tests', 'security', 'judge', 'verify'],
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
      [{ quality: [failed('provider_no_tools')] }, 'provider_no_tools', ['quality']],
      [
        { quality: [answer({ findings: [] })], tests: [failed('provider_error')] },
        'provider_error',
        ['quality', 'tests'],
      ],
      [
        {
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          security: [answer({ findings: [] })],
          judge: [prose('No JSON.'), failed('provider_error')],
        },
        'provider_error',
        ['quality', 'tests', 'security', 'judge', 'judge'],
      ],
      [
        {
          quality: [answer({ findings: [] })],
          tests: [answer({ findings: [] })],
          security: [answer({ findings: [] })],
          judge: [answer(serious)],
          verify: [failed('provider_error')],
        },
        'provider_error',
        ['quality', 'tests', 'security', 'judge', 'verify'],
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
    const key = 'sk-test-0123456789abcdef';
    // The key as JSON escapes spell it: a parser reads it back.
    const escaped = [...key]
      .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    const quality = JSON.stringify({ findings: [found({ title: `Key ${key} in code` })] });
    const judge = JSON.stringify(
      judgeSays({ findings: [judgedAs({ body: 'Rotate KEY now.' })] }),
    ).replace('KEY', escaped);
    const { deps, calls } = scripted(
      {
        quality: [prose(quality)],
        judge: [prose(judge)],
      },
      key,
    );
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
    const prior = (id: string, status: 'open' | 'wont_fix') => ({
      id,
      category: 'logic' as const,
      severity: 'medium',
      status,
      path: 'src/cart.ts',
      line: 3,
      endLine: 3,
      title: `Prior ${id}`,
      body: 'The total skips the last item.',
      fingerprint: 'f'.repeat(32),
    });
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
    });
  });
});
