import { describe, expect, it } from 'vitest';
import { MAX_REMEMBERED_PAIRS, pairOf, RememberedPairs } from './remembered-pairs';
import type { ProviderConfig } from './types';

describe('RememberedPairs: what a process knows of the pairs of a base URL and a model', () => {
  it('keeps at most 1 000 pairs, and drops the oldest first', () => {
    expect(MAX_REMEMBERED_PAIRS).toBe(1_000);
    const pairs = new RememberedPairs();
    for (let i = 0; i < MAX_REMEMBERED_PAIRS + 1; i += 1) pairs.add(`pair ${i}`);
    expect(pairs.has('pair 0')).toBe(false);
    expect(pairs.has('pair 1')).toBe(true);
    expect(pairs.has(`pair ${MAX_REMEMBERED_PAIRS}`)).toBe(true);
    expect(pairs.size).toBe(MAX_REMEMBERED_PAIRS);
  });

  it('holds a pair once however often it is added, and an old pair added again is the newest', () => {
    const pairs = new RememberedPairs(3);
    for (const pair of ['a', 'b', 'c']) pairs.add(pair);
    pairs.add('a');
    expect(pairs.size).toBe(3);
    pairs.add('d');
    // `b` was the oldest after `a` was added again.
    expect([pairs.has('a'), pairs.has('b'), pairs.has('c'), pairs.has('d')]).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it('names a pair by its base URL, with or without a trailing slash, and its model', () => {
    const config = { baseUrl: 'https://llm.example/v1', model: 'm-1' } as ProviderConfig;
    expect(pairOf({ ...config, baseUrl: 'https://llm.example/v1//' })).toBe(pairOf(config));
    expect(pairOf({ ...config, model: 'm-2' })).not.toBe(pairOf(config));
    expect(pairOf({ ...config, baseUrl: 'https://other.example/v1' })).not.toBe(pairOf(config));
  });
});
