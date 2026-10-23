import { describe, expect, it } from 'vitest';
import { budgetMs } from '../../test/perf';
import {
  compilePathGlob,
  likePrefix,
  MAX_GLOB_STEPS,
  MAX_GLOB_WILDCARDS,
  newGlobWork,
} from './path-glob';

describe('the path_glob language', () => {
  const matches = (glob: string, path: string) => compilePathGlob(glob).matches(path);

  it('matches * within a segment, ** across segments and ? one character', () => {
    expect(matches('*.ts', 'a.ts')).toBe(true);
    expect(matches('*.ts', 'src/a.ts')).toBe(false);
    expect(matches('*.ts', 'a.tsx')).toBe(false);
    expect(matches('src/*/c.ts', 'src/lib/c.ts')).toBe(true);
    expect(matches('src/*/c.ts', 'src/lib/deep/c.ts')).toBe(false);
    expect(matches('src/*/c.ts', 'src/c.ts')).toBe(false);
    expect(matches('**/*.ts', 'a.ts')).toBe(true);
    expect(matches('**/*.ts', 'src/lib/a.ts')).toBe(true);
    expect(matches('**/*.ts', 'src/lib/a.js')).toBe(false);
    expect(matches('src/**', 'src/a')).toBe(true);
    expect(matches('src/**', 'src/a/b/c')).toBe(true);
    expect(matches('src/**', 'src')).toBe(false);
    expect(matches('src/**', 'srcs/a')).toBe(false);
    expect(matches('src/**/c.ts', 'src/c.ts')).toBe(true);
    expect(matches('src/**/c.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matches('src/**/c.ts', 'src/a/b/d.ts')).toBe(false);
    expect(matches('src/**/c.ts', 'src/xc.ts')).toBe(false);
    expect(matches('**', 'any/path/at.all')).toBe(true);
    expect(matches('**.ts', 'src/lib/a.ts')).toBe(true);
    expect(matches('?.ts', 'a.ts')).toBe(true);
    expect(matches('?.ts', 'ab.ts')).toBe(false);
    expect(matches('?.ts', '/.ts')).toBe(false);
    expect(matches('a?c', 'a/c')).toBe(false);
    expect(matches('a?c', 'a😀c')).toBe(true);
    // Case matters.
    expect(matches('SRC/**', 'src/a')).toBe(false);
  });

  it('takes a literal run as one piece: a mismatch inside it, and a run cut short by the path', () => {
    expect(matches('src/lib/deep/file.ts', 'src/lib/deep/file.ts')).toBe(true);
    expect(matches('src/lib/deep/file.ts', 'src/lib/deep/filE.ts')).toBe(false);
    expect(matches('src/lib/deep/file.ts', 'src/lib/deep/file.t')).toBe(false);
    expect(matches('*/lib/deep/*.ts', 'src/lib/deep/x.ts')).toBe(true);
    expect(matches('*/lib/deep/*.ts', 'src/lib/deeP/x.ts')).toBe(false);
    expect(matches('a*bcd*e', 'aXXbcdYYe')).toBe(true);
    expect(matches('a*bcd*e', 'aXXbcYYe')).toBe(false);
    expect(matches('a*bcd*e', 'abcde')).toBe(true);
    // Characters outside the Basic Multilingual Plane count as one.
    expect(matches('😀😀*.ts', '😀😀x.ts')).toBe(true);
    expect(matches('😀😀*.ts', '😀x.ts')).toBe(false);
  });

  it('takes every other character as itself', () => {
    expect(matches('a.b(c)[d]+e^$|f{g}', 'a.b(c)[d]+e^$|f{g}')).toBe(true);
    expect(matches('a.b', 'aXb')).toBe(false);
    expect(matches('[ab].ts', 'a.ts')).toBe(false);
    expect(matches('[ab].ts', '[ab].ts')).toBe(true);
    expect(matches('{a,b}.ts', 'a.ts')).toBe(false);
    expect(matches('src/%/x', 'src/%/x')).toBe(true);
    expect(matches('src/%/x', 'src/y/x')).toBe(false);
    expect(matches('a_b', 'axb')).toBe(false);
  });

  it('takes the literal text before the first wildcard as the prefix', () => {
    expect(compilePathGlob('src/lib/*.ts').prefix).toBe('src/lib/');
    expect(compilePathGlob('src/ut?l.ts').prefix).toBe('src/ut');
    expect(compilePathGlob('src/**/c.ts').prefix).toBe('src/');
    expect(compilePathGlob('**/*.ts').prefix).toBe('');
    expect(compilePathGlob('exact/path.ts').prefix).toBe('exact/path.ts');
    // Every path a glob matches starts with its prefix.
    for (const [glob, path] of [
      ['src/**/c.ts', 'src/c.ts'],
      ['src/ut?l.ts', 'src/utel.ts'],
      ['a**/b', 'a/x/b'],
    ] as const) {
      expect(matches(glob, path)).toBe(true);
      expect(path.startsWith(compilePathGlob(glob).prefix)).toBe(true);
    }
  });

  it('counts its wildcards: each ?, each run of stars, and ** followed by a slash', () => {
    const wildcards = (glob: string) => compilePathGlob(glob).wildcards;
    expect(wildcards('src/lib/file.ts')).toBe(0);
    expect(wildcards('*.ts')).toBe(1);
    expect(wildcards('src/**/*.ts')).toBe(2);
    expect(wildcards('a?c?e')).toBe(2);
    expect(wildcards('***')).toBe(1);
    expect(wildcards('**/**/**/x')).toBe(3);
    expect(wildcards('*a'.repeat(MAX_GLOB_WILDCARDS))).toBe(MAX_GLOB_WILDCARDS);
  });

  it('escapes LIKE metacharacters in the prefix of a glob', () => {
    expect(likePrefix('src/%/')).toBe('src/\\%/%');
    expect(likePrefix('a_b/')).toBe('a\\_b/%');
    expect(likePrefix('a\\b')).toBe('a\\\\b%');
    expect(likePrefix('')).toBe('%');
  });
});

/**
 * The glob as a regular expression, for the small globs of a test (never for a model's: a regular
 * expression of its choosing could take exponential time). The same language as
 * {@link compilePathGlob}, spelled the other way round.
 */
function referenceRegExp(glob: string): RegExp {
  const chars = Array.from(glob);
  let source = '';
  let at = 0;
  while (at < chars.length) {
    const char = chars[at] ?? '';
    if (char === '?') {
      source += '[^/]';
      at += 1;
    } else if (char === '*') {
      let end = at;
      while (chars[end] === '*') end += 1;
      const segmentStart = at === 0 || chars[at - 1] === '/';
      if (end - at >= 2 && segmentStart && chars[end] === '/') {
        source += '(?:.*/)?';
        at = end + 1;
      } else {
        source += end - at >= 2 ? '.*' : '[^/]*';
        at = end;
      }
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
      at += 1;
    }
  }
  // Unicode mode, so that a character outside the Basic Multilingual Plane is one character.
  return new RegExp(`^${source}$`, 'su');
}

describe('the walk of a glob over a path', () => {
  /** A small deterministic generator (mulberry32), so that a failure can be replayed. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('agrees with the regular expression of the same glob, for thousands of small globs and paths', () => {
    const next = random(20261023);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const letters = ['a', 'b', '/', '.', 'x', '😀'] as const;
    const some = (max: number, from: readonly string[]) =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(from)).join('');
    /** A piece of a glob, and a piece of a path it matches. */
    const pieces: (() => [string, string])[] = [
      () => ['a', 'a'],
      () => ['b', 'b'],
      () => ['/', '/'],
      () => ['.', '.'],
      () => ['x', 'x'],
      () => ['😀', '😀'],
      () => ['?', pick(['a', 'b', 'x', '.', '😀'])],
      () => ['*', some(3, ['a', 'b', 'x', '.', '😀'])],
      () => ['**', some(4, letters)],
      () => ['**/', pick(['', 'a/', 'b/x/', '.a/'])],
      () => ['*/', `${some(2, ['a', 'b'])}/`],
    ];
    let matched = 0;
    const cases = 6_000;
    for (let i = 0; i < cases; i += 1) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 7) }, () => pick(pieces)());
      const glob = parts.map(([piece]) => piece).join('');
      // A path the glob was made to match, one letter off in a fifth of the cases; or any path.
      let path = parts.map(([, sample]) => sample).join('');
      if (next() < 0.2 && path.length > 0) {
        const chars = Array.from(path);
        chars[Math.floor(next() * chars.length)] = pick(letters);
        path = chars.join('');
      } else if (next() < 0.25) {
        path = some(10, letters);
      }
      const expected = referenceRegExp(glob).test(path);
      matched += expected ? 1 : 0;
      expect(compilePathGlob(glob).matches(path), JSON.stringify([glob, path])).toBe(expected);
    }
    // The corpus holds both kinds of case.
    expect(matched).toBeGreaterThan(cases / 4);
    expect(matched).toBeLessThan((cases * 9) / 10);
  });
});

describe('the work of matching a glob is bounded', () => {
  const spent = (glob: string, path: string): number => {
    const work = newGlobWork();
    compilePathGlob(glob).matches(path, work);
    return MAX_GLOB_STEPS - work.steps;
  };

  it('is 20 million steps for the walks of one search, about a tenth of a second at the worst', () => {
    // The slowest shapes measured take 5 ms for a million steps (the test of the shapes below
    // has them): more steps than this would be more time than a search may take.
    expect(MAX_GLOB_STEPS).toBe(20_000_000);
    expect(newGlobWork()).toEqual({ steps: MAX_GLOB_STEPS, exhausted: false });
  });

  it('charges the length of a path before it walks a token, and refuses a walk it cannot pay for', () => {
    const path = 'a'.repeat(1_000);
    // A glob that takes the path nowhere costs what looking at the path does, and no more.
    expect(spent('zzz*', path)).toBeGreaterThanOrEqual(1_000);
    expect(spent('zzz*', path)).toBeLessThan(1_010);
    // A path longer than what is left of the bound is not walked: the search is out of steps.
    const work = { steps: 999, exhausted: false };
    expect(compilePathGlob('a*').matches(path, work)).toBe(false);
    expect(work.exhausted).toBe(true);
    // A path of characters outside the Basic Multilingual Plane is counted by characters.
    expect(spent('zzz*', '😀'.repeat(500))).toBeGreaterThanOrEqual(500);
    expect(spent('zzz*', '😀'.repeat(500))).toBeLessThan(510);
  });

  it('sets exhausted when the tokens of a walk spend the steps that are left', () => {
    // 16 steps for the path, 17 for the first token: 30 are not enough, and the walk is cut in
    // the middle.
    const work = { steps: 30, exhausted: false };
    expect(compilePathGlob('*a*a*a').matches('a'.repeat(16), work)).toBe(false);
    expect(work.exhausted).toBe(true);
    // The same walk with enough steps matches.
    expect(compilePathGlob('*a*a*a').matches('a'.repeat(16), newGlobWork())).toBe(true);
  });

  it('is not exponential, whatever the stars', () => {
    const started = performance.now();
    expect(compilePathGlob('*a'.repeat(MAX_GLOB_WILDCARDS) + '*b').matches('a'.repeat(1_000))).toBe(
      false,
    );
    expect(
      compilePathGlob(`${'**/'.repeat(MAX_GLOB_WILDCARDS)}x`).matches(`${'d/'.repeat(500)}y`),
    ).toBe(false);
    // Without a limit on the wildcards, the same.
    expect(compilePathGlob(`${'*a'.repeat(100)}*b`).matches('a'.repeat(1_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(budgetMs(1_000));
  });

  it('ends the walk of a path as soon as no position of it is reachable', () => {
    const path = 'a'.repeat(1_000);
    // The first run is not at the start of the path: nothing is reachable after one token.
    const early = spent(`zzz${'*a'.repeat(15)}*b`, path);
    // The same glob with a first run that matches: the whole path is walked for each token.
    const full = spent(`aaa${'*a'.repeat(15)}*b`, path);
    expect(early - path.length).toBeLessThan(10);
    expect(full - path.length).toBeGreaterThan(10_000);
  });

  it('charges every walk to the work of a search, and refuses the walks once it is spent', () => {
    const glob = compilePathGlob(`${'*a'.repeat(MAX_GLOB_WILDCARDS - 1)}*b`);
    const work = newGlobWork();
    const path = 'a'.repeat(1_000);
    let walked = 0;
    // A bound that does not hold ends the loop here, not after minutes.
    while (!work.exhausted && walked < 20_000) {
      glob.matches(path, work);
      walked += 1;
    }
    expect(work.exhausted).toBe(true);
    // Each walk takes tens of thousands of steps: the bound ends the loop after a few hundred.
    expect(walked).toBeGreaterThan(100);
    expect(walked).toBeLessThan(5_000);
    expect(work.steps).toBeLessThanOrEqual(0);
    // Once spent, no walk is made: a path that would match is answered false.
    expect(compilePathGlob('a*').matches('abc', work)).toBe(false);
    expect(compilePathGlob('a*').matches('abc')).toBe(true);
  });

  it('walks the whole of a large snapshot with a plain glob inside the bound', () => {
    // 50 000 paths of about 100 characters, the most files a snapshot holds.
    const paths = Array.from(
      { length: 50_000 },
      (_, i) => `packages/module-${i % 97}/src/components/section-${i % 13}/widget-${i}.test.tsx`,
    );
    for (const glob of ['**/*.test.tsx', 'packages/*/src/**', '**/section-1?/*', '*widget*']) {
      const compiled = compilePathGlob(glob);
      const work = newGlobWork();
      for (const path of paths) compiled.matches(path, work);
      expect(work.exhausted, glob).toBe(false);
      // A path of this size costs a few hundred steps: the bound is for something else.
      expect(work.steps, glob).toBeGreaterThan(0);
    }
  });

  it('takes the shapes that cost most over many long paths a tenth of a second each, not minutes', () => {
    // 50 000 paths of 1 006 characters. These are the globs that were slowest to walk: stars that
    // look at every position, tokens that take a path nowhere (the walk then costs what looking
    // at the path does), and `**/` over a path of many segments.
    const flat = Array.from(
      { length: 50_000 },
      (_, i) => `${'a'.repeat(1_000)}${String(i).padStart(6, '0')}`,
    );
    const deep = Array.from(
      { length: 50_000 },
      (_, i) => `${'a/'.repeat(500)}${String(i).padStart(6, '0')}`,
    );
    const shapes: [string, string, string[]][] = [
      ['?*', '?*', flat],
      ['?**', '?**', flat],
      ['?zzz*', '?zzz*', flat],
      ['zzz*', 'zzz*', flat],
      ['*? x8', '*?'.repeat(8), flat],
      ['*a x15 *b', `${'*a'.repeat(15)}*b`, flat],
      ['*/ x16 x', `${'*/'.repeat(16)}x`, flat],
      ['**/ x16 x', `${'**/'.repeat(16)}x`, deep],
      ['**/*a*/**/*b*/x', '**/*a*/**/*b*/x', deep],
    ];
    for (const [label, glob, paths] of shapes) {
      const compiled = compilePathGlob(glob);
      const work = newGlobWork();
      const started = performance.now();
      let walked = 0;
      for (const path of paths) {
        compiled.matches(path, work);
        walked += 1;
        if (work.exhausted) break;
      }
      const elapsed = performance.now() - started;
      // The bound ends the search before the paths do, and a path costs at least its length.
      expect(work.exhausted, label).toBe(true);
      expect(walked, label).toBeLessThanOrEqual(Math.ceil(MAX_GLOB_STEPS / 1_006));
      // About 100 ms here; the bound is 300 so that a busy machine does not fail it.
      expect(elapsed, label).toBeLessThan(budgetMs(300));
    }
  });
});
