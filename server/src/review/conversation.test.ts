import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicAnswer,
  anthropicToolUse,
  createFakeLlm,
  llmShape,
  openAiAnswer,
  openAiToolCalls,
  type FakeLlm,
  type LlmReply,
  type LlmResponder,
  type RecordedLlmRequest,
} from '../../test/fake-llm';
import {
  converse,
  LlmCallAborted,
  LlmError,
  type LlmConversation,
  type LlmMessage,
  type LlmToolCall,
  type LlmTurn,
  type ProviderConfig,
} from '../llm/providers';
import { parseInternalHosts } from '../scm/url';
import {
  CircuitOpenError,
  CONVERSATION_LIMITS,
  runConversation,
  type ConversationInput,
} from './conversation';
import { newNonce } from './envelope';

const KINDS = ['openai', 'anthropic'] as const;
type Kind = (typeof KINDS)[number];

const NONCE = newNonce();
const USER_TEXT = 'Review this change';
// The fixed texts of the loop, as the brief spells them: a change here is a change of contract.
const WRAP_UP = 'Token budget reached: answer now, with what you have, in the required JSON.';
const TOO_MANY = 'too many calls in one turn; this one was not run';
const BAD_ARGUMENTS = 'the arguments were not valid JSON; call again';

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'grep',
    description: 'Search the repository',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
  },
];
const LIMITS: ConversationInput['limits'] = {
  maxTurns: CONVERSATION_LIMITS.maxTurns,
  maxCallsPerTurn: CONVERSATION_LIMITS.maxCallsPerTurn,
  tokenBudget: 1_000_000,
  maxOutputTokens: 50,
};

// ─── What the model says, on the wire of each kind ───────────────────────────

type Call = { id: string; name?: string; args: unknown };

/**
 * The model asks for tool calls (and says `text` beside them, when given). `tokens` null: the
 * provider sends no usage, as some servers do not.
 */
function toolTurn(
  kind: Kind,
  calls: Call[],
  tokens: number[] | null = [100, 10],
  text?: string,
): LlmReply {
  const [input = 0, output = 0] = tokens ?? [];
  const over = text === undefined ? {} : { text };
  const body =
    kind === 'openai'
      ? openAiToolCalls(
          calls.map(({ id, name = 'read_file', args }) => ({ id, name, arguments: args })),
          {
            usage: tokens === null ? null : { prompt_tokens: input, completion_tokens: output },
            ...over,
          },
        )
      : anthropicToolUse(
          calls.map(({ id, name = 'read_file', args }) => ({ id, name, input: args })),
          {
            usage: tokens === null ? null : { input_tokens: input, output_tokens: output },
            ...over,
          },
        );
  return { status: 200, body };
}

/** The model answers with text and ends its turn the way `finish` says. */
function textTurn(
  kind: Kind,
  text: string,
  tokens: number[] | null = [100, 10],
  finish: 'stop' | 'length' | 'tool' | 'refusal' = 'stop',
): LlmReply {
  const [input = 0, output = 0] = tokens ?? [];
  const body =
    kind === 'openai'
      ? openAiAnswer(text, {
          finishReason: {
            stop: 'stop',
            length: 'length',
            tool: 'tool_calls',
            refusal: 'content_filter',
          }[finish],
          usage: tokens === null ? null : { prompt_tokens: input, completion_tokens: output },
        })
      : anthropicAnswer(text, {
          stopReason: {
            stop: 'end_turn',
            length: 'max_tokens',
            tool: 'tool_use',
            refusal: 'refusal',
          }[finish],
          usage: tokens === null ? null : { input_tokens: input, output_tokens: output },
        });
  return { status: 200, body };
}

/** The provider fails with `status`; the error body says `message` when it is given. */
function failure(
  kind: Kind,
  status: number,
  over: { headers?: Record<string, string>; message?: string } = {},
): LlmReply {
  const body =
    over.message === undefined
      ? llmShape(kind === 'anthropic' ? 'anthropic-error' : 'openai-error')
      : kind === 'anthropic'
        ? { type: 'error', error: { type: 'invalid_request_error', message: over.message } }
        : {
            error: {
              message: over.message,
              type: 'invalid_request_error',
              param: null,
              code: null,
            },
          };
  return { status, ...(over.headers ? { headers: over.headers } : {}), body };
}

// ─── What the request says, on the wire of each kind ─────────────────────────

interface WireView {
  /** The names of the tools offered. */
  tools(request: RecordedLlmRequest): string[];
  /** The calls echoed back in the history, in order; `arguments` as the wire carries them. */
  echoes(request: RecordedLlmRequest): { id: string; name: string; arguments: unknown }[];
  /** The tool messages, in order. */
  results(request: RecordedLlmRequest): { id: string; text: string }[];
  /** The text of the last user message ('' when it has none, as a message of tool results). */
  lastUser(request: RecordedLlmRequest): string;
  /** The texts of the assistant messages that are not calls. */
  assistantTexts(request: RecordedLlmRequest): string[];
}

interface OpenAiWire {
  tools?: { function: { name: string } }[];
  messages: {
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  }[];
}
interface AnthropicWire {
  tools?: { name: string }[];
  messages: {
    role: string;
    content: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: string;
    }[];
  }[];
}

const WIRES: Record<Kind, WireView> = {
  openai: {
    tools: (r) => (r.json as OpenAiWire).tools?.map((t) => t.function.name) ?? [],
    echoes: (r) =>
      (r.json as OpenAiWire).messages.flatMap((m) =>
        (m.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        })),
      ),
    results: (r) =>
      (r.json as OpenAiWire).messages
        .filter((m) => m.role === 'tool')
        .map((m) => ({ id: m.tool_call_id ?? '', text: m.content ?? '' })),
    lastUser: (r) =>
      (r.json as OpenAiWire).messages.findLast((m) => m.role === 'user')?.content ?? '',
    assistantTexts: (r) =>
      (r.json as OpenAiWire).messages
        .filter((m) => m.role === 'assistant' && m.tool_calls === undefined)
        .map((m) => m.content ?? ''),
  },
  anthropic: {
    tools: (r) => (r.json as AnthropicWire).tools?.map((t) => t.name) ?? [],
    echoes: (r) =>
      (r.json as AnthropicWire).messages.flatMap((m) =>
        m.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id ?? '', name: b.name ?? '', arguments: b.input })),
      ),
    results: (r) =>
      (r.json as AnthropicWire).messages.flatMap((m) =>
        m.content
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({ id: b.tool_use_id ?? '', text: b.content ?? '' })),
      ),
    lastUser: (r) =>
      (r.json as AnthropicWire).messages
        .findLast((m) => m.role === 'user')
        ?.content.filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('') ?? '',
    assistantTexts: (r) =>
      (r.json as AnthropicWire).messages
        .filter((m) => m.role === 'assistant' && m.content.every((b) => b.type === 'text'))
        .map((m) => m.content.map((b) => b.text ?? '').join('')),
  },
};

/** A call's arguments as the model reads them back: parsed, for the wire that sends text. */
const parsedArguments = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

/** What a tool message says: the envelope's marker lines checked, the line inside parsed. */
function unwrap(text: string): { tool: string; result: string } {
  const lines = text.split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(`<<<QUALOR-DATA-${NONCE}`);
  expect(lines[2]).toBe(`QUALOR-DATA-${NONCE}>>>`);
  return JSON.parse(lines[1]!) as { tool: string; result: string };
}

/** `depth` objects inside one another, as JSON text: `{"a":{"a":…1…}}`. */
const nestedText = (depth: number): string => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
/** The same as a value, built without recursion. */
function nestedValue(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 1; level < depth; level += 1) value = { a: value };
  return value;
}

describe('runConversation: the tool loop of a review (llm.md §2.5, review.md §9.1)', () => {
  let fake: FakeLlm;
  let configs: Record<Kind, ProviderConfig>;
  let http: { internalHosts: ReadonlySet<string>; version: string };

  // One fake per test: a reply a failing test left in the queue never reaches the next test.
  beforeEach(async () => {
    fake = await createFakeLlm();
    http = { internalHosts: parseInternalHosts(fake.host), version: '0.0.0' };
    const base = {
      model: 'm-1',
      auth: 'bearer',
      jsonMode: 'json_object',
      maxTokensField: 'max_tokens',
      temperature: null,
      timeoutSeconds: 5,
    } as const;
    configs = {
      openai: { kind: 'openai', baseUrl: fake.openAiBaseUrl, ...base },
      anthropic: { kind: 'anthropic', baseUrl: fake.anthropicBaseUrl, ...base },
    };
  });
  afterEach(async () => {
    await fake.close();
  });

  /** The loop over the fake provider of `kind`, with the tools it runs and the waits it makes recorded. */
  function start(kind: Kind, over: Partial<ConversationInput> = {}) {
    const ran: LlmToolCall[] = [];
    const sleeps: number[] = [];
    const input: ConversationInput = {
      system: 'S',
      user: USER_TEXT,
      nonce: NONCE,
      tools: TOOLS,
      runTool: (call) => {
        ran.push(call);
        return Promise.resolve(`${call.name} ${JSON.stringify(call.arguments)}`);
      },
      limits: LIMITS,
      send: (conversation) => converse(configs[kind], fake.apiKey, conversation, http),
      shouldStop: () => Promise.resolve(false),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...over,
    };
    return { input, ran, sleeps };
  }

  const run = (kind: Kind, over: Partial<ConversationInput> = {}) => {
    const started = start(kind, over);
    return runConversation(started.input).then((result) => ({ result, ...started }));
  };

  describe('the conversation', () => {
    it.each(KINDS)(
      'a three-turn tool loop returns the final text with summed tokens (%s)',
      async (kind) => {
        fake.enqueue(
          toolTurn(
            kind,
            [
              { id: 'c1', args: { path: 'a.ts' } },
              { id: 'c2', name: 'grep', args: { pattern: 'x' } },
            ],
            [100, 10],
          ),
          toolTurn(kind, [{ id: 'c3', args: { path: 'b.ts' } }], [150, 12]),
          textTurn(kind, '{"findings":[]}', [200, 20]),
        );
        const { result, ran } = await run(kind);
        expect(result).toEqual({
          kind: 'answer',
          text: '{"findings":[]}',
          inputTokens: 450,
          outputTokens: 42,
          turns: 3,
          toolCalls: 3,
          budgetReached: false,
        });
        expect(ran).toEqual([
          { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'c2', name: 'grep', arguments: { pattern: 'x' } },
          { id: 'c3', name: 'read_file', arguments: { path: 'b.ts' } },
        ]);

        const wire = WIRES[kind];
        expect(fake.requests).toHaveLength(3);
        for (const request of fake.requests) {
          // The tool list goes on every turn; the output limit is the one given.
          expect(wire.tools(request)).toEqual(['read_file', 'grep']);
          expect(request.json).toMatchObject({ max_tokens: 50 });
        }
        // The last request holds the whole history, in order, and each result in the data envelope.
        const last = fake.requests[2]!;
        expect(wire.echoes(last).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
        expect(wire.results(last).map((r) => [r.id, unwrap(r.text)])).toEqual([
          ['c1', { tool: 'read_file', result: 'read_file {"path":"a.ts"}' }],
          ['c2', { tool: 'grep', result: 'grep {"pattern":"x"}' }],
          ['c3', { tool: 'read_file', result: 'read_file {"path":"b.ts"}' }],
        ]);
        expect(wire.lastUser(fake.requests[0]!)).toBe(USER_TEXT);
      },
    );
  });

  describe('the wrap-up turn', () => {
    it.each(KINDS)(
      'the tool list is sent on the wrap-up turn after tool history, and its calls are not run (%s)',
      async (kind) => {
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }]),
          toolTurn(kind, [{ id: 'c2', args: { path: 'b.ts' } }]),
          // The wrap-up answer calls a tool again, beside its text.
          toolTurn(kind, [{ id: 'c3', args: { path: 'c.ts' } }], [100, 10], '{"findings":[]}'),
        );
        const { result, ran } = await run(kind, { limits: { ...LIMITS, maxTurns: 2 } });
        expect(result).toEqual({
          kind: 'answer',
          text: '{"findings":[]}',
          inputTokens: 300,
          outputTokens: 30,
          turns: 3,
          toolCalls: 2,
          budgetReached: true,
        });
        expect(ran.map((c) => c.id)).toEqual(['c1', 'c2']);

        const wire = WIRES[kind];
        expect(fake.requests).toHaveLength(3);
        const wrapUp = fake.requests[2]!;
        expect(wire.tools(wrapUp)).toEqual(['read_file', 'grep']);
        // The history the tool list must come with (Anthropic refuses tool blocks without tools).
        expect(wire.echoes(wrapUp).map((c) => c.id)).toEqual(['c1', 'c2']);
        expect(wire.results(wrapUp)).toHaveLength(2);
        expect(wire.lastUser(wrapUp)).toBe(WRAP_UP);
        expect(wire.lastUser(fake.requests[1]!)).not.toContain('Token budget');
      },
    );

    it.each(KINDS)(
      'the wrap-up comes once 85 % of the token budget is used, not before (%s)',
      async (kind) => {
        const limits = { ...LIMITS, tokenBudget: 100_000 };
        // Turns of 30 000, 20 000, 14 000, 10 000, 6 500 and 4 500 tokens make 85 000 of the
        // 100 000 after the sixth: 85 % exactly. After each of them another turn as large, and the
        // wrap-up after it, would still fit, so the 85 % alone makes the seventh request the wrap-up.
        const turnsOf = (last: number) =>
          [
            [29_000, 1_000],
            [19_000, 1_000],
            [13_000, 1_000],
            [9_000, 1_000],
            [6_000, 500],
            [last - 100, 100],
          ].map(([input, output], n) =>
            toolTurn(kind, [{ id: `c${n + 1}`, args: { path: 'a.ts' } }], [input!, output!]),
          );
        fake.enqueue(...turnsOf(4_500), textTurn(kind, '{"findings":[]}', [10, 1]));
        const over = await run(kind, { limits });
        expect(over.result).toMatchObject({
          kind: 'answer',
          inputTokens: 29_000 + 19_000 + 13_000 + 9_000 + 6_000 + 4_400 + 10,
          outputTokens: 4 * 1_000 + 500 + 100 + 1,
          turns: 7,
          budgetReached: true,
        });
        expect(WIRES[kind].lastUser(fake.requests[6]!)).toBe(WRAP_UP);
        expect(WIRES[kind].lastUser(fake.requests[5]!)).not.toContain('Token budget');

        // 84 900 after the sixth turn: not 85 % yet, and another turn and its wrap-up would fit.
        fake.requests.length = 0;
        fake.enqueue(...turnsOf(4_400), textTurn(kind, '{"findings":[]}', [10, 1]));
        const under = await run(kind, { limits });
        expect(under.result).toMatchObject({ kind: 'answer', turns: 7, budgetReached: false });
        expect(WIRES[kind].lastUser(fake.requests[6]!)).not.toContain('Token budget');
      },
    );

    it.each(KINDS)(
      'the wrap-up comes a turn early when the next turn of tools would fit but not the wrap-up after it, whatever the share used (%s)',
      async (kind) => {
        const limits = { ...LIMITS, tokenBudget: 10_000 };
        // 3 300 used, a third of the budget. Another turn as large (the 3 300 sent again with the
        // results, and 100 written) would make under 7 000; the wrap-up after it sends all that
        // again and may write 50, which would make more than 10 000.
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [3_200, 100]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const reached = await run(kind, { limits });
        expect(reached.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: true });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).toBe(WRAP_UP);

        // Three hundred tokens fewer, and the wrap-up after another turn would fit: the model goes on.
        fake.requests.length = 0;
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [2_900, 100]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const fits = await run(kind, { limits });
        expect(fits.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: false });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).not.toContain('Token budget');
      },
    );

    it.each(KINDS)(
      'the wrap-up after the next turn is counted with the longest answer it may write (%s)',
      async (kind) => {
        // 2 900 used; another turn as large and the wrap-up after it make about 9 100 with the
        // wrap-up's answer counted at 50 tokens, and about 11 100 at 2 000.
        const reply = () => [
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [2_800, 100]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        ];
        fake.enqueue(...reply());
        const long = await run(kind, {
          limits: { ...LIMITS, tokenBudget: 10_000, maxOutputTokens: 2_000 },
        });
        expect(long.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: true });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).toBe(WRAP_UP);

        fake.requests.length = 0;
        fake.enqueue(...reply());
        const short = await run(kind, { limits: { ...LIMITS, tokenBudget: 10_000 } });
        expect(short.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: false });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).not.toContain('Token budget');
      },
    );

    it.each(KINDS)(
      'what the model wrote beside its calls is counted in the next turn and the wrap-up after it (%s)',
      async (kind) => {
        const limits = { ...LIMITS, tokenBudget: 10_000 };
        // 1 000 read and 1 500 written. The next turn sends the 1 500 again and is guessed to write
        // as much; the wrap-up after it sends both: about 10 700 in all, past the budget.
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [1_000, 1_500]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const wordy = await run(kind, { limits });
        expect(wordy.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: true });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).toBe(WRAP_UP);

        // 1 000 written: about 8 200 in all, and the model goes on.
        fake.requests.length = 0;
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [1_000, 1_000]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const terse = await run(kind, { limits });
        expect(terse.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: false });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).not.toContain('Token budget');
      },
    );

    it.each(KINDS)(
      'the wrap-up counts what the tools just added, in the next turn and in the wrap-up after it (%s)',
      async (kind) => {
        const limits = { ...LIMITS, tokenBudget: 10_000 };
        // 1 100 used, and another turn as large with its wrap-up would make about 3 700 if the tools
        // added little. The file read adds about 2 300 tokens to what both of them send, and the
        // next turn is guessed to read as much again: about 10 500, past the budget.
        const read = (text: string) => () => Promise.resolve(text);
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [1_000, 100]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const large = await run(kind, { limits, runTool: read('x'.repeat(9_000)) });
        expect(large.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: true });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).toBe(WRAP_UP);

        // A small result leaves room for another turn: the model goes on.
        fake.requests.length = 0;
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [1_000, 100]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const small = await run(kind, { limits, runTool: read('a small file') });
        expect(small.result).toMatchObject({ kind: 'answer', turns: 2, budgetReached: false });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).not.toContain('Token budget');
      },
    );

    it.each(KINDS)('a wrap-up answer that only calls tools is a bad answer (%s)', async (kind) => {
      fake.enqueue(
        toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }]),
        toolTurn(kind, [{ id: 'c2', args: { path: 'b.ts' } }]),
      );
      const { result, ran } = await run(kind, { limits: { ...LIMITS, maxTurns: 1 } });
      expect(result).toMatchObject({ kind: 'failed', reason: 'bad_answer' });
      expect(ran.map((c) => c.id)).toEqual(['c1']);
      expect(fake.requests).toHaveLength(2);
    });

    describe('a model that keeps calling tools', () => {
      // Answers every request with a call of its own, however it is asked, and the tokens given.
      const insatiable = (kind: Kind, tokens: number[] | null): LlmResponder => {
        return (request) =>
          toolTurn(
            kind,
            [{ id: `call-${fake.requests.indexOf(request)}`, args: { path: 'a.ts' } }],
            tokens,
          );
      };

      it.each(KINDS)(
        'is stopped after maxTurns turns of tools and one wrap-up, however many it asks for (%s)',
        async (kind) => {
          fake.enqueue(...Array.from({ length: 40 }, () => insatiable(kind, [100, 10])));
          const { result, ran } = await run(kind);
          // What it spent is reported although it never answered.
          expect(result).toEqual({
            kind: 'failed',
            reason: 'bad_answer',
            inputTokens: 17 * 100,
            outputTokens: 17 * 10,
            turns: 17,
            toolCalls: 16,
          });
          // The 16 turns of the limit, then the wrap-up, which is not answered with a call that runs.
          expect(fake.requests).toHaveLength(CONVERSATION_LIMITS.maxTurns + 1);
          expect(ran).toHaveLength(CONVERSATION_LIMITS.maxTurns);
          expect(WIRES[kind].lastUser(fake.requests.at(-1)!)).toBe(WRAP_UP);
        },
      );

      it.each(KINDS)('is stopped by the token budget too (%s)', async (kind) => {
        fake.enqueue(...Array.from({ length: 40 }, () => insatiable(kind, [4_000, 1_000])));
        const { result, ran } = await run(kind, { limits: { ...LIMITS, tokenBudget: 20_000 } });
        // 2 turns are 10 000 of the 20 000 tokens. A 3rd turn (its 5 000 sent again, with the
        // results, and 1 000 written) would fit, but not the wrap-up after it: the 3rd request is
        // the wrap-up, a turn before the 4th that the next call alone would make it, and so the
        // conversation stays within the budget.
        expect(result).toEqual({
          kind: 'failed',
          reason: 'bad_answer',
          inputTokens: 3 * 4_000,
          outputTokens: 3 * 1_000,
          turns: 3,
          toolCalls: 2,
        });
        expect(fake.requests).toHaveLength(3);
        expect(ran).toHaveLength(2);
        expect(WIRES[kind].lastUser(fake.requests[2]!)).toBe(WRAP_UP);
        expect(WIRES[kind].lastUser(fake.requests[1]!)).not.toBe(WRAP_UP);
      });

      it.each(KINDS)(
        'is stopped by the budget when the provider counts no tokens, on what it was sent (%s)',
        async (kind) => {
          fake.enqueue(...Array.from({ length: 40 }, () => insatiable(kind, null)));
          const limits = { ...LIMITS, tokenBudget: 8_000, maxOutputTokens: 400 };
          const { result, ran } = await run(kind, { limits });
          // Counted as nothing it would call until the turn limit; charged what it was sent and
          // the longest answer it may write, it is asked to answer after a few turns.
          expect(result).toMatchObject({ kind: 'failed', reason: 'bad_answer' });
          expect(fake.requests.length).toBeLessThan(CONVERSATION_LIMITS.maxTurns + 1);
          expect(ran.length).toBeGreaterThan(1);
          expect(WIRES[kind].lastUser(fake.requests.at(-1)!)).toBe(WRAP_UP);
          expect(ran).toHaveLength(fake.requests.length - 1);
          expect(result.turns).toBe(fake.requests.length);
          expect(result.outputTokens).toBe(fake.requests.length * 400);
          expect(result.inputTokens).toBeGreaterThan(0);
        },
      );
    });
  });

  describe('the Anthropic wire', () => {
    const rolesOf = (request: RecordedLlmRequest) =>
      (request.json as AnthropicWire).messages.map((message) => message.role);
    /** No request of the conversation has two messages of one role in a row. */
    const expectAlternating = () => {
      for (const request of fake.requests) {
        const roles = rolesOf(request);
        roles.forEach((role, i) => {
          if (i > 0) expect(role, `message ${i} of ${roles.join(', ')}`).not.toBe(roles[i - 1]);
        });
      }
    };

    it('sends the wrap-up as a text block in the user message of the tool results', async () => {
      fake.enqueue(
        toolTurn('anthropic', [
          { id: 'c1', args: { path: 'a.ts' } },
          { id: 'c2', args: { path: 'b.ts' } },
        ]),
        textTurn('anthropic', '{"findings":[]}'),
      );
      await run('anthropic', { limits: { ...LIMITS, maxTurns: 1 } });
      const wrapUp = fake.requests[1]!.json as AnthropicWire;
      expect(wrapUp.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
      expect(wrapUp.messages[2]!.content.map((block) => block.type)).toEqual([
        'tool_result',
        'tool_result',
        'text',
      ]);
      expect(WIRES.anthropic.lastUser(fake.requests[1]!)).toBe(WRAP_UP);
      expectAlternating();
    });

    it('sends a shorter-answer text after a blank cut-off answer in the user message before it', async () => {
      fake.enqueue(textTurn('anthropic', '', [10, 1], 'length'), textTurn('anthropic', 'done'));
      await run('anthropic');
      const second = fake.requests[1]!.json as AnthropicWire;
      expect(second.messages.map((message) => message.role)).toEqual(['user']);
      expect(second.messages[0]!.content.map((block) => block.text)).toEqual([
        USER_TEXT,
        expect.stringMatching(/shorter/),
      ]);
      expectAlternating();
    });

    it('keeps a shorter-answer text after an answer that has text in a message of its own', async () => {
      fake.enqueue(
        textTurn('anthropic', '{"findings":[{"ti', [10, 1], 'length'),
        textTurn('anthropic', 'done'),
      );
      await run('anthropic');
      expect(rolesOf(fake.requests[1]!)).toEqual(['user', 'assistant', 'user']);
      expectAlternating();
    });

    it('alternates in a conversation that wraps up and then asks for a shorter answer', async () => {
      fake.enqueue(
        toolTurn('anthropic', [{ id: 'c1', args: { path: 'a.ts' } }]),
        textTurn('anthropic', '', [10, 1], 'length'),
        textTurn('anthropic', '{"findings":[]}'),
      );
      const { result } = await run('anthropic', { limits: { ...LIMITS, maxTurns: 1 } });
      expect(result).toMatchObject({ kind: 'answer', budgetReached: true, turns: 3 });
      expect(rolesOf(fake.requests[2]!)).toEqual(['user', 'assistant', 'user']);
      expectAlternating();
    });
  });

  describe('the calls of a turn', () => {
    it.each(KINDS)('extra calls past the per-turn cap are answered, not run (%s)', async (kind) => {
      const calls = Array.from({ length: 10 }, (_, i) => ({
        id: `c${i + 1}`,
        args: { path: `f${i + 1}.ts` },
      }));
      fake.enqueue(toolTurn(kind, calls), textTurn(kind, '{"findings":[]}'));
      const { result, ran } = await run(kind);
      expect(result).toMatchObject({ kind: 'answer', turns: 2, toolCalls: 8 });
      expect(ran.map((c) => c.id)).toEqual(calls.slice(0, 8).map((c) => c.id));

      const wire = WIRES[kind];
      const second = fake.requests[1]!;
      // Every call is echoed, so that every call has its answer.
      expect(wire.echoes(second).map((c) => c.id)).toEqual(calls.map((c) => c.id));
      const results = wire.results(second);
      expect(results.map((r) => r.id)).toEqual(calls.map((c) => c.id));
      for (const r of results.slice(0, 8)) expect(unwrap(r.text).result).toMatch(/^read_file /);
      for (const r of results.slice(8)) expect(unwrap(r.text).result).toBe(TOO_MANY);
    });

    it.each(KINDS)('a repeated call id fails with bad_answer (%s)', async (kind) => {
      fake.enqueue(
        toolTurn(kind, [
          { id: 'c1', args: { path: 'a.ts' } },
          { id: 'c1', args: { path: 'b.ts' } },
        ]),
      );
      const { result, ran } = await run(kind);
      expect(result).toMatchObject({ kind: 'failed', reason: 'bad_answer' });
      expect(ran).toEqual([]);
      expect(fake.requests).toHaveLength(1);
    });

    it.each(KINDS)(
      'raw-string, oversized and deeply nested arguments are echoed as {} with the retry message (%s)',
      async (kind) => {
        // Far deeper than JSON.stringify can follow: a RangeError if the loop echoed it.
        const deep = nestedText(20_000);
        const calls: Call[] = [
          { id: 'c1', args: '{"path": "a.ts"' },
          { id: 'c2', args: { path: 'x'.repeat(20_000) } },
          { id: 'c3', args: JSON.parse(nestedText(25)) as unknown },
          { id: 'c4', args: 'DEEP' },
          { id: 'c5', args: { path: 'ok.ts' } },
        ];
        const reply = toolTurn(kind, calls);
        // The marker stands for the text of the deep call, which is not a value the fake can write.
        const text = JSON.stringify(reply.body);
        fake.enqueue({
          status: 200,
          body:
            kind === 'openai'
              ? text.replace('"DEEP"', JSON.stringify(deep))
              : text.replace('"DEEP"', deep),
        });
        fake.say('{"findings":[]}');
        const { result, ran } = await run(kind);

        expect(result).toMatchObject({ kind: 'answer', turns: 2, toolCalls: 1 });
        expect(ran).toEqual([{ id: 'c5', name: 'read_file', arguments: { path: 'ok.ts' } }]);
        const wire = WIRES[kind];
        const second = fake.requests[1]!;
        const echoes = wire.echoes(second);
        expect(echoes.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
        expect(echoes.map((c) => parsedArguments(c.arguments))).toEqual([
          {},
          {},
          {},
          {},
          { path: 'ok.ts' },
        ]);
        if (kind === 'openai')
          expect(echoes.slice(0, 4).map((c) => c.arguments)).toEqual(Array(4).fill('{}'));
        const results = wire.results(second).map((r) => unwrap(r.text).result);
        expect(results.slice(0, 4)).toEqual(Array(4).fill(BAD_ARGUMENTS));
        expect(results[4]).toBe('read_file {"path":"ok.ts"}');
      },
    );
  });

  describe('the end of an answer', () => {
    it.each(KINDS)('finish reason tool without calls (%s)', async (kind) => {
      // The provider layer says `tool` whenever there are calls, and sometimes when there are none.
      fake.enqueue(textTurn(kind, '{"findings":[]}', [10, 2], 'tool'));
      const text = await run(kind);
      expect(text.result).toMatchObject({
        kind: 'answer',
        text: '{"findings":[]}',
        turns: 1,
        toolCalls: 0,
      });

      fake.enqueue(textTurn(kind, '  \n', [10, 2], 'tool'));
      const blank = await run(kind);
      expect(blank.result).toMatchObject({ kind: 'failed', reason: 'bad_answer' });
    });

    it.each(KINDS)('a refusal is a bad answer, with text or without (%s)', async (kind) => {
      // A refusal may come with the words of its apology; they are not the answer.
      for (const text of ['', "I can't help with that."]) {
        fake.requests.length = 0;
        fake.enqueue(textTurn(kind, text, [10, 2], 'refusal'));
        const { result } = await run(kind);
        expect(result).toMatchObject({ kind: 'failed', reason: 'bad_answer' });
        expect(fake.requests).toHaveLength(1);
      }
    });

    it.each(KINDS)('length then length fails with bad_answer (%s)', async (kind) => {
      fake.enqueue(
        textTurn(kind, '{"findings":[{"title":"A very', [100, 50], 'length'),
        textTurn(kind, '{"findings":[{"title"', [200, 50], 'length'),
      );
      const { result } = await run(kind);
      expect(result).toMatchObject({ kind: 'failed', reason: 'bad_answer' });

      const wire = WIRES[kind];
      expect(fake.requests).toHaveLength(2);
      const second = fake.requests[1]!;
      // One more turn, asking for a shorter answer, with the tools still offered.
      expect(wire.tools(second)).toEqual(['read_file', 'grep']);
      expect(wire.lastUser(second)).toMatch(/shorter/);
      expect(wire.assistantTexts(second)).toEqual(['{"findings":[{"title":"A very']);
    });

    it.each(KINDS)('length then an answer is that answer (%s)', async (kind) => {
      fake.enqueue(
        textTurn(kind, '{"findings":[{"title":"A very', [100, 50], 'length'),
        textTurn(kind, '{"findings":[]}', [200, 20]),
      );
      const { result } = await run(kind);
      expect(result).toEqual({
        kind: 'answer',
        text: '{"findings":[]}',
        inputTokens: 300,
        outputTokens: 70,
        turns: 2,
        toolCalls: 0,
        budgetReached: false,
      });
    });
  });

  describe('an answer the caller does not accept', () => {
    const RETRY = 'Your answer did not match the required JSON; answer again with JSON only.';
    const isJson = (text: string): boolean => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    };

    it.each(KINDS)('an answer the caller accepts ends the conversation (%s)', async (kind) => {
      fake.enqueue(textTurn(kind, '{"findings":[]}'));
      const seen: string[] = [];
      const { result } = await run(kind, {
        accept: (text) => {
          seen.push(text);
          return true;
        },
      });
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 1 });
      expect(seen).toEqual(['{"findings":[]}']);
      expect(fake.requests).toHaveLength(1);
    });

    it.each(KINDS)(
      'a rejected answer is asked for once more, after it, and no tool runs then (%s)',
      async (kind) => {
        fake.enqueue(
          textTurn(kind, 'Here is my review.', [100, 10]),
          // A call in the answer asked for again is not run: its text is the answer.
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [150, 20], '{"findings":[]}'),
        );
        const { result, ran } = await run(kind, { accept: isJson });
        expect(result).toEqual({
          kind: 'answer',
          text: '{"findings":[]}',
          inputTokens: 250,
          outputTokens: 30,
          turns: 2,
          toolCalls: 0,
          budgetReached: false,
        });
        expect(ran).toEqual([]);
        const wire = WIRES[kind];
        expect(fake.requests).toHaveLength(2);
        const second = fake.requests[1]!;
        // The answer, then one user turn that asks again; the tools are still offered.
        expect(wire.assistantTexts(second)).toEqual(['Here is my review.']);
        expect(wire.lastUser(second)).toBe(RETRY);
        expect(wire.tools(second)).toEqual(['read_file', 'grep']);
      },
    );

    it.each(KINDS)('a second rejection ends as a bad answer (%s)', async (kind) => {
      fake.enqueue(textTurn(kind, 'First.', [100, 10]), textTurn(kind, 'Second.', [150, 10]));
      const { result } = await run(kind, { accept: isJson });
      expect(result).toEqual({
        kind: 'failed',
        reason: 'bad_answer',
        inputTokens: 250,
        outputTokens: 20,
        turns: 2,
        toolCalls: 0,
      });
      expect(fake.requests).toHaveLength(2);
    });

    it.each(KINDS)(
      'a rejection that brings a text asks again with that text, not the loop’s (%s)',
      async (kind) => {
        const WHY = 'That is no JSON: answer again with a key named findings.';
        fake.enqueue(
          textTurn(kind, 'Here is my review.', [100, 10]),
          textTurn(kind, '{"findings":[]}', [150, 20]),
        );
        const { result } = await run(kind, {
          accept: (text) => (isJson(text) ? true : WHY),
        });
        expect(result).toEqual({
          kind: 'answer',
          text: '{"findings":[]}',
          inputTokens: 250,
          outputTokens: 30,
          turns: 2,
          toolCalls: 0,
          budgetReached: false,
        });
        const second = fake.requests[1]!;
        // The answer stays in the history, and the one user turn after it is the text given.
        expect(WIRES[kind].assistantTexts(second)).toEqual(['Here is my review.']);
        expect(WIRES[kind].lastUser(second)).toBe(WHY);
      },
    );

    it.each(KINDS)(
      'a rejection that brings a blank text asks with the loop’s own, and a second one is a bad answer (%s)',
      async (kind) => {
        fake.enqueue(textTurn(kind, 'First.', [100, 10]), textTurn(kind, '{"findings":[]}'));
        const blank = await run(kind, { accept: (text) => (isJson(text) ? true : '  ') });
        expect(blank.result).toMatchObject({ kind: 'answer', turns: 2 });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).toBe(RETRY);

        // The question is asked once, whatever it says: a second answer that is rejected ends it.
        fake.requests.length = 0;
        fake.enqueue(textTurn(kind, 'First.', [100, 10]), textTurn(kind, 'Second.', [150, 10]));
        const twice = await run(kind, { accept: () => 'Not that: answer again.' });
        expect(twice.result).toEqual({
          kind: 'failed',
          reason: 'bad_answer',
          inputTokens: 250,
          outputTokens: 20,
          turns: 2,
          toolCalls: 0,
        });
        expect(fake.requests).toHaveLength(2);
        expect(WIRES[kind].lastUser(fake.requests[1]!)).toBe('Not that: answer again.');
      },
    );

    it.each(KINDS)(
      'the turn that asks again may go past the token budget, as the wrap-up may (%s)',
      async (kind) => {
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [100, 10]),
          // The answer to the wrap-up, which is not JSON.
          textTurn(kind, 'Not JSON.', [200, 10]),
          textTurn(kind, '{"findings":[]}', [300, 10]),
        );
        const { result } = await run(kind, {
          accept: isJson,
          limits: { ...LIMITS, tokenBudget: 150 },
        });
        expect(result).toMatchObject({
          kind: 'answer',
          text: '{"findings":[]}',
          turns: 3,
          toolCalls: 1,
          budgetReached: true,
        });
        expect(fake.requests).toHaveLength(3);
        expect(WIRES[kind].lastUser(fake.requests[2]!)).toBe(RETRY);
      },
    );

    it.each(KINDS)(
      'a cut-off answer is asked for shorter before it is checked (%s)',
      async (kind) => {
        fake.enqueue(
          textTurn(kind, '{"findings":[{"title":"A very', [100, 50], 'length'),
          textTurn(kind, 'Shorter, but not JSON.', [200, 20]),
          textTurn(kind, '{"findings":[]}', [300, 20]),
        );
        const { result } = await run(kind, { accept: isJson });
        expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 3 });
        expect(WIRES[kind].lastUser(fake.requests[1]!)).toMatch(/shorter/);
        expect(WIRES[kind].lastUser(fake.requests[2]!)).toBe(RETRY);
      },
    );
  });

  describe('provider errors', () => {
    it.each(KINDS)(
      'rate limits are retried after Retry-After, at most twice (%s)',
      async (kind) => {
        fake.enqueue(
          failure(kind, 429, { headers: { 'retry-after': '7' } }),
          // A provider that asks for more than a minute is waited for a minute.
          failure(kind, 429, { headers: { 'retry-after': '600' } }),
          textTurn(kind, '{"findings":[]}'),
        );
        const waits = await run(kind);
        expect(waits.result).toMatchObject({ kind: 'answer', turns: 1 });
        expect(waits.sleeps).toEqual([7_000, 60_000]);
        expect(fake.requests).toHaveLength(3);

        // The third limit fails the conversation.
        fake.requests.length = 0;
        fake.enqueue(
          failure(kind, 429, { headers: { 'retry-after': '1' } }),
          failure(kind, 429, { headers: { 'retry-after': '2' } }),
          failure(kind, 429, { headers: { 'retry-after': '3' } }),
        );
        const given = await run(kind);
        expect(given.result).toMatchObject({ kind: 'failed', reason: 'provider_error' });
        expect(given.sleeps).toEqual([1_000, 2_000]);
        expect(fake.requests).toHaveLength(3);
      },
    );

    it.each(KINDS)(
      'a rate limit with no usable Retry-After waits the backoff (%s)',
      async (kind) => {
        fake.enqueue(
          failure(kind, 429),
          failure(kind, 429, { headers: { 'retry-after': '0' } }),
          textTurn(kind, '{"findings":[]}'),
        );
        const { result, sleeps } = await run(kind);
        expect(result).toMatchObject({ kind: 'answer' });
        // 5 s when the provider named none; never less than a second when it said 0.
        expect(sleeps).toEqual([5_000, 1_000]);
      },
    );

    it.each(KINDS)('an unavailable provider is retried once (%s)', async (kind) => {
      fake.enqueue(failure(kind, 503), failure(kind, 500));
      const failed = await run(kind);
      expect(failed.result).toMatchObject({ kind: 'failed', reason: 'provider_error' });
      expect(failed.sleeps).toEqual([5_000]);
      expect(fake.requests).toHaveLength(2);

      fake.requests.length = 0;
      fake.enqueue(failure(kind, 502), textTurn(kind, '{"findings":[]}'));
      const recovered = await run(kind);
      expect(recovered.result).toMatchObject({ kind: 'answer', turns: 1 });
      expect(fake.requests).toHaveLength(2);
    });

    it.each(KINDS)('a refused key or request is not retried (%s)', async (kind) => {
      for (const status of [401, 403, 400, 413]) {
        fake.requests.length = 0;
        fake.enqueue(failure(kind, status));
        const { result, sleeps } = await run(kind);
        expect(result).toMatchObject({ kind: 'failed', reason: 'provider_error' });
        expect(sleeps).toEqual([]);
        expect(fake.requests).toHaveLength(1);
      }
    });

    it.each(KINDS)('retries the call of a later turn as well (%s)', async (kind) => {
      fake.enqueue(
        toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }]),
        failure(kind, 429, { headers: { 'retry-after': '3' } }),
        textTurn(kind, '{"findings":[]}'),
      );
      const { result, sleeps } = await run(kind);
      expect(result).toMatchObject({ kind: 'answer', turns: 2, toolCalls: 1 });
      expect(sleeps).toEqual([3_000]);
      // The retry sends the same history again.
      expect(fake.requests[2]!.body).toBe(fake.requests[1]!.body);
    });

    describe.each([400, 404, 422])('HTTP %i', (status) => {
      it.each(KINDS)(
        'a tools refusal on the first turn is provider_no_tools (%s)',
        async (kind) => {
          fake.enqueue(failure(kind, status, { message: 'This model does not support tools' }));
          const { result, sleeps } = await run(kind);
          expect(result).toMatchObject({ kind: 'failed', reason: 'provider_no_tools' });
          expect(sleeps).toEqual([]);
          expect(fake.requests).toHaveLength(1);
        },
      );

      it.each(KINDS)('a tools refusal on a later turn is a provider error (%s)', async (kind) => {
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }]),
          failure(kind, status, { message: 'This model does not support tools' }),
        );
        const { result } = await run(kind);
        expect(result).toMatchObject({ kind: 'failed', reason: 'provider_error' });
        expect(fake.requests).toHaveLength(2);
      });
    });

    it.each(KINDS)('a refusal that does not name tools is a provider error (%s)', async (kind) => {
      fake.enqueue(failure(kind, 400, { message: 'Model not found' }));
      const { result } = await run(kind);
      expect(result).toMatchObject({ kind: 'failed', reason: 'provider_error' });
    });
  });

  describe('stopping', () => {
    it.each(KINDS)('shouldStop true stops before the next call (%s)', async (kind) => {
      fake.enqueue(
        toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }]),
        textTurn(kind, '{"findings":[]}'),
      );
      let asked = 0;
      const { result, ran } = await run(kind, {
        // Not stopped before the first call, stopped before the second.
        shouldStop: () => Promise.resolve(++asked > 1),
      });
      expect(result).toMatchObject({ kind: 'stopped' });
      expect(fake.requests).toHaveLength(1);
      expect(ran).toHaveLength(1);
      expect(asked).toBe(2);
    });

    it.each(KINDS)('is checked before the first call, and sends nothing (%s)', async (kind) => {
      fake.enqueue(textTurn(kind, '{"findings":[]}'));
      const { result } = await run(kind, { shouldStop: () => Promise.resolve(true) });
      expect(result).toMatchObject({ kind: 'stopped' });
      expect(fake.requests).toHaveLength(0);
    });

    it.each(KINDS)('is checked again before a retry, after the wait (%s)', async (kind) => {
      fake.enqueue(
        failure(kind, 429, { headers: { 'retry-after': '5' } }),
        textTurn(kind, '{"findings":[]}'),
      );
      let asked = 0;
      const { result, sleeps } = await run(kind, {
        shouldStop: () => Promise.resolve(++asked > 1),
      });
      expect(result).toMatchObject({ kind: 'stopped' });
      expect(sleeps).toEqual([5_000]);
      expect(fake.requests).toHaveLength(1);
    });

    it.each(KINDS)('a signal that aborts wakes the wait of a retry at once (%s)', async (kind) => {
      fake.enqueue(
        failure(kind, 429, { headers: { 'retry-after': '60' } }),
        textTurn(kind, '{"findings":[]}'),
      );
      const controller = new AbortController();
      const began = Date.now();
      // The real wait, a minute long: the server stops while the loop sits in it.
      const running = run(kind, {
        sleep: undefined,
        signal: controller.signal,
        shouldStop: () => Promise.resolve(controller.signal.aborted),
      });
      await vi.waitFor(() => expect(fake.requests).toHaveLength(1), { timeout: 10_000 });
      controller.abort();
      const { result } = await running;
      expect(result).toMatchObject({ kind: 'stopped' });
      expect(fake.requests).toHaveLength(1);
      expect(Date.now() - began).toBeLessThan(10_000);
    });

    it.each(KINDS)('a signal that has aborted already makes no wait at all (%s)', async (kind) => {
      fake.enqueue(
        failure(kind, 503),
        failure(kind, 429, { headers: { 'retry-after': '60' } }),
        textTurn(kind, '{"findings":[]}'),
      );
      const began = Date.now();
      let asked = 0;
      const { result } = await run(kind, {
        sleep: undefined,
        signal: AbortSignal.abort(),
        // Not stopped before the first call: the abort is seen by the wait only.
        shouldStop: () => Promise.resolve(++asked > 1),
      });
      expect(result).toMatchObject({ kind: 'stopped' });
      expect(fake.requests).toHaveLength(1);
      expect(Date.now() - began).toBeLessThan(2_000);
    });

    it.each(KINDS)(
      'hands its signal to the wait it makes, whichever wait it is (%s)',
      async (kind) => {
        fake.enqueue(
          failure(kind, 429, { headers: { 'retry-after': '3' } }),
          failure(kind, 429, { headers: { 'retry-after': '4' } }),
          textTurn(kind, '{"findings":[]}'),
        );
        const controller = new AbortController();
        const given: (AbortSignal | undefined)[] = [];
        const waits = (signals: (AbortSignal | undefined)[]): ConversationInput['sleep'] => {
          return (_ms, signal) => {
            signals.push(signal);
            return Promise.resolve();
          };
        };
        const withSignal = await run(kind, { signal: controller.signal, sleep: waits(given) });
        expect(withSignal.result).toMatchObject({ kind: 'answer' });
        expect(given).toEqual([controller.signal, controller.signal]);

        fake.requests.length = 0;
        fake.enqueue(
          failure(kind, 429, { headers: { 'retry-after': '3' } }),
          textTurn(kind, '{"findings":[]}'),
        );
        const without: (AbortSignal | undefined)[] = [];
        const noSignal = await run(kind, { sleep: waits(without) });
        expect(noSignal.result).toMatchObject({ kind: 'answer' });
        expect(without).toEqual([undefined]);
      },
    );
  });
});

// ─── The loop alone: a scripted provider, for what the wires cannot show ──────

const turn = (text: string, over: Partial<LlmTurn> = {}): LlmTurn => ({
  text,
  finishReason: 'stop',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: null,
  ...over,
});
const callTurn = (calls: LlmToolCall[], over: Partial<LlmTurn> = {}): LlmTurn =>
  turn('', { finishReason: 'tool', toolCalls: calls, ...over });
const FILE = { path: 'a.ts' };
const call = (id: string, args: unknown = FILE, name = 'read_file'): LlmToolCall => ({
  id,
  name,
  arguments: args,
});

/**
 * What the loop charges for the input it sent, and guesses for a part of it: a quarter of the
 * bytes of its JSON, rounded up.
 */
const quarterOfBytes = (sent: LlmConversation | readonly LlmMessage[]) =>
  Math.ceil(Buffer.byteLength(JSON.stringify(sent), 'utf8') / 4);

describe('runConversation with a scripted provider', () => {
  /** A provider that plays `steps` in order (an Error is thrown) and keeps what it was sent. */
  function scripted(...steps: (LlmTurn | Error)[]) {
    const seen: LlmConversation[] = [];
    const ran: LlmToolCall[] = [];
    const sleeps: number[] = [];
    const queue = [...steps];
    const input: ConversationInput = {
      system: 'S',
      user: USER_TEXT,
      nonce: NONCE,
      tools: TOOLS,
      runTool: (c) => {
        ran.push(c);
        return Promise.resolve('ok');
      },
      limits: LIMITS,
      send: (conversation) => {
        seen.push(conversation);
        const step = queue.shift();
        if (step === undefined) return Promise.reject(new Error('the script ran out'));
        return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
      },
      shouldStop: () => Promise.resolve(false),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
    return { input, seen, ran, sleeps };
  }

  it('sends the system prompt, the user message, the tools and the output limit on the first turn', async () => {
    const s = scripted(turn('done'));
    await runConversation(s.input);
    expect(s.seen).toEqual([
      {
        system: 'S',
        messages: [{ role: 'user', text: USER_TEXT }],
        tools: TOOLS,
        maxOutputTokens: 50,
      },
    ]);
  });

  describe('the arguments a model sends', () => {
    /** The result a one-call turn gives for `args`, and what the tool and the history saw of them. */
    async function withArguments(args: unknown) {
      // Built by hand: `call` gives an argument that is not there its default.
      const s = scripted(
        callTurn([{ id: 'c1', name: 'read_file', arguments: args }]),
        turn('done'),
      );
      const result = await runConversation(s.input);
      const history = s.seen[1]!.messages;
      return { result, ran: s.ran, history };
    }
    const echoed = (history: readonly LlmMessage[]) =>
      history.flatMap((m) => (m.role === 'assistant' ? m.toolCalls.map((c) => c.arguments) : []));
    const answer = (history: readonly LlmMessage[]) =>
      history.flatMap((m) => (m.role === 'tool' ? [unwrap(m.text).result] : []));

    it.each([
      ['a string', '{"path": "a.ts"'],
      ['a list', ['a.ts']],
      ['a number', 7],
      ['a boolean', true],
    ])('%s is not arguments: it is echoed as {} and the model is told', async (_name, args) => {
      const { ran, history } = await withArguments(args);
      expect(ran).toEqual([]);
      expect(echoed(history)).toEqual([{}]);
      expect(answer(history)).toEqual([BAD_ARGUMENTS]);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('%s is no arguments: the tool is run with {}', async (_name, args) => {
      const { ran, history } = await withArguments(args);
      expect(ran).toEqual([{ id: 'c1', name: 'read_file', arguments: {} }]);
      expect(echoed(history)).toEqual([{}]);
    });

    it('allows arguments nested 20 levels and refuses 21', async () => {
      const ok = await withArguments(nestedValue(CONVERSATION_LIMITS.maxArgumentDepth));
      expect(ok.ran).toHaveLength(1);
      const tooDeep = await withArguments(nestedValue(CONVERSATION_LIMITS.maxArgumentDepth + 1));
      expect(tooDeep.ran).toEqual([]);
      expect(answer(tooDeep.history)).toEqual([BAD_ARGUMENTS]);
    });

    it('refuses nesting that JSON.stringify cannot follow, without a RangeError', async () => {
      const { result, ran, history } = await withArguments(nestedValue(100_000));
      expect(result).toMatchObject({ kind: 'answer' });
      expect(ran).toEqual([]);
      expect(echoed(history)).toEqual([{}]);
    });

    it('allows 16 KiB of arguments and refuses one byte more', async () => {
      const overhead = Buffer.byteLength(JSON.stringify({ path: '' }));
      const size = (bytes: number) => ({ path: 'x'.repeat(bytes - overhead) });
      expect(Buffer.byteLength(JSON.stringify(size(16_384)))).toBe(16_384);
      const ok = await withArguments(size(16_384));
      expect(ok.ran).toHaveLength(1);
      const over = await withArguments(size(16_385));
      expect(over.ran).toEqual([]);
      expect(answer(over.history)).toEqual([BAD_ARGUMENTS]);
    });

    it('measures the size in bytes, not characters', async () => {
      // 6 000 three-byte characters: 18 000 bytes.
      const { ran } = await withArguments({ path: '€'.repeat(6_000) });
      expect(ran).toEqual([]);
    });
  });

  describe('the calls of one turn', () => {
    it('counts the calls past the cap whatever their arguments', async () => {
      const calls = [
        call('c1'),
        call('c2', 'raw'),
        call('c3'),
        // Past the cap of 2: answered as too many, also when the arguments are bad.
        call('c4'),
        call('c5', 'raw'),
      ];
      const s = scripted(callTurn(calls), turn('done'));
      s.input.limits = { ...LIMITS, maxCallsPerTurn: 2 };
      await runConversation(s.input);
      expect(s.ran.map((c) => c.id)).toEqual(['c1']);
      const answers = s.seen[1]!.messages.flatMap((m) =>
        m.role === 'tool' ? [[m.callId, unwrap(m.text).result]] : [],
      );
      expect(answers).toEqual([
        ['c1', 'ok'],
        ['c2', BAD_ARGUMENTS],
        ['c3', TOO_MANY],
        ['c4', TOO_MANY],
        ['c5', TOO_MANY],
      ]);
    });

    it('runs the calls one after the other, in order', async () => {
      const order: string[] = [];
      const s = scripted(callTurn([call('c1'), call('c2')]), turn('done'));
      s.input.runTool = async (c) => {
        order.push(`start ${c.id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${c.id}`);
        return 'ok';
      };
      await runConversation(s.input);
      expect(order).toEqual(['start c1', 'end c1', 'start c2', 'end c2']);
    });

    it('does not fail on an id used again in a later turn', async () => {
      const s = scripted(callTurn([call('c1')]), callTurn([call('c1')]), turn('done'));
      expect(await runConversation(s.input)).toMatchObject({ kind: 'answer', toolCalls: 2 });
    });

    it('keeps the text a model says beside its calls', async () => {
      const s = scripted(callTurn([call('c1')], { text: 'Looking at the file.' }), turn('done'));
      await runConversation(s.input);
      expect(s.seen[1]!.messages[1]).toEqual({
        role: 'assistant',
        text: 'Looking at the file.',
        toolCalls: [call('c1')],
      });
    });

    it('gives the history to each turn as it was then', async () => {
      const s = scripted(callTurn([call('c1')]), turn('done'));
      await runConversation(s.input);
      expect(s.seen[0]!.messages).toEqual([{ role: 'user', text: USER_TEXT }]);
      expect(s.seen[1]!.messages).toHaveLength(3);
    });

    it('wraps the loop’s own tool messages in the data envelope, under the name of the tool', async () => {
      const s = scripted(callTurn([call('c1', 'raw', 'grep')]), turn('done'));
      await runConversation(s.input);
      const message = s.seen[1]!.messages[2]!;
      expect(message).toMatchObject({ role: 'tool', callId: 'c1', name: 'grep' });
      expect(unwrap((message as { text: string }).text)).toEqual({
        tool: 'grep',
        result: BAD_ARGUMENTS,
      });
    });
  });

  describe('turns, tokens and the wrap-up', () => {
    it('wraps up after maxTurns turns of tools, never sooner', async () => {
      const s = scripted(
        callTurn([call('c1')]),
        callTurn([call('c2')]),
        callTurn([call('c3')]),
        turn('done'),
      );
      s.input.limits = { ...LIMITS, maxTurns: 3 };
      const result = await runConversation(s.input);
      expect(result).toMatchObject({ kind: 'answer', turns: 4, budgetReached: true });
      const lastUser = (n: number) => s.seen[n]!.messages.findLast((m) => m.role === 'user');
      expect(lastUser(2)).toEqual({ role: 'user', text: USER_TEXT });
      expect(lastUser(3)).toEqual({ role: 'user', text: WRAP_UP });
    });

    it('wraps up exactly when what was used, the next turn and the wrap-up after it reach the budget', async () => {
      // One turn of tools that was sent 100 tokens and wrote 20, then the answer.
      const play = async (tokenBudget: number) => {
        const s = scripted(
          callTurn([call('c1')], { usage: { inputTokens: 100, outputTokens: 20 } }),
          turn('done'),
        );
        s.input.limits = { ...LIMITS, tokenBudget, maxOutputTokens: 30 };
        return { s, result: await runConversation(s.input) };
      };
      const { s } = await play(1_000_000);
      // What the tool answered, as the next call sends it, at a quarter of its bytes.
      const grown = quarterOfBytes(s.seen[1]!.messages.slice(2));
      // The next turn sends the 100 and the 20 again with what the tool answered, and writes 20;
      // the wrap-up after it sends all that again with 20 and as much from its tools, and may
      // write 30.
      const next = 100 + 20 + grown + 20;
      const wrapUpAfter = 100 + 20 + grown + 20 + grown + 30;
      const due = 100 + 20 + next + wrapUpAfter;
      expect((await play(due)).result).toMatchObject({ kind: 'answer', budgetReached: true });
      expect((await play(due + 1)).result).toMatchObject({ kind: 'answer', budgetReached: false });
    });

    it('sends the tools and the output limit on the wrap-up turn too', async () => {
      const s = scripted(callTurn([call('c1')]), turn('done'));
      s.input.limits = { ...LIMITS, maxTurns: 1 };
      await runConversation(s.input);
      for (const conversation of s.seen) {
        expect(conversation.tools).toEqual(TOOLS);
        expect(conversation.maxOutputTokens).toBe(50);
      }
      expect(s.seen).toHaveLength(2);
    });

    describe('a provider that does not count tokens', () => {
      const unknown = { inputTokens: null, outputTokens: null };

      it('is charged a quarter of the bytes it was sent and the longest answer it may write, and the result says so', async () => {
        const s = scripted(
          callTurn([call('c1')], { usage: unknown }),
          turn('done', { usage: unknown }),
        );
        const result = await runConversation(s.input);
        expect(result).toEqual({
          kind: 'answer',
          text: 'done',
          inputTokens: quarterOfBytes(s.seen[0]!) + quarterOfBytes(s.seen[1]!),
          outputTokens: 2 * LIMITS.maxOutputTokens,
          turns: 2,
          toolCalls: 1,
          budgetReached: false,
        });
      });

      it('is charged for the bytes of the JSON it was sent, not for its characters', async () => {
        const s = scripted(turn('done', { usage: unknown }));
        // Characters of two, three and four bytes.
        s.input.user = 'é€😀'.repeat(100);
        const result = await runConversation(s.input);
        const json = JSON.stringify(s.seen[0]);
        expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(json.length);
        expect(result.inputTokens).toBe(Math.ceil(Buffer.byteLength(json, 'utf8') / 4));
      });

      it('is charged only for the count it did not give', async () => {
        const s = scripted(
          callTurn([call('c1')], { usage: { inputTokens: 7, outputTokens: null } }),
          turn('done', { usage: { inputTokens: null, outputTokens: 9 } }),
        );
        const result = await runConversation(s.input);
        expect(result).toMatchObject({
          inputTokens: 7 + quarterOfBytes(s.seen[1]!),
          outputTokens: LIMITS.maxOutputTokens + 9,
        });
      });

      it('is asked to answer once its guessed tokens reach the budget', async () => {
        // Always calls, never counts; 400 tokens are charged for each answer.
        const steps = Array.from({ length: 20 }, (_, i) =>
          callTurn([call(`c${i}`)], { usage: unknown }),
        );
        const s = scripted(...steps);
        s.input.limits = { ...LIMITS, tokenBudget: 8_000, maxOutputTokens: 400 };
        const result = await runConversation(s.input);
        expect(result).toMatchObject({ kind: 'failed', reason: 'bad_answer' });
        // Not the 17 requests of the turn limit: the guess ends the calls far sooner.
        expect(s.seen.length).toBeLessThan(CONVERSATION_LIMITS.maxTurns + 1);
        expect(s.ran.length).toBeGreaterThan(1);
        expect(s.seen.at(-1)!.messages.at(-1)).toEqual({ role: 'user', text: WRAP_UP });
        expect(result.inputTokens).toBe(
          s.seen.reduce((sum, conversation) => sum + quarterOfBytes(conversation), 0),
        );
        expect(result.outputTokens).toBe(s.seen.length * 400);
      });

      it('serialises the conversation only for a call whose input it has to estimate', async () => {
        const stringify = vi.spyOn(JSON, 'stringify');
        const serialisedConversations = () =>
          stringify.mock.calls.filter(
            ([value]) =>
              typeof value === 'object' &&
              value !== null &&
              'system' in value &&
              'messages' in value,
          ).length;
        try {
          await runConversation(scripted(callTurn([call('c1')]), turn('done')).input);
          expect(serialisedConversations()).toBe(0);

          stringify.mockClear();
          await runConversation(
            scripted(
              callTurn([call('c1')], { usage: { inputTokens: null, outputTokens: 5 } }),
              turn('done'),
            ).input,
          );
          expect(serialisedConversations()).toBe(1);

          stringify.mockClear();
          await runConversation(
            scripted(
              callTurn([call('c1')], { usage: { inputTokens: 5, outputTokens: null } }),
              turn('done'),
            ).input,
          );
          expect(serialisedConversations()).toBe(0);
        } finally {
          stringify.mockRestore();
        }
      });
    });

    it('asks for a shorter answer once, also after a wrap-up', async () => {
      const s = scripted(
        callTurn([call('c1')]),
        turn('{"findings":[{"ti', { finishReason: 'length' }),
        turn('{"findings":[]}'),
      );
      s.input.limits = { ...LIMITS, maxTurns: 1 };
      const result = await runConversation(s.input);
      expect(result).toMatchObject({
        kind: 'answer',
        text: '{"findings":[]}',
        budgetReached: true,
      });
      const last = s.seen[2]!.messages;
      expect(last.at(-1)).toMatchObject({ role: 'user' });
      expect((last.at(-1) as { text: string }).text).toMatch(/shorter/);
      expect(last.at(-2)).toEqual({
        role: 'assistant',
        text: '{"findings":[{"ti',
        toolCalls: [],
      });
    });

    it('does not echo a cut-off answer that has no text', async () => {
      const s = scripted(turn('', { finishReason: 'length' }), turn('done'));
      await runConversation(s.input);
      const messages = s.seen[1]!.messages;
      expect(messages.map((m) => m.role)).toEqual(['user', 'user']);
    });

    it('answers a cut-off call as bad arguments, and goes on', async () => {
      // The provider says `tool` when there are calls, so a cut-off call is a call with raw arguments.
      const s = scripted(
        callTurn([call('c1', '{"path": "a.t')], { text: 'Reading' }),
        turn('done'),
      );
      const result = await runConversation(s.input);
      expect(result).toMatchObject({ kind: 'answer', toolCalls: 0, turns: 2 });
    });
  });

  describe('what a conversation reports, whatever its end', () => {
    // Two turns of 10 + 5 tokens, and three calls run.
    const spent = { inputTokens: 20, outputTokens: 10, turns: 2, toolCalls: 3 };
    const twoTurns = () => [callTurn([call('c1')]), callTurn([call('c2'), call('c3')])];

    it('a failure carries what was spent before it', async () => {
      const s = scripted(...twoTurns(), new LlmError('rejected', 'refused', 400));
      expect(await runConversation(s.input)).toEqual({
        kind: 'failed',
        reason: 'provider_error',
        ...spent,
      });
    });

    it('a bad answer carries the turn that was one', async () => {
      const s = scripted(callTurn([call('c1')]), turn('  '));
      expect(await runConversation(s.input)).toEqual({
        kind: 'failed',
        reason: 'bad_answer',
        inputTokens: 20,
        outputTokens: 10,
        turns: 2,
        toolCalls: 1,
      });
    });

    it('a call id used twice carries the tokens of its turn and runs none of its calls', async () => {
      const s = scripted(callTurn([call('c1')]), callTurn([call('c2'), call('c2')]));
      expect(await runConversation(s.input)).toEqual({
        kind: 'failed',
        reason: 'bad_answer',
        inputTokens: 20,
        outputTokens: 10,
        turns: 2,
        toolCalls: 1,
      });
    });

    it('a stop carries what was spent before it', async () => {
      const s = scripted(...twoTurns(), turn('never asked'));
      let asked = 0;
      // Not stopped before the first call and the second, stopped before the third.
      s.input.shouldStop = () => Promise.resolve(++asked > 2);
      expect(await runConversation(s.input)).toEqual({ kind: 'stopped', ...spent });
    });

    it('an open circuit carries what was spent before it', async () => {
      const s = scripted(...twoTurns(), new CircuitOpenError());
      expect(await runConversation(s.input)).toEqual({
        kind: 'failed',
        reason: 'provider_error',
        ...spent,
      });
    });

    it('a stop before the first call, and a first call refused for its tools, carry nothing', async () => {
      const none = { inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 };
      const stopped = scripted(turn('never asked'));
      stopped.input.shouldStop = () => Promise.resolve(true);
      expect(await runConversation(stopped.input)).toEqual({ kind: 'stopped', ...none });

      const refused = scripted(new LlmError('rejected', 'refused', 400, null, true));
      expect(await runConversation(refused.input)).toEqual({
        kind: 'failed',
        reason: 'provider_no_tools',
        ...none,
      });
    });

    it('a failure after turns the provider did not count carries the guessed tokens, and the input of the call that timed out', async () => {
      const unknown = { inputTokens: null, outputTokens: null };
      const s = scripted(
        callTurn([call('c1')], { usage: unknown }),
        new LlmError('timeout', 'The model did not answer within 60 s'),
        new LlmError('unavailable', 'The model provider could not be reached'),
      );
      const result = await runConversation(s.input);
      expect(result).toMatchObject({ kind: 'failed', reason: 'provider_error', turns: 1 });
      // The output of a call that was not answered is not known and is not charged.
      expect(result.outputTokens).toBe(LIMITS.maxOutputTokens);
      // The call that timed out was sent, and most likely billed for its input; the one that could
      // not be reached cost nothing.
      expect(result.inputTokens).toBe(quarterOfBytes(s.seen[0]!) + quarterOfBytes(s.seen[1]!));
    });
  });

  describe('the input of a call that was not answered', () => {
    const timeout = new LlmError('timeout', 'The model did not answer within 60 s');
    const unreadable = new LlmError(
      'bad_answer',
      'The answer of the provider was not understood',
      200,
    );

    it('is charged for a call that timed out, and again for the retry that timed out', async () => {
      const s = scripted(timeout, timeout);
      // Characters of two, three and four bytes: the guess is made from the bytes.
      s.input.user = 'é€😀'.repeat(100);
      expect(await runConversation(s.input)).toEqual({
        kind: 'failed',
        reason: 'provider_error',
        inputTokens: quarterOfBytes(s.seen[0]!) + quarterOfBytes(s.seen[1]!),
        outputTokens: 0,
        turns: 0,
        toolCalls: 0,
      });
    });

    it('is charged for a call that timed out, beside what its retry counted', async () => {
      const s = scripted(timeout, turn('done'));
      expect(await runConversation(s.input)).toEqual({
        kind: 'answer',
        text: 'done',
        budgetReached: false,
        inputTokens: quarterOfBytes(s.seen[0]!) + 10,
        outputTokens: 5,
        turns: 1,
        toolCalls: 0,
      });
    });

    it('is charged for a call that timed out when the conversation is stopped after it', async () => {
      const s = scripted(timeout, turn('never asked'));
      let asked = 0;
      s.input.shouldStop = () => Promise.resolve(++asked > 1);
      expect(await runConversation(s.input)).toEqual({
        kind: 'stopped',
        inputTokens: quarterOfBytes(s.seen[0]!),
        outputTokens: 0,
        turns: 0,
        toolCalls: 0,
      });
    });

    it('is charged for an answer that could not be read, which ends the conversation', async () => {
      const s = scripted(callTurn([call('c1')]), unreadable, turn('never asked'));
      expect(await runConversation(s.input)).toEqual({
        kind: 'failed',
        reason: 'provider_error',
        inputTokens: 10 + quarterOfBytes(s.seen[1]!),
        outputTokens: 5,
        turns: 1,
        toolCalls: 1,
      });
      expect(s.seen).toHaveLength(2);
    });

    it.each([
      [
        'an unreachable provider',
        new LlmError('unavailable', 'The model provider could not be reached'),
      ],
      ['a rate limit', new LlmError('rate_limited', 'limited', 429, 1)],
      ['a refusal of the key', new LlmError('refused_key', 'refused', 401)],
      ['a refusal of the request', new LlmError('rejected', 'refused', 400)],
      ['an address that is not allowed', new LlmError('url_not_allowed', 'not allowed')],
    ])('is not charged for %s', async (_name, error) => {
      // A rate limit is tried twice more and an unreachable provider once; the rest end it at once.
      const s = scripted(error, error, error);
      expect(await runConversation(s.input)).toMatchObject({
        kind: 'failed',
        inputTokens: 0,
        outputTokens: 0,
      });
    });

    it('counts toward the budget, so that the wrap-up comes when the calls that failed made it due', async () => {
      const play = (tokenBudget: number) => {
        // A call with a tool, a call that times out, its retry with another tool, and the answer.
        const s = scripted(callTurn([call('c1')]), timeout, callTurn([call('c2')]), turn('done'));
        // A long first message, so that the call that timed out is charged much more than the
        // turns the provider counted, and than another turn with the wrap-up after it.
        s.input.user = 'x'.repeat(8_000);
        s.input.limits = { ...LIMITS, tokenBudget };
        return { s, result: runConversation(s.input) };
      };
      // What the call that timed out is charged: the rest of the input is that of the three turns.
      const guessed = (await play(1_000_000).result).inputTokens - 30;
      expect(guessed).toBeGreaterThan(2_000);
      // The two turns of tools used 30 tokens, and another turn with the wrap-up after it would
      // take a few hundred more: well short of this budget. With the call that timed out they used
      // 30 and its guess, nearly all of it.
      const { s, result } = play(40 + guessed);
      expect(await result).toMatchObject({ kind: 'answer', budgetReached: true });
      expect(s.seen.at(-1)!.messages.at(-1)).toEqual({ role: 'user', text: WRAP_UP });
    });

    it('serialises the conversation for a call that timed out or was unreadable, and for no other failure', async () => {
      const stringify = vi.spyOn(JSON, 'stringify');
      const serialisedConversations = () =>
        stringify.mock.calls.filter(
          ([value]) =>
            typeof value === 'object' && value !== null && 'system' in value && 'messages' in value,
        ).length;
      const unavailable = new LlmError('unavailable', 'The model provider could not be reached');
      try {
        await runConversation(scripted(timeout, turn('done')).input);
        expect(serialisedConversations()).toBe(1);

        stringify.mockClear();
        await runConversation(scripted(unreadable).input);
        expect(serialisedConversations()).toBe(1);

        stringify.mockClear();
        await runConversation(scripted(unavailable, turn('done')).input);
        expect(serialisedConversations()).toBe(0);
      } finally {
        stringify.mockRestore();
      }
    });
  });

  describe('failures', () => {
    it('an open circuit fails at once, with no retry', async () => {
      const s = scripted(new CircuitOpenError());
      expect(await runConversation(s.input)).toMatchObject({
        kind: 'failed',
        reason: 'provider_error',
      });
      expect(s.seen).toHaveLength(1);
      expect(s.sleeps).toEqual([]);
    });

    it('timeouts and unavailable providers share one retry', async () => {
      const timeout = new LlmError('timeout', 'The model did not answer within 60 s');
      const unavailable = new LlmError('unavailable', 'The model provider could not be reached');
      const both = scripted(timeout, unavailable, turn('done'));
      expect(await runConversation(both.input)).toMatchObject({
        kind: 'failed',
        reason: 'provider_error',
      });
      expect(both.sleeps).toEqual([5_000]);
      expect(both.seen).toHaveLength(2);

      const once = scripted(timeout, turn('done'));
      expect(await runConversation(once.input)).toMatchObject({ kind: 'answer' });
      expect(once.sleeps).toEqual([5_000]);
    });

    it('rate limits and timeouts have a retry each, in the same call', async () => {
      const limited = new LlmError('rate_limited', 'limited', 429, 2);
      const timeout = new LlmError('timeout', 'The model did not answer within 60 s');
      const s = scripted(limited, timeout, limited, turn('done'));
      expect(await runConversation(s.input)).toMatchObject({ kind: 'answer' });
      expect(s.sleeps).toEqual([2_000, 5_000, 2_000]);
    });

    it('gives each call its own retries', async () => {
      const unavailable = new LlmError('unavailable', 'The model provider could not be reached');
      const s = scripted(unavailable, callTurn([call('c1')]), unavailable, turn('done'));
      expect(await runConversation(s.input)).toMatchObject({ kind: 'answer', turns: 2 });
      expect(s.sleeps).toEqual([5_000, 5_000]);
    });

    it('answers provider_no_tools only for a refusal of 400, 404 or 422 that names tools', async () => {
      const refused = (status: number, names: boolean) =>
        new LlmError('rejected', 'The provider refused the request', status, null, names);
      const reasonFor = async (error: LlmError, tools = TOOLS) => {
        const s = scripted(error);
        return runConversation({ ...s.input, tools });
      };
      expect(await reasonFor(refused(400, true))).toMatchObject({
        kind: 'failed',
        reason: 'provider_no_tools',
      });
      expect(await reasonFor(refused(413, true))).toMatchObject({
        kind: 'failed',
        reason: 'provider_error',
      });
      expect(await reasonFor(refused(400, false))).toMatchObject({
        kind: 'failed',
        reason: 'provider_error',
      });
      // A conversation that sent no tools cannot have been refused for them.
      expect(await reasonFor(refused(400, true), [])).toMatchObject({
        kind: 'failed',
        reason: 'provider_error',
      });
      // Only a refusal: a bad answer that happens to say so is not one.
      const badAnswer = new LlmError('bad_answer', 'x', 400, null, true);
      expect(await reasonFor(badAnswer)).toMatchObject({
        kind: 'failed',
        reason: 'provider_error',
      });
    });

    it('stops at a call its caller gave up, which is not tried again or charged', async () => {
      const s = scripted(callTurn([call('c1')]), new LlmCallAborted(), turn('never asked'));
      // The server stopped while the provider was answering the second call.
      expect(await runConversation(s.input)).toEqual({
        kind: 'stopped',
        inputTokens: 10,
        outputTokens: 5,
        turns: 1,
        toolCalls: 1,
      });
      expect(s.seen).toHaveLength(2);
      expect(s.sleeps).toEqual([]);
    });

    it('lets an error that is not the provider’s end the conversation', async () => {
      const broken = new RangeError('Maximum call stack size exceeded');
      await expect(runConversation(scripted(broken).input)).rejects.toBe(broken);
    });

    it('lets a tool that throws end the conversation', async () => {
      const s = scripted(callTurn([call('c1')]), turn('done'));
      const aborted = new Error('the masker was closed');
      s.input.runTool = () => Promise.reject(aborted);
      await expect(runConversation(s.input)).rejects.toBe(aborted);
      expect(s.seen).toHaveLength(1);
    });

    it('lets a stop check that throws end the conversation', async () => {
      const s = scripted(turn('done'));
      const down = new Error('the database is down');
      s.input.shouldStop = () => Promise.reject(down);
      await expect(runConversation(s.input)).rejects.toBe(down);
      expect(s.seen).toHaveLength(0);
    });
  });
});

describe('CONVERSATION_LIMITS', () => {
  it('holds the values of the contract', () => {
    expect(CONVERSATION_LIMITS).toEqual({
      maxTurns: 16,
      maxCallsPerTurn: 8,
      wrapUpAt: 0.85,
      maxArgumentBytes: 16_384,
      maxArgumentDepth: 20,
    });
  });
});
