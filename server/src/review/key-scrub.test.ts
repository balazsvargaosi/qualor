import { LONE_SURROGATE_SOURCE, REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { LlmTurn } from '../llm/providers';
import { CONVERSATION_LIMITS } from './conversation';
import { scrubText, scrubTurn } from './key-scrub';

const KEY = 'sk-test-0123456789abcdef';

/** Every character of `text` as a JSON escape: how a JSON string can spell a word without writing it. */
const spelledOut = (text: string) =>
  [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

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
    expect(scrubbed).not.toContain(KEY);
    // The value of every string is what it was, except the key.
    expect(JSON.parse(scrubbed)).toEqual({
      a: 'café',
      b: REDACTED,
      c: 'quote" and backslash\\',
    });
  });

  it('keeps the escapes of control characters and of a lone surrogate, so that the text stays JSON', () => {
    const text = `{"a":"line\\u000abreak","b":"half\\ud800","c":"pair\\ud83d\\ude00","d":"${spelledOut(KEY)}"}`;
    const scrubbed = scrubText(text, KEY);
    expect(JSON.parse(scrubbed)).toEqual({
      a: 'line\nbreak',
      b: 'half\ud800',
      c: 'pair😀',
      d: REDACTED,
    });
    // No lone surrogate was made out of an escape.
    expect(new RegExp(LONE_SURROGATE_SOURCE).test(scrubbed)).toBe(false);
  });

  it('does not take an escaped backslash for the start of an escape', () => {
    // The value of "a" is the six characters \\u0073: a backslash, then u0073.
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
  });

  it('does not follow arguments deeper than the loop takes, and they stay too deep for it', () => {
    let deep: Record<string, unknown> = { path: KEY };
    for (let level = 1; level < 100_000; level += 1) deep = { a: deep };
    const scrubbed = scrubTurn(
      turnOf({ toolCalls: [{ id: 'c1', name: 'read_file', arguments: deep }] }),
      KEY,
    );
    const depth = depthOf(scrubbed.toolCalls[0]!.arguments);
    expect(depth).toBeGreaterThan(CONVERSATION_LIMITS.maxArgumentDepth);
    expect(JSON.stringify(scrubbed)).not.toContain(KEY);
  });
});
