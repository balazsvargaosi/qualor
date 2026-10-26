import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicAnswer,
  anthropicRedactedThinking,
  anthropicThinking,
  anthropicToolUse,
  createFakeLlm,
  openAiAnswer,
  openAiToolCalls,
  responsesAnswer,
  responsesReasoning,
  responsesToolCalls,
  type FakeLlm,
  type LlmReply,
  type RecordedLlmRequest,
} from '../../../test/fake-llm';
import { withStreamServer, type StreamServer } from '../../../test/stream-server';
import { parseInternalHosts } from '../../scm/url';
import {
  callProvider,
  converse,
  LLM_MAX_ANSWER_BYTES,
  LLM_MAX_EVENT_BYTES,
  LlmCallAborted,
  LlmError,
  type LlmConversation,
  type ProviderConfig,
  type ProviderHttpOptions,
  type StreamLimits,
} from './index';

/*
 * R35: a conversation's call streams when its options give the limits of a stream. Whatever comes
 * in the stream, each wire puts it together into the very answer it reads when it is not streamed,
 * so a streamed turn and an unstreamed one are one turn from there.
 */

const readFile = {
  name: 'read_file',
  description: 'Read a file of the repository snapshot',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const listFiles = {
  name: 'list_files',
  description: 'List the files of a directory',
  parameters: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] },
};

/** The system prompt, one user turn and the read-only tools: the start of a review. */
const start: LlmConversation = {
  system: 'S',
  messages: [{ role: 'user', text: 'Review this change' }],
  tools: [readFile, listFiles],
  maxOutputTokens: 50,
};

/** Limits a test does not run into, unless it is about them. */
const LIMITS: StreamLimits = {
  firstByteMs: 5_000,
  idleMs: 5_000,
  totalMs: 60_000,
  maxStreamBytes: 16 * 1024 * 1024,
};

const WIRES = ['chat', 'anthropic', 'responses'] as const;
type Wire = (typeof WIRES)[number];

/** The calls of the equality tests: one with characters of two and four bytes, one not JSON. */
const CALLS = [
  { id: 'call_1', name: 'read_file', arguments: { path: 'src/café/😀.ts', from: 3 } },
  { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
];
const TEXT = 'Let me look at café € 😀, twice: 😀.';

/** The request a test sends, without what a stream adds to it. */
const unstreamed = (request: RecordedLlmRequest): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(request.json as Record<string, unknown>).filter(
      ([field]) => field !== 'stream' && field !== 'stream_options',
    ),
  );

describe('converse: a streamed answer is the answer that is not streamed (R35)', () => {
  let fake: FakeLlm;
  let http: ProviderHttpOptions;
  let streamed: ProviderHttpOptions;
  const configs = {} as Record<Wire, ProviderConfig>;

  const fakeOf = async (options: Parameters<typeof createFakeLlm>[0] = {}) => {
    fake = await createFakeLlm(options);
    http = { internalHosts: parseInternalHosts(fake.host), version: '0.0.0' };
    streamed = { ...http, stream: LIMITS };
    const base = {
      model: 'm-1',
      auth: 'bearer',
      jsonMode: 'json_object',
      maxTokensField: 'max_tokens',
      temperature: null,
      api: 'chat_completions',
      workspaceId: null,
      timeoutSeconds: 5,
    } as const;
    configs.chat = { kind: 'openai', baseUrl: fake.openAiBaseUrl, ...base };
    configs.responses = { ...configs.chat, api: 'responses' };
    configs.anthropic = { kind: 'anthropic', baseUrl: fake.anthropicBaseUrl, ...base };
  };
  // One fake per test: a reply a failing test left in the queue never reaches the next test.
  beforeEach(async () => {
    await fakeOf();
  });
  afterEach(async () => {
    await fake.close();
  });

  /** The same answer, streamed and not: the turn of each, in that order. */
  async function bothWays(wire: Wire, reply: () => LlmReply, conversation = start) {
    fake.enqueue(reply(), reply());
    const asStream = await converse(configs[wire], fake.apiKey, conversation, streamed);
    const whole = await converse(configs[wire], fake.apiKey, conversation, http);
    return { asStream, whole };
  }

  it('a streamed OpenAI turn with text, two tool calls and usage equals the unstreamed one', async () => {
    const { asStream, whole } = await bothWays('chat', () => ({
      status: 200,
      body: openAiToolCalls(CALLS, {
        text: TEXT,
        usage: { prompt_tokens: 120, completion_tokens: 34 },
      }),
    }));
    expect(asStream).toEqual(whole);
    expect(whole).toEqual({
      text: TEXT,
      finishReason: 'tool',
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: 'src/café/😀.ts', from: 3 } },
        { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
      ],
      usage: { inputTokens: 120, outputTokens: 34 },
      model: 'fake-openai-model',
    });
    // The streamed request asked for the stream and its usage, and is otherwise the same request.
    const [first, second] = fake.requests;
    expect(first!.json).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(first!.headers.accept).toBe('text/event-stream');
    expect(second!.json).not.toHaveProperty('stream');
    expect(second!.json).not.toHaveProperty('stream_options');
    expect(unstreamed(first!)).toEqual(second!.json);
  });

  it('the same for Anthropic, including input_json_delta, the thinking with its signature and the redacted thinking, which come back as they came', async () => {
    const thinking = [
      anthropicThinking('SIGNATURE-ONE', 'I should read 😀 first.'),
      anthropicRedactedThinking('ENCRYPTED-ONE'),
    ];
    const { asStream, whole } = await bothWays('anthropic', () => ({
      status: 200,
      body: anthropicToolUse(
        [
          { id: 'toolu_1', name: 'read_file', input: { path: 'src/café/😀.ts', from: 3 } },
          { id: 'toolu_2', name: 'list_files', input: {} },
        ],
        { text: TEXT, thinking, usage: { input_tokens: 431, output_tokens: 1_102 } },
      ),
    }));
    expect(asStream).toEqual(whole);
    expect(whole).toEqual({
      text: TEXT,
      finishReason: 'tool',
      toolCalls: [
        { id: 'toolu_1', name: 'read_file', arguments: { path: 'src/café/😀.ts', from: 3 } },
        { id: 'toolu_2', name: 'list_files', arguments: {} },
      ],
      usage: { inputTokens: 431, outputTokens: 1_102 },
      model: 'fake-anthropic-model',
      replay: {
        kind: 'anthropic',
        items: [
          ...thinking,
          { type: 'text', text: TEXT },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'read_file',
            input: { path: 'src/café/😀.ts', from: 3 },
          },
          { type: 'tool_use', id: 'toolu_2', name: 'list_files', input: {} },
        ],
      },
    });
    const [first, second] = fake.requests;
    expect(first!.json).toMatchObject({ stream: true });
    expect(first!.json).not.toHaveProperty('stream_options');
    expect(unstreamed(first!)).toEqual(second!.json);
  });

  it('the same for the Responses API, with its reasoning items, which come back as they came', async () => {
    const reasoning = [responsesReasoning('ENCRYPTED-ONE'), responsesReasoning('ENCRYPTED-TWO')];
    const { asStream, whole } = await bothWays('responses', () => ({
      status: 200,
      body: responsesToolCalls(CALLS, {
        text: TEXT,
        reasoning,
        usage: { input_tokens: 120, output_tokens: 34 },
      }),
    }));
    expect(asStream).toEqual(whole);
    expect(whole).toMatchObject({
      text: TEXT,
      finishReason: 'tool',
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: 'src/café/😀.ts', from: 3 } },
        { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
      ],
      usage: { inputTokens: 120, outputTokens: 34 },
      model: 'fake-openai-model',
    });
    expect(whole.replay?.items.slice(0, 2)).toEqual(reasoning);
    const [first, second] = fake.requests;
    expect(first!.json).toMatchObject({ stream: true });
    expect(first!.json).not.toHaveProperty('stream_options');
    expect(unstreamed(first!)).toEqual(second!.json);
  });

  /** Answers each wire reads in a way of its own, as each wire's unstreamed answer has them. */
  const ANSWERS: [string, Record<Wire, () => unknown>][] = [
    [
      'a text that ends the turn',
      {
        chat: () => openAiAnswer('{"findings":[]}'),
        anthropic: () => anthropicAnswer('{"findings":[]}'),
        responses: () => responsesAnswer('{"findings":[]}'),
      },
    ],
    [
      'a turn cut off at its limit (on Anthropic, a thinking block alone with its signature)',
      {
        chat: () => openAiAnswer('{"fi', { finishReason: 'length' }),
        anthropic: () => {
          const cut = anthropicAnswer('', { stopReason: 'max_tokens' }) as { content: unknown[] };
          cut.content = [anthropicThinking('SIGNATURE-CUT')];
          return cut;
        },
        responses: () =>
          responsesAnswer('', {
            incomplete: 'max_output_tokens',
            reasoning: [responsesReasoning('ENCRYPTED-CUT')],
          }),
      },
    ],
    [
      'a refusal',
      {
        chat: () => {
          const refused = openAiAnswer('x') as { choices: { message: Record<string, unknown> }[] };
          refused.choices[0]!.message.content = null;
          refused.choices[0]!.message.refusal = 'I cannot help with that.';
          return refused;
        },
        anthropic: () => anthropicAnswer('No.', { stopReason: 'refusal' }),
        responses: () => responsesAnswer('', { refusal: 'I cannot help with that.' }),
      },
    ],
    [
      'an answer without usage',
      {
        chat: () => openAiAnswer('{}', { usage: null }),
        anthropic: () => anthropicAnswer('{}', { usage: null }),
        responses: () => responsesAnswer('{}', { usage: null }),
      },
    ],
    [
      'a usage that is not a count',
      {
        chat: () => ({
          ...(openAiAnswer('{}') as object),
          usage: { prompt_tokens: -1, completion_tokens: 2.5 },
        }),
        anthropic: () => ({
          ...(anthropicAnswer('{}') as object),
          usage: { input_tokens: '412', output_tokens: 7 },
        }),
        responses: () => ({
          ...(responsesAnswer('{}') as object),
          usage: { input_tokens: -1, output_tokens: 2.5 },
        }),
      },
    ],
    [
      'calls with no arguments',
      {
        chat: () => {
          const body = openAiToolCalls([{ id: 'call_1', name: 'list_files', arguments: {} }]) as {
            choices: { message: { tool_calls: { function: Record<string, unknown> }[] } }[];
          };
          delete body.choices[0]!.message.tool_calls[0]!.function.arguments;
          return body;
        },
        anthropic: () => {
          const body = anthropicToolUse([{ id: 'toolu_1', name: 'list_files', input: {} }]) as {
            content: Record<string, unknown>[];
          };
          delete body.content[0]!.input;
          return body;
        },
        responses: () => responsesToolCalls([{ id: 'call_1', name: 'list_files', arguments: {} }]),
      },
    ],
    [
      'a call without an id, which is not understood',
      {
        chat: () => {
          const body = openAiToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]) as {
            choices: { message: { tool_calls: Record<string, unknown>[] } }[];
          };
          delete body.choices[0]!.message.tool_calls[0]!.id;
          return body;
        },
        anthropic: () => {
          const body = anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: {} }]) as {
            content: Record<string, unknown>[];
          };
          delete body.content[0]!.id;
          return body;
        },
        responses: () => {
          const body = responsesToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]) as {
            output: Record<string, unknown>[];
          };
          delete body.output[0]!.call_id;
          return body;
        },
      },
    ],
  ];

  describe.each(WIRES)('%s: every answer is read as it is unstreamed', (wire) => {
    it.each(ANSWERS)('%s', async (_what, bodies) => {
      const reply = () => ({ status: 200, body: bodies[wire]() });
      fake.enqueue(reply(), reply());
      const outcome = (http: ProviderHttpOptions) =>
        converse(configs[wire], fake.apiKey, start, http).catch((e: unknown) => e);
      const asStream = await outcome(streamed);
      const whole = await outcome(http);
      if (whole instanceof LlmError) {
        expect(asStream).toBeInstanceOf(LlmError);
        expect(asStream).toMatchObject({ failure: whole.failure, message: whole.message });
      } else {
        expect(asStream).toEqual(whole);
      }
      expect(fake.requests[0]!.json).toMatchObject({ stream: true });
    });
  });

  describe('an error event after the 200 is the provider’s error, in a fixed text', () => {
    const ERRORS: [Wire, string, 'unavailable' | 'rejected'][] = [
      ['chat', 'server_error', 'unavailable'],
      ['chat', 'invalid_request_error', 'rejected'],
      ['anthropic', 'overloaded_error', 'unavailable'],
      // The type of the API's own failure, as an HTTP 500 before the stream is.
      ['anthropic', 'api_error', 'unavailable'],
      ['anthropic', 'invalid_request_error', 'rejected'],
      ['responses', 'server_error', 'unavailable'],
      ['responses', 'invalid_prompt', 'rejected'],
    ];
    it.each(ERRORS)('%s: %s is %s', async (wire, type, failure) => {
      fake.enqueue({
        status: 200,
        body:
          wire === 'anthropic'
            ? anthropicAnswer('{}')
            : wire === 'responses'
              ? responsesAnswer('{}')
              : openAiAnswer('{}'),
        stream: { error: { type, message: 'Fake error text: it broke' } },
      });
      const err = await converse(configs[wire], fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LlmError);
      expect(err).toMatchObject({ failure });
      expect((err as Error).message).not.toContain('Fake error text');
    });

    it.each(WIRES)('%s: an error event that is not JSON is a refusal', async (wire) => {
      fake.enqueue({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'event: error\ndata: Fake error text: Internal error\n\n',
      });
      const err = await converse(configs[wire], fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'rejected' });
      expect((err as Error).message).not.toContain('Fake error text');
    });
  });

  it.each(WIRES)('%s: a stream that ends without its terminator is unavailable', async (wire) => {
    fake.enqueue({
      status: 200,
      body:
        wire === 'anthropic'
          ? anthropicAnswer('{"findings":[]}')
          : wire === 'responses'
            ? responsesAnswer('{"findings":[]}')
            : openAiAnswer('{"findings":[]}'),
      stream: { cut: true },
    });
    const err = await converse(configs[wire], fake.apiKey, start, streamed).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ failure: 'unavailable' });
  });

  it.each(WIRES)(
    '%s: a stream whose data is not JSON is an answer not understood',
    async (wire) => {
      fake.enqueue({ status: 200, body: 'this is not JSON' });
      const err = await converse(configs[wire], fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'bad_answer' });
    },
  );

  it.each(WIRES)(
    '%s: a stream whose usage is missing has no tokens, as an answer without usage',
    async (wire) => {
      fake.enqueue({
        status: 200,
        body:
          wire === 'anthropic'
            ? anthropicAnswer('{}')
            : wire === 'responses'
              ? responsesAnswer('{}')
              : openAiAnswer('{}'),
        stream: { noUsage: true },
      });
      const turn = await converse(configs[wire], fake.apiKey, start, streamed);
      expect(turn.usage).toEqual({ inputTokens: null, outputTokens: null });
    },
  );

  describe('a server that will not stream', () => {
    beforeEach(async () => {
      await fake.close();
      await fakeOf({ refuseStream: true });
    });

    it.each(WIRES)(
      '%s: a server refusing the stream is asked once more without it, with the same request',
      async (wire) => {
        const body =
          wire === 'anthropic'
            ? anthropicAnswer('{"findings":[]}')
            : wire === 'responses'
              ? responsesAnswer('{"findings":[]}')
              : openAiAnswer('{"findings":[]}');
        fake.enqueue({ status: 200, body }, { status: 200, body });
        const turn = await converse(configs[wire], fake.apiKey, start, streamed);
        expect(fake.requests).toHaveLength(2);
        const [refused, asked] = fake.requests;
        expect(refused!.json).toMatchObject({ stream: true });
        expect(asked!.json).not.toHaveProperty('stream');
        expect(asked!.json).not.toHaveProperty('stream_options');
        expect(unstreamed(refused!)).toEqual(asked!.json);
        // The answer is the one the server gives without a stream.
        expect(turn).toEqual(await converse(configs[wire], fake.apiKey, start, http));
      },
    );

    it('a server refusing stream_options is asked once more without it, and the rest of the call is not streamed', async () => {
      await fake.close();
      // A server that also refuses a limit over 1 200: the call is asked again without the room.
      await fakeOf({ refuseStream: true, outputCaps: { 'm-1': 1_200 } });
      fake.enqueue({ status: 200, body: openAiAnswer('{}') });
      const turn = await converse(
        configs.chat,
        fake.apiKey,
        { ...start, maxOutputTokens: 1_200, reasoningAllowance: 4_000 },
        streamed,
      );
      expect(turn.text).toBe('{}');
      expect(
        fake.requests.map((request) => {
          const json = request.json as { stream?: unknown; max_tokens?: unknown };
          return [json.stream ?? false, json.max_tokens];
        }),
      ).toEqual([
        [true, 5_200],
        [false, 5_200],
        [false, 1_200],
      ]);
    });

    it('remembers a model whose server refused the stream: its later calls go unstreamed at once, and another model still asks for one', async () => {
      const told: string[] = [];
      const options: ProviderHttpOptions = {
        ...streamed,
        onStreamRefused: () => void told.push('refused'),
      };
      const other = { ...configs.chat, model: 'm-2' };
      for (const config of [configs.chat, configs.chat, other]) {
        fake.enqueue({ status: 200, body: openAiAnswer('{}') });
        expect((await converse(config, fake.apiKey, start, options)).text).toBe('{}');
      }
      expect(
        fake.requests.map((request) => {
          const json = request.json as { model: string; stream?: unknown };
          return [json.model, json.stream ?? false];
        }),
      ).toEqual([
        ['m-1', true],
        ['m-1', false],
        ['m-1', false],
        ['m-2', true],
        ['m-2', false],
      ]);
      // Told once for each model whose stream was refused.
      expect(told).toEqual(['refused', 'refused']);
    });

    it('a refusal that is not of the stream is not asked again', async () => {
      await fake.close();
      await fakeOf();
      fake.enqueue({
        status: 400,
        body: {
          error: {
            message: 'Fake error text: something else',
            type: 'invalid_request_error',
            param: null,
            code: null,
          },
        },
      });
      const err = await converse(configs.chat, fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'rejected', status: 400, refusedStream: false });
      expect(fake.requests).toHaveLength(1);
    });
  });

  describe('a server that ignores the stream', () => {
    beforeEach(async () => {
      await fake.close();
      await fakeOf({ ignoreStream: true });
    });

    /** An answer with text, calls and usage, and the thinking or reasoning of the wires that have it. */
    const richAnswer = (wire: Wire): unknown =>
      wire === 'anthropic'
        ? anthropicToolUse(
            [{ id: 'toolu_1', name: 'read_file', input: { path: 'src/café/😀.ts' } }],
            {
              text: TEXT,
              thinking: [anthropicThinking('SIGNATURE-ONE', 'I should read 😀 first.')],
              usage: { input_tokens: 431, output_tokens: 1_102 },
            },
          )
        : wire === 'responses'
          ? responsesToolCalls(CALLS, {
              text: TEXT,
              reasoning: [responsesReasoning('ENCRYPTED-ONE')],
              usage: { input_tokens: 120, output_tokens: 34 },
            })
          : openAiToolCalls(CALLS, {
              text: TEXT,
              usage: { prompt_tokens: 120, completion_tokens: 34 },
            });

    it.each(WIRES)(
      '%s: its whole answer, JSON and no event stream, is read as the answer that is not streamed, in one request',
      async (wire) => {
        fake.enqueue(
          { status: 200, body: richAnswer(wire) },
          { status: 200, body: richAnswer(wire) },
        );
        const turn = await converse(configs[wire], fake.apiKey, start, streamed);
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0]!.json).toMatchObject({ stream: true });
        expect(turn).toEqual(await converse(configs[wire], fake.apiKey, start, http));
        expect(turn.toolCalls.length).toBeGreaterThan(0);
      },
    );

    it.each(WIRES)('%s: a whole answer that is not JSON is not understood', async (wire) => {
      fake.enqueue({ status: 200, body: 'this is not JSON' });
      const err = await converse(configs[wire], fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'bad_answer', status: 200 });
    });

    it.each(WIRES)('%s: a whole answer over 1 MiB is not understood', async (wire) => {
      const text = 'é'.repeat(LLM_MAX_ANSWER_BYTES / 2 + 1);
      fake.enqueue({
        status: 200,
        body:
          wire === 'anthropic'
            ? anthropicAnswer(text)
            : wire === 'responses'
              ? responsesAnswer(text)
              : openAiAnswer(text),
      });
      const err = await converse(configs[wire], fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'bad_answer' });
    });
  });

  it.each(WIRES)(
    '%s: explain, triage, fix and the Test do not stream: a single call never does, nor a conversation not told to',
    async (wire) => {
      // A single call ignores the limits of a stream; the Test's conversation has none.
      await callProvider(
        configs[wire],
        fake.apiKey,
        { system: 'S', user: 'U', maxOutputTokens: 50 },
        streamed,
      );
      await converse(configs[wire], fake.apiKey, start, http);
      expect(fake.requests).toHaveLength(2);
      for (const request of fake.requests) {
        expect(request.json).not.toHaveProperty('stream');
        expect(request.json).not.toHaveProperty('stream_options');
        expect(request.headers.accept).toBe('application/json');
      }
    },
  );

  it('JSON mode on the Responses API still names JSON in the first message, streamed', async () => {
    fake.enqueue({ status: 200, body: responsesAnswer('{}') });
    await converse(configs.responses, fake.apiKey, { ...start, tools: [] }, streamed);
    expect(fake.requests[0]!.json).toMatchObject({
      stream: true,
      text: { format: { type: 'json_object' } },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Review this change' },
            { type: 'input_text', text: 'Reply in JSON.' },
          ],
        },
      ],
    });
  });

  describe('the answer’s cap and the event’s', () => {
    it.each(WIRES)('%s: a streamed answer over 1 MiB is not understood', async (wire) => {
      // Many small deltas, no event near its bound: the answer they make is over its cap.
      const text = 'é'.repeat(LLM_MAX_ANSWER_BYTES / 2 + 1);
      fake.enqueue({
        status: 200,
        body:
          wire === 'anthropic'
            ? anthropicAnswer(text)
            : wire === 'responses'
              ? responsesAnswer(text)
              : openAiAnswer(text),
      });
      const err = await converse(configs[wire], fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'bad_answer' });
    });

    it('an event over 1 MiB is read when the answer is not: the end of a Responses stream repeats the whole response', async () => {
      const instructions = 'i'.repeat(LLM_MAX_ANSWER_BYTES + 1_000);
      fake.enqueue({ status: 200, body: { ...(responsesAnswer('{}') as object), instructions } });
      const turn = await converse(configs.responses, fake.apiKey, start, streamed);
      expect(turn.text).toBe('{}');
    });

    it('an event over 4 MiB is not', async () => {
      const instructions = 'i'.repeat(LLM_MAX_EVENT_BYTES + 1);
      fake.enqueue({ status: 200, body: { ...(responsesAnswer('{}') as object), instructions } });
      const err = await converse(configs.responses, fake.apiKey, start, streamed).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'bad_answer' });
    });
  });
});

describe('converse: a stream answered by hand', () => {
  const base = {
    kind: 'openai',
    model: 'm-1',
    auth: 'bearer',
    jsonMode: 'none',
    maxTokensField: 'max_tokens',
    temperature: null,
    api: 'chat_completions',
    workspaceId: null,
    timeoutSeconds: 5,
  } as const;
  const against = (server: StreamServer, limits: Partial<StreamLimits> = {}) => ({
    config: { ...base, baseUrl: `http://${server.host}/v1` } as ProviderConfig,
    http: {
      internalHosts: parseInternalHosts(server.host),
      version: '0.0.0',
      stream: { ...LIMITS, ...limits },
    },
  });
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ model: 'm-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two tool calls whose argument deltas interleave are merged by their index, the id, type and name from the first delta that has them', async () => {
    await withStreamServer(async (server) => {
      const { config, http } = against(server);
      const turn = converse(config, 'k', start, http);
      const answer = await server.next();
      answer.head();
      for (const piece of [
        chunk({ role: 'assistant', content: null }),
        // The second call opens first: the order of the calls is their index.
        chunk({
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              type: 'function',
              function: { name: 'list_files', arguments: '' },
            },
          ],
        }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'read_file', arguments: '{"pa' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"dir"' } }] }),
        // A delta that names the call again, or names nothing, changes neither.
        chunk({
          tool_calls: [{ index: 0, id: '', function: { name: 'other', arguments: 'th":' } }],
        }),
        chunk({ tool_calls: [{ index: 1, id: null, function: { arguments: ':"src"}' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
        chunk({}, 'tool_calls'),
        `data: ${JSON.stringify({ model: 'm-1', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } })}\n\n`,
        'data: [DONE]\n\n',
      ]) {
        await answer.write(piece);
      }
      await answer.end();
      expect(await turn).toEqual({
        text: '',
        finishReason: 'tool',
        toolCalls: [
          { id: 'call_a', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'call_b', name: 'list_files', arguments: { dir: 'src' } },
        ],
        usage: { inputTokens: 9, outputTokens: 4 },
        model: 'm-1',
      });
    });
  });

  it('reads an event cut anywhere, a character of four bytes cut between two chunks', async () => {
    await withStreamServer(async (server) => {
      const { config, http } = against(server);
      const turn = converse(config, 'k', start, http);
      const answer = await server.next();
      answer.head();
      const text = Buffer.from(
        `${chunk({ role: 'assistant', content: '' })}${chunk({ content: 'a 😀 b' })}${chunk({}, 'stop')}data: [DONE]\n\n`,
      );
      const emoji = text.indexOf(Buffer.from('😀'));
      await answer.write(text.subarray(0, emoji + 2));
      await answer.write(text.subarray(emoji + 2, emoji + 3));
      await answer.end(text.subarray(emoji + 3));
      expect(await turn).toMatchObject({ text: 'a 😀 b', finishReason: 'stop' });
    });
  });

  it('a review call silent past the idle limit times out, and the wait for the first byte too', async () => {
    await withStreamServer(async (server) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { config, http } = against(server, { firstByteMs: 3_000, idleMs: 2_000 });
      const quiet = converse(config, 'k', start, http).catch((e: unknown) => e);
      const answer = await server.next();
      answer.head();
      await answer.write(chunk({ role: 'assistant', content: '' }));
      await vi.advanceTimersByTimeAsync(1_999);
      await answer.write(chunk({ content: 'still' }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await quiet).toMatchObject({
        failure: 'timeout',
        message: 'The model sent nothing for 2 s; raise the timeout in the AI assistant settings',
      });
      await answer.closed;

      const silent = converse(config, 'k', start, http).catch((e: unknown) => e);
      await server.next();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await silent).toMatchObject({
        failure: 'timeout',
        message: 'The model sent nothing for 3 s; raise the timeout in the AI assistant settings',
      });
    });
  });

  it('an Anthropic call whose input is cut off at the limit keeps the input it started with, and its turn can go back as it came', async () => {
    await withStreamServer(async (server) => {
      const config: ProviderConfig = {
        ...base,
        kind: 'anthropic',
        baseUrl: `http://${server.host}`,
      };
      const { http } = against(server);
      const turn = converse(config, 'k', start, http);
      const answer = await server.next();
      answer.head();
      const event = (data: Record<string, unknown>) =>
        `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
      await answer.end(
        [
          event({
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'm-1',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 5, output_tokens: 1 },
            },
          }),
          event({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
          }),
          event({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path": "src/a' },
          }),
          event({ type: 'content_block_stop', index: 0 }),
          event({
            type: 'message_delta',
            delta: { stop_reason: 'max_tokens' },
            usage: { output_tokens: 50 },
          }),
          event({ type: 'message_stop' }),
        ].join(''),
      );
      expect(await turn).toEqual({
        text: '',
        finishReason: 'tool',
        toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: {} }],
        usage: { inputTokens: 5, outputTokens: 50 },
        model: 'm-1',
        replay: {
          kind: 'anthropic',
          items: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }],
        },
      });
    });
  });

  it('a call its caller gives up while the answer streams is given up at once, and is no failure of the provider’s', async () => {
    await withStreamServer(async (server) => {
      const { config, http } = against(server);
      const controller = new AbortController();
      const turn = converse(config, 'k', start, { ...http, signal: controller.signal }).catch(
        (e: unknown) => e,
      );
      const answer = await server.next();
      answer.head();
      await answer.write(chunk({ role: 'assistant', content: 'half' }));
      controller.abort();
      const err = await turn;
      expect(err).toBeInstanceOf(LlmCallAborted);
      expect(err).not.toBeInstanceOf(LlmError);
      await answer.closed;
    });
  });

  it('stops reading at the terminator, and closes the connection', async () => {
    await withStreamServer(async (server) => {
      const { config, http } = against(server);
      const turn = converse(config, 'k', start, http);
      const answer = await server.next();
      answer.head();
      await answer.write(
        `${chunk({ role: 'assistant', content: 'done' })}${chunk({}, 'stop')}data: [DONE]\n\n`,
      );
      // The provider would have more to say, but the answer is complete.
      expect(await turn).toMatchObject({ text: 'done', finishReason: 'stop' });
      await answer.closed;
    });
  });
});
