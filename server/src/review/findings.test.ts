import {
  contextHash,
  filelessHash,
  lineHash,
  normalizeSarif,
  REDACTED,
  type NormalizeOptions,
} from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { AiCategory } from '../db/schema';
import type { ReviewableChange } from './context';
import {
  fingerprintOf,
  matchPrior,
  matchPriors,
  MAX_FINDINGS_PER_REVIEW,
  placeFinding,
  planFindings,
  renderFinding,
  reviewScope,
  reviewSummary,
  reviewSummarySchema,
  type PlannedFinding,
} from './findings';
import type { PriorFinding } from './findings-query';
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

function prior(id: string, over: Partial<PriorFinding> = {}): PriorFinding {
  const base = {
    id,
    category: 'logic' as const,
    severity: 'medium',
    status: 'open' as const,
    path: 'src/a.ts',
    title: 'Total skips the last item',
    body: 'The loop stops one item early.',
    ...over,
    line: over.line ?? 12,
    endLine: over.endLine ?? over.line ?? 12,
  };
  return {
    ...base,
    fingerprint: over.fingerprint ?? fingerprintOf(base.category, base.path, base.title),
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
  summary: { verdict: 'One problem.', walkthrough: ['The cart.'] },
  tokenLimitReached: false,
  notes: [],
  ...over,
});

const verdict = (id: string, status: 'present' | 'fixed' | 'unclear') => ({
  id,
  status,
  reason: 'Because.',
});

describe('the scope of a review', () => {
  it("a first review's scope is the added lines and a re-review's the since ranges", () => {
    // A first review: the added lines, and the line after what was removed.
    const first = change('src/first.ts', { added: new Set([3, 4, 5, 9]), removalPoints: [7] });
    expect(reviewScope([first]).get('src/first.ts')).toEqual([
      [3, 5],
      [7, 7],
      [9, 9],
    ]);

    // A re-review: the lines changed since the last review, whatever the change added in all.
    const since = change('src/since.ts', {
      added: new Set(range(1, 50)),
      since: [
        [10, 12],
        [20, 20],
      ],
    });
    // A change with no ranges of its own counts all its added lines; one with none changed, none.
    const fresh = change('src/fresh.ts', { added: new Set([2, 3]), since: null });
    const unchanged = change('src/unchanged.ts', { added: new Set(range(1, 9)), since: [] });
    const scope = reviewScope([since, fresh, unchanged]);
    expect(scope.get('src/since.ts')).toEqual([
      [10, 12],
      [20, 20],
    ]);
    expect(scope.get('src/fresh.ts')).toEqual([[2, 3]]);
    expect(scope.get('src/unchanged.ts')).toEqual([]);
    expect([...scope.keys()]).toEqual(['src/since.ts', 'src/fresh.ts', 'src/unchanged.ts']);
  });

  it('puts the whole file in scope when the patch says nothing of its lines, on a first review', () => {
    const blind = change('src/blind.ts', {
      hasPatch: false,
      patchUsable: false,
      added: new Set(),
      lines: 30,
    });
    expect(reviewScope([blind]).get('src/blind.ts')).toEqual([[1, 30]]);
    expect(reviewScope([{ ...blind, lines: null }]).get('src/blind.ts')).toEqual([]);
  });
});

describe('placeFinding', () => {
  const ch = change('src/a.ts', { added: new Set(range(10, 20)) });
  const scope = reviewScope([ch]);
  const place = (line: number, endLine = line) =>
    placeFinding({ path: 'src/a.ts', line, endLine }, ch, scope);

  it('an out-of-scope new finding is dropped and an in-scope one kept', () => {
    // On the added lines, and up to three lines either side of them.
    expect(place(15).inScope).toBe(true);
    expect(place(7).inScope).toBe(true);
    expect(place(23).inScope).toBe(true);
    expect(place(6).inScope).toBe(false);
    expect(place(24).inScope).toBe(false);
    // A range is in scope when it meets the widened lines anywhere.
    expect(place(1, 7).inScope).toBe(true);
    expect(place(1, 6).inScope).toBe(false);
    expect(place(23, 90).inScope).toBe(true);
    expect(place(24, 90).inScope).toBe(false);
    expect(place(1, 90).inScope).toBe(true);
    // A file the review has no change of is out of scope, with nowhere to place a finding.
    expect(placeFinding({ path: 'src/a.ts', line: 15, endLine: 15 }, undefined, scope)).toEqual({
      inScope: false,
      anchorLine: null,
    });
  });

  it('judges a re-review by the lines changed since the last one', () => {
    const rereview = change('src/a.ts', { added: new Set(range(10, 40)), since: [[30, 32]] });
    const narrow = reviewScope([rereview]);
    const placeSince = (line: number) =>
      placeFinding({ path: 'src/a.ts', line, endLine: line }, rereview, narrow);
    expect(placeSince(15).inScope).toBe(false);
    expect(placeSince(26).inScope).toBe(false);
    expect(placeSince(27).inScope).toBe(true);
    expect(placeSince(35).inScope).toBe(true);
    expect(placeSince(36).inScope).toBe(false);
  });

  it('the anchor is the nearest added line within 3, inside the range first, else null', () => {
    const scattered = change('src/a.ts', { added: new Set([10, 11, 14, 30]) });
    const around = reviewScope([scattered]);
    const anchorOf = (line: number, endLine = line) =>
      placeFinding({ path: 'src/a.ts', line, endLine }, scattered, around);

    // On an added line: that line.
    expect(anchorOf(14).anchorLine).toBe(14);
    // Off the added lines: the nearest one, three lines away at most.
    expect(anchorOf(12).anchorLine).toBe(11);
    expect(anchorOf(16).anchorLine).toBe(14);
    expect(anchorOf(8).anchorLine).toBe(10);
    // Four lines from the nearest is too far.
    expect(anchorOf(17).anchorLine).toBe(14);
    expect(anchorOf(18)).toEqual({ inScope: false, anchorLine: null });

    const anchorIn = (added: number[], line: number, endLine = line) => {
      const ch2 = change('src/a.ts', { added: new Set(added) });
      return placeFinding({ path: 'src/a.ts', line, endLine }, ch2, reviewScope([ch2])).anchorLine;
    };
    // Equally near on both sides: the earlier line.
    expect(anchorIn([10, 14], 12)).toBe(10);
    // A line inside the range wins over a nearer line outside it.
    expect(anchorIn([8, 12], 9, 13)).toBe(12);
    // Of several inside the range, the first.
    expect(anchorIn([11, 13, 14], 10, 14)).toBe(11);
    expect(anchorIn([10, 11, 14, 30], 9, 13)).toBe(10);
  });

  it('is in scope but cannot be placed when no added line is within 3 of the finding', () => {
    // The lines changed since the last review are far from the lines the change adds.
    const apart = change('src/a.ts', { added: new Set([10, 11]), since: [[40, 42]] });
    const result = placeFinding(
      { path: 'src/a.ts', line: 38, endLine: 38 },
      apart,
      reviewScope([apart]),
    );
    expect(result).toEqual({ inScope: true, anchorLine: null });
  });

  it('is not slowed by a range of a billion lines', () => {
    const result = placeFinding({ path: 'src/a.ts', line: 5, endLine: 1_000_000_000 }, ch, scope);
    expect(result).toEqual({ inScope: true, anchorLine: 10 });
  });
});

describe('fingerprintOf', () => {
  const fp = (title: string, category: AiCategory = 'logic', path = 'src/a.ts') =>
    fingerprintOf(category, path, title);

  it('is 32 hex digits', () => {
    expect(fp('Total skips the last item')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not change with case, digits, code spans, punctuation or spacing', () => {
    const base = fp('Missing null check on `user`');
    for (const title of [
      'missing NULL check on `account.id`',
      '  Missing null-check on `user`.  ',
      'Missing null check on ``a`b``',
      'Missing null check on 3 `user`',
      'MISSING   NULL\tCHECK on `user`!',
    ]) {
      expect(fp(title), title).toBe(base);
    }
    expect(fp('Ünchecked résultat')).toBe(fp('ünchecked RÉSULTAT'));
    // The same letters composed or decomposed.
    expect(fp('caf\u00e9 not closed')).toBe(fp('cafe\u0301 not closed'));
  });

  it('changes with the words, the category and the path', () => {
    const base = fp('Missing null check on `user`');
    expect(fp('Missing null check on user')).not.toBe(base);
    expect(fp('Missing null check on `user`', 'security')).not.toBe(base);
    expect(fp('Missing null check on `user`', 'logic', 'src/b.ts')).not.toBe(base);
    expect(fp('Missing range check on `user`')).not.toBe(base);
  });

  it('removes the digits of a word, it does not split the word', () => {
    expect(fp('foo2bar problem')).toBe(fp('foobar problem'));
    expect(fp('foo2bar problem')).not.toBe(fp('foo bar problem'));
  });

  it('keeps titles of nothing but code and digits apart', () => {
    expect(fp('`foo()`')).not.toBe(fp('`bar()`'));
    expect(fp('404')).not.toBe(fp('500'));
    expect(fp('`foo()`')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('matchPrior', () => {
  it('a judge priorId keeps the issue and a forged one is ignored', () => {
    const p1 = prior('p1', { line: 10 });
    const p2 = prior('p2', { line: 90, title: 'Another problem entirely' });
    // The id wins, whatever the finding says: another place, another title.
    const moved = judged({ priorId: 'p2', line: 12, title: 'Total skips the last item' });
    expect(matchPrior(moved, [p1, p2])).toBe(p2);
    // An id that names none of the prior findings is ignored: the rest of the rule decides.
    const forged = judged({ priorId: 'not-a-prior', line: 12 });
    expect(matchPrior(forged, [p1, p2])).toBe(p1);
    expect(
      matchPrior(judged({ priorId: 'not-a-prior', line: 60, title: 'Nothing like it' }), [p1, p2]),
    ).toBeNull();
    expect(
      matchPrior(judged({ priorId: null, line: 60, title: 'Nothing like it' }), []),
    ).toBeNull();
  });

  it('fingerprint and proximity match a re-worded finding', () => {
    const p = prior('p', { line: 10, title: 'Missing null check on `user`' });
    const reworded = (over: Partial<JudgedFinding>) =>
      judged({ title: 'missing NULL check on `account` (2)', ...over });
    expect(matchPrior(reworded({ line: 10 }), [p])).toBe(p);
    expect(matchPrior(reworded({ line: 30 }), [p])).toBe(p);
    expect(matchPrior(reworded({ line: 31 }), [p])).toBeNull();
    expect(matchPrior(reworded({ line: 1 }), [p])).toBe(p);
    // The same rule, the same path and the same words: all three.
    expect(matchPrior(reworded({ line: 10, category: 'security' }), [p])).toBeNull();
    expect(matchPrior(reworded({ line: 10, path: 'src/b.ts' }), [p])).toBeNull();
    expect(matchPrior(reworded({ line: 10, title: 'Missing range check' }), [p])).toBeNull();
    // A prior finding whose stored fingerprint is not of the same words does not match them.
    const other = prior('other', { line: 10, fingerprint: 'f'.repeat(32) });
    expect(matchPrior(reworded({ line: 10 }), [other])).toBeNull();
  });

  it('needs the same rule and the same path as well as the same words', () => {
    // Prior findings whose stored fingerprint is the finding's, but of another rule or path.
    const words = fingerprintOf('logic', 'src/a.ts', 'Total skips the last item');
    const otherRule = prior('other-rule', { category: 'security', fingerprint: words });
    const otherPath = prior('other-path', { path: 'src/b.ts', fingerprint: words });
    expect(matchPrior(judged({ line: 12 }), [otherRule, otherPath])).toBeNull();
    const same = prior('same', { fingerprint: words });
    expect(matchPrior(judged({ line: 12 }), [otherRule, otherPath, same])).toBe(same);
  });

  it('takes the nearest of several, an open one before a dismissed one, then the first line', () => {
    const near = prior('near', { line: 18 });
    const far = prior('far', { line: 5 });
    expect(matchPrior(judged({ line: 17 }), [far, near])).toBe(near);
    const dismissed = prior('dismissed', { line: 14, status: 'wont_fix' });
    const open = prior('open', { line: 10 });
    expect(matchPrior(judged({ line: 12 }), [dismissed, open])).toBe(open);
    expect(matchPrior(judged({ line: 13 }), [dismissed, open])).toBe(dismissed);
    const early = prior('early', { line: 10 });
    const late = prior('late', { line: 14 });
    expect(matchPrior(judged({ line: 12 }), [late, early])).toBe(early);
  });
});

describe('matchPriors', () => {
  it('gives each open prior finding to one finding: a claim by id first, then the nearest', () => {
    const a = prior('a', { line: 10 });
    const b = prior('b', { line: 14 });
    // Both findings claim a; the first has it, and the second takes what its words and place say.
    const claims = [judged({ priorId: 'a', line: 13 }), judged({ priorId: 'a', line: 13 })];
    expect(matchPriors(claims, [a, b])).toEqual([a, b]);
    // A claim is kept for the finding that makes it, whatever finds the prior nearer.
    const stolen = [judged({ line: 10 }), judged({ priorId: 'a', line: 30 })];
    expect(matchPriors(stolen, [a, b])).toEqual([b, a]);
  });

  it('pairs findings and prior findings of the same words by distance, not by order', () => {
    const near10 = prior('p10', { line: 10 });
    const near18 = prior('p18', { line: 18 });
    // Whichever comes first in the list, each finding is paired with the prior it is nearest.
    const at17 = judged({ line: 17 });
    const at11 = judged({ line: 11 });
    expect(matchPriors([at17, at11], [near10, near18])).toEqual([near18, near10]);
    expect(matchPriors([at11, at17], [near10, near18])).toEqual([near10, near18]);
    // Two findings of one prior: the nearer has it, the other is new.
    expect(matchPriors([judged({ line: 15 }), judged({ line: 11 })], [near10])).toEqual([
      null,
      near10,
    ]);
  });

  it('gives a prior finding that two findings are equally near to the one the judge listed first', () => {
    const p = prior('p', { line: 10 });
    expect(matchPriors([judged({ line: 8 }), judged({ line: 12 })], [p])).toEqual([p, null]);
    expect(matchPriors([judged({ line: 12 }), judged({ line: 8 })], [p])).toEqual([p, null]);
  });

  it('lets a dismissed prior finding take any number of findings', () => {
    const gone = prior('gone', { line: 10, status: 'false_positive' });
    expect(matchPriors([judged({ line: 10 }), judged({ line: 12 })], [gone])).toEqual([gone, gone]);
    expect(matchPriors([judged({ priorId: 'gone' }), judged({ priorId: 'gone' })], [gone])).toEqual(
      [gone, gone],
    );
  });
});

describe('planFindings', () => {
  const reviewed = [change('src/a.ts', { added: new Set(range(10, 20)) })];
  const plan = (
    outcome: Partial<Reviewed>,
    priors: PriorFinding[] = [],
    changes: ReviewableChange[] = reviewed,
  ) => planFindings({ reviewed: changes, prior: priors }, outcomeOf(outcome));

  it('an out-of-scope new finding is dropped and an in-scope one kept', () => {
    const inside = judged({ title: 'Inside', line: 12 });
    const near = judged({ title: 'Near', line: 23, endLine: 23 });
    const far = judged({ title: 'Far', line: 60, endLine: 61 });
    const elsewhere = judged({ title: 'Elsewhere', path: 'src/other.ts' });
    const result = plan({ findings: [far, inside, elsewhere, near] });
    expect(result.creates.map((c) => c.finding.title)).toEqual(['Inside', 'Near']);
    expect(result.creates.map((c) => c.anchorLine)).toEqual([12, 20]);
    expect(result.dropped.map((d) => [d.finding.title, d.why])).toEqual([
      ['Far', 'out_of_scope'],
      ['Elsewhere', 'out_of_scope'],
    ]);
    expect(result.updates).toEqual([]);
  });

  it('keeps a finding in scope that no added line is near, with no anchor', () => {
    const apart = [change('src/a.ts', { added: new Set([10, 11]), since: [[40, 42]] })];
    const result = plan({ findings: [judged({ line: 38, endLine: 38 })] }, [], apart);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]?.anchorLine).toBeNull();
  });

  it('never stores a finding of low confidence, and at most 40 of the rest', () => {
    const low = judged({ title: 'Doubtful', confidence: 'low' });
    const many = range(1, MAX_FINDINGS_PER_REVIEW + 5).map((n) =>
      judged({
        title: `Problem number ${String.fromCharCode(97 + (n % 26))}${'x'.repeat(n)}`,
        line: 15,
      }),
    );
    const result = plan({ findings: [low, ...many] });
    expect(MAX_FINDINGS_PER_REVIEW).toBe(40);
    expect(result.creates).toHaveLength(40);
    expect(result.creates[0]?.finding.title).toBe(many[0]?.title);
    expect(result.dropped.map((d) => d.why)).toEqual([
      'low_confidence',
      ...Array.from({ length: 5 }, () => 'over_limit'),
    ]);
  });

  it('holds the lines of a finding to the file, and drops one that is not on it', () => {
    const result = plan({
      findings: [
        judged({ title: 'Past the end', line: 18, endLine: 5_000_000 }),
        judged({ title: 'Off the file', line: 101, endLine: 101 }),
        judged({ title: 'Absurd', line: 3_000_000_000, endLine: 3_000_000_001 }),
        judged({ title: 'Before the file', line: 0, endLine: 0 }),
        judged({ title: 'Negative', line: -3, endLine: 4 }),
      ],
    });
    expect(result.creates.map((c) => [c.finding.line, c.finding.endLine])).toEqual([[18, 100]]);
    expect(result.dropped.map((d) => [d.finding.title, d.why])).toEqual([
      ['Off the file', 'bad_lines'],
      ['Absurd', 'bad_lines'],
      ['Before the file', 'bad_lines'],
      ['Negative', 'bad_lines'],
    ]);
    // A file whose length is not known: held to what a line number can be.
    const unknown = [change('src/a.ts', { lines: null })];
    const open = plan({ findings: [judged({ line: 18, endLine: 9_000_000_000 })] }, [], unknown);
    expect(open.creates.map((c) => [c.finding.line, c.finding.endLine])).toEqual([
      [18, 2_147_483_647],
    ]);
  });

  it('a finding matching a dismissed issue is dropped', () => {
    const falsePositive = prior('fp', { status: 'false_positive', line: 12 });
    const wontFix = prior('wf', { status: 'wont_fix', line: 40, title: 'Other problem' });
    const result = plan(
      {
        findings: [
          // By the judge's id, and by the words and the place.
          judged({ title: 'Anything at all', priorId: 'wf', line: 15 }),
          judged({ title: 'total skips the LAST item', line: 14 }),
          judged({ title: 'Something new', line: 16 }),
        ],
        shownPriorIds: ['fp', 'wf'],
      },
      [falsePositive, wontFix],
    );
    expect(result.dropped.map((d) => [d.finding.title, d.why])).toEqual([
      ['Anything at all', 'dismissed'],
      ['total skips the LAST item', 'dismissed'],
    ]);
    expect(result.creates.map((c) => c.finding.title)).toEqual(['Something new']);
    // A dismissed issue is neither updated nor closed, and does not count as left out.
    expect(result.updates).toEqual([]);
    expect(result.closes).toEqual([]);
  });

  it('a re-emitted prior finding is updated wherever it is, and stays open whatever the judge says', () => {
    const p = prior('p', { line: 60, title: 'Old words for the problem' });
    const result = plan(
      {
        // Out of scope, and the judge also says it is fixed: it is in the findings, so it stays.
        findings: [judged({ priorId: 'p', line: 61, title: 'New words for the problem' })],
        prior: [verdict('p', 'fixed')],
        shownPriorIds: ['p'],
      },
      [p],
    );
    expect(
      result.updates.map((u) => [u.prior.id, u.found.finding.title, u.found.anchorLine]),
    ).toEqual([['p', 'New words for the problem', null]]);
    expect(result.creates).toEqual([]);
    expect(result.closes).toEqual([]);
    expect(result.keeps).toEqual([]);
  });

  it('two findings of one prior: the first updates it and the second is judged as new', () => {
    const p = prior('p', { line: 12 });
    const result = plan(
      {
        findings: [
          judged({ title: 'First words', priorId: 'p', line: 12 }),
          judged({ title: 'Second words', priorId: 'p', line: 14 }),
        ],
        shownPriorIds: ['p'],
      },
      [p],
    );
    expect(result.updates.map((u) => u.found.finding.title)).toEqual(['First words']);
    expect(result.creates.map((c) => c.finding.title)).toEqual(['Second words']);
  });

  it('a fixed prior is closed, and a present one not re-emitted stays open', () => {
    const fixed = prior('fixed', { line: 14, title: 'Fixed problem' });
    const present = prior('present', { line: 15, title: 'Present problem' });
    const result = plan(
      {
        prior: [verdict('fixed', 'fixed'), verdict('present', 'present')],
        shownPriorIds: ['fixed', 'present'],
      },
      [fixed, present],
    );
    expect(result.closes.map((c) => [c.prior.id, c.why])).toEqual([['fixed', 'fixed']]);
    expect(result.keeps.map((p2) => p2.id)).toEqual(['present']);
    // A verdict on a prior finding that does not exist, or that nobody has open, changes nothing.
    const dismissed = prior('dismissed', { status: 'wont_fix', title: 'Dismissed problem' });
    const ignored = plan(
      {
        prior: [verdict('nobody', 'fixed'), verdict('dismissed', 'fixed')],
        shownPriorIds: ['dismissed'],
      },
      [dismissed],
    );
    expect(ignored.closes).toEqual([]);
    expect(ignored.keeps).toEqual([]);
  });

  it('an omitted prior on changed lines is closed, on unchanged lines left open', () => {
    const changed = prior('changed', { line: 12, endLine: 13, title: 'Changed problem' });
    const nearby = prior('nearby', { line: 23, title: 'Nearby problem' });
    const unchanged = prior('unchanged', { line: 60, title: 'Unchanged problem' });
    const everything = ['changed', 'nearby', 'unchanged'];
    // The judge shows no verdict for a prior finding it left out; one it could not tell is the same.
    const omitted = plan({ shownPriorIds: everything }, [changed, nearby, unchanged]);
    expect(omitted.closes.map((c) => [c.prior.id, c.why])).toEqual([
      ['changed', 'left_out'],
      ['nearby', 'left_out'],
    ]);
    const unclear = plan(
      { prior: everything.map((id) => verdict(id, 'unclear')), shownPriorIds: everything },
      [changed, nearby, unchanged],
    );
    expect(unclear.closes.map((c) => c.prior.id)).toEqual(['changed', 'nearby']);
    // A prior finding the judge was not shown is not left out by it.
    const unshown = plan({ shownPriorIds: ['unchanged'] }, [changed, nearby, unchanged]);
    expect(unshown.closes).toEqual([]);
    // Four lines from the changed lines is too far.
    const far = prior('far', { line: 24, title: 'Far problem' });
    expect(plan({ shownPriorIds: ['far'] }, [far]).closes).toEqual([]);
  });

  it('judges the lines a re-review changed, not the lines the change added in all', () => {
    const rereview = [change('src/a.ts', { added: new Set(range(10, 40)), since: [[30, 32]] })];
    const early = prior('early', { line: 12, title: 'Early problem' });
    const late = prior('late', { line: 31, title: 'Late problem' });
    const result = plan({ shownPriorIds: ['early', 'late'] }, [early, late], rereview);
    expect(result.closes.map((c) => c.prior.id)).toEqual(['late']);
  });

  it('closes a prior finding left out whose file the merge request deleted, wherever it was', () => {
    const gone = [
      change('src/a.ts', { status: 'deleted', lines: null, added: new Set(), unshown: 'deleted' }),
    ];
    const p = prior('p', { line: 60 });
    const result = plan({ shownPriorIds: ['p'] }, [p], gone);
    expect(result.closes.map((c) => [c.prior.id, c.why])).toEqual([['p', 'deleted']]);
    // A prior finding on a file the merge request no longer changes is left as it is.
    expect(plan({ shownPriorIds: ['p'] }, [p], []).closes).toEqual([]);
  });

  it('reads the first verdict the judge gave of a prior finding', () => {
    const p = prior('p', { line: 14 });
    const result = plan(
      { prior: [verdict('p', 'present'), verdict('p', 'fixed')], shownPriorIds: ['p'] },
      [p],
    );
    expect(result.keeps.map((k) => k.id)).toEqual(['p']);
    expect(result.closes).toEqual([]);
    const other = plan(
      { prior: [verdict('p', 'fixed'), verdict('p', 'present')], shownPriorIds: ['p'] },
      [p],
    );
    expect(other.closes.map((c) => c.prior.id)).toEqual(['p']);
    expect(other.keeps).toEqual([]);
  });

  it('drops a finding in a file the review knows nothing of, also one that names a prior finding', () => {
    const p = prior('p', { line: 14 });
    const result = plan(
      {
        findings: [judged({ priorId: 'p', path: 'src/bogus.ts', line: 14, title: 'Elsewhere' })],
        shownPriorIds: ['p'],
      },
      [p],
    );
    expect(result.updates).toEqual([]);
    expect(result.creates).toEqual([]);
    expect(result.dropped.map((d) => [d.finding.path, d.why])).toEqual([
      ['src/bogus.ts', 'out_of_scope'],
    ]);
    // The prior finding is then one the judge left out, and its lines changed.
    expect(result.closes.map((c) => [c.prior.id, c.why])).toEqual([['p', 'left_out']]);

    // A file the review has no change of but an earlier finding is in: the judge may raise it again.
    const gone = prior('gone', { path: 'src/left-the-mr.ts', line: 5 });
    const again = plan(
      {
        findings: [
          judged({ priorId: 'gone', path: 'src/left-the-mr.ts', line: 5, title: 'Again' }),
        ],
        shownPriorIds: ['gone'],
      },
      [gone],
    );
    expect(again.updates.map((u) => [u.prior.id, u.found.anchorLine])).toEqual([['gone', null]]);
    expect(again.dropped).toEqual([]);
  });

  it('plans nothing for an empty review', () => {
    expect(plan({})).toEqual({ creates: [], updates: [], keeps: [], closes: [], dropped: [] });
  });
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
