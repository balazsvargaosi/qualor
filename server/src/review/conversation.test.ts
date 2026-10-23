import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/** The model asks for tool calls (and says `text` beside them, when given). */
function toolTurn(kind: Kind, calls: Call[], tokens = [100, 10], text?: string): LlmReply {
  const [input = 0, output = 0] = tokens;
  const over = text === undefined ? {} : { text };
  const body =
    kind === 'openai'
      ? openAiToolCalls(
          calls.map(({ id, name = 'read_file', args }) => ({ id, name, arguments: args })),
          { usage: { prompt_tokens: input, completion_tokens: output }, ...over },
        )
      : anthropicToolUse(
          calls.map(({ id, name = 'read_file', args }) => ({ id, name, input: args })),
          { usage: { input_tokens: input, output_tokens: output }, ...over },
        );
  return { status: 200, body };
}

/** The model answers with text and ends its turn the way `finish` says. */
function textTurn(
  kind: Kind,
  text: string,
  tokens = [100, 10],
  finish: 'stop' | 'length' | 'tool' | 'refusal' = 'stop',
): LlmReply {
  const [input = 0, output = 0] = tokens;
  const body =
    kind === 'openai'
      ? openAiAnswer(text, {
          finishReason: {
            stop: 'stop',
            length: 'length',
            tool: 'tool_calls',
            refusal: 'content_filter',
          }[finish],
          usage: { prompt_tokens: input, completion_tokens: output },
        })
      : anthropicAnswer(text, {
          stopReason: {
            stop: 'end_turn',
            length: 'max_tokens',
            tool: 'tool_use',
            refusal: 'refusal',
          }[finish],
          usage: { input_tokens: input, output_tokens: output },
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
        const limits = { ...LIMITS, tokenBudget: 1_000 };
        // 500, then 860 of 1000: the third request is the wrap-up.
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [400, 100]),
          toolTurn(kind, [{ id: 'c2', args: { path: 'b.ts' } }], [300, 60]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const over = await run(kind, { limits });
        expect(over.result).toMatchObject({
          kind: 'answer',
          inputTokens: 710,
          outputTokens: 161,
          turns: 3,
          budgetReached: true,
        });
        expect(WIRES[kind].lastUser(fake.requests[2]!)).toBe(WRAP_UP);

        // 500, then 840 of 1000: the model goes on with its tools.
        fake.requests.length = 0;
        fake.enqueue(
          toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }], [400, 100]),
          toolTurn(kind, [{ id: 'c2', args: { path: 'b.ts' } }], [300, 40]),
          textTurn(kind, '{"findings":[]}', [10, 1]),
        );
        const under = await run(kind, { limits });
        expect(under.result).toMatchObject({ kind: 'answer', turns: 3, budgetReached: false });
        expect(WIRES[kind].lastUser(fake.requests[2]!)).not.toContain('Token budget');
      },
    );

    it.each(KINDS)('a wrap-up answer that only calls tools is a bad answer (%s)', async (kind) => {
      fake.enqueue(
        toolTurn(kind, [{ id: 'c1', args: { path: 'a.ts' } }]),
        toolTurn(kind, [{ id: 'c2', args: { path: 'b.ts' } }]),
      );
      const { result, ran } = await run(kind, { limits: { ...LIMITS, maxTurns: 1 } });
      expect(result).toEqual({ kind: 'failed', reason: 'bad_answer' });
      expect(ran.map((c) => c.id)).toEqual(['c1']);
      expect(fake.requests).toHaveLength(2);
    });

    describe('a model that keeps calling tools', () => {
      // Answers every request with a call of its own, however it is asked, and the tokens given.
      const insatiable = (kind: Kind, tokens: number[]): LlmResponder => {
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
          expect(result).toEqual({ kind: 'failed', reason: 'bad_answer' });
          // The 16 turns of the limit, then the wrap-up, which is not answered with a call that runs.
          expect(fake.requests).toHaveLength(CONVERSATION_LIMITS.maxTurns + 1);
          expect(ran).toHaveLength(CONVERSATION_LIMITS.maxTurns);
          expect(WIRES[kind].lastUser(fake.requests.at(-1)!)).toBe(WRAP_UP);
        },
      );

      it.each(KINDS)('is stopped by the token budget too (%s)', async (kind) => {
        fake.enqueue(...Array.from({ length: 40 }, () => insatiable(kind, [4_000, 1_000])));
        const { result, ran } = await run(kind, { limits: { ...LIMITS, tokenBudget: 20_000 } });
        expect(result).toEqual({ kind: 'failed', reason: 'bad_answer' });
        // 3 turns are 15 000 of the 20 000 tokens; the 4th makes 20 000, past 85 %: the wrap-up
        // is the 5th request.
        expect(fake.requests).toHaveLength(5);
        expect(ran).toHaveLength(4);
        expect(WIRES[kind].lastUser(fake.requests[4]!)).toBe(WRAP_UP);
        expect(WIRES[kind].lastUser(fake.requests[3]!)).not.toBe(WRAP_UP);
      });
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
      expect(result).toEqual({ kind: 'failed', reason: 'bad_answer' });
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
      expect(blank.result).toEqual({ kind: 'failed', reason: 'bad_answer' });
    });

    it.each(KINDS)('a refusal is a bad answer, with text or without (%s)', async (kind) => {
      // A refusal may come with the words of its apology; they are not the answer.
      for (const text of ['', "I can't help with that."]) {
        fake.requests.length = 0;
        fake.enqueue(textTurn(kind, text, [10, 2], 'refusal'));
        const { result } = await run(kind);
        expect(result).toEqual({ kind: 'failed', reason: 'bad_answer' });
        expect(fake.requests).toHaveLength(1);
      }
    });

    it.each(KINDS)('length then length fails with bad_answer (%s)', async (kind) => {
      fake.enqueue(
        textTurn(kind, '{"findings":[{"title":"A very', [100, 50], 'length'),
        textTurn(kind, '{"findings":[{"title"', [200, 50], 'length'),
      );
      const { result } = await run(kind);
      expect(result).toEqual({ kind: 'failed', reason: 'bad_answer' });

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
        expect(given.result).toEqual({ kind: 'failed', reason: 'provider_error' });
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
      expect(failed.result).toEqual({ kind: 'failed', reason: 'provider_error' });
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
        expect(result).toEqual({ kind: 'failed', reason: 'provider_error' });
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
          expect(result).toEqual({ kind: 'failed', reason: 'provider_no_tools' });
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
        expect(result).toEqual({ kind: 'failed', reason: 'provider_error' });
        expect(fake.requests).toHaveLength(2);
      });
    });

    it.each(KINDS)('a refusal that does not name tools is a provider error (%s)', async (kind) => {
      fake.enqueue(failure(kind, 400, { message: 'Model not found' }));
      const { result } = await run(kind);
      expect(result).toEqual({ kind: 'failed', reason: 'provider_error' });
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
      expect(result).toEqual({ kind: 'stopped' });
      expect(fake.requests).toHaveLength(1);
      expect(ran).toHaveLength(1);
      expect(asked).toBe(2);
    });

    it.each(KINDS)('is checked before the first call, and sends nothing (%s)', async (kind) => {
      fake.enqueue(textTurn(kind, '{"findings":[]}'));
      const { result } = await run(kind, { shouldStop: () => Promise.resolve(true) });
      expect(result).toEqual({ kind: 'stopped' });
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
      expect(result).toEqual({ kind: 'stopped' });
      expect(sleeps).toEqual([5_000]);
      expect(fake.requests).toHaveLength(1);
    });
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

    it('counts a token count the provider did not give as nothing', async () => {
      const unknown = { inputTokens: null, outputTokens: null };
      const s = scripted(
        callTurn([call('c1')], { usage: unknown }),
        turn('done', { usage: { inputTokens: 30, outputTokens: null } }),
      );
      s.input.limits = { ...LIMITS, tokenBudget: 10 };
      const result = await runConversation(s.input);
      // Nothing was counted after the first turn, so no wrap-up came.
      expect(result).toEqual({
        kind: 'answer',
        text: 'done',
        inputTokens: 30,
        outputTokens: 0,
        turns: 2,
        toolCalls: 1,
        budgetReached: false,
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

  describe('failures', () => {
    it('an open circuit fails at once, with no retry', async () => {
      const s = scripted(new CircuitOpenError());
      expect(await runConversation(s.input)).toEqual({ kind: 'failed', reason: 'provider_error' });
      expect(s.seen).toHaveLength(1);
      expect(s.sleeps).toEqual([]);
    });

    it('timeouts and unavailable providers share one retry', async () => {
      const timeout = new LlmError('timeout', 'The model did not answer within 60 s');
      const unavailable = new LlmError('unavailable', 'The model provider could not be reached');
      const both = scripted(timeout, unavailable, turn('done'));
      expect(await runConversation(both.input)).toEqual({
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
      expect(await reasonFor(refused(400, true))).toEqual({
        kind: 'failed',
        reason: 'provider_no_tools',
      });
      expect(await reasonFor(refused(413, true))).toEqual({
        kind: 'failed',
        reason: 'provider_error',
      });
      expect(await reasonFor(refused(400, false))).toEqual({
        kind: 'failed',
        reason: 'provider_error',
      });
      // A conversation that sent no tools cannot have been refused for them.
      expect(await reasonFor(refused(400, true), [])).toEqual({
        kind: 'failed',
        reason: 'provider_error',
      });
      // Only a refusal: a bad answer that happens to say so is not one.
      const badAnswer = new LlmError('bad_answer', 'x', 400, null, true);
      expect(await reasonFor(badAnswer)).toEqual({ kind: 'failed', reason: 'provider_error' });
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
