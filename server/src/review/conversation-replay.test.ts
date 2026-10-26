import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anthropicAnswer,
  anthropicRedactedThinking,
  anthropicThinking,
  createFakeLlm,
  responsesAnswer,
  responsesReasoning,
  type FakeLlm,
  type LlmReply,
  type RecordedLlmRequest,
} from '../../test/fake-llm';
import { converse, type LlmToolCall, type ProviderConfig } from '../llm/providers';
import { parseInternalHosts } from '../scm/url';
import { CONVERSATION_LIMITS, runConversation, type ConversationInput } from './conversation';
import { newNonce } from './envelope';

type Kind = 'openai' | 'anthropic';
/** The wires the loop is run over: the two kinds, and the Responses API of the OpenAI kind. */
type Wire = Kind | 'responses';

const NONCE = newNonce();
const USER_TEXT = 'Review this change';
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

/** What a tool message says: the envelope's marker lines checked, the line inside parsed. */
function unwrap(text: string): { tool: string; result: string } {
  const lines = text.split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(`<<<QUALOR-DATA-${NONCE}`);
  expect(lines[2]).toBe(`QUALOR-DATA-${NONCE}>>>`);
  return JSON.parse(lines[1]!) as { tool: string; result: string };
}

describe('runConversation: the tool loop of a review (llm.md §2.5, review.md §9.1)', () => {
  let fake: FakeLlm;
  let configs: Record<Wire, ProviderConfig>;
  let http: { internalHosts: ReadonlySet<string>; version: string };

  // One fake per test: a reply a failing test left in the queue never reaches the next test.
  beforeEach(async () => {
    // As the real API does, it refuses a text block that is empty or only whitespace.
    fake = await createFakeLlm({ refuseBlankText: true });
    http = { internalHosts: parseInternalHosts(fake.host), version: '0.0.0' };
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
    configs = {
      openai: { kind: 'openai', baseUrl: fake.openAiBaseUrl, ...base },
      anthropic: { kind: 'anthropic', baseUrl: fake.anthropicBaseUrl, ...base },
      responses: { kind: 'openai', baseUrl: fake.openAiBaseUrl, ...base, api: 'responses' },
    };
  });
  afterEach(async () => {
    await fake.close();
  });

  /** The loop over the fake provider of `kind`, with the tools it runs and the waits it makes recorded. */
  function start(kind: Wire, over: Partial<ConversationInput> = {}) {
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

  const run = (kind: Wire, over: Partial<ConversationInput> = {}) => {
    const started = start(kind, over);
    return runConversation(started.input).then((result) => ({ result, ...started }));
  };

  describe('the thinking of the current Anthropic models', () => {
    /** An answer of exactly this content; a turn that asks for tools ends with `tool_use`. */
    const answerOf = (content: unknown[], stop: string): LlmReply => ({
      status: 200,
      body: { ...(anthropicAnswer('') as object), content, stop_reason: stop },
    });
    const toolUse = (id: string, input: unknown, name = 'read_file') => ({
      type: 'tool_use',
      id,
      name,
      input,
    });
    /** The model's four turns: three of tools, each with thinking of its own, and the answer. */
    const CONTENTS = [
      [
        anthropicThinking('sig-1'),
        anthropicRedactedThinking('data-1'),
        { type: 'text', text: 'Reading.' },
        toolUse('c1', { path: 'a.ts' }),
      ],
      [
        anthropicThinking('sig-2', 'A summary.'),
        toolUse('c2', { pattern: 'x' }, 'grep'),
        toolUse('c3', { path: 'b.ts' }),
      ],
      [anthropicRedactedThinking('data-3'), toolUse('c4', { path: 'c.ts' })],
      [anthropicThinking('sig-4'), { type: 'text', text: '{"findings":[]}' }],
    ];
    const enqueueAll = () =>
      fake.enqueue(
        ...CONTENTS.map((content, i) => answerOf(content, i < 3 ? 'tool_use' : 'end_turn')),
      );
    const messagesOf = (request: RecordedLlmRequest) =>
      (request.json as AnthropicWire).messages.map((message) => ({
        role: message.role,
        json: JSON.stringify(message.content),
      }));

    it('thinking and redacted_thinking blocks come back verbatim, in order, on every later turn', async () => {
      enqueueAll();
      const { result } = await run('anthropic');
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 4 });
      expect(fake.requests).toHaveLength(4);
      for (const [n, request] of fake.requests.entries()) {
        // Byte for byte the content of the earlier turns of the model, each turn once, in order.
        const assistants = messagesOf(request)
          .filter((message) => message.role === 'assistant')
          .map((message) => message.json);
        expect(assistants, `request ${n}`).toEqual(
          CONTENTS.slice(0, n).map((content) => JSON.stringify(content)),
        );
      }
    });

    it('three tool turns: the request bodies share an unchanged prefix, byte-identical up to the new turn', async () => {
      enqueueAll();
      await run('anthropic');
      const bodies = fake.requests.map((request) => request.json as Record<string, unknown>);
      const messages = fake.requests.map((request) => messagesOf(request).map((m) => m.json));
      for (let n = 1; n < bodies.length; n += 1) {
        const before = messages[n - 1]!;
        // Everything the earlier request held is there again, as it was, and the new turn is added.
        expect(messages[n]!.slice(0, before.length), `request ${n}`).toEqual(before);
        expect(messages[n]!.length, `request ${n}`).toBeGreaterThan(before.length);
        for (const field of ['model', 'max_tokens', 'system', 'tools', 'tool_choice']) {
          expect(JSON.stringify(bodies[n]![field]), `${field} of request ${n}`).toBe(
            JSON.stringify(bodies[0]![field]),
          );
        }
      }
      // The raw bodies too: what comes before the messages is the same text on every request.
      const head = (raw: string) => raw.slice(0, raw.indexOf('"messages":['));
      expect(new Set(fake.requests.map((request) => head(request.body))).size).toBe(1);
    });

    it('sends the results of a turn right after it, and no message between a turn and them', async () => {
      enqueueAll();
      await run('anthropic');
      const last = (fake.requests[3]!.json as AnthropicWire).messages;
      expect(last.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      expect(last[2]!.content.map((block) => block.tool_use_id)).toEqual(['c1']);
      expect(last[4]!.content.map((block) => block.tool_use_id)).toEqual(['c2', 'c3']);
      expect(last[6]!.content.map((block) => block.tool_use_id)).toEqual(['c4']);
    });

    it('sends the thinking of an answer that was cut off, and of one the caller did not accept, with the answer', async () => {
      const cut = [anthropicThinking('sig-cut'), { type: 'text', text: '{"findings":[{"ti' }];
      const bad = [anthropicRedactedThinking('data-bad'), { type: 'text', text: 'not json' }];
      const good = [anthropicThinking('sig-good'), { type: 'text', text: '{"findings":[]}' }];
      fake.enqueue(
        answerOf(cut, 'max_tokens'),
        answerOf(bad, 'end_turn'),
        answerOf(good, 'end_turn'),
      );
      const { result } = await run('anthropic', {
        accept: (text) => text.startsWith('{"findings":[]'),
      });
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 3 });
      const last = messagesOf(fake.requests[2]!);
      expect(last.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      expect(last[1]!.json).toBe(JSON.stringify(cut));
      expect(last[3]!.json).toBe(JSON.stringify(bad));
    });

    it('sends a turn whose calls were not run as its text alone: no thinking, no call, and never a text that is blank', async () => {
      // The wrap-up answers with thinking, words that are not the answer and a call, which is not run.
      const late = [
        anthropicThinking('sig-late'),
        { type: 'text', text: 'Enough.' },
        toolUse('c9', { path: 'z.ts' }),
      ];
      fake.enqueue(
        answerOf(CONTENTS[0]!, 'tool_use'),
        answerOf(late, 'tool_use'),
        answerOf(CONTENTS[3]!, 'end_turn'),
      );
      const { result } = await run('anthropic', {
        limits: { ...LIMITS, maxTurns: 1 },
        accept: (text) => text.startsWith('{'),
      });
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 3 });
      const history = messagesOf(fake.requests[2]!);
      expect(history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      // The turn before it keeps its thinking; this one is its text and nothing else.
      expect(history[1]!.json).toBe(JSON.stringify(CONTENTS[0]));
      expect(history[3]!.json).toBe(JSON.stringify([{ type: 'text', text: 'Enough.' }]));
      expect(fake.requests[2]!.body).not.toContain('sig-late');
      expect(fake.requests[2]!.body).not.toContain('"c9"');
    });

    it('a turn that only thought before it was cut off is not in the history: there is no message of its own to send', async () => {
      fake.enqueue(
        answerOf([anthropicThinking('sig-half')], 'max_tokens'),
        answerOf(CONTENTS[3]!, 'end_turn'),
      );
      const { result } = await run('anthropic');
      expect(result).toMatchObject({ kind: 'answer', turns: 2 });
      expect(fake.requests[1]!.body).not.toContain('sig-half');
      expect(messagesOf(fake.requests[1]!).map((message) => message.role)).toEqual(['user']);
    });

    it('a refusal after thinking ends the conversation as a bad answer with what it spent, and sends nothing more', async () => {
      fake.enqueue(
        answerOf(CONTENTS[0]!, 'tool_use'),
        {
          status: 200,
          body: {
            ...(anthropicAnswer('', {
              usage: { input_tokens: 700, output_tokens: 900 },
            }) as object),
            content: [anthropicThinking('sig-refused'), { type: 'text', text: 'No.' }],
            stop_reason: 'refusal',
          },
        },
        answerOf(CONTENTS[3]!, 'end_turn'),
      );
      const { result } = await run('anthropic');
      expect(result).toMatchObject({
        kind: 'failed',
        reason: 'bad_answer',
        turns: 2,
        inputTokens: 431 + 700,
        outputTokens: 102 + 900,
      });
      expect(fake.requests).toHaveLength(2);
    });
  });

  describe('the reasoning of the current OpenAI models (the Responses API)', () => {
    type Item = Record<string, unknown>;
    /** An answer of exactly these output items; `cut`: it ran out of tokens, as the answer says. */
    const answerOf = (
      output: Item[],
      over: { cut?: boolean; tokens?: [number, number] } = {},
    ): LlmReply => {
      const [input, outputTokens] = over.tokens ?? [100, 10];
      const body = responsesAnswer('x', {
        ...(over.cut ? { incomplete: 'max_output_tokens' } : {}),
        usage: { input_tokens: input, output_tokens: outputTokens },
      }) as { output: unknown[] };
      body.output = output;
      return { status: 200, body };
    };
    const reasoning = (encrypted: string): Item => responsesReasoning(encrypted) as Item;
    const message = (text: string): Item => ({
      id: `msg_${text.length}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    });
    const call = (id: string, args: unknown, name = 'read_file'): Item => ({
      id: `fc_${id}`,
      type: 'function_call',
      status: 'completed',
      call_id: id,
      name,
      arguments: JSON.stringify(args),
    });
    /** The model's four turns: three of tools, each with reasoning of its own, and the answer. */
    const CONTENTS: Item[][] = [
      [reasoning('enc-1'), message('Reading.'), call('c1', { path: 'a.ts' })],
      [reasoning('enc-2'), call('c2', { pattern: 'x' }, 'grep'), call('c3', { path: 'b.ts' })],
      [reasoning('enc-3'), reasoning('enc-3b'), call('c4', { path: 'c.ts' })],
      [reasoning('enc-4'), message('{"findings":[]}')],
    ];
    const enqueueAll = () => fake.enqueue(...CONTENTS.map((content) => answerOf(content)));
    const inputOf = (request: RecordedLlmRequest): Item[] =>
      (request.json as { input: Item[] }).input;
    /** What an input item is: its type, or its role for a message without one. */
    const kindOf = (item: Item): string => String(item.type ?? item.role);
    /** The items of the history that the model made: all but the user's messages and the results. */
    const madeByModel = (request: RecordedLlmRequest): string[] =>
      inputOf(request)
        .filter((item) => item.role !== 'user' && item.type !== 'function_call_output')
        .map((item) => JSON.stringify(item));

    it('reasoning items come back verbatim, in order, on every later turn', async () => {
      enqueueAll();
      const { result } = await run('responses');
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 4 });
      expect(fake.requests).toHaveLength(4);
      for (const [n, request] of fake.requests.entries()) {
        // Byte for byte the output of the earlier turns of the model, each turn once, in order.
        expect(madeByModel(request), `request ${n}`).toEqual(
          CONTENTS.slice(0, n)
            .flat()
            .map((item) => JSON.stringify(item)),
        );
      }
    });

    it('three tool turns: the request bodies share an unchanged prefix, byte-identical up to the new turn', async () => {
      enqueueAll();
      await run('responses');
      const bodies = fake.requests.map((request) => request.json as Record<string, unknown>);
      const inputs = fake.requests.map((request) => inputOf(request).map((i) => JSON.stringify(i)));
      for (let n = 1; n < bodies.length; n += 1) {
        const before = inputs[n - 1]!;
        // Everything the earlier request held is there again, as it was, and the new turn is added.
        expect(inputs[n]!.slice(0, before.length), `request ${n}`).toEqual(before);
        expect(inputs[n]!.length, `request ${n}`).toBeGreaterThan(before.length);
        for (const field of [
          'model',
          'instructions',
          'tools',
          'tool_choice',
          'max_output_tokens',
          'store',
          'include',
        ]) {
          expect(JSON.stringify(bodies[n]![field]), `${field} of request ${n}`).toBe(
            JSON.stringify(bodies[0]![field]),
          );
        }
      }
      // The raw bodies too: what comes before the input is the same text on every request.
      const head = (raw: string) => raw.slice(0, raw.indexOf('"input":['));
      expect(new Set(fake.requests.map((request) => head(request.body))).size).toBe(1);
    });

    it('sends the results of a turn right after it, each by the id of its call', async () => {
      enqueueAll();
      await run('responses');
      const last = inputOf(fake.requests[3]!);
      expect(last.map(kindOf)).toEqual([
        'user',
        'reasoning',
        'message',
        'function_call',
        'function_call_output',
        'reasoning',
        'function_call',
        'function_call',
        'function_call_output',
        'function_call_output',
        'reasoning',
        'reasoning',
        'function_call',
        'function_call_output',
      ]);
      expect(
        last.filter((item) => item.type === 'function_call_output').map((i) => i.call_id),
      ).toEqual(['c1', 'c2', 'c3', 'c4']);
    });

    it('sends the output of an answer that was cut off, and of one the caller did not accept, with the answer', async () => {
      const cut = [reasoning('enc-cut'), message('{"findings":[{"ti')];
      cut[1]!.status = 'incomplete';
      const bad = [reasoning('enc-bad'), message('not json')];
      const good = [reasoning('enc-good'), message('{"findings":[]}')];
      fake.enqueue(answerOf(cut, { cut: true }), answerOf(bad), answerOf(good));
      const { result } = await run('responses', {
        accept: (text) => text.startsWith('{"findings":[]'),
      });
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 3 });
      const last = inputOf(fake.requests[2]!);
      expect(last.map(kindOf)).toEqual([
        'user',
        'reasoning',
        'message',
        'user',
        'reasoning',
        'message',
        'user',
      ]);
      expect(JSON.stringify(last.slice(1, 3))).toBe(JSON.stringify(cut));
      expect(JSON.stringify(last.slice(4, 6))).toBe(JSON.stringify(bad));
    });

    it('sends a turn whose calls were not run as its text alone: no reasoning, no call, and never a text that is blank', async () => {
      // The wrap-up answers with reasoning, words that are not the answer and a call, which is not run.
      const late = [reasoning('enc-late'), message('Enough.'), call('c9', { path: 'z.ts' })];
      fake.enqueue(answerOf(CONTENTS[0]!), answerOf(late), answerOf(CONTENTS[3]!));
      const { result } = await run('responses', {
        limits: { ...LIMITS, maxTurns: 1 },
        accept: (text) => text.startsWith('{'),
      });
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 3 });
      const history = inputOf(fake.requests[2]!);
      // The turn before it keeps its reasoning; this one is its text and nothing else.
      expect(history.map(kindOf)).toEqual([
        'user',
        'reasoning',
        'message',
        'function_call',
        'function_call_output',
        'user',
        'assistant',
        'user',
      ]);
      expect(JSON.stringify(history.slice(1, 4))).toBe(JSON.stringify(CONTENTS[0]));
      expect(history[6]).toEqual({
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Enough.' }],
      });
      expect(fake.requests[2]!.body).not.toContain('enc-late');
      expect(fake.requests[2]!.body).not.toContain('"c9"');
    });

    it('a turn that only reasoned before it was cut off is not in the history: there is no message of its own to send', async () => {
      fake.enqueue(answerOf([reasoning('enc-half')], { cut: true }), answerOf(CONTENTS[3]!));
      const { result } = await run('responses');
      expect(result).toMatchObject({ kind: 'answer', turns: 2 });
      expect(fake.requests[1]!.body).not.toContain('enc-half');
      expect(inputOf(fake.requests[1]!).map(kindOf)).toEqual(['user', 'user']);
    });

    it('a call whose arguments are not JSON is answered with the retry message, and goes back as the model made it', async () => {
      // A call cut off in its arguments: the history says it as it was said, as a model that
      // reasoned expects, and the result beside it tells the model what was wrong with it.
      const truncated = { ...call('c1', {}), arguments: '{"path": "a.ts"', status: 'incomplete' };
      fake.enqueue(
        answerOf([reasoning('enc-1'), truncated], { cut: true }),
        answerOf(CONTENTS[3]!),
      );
      const { result, ran } = await run('responses');
      expect(result).toMatchObject({ kind: 'answer', turns: 2, toolCalls: 0 });
      expect(ran).toEqual([]);
      const second = inputOf(fake.requests[1]!);
      expect(second[2]).toEqual(truncated);
      expect(second[3]).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
      expect(unwrap(String(second[3]!.output)).result).toBe(BAD_ARGUMENTS);
    });

    it('a conversation without tools names JSON in its first message, and the retry that says JSON changes nothing before it', async () => {
      // JSON mode is on and there are no tools (a reply on a branch with no snapshot): the API
      // wants the word json in the input messages, and the first message does not say it.
      fake.enqueue(answerOf([message('not json')]), answerOf([message('{"findings":[]}')]));
      const { result } = await run('responses', {
        tools: [],
        accept: (text) => text.startsWith('{'),
      });
      expect(result).toMatchObject({ kind: 'answer', text: '{"findings":[]}', turns: 2 });
      const [first, second] = fake.requests.map(inputOf);
      expect(first).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: USER_TEXT },
            { type: 'input_text', text: 'Reply in JSON.' },
          ],
        },
      ]);
      // The second request holds the first message as it was, then the answer and the retry words.
      expect(JSON.stringify(second![0])).toBe(JSON.stringify(first![0]));
      expect(second!.map(kindOf)).toEqual(['user', 'message', 'user']);
      expect(fake.requests[1]!.body.split('Reply in JSON.')).toHaveLength(2);
    });

    it('a refusal after reasoning ends the conversation as a bad answer with what it spent, and sends nothing more', async () => {
      const refusal = responsesAnswer('', {
        refusal: 'No.',
        reasoning: [responsesReasoning('enc-refused')],
        usage: { input_tokens: 700, output_tokens: 900 },
      });
      fake.enqueue(
        answerOf(CONTENTS[0]!, { tokens: [431, 102] }),
        { status: 200, body: refusal },
        answerOf(CONTENTS[3]!),
      );
      const { result } = await run('responses');
      expect(result).toMatchObject({
        kind: 'failed',
        reason: 'bad_answer',
        turns: 2,
        inputTokens: 431 + 700,
        outputTokens: 102 + 900,
      });
      expect(fake.requests).toHaveLength(2);
    });

    it('counts the reasoning it sends again in what it guesses a call cost, as the history is part of the input', async () => {
      // A provider that counts nothing: the guess is of the JSON sent, the replay with it.
      const uncounted = (output: Item[]): LlmReply => {
        const reply = answerOf(output);
        delete (reply.body as { usage?: unknown }).usage;
        return reply;
      };
      const heavy = [reasoning('e'.repeat(40_000)), call('c1', { path: 'a.ts' })];
      fake.enqueue(uncounted(heavy), uncounted(CONTENTS[3]!));
      const { result } = await run('responses');
      // 40 000 characters of reasoning are some 10 000 tokens the second call is charged for.
      expect(result).toMatchObject({ kind: 'answer', turns: 2 });
      expect((result as { inputTokens: number }).inputTokens).toBeGreaterThan(10_000);
    });
  });
});
