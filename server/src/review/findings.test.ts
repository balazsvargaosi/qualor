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
  reviewScope,
} from './findings';
import type { PriorFinding } from './findings-query';
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
  namedPriorIds: [],
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

  it('a judge priorId names an issue in another file only for a rename', () => {
    const p = prior('p', { path: 'src/a.ts', line: 10 });
    const elsewhere = judged({ priorId: 'p', path: 'src/b.ts', line: 10 });
    // Not a rename: the id is not followed, and by its words the finding is another file's.
    expect(matchPrior(elsewhere, [p])).toBeNull();
    expect(matchPrior(elsewhere, [p], new Map([['src/c.ts', 'src/a.ts']]))).toBeNull();
    expect(matchPrior(elsewhere, [p], new Map([['src/b.ts', 'src/c.ts']]))).toBeNull();
    // src/b.ts is src/a.ts renamed.
    const renamed = new Map([['src/b.ts', 'src/a.ts']]);
    expect(matchPrior(elsewhere, [p], renamed)).toBe(p);
    // The judge may still call the file by the name the prior finding has, which is its own.
    const old = judged({ priorId: 'p', path: 'src/a.ts', line: 90, title: 'Anything' });
    expect(matchPrior(old, [p], renamed)).toBe(p);
  });

  it('a finding in a renamed file is the earlier finding of the file under its old name', () => {
    const title = 'Problem in a renamed file';
    const renamed = new Map([['src/new.ts', 'src/old.ts']]);
    const old = prior('old', { path: 'src/old.ts', line: 14, title });
    const finding = judged({ path: 'src/new.ts', line: 15, title });
    // Not known to be a rename: another file's finding.
    expect(matchPrior(finding, [old])).toBeNull();
    expect(matchPrior(finding, [old], renamed)).toBe(old);
    // The rule, the words and the place are needed as ever, and the file must be the one renamed.
    expect(matchPrior({ ...finding, category: 'security' }, [old], renamed)).toBeNull();
    expect(matchPrior({ ...finding, title: 'Something else' }, [old], renamed)).toBeNull();
    expect(matchPrior({ ...finding, line: 40 }, [old], renamed)).toBeNull();
    expect(matchPrior(finding, [old], new Map([['src/new.ts', 'src/other.ts']]))).toBeNull();
    expect(matchPrior({ ...finding, path: 'src/other.ts' }, [old], renamed)).toBeNull();
    // The fingerprint an earlier finding has is the one of its own file.
    const stale = prior('stale', {
      path: 'src/old.ts',
      line: 14,
      title,
      fingerprint: fingerprintOf('logic', 'src/new.ts', title),
    });
    expect(matchPrior(finding, [stale], renamed)).toBeNull();
    // A dismissal of the old file holds in the new one, for the same code.
    const gone = prior('gone', {
      path: 'src/old.ts',
      status: 'wont_fix',
      line: 14,
      title: 'Check `user`',
    });
    expect(matchPrior({ ...finding, title: 'check `user`' }, [gone], renamed)).toBe(gone);
    expect(matchPrior({ ...finding, title: 'check `order`' }, [gone], renamed)).toBeNull();
    // An earlier finding in the file under its own name is the finding's too, with or without it.
    const own = prior('own', { path: 'src/new.ts', line: 14, title });
    expect(matchPrior(finding, [own])).toBe(own);
    expect(matchPrior(finding, [own], renamed)).toBe(own);
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

  it('a dismissed prior finding is a finding by its id, or by its words and the code in them', () => {
    const gone = prior('gone', {
      status: 'wont_fix',
      line: 10,
      title: 'Missing null check on `user`',
    });
    const finding = (title: string, over: Partial<JudgedFinding> = {}) =>
      judged({ title, line: 12, ...over });
    // The same code, in other words around it.
    expect(matchPrior(finding('missing NULL check on `user`'), [gone])).toBe(gone);
    // Other code, none, or more: another finding, which a dismissal does not cover.
    expect(matchPrior(finding('Missing null check on `order`'), [gone])).toBeNull();
    expect(matchPrior(finding('Missing null check on'), [gone])).toBeNull();
    expect(matchPrior(finding('Missing null check on `user`, `order`'), [gone])).toBeNull();
    // The order of the code and its repeats do not matter.
    const swap = prior('swap', { status: 'false_positive', line: 10, title: 'Swap `a` and `b`' });
    expect(matchPrior(finding('swap `b`, `a` and `b`'), [swap])).toBe(swap);
    // The space inside a code span is not code, and naming only some of the code is another finding.
    expect(matchPrior(finding('swap `  b `, `a` and `b`'), [swap])).toBe(swap);
    const pair = prior('pair', { status: 'wont_fix', line: 10, title: 'Mix `a` and `b`' });
    expect(matchPrior(finding('Mix `a` and'), [pair])).toBeNull();
    // The judge's own id still names it.
    expect(matchPrior(finding('Anything', { priorId: 'gone', line: 90 }), [gone])).toBe(gone);
    // An open prior finding does not need the same code: a re-worded finding is still it.
    const open = prior('open', { line: 10, title: 'Missing null check on `user`' });
    expect(matchPrior(finding('Missing null check on `order`'), [open])).toBe(open);
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

  it('gives a dismissed prior finding to one finding, as an open one', () => {
    const gone = prior('gone', { line: 10, status: 'false_positive' });
    expect(matchPriors([judged({ line: 10 }), judged({ line: 12 })], [gone])).toEqual([gone, null]);
    expect(matchPriors([judged({ priorId: 'gone' }), judged({ priorId: 'gone' })], [gone])).toEqual(
      [gone, null],
    );
  });

  it('follows a claim into another file only for a rename', () => {
    const p = prior('p', { path: 'src/a.ts' });
    const claim = judged({ priorId: 'p', path: 'src/b.ts', title: 'Another problem' });
    expect(matchPriors([claim], [p])).toEqual([null]);
    expect(matchPriors([claim], [p], new Map([['src/b.ts', 'src/a.ts']]))).toEqual([p]);
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
    expect(result.keeps).toEqual([]);
  });

  it('a dismissal covers one finding, and not the same words around other code', () => {
    const dismissed = prior('fp', { status: 'false_positive', line: 12 });
    const twice = plan(
      {
        findings: [
          judged({ title: 'Total skips the last item', line: 12 }),
          judged({ title: 'Total skips the last item!', line: 14 }),
        ],
      },
      [dismissed],
    );
    expect(twice.dropped.map((d) => [d.finding.line, d.why])).toEqual([[12, 'dismissed']]);
    expect(twice.creates.map((c) => c.finding.line)).toEqual([14]);

    const user = prior('user', {
      status: 'wont_fix',
      line: 12,
      title: 'Missing null check on `user`',
    });
    const other = plan(
      { findings: [judged({ title: 'Missing null check on `order`', line: 14 })] },
      [user],
    );
    expect(other.dropped).toEqual([]);
    expect(other.creates.map((c) => c.finding.title)).toEqual(['Missing null check on `order`']);
  });

  it('a re-emitted prior finding is updated and stays open whatever the judge says of it', () => {
    const p = prior('p', { line: 14, title: 'Old words for the problem' });
    const result = plan(
      {
        // The judge also says it is fixed: it is in the findings, so it stays.
        findings: [judged({ priorId: 'p', line: 15, title: 'New words for the problem' })],
        prior: [verdict('p', 'fixed')],
        shownPriorIds: ['p'],
      },
      [p],
    );
    expect(
      result.updates.map((u) => [u.prior.id, u.found.finding.title, u.found.anchorLine]),
    ).toEqual([['p', 'New words for the problem', 15]]);
    expect(result.creates).toEqual([]);
    expect(result.closes).toEqual([]);
    expect(result.keeps).toEqual([]);
  });

  it('a prior finding raised again where it cannot be placed is kept as it is', () => {
    const p = prior('p', { line: 60, title: 'Old words for the problem' });
    const result = plan(
      {
        // No added line is near line 61: nothing of the new finding would fit its old anchor.
        findings: [judged({ priorId: 'p', line: 61, title: 'New words for the problem' })],
        prior: [verdict('p', 'fixed')],
        shownPriorIds: ['p'],
      },
      [p],
    );
    expect(result.keeps.map((k) => k.id)).toEqual(['p']);
    expect(result.updates).toEqual([]);
    expect(result.closes).toEqual([]);
    expect(result.creates).toEqual([]);
    expect(result.dropped).toEqual([]);
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

  it('an omitted or unclear prior is left open, on changed lines or not: only a fix or a deleted file closes it', () => {
    const changed = prior('changed', { line: 12, endLine: 13, title: 'Changed problem' });
    const nearby = prior('nearby', { line: 23, title: 'Nearby problem' });
    const unchanged = prior('unchanged', { line: 60, title: 'Unchanged problem' });
    const everything = ['changed', 'nearby', 'unchanged'];
    const priors = [changed, nearby, unchanged];
    // The judge gives no verdict for a prior finding it left out; one it could not tell is the same.
    const omitted = plan({ shownPriorIds: everything }, priors);
    expect(omitted.closes).toEqual([]);
    expect(omitted.keeps).toEqual([]);
    const unclear = plan(
      { prior: everything.map((id) => verdict(id, 'unclear')), shownPriorIds: everything },
      priors,
    );
    expect(unclear.closes).toEqual([]);
    // The lines of a prior finding come from an older head than the lines changed since the last
    // review: the same on a re-review.
    const rereview = [change('src/a.ts', { added: new Set(range(10, 40)), since: [[11, 14]] })];
    expect(plan({ shownPriorIds: everything }, priors, rereview).closes).toEqual([]);
    // A fix the judge reports does close one.
    const fixed = plan({ prior: [verdict('changed', 'fixed')], shownPriorIds: everything }, priors);
    expect(fixed.closes.map((c) => [c.prior.id, c.why])).toEqual([['changed', 'fixed']]);
  });

  it('closes a prior finding left out whose file the merge request deleted, wherever it was', () => {
    const gone = [
      change('src/a.ts', { status: 'deleted', lines: null, added: new Set(), unshown: 'deleted' }),
    ];
    const p = prior('p', { line: 60 });
    const result = plan({ shownPriorIds: ['p'] }, [p], gone);
    expect(result.closes.map((c) => [c.prior.id, c.why])).toEqual([['p', 'deleted']]);
    // One the judge was not shown is left as it is, and so is one on a file nobody deleted.
    expect(plan({ shownPriorIds: [] }, [p], gone).closes).toEqual([]);
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

  it('a prior finding named by a finding the plan drops stays open, whatever the judge says of it', () => {
    const p = prior('p', { line: 14 });
    const filler = range(1, MAX_FINDINGS_PER_REVIEW).map((n) =>
      judged({ title: `Filler ${'x'.repeat(n)}`, line: 15 }),
    );
    const cases: [string, JudgedFinding[], string][] = [
      // A file the review knows nothing of.
      ['bogus path', [judged({ priorId: 'p', path: 'src/bogus.ts', line: 14 })], 'out_of_scope'],
      // The judge copied a stale line, and the push shortened the file.
      ['stale line', [judged({ priorId: 'p', line: 500, endLine: 500 })], 'bad_lines'],
      ['low confidence', [judged({ priorId: 'p', confidence: 'low' })], 'low_confidence'],
      // The 41st finding of a hand-made outcome.
      ['over the limit', [...filler, judged({ priorId: 'p', title: 'Last' })], 'over_limit'],
    ];
    for (const [label, findings, why] of cases) {
      const result = plan({ findings, prior: [verdict('p', 'fixed')], shownPriorIds: ['p'] }, [p]);
      expect(
        result.dropped.map((d) => d.why).filter((w) => w === why),
        label,
      ).toHaveLength(1);
      expect(
        result.keeps.map((k) => k.id),
        label,
      ).toEqual(['p']);
      expect(result.closes, label).toEqual([]);
      expect(result.updates, label).toEqual([]);
    }
  });

  it('a prior finding named in another file is kept, and the finding is judged as its own', () => {
    const p = prior('p', { path: 'src/a.ts', line: 14 });
    const two = [change('src/a.ts'), change('src/b.ts')];
    const result = plan(
      {
        findings: [judged({ priorId: 'p', path: 'src/b.ts', line: 14, title: 'Another problem' })],
        prior: [verdict('p', 'fixed')],
        shownPriorIds: ['p'],
      },
      [p],
      two,
    );
    expect(result.creates.map((c) => [c.finding.path, c.finding.title])).toEqual([
      ['src/b.ts', 'Another problem'],
    ]);
    expect(result.updates).toEqual([]);
    expect(result.keeps.map((k) => k.id)).toEqual(['p']);
    expect(result.closes).toEqual([]);
  });

  it('looks a change up by the path a renamed file had, and stores the path it has', () => {
    const renamed = [
      change('src/new.ts', { oldPath: 'src/old.ts', status: 'renamed', lines: 100 }),
    ];
    const title = 'Problem in a renamed file';
    const p = prior('p', { path: 'src/old.ts', line: 14, title });
    const updated = (result: ReturnType<typeof plan>) =>
      result.updates.map((u) => [u.prior.id, u.found.finding.path, u.found.anchorLine]);

    // The judge names the prior finding with the old name of the file, or with the new one.
    const old = plan(
      {
        findings: [judged({ priorId: 'p', path: 'src/old.ts', line: 15, title })],
        shownPriorIds: ['p'],
      },
      [p],
      renamed,
    );
    expect(updated(old)).toEqual([['p', 'src/new.ts', 15]]);
    const named = plan(
      {
        findings: [judged({ priorId: 'p', path: 'src/new.ts', line: 15, title })],
        shownPriorIds: ['p'],
      },
      [p],
      renamed,
    );
    expect(updated(named)).toEqual([['p', 'src/new.ts', 15]]);
    // With no id, the old name and the same words are the prior finding.
    const byWords = plan(
      { findings: [judged({ path: 'src/old.ts', line: 15, title })], shownPriorIds: ['p'] },
      [p],
      renamed,
    );
    expect(updated(byWords)).toEqual([['p', 'src/new.ts', 15]]);
    // A new finding that uses the old name is a finding in the renamed file.
    const created = plan(
      { findings: [judged({ path: 'src/old.ts', line: 15, title: 'Something else' })] },
      [],
      renamed,
    );
    expect(created.creates.map((c) => [c.finding.path, c.change?.path])).toEqual([
      ['src/new.ts', 'src/new.ts'],
    ]);
    // A prior finding in a renamed file the judge leaves out is not closed: the file is there.
    expect(plan({ shownPriorIds: ['p'] }, [p], renamed).closes).toEqual([]);
  });

  it('a path that is a file of the review is that file, though another file was renamed from it', () => {
    const files = [
      change('src/a.ts', { status: 'added' }),
      change('src/b.ts', { oldPath: 'src/a.ts', status: 'renamed' }),
    ];
    const result = plan(
      { findings: [judged({ path: 'src/a.ts', line: 15, title: 'In the new file' })] },
      [],
      files,
    );
    expect(result.creates.map((c) => [c.finding.path, c.change?.path])).toEqual([
      ['src/a.ts', 'src/a.ts'],
    ]);
  });

  it('puts the whole file in scope for a new finding, and closes no prior finding for it', () => {
    const blind = [
      change('src/a.ts', { hasPatch: false, patchUsable: false, added: new Set(), lines: 100 }),
    ];
    const early = prior('early', { line: 60, title: 'Early problem' });
    const result = plan(
      { findings: [judged({ title: 'New', line: 50, endLine: 50 })], shownPriorIds: ['early'] },
      [early],
      blind,
    );
    expect(result.creates.map((c) => [c.finding.title, c.anchorLine])).toEqual([['New', null]]);
    expect(result.closes).toEqual([]);
    expect(result.keeps).toEqual([]);
  });

  it('a finding that uses the old name of a renamed file is the earlier finding already on the new name', () => {
    const renamed = [change('src/new.ts', { oldPath: 'src/old.ts', status: 'renamed' })];
    const title = 'Problem in a renamed file';
    // An earlier review has moved the issue to the new name; the judge still uses the old one.
    const p = prior('p', { path: 'src/new.ts', line: 14, title });
    const byId = plan(
      {
        findings: [judged({ priorId: 'p', path: 'src/old.ts', line: 15, title })],
        shownPriorIds: ['p'],
      },
      [p],
      renamed,
    );
    const byWords = plan(
      { findings: [judged({ path: 'src/old.ts', line: 15, title })], shownPriorIds: ['p'] },
      [p],
      renamed,
    );
    for (const [label, result] of [
      ['by its id', byId],
      ['by its words', byWords],
    ] as const) {
      // One update, and no second issue for the same finding.
      expect(
        result.updates.map((u) => [u.prior.id, u.found.finding.path, u.found.anchorLine]),
        label,
      ).toEqual([['p', 'src/new.ts', 15]]);
      expect(result.creates, label).toEqual([]);
      expect(result.keeps, label).toEqual([]);
      expect(result.closes, label).toEqual([]);
      expect(result.dropped, label).toEqual([]);
    }
  });

  it('a finding in the new name of a renamed file, with no id, is the earlier finding of the old name', () => {
    const renamed = [change('src/new.ts', { oldPath: 'src/old.ts', status: 'renamed' })];
    const title = 'Problem in a renamed file';
    const p = prior('p', { path: 'src/old.ts', line: 14, title });
    const result = plan(
      { findings: [judged({ path: 'src/new.ts', line: 15, title })], shownPriorIds: ['p'] },
      [p],
      renamed,
    );
    // It moves the issue to the new name, and raises no second one.
    expect(
      result.updates.map((u) => [u.prior.id, u.found.finding.path, u.found.anchorLine]),
    ).toEqual([['p', 'src/new.ts', 15]]);
    expect(result.creates).toEqual([]);
    expect(result.keeps).toEqual([]);
    expect(result.closes).toEqual([]);
    expect(result.dropped).toEqual([]);

    // What a person dismissed in the old name is not raised again in the new one.
    const gone = prior('gone', {
      path: 'src/old.ts',
      status: 'wont_fix',
      line: 14,
      title: 'Check `user`',
    });
    const again = plan(
      { findings: [judged({ path: 'src/new.ts', line: 15, title: 'Check `user`' })] },
      [gone],
      renamed,
    );
    expect(again.dropped.map((d) => d.why)).toEqual(['dismissed']);
    expect(again.creates).toEqual([]);
  });

  it('takes the old path of a file only where the merge request renamed it', () => {
    const title = 'Problem in another file';
    const p = prior('p', { path: 'src/old.ts', line: 14, title });
    const forged = (status: ReviewableChange['status']) => [
      change('src/new.ts', { oldPath: 'src/old.ts', status }),
    ];
    for (const status of ['added', 'modified'] as const) {
      // A finding that uses that name is in no file of the review: it is not looked up as the new
      // file, and the issue of that name stays where it is.
      const byName = plan(
        { findings: [judged({ path: 'src/old.ts', line: 15, title })], shownPriorIds: ['p'] },
        [p],
        forged(status),
      );
      expect(byName.updates, status).toEqual([]);
      expect(byName.creates, status).toEqual([]);
      expect(
        byName.keeps.map((k) => k.id),
        status,
      ).toEqual(['p']);
      // The judge's id is not followed into the file, nor are the same words in it the issue's.
      for (const finding of [
        judged({ priorId: 'p', path: 'src/new.ts', line: 15, title: 'Other words' }),
        judged({ path: 'src/new.ts', line: 15, title }),
      ]) {
        const inFile = plan({ findings: [finding], shownPriorIds: ['p'] }, [p], forged(status));
        expect(inFile.updates, status).toEqual([]);
        expect(
          inFile.creates.map((c) => c.finding.path),
          status,
        ).toEqual(['src/new.ts']);
      }
    }
    // A file said to be deleted does not delete the issues of the name it gives: that is not a
    // deletion of theirs.
    const deleted = [
      change('src/new.ts', {
        oldPath: 'src/old.ts',
        status: 'deleted',
        lines: null,
        added: new Set(),
        unshown: 'deleted',
      }),
    ];
    expect(plan({ shownPriorIds: ['p'] }, [p], deleted).closes).toEqual([]);
  });

  it('a prior finding the review named in a finding it dropped itself stays open', () => {
    const p = prior('p', { line: 14 });
    const kept = plan(
      { namedPriorIds: ['p'], prior: [verdict('p', 'fixed')], shownPriorIds: ['p'] },
      [p],
    );
    expect(kept.keeps.map((k) => k.id)).toEqual(['p']);
    expect(kept.closes).toEqual([]);
    // An id that is no open prior finding's names nothing.
    const gone = prior('gone', { status: 'wont_fix', title: 'Dismissed problem' });
    const none = plan({ namedPriorIds: ['nobody', 'gone'], shownPriorIds: ['gone'] }, [gone]);
    expect(none.keeps).toEqual([]);
    expect(none.closes).toEqual([]);
  });

  it('plans nothing for an empty review', () => {
    expect(plan({})).toEqual({ creates: [], updates: [], keeps: [], closes: [], dropped: [] });
  });
});
