import { describe, expect, it } from 'vitest';
import { memorySnapshot } from '../../test/review';
import { MAX_GLOB_WILDCARDS } from './path-glob';

const hit = (path: string, line = 1, text = 'needle') => ({ path, line, text });
const needleIn = (...paths: string[]) =>
  Object.fromEntries(paths.map((path) => [path, 'needle\n']));

describe('the search of the memory reader', () => {
  it('leaves out the paths the exclusion names: they use up no limit and are no "more"', async () => {
    const reader = memorySnapshot({ files: needleIn('a/1.ts', 'a/2.ts', 'b/1.ts', 'b/2.ts') });
    const inA = (path: string) => path.startsWith('a/');
    expect(await reader.grep('needle', null, 2, inA)).toEqual({
      hits: [hit('b/1.ts'), hit('b/2.ts')],
      truncated: false,
    });
    expect(await reader.grep('needle', null, 1, inA)).toEqual({
      hits: [hit('b/1.ts')],
      truncated: true,
    });
    // Without it, the same limit finds the first files and says there is more.
    expect(await reader.grep('needle', null, 2)).toEqual({
      hits: [hit('a/1.ts'), hit('a/2.ts')],
      truncated: true,
    });
    // All of them excluded: nothing, and nothing more.
    expect(await reader.grep('needle', null, 5, () => true)).toEqual({
      hits: [],
      truncated: false,
    });
    // The exclusion and the glob both narrow the search.
    expect(await reader.grep('needle', 'b/*', 5, (path) => path === 'b/2.ts')).toEqual({
      hits: [hit('b/1.ts')],
      truncated: false,
    });
  });

  it('asks the exclusion only for paths that hold the needle, each once', async () => {
    const reader = memorySnapshot({
      files: { ...needleIn('a/1.ts', 'b/1.ts'), 'c/no.ts': 'nothing here\n' },
    });
    const asked: string[] = [];
    await reader.grep('needle', null, 5, (path) => {
      asked.push(path);
      return false;
    });
    expect(asked).toEqual(['a/1.ts', 'b/1.ts']);
  });
});

describe('the work of a search with a glob', () => {
  // `*a` fifteen times and `*b`: sixteen wildcards, and every path of a's is walked to its end.
  const hostile = `${'*a'.repeat(MAX_GLOB_WILDCARDS - 1)}*b`;
  const longPath = (i: number) => `${'a'.repeat(990)}${String(i).padStart(6, '0')}`;
  // The match sorts before the long paths, which none of the hostile glob can match.
  const match = `0${'a'.repeat(20)}b`;

  it('ends early with the hits it found, and says there is more, when the glob takes too much work', async () => {
    const paths = Array.from({ length: 4_000 }, (_, i) => longPath(i));
    const reader = memorySnapshot({ files: needleIn(match, ...paths) });
    const started = performance.now();
    const found = await reader.grep('needle', hostile, 50);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(found.hits).toEqual([hit(match)]);
    expect(found.truncated).toBe(true);
  });

  it('finishes a search whose glob takes little work, and says nothing is left', async () => {
    const paths = Array.from({ length: 50 }, (_, i) => longPath(i));
    const reader = memorySnapshot({ files: needleIn(match, ...paths) });
    const found = await reader.grep('needle', hostile, 50);
    expect(found.hits).toEqual([hit(match)]);
    expect(found.truncated).toBe(false);
  });

  it('spends no work on a path the exclusion names', async () => {
    const paths = Array.from({ length: 4_000 }, (_, i) => longPath(i));
    const reader = memorySnapshot({ files: needleIn(match, ...paths) });
    // The long paths are excluded: the walks are not made, and the search is whole.
    const found = await reader.grep('needle', hostile, 50, (path) => path !== match);
    expect(found).toEqual({ hits: [hit(match)], truncated: false });
  });
});
