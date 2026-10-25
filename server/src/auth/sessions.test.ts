import type * as NodeCrypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { safeEqual } from './sessions';

/** The sizes of the two buffers each `timingSafeEqual` call of this file's tests was handed. */
const compared = vi.hoisted(() => [] as [number, number][]);

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof NodeCrypto>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.push([a.byteLength, b.byteLength]);
      return real.timingSafeEqual(a, b);
    },
  };
});

describe('safeEqual', () => {
  it('is true for equal strings and false for unequal ones, of one length or of two', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('é€😀', 'é€😀')).toBe(true);
    expect(safeEqual('a'.repeat(5_000), 'a'.repeat(5_000))).toBe(true);
    // Of one length, with one character different, first or last.
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'Secret')).toBe(false);
    // Of two lengths: one a prefix of the other, either way round, and an empty one.
    expect(safeEqual('secret', 'secrets')).toBe(false);
    expect(safeEqual('secrets', 'secret')).toBe(false);
    expect(safeEqual('', 'secret')).toBe(false);
    expect(safeEqual('secret', '')).toBe(false);
    expect(safeEqual('a'.repeat(5_000), 'a'.repeat(5_001))).toBe(false);
    // Two characters that are one byte each and one of two bytes are not one another.
    expect(safeEqual('ab', 'é')).toBe(false);
  });

  it('hands timingSafeEqual two digests of 32 bytes whatever the lengths: no early exit on a length', () => {
    compared.length = 0;
    const pairs: [string, string][] = [
      ['secret', 'secret'],
      ['', ''],
      ['', 'secret'],
      ['secret', ''],
      ['secret', 'secrets'],
      ['a'.repeat(5_000), 'b'],
    ];
    for (const [a, b] of pairs) safeEqual(a, b);
    expect(compared).toEqual(pairs.map(() => [32, 32]));
  });
});
