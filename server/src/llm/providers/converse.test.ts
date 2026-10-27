import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anthropicAnswer,
  anthropicToolUse,
  createFakeLlm,
  llmShape,
  openAiAnswer,
  openAiToolCalls,
  responsesAnswer,
  responsesToolCalls,
  type FakeLlm,
} from '../../../test/fake-llm';
import { parseInternalHosts } from '../../scm/url';
import {
  callProvider,
  converse,
  LlmError,
  MAX_TOKEN_COUNT,
  type LlmConversation,
  type ProviderConfig,
  type StreamLimits,
} from './index';

/** Stream limits a test does not run into. */
const STREAM: StreamLimits = {
  firstByteMs: 5_000,
  idleMs: 5_000,
  totalMs: 60_000,
  maxStreamBytes: 16 * 1024 * 1024,
};

const readFile = {
  name: 'read_file',
  description: 'Read a file of the repository snapshot',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } },
    required: ['path'],
  },
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

const KINDS = ['openai', 'anthropic'] as const;

interface OpenAiToolCallBody {
  id?: unknown;
  function: { name?: unknown; arguments?: unknown };
}
interface OpenAiToolBody {
  choices: { finish_reason: string; message: { tool_calls: OpenAiToolCallBody[] } }[];
}
interface AnthropicToolBody {
  content: { id?: unknown; name?: unknown; input?: unknown }[];
  stop_reason: string;
}

/**
 * A chat completion whose usage says that none of its prompt was cached, as the recorded Responses
 * answer says (`cached_tokens` 0), which the recorded chat completion does not: the two wires then
 * read the same usage.
 */
function noneCached(body: unknown): unknown {
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return body;
  return { ...(body as object), usage: { ...usage, prompt_tokens_details: { cached_tokens: 0 } } };
}

describe('converse: conversations with read-only tools (R5)', () => {
  let fake: FakeLlm;
  let http: { internalHosts: ReadonlySet<string>; version: string };
  let openai: ProviderConfig;
  let anthropic: ProviderConfig;
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
      api: 'chat_completions',
      workspaceId: null,
      timeoutSeconds: 5,
    } as const;
    openai = { kind: 'openai', baseUrl: fake.openAiBaseUrl, ...base };
    anthropic = { kind: 'anthropic', baseUrl: fake.anthropicBaseUrl, ...base };
  });
  afterEach(async () => {
    await fake.close();
  });

  /** The JSON body of the n-th request the fake received. */
  const sent = (n = 0): Record<string, unknown> =>
    fake.requests[n]!.json as Record<string, unknown>;
  const configFor = (kind: (typeof KINDS)[number]): ProviderConfig =>
    kind === 'anthropic' ? anthropic : openai;

  it("openai: sends tools and the tool round trip in OpenAI's shape", async () => {
    fake.say('{"findings":[]}');
    await converse(
      openai,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [
              { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts', from: 1 } },
            ],
          },
          { role: 'tool', callId: 'call_1', name: 'read_file', text: 'const a = 1;' },
        ],
      },
      http,
    );
    const request = fake.requests[0]!;
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
    expect(request.headers['user-agent']).toBe('Qualor/0.0.0');
    const body = sent() as { tools: unknown[]; messages: { role: string }[] };
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: readFile.description,
        parameters: readFile.parameters,
      },
    });
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    // The JSON mode is on in this config, and still off while tools are sent.
    expect(openai.jsonMode).toBe('json_object');
    expect(body).not.toHaveProperty('response_format');
    expect(body).toEqual({
      model: 'm-1',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'Review this change' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/a.ts","from":1}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'const a = 1;' },
      ],
      max_tokens: 50,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: readFile.description,
            parameters: readFile.parameters,
          },
        },
        {
          type: 'function',
          function: {
            name: 'list_files',
            description: listFiles.description,
            parameters: listFiles.parameters,
          },
        },
      ],
      tool_choice: 'auto',
    });
  });

  it('openai: an assistant turn keeps its text and its parallel calls in order; one without calls has no tool_calls key', async () => {
    await converse(
      openai,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: 'Reading two things.',
            toolCalls: [
              { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts' } },
              { id: 'call_2', name: 'list_files', arguments: { dir: 'src' } },
            ],
          },
          { role: 'tool', callId: 'call_1', name: 'read_file', text: 'one' },
          { role: 'tool', callId: 'call_2', name: 'list_files', text: 'two' },
          { role: 'assistant', text: 'Both look fine.', toolCalls: [] },
          { role: 'user', text: 'Go on' },
        ],
      },
      http,
    );
    expect((sent() as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Review this change' },
      {
        role: 'assistant',
        content: 'Reading two things.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'list_files', arguments: '{"dir":"src"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'one' },
      { role: 'tool', tool_call_id: 'call_2', content: 'two' },
      { role: 'assistant', content: 'Both look fine.' },
      { role: 'user', content: 'Go on' },
    ]);
  });

  it('openai: builds an assistant turn from its text and calls, and ignores a replay (that of another kind), and has none of its own', async () => {
    await converse(
      openai,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: 'Reading.',
            toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
            replay: {
              kind: 'anthropic',
              items: [{ type: 'thinking', thinking: '', signature: 'SIGNATURE' }],
            },
          },
          { role: 'tool', callId: 'call_1', name: 'read_file', text: 'A' },
        ],
      },
      http,
    );
    expect((sent() as { messages: unknown[] }).messages[2]).toEqual({
      role: 'assistant',
      content: 'Reading.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        },
      ],
    });
    expect(fake.requests[0]!.body).not.toContain('SIGNATURE');
    fake.say('{"findings":[]}');
    expect(await converse(openai, fake.apiKey, start, http)).not.toHaveProperty('replay');
  });

  it('openai: tool calls come back with parsed arguments; unparseable arguments stay a string', async () => {
    fake.enqueue({
      status: 200,
      body: openAiToolCalls(
        [
          { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts', from: 3 } },
          { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
          { id: 'call_3', name: 'list_files', arguments: { dir: 'tests' } },
        ],
        { text: 'Let me look.' },
      ),
    });
    const turn = await converse(openai, fake.apiKey, start, http);
    expect(turn).toEqual({
      text: 'Let me look.',
      finishReason: 'tool',
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts', from: 3 } },
        { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
        { id: 'call_3', name: 'list_files', arguments: { dir: 'tests' } },
      ],
      usage: { inputTokens: 412, outputTokens: 96 },
      model: 'fake-openai-model',
    });
  });

  it('openai: a call whose arguments are missing has none (an empty object)', async () => {
    const body = openAiToolCalls([{ id: 'call_1', name: 'list_files', arguments: {} }]);
    delete (body as OpenAiToolBody).choices[0]!.message.tool_calls[0]!.function.arguments;
    fake.enqueue({ status: 200, body });
    const turn = await converse(openai, fake.apiKey, start, http);
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'list_files', arguments: {} }]);
  });

  it('anthropic: tool_use blocks become tool calls; tool results go back as one user message of tool_result blocks in order', async () => {
    fake.enqueue({
      status: 200,
      body: anthropicToolUse(
        [
          { id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } },
          { id: 'toolu_2', name: 'list_files', input: { dir: 'src' } },
        ],
        { text: 'Checking two things.' },
      ),
    });
    const turn = await converse(anthropic, fake.apiKey, start, http);
    expect(turn).toEqual({
      text: 'Checking two things.',
      finishReason: 'tool',
      toolCalls: [
        { id: 'toolu_1', name: 'read_file', arguments: { path: 'src/a.ts' } },
        { id: 'toolu_2', name: 'list_files', arguments: { dir: 'src' } },
      ],
      usage: { inputTokens: 431, outputTokens: 102 },
      model: 'fake-anthropic-model',
      // The content as it came, to send the turn back as the model made it.
      replay: {
        kind: 'anthropic',
        items: [
          { type: 'text', text: 'Checking two things.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } },
          { type: 'tool_use', id: 'toolu_2', name: 'list_files', input: { dir: 'src' } },
        ],
      },
    });

    fake.say('{"findings":[]}');
    await converse(
      anthropic,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          { role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, replay: turn.replay },
          { role: 'tool', callId: 'toolu_1', name: 'read_file', text: 'const a = 1;' },
          { role: 'tool', callId: 'toolu_2', name: 'list_files', text: 'a.ts\nb.ts' },
        ],
      },
      http,
    );
    const request = fake.requests[1]!;
    expect(request.path).toBe('/v1/messages');
    expect(request.headers['x-api-key']).toBe(fake.apiKey);
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.json).toEqual({
      model: 'm-1',
      max_tokens: 50,
      // The system prompt as one block, and the last block of the last message, carry the
      // prompt-cache markers (R49).
      system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Review this change' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking two things.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } },
            { type: 'tool_use', id: 'toolu_2', name: 'list_files', input: { dir: 'src' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'const a = 1;' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: 'a.ts\nb.ts',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'read_file',
          description: readFile.description,
          input_schema: readFile.parameters,
        },
        {
          name: 'list_files',
          description: listFiles.description,
          input_schema: listFiles.parameters,
        },
      ],
      // Only auto: the current models refuse a forced choice.
      tool_choice: { type: 'auto' },
    });
  });

  it('anthropic: an assistant turn is its text (when there is some) then its tool_use blocks, and each run of tool messages is one user message', async () => {
    await converse(
      anthropic,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 'toolu_a', name: 'read_file', arguments: { path: 'a.ts' } }],
          },
          { role: 'tool', callId: 'toolu_a', name: 'read_file', text: 'A' },
          {
            role: 'assistant',
            text: 'Now two.',
            toolCalls: [
              { id: 'toolu_b', name: 'read_file', arguments: { path: 'b.ts' } },
              { id: 'toolu_c', name: 'read_file', arguments: { path: 'c.ts' } },
            ],
          },
          { role: 'tool', callId: 'toolu_b', name: 'read_file', text: 'B' },
          { role: 'tool', callId: 'toolu_c', name: 'read_file', text: 'C' },
          { role: 'assistant', text: 'Done.', toolCalls: [] },
          { role: 'user', text: 'Thanks' },
        ],
      },
      http,
    );
    expect((sent() as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Review this change' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Now two.' },
          { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'b.ts' } },
          { type: 'tool_use', id: 'toolu_c', name: 'read_file', input: { path: 'c.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_b', content: 'B' },
          { type: 'tool_result', tool_use_id: 'toolu_c', content: 'C' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      // The last block of the last message carries the prompt-cache marker (R49).
      {
        role: 'user',
        content: [{ type: 'text', text: 'Thanks', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('anthropic: an assistant text of only whitespace is no text block (the API refuses one)', async () => {
    await converse(
      anthropic,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: '\n\n',
            toolCalls: [{ id: 'toolu_a', name: 'read_file', arguments: { path: 'a.ts' } }],
          },
          { role: 'tool', callId: 'toolu_a', name: 'read_file', text: 'A' },
        ],
      },
      http,
    );
    expect((sent() as { messages: { content: unknown[] }[] }).messages[1]!.content).toEqual([
      { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  it('anthropic: a user message that follows tool results is a text block after them, in their message', async () => {
    await converse(
      anthropic,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [
              { id: 'toolu_a', name: 'read_file', arguments: { path: 'a.ts' } },
              { id: 'toolu_b', name: 'read_file', arguments: { path: 'b.ts' } },
            ],
          },
          { role: 'tool', callId: 'toolu_a', name: 'read_file', text: 'A' },
          { role: 'tool', callId: 'toolu_b', name: 'read_file', text: 'B' },
          { role: 'user', text: 'Answer now' },
        ],
      },
      http,
    );
    // One user message, the results first: a strict endpoint refuses two user messages in a row.
    expect((sent() as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Review this change' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'b.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' },
          { type: 'tool_result', tool_use_id: 'toolu_b', content: 'B' },
          // The last block of the last message carries the prompt-cache marker (R49).
          { type: 'text', text: 'Answer now', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
  });

  it('anthropic: user messages in a row are one user message of text blocks', async () => {
    await converse(
      anthropic,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          { role: 'user', text: 'Answer shorter' },
        ],
      },
      http,
    );
    expect((sent() as { messages: unknown[] }).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this change' },
          // The last block of the last message carries the prompt-cache marker (R49).
          { type: 'text', text: 'Answer shorter', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
  });

  it('anthropic: an assistant message between two user messages keeps them apart', async () => {
    await converse(
      anthropic,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 'toolu_a', name: 'read_file', arguments: { path: 'a.ts' } }],
          },
          { role: 'tool', callId: 'toolu_a', name: 'read_file', text: 'A' },
          { role: 'assistant', text: 'Looks fine.', toolCalls: [] },
          { role: 'user', text: 'Go on' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 'toolu_b', name: 'read_file', arguments: { path: 'b.ts' } }],
          },
          { role: 'tool', callId: 'toolu_b', name: 'read_file', text: 'B' },
        ],
      },
      http,
    );
    expect(
      (sent() as { messages: { role: string }[] }).messages.map((message) => message.role),
    ).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('openai: a user message after tool messages is a message of its own', async () => {
    await converse(
      openai,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
          },
          { role: 'tool', callId: 'call_1', name: 'read_file', text: 'A' },
          { role: 'user', text: 'Answer now' },
        ],
      },
      http,
    );
    expect(
      (sent() as { messages: { role: string }[] }).messages.map((message) => message.role),
    ).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
  });

  it('anthropic: a call whose input is missing has none (an empty object)', async () => {
    const body = anthropicToolUse([{ id: 'toolu_1', name: 'list_files', input: {} }]);
    delete (body as AnthropicToolBody).content[0]!.input;
    fake.enqueue({ status: 200, body });
    const turn = await converse(anthropic, fake.apiKey, start, http);
    expect(turn.toolCalls).toEqual([{ id: 'toolu_1', name: 'list_files', arguments: {} }]);
  });

  it.each(KINDS)('a turn without tool calls is text with finishReason stop (%s)', async (kind) => {
    fake.say('{"findings":[]}');
    const turn = await converse(configFor(kind), fake.apiKey, start, http);
    expect(turn).toEqual({
      text: '{"findings":[]}',
      finishReason: 'stop',
      toolCalls: [],
      usage:
        kind === 'openai'
          ? { inputTokens: 412, outputTokens: 96 }
          : { inputTokens: 431, outputTokens: 102 },
      model: kind === 'openai' ? 'fake-openai-model' : 'fake-anthropic-model',
      // Only the Anthropic adapter keeps what it needs to send a turn back as it came.
      ...(kind === 'anthropic'
        ? { replay: { kind: 'anthropic', items: [{ type: 'text', text: '{"findings":[]}' }] } }
        : {}),
    });
  });

  it('a Responses conversation with text, two function calls and usage equals the Chat Completions one', async () => {
    const calls = [
      { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts', from: 3 } },
      // Arguments that are not JSON stay the model's own text, on either wire.
      { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
    ];
    fake.enqueue(
      {
        status: 200,
        body: noneCached(
          openAiToolCalls(calls, {
            text: 'Let me look.',
            usage: { prompt_tokens: 120, completion_tokens: 34 },
          }),
        ),
      },
      {
        status: 200,
        body: responsesToolCalls(calls, {
          text: 'Let me look.',
          usage: { input_tokens: 120, output_tokens: 34 },
        }),
      },
    );
    const chat = await converse(openai, fake.apiKey, start, http);
    const responses = await converse({ ...openai, api: 'responses' }, fake.apiKey, start, http);
    // One path from the answer on: the same turn, but for what only the Responses wire keeps to
    // send it back as it came.
    const { replay, ...turn } = responses;
    expect(turn).toEqual(chat);
    expect(turn).toEqual({
      text: 'Let me look.',
      finishReason: 'tool',
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts', from: 3 } },
        { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
      ],
      usage: { inputTokens: 120, outputTokens: 34, cacheReadTokens: 0 },
      model: 'fake-openai-model',
    });
    expect(chat).not.toHaveProperty('replay');
    expect(replay).toMatchObject({ kind: 'openai' });
    expect(replay?.items.map((item) => (item as { type: string }).type)).toEqual([
      'message',
      'function_call',
      'function_call',
    ]);
  });

  it.each([
    ['a text that ends the turn', () => openAiAnswer('{"a":1}'), () => responsesAnswer('{"a":1}')],
    [
      'an answer cut off at its limit',
      () => openAiAnswer('{"a', { finishReason: 'length' }),
      () => responsesAnswer('{"a', { incomplete: 'max_output_tokens' }),
    ],
    [
      'an answer that stopped for a reason it does not know',
      () => openAiAnswer('Words', { finishReason: 'something_new' }),
      () => responsesAnswer('Words', { incomplete: 'something_new' }),
    ],
    [
      'a refusal',
      () => {
        const refused = openAiAnswer('x') as { choices: { message: Record<string, unknown> }[] };
        refused.choices[0]!.message.content = null;
        refused.choices[0]!.message.refusal = 'I cannot help with that.';
        return refused;
      },
      () => responsesAnswer('', { refusal: 'I cannot help with that.' }),
    ],
    [
      'a missing usage',
      () => openAiAnswer('{}', { usage: null }),
      () => responsesAnswer('{}', { usage: null }),
    ],
    [
      'a usage that is not a count',
      () => ({
        ...(openAiAnswer('{}') as object),
        usage: { prompt_tokens: -1, completion_tokens: 2.5 },
      }),
      () => ({
        ...(responsesAnswer('{}') as object),
        usage: { input_tokens: -1, output_tokens: 2.5 },
      }),
    ],
  ])('reads %s as the Chat Completions wire does', async (_what, chatBody, responsesBody) => {
    const responses: ProviderConfig = { ...openai, api: 'responses' };
    // The replies are taken in the order of the calls: a call and a conversation, each on the
    // Responses wire first.
    fake.enqueue(
      { status: 200, body: responsesBody() },
      { status: 200, body: noneCached(chatBody()) },
      { status: 200, body: responsesBody() },
      { status: 200, body: noneCached(chatBody()) },
    );
    const call = { system: 'S', user: 'U', maxOutputTokens: 50 };
    expect(await callProvider(responses, fake.apiKey, call, http)).toEqual(
      await callProvider(openai, fake.apiKey, call, http),
    );
    const turn = await converse(responses, fake.apiKey, start, http);
    // What only the Responses wire keeps to send the turn back (a refusal has none), apart, it is
    // the same turn.
    expect(turn.replay?.kind).toBe(turn.finishReason === 'refusal' ? undefined : 'openai');
    delete turn.replay;
    expect(turn).toEqual(await converse(openai, fake.apiKey, start, http));
  });

  it('openai: an empty tool_calls list is no tool call', async () => {
    const body = openAiAnswer('Nothing to look up.') as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message.tool_calls = [];
    fake.enqueue({ status: 200, body });
    const turn = await converse(openai, fake.apiKey, start, http);
    expect(turn).toMatchObject({
      text: 'Nothing to look up.',
      finishReason: 'stop',
      toolCalls: [],
    });
  });

  it('is a tool turn whatever finish reason the provider gives, once there are calls', async () => {
    const openAiBody = openAiToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]);
    (openAiBody as OpenAiToolBody).choices[0]!.finish_reason = 'stop';
    const anthropicBody = anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: {} }]);
    (anthropicBody as AnthropicToolBody).stop_reason = 'end_turn';
    fake.enqueue({ status: 200, body: openAiBody }, { status: 200, body: anthropicBody });
    expect((await converse(openai, fake.apiKey, start, http)).finishReason).toBe('tool');
    expect((await converse(anthropic, fake.apiKey, start, http)).finishReason).toBe('tool');
  });

  it('openai: reads an answer with content null as refusal, and refuses one with no content, calls or refusal', async () => {
    const refused = openAiAnswer('x') as { choices: { message: Record<string, unknown> }[] };
    refused.choices[0]!.message.content = null;
    refused.choices[0]!.message.refusal = 'I cannot help with that.';
    fake.enqueue({ status: 200, body: refused });
    expect(await converse(openai, fake.apiKey, start, http)).toMatchObject({
      text: '',
      finishReason: 'refusal',
      toolCalls: [],
    });
    const empty = openAiAnswer('x') as { choices: { message: Record<string, unknown> }[] };
    empty.choices[0]!.message.content = null;
    fake.enqueue({ status: 200, body: empty });
    await expect(converse(openai, fake.apiKey, start, http)).rejects.toMatchObject({
      failure: 'bad_answer',
    });
  });

  it('anthropic: reads the text blocks as one text, and a refusal as refusal', async () => {
    fake.enqueue(
      {
        status: 200,
        body: {
          ...(anthropicAnswer('') as object),
          content: [
            { type: 'text', text: '{"a"' },
            { type: 'text', text: ':1}' },
          ],
        },
      },
      { status: 200, body: anthropicAnswer('No.', { stopReason: 'refusal' }) },
    );
    expect(await converse(anthropic, fake.apiKey, start, http)).toMatchObject({
      text: '{"a":1}',
      finishReason: 'stop',
      toolCalls: [],
    });
    expect(await converse(anthropic, fake.apiKey, start, http)).toMatchObject({
      finishReason: 'refusal',
    });
  });

  describe('a tool call without an id or a name is a bad_answer', () => {
    const brokenOpenAi: [string, (call: OpenAiToolCallBody) => void][] = [
      ['no id', (call) => void delete call.id],
      ['an empty id', (call) => void (call.id = '')],
      ['an id that is not a string', (call) => void (call.id = 7)],
      ['no name', (call) => void delete call.function.name],
      ['an empty name', (call) => void (call.function.name = '')],
      ['a name that is not a string', (call) => void (call.function.name = ['read_file'])],
    ];
    it.each(brokenOpenAi)('openai: %s', async (_name, change) => {
      const body = openAiToolCalls([
        { id: 'call_1', name: 'read_file', arguments: {} },
        { id: 'call_2', name: 'read_file', arguments: {} },
      ]);
      change((body as OpenAiToolBody).choices[0]!.message.tool_calls[1]!);
      fake.enqueue({ status: 200, body });
      const err = await converse(openai, fake.apiKey, start, http).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(err).toMatchObject({
        failure: 'bad_answer',
        message: "The provider's answer was not understood",
      });
    });

    const brokenAnthropic: [string, (block: AnthropicToolBody['content'][number]) => void][] = [
      ['no id', (block) => void delete block.id],
      ['an empty id', (block) => void (block.id = '')],
      ['an id that is not a string', (block) => void (block.id = 7)],
      ['no name', (block) => void delete block.name],
      ['an empty name', (block) => void (block.name = '')],
      ['a name that is not a string', (block) => void (block.name = ['read_file'])],
    ];
    it.each(brokenAnthropic)('anthropic: %s', async (_name, change) => {
      const body = anthropicToolUse([
        { id: 'toolu_1', name: 'read_file', input: {} },
        { id: 'toolu_2', name: 'read_file', input: {} },
      ]);
      change((body as AnthropicToolBody).content[1]!);
      fake.enqueue({ status: 200, body });
      const err = await converse(anthropic, fake.apiKey, start, http).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(err).toMatchObject({
        failure: 'bad_answer',
        message: "The provider's answer was not understood",
      });
    });

    it('callProvider still answers such a call as a tool turn (the single-shot path is unchanged)', async () => {
      const openAiBody = openAiToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]);
      delete (openAiBody as OpenAiToolBody).choices[0]!.message.tool_calls[0]!.id;
      const anthropicBody = anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: {} }]);
      delete (anthropicBody as AnthropicToolBody).content[0]!.name;
      fake.enqueue({ status: 200, body: openAiBody }, { status: 200, body: anthropicBody });
      const call = { system: 'S', user: 'U', maxOutputTokens: 50 };
      expect((await callProvider(openai, fake.apiKey, call, http)).finishReason).toBe('tool');
      expect((await callProvider(anthropic, fake.apiKey, call, http)).finishReason).toBe('tool');
    });
  });

  describe('usage tokens are read as callProvider reads them', () => {
    it.each([
      ['whole numbers', 412, 96, { inputTokens: 412, outputTokens: 96 }],
      [
        'zero and the ceiling',
        0,
        MAX_TOKEN_COUNT,
        { inputTokens: 0, outputTokens: MAX_TOKEN_COUNT },
      ],
      ['negative', -1, 7, { inputTokens: null, outputTokens: 7 }],
      ['fractional', 1.5, 7, { inputTokens: null, outputTokens: 7 }],
      ['over the ceiling', MAX_TOKEN_COUNT + 1, 7, { inputTokens: null, outputTokens: 7 }],
      ['huge', 1e300, 7, { inputTokens: null, outputTokens: 7 }],
      ['a string', '412', 7, { inputTokens: null, outputTokens: 7 }],
      ['null', null, 7, { inputTokens: null, outputTokens: 7 }],
    ])('%s (both kinds, tool turns)', async (_name, first, second, expected) => {
      const openAiBody = {
        ...(openAiToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]) as object),
        usage: { prompt_tokens: first, completion_tokens: second },
      };
      const anthropicBody = {
        ...(anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: {} }]) as object),
        usage: { input_tokens: first, output_tokens: second },
      };
      const call = { system: 'S', user: 'U', maxOutputTokens: 50 };
      fake.enqueue(
        { status: 200, body: openAiBody },
        { status: 200, body: openAiBody },
        { status: 200, body: anthropicBody },
        { status: 200, body: anthropicBody },
      );
      const a = await callProvider(openai, fake.apiKey, call, http);
      const b = await converse(openai, fake.apiKey, start, http);
      const c = await callProvider(anthropic, fake.apiKey, call, http);
      const d = await converse(anthropic, fake.apiKey, start, http);
      expect([b.usage, d.usage]).toEqual([expected, expected]);
      expect([b.usage, b.model]).toEqual([a.usage, a.model]);
      expect([d.usage, d.model]).toEqual([c.usage, c.model]);
    });

    it('reads cached_tokens on Chat Completions and on the Responses API, and inputTokens stays the whole prompt (Chat Completions here)', async () => {
      const usage = {
        prompt_tokens: 10_000,
        completion_tokens: 50,
        total_tokens: 10_050,
        prompt_tokens_details: { cached_tokens: 8_000, audio_tokens: 0 },
      };
      const body = { ...(openAiAnswer('{}') as object), usage };
      const expected = { inputTokens: 10_000, outputTokens: 50, cacheReadTokens: 8_000 };
      fake.enqueue({ status: 200, body }, { status: 200, body }, { status: 200, body });
      expect((await converse(openai, fake.apiKey, start, http)).usage).toEqual(expected);
      expect(
        (await converse(openai, fake.apiKey, start, { ...http, stream: STREAM })).usage,
      ).toEqual(expected);
      const call = { system: 'S', user: 'U', maxOutputTokens: 50 };
      expect((await callProvider(openai, fake.apiKey, call, http)).usage).toEqual(expected);
      // OpenAI bills no write; and a cached count it did not give, or one past the prompt, is left out.
      fake.enqueue(
        { status: 200, body: { ...body, usage: { ...usage, prompt_tokens_details: {} } } },
        {
          status: 200,
          body: { ...body, usage: { ...usage, prompt_tokens_details: { cached_tokens: 10_001 } } },
        },
        {
          status: 200,
          body: { ...body, usage: { ...usage, prompt_tokens_details: { cached_tokens: 0 } } },
        },
      );
      const plain = { inputTokens: 10_000, outputTokens: 50 };
      expect((await converse(openai, fake.apiKey, start, http)).usage).toEqual(plain);
      expect((await converse(openai, fake.apiKey, start, http)).usage).toEqual(plain);
      expect((await converse(openai, fake.apiKey, start, http)).usage).toEqual({
        ...plain,
        cacheReadTokens: 0,
      });
    });

    it('reads a missing usage, and one that is not an object, as unknown', async () => {
      const unknown = { inputTokens: null, outputTokens: null };
      fake.enqueue(
        { status: 200, body: openAiAnswer('{}', { usage: null }) },
        { status: 200, body: { ...(openAiAnswer('{}') as object), usage: 'lots' } },
        { status: 200, body: anthropicAnswer('{}', { usage: null }) },
        { status: 200, body: { ...(anthropicAnswer('{}') as object), usage: 'lots' } },
      );
      expect((await converse(openai, fake.apiKey, start, http)).usage).toEqual(unknown);
      expect((await converse(openai, fake.apiKey, start, http)).usage).toEqual(unknown);
      expect((await converse(anthropic, fake.apiKey, start, http)).usage).toEqual(unknown);
      expect((await converse(anthropic, fake.apiKey, start, http)).usage).toEqual(unknown);
    });
  });

  describe('a conversation without tools', () => {
    const noTools: LlmConversation = { ...start, tools: [] };

    it('openai: sends no tools, and keeps the JSON mode the settings ask for', async () => {
      await converse(openai, fake.apiKey, noTools, http);
      await converse({ ...openai, jsonMode: 'none' }, fake.apiKey, noTools, http);
      expect(sent(0)).toEqual({
        model: 'm-1',
        messages: [
          { role: 'system', content: 'S' },
          { role: 'user', content: 'Review this change' },
        ],
        max_tokens: 50,
        response_format: { type: 'json_object' },
      });
      expect(sent(1)).not.toHaveProperty('response_format');
      expect(sent(1)).not.toHaveProperty('tools');
      expect(sent(1)).not.toHaveProperty('tool_choice');
    });

    it('anthropic: sends no tools', async () => {
      await converse(anthropic, fake.apiKey, noTools, http);
      expect(sent()).toEqual({
        model: 'm-1',
        max_tokens: 50,
        // With the prompt-cache markers of every conversation's call (R49).
        system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Review this change', cache_control: { type: 'ephemeral' } },
            ],
          },
        ],
      });
    });
  });

  it.each(KINDS)('callProvider sends no tools (%s)', async (kind) => {
    await callProvider(
      configFor(kind),
      fake.apiKey,
      { system: 'S', user: 'U', maxOutputTokens: 50 },
      http,
    );
    expect(sent()).not.toHaveProperty('tools');
    expect(sent()).not.toHaveProperty('tool_choice');
    expect(JSON.stringify(sent())).not.toContain('tool');
  });

  describe('the request is made as callProvider makes it', () => {
    it('openai: honours auth, maxTokensField and temperature', async () => {
      await converse(
        {
          ...openai,
          auth: 'api-key',
          maxTokensField: 'max_completion_tokens',
          temperature: 0,
        },
        fake.apiKey,
        start,
        http,
      );
      const request = fake.requests[0]!;
      expect(request.headers['api-key']).toBe(fake.apiKey);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.json).toMatchObject({ max_completion_tokens: 50, temperature: 0 });
      expect(request.json).not.toHaveProperty('max_tokens');
    });

    it('anthropic: sends no temperature, whatever the config holds', async () => {
      await converse({ ...anthropic, temperature: 0.5 }, fake.apiKey, start, http);
      expect(sent()).not.toHaveProperty('temperature');
    });

    it.each(KINDS)('%s: sends no key header without a key', async (kind) => {
      const open = await createFakeLlm({ apiKey: null });
      try {
        const config = {
          ...configFor(kind),
          baseUrl: kind === 'openai' ? open.openAiBaseUrl : open.anthropicBaseUrl,
        };
        const turn = await converse(config, null, start, {
          ...http,
          internalHosts: parseInternalHosts(open.host),
        });
        expect(turn.finishReason).toBe('stop');
        expect(open.requests).toHaveLength(1);
      } finally {
        await open.close();
      }
    });

    it.each(KINDS)('%s: never contacts an address that is not listed', async (kind) => {
      const err = await converse(configFor(kind), fake.apiKey, start, {
        ...http,
        internalHosts: new Set(),
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ failure: 'url_not_allowed' });
      expect(fake.requests).toHaveLength(0);
    });

    describe.each(KINDS)('%s: classifies a failure as callProvider does', (kind) => {
      it.each([
        [429, { 'retry-after': '7' }, 'rate_limited', 7],
        [401, {}, 'refused_key', null],
        [403, {}, 'refused_key', null],
        [400, {}, 'rejected', null],
        [500, {}, 'unavailable', null],
      ])('HTTP %i', async (status, headers, failure, retryAfter) => {
        fake.enqueue({ status, headers, body: llmShape('openai-error') });
        const err = await converse(configFor(kind), fake.apiKey, start, http).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(LlmError);
        expect(err).toMatchObject({ failure, status, retryAfterSeconds: retryAfter });
        expect((err as Error).message).not.toContain('Fake error text');
      });
    });

    it('names the output limit field when the model refuses the one it sent', async () => {
      fake.enqueue({
        status: 400,
        body: {
          error: {
            message: "Fake error text: Unsupported parameter: 'max_tokens'",
            type: 'invalid_request_error',
            param: 'max_tokens',
            code: 'unsupported_parameter',
          },
        },
      });
      const err = await converse(openai, fake.apiKey, start, http).catch((e: unknown) => e);
      expect(err).toMatchObject({
        failure: 'rejected',
        status: 400,
        message:
          'The model does not accept max_tokens; set the output limit parameter to max_completion_tokens in the AI provider settings',
      });
    });
  });
});
