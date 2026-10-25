import { LONE_SURROGATE_SOURCE } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { jsonbTextBytes } from '../llm/job';
import type { LlmConversation, LlmMessage, LlmToolCall, LlmTurn } from '../llm/providers';
import {
  STORED_PROMPT_BYTES,
  STORED_RESULT_BYTES,
  storedPrompt,
  storedResult,
} from './usage-store';

const RUN = '0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const SYSTEM = 'Qualor review: quality';

const conversationOf = (messages: LlmMessage[], system = SYSTEM): LlmConversation => ({
  system,
  messages,
  tools: [],
  maxOutputTokens: 50,
});
const turnOf = (over: Partial<LlmTurn> = {}): LlmTurn => ({
  text: '',
  finishReason: 'stop',
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  model: null,
  ...over,
});
const call = (id: string, args: unknown = { path: 'a.ts' }): LlmToolCall => ({
  id,
  name: 'read_file',
  arguments: args,
});
/** `depth` objects inside one another, built without recursion. */
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 1; level < depth; level += 1) value = { a: value };
  return value;
}

interface StoredMessage {
  role: string;
  text: string;
  callId?: string;
  name?: string;
  callCount?: number;
  calls?: { id: string; name: string; arguments: string }[];
}
interface StoredPrompt {
  runId: string;
  system: string;
  omitted: number;
  messages: StoredMessage[];
}
interface StoredResult {
  finishReason: string;
  text: string;
  callCount: number;
  calls: { id: string; name: string; arguments: string }[];
}
const promptOf = (conversation: LlmConversation) => storedPrompt(RUN, conversation) as StoredPrompt;
const resultOf = (turn: LlmTurn) => storedResult(turn) as StoredResult;

// A NUL, a lone surrogate, control characters, quotes and backslashes, and text of two to four bytes
// a character: what would break a jsonb value or its size.
const AWKWARD = `\u0000a\ud800b\u0001"\\${'é€😀'.repeat(40_000)}`;

/** Every string of a stored document, the names included. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, item]) => [name, ...strings(item)]);
}
const LONE_SURROGATE = new RegExp(LONE_SURROGATE_SOURCE);
/** The character that takes the place of a NUL or a lone surrogate. */
const REPLACEMENT = String.fromCodePoint(0xfffd);
const NUL = String.fromCharCode(0);
/** A key of the kind a provider issues, and the same with a NUL in the middle of it. */
const KEY = 'sk-proj-AbCdEfGhIjKlMnOpQrSt';
const SPLIT_KEY = `${KEY.slice(0, 12)}${NUL}${KEY.slice(12)}`;
const SPLIT_KEY_STORED = `${KEY.slice(0, 12)}${REPLACEMENT}${KEY.slice(12)}`;
/** Whether a stored document holds a NUL or a lone surrogate: PostgreSQL refuses both in jsonb. */
const unstorable = (document: unknown) =>
  strings(document).some((text) => text.includes('\u0000') || LONE_SURROGATE.test(text));

describe('storedPrompt', () => {
  it('keeps the run, the system prompt and every message of a short conversation', () => {
    const messages: LlmMessage[] = [
      { role: 'user', text: 'The change' },
      { role: 'assistant', text: 'Reading.', toolCalls: [call('c1')] },
      { role: 'tool', callId: 'c1', name: 'read_file', text: 'file text' },
    ];
    expect(promptOf(conversationOf(messages))).toEqual({
      runId: RUN,
      system: SYSTEM,
      omitted: 0,
      messages: [
        { role: 'user', text: 'The change' },
        {
          role: 'assistant',
          text: 'Reading.',
          callCount: 1,
          calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
        },
        { role: 'tool', callId: 'c1', name: 'read_file', text: 'file text' },
      ],
    });
  });

  it('keeps no replay: a stored prompt shows the text and the calls of a turn, never the provider’s own data', () => {
    // The thinking of a current model is signed and encrypted by the provider: sent back to it, and
    // kept nowhere else.
    const replay = {
      kind: 'anthropic' as const,
      items: [
        { type: 'thinking', thinking: '', signature: 'SIGNATURE-OF-THE-THINKING' },
        { type: 'redacted_thinking', data: 'ENCRYPTED-THINKING-DATA' },
        { type: 'text', text: 'Reading.' },
      ],
    };
    const messages: LlmMessage[] = [
      { role: 'user', text: 'The change' },
      { role: 'assistant', text: 'Reading.', toolCalls: [call('c1')], replay },
      { role: 'tool', callId: 'c1', name: 'read_file', text: 'file text' },
    ];
    const stored = promptOf(conversationOf(messages));
    expect(stored.messages[1]).toEqual({
      role: 'assistant',
      text: 'Reading.',
      callCount: 1,
      calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
    });
    const text = JSON.stringify(stored);
    for (const secret of ['SIGNATURE-OF-THE-THINKING', 'ENCRYPTED-THINKING-DATA', 'replay']) {
      expect(text).not.toContain(secret);
    }
  });

  it('stores a conversation without messages as none', () => {
    expect(promptOf(conversationOf([]))).toEqual({
      runId: RUN,
      system: SYSTEM,
      omitted: 0,
      messages: [],
    });
  });

  it('names the reply, and no run, when the conversation answers a reply', () => {
    const messages: LlmMessage[] = [
      { role: 'user', text: 'The thread' },
      { role: 'assistant', text: 'Reading.', toolCalls: [call('c1')] },
    ];
    const stored = storedPrompt(RUN, conversationOf(messages), 'replyId');
    expect(stored).toEqual({
      replyId: RUN,
      system: SYSTEM,
      omitted: 0,
      messages: [
        { role: 'user', text: 'The thread' },
        {
          role: 'assistant',
          text: 'Reading.',
          callCount: 1,
          calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
        },
      ],
    });
    // The same size rules hold: a long conversation is cut the same way, under the same name.
    const long = storedPrompt(
      RUN,
      conversationOf([{ role: 'user', text: 'U'.repeat(200_000) }]),
      'replyId',
    ) as { replyId: string; omitted: number; messages: StoredMessage[] };
    expect(long.replyId).toBe(RUN);
    expect(long).not.toHaveProperty('runId');
    expect(jsonbTextBytes(long)).toBeLessThanOrEqual(STORED_PROMPT_BYTES);
    expect(long.messages).toHaveLength(1);
    // Without a name it is the review's, as it was.
    expect(storedPrompt(RUN, conversationOf([]))).toHaveProperty('runId', RUN);
  });

  it('cuts the system prompt', () => {
    const { system } = promptOf(conversationOf([{ role: 'user', text: 'U' }], 'S'.repeat(5_000)));
    expect([...system]).toHaveLength(1_000);
    expect(system.endsWith('…')).toBe(true);
  });

  it('keeps the newest messages that fit, oldest first, and counts the ones before them', () => {
    const messages: LlmMessage[] = [{ role: 'user', text: 'U'.repeat(30_000) }];
    for (let i = 0; i < 40; i += 1) {
      messages.push({ role: 'assistant', text: `turn ${i}`, toolCalls: [call(`c${i}`)] });
      messages.push({
        role: 'tool',
        callId: `c${i}`,
        name: 'read_file',
        text: `result ${i} ${'x'.repeat(2_000)}`,
      });
    }
    const stored = promptOf(conversationOf(messages));
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_PROMPT_BYTES);
    expect(stored.messages.at(-1)).toMatchObject({ role: 'tool', callId: 'c39' });
    expect(stored.omitted).toBeGreaterThan(0);
    expect(stored.messages.length + stored.omitted).toBe(messages.length);
    // Oldest first: the turns kept run on from one to the last.
    const turns = stored.messages.filter((m) => m.role === 'assistant').map((m) => m.text);
    expect(turns).toEqual([...turns].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))));
  });

  it('cuts a message that is too big for the bound, to fewer characters until it fits', () => {
    const stored = promptOf(conversationOf([{ role: 'user', text: 'x'.repeat(3_000_000) }]));
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_PROMPT_BYTES);
    expect(stored.messages).toHaveLength(1);
    expect(stored.omitted).toBe(0);
    expect(stored.messages[0]!.text.endsWith('…')).toBe(true);
    expect(stored.messages[0]!.text.length).toBeGreaterThan(1_000);
  });

  it('stays within the bound whatever is said, counted as PostgreSQL writes it', () => {
    const messages: LlmMessage[] = [
      { role: 'user', text: AWKWARD },
      { role: 'assistant', text: AWKWARD, toolCalls: [call('c1', { path: AWKWARD })] },
      { role: 'tool', callId: 'c1', name: 'read_file', text: AWKWARD },
    ];
    const stored = promptOf(conversationOf(messages, AWKWARD));
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_PROMPT_BYTES);
    expect(stored.messages.length).toBeGreaterThan(0);
  });

  it('makes text storable: no NUL and no lone surrogate', () => {
    const stored = promptOf(
      conversationOf(
        [
          { role: 'user', text: 'a\u0000b\ud800c' },
          { role: 'assistant', text: 'x', toolCalls: [call('c\u0000', { p: '\udc00' })] },
        ],
        'sys\u0000\ud800',
      ),
    );
    expect(unstorable(stored)).toBe(false);
    // The NUL and the lone surrogate each become the replacement character: neither is dropped.
    expect(stored.messages[0]!.text).toBe(`a${REPLACEMENT}b${REPLACEMENT}c`);
  });

  it('does not join the two halves of a key that a NUL splits', () => {
    const stored = promptOf(
      conversationOf(
        [
          { role: 'user', text: `see ${SPLIT_KEY}` },
          { role: 'assistant', text: SPLIT_KEY, toolCalls: [call('c1', { path: SPLIT_KEY })] },
          { role: 'tool', callId: 'c1', name: 'read_file', text: SPLIT_KEY },
        ],
        SPLIT_KEY,
      ),
    );
    expect(unstorable(stored)).toBe(false);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    // Every place the NUL stood holds the replacement character, in the texts and in the system prompt.
    expect(stored.system).toBe(SPLIT_KEY_STORED);
    expect(stored.messages.map((message) => message.text)).toEqual([
      `see ${SPLIT_KEY_STORED}`,
      SPLIT_KEY_STORED,
      SPLIT_KEY_STORED,
    ]);
  });

  it('stays within the bound when every character is a NUL', () => {
    // A NUL is one byte as text and three as the character that takes its place.
    const stored = promptOf(conversationOf([{ role: 'user', text: NUL.repeat(100_000) }]));
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_PROMPT_BYTES);
    expect(unstorable(stored)).toBe(false);
    const text = stored.messages[0]!.text;
    expect(text.endsWith('…')).toBe(true);
    expect(text.slice(0, -1)).toBe(REPLACEMENT.repeat(text.length - 1));
  });

  it('shows at most 20 calls of an assistant message, each cut, and says how many there were', () => {
    const calls = Array.from({ length: 30 }, (_, i) => call(`c${i}`, { path: 'p'.repeat(1_000) }));
    const stored = promptOf(
      conversationOf([
        { role: 'user', text: 'U' },
        { role: 'assistant', text: '', toolCalls: calls },
      ]),
    );
    const assistant = stored.messages[1]!;
    expect(assistant.callCount).toBe(30);
    expect(assistant.calls).toHaveLength(20);
    for (const shown of assistant.calls!)
      expect([...shown.arguments].length).toBeLessThanOrEqual(300);
  });

  it('shows arguments nested deeper than JSON.stringify can follow as such', () => {
    const stored = promptOf(
      conversationOf([
        { role: 'user', text: 'U' },
        { role: 'assistant', text: '', toolCalls: [call('c1', nested(100_000))] },
      ]),
    );
    expect(stored.messages[1]!.calls).toEqual([
      { id: 'c1', name: 'read_file', arguments: '[too deeply nested to show]' },
    ]);
  });
});

describe('storedResult', () => {
  it('keeps no replay of a turn, whatever it holds', () => {
    const replay = {
      kind: 'anthropic' as const,
      items: [{ type: 'thinking', thinking: '', signature: 'SIGNATURE-OF-THE-THINKING' }],
    };
    const stored = resultOf(turnOf({ text: 'Done.', replay }));
    expect(stored).toEqual({ finishReason: 'stop', text: 'Done.', callCount: 0, calls: [] });
    expect(JSON.stringify(stored)).not.toContain('SIGNATURE-OF-THE-THINKING');
  });

  it('keeps the finish reason, the text and the calls of a turn', () => {
    expect(
      resultOf(turnOf({ text: '{"findings":[]}', finishReason: 'tool', toolCalls: [call('c1')] })),
    ).toEqual({
      finishReason: 'tool',
      text: '{"findings":[]}',
      callCount: 1,
      calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
    });
  });

  it('keeps the text of the calls that are strings as they are', () => {
    const stored = resultOf(turnOf({ toolCalls: [call('c1', '{"path": "a.t')] }));
    expect(stored.calls[0]!.arguments).toBe('{"path": "a.t');
  });

  it('cuts a long text until the document fits', () => {
    const stored = resultOf(turnOf({ text: 'x'.repeat(2_000_000) }));
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_RESULT_BYTES);
    expect(stored.text.endsWith('…')).toBe(true);
    expect(stored.text.length).toBeGreaterThan(1_000);
  });

  it('stays within the bound whatever is said, counted as PostgreSQL writes it', () => {
    const stored = resultOf(
      turnOf({
        text: AWKWARD,
        toolCalls: Array.from({ length: 25 }, (_, i) => call(`c${i}`, AWKWARD)),
      }),
    );
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_RESULT_BYTES);
    // Every call is counted; the ones shown give way to the text when both do not fit.
    expect(stored.callCount).toBe(25);
    expect(stored.calls.length).toBeLessThanOrEqual(20);
    expect(stored.text.length).toBeGreaterThan(100);
  });

  it('shows 20 calls, each cut, when they fit beside the text', () => {
    const calls = Array.from({ length: 30 }, (_, i) => call(`c${i}`, { path: 'p'.repeat(1_000) }));
    const stored = resultOf(turnOf({ text: 'answer', toolCalls: calls }));
    expect(stored.callCount).toBe(30);
    expect(stored.calls).toHaveLength(20);
    for (const shown of stored.calls) expect([...shown.arguments].length).toBeLessThanOrEqual(300);
  });

  it('keeps the text before the calls when both do not fit', () => {
    const text = 'x'.repeat(14_000);
    const calls = Array.from({ length: 20 }, (_, i) => call(`c${i}`, { path: 'p'.repeat(1_000) }));
    const stored = resultOf(turnOf({ text, toolCalls: calls }));
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_RESULT_BYTES);
    expect(stored.text).toBe(text);
    expect(stored.callCount).toBe(20);
    expect(stored.calls).toEqual([]);
  });

  it('makes text storable: no NUL and no lone surrogate', () => {
    const stored = resultOf(
      turnOf({ text: 'a\u0000b\ud800c', toolCalls: [call('i\u0000', '\ud800')] }),
    );
    expect(unstorable(stored)).toBe(false);
    // The NUL and the lone surrogate each become the replacement character: neither is dropped.
    expect(stored.text).toBe(`a${REPLACEMENT}b${REPLACEMENT}c`);
    expect(stored.calls[0]!.arguments).toBe(REPLACEMENT);
    expect(stored.calls[0]!.id).toBe(`i${REPLACEMENT}`);
  });

  it('does not join the two halves of a key that a NUL splits', () => {
    const stored = resultOf(
      turnOf({
        text: `{"summary":"${SPLIT_KEY}"}`,
        toolCalls: [call(SPLIT_KEY, SPLIT_KEY), call('c2', { path: SPLIT_KEY })],
      }),
    );
    expect(unstorable(stored)).toBe(false);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(stored.text).toBe(`{"summary":"${SPLIT_KEY_STORED}"}`);
    expect(stored.calls[0]).toMatchObject({ id: SPLIT_KEY_STORED, arguments: SPLIT_KEY_STORED });
    // The NUL of an object is written out as the escape of JSON, which is not the key either.
    expect(stored.calls[1]!.arguments).not.toContain(KEY);
  });

  it('stays within the bound when every character is a NUL', () => {
    const stored = resultOf(turnOf({ text: NUL.repeat(100_000) }));
    expect(jsonbTextBytes(stored)).toBeLessThanOrEqual(STORED_RESULT_BYTES);
    expect(unstorable(stored)).toBe(false);
    expect(stored.text.endsWith('…')).toBe(true);
    expect(stored.text.length).toBeGreaterThan(1_000);
  });

  it('shows arguments nested deeper than JSON.stringify can follow as such', () => {
    const stored = resultOf(turnOf({ toolCalls: [call('c1', nested(100_000))] }));
    expect(stored.calls[0]!.arguments).toBe('[too deeply nested to show]');
  });
});
