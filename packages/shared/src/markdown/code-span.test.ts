import { describe, expect, it } from 'vitest';
import {
  CONTROL_CHARS,
  INVISIBLE_CHARS,
  JOINER_CHARS,
  safeCodeSpan,
  safePlainValue,
} from './code-span';

describe('safeCodeSpan (scm.md §6)', () => {
  it('wraps a value in a fence it cannot close, on one line', () => {
    expect(safeCodeSpan('plain', 100)).toBe('` plain `');
    expect(safeCodeSpan('a ` b', 100)).toBe('`` a ` b ``');
    expect(safeCodeSpan('``x``', 100)).toBe('``` ``x`` ```');
    expect(safeCodeSpan('line\nbreak\r\u2028sep', 100)).toBe('` line break  sep `');
    expect(safeCodeSpan('\u202eright\u2066', 100)).toBe('`  right  `');
    expect(safeCodeSpan('', 100)).toBe('` `');
    expect(safeCodeSpan('x'.repeat(500), 10)).toBe(`\` ${'x'.repeat(9)}… \``);
  });

  it('never lets a quick action, mention, link or HTML out of the span', () => {
    const value = '\n/merge @all ![x](http://evil) <img src=x> [l](http://evil) ``` `';
    const span = safeCodeSpan(value, 300);
    expect(span).not.toContain('\n');
    const fence = /^`+/.exec(span)?.[0] ?? '';
    expect(span.startsWith(`${fence} `) && span.endsWith(` ${fence}`)).toBe(true);
    expect(span.slice(fence.length, -fence.length)).not.toContain(fence);
  });

  it('removes invisible characters and keeps graphemes whole', () => {
    expect(safePlainValue('a\u200bb\u2060c\ufeffd\u00ade', 100)).toBe('abcde');
    expect(safePlainValue('a\ud800b', 100)).toBe('a\ufffdb');
    expect(safePlainValue('😀😀😀', 2)).toBe('😀…');
  });

  it('removes the default-ignorable code points no other list had, so none can split a value', () => {
    const ranges = [
      [0xfff0, 0xfff8],
      [0x1bca0, 0x1bca3],
      [0x1d173, 0x1d17a],
      [0xe0080, 0xe00ff],
      [0xe01f0, 0xe0fff],
    ] as const;
    for (const [from, to] of ranges) {
      for (let codePoint = from; codePoint <= to; codePoint += 1) {
        const hidden = String.fromCodePoint(codePoint);
        expect(safePlainValue(`a${hidden}b`, 100), `U+${codePoint.toString(16)}`).toBe('ab');
      }
    }
    expect(safeCodeSpan(`k${String.fromCodePoint(0xe0080)}ey`, 100)).toBe('` key `');
  });

  it('has every default-ignorable code point in one of its lists (a reader sees none of them)', () => {
    // Unicode's Default_Ignorable_Code_Point: renderers draw nothing for these, so each is either
    // replaced by a space (the controls), removed (invisible) or kept for the scripts that need it.
    const ignorable = /^\p{Default_Ignorable_Code_Point}$/u;
    const listed = new RegExp(`^[${CONTROL_CHARS}${INVISIBLE_CHARS}${JOINER_CHARS}]$`, 'u');
    const unlisted: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const character = String.fromCodePoint(codePoint);
      if (ignorable.test(character) && !listed.test(character)) {
        unlisted.push(`U+${codePoint.toString(16).toUpperCase()}`);
      }
    }
    expect(unlisted).toEqual([]);
  });

  it('removes the blank-looking fillers that would show a value as empty or spaced', () => {
    // Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the braille blank (U+2800) render as
    // nothing or as a space but are letters or symbols, so they are not whitespace to a reader.
    expect(safePlainValue('a\u3164b\u115fc\u1160d\uffa0e\u2800f', 100)).toBe('abcdef');
    expect(safeCodeSpan('\u3164\u2800', 100)).toBe('` `');
  });
});
