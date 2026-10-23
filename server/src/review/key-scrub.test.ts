import { LONE_SURROGATE_SOURCE, REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { LlmTurn } from '../llm/providers';
import { scrubKeyDeep, scrubText, scrubTurn } from './key-scrub';

const j = (...parts: string[]) => parts.join('');
/** A fake provider key, built at run time so no scanner takes it for a real one. */
const KEY = j('sk-test-', '0123456789abcdef');
/** A key of the kind base64 makes: it has slashes, a plus sign and padding. */
const SLASH_KEY = 'sk-proj/AbCdEf+0123/GhIjKl==';
/** `SLASH_KEY` with a slash as `\/`, as the escape of a letter and of a sign, and as it is. */
const SLASH_KEY_MIXED = 'sk-pro\\u006a\\/AbC\\u0064Ef\\u002B0123\\u002fGhIjKl\\u003d=';

const unitsOf = (text: string): number[] =>
  Array.from({ length: text.length }, (_, at) => text.charCodeAt(at));
const hex4 = (unit: number): string => unit.toString(16).padStart(4, '0');

/**
 * Every character of `text` as a JSON escape: how a JSON string can spell a word without writing
 * it. `upper` writes the hex digits in capitals.
 */
const spelledOut = (text: string, upper = false): string =>
  unitsOf(text)
    .map((unit) => `\\u${upper ? hex4(unit).toUpperCase() : hex4(unit)}`)
    .join('');

const turnOf = (over: Partial<LlmTurn> = {}): LlmTurn => ({
  text: '',
  finishReason: 'tool',
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  model: null,
  ...over,
});

/** The most levels of objects and lists in `value`, counted without recursion. */
function depthOf(value: unknown): number {
  let deepest = 0;
  const pending: [unknown, number][] = [[value, 0]];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const [node, depth] = item;
    if (typeof node !== 'object' || node === null) continue;
    deepest = Math.max(deepest, depth + 1);
    for (const child of Object.values(node)) pending.push([child, depth + 1]);
  }
  return deepest;
}

/** A small seeded generator, so that a spelling that fails can be found again. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** What a JSON string may write instead of the character with this code unit. */
const SHORT_ESCAPES: Record<number, string> = {
  0x22: '\\"',
  0x5c: '\\\\',
  0x2f: '\\/',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
};

/** One of the spellings a JSON string has for the character: an escape, or the character itself. */
function spelledAnyWay(unit: number, next: () => number): string {
  const spellings = [`\\u${hex4(unit)}`, `\\u${hex4(unit).toUpperCase()}`];
  const short = SHORT_ESCAPES[unit];
  if (short !== undefined) spellings.push(short);
  // A string may hold every other character as it is, from the space up.
  if (unit >= 0x20 && unit !== 0x22 && unit !== 0x5c) spellings.push(String.fromCharCode(unit));
  return spellings[Math.floor(next() * spellings.length)]!;
}

describe('scrubText', () => {
  it('replaces every occurrence of the key', () => {
    expect(scrubText(`one ${KEY} two ${KEY}`, KEY)).toBe(`one ${REDACTED} two ${REDACTED}`);
  });

  it('leaves a text without the key as it is', () => {
    const text = '{"summary":"nothing secret here","line":12}';
    expect(scrubText(text, KEY)).toBe(text);
  });

  it('catches the key spelled with JSON escapes, so that the parsed text does not hold it', () => {
    const text = `{"a":"caf\\u00e9","b":"${spelledOut(KEY)}","c":"quote\\u0022 and backslash\\u005c"}`;
    const scrubbed = scrubText(text, KEY);
    expect(scrubbed).toBe(
      `{"a":"caf\\u00e9","b":"${REDACTED}","c":"quote\\u0022 and backslash\\u005c"}`,
    );
    expect(JSON.parse(scrubbed)).toEqual({
      a: 'café',
      b: REDACTED,
      c: 'quote" and backslash\\',
    });
  });

  it('does not take an escaped backslash for the start of an escape', () => {
    // The value of "a" is a backslash, then the five characters u0073: no escape, and no s.
    const text = `{"a":"\\\\u0073","b":"${spelledOut(KEY)}"}`;
    expect(JSON.parse(scrubText(text, KEY))).toEqual({ a: '\\u0073', b: REDACTED });
  });

  it('leaves the escapes alone when the key is not hidden in them', () => {
    const text = '{"a":"caf\\u00e9"}';
    expect(scrubText(text, KEY)).toBe(text);
  });

  it('does not look for a key of fewer than 8 characters, or for none', () => {
    expect(scrubText('abc abc', 'abc')).toBe('abc abc');
    expect(scrubText(`has ${KEY}`, null)).toBe(`has ${KEY}`);
    // Nor in the escapes of the text: the shortest key that is looked for has 8 characters.
    expect(scrubText('abcdefg \\u0061bcdefg', 'abcdefg')).toBe('abcdefg \\u0061bcdefg');
    expect(scrubText('abcdefgh \\u0061bcdefgh', 'abcdefgh')).toBe(`${REDACTED} ${REDACTED}`);
  });
});

describe('scrubText: a key that a JSON string spells another way', () => {
  /** An answer with the key written as `spelled`, and other escapes around it. */
  const rest = 'caf\\u00e9 \\/ \\"quoted\\" \\\\ \\n \\ud83d\\ude00';
  const answer = (spelled: string) => `{"summary":"before ${spelled} after","other":"${rest}"}`;
  const scrubbed = `{"summary":"before ${REDACTED} after","other":"${rest}"}`;

  it('catches a slash written as \\/, as it is, and as \\u002f', () => {
    for (const spelled of [
      SLASH_KEY,
      'sk-proj\\/AbCdEf+0123\\/GhIjKl==',
      'sk-proj\\u002fAbCdEf+0123\\u002FGhIjKl==',
    ]) {
      expect(scrubText(answer(spelled), SLASH_KEY), spelled).toBe(scrubbed);
    }
  });

  it('catches a key split across escapes, in a mix of spellings', () => {
    expect(scrubText(answer(SLASH_KEY_MIXED), SLASH_KEY)).toBe(scrubbed);
  });

  it('catches the key spelled out whole, with the hex digits in either case', () => {
    expect(scrubText(answer(spelledOut(SLASH_KEY)), SLASH_KEY)).toBe(scrubbed);
    expect(scrubText(answer(spelledOut(SLASH_KEY, true)), SLASH_KEY)).toBe(scrubbed);
  });

  it('leaves the value of every other string as it was, and the parsed text without the key', () => {
    const out = scrubText(answer(SLASH_KEY_MIXED), SLASH_KEY);
    const parsed = JSON.parse(out) as { summary: string; other: string };
    expect(parsed.summary).toBe(`before ${REDACTED} after`);
    expect(parsed.other).toBe('café / "quoted" \\ \n 😀');
    expect(out).not.toContain(SLASH_KEY);
    expect(parsed.summary).not.toContain(SLASH_KEY);
  });

  it('writes out the escapes of the quote, the backslash and the control characters, too', () => {
    // A quote, a backslash and a line feed, a tab, a backspace, a form feed and a return.
    const odd = 'ab"cd\\ef\n\t\b\f\r-ghij';
    const spelled = JSON.stringify(odd).slice(1, -1);
    for (const escape of ['\\"', '\\\\', '\\n', '\\t', '\\b', '\\f', '\\r']) {
      expect(spelled).toContain(escape);
    }
    expect(scrubText(`{"a":"x${spelled}y"}`, odd)).toBe(`{"a":"x${REDACTED}y"}`);
  });

  it('catches a key with an astral character as a surrogate pair, in either case, or as it is', () => {
    const emoji = 'key-😀-0123456789';
    const lowHalf = String.fromCharCode(0xde00);
    for (const spelled of [
      emoji,
      'key-\\ud83d\\ude00-0123456789',
      'key-\\uD83D\\uDE00-0123456789',
      `key-\\ud83d${lowHalf}-0123456789`,
    ]) {
      const out = scrubText(`<${spelled}>`, emoji);
      expect(out, spelled).toBe(`<${REDACTED}>`);
    }
    // Half of a pair is not made out of an escape, or left behind.
    const out = scrubText(`{"a":"key-\\ud83d\\ude00-0123456789 and 😀"}`, emoji);
    expect(new RegExp(LONE_SURROGATE_SOURCE).test(out)).toBe(false);
    expect(JSON.parse(out)).toEqual({ a: `${REDACTED} and 😀` });
  });

  it('replaces a key that begins or ends in an escape, and nothing around it', () => {
    const edges = '/abcdefgh/';
    expect(scrubText('p\\/abcdefgh\\/q', edges)).toBe(`p${REDACTED}q`);
    expect(scrubText('\\u002fabcdefgh\\u002f', edges)).toBe(REDACTED);
    expect(scrubText('/abcdefgh\\/', edges)).toBe(REDACTED);
  });

  it('leaves everything else of the text as it was written, byte for byte', () => {
    const around = 'lead \\/ \\u00e9 \\ud83d\\ude00 \\" \\\\ \\n \\u0041 \\u00 \\q ';
    const text = `${around}${spelledOut(SLASH_KEY)}${around}sk-proj\\/AbCdEf+0123\\/GhIjKl==${around}`;
    expect(scrubText(text, SLASH_KEY)).toBe(`${around}${REDACTED}${around}${REDACTED}${around}`);
  });

  it('finds the key more than once, written differently, and back to back', () => {
    const text = `${SLASH_KEY}sk-proj\\/AbCdEf+0123\\/GhIjKl==\\u0073k-proj/AbCdEf+0123/GhIjKl==`;
    expect(scrubText(text, SLASH_KEY)).toBe(REDACTED.repeat(3));
  });

  it('does not take what is no escape of JSON for one', () => {
    // Each of these stands for itself: they are not escapes, and the key is found past them.
    const broken = '\\q \\u12 \\u12zz \\u00g1 \\U0041 \\x41 \\';
    const text = `${broken} ${spelledOut(SLASH_KEY)} ${broken}`;
    expect(scrubText(text, SLASH_KEY)).toBe(`${broken} ${REDACTED} ${broken}`);
  });

  it('does not find the key where a character that is no escape is in the way', () => {
    const text = 'sk-proj\\x/AbCdEf+0123/GhIjKl== and sk-proj/AbCdEf+01\\u2/3/GhIjKl== and sk-proj';
    expect(scrubText(text, SLASH_KEY)).toBe(text);
  });

  it('does not let the half of an escape take the start of the key', () => {
    // Each of these is cut off before it is an escape, and the key follows at once: as it is, and
    // with its slashes written as \/, which only the reading of the escapes can find.
    const spellings = [SLASH_KEY, 'sk-proj\\/AbCdEf+0123\\/GhIjKl=='];
    for (const half of ['\\', '\\u', '\\u0', '\\u00', '\\u000', '\\u00zz']) {
      for (const spelled of spellings) {
        expect(scrubText(`${half}${spelled}`, SLASH_KEY), `${half}${spelled}`).toBe(
          `${half}${REDACTED}`,
        );
      }
    }
  });

  it('does not take a character for the start of an escape unless it is a backslash', () => {
    // A backslash somewhere else, so that the escapes are read: the u and its digits are text.
    const text = '\\q xu0061bcdefgh';
    expect(scrubText(text, 'abcdefgh')).toBe(text);
  });

  it('does not take an escaped backslash for the start of an escape of the key', () => {
    // The characters \u002f: the value of the string is these six, not a slash.
    const text = 'sk-proj\\\\u002fAbCdEf+0123/GhIjKl==';
    expect(scrubText(text, SLASH_KEY)).toBe(text);
    // The same for a key that begins with the slash.
    const slashFirst = 'x\\\\u002fabcdefgh';
    expect(scrubText(slashFirst, '/abcdefgh')).toBe(slashFirst);
  });

  it('finds a key with a backslash in it, as it is written and as JSON spells it', () => {
    // A backslash, then an n: the characters of the escape of a line feed, and not one.
    const backslashed = 'ab\\ncdefgh';
    expect(scrubText('x ab\\ncdefgh y', backslashed)).toBe(`x ${REDACTED} y`);
    expect(scrubText('x ab\\\\ncdefgh y', backslashed)).toBe(`x ${REDACTED} y`);
    // A line feed is not the key.
    expect(scrubText('x ab\ncdefgh y', backslashed)).toBe('x ab\ncdefgh y');
    // Both spellings in one text: the key as it is written, and as JSON spells it.
    expect(scrubText('ab\\ncdefgh and ab\\\\ncdefgh', backslashed)).toBe(
      `${REDACTED} and ${REDACTED}`,
    );
  });

  it('goes on after a match, not from inside it', () => {
    // A key that overlaps itself, in a text that spells it 12 characters long and has no run of it
    // as it is: one match, and the four characters left over, not a second match that begins
    // inside the first.
    const key = 'abababab';
    expect(scrubText('\\u0061ba\\u0062ab\\u0061ba\\u0062ab', key)).toBe(`${REDACTED}a\\u0062ab`);
  });

  it('is the text itself when the key is not in it, however many escapes it has', () => {
    const text = `${spelledOut('nothing to see here')} \\/ \\n \\u00e9 \\\\u0073k-proj/AbCdEf+0123/GhIjKl`;
    expect(scrubText(text, SLASH_KEY)).toBe(text);
  });

  it('finds the key however each character of it is spelled', () => {
    const next = seeded(20_261_023);
    const alphabet = [...unitsOf('abcXYZ019-_/+=.:"\\\n\t\b\u00e9\u20ac'), 0xd83d, 0xde00];
    const before = 'pre \\u00e9 \\/ ';
    const after = ' \\\\ post';
    for (let round = 0; round < 400; round += 1) {
      const length = 8 + Math.floor(next() * 12);
      const units = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]!);
      const key = String.fromCharCode(...units);
      const spelled = units.map((unit) => spelledAnyWay(unit, next)).join('');
      expect(scrubText(`{"a":"${before}${spelled}${after}"}`, key), `${key} as ${spelled}`).toBe(
        `{"a":"${before}${REDACTED}${after}"}`,
      );
    }
  });
});

describe('scrubKeyDeep', () => {
  it('takes the key out of every string and every name, at every level', () => {
    const value = {
      [`name-${KEY}`]: `value ${KEY}`,
      list: [KEY, [`in ${KEY}`], { deeper: { [KEY]: [{ text: `x${KEY}y` }] } }],
      number: 3,
      flag: true,
      nothing: null,
    };
    expect(scrubKeyDeep(value, KEY)).toEqual({
      [`name-${REDACTED}`]: `value ${REDACTED}`,
      list: [REDACTED, [`in ${REDACTED}`], { deeper: { [REDACTED]: [{ text: `x${REDACTED}y` }] } }],
      number: 3,
      flag: true,
      nothing: null,
    });
  });

  it('takes out a key with a slash that a parsed string holds', () => {
    const value = { summary: `the key is ${SLASH_KEY}`, [SLASH_KEY]: [SLASH_KEY] };
    expect(scrubKeyDeep(value, SLASH_KEY)).toEqual({
      summary: `the key is ${REDACTED}`,
      [REDACTED]: [REDACTED],
    });
  });

  it('takes out a key that a string still spells with escapes: text that is JSON itself', () => {
    const value = {
      note: 'see sk-proj\\/AbCdEf+0123\\/GhIjKl== here',
      ['sk-proj\\u002fAbCdEf+0123/GhIjKl==']: [spelledOut(SLASH_KEY)],
    };
    expect(scrubKeyDeep(value, SLASH_KEY)).toEqual({
      note: `see ${REDACTED} here`,
      [REDACTED]: [REDACTED],
    });
  });

  it('is a copy that equals the value when the key is not in it', () => {
    const value = {
      a: ['x', 1, null, { b: 'y\\/z', [`n${KEY.slice(0, 8)}`]: true }],
      c: 'caf\\u00e9',
    };
    const copy = scrubKeyDeep(value, KEY);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
  });

  it('does not change the value it is given', () => {
    const value = { path: KEY, nested: [{ [KEY]: KEY }] };
    scrubKeyDeep(value, KEY);
    expect(value).toEqual({ path: KEY, nested: [{ [KEY]: KEY }] });
  });

  it('is the value itself without a key to look for, or with one too short to look for', () => {
    const value = { path: KEY };
    expect(scrubKeyDeep(value, null)).toBe(value);
    expect(scrubKeyDeep(value, 'short')).toBe(value);
    // The shortest key that is looked for has 8 characters.
    expect(scrubKeyDeep({ a: 'abcdefg' }, 'abcdefg')).toEqual({ a: 'abcdefg' });
    expect(scrubKeyDeep({ a: 'abcdefgh' }, 'abcdefgh')).toEqual({ a: REDACTED });
  });

  it('hands back what is not a string, a list or an object as it is', () => {
    for (const value of [3, true, false, null, undefined]) {
      expect(scrubKeyDeep(value, KEY)).toBe(value);
    }
    expect(scrubKeyDeep(`a ${KEY}`, KEY)).toBe(`a ${REDACTED}`);
  });

  it('walks a value 100 000 levels deep, keeps all of it, and takes the key out of the bottom', () => {
    let deep: unknown = { path: KEY, list: [KEY] };
    for (let level = 1; level < 100_000; level += 1) deep = level % 2 === 0 ? { a: deep } : [deep];
    const scrubbed = scrubKeyDeep(deep, KEY);
    expect(depthOf(scrubbed)).toBe(depthOf(deep));
    let node = scrubbed;
    while (typeof node === 'object' && node !== null && !('path' in node)) {
      node = Array.isArray(node) ? (node as unknown[])[0] : (node as { a: unknown }).a;
    }
    expect(node).toEqual({ path: REDACTED, list: [REDACTED] });
  });

  it('keeps a name that is __proto__ as a name, and leaves the prototype alone', () => {
    const value = JSON.parse(`{"__proto__":{"polluted":"${KEY}"},"a":"${KEY}"}`) as object;
    const scrubbed = scrubKeyDeep(value, KEY) as Record<string, unknown>;
    expect(Object.getPrototypeOf(scrubbed)).toBe(Object.prototype);
    expect(Object.keys(scrubbed)).toEqual(['__proto__', 'a']);
    expect(Object.getOwnPropertyDescriptor(scrubbed, '__proto__')?.value).toEqual({
      polluted: REDACTED,
    });
    expect((scrubbed as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('makes the properties of a parsed value: plain data that can be written and deleted', () => {
    const scrubbed = scrubKeyDeep({ a: KEY, [KEY]: 1 }, KEY) as Record<string, unknown>;
    const data = { writable: true, enumerable: true, configurable: true };
    expect(Object.getOwnPropertyDescriptor(scrubbed, 'a')).toEqual({ value: REDACTED, ...data });
    expect(Object.getOwnPropertyDescriptor(scrubbed, REDACTED)).toEqual({ value: 1, ...data });
  });

  it('keeps the later value of two names that become the same', () => {
    const value = { [KEY]: 'first', ['sk-test-\\u0030123456789abcdef']: 'second' };
    expect(scrubKeyDeep(value, KEY)).toEqual({ [REDACTED]: 'second' });
  });
});

describe('scrubTurn', () => {
  it('takes the key out of the text and out of every string of the calls', () => {
    const turn = turnOf({
      text: `the key is ${KEY}`,
      toolCalls: [
        {
          id: `id-${KEY}`,
          name: `name-${KEY}`,
          arguments: { path: KEY, nested: [{ [`k${KEY}`]: `v ${KEY}` }, 3, null, true] },
        },
      ],
    });
    expect(scrubTurn(turn, KEY)).toEqual({
      ...turn,
      text: `the key is ${REDACTED}`,
      toolCalls: [
        {
          id: `id-${REDACTED}`,
          name: `name-${REDACTED}`,
          arguments: {
            path: REDACTED,
            nested: [{ [`k${REDACTED}`]: `v ${REDACTED}` }, 3, null, true],
          },
        },
      ],
    });
  });

  it('takes a key with a slash out of an answer that writes the slashes as \\/ or splits it', () => {
    const turn = turnOf({
      finishReason: 'stop',
      text: `{"summary":"a ${SLASH_KEY}, b sk-proj\\/AbCdEf+0123\\/GhIjKl==, c ${SLASH_KEY_MIXED}"}`,
    });
    const scrubbed = scrubTurn(turn, SLASH_KEY);
    expect(scrubbed.text).toBe(`{"summary":"a ${REDACTED}, b ${REDACTED}, c ${REDACTED}"}`);
    expect((JSON.parse(scrubbed.text) as { summary: string }).summary).not.toContain(SLASH_KEY);
  });

  it('does not change the turn it is given', () => {
    const turn = turnOf({
      text: KEY,
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: KEY } }],
    });
    scrubTurn(turn, KEY);
    expect(turn.text).toBe(KEY);
    expect(turn.toolCalls[0]!.arguments).toEqual({ path: KEY });
  });

  it('keeps everything else of the turn: the finish reason, the usage and the model', () => {
    const turn = turnOf({
      finishReason: 'stop',
      model: 'm-1',
      usage: { inputTokens: 7, outputTokens: 9 },
    });
    expect(scrubTurn(turn, KEY)).toEqual(turn);
  });

  it('is the turn itself without a key to look for', () => {
    const turn = turnOf({ text: KEY });
    expect(scrubTurn(turn, null)).toBe(turn);
    expect(scrubTurn(turn, 'short')).toBe(turn);
    expect(scrubTurn(turnOf({ text: 'abcdefgh' }), 'abcdefgh').text).toBe(REDACTED);
  });

  it('follows arguments of any depth, keeps their shape, and takes the key out of them', () => {
    let deep: Record<string, unknown> = { path: KEY };
    for (let level = 1; level < 100_000; level += 1) deep = { a: deep };
    const scrubbed = scrubTurn(
      turnOf({ toolCalls: [{ id: 'c1', name: 'read_file', arguments: deep }] }),
      KEY,
    );
    // JSON.stringify cannot follow arguments this deep: go down them one level at a time.
    let node: unknown = scrubbed.toolCalls[0]!.arguments;
    let levels = 1;
    while (typeof node === 'object' && node !== null && 'a' in node) {
      node = (node as { a: unknown }).a;
      levels += 1;
    }
    expect(levels).toBe(100_000);
    expect(node).toEqual({ path: REDACTED });
  });
});
