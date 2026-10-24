import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicAnswer,
  anthropicToolUse,
  createFakeLlm,
  llmShape,
  openAiAnswer,
  openAiToolCalls,
  type FakeLlm,
} from '../../../test/fake-llm';
import { parseInternalHosts } from '../../scm/url';
import {
  callProvider,
  converse,
  LlmCallAborted,
  LlmError,
  MAX_TOKEN_COUNT,
  type LlmConversation,
  type ProviderConfig,
} from './index';

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
    });

    fake.say('{"findings":[]}');
    await converse(
      anthropic,
      fake.apiKey,
      {
        ...start,
        messages: [
          { role: 'user', text: 'Review this change' },
          { role: 'assistant', text: turn.text, toolCalls: turn.toolCalls },
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
      system: 'S',
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
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'a.ts\nb.ts' },
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
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
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
          { type: 'text', text: 'Answer now' },
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
          { type: 'text', text: 'Answer shorter' },
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
    });
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
        system: 'S',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Review this change' }] }],
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

    it('anthropic: sends the temperature when configured', async () => {
      await converse({ ...anthropic, temperature: 0.5 }, fake.apiKey, start, http);
      expect(sent()).toMatchObject({ temperature: 0.5 });
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
          'The model does not accept max_tokens; set the output limit field to max_completion_tokens in the AI assistant settings',
      });
    });
  });

  describe('a call its caller gives up (the signal of the call)', () => {
    it.each(KINDS)(
      '%s: is cut at once while the provider answers, and is no failure of the provider’s',
      async (kind) => {
        let received!: () => void;
        const asked = new Promise<void>((resolve) => {
          received = resolve;
        });
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        fake.enqueue(async () => {
          received();
          await held;
          return { status: 200, body: openAiAnswer('{}') };
        });
        const controller = new AbortController();
        try {
          const call = converse({ ...configFor(kind), timeoutSeconds: 60 }, fake.apiKey, start, {
            ...http,
            signal: controller.signal,
          }).catch((e: unknown) => e);
          await asked;
          const aborted = Date.now();
          controller.abort();
          const err = await call;
          expect(Date.now() - aborted).toBeLessThan(2_000);
          expect(err).toBeInstanceOf(LlmCallAborted);
          expect(err).not.toBeInstanceOf(LlmError);
          // The connection is closed: the provider sees its caller hang up.
          await vi.waitFor(() => expect(fake.abandoned).toEqual([fake.requests[0]]));
        } finally {
          release();
        }
      },
    );

    it.each(KINDS)('%s: sends nothing once its signal is aborted', async (kind) => {
      const err = await converse(configFor(kind), fake.apiKey, start, {
        ...http,
        signal: AbortSignal.abort(),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmCallAborted);
      expect(fake.requests).toHaveLength(0);
    });
  });

  // Anthropic's errors name no parameter and no code, so these two are OpenAI's alone.
  it('openai: a refusal is flagged by the parameter it refuses and the code that says it is unsupported, whatever the words', async () => {
    fake.enqueue({
      status: 400,
      body: {
        error: {
          message: 'Invalid value',
          type: 'invalid_request_error',
          param: 'tools',
          code: 'unsupported_parameter',
        },
      },
    });
    const err = await converse(openai, fake.apiKey, start, http).catch((e: unknown) => e);
    expect(err).toMatchObject({ failure: 'rejected', status: 400, refusedTools: true });
  });

  it('openai: the parameter alone, with nothing that says it is unsupported, is some other refusal', async () => {
    fake.enqueue({
      status: 400,
      body: {
        error: {
          message: 'Invalid value',
          type: 'invalid_request_error',
          param: 'tools',
          code: null,
        },
      },
    });
    const err = await converse(openai, fake.apiKey, start, http).catch((e: unknown) => e);
    expect(err).toMatchObject({ failure: 'rejected', status: 400, refusedTools: false });
  });

  describe.each(KINDS)('%s: a refusal that names tools', (kind) => {
    // The error body of each kind's API.
    const errorBody = (message: string, over: { param?: string; code?: string } = {}): unknown =>
      kind === 'anthropic'
        ? { type: 'error', error: { type: 'invalid_request_error', message } }
        : { error: { message, type: 'invalid_request_error', param: null, code: null, ...over } };
    const refusal = async (body: unknown, status = 400, conversation = start) => {
      fake.enqueue({ status, body });
      return converse(configFor(kind), fake.apiKey, conversation, http).catch((e: unknown) => e);
    };

    it.each([
      [400, 'registry.ollama.ai/library/gemma:2b does not support tools'],
      [404, 'This model does not support tool use'],
      [422, 'Function calling is not enabled for this model'],
      [400, 'Unrecognized request argument supplied: tool_choice'],
      [400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser'],
      [400, 'tools param requires --jinja flag'],
      [400, "Unsupported parameter: 'tools' is not supported with this model."],
      [400, 'tools: Extra inputs are not permitted'],
      [400, "This model doesn't support function calling"],
      [400, "Unsupported parameter: 'tools'"],
      [400, 'This endpoint cannot support tool use'],
      // OpenRouter, when no provider behind the model can call tools: it says what is missing.
      [
        404,
        'No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing',
      ],
      // The same kind of sentence with the other words for them.
      [400, 'No model found that supports function calling'],
      [404, 'Only an endpoint that supports tools can take tool_choice'],
      [400, 'This route only serves models that support functions'],
      // Whatever whitespace the words are set apart with.
      [400, 'No endpoints found that\nsupport  tool use'],
    ])('HTTP %i %s is flagged, with a fixed message that names tools', async (status, message) => {
      const err = await refusal(errorBody(message), status);
      expect(err).toBeInstanceOf(LlmError);
      expect(err).toMatchObject({ failure: 'rejected', status, refusedTools: true });
      expect((err as Error).message).toMatch(/\btools\b/);
      // Fixed text: nothing of the provider's own words.
      expect((err as Error).message).not.toContain(message.slice(0, 20));
    });

    it('is flagged when the code of the error is a number, as OpenRouter writes it', async () => {
      const err = await refusal(
        {
          error: {
            message:
              'No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing',
            code: 404,
          },
        },
        404,
      );
      expect(err).toMatchObject({ failure: 'rejected', status: 404, refusedTools: true });
    });

    it('is flagged when the error is at the top of the body or a plain string', async () => {
      const top = await refusal({ object: 'error', message: 'tools are not supported', code: 400 });
      const text = await refusal({ error: 'model does not support tools' });
      expect(top).toMatchObject({ failure: 'rejected', refusedTools: true });
      expect(text).toMatchObject({ failure: 'rejected', refusedTools: true });
    });

    it.each([
      ['a refusal that says nothing of tools', errorBody('Model not found')],
      [
        'a search for endpoints that says nothing of tools',
        errorBody(
          'No endpoints found for acme/some-model. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing',
        ),
      ],
      [
        'a sentence about what an endpoint supports that does not name tools',
        errorBody('No endpoints found that support the requested context length'),
      ],
      ['an unreadable body', 'not json at all'],
      ['a body that is not an object', [1, 2]],
      [
        'a context length error that counts the functions',
        errorBody(
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens (8000 in the messages, 1000 in the functions). Please reduce the length of the messages or functions.",
          { param: 'messages', code: 'context_length_exceeded' },
        ),
      ],
      [
        "OpenAI's refusal of the schema of a function",
        errorBody(
          "Invalid schema for function 'read_file': In context=('properties', 'path'), 'minimum' is not permitted.",
          { param: 'tools[0].function.parameters' },
        ),
      ],
      [
        'a refusal of a schema that names the parameter tools',
        errorBody("Invalid schema for function 'read_file': 'type' is required.", {
          param: 'tools',
        }),
      ],
      [
        "Anthropic's refusal of an input schema",
        errorBody(
          'tools.0.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12 (https://json-schema.org/draft/2020-12). Learn more about tool use at https://docs.claude.com/en/docs/tool-use.',
        ),
      ],
      [
        'a tool name that does not match the pattern',
        errorBody("tools[0].function.name: string does not match pattern '^[a-zA-Z0-9_-]{1,64}$'"),
      ],
      [
        'an empty list of tools',
        errorBody("Invalid 'tools': empty array. Expected an array with minimum length 1."),
      ],
      [
        'an unsupported parameter that is not a tool one',
        errorBody("Unsupported parameter: 'temperature' is not supported with this model.", {
          param: 'temperature',
          code: 'unsupported_parameter',
        }),
      ],
      [
        'a refusal of an input schema that says only "input_schema"',
        errorBody('tools.0.input_schema: Extra inputs are not permitted'),
      ],
      [
        'a role the server does not know',
        errorBody(
          "Invalid value: 'tool'. Supported values are: 'system', 'assistant', 'user', and 'function'.",
        ),
      ],
    ])('is not flagged: %s', async (_name, body) => {
      const err = await refusal(body);
      expect(err).toMatchObject({ failure: 'rejected', status: 400, refusedTools: false });
      expect((err as Error).message).toBe(
        'The provider refused the request (HTTP 400); check the base URL and model',
      );
    });

    it('is not flagged for a status that is not a refusal of the request, such as a 5xx', async () => {
      const err = await refusal(errorBody('tools are down'), 503);
      expect(err).toMatchObject({ failure: 'unavailable', refusedTools: false });
    });

    it('is not flagged when no tools were sent, by converse or by callProvider', async () => {
      const body = errorBody('This model does not support tools');
      const without = await refusal(body, 400, { ...start, tools: [] });
      expect(without).toMatchObject({ failure: 'rejected', refusedTools: false });
      fake.enqueue({ status: 400, body });
      const single = await callProvider(
        configFor(kind),
        fake.apiKey,
        { system: 'S', user: 'U', maxOutputTokens: 50 },
        http,
      ).catch((e: unknown) => e);
      expect(single).toMatchObject({ failure: 'rejected', refusedTools: false });
    });
  });
});
