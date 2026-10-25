import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicAnswer,
  anthropicRedactedThinking,
  anthropicThinking,
  anthropicToolUse,
  createFakeLlm,
  llmShape,
  type FakeLlm,
} from '../../../test/fake-llm';
import { parseInternalHosts } from '../../scm/url';
import {
  callProvider,
  converse,
  LLM_MAX_ANSWER_BYTES,
  LlmError,
  type LlmConversation,
  type LlmMessage,
  type ProviderConfig,
  type ProviderReplay,
} from './index';

/*
 * The Anthropic adapter against the current Claude models (Opus, Sonnet and Haiku 5.5, Fable 5.1,
 * and every model from 4.7 on): they refuse a sampling parameter or a forced tool choice, think
 * before they answer, bind their thinking to the conversation, refuse in an answer with a 200, and
 * want an organisation-wide key to name its workspace.
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

const call = { system: 'S', user: 'U', maxOutputTokens: 50 };
const start: LlmConversation = {
  system: 'S',
  messages: [{ role: 'user', text: 'Review this change' }],
  tools: [readFile, listFiles],
  maxOutputTokens: 50,
};
const WORKSPACE = 'wrkspc_01AbCdEf';
const NOT_SCOPED =
  'This key is not scoped to a workspace: give its workspace ID in the AI assistant settings.';

/** The content of a Messages answer, as the API sent it. */
interface Content {
  content: unknown[];
}
/** A Messages answer holding exactly `content`, ending the turn the way `stop` says. */
const answerOf = (content: unknown[], stop = 'tool_use'): unknown => ({
  ...(anthropicAnswer('') as object),
  content,
  stop_reason: stop,
});
const toolUseBlock = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

describe('the Anthropic adapter: the current models', () => {
  let fake: FakeLlm;
  let http: { internalHosts: ReadonlySet<string>; version: string };
  let anthropic: ProviderConfig;
  let openai: ProviderConfig;
  // One fake per test: a reply a failing test left in the queue never reaches the next test.
  beforeEach(async () => {
    // As the real API does, it refuses a text block that is empty or only whitespace.
    fake = await createFakeLlm({ refuseBlankText: true });
    http = { internalHosts: parseInternalHosts(fake.host), version: '0.0.0' };
    const base = {
      model: 'claude-x',
      auth: 'bearer',
      jsonMode: 'json_object',
      maxTokensField: 'max_tokens',
      temperature: null,
      api: 'chat_completions',
      workspaceId: null,
      timeoutSeconds: 5,
    } as const;
    anthropic = { kind: 'anthropic', baseUrl: fake.anthropicBaseUrl, ...base };
    openai = { kind: 'openai', baseUrl: fake.openAiBaseUrl, ...base };
  });
  afterEach(async () => {
    await fake.close();
  });

  const body = (n = 0): Record<string, unknown> =>
    fake.requests[n]!.json as Record<string, unknown>;
  const messagesOf = (n: number) =>
    (body(n) as { messages: { role: string; content: unknown[] }[] }).messages;

  describe('sampling parameters', () => {
    it('no temperature, top_p or top_k is ever sent to Anthropic, whatever the config holds', async () => {
      // The settings of an older version may hold a temperature: it reaches the adapter as it is.
      const config = { ...anthropic, temperature: 0.7 };
      const history: LlmMessage[] = [
        { role: 'user', text: 'Review this change' },
        {
          role: 'assistant',
          text: 'Reading.',
          toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } }],
        },
        { role: 'tool', callId: 'toolu_1', name: 'read_file', text: 'const a = 1;' },
      ];
      await callProvider(config, fake.apiKey, call, http);
      await converse(config, fake.apiKey, start, http);
      await converse(config, fake.apiKey, { ...start, tools: [] }, http);
      await converse(config, fake.apiKey, { ...start, messages: history }, http);
      expect(fake.requests).toHaveLength(4);
      for (const [n, request] of fake.requests.entries()) {
        for (const name of ['temperature', 'top_p', 'top_k']) {
          expect(body(n), `request ${n}`).not.toHaveProperty(name);
        }
        expect(request.body).not.toMatch(/temperature|top_p|top_k/);
        // Each model runs its own default way of thinking: no `thinking`, no `effort`.
        for (const name of ['thinking', 'effort', 'output_config']) {
          expect(body(n), `request ${n}`).not.toHaveProperty(name);
        }
      }
      // The fields of a request are those of the contract, and no others.
      expect(Object.keys(body(0)).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
      expect(Object.keys(body(1)).sort()).toEqual([
        'max_tokens',
        'messages',
        'model',
        'system',
        'tool_choice',
        'tools',
      ]);
      expect(Object.keys(body(2)).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    });

    it('the OpenAI adapter still sends the temperature that is configured', async () => {
      await callProvider({ ...openai, temperature: 0.2 }, fake.apiKey, call, http);
      expect(body()).toMatchObject({ temperature: 0.2 });
    });
  });

  describe('the workspace', () => {
    it('the workspace id goes out as anthropic-workspace-id, on every Anthropic request', async () => {
      const config = { ...anthropic, workspaceId: WORKSPACE };
      await callProvider(config, fake.apiKey, call, http);
      await converse(config, fake.apiKey, start, http);
      await converse(config, fake.apiKey, { ...start, tools: [] }, http);
      expect(fake.requests.map((r) => r.headers['anthropic-workspace-id'])).toEqual([
        WORKSPACE,
        WORKSPACE,
        WORKSPACE,
      ]);
      // The other headers are as they were.
      for (const request of fake.requests) {
        expect(request.headers['x-api-key']).toBe(fake.apiKey);
        expect(request.headers['anthropic-version']).toBe('2023-06-01');
        expect(request.headers['user-agent']).toBe('Qualor/0.0.0');
      }
    });

    it('no header goes out without a workspace id, and the OpenAI adapter never sends one', async () => {
      await callProvider(anthropic, fake.apiKey, call, http);
      await converse(anthropic, fake.apiKey, start, http);
      await callProvider({ ...openai, workspaceId: WORKSPACE }, fake.apiKey, call, http);
      await converse({ ...openai, workspaceId: WORKSPACE }, fake.apiKey, start, http);
      expect(fake.requests).toHaveLength(4);
      for (const request of fake.requests) {
        expect(request.headers).not.toHaveProperty('anthropic-workspace-id');
      }
    });

    describe('a key that is not scoped to a workspace', () => {
      let org: FakeLlm;
      let orgHttp: { internalHosts: ReadonlySet<string>; version: string };
      let orgConfig: ProviderConfig;
      beforeEach(async () => {
        org = await createFakeLlm({ workspaceId: WORKSPACE });
        orgHttp = { internalHosts: parseInternalHosts(org.host), version: '0.0.0' };
        orgConfig = { ...anthropic, baseUrl: org.anthropicBaseUrl };
      });
      afterEach(async () => {
        await org.close();
      });

      it('is named by a fixed hint, for a call and for a conversation, and the provider’s words are never echoed', async () => {
        const single = await callProvider(orgConfig, org.apiKey, call, orgHttp).catch(
          (e: unknown) => e,
        );
        const turn = await converse(orgConfig, org.apiKey, start, orgHttp).catch((e: unknown) => e);
        for (const err of [single, turn]) {
          expect(err).toBeInstanceOf(LlmError);
          expect(err).toMatchObject({
            failure: 'workspace_required',
            status: 400,
            message: NOT_SCOPED,
          });
          expect((err as Error).message).not.toContain('Fake error text');
          expect(JSON.stringify(err)).not.toContain('anthropic-workspace-id');
        }
      });

      it('works once the workspace is named, and a workspace that is not the key’s is a key that may not do this', async () => {
        const named = { ...orgConfig, workspaceId: WORKSPACE };
        expect((await callProvider(named, org.apiKey, call, orgHttp)).finishReason).toBe('stop');
        expect((await converse(named, org.apiKey, start, orgHttp)).finishReason).toBe('stop');
        const other = await callProvider(
          { ...orgConfig, workspaceId: 'wrkspc_Other02' },
          org.apiKey,
          call,
          orgHttp,
        ).catch((e: unknown) => e);
        expect(other).toMatchObject({ failure: 'refused_key', status: 403 });
        expect((other as Error).message).not.toBe(NOT_SCOPED);
      });
    });

    describe('what says a key is not scoped', () => {
      const refusal = (message: string, over: Partial<ProviderConfig> = {}, status = 400) => {
        fake.enqueue({
          status,
          body: { type: 'error', error: { type: 'invalid_request_error', message } },
        });
        return callProvider({ ...anthropic, ...over }, fake.apiKey, call, http).catch(
          (e: unknown) => e,
        );
      };
      const GENERIC = 'The provider refused the request (HTTP 400); check the base URL and model';

      it.each([
        'This API key is not scoped to a workspace.',
        'api key NOT SCOPED TO A WORKSPACE: send one',
        'Specify the workspace with the anthropic-workspace-id header.',
      ])('is read from the words of the error: %s', async (message) => {
        expect(await refusal(message)).toMatchObject({
          failure: 'workspace_required',
          message: NOT_SCOPED,
        });
      });

      it.each([
        'max_tokens: must be at least 1',
        'The workspace is archived.',
        'tools.0.input_schema: JSON schema is invalid',
      ])('does not read any other refusal as one: %s', async (message) => {
        expect(await refusal(message)).toMatchObject({ failure: 'rejected', message: GENERIC });
      });

      it('says it only to a provider that gave no workspace, and only for a 400', async () => {
        const words = 'This API key is not scoped to a workspace.';
        // A workspace was given and the provider still refuses: the settings are not what is missing.
        expect(await refusal(words, { workspaceId: WORKSPACE })).toMatchObject({
          message: GENERIC,
        });
        expect(await refusal(words, {}, 422)).toMatchObject({
          message: 'The provider refused the request (HTTP 422); check the base URL and model',
        });
        // An OpenAI-compatible server has no workspace to name.
        fake.enqueue({ status: 400, body: { error: { message: words } } });
        const err = await callProvider(openai, fake.apiKey, call, http).catch((e: unknown) => e);
        expect(err).toMatchObject({ failure: 'rejected', message: GENERIC });
      });

      it('is no more than a yes or no: nothing of the body is kept', async () => {
        const err = await refusal('This API key is not scoped to a workspace. Key sk-leak-123.');
        expect(err).toMatchObject({ failure: 'workspace_required', message: NOT_SCOPED });
        expect(JSON.stringify(err)).not.toContain('sk-leak-123');
      });
    });
  });

  describe('the thinking of a turn', () => {
    /** The content of three turns: two ask for tools, the last answers. */
    const ONE = [
      anthropicThinking('sig-one'),
      anthropicRedactedThinking('data-one'),
      { type: 'text', text: 'Reading.' },
      toolUseBlock('toolu_1', 'read_file', { path: 'a.ts' }),
    ];
    const TWO = [
      anthropicRedactedThinking('data-two'),
      anthropicThinking('sig-two', 'A summary of it.'),
      toolUseBlock('toolu_2', 'read_file', { path: 'b.ts' }),
      toolUseBlock('toolu_3', 'list_files', { dir: 'src' }),
    ];
    const THREE = [anthropicThinking('sig-three'), { type: 'text', text: '{"findings":[]}' }];

    /** The loop of a review as far as the wire is concerned: each turn is sent back as the model made it. */
    async function converseThrough(contents: unknown[][], config = anthropic) {
      const messages: LlmMessage[] = [{ role: 'user', text: 'Review this change' }];
      const turns = [];
      for (const [i, content] of contents.entries()) {
        fake.enqueue({
          status: 200,
          body: answerOf(content, i < contents.length - 1 ? 'tool_use' : 'end_turn'),
        });
        const turn = await converse(config, fake.apiKey, { ...start, messages }, http);
        turns.push(turn);
        messages.push(
          { role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, replay: turn.replay },
          ...turn.toolCalls.map((c): LlmMessage => ({
            role: 'tool',
            callId: c.id,
            name: c.name,
            text: `result of ${c.id}`,
          })),
        );
      }
      return turns;
    }

    /** The content of the assistant messages of request `n`, as JSON text. */
    const assistantContents = (n: number) =>
      messagesOf(n)
        .filter((m) => m.role === 'assistant')
        .map((m) => JSON.stringify(m.content));

    it('thinking and redacted_thinking blocks come back verbatim, in order, on every later turn', async () => {
      await converseThrough([ONE, TWO, THREE]);
      expect(fake.requests).toHaveLength(3);
      // Byte for byte what the model sent, the blocks of one turn in their order, the turns in theirs.
      expect(assistantContents(0)).toEqual([]);
      expect(assistantContents(1)).toEqual([JSON.stringify(ONE)]);
      expect(assistantContents(2)).toEqual([JSON.stringify(ONE), JSON.stringify(TWO)]);
      // And the results of a turn's calls follow it, in their own user message.
      expect(messagesOf(2).map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      expect(messagesOf(2)[4]!.content).toEqual([
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'result of toolu_2' },
        { type: 'tool_result', tool_use_id: 'toolu_3', content: 'result of toolu_3' },
      ]);
    });

    it('sends the replay as the content of the message, whatever the message’s own text and calls say', async () => {
      const replay = { kind: 'anthropic' as const, items: ONE };
      await converse(
        anthropic,
        fake.apiKey,
        {
          ...start,
          messages: [
            { role: 'user', text: 'Review this change' },
            { role: 'assistant', text: 'Another text', toolCalls: [], replay },
          ],
        },
        http,
      );
      expect(messagesOf(0)[1]).toEqual({ role: 'assistant', content: ONE });
    });

    it('builds the content from the text and the calls when the message has no replay, as before', async () => {
      await converse(
        anthropic,
        fake.apiKey,
        {
          ...start,
          messages: [
            { role: 'user', text: 'Review this change' },
            {
              role: 'assistant',
              text: 'Reading.',
              toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } }],
            },
          ],
        },
        http,
      );
      expect(messagesOf(0)[1]!.content).toEqual([
        { type: 'text', text: 'Reading.' },
        toolUseBlock('toolu_1', 'read_file', { path: 'a.ts' }),
      ]);
    });

    describe('a message without text', () => {
      // The API refuses a text block that is empty or only whitespace, and a message with nothing
      // in it: an assistant message that has no text, no calls and no replay is sent with a fixed
      // placeholder as its text, never empty.
      const NO_TEXT = '(no text)';
      const assistant = (text: string, replay?: ProviderReplay): LlmMessage => ({
        role: 'assistant',
        text,
        toolCalls: [],
        ...(replay === undefined ? {} : { replay }),
      });
      const sentMessage = async (message: LlmMessage) => {
        await converse(
          anthropic,
          fake.apiKey,
          {
            ...start,
            messages: [
              { role: 'user', text: 'Review this change' },
              message,
              { role: 'user', text: 'Answer again' },
            ],
          },
          http,
        );
        return messagesOf(fake.requests.length - 1)[1]!;
      };

      it.each([
        ['no text', ''],
        ['a blank text', '   '],
        ['a text of line breaks', '\n\n'],
      ])(
        'sends the placeholder for an assistant message with %s and no calls',
        async (_what, text) => {
          expect(await sentMessage(assistant(text))).toEqual({
            role: 'assistant',
            content: [{ type: 'text', text: NO_TEXT }],
          });
        },
      );

      it('sends the placeholder also when the replay is of another kind', async () => {
        const other = { kind: 'openai' as const, items: [{ type: 'reasoning', id: 'rs_1' }] };
        expect((await sentMessage(assistant('', other))).content).toEqual([
          { type: 'text', text: NO_TEXT },
        ]);
      });

      it('sends a text there is as it is, and no placeholder beside calls or a replay', async () => {
        expect((await sentMessage(assistant('Enough.'))).content).toEqual([
          { type: 'text', text: 'Enough.' },
        ]);
        // Calls and no text: the calls alone, as before.
        const withCall: LlmMessage = {
          role: 'assistant',
          text: '  ',
          toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } }],
        };
        const callOnly = await converse(
          anthropic,
          fake.apiKey,
          {
            ...start,
            messages: [
              { role: 'user', text: 'Review this change' },
              withCall,
              { role: 'tool', callId: 'toolu_1', name: 'read_file', text: 'A' },
            ],
          },
          http,
        );
        expect(callOnly.finishReason).toBe('stop');
        expect(messagesOf(fake.requests.length - 1)[1]!.content).toEqual([
          toolUseBlock('toolu_1', 'read_file', { path: 'a.ts' }),
        ]);
        // A replay goes as it came, whatever the message's own text says.
        const replay = { kind: 'anthropic' as const, items: [anthropicThinking('sig-kept')] };
        expect((await sentMessage(assistant('', replay))).content).toEqual(replay.items);
      });
    });

    it('ignores a replay of the other kind: the message is built as it would be without one', async () => {
      await converse(
        anthropic,
        fake.apiKey,
        {
          ...start,
          messages: [
            { role: 'user', text: 'Review this change' },
            {
              role: 'assistant',
              text: 'Reading.',
              toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } }],
              replay: { kind: 'openai', items: [{ type: 'reasoning', id: 'rs_1' }] },
            },
          ],
        },
        http,
      );
      expect(messagesOf(0)[1]!.content).toEqual([
        { type: 'text', text: 'Reading.' },
        toolUseBlock('toolu_1', 'read_file', { path: 'a.ts' }),
      ]);
      expect(fake.requests[0]!.body).not.toContain('rs_1');
    });

    it('keeps the content of an answer as it came for the replay, blocks of a kind it does not know included', async () => {
      const odd = [
        anthropicThinking('sig-odd'),
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
        { type: 'text', text: 'Hello', citations: null },
        toolUseBlock('toolu_9', 'read_file', { path: 'z.ts' }),
      ];
      fake.enqueue({ status: 200, body: answerOf(odd) });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      expect(turn.replay).toEqual({ kind: 'anthropic', items: odd });
      expect(JSON.stringify(turn.replay?.items)).toBe(JSON.stringify(odd));
      // What the loop reads of the turn is still the text and the calls.
      expect(turn).toMatchObject({
        text: 'Hello',
        finishReason: 'tool',
        toolCalls: [{ id: 'toolu_9', name: 'read_file', arguments: { path: 'z.ts' } }],
      });
    });

    it('gives a turn without thinking a replay too, and the single-shot call none', async () => {
      fake.enqueue({
        status: 200,
        body: anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: {} }]),
      });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      expect(turn.replay).toEqual({
        kind: 'anthropic',
        items: [toolUseBlock('toolu_1', 'read_file', {})],
      });
      expect(await callProvider(anthropic, fake.apiKey, call, http)).not.toHaveProperty('replay');
    });

    it('is a turn that thinks like any other: the text of its text blocks, the usage of the thinking too', async () => {
      const shape = llmShape<Content & { usage: unknown }>('anthropic-message-thinking');
      fake.enqueue({ status: 200, body: shape });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      expect(turn).toMatchObject({
        text: '{}',
        finishReason: 'stop',
        toolCalls: [],
        usage: { inputTokens: 431, outputTokens: 1102 },
        replay: { kind: 'anthropic', items: shape.content },
      });
    });

    it('a model cut off while it still thinks is a turn of no text that ran out of tokens', async () => {
      fake.enqueue({ status: 200, body: answerOf([anthropicThinking('sig-cut')], 'max_tokens') });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      expect(turn).toMatchObject({ text: '', finishReason: 'length', toolCalls: [] });
    });

    it('is part of the answer: thinking that takes the answer past 1 MiB makes it a bad answer', async () => {
      const heavy = [
        anthropicThinking('s'.repeat(LLM_MAX_ANSWER_BYTES)),
        { type: 'text', text: 'Done.' },
      ];
      fake.enqueue({ status: 200, body: answerOf(heavy, 'end_turn') });
      await expect(converse(anthropic, fake.apiKey, start, http)).rejects.toMatchObject({
        failure: 'bad_answer',
      });
      // Under the cap the same turn is read, with all of its thinking kept.
      const light = [anthropicThinking('s'.repeat(LLM_MAX_ANSWER_BYTES / 2)), heavy[1]];
      fake.enqueue({ status: 200, body: answerOf(light, 'end_turn') });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      expect(turn).toMatchObject({ text: 'Done.', finishReason: 'stop' });
      expect(JSON.stringify(turn.replay?.items)).toBe(JSON.stringify(light));
    });

    it('has no replay for a call whose input nests deeper than JSON can write: nothing is thrown and nothing is sent that cannot be', async () => {
      const depth = 100_000;
      const nested = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
      fake.enqueue({
        status: 200,
        body: `{"id":"msg_1","type":"message","role":"assistant","model":"m","stop_reason":"tool_use","content":[{"type":"thinking","thinking":"","signature":"sig-deep"},{"type":"tool_use","id":"toolu_1","name":"read_file","input":${nested}}],"usage":{"input_tokens":1,"output_tokens":1}}`,
      });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      expect(turn.finishReason).toBe('tool');
      expect(turn.toolCalls).toHaveLength(1);
      expect(turn.replay).toBeUndefined();
    });

    describe('a block that is not a call and nests deeper than JSON can write', () => {
      const DEPTH = 100_000;
      const deep = `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}`;
      /** An answer as the provider's JSON text, from the text of each block of its content. */
      const rawAnswer = (stop: string, ...blocks: string[]): string =>
        `{"id":"msg_1","type":"message","role":"assistant","model":"m","stop_reason":"${stop}","content":[${blocks.join(',')}],"usage":{"input_tokens":1,"output_tokens":1}}`;
      const THINKING = '{"type":"thinking","thinking":"","signature":"sig-deep"}';
      const CALL = '{"type":"tool_use","id":"toolu_1","name":"read_file","input":{"path":"a.ts"}}';
      const BLOCKS: [string, string][] = [
        ['a text block with deep citations', `{"type":"text","text":"Done.","citations":${deep}}`],
        [
          'a block of a kind it does not know',
          `{"type":"server_tool_use","id":"srv_1","name":"web_search","input":${deep}}`,
        ],
        [
          'a thinking block with a deep field of its own',
          `{"type":"thinking","thinking":"","signature":"s","extra":${deep}}`,
        ],
      ];

      it.each(BLOCKS)(
        'ends as the adapter’s own bad answer for %s, whatever turn it comes in, never as a turn no request can carry',
        async (_what, block) => {
          for (const [stop, blocks] of [
            ['tool_use', [THINKING, CALL, block]],
            ['end_turn', [THINKING, block]],
          ] as const) {
            fake.enqueue({ status: 200, body: rawAnswer(stop, ...blocks) });
            // Not the turn itself: what a failing test shows of a turn that deep cannot be sent
            // between the processes of the runner.
            const err = await converse(anthropic, fake.apiKey, start, http).then(
              () => 'a turn',
              (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(LlmError);
            expect(err).toMatchObject({
              failure: 'bad_answer',
              message: "The provider's answer was not understood",
            });
          }
        },
      );

      it('is still read in a single call, which keeps no replay and sends nothing back', async () => {
        fake.enqueue({
          status: 200,
          body: rawAnswer('end_turn', THINKING, `{"type":"text","text":"{}","citations":${deep}}`),
        });
        expect(await callProvider(anthropic, fake.apiKey, call, http)).toMatchObject({
          text: '{}',
          finishReason: 'stop',
        });
      });

      it('keeps the replay of a block nested as deep as JSON still follows, as it came', async () => {
        const nested = `${'{"a":'.repeat(500)}1${'}'.repeat(500)}`;
        const text = rawAnswer(
          'end_turn',
          THINKING,
          `{"type":"text","text":"Done.","citations":${nested}}`,
        );
        fake.enqueue({ status: 200, body: text });
        const turn = await converse(anthropic, fake.apiKey, start, http);
        expect(turn.text).toBe('Done.');
        expect(JSON.stringify(turn.replay?.items)).toBe(
          JSON.stringify((JSON.parse(text) as Content).content),
        );
      });

      it('does not lean on how deep a copy can follow: what JSON cannot write is a bad answer however the copy is made', async () => {
        // A copy that follows any depth, as another runtime's may.
        vi.stubGlobal('structuredClone', <T>(value: T): T => value);
        try {
          const [, block] = BLOCKS[0]!;
          fake.enqueue({ status: 200, body: rawAnswer('end_turn', THINKING, block) });
          const err = await converse(anthropic, fake.apiKey, start, http).then(
            () => 'a turn',
            (e: unknown) => e,
          );
          expect(err).toMatchObject({ failure: 'bad_answer' });
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });

    it('keeps a copy of the content as the replay: nothing done to the calls of the turn changes it', async () => {
      const input = { path: 'a.ts', nested: { keep: true } };
      fake.enqueue({
        status: 200,
        body: answerOf([
          anthropicThinking('sig-copy'),
          toolUseBlock('toolu_1', 'read_file', input),
        ]),
      });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      const before = JSON.stringify(turn.replay?.items);
      expect(before).toContain('"keep":true');
      const sent = turn.toolCalls[0]!.arguments as typeof input;
      sent.path = 'changed.ts';
      sent.nested.keep = false;
      expect(JSON.stringify(turn.replay?.items)).toBe(before);
      // And the copy is of the whole content, thinking and all, in its order.
      expect(turn.replay?.items).toEqual([
        anthropicThinking('sig-copy'),
        toolUseBlock('toolu_1', 'read_file', { path: 'a.ts', nested: { keep: true } }),
      ]);
    });
  });

  describe('a refusal', () => {
    it('a refusal is a refusal, and its content is not read', async () => {
      // A refusal comes as a 200 with its stop reason; what it holds may be an apology, half of an
      // answer, or a call that cannot be read: none of it is the turn's.
      const refused = {
        ...(anthropicAnswer('') as object),
        stop_reason: 'refusal',
        content: [
          anthropicThinking('sig-refused'),
          { type: 'text', text: '{"findings":[{"title":"Half of an ans' },
          { type: 'tool_use', name: 'read_file', input: {} },
        ],
      };
      fake.enqueue({ status: 200, body: refused }, { status: 200, body: refused });
      const turn = await converse(anthropic, fake.apiKey, start, http);
      expect(turn).toEqual({
        text: '',
        finishReason: 'refusal',
        toolCalls: [],
        usage: { inputTokens: 431, outputTokens: 102 },
        model: 'fake-anthropic-model',
      });
      expect(turn.replay).toBeUndefined();
      const single = await callProvider(anthropic, fake.apiKey, call, http);
      expect(single).toEqual({
        text: '',
        finishReason: 'refusal',
        usage: { inputTokens: 431, outputTokens: 102 },
        model: 'fake-anthropic-model',
      });
    });

    it('is a refusal with nothing in its content too', async () => {
      fake.enqueue({ status: 200, body: answerOf([], 'refusal') });
      expect(await converse(anthropic, fake.apiKey, start, http)).toMatchObject({
        text: '',
        finishReason: 'refusal',
        toolCalls: [],
      });
    });
  });

  describe('the tool choice', () => {
    it('no tool_choice other than auto', async () => {
      const replayed: LlmMessage[] = [
        { role: 'user', text: 'Review this change' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: {} }],
          replay: { kind: 'anthropic', items: [toolUseBlock('toolu_1', 'read_file', {})] },
        },
        { role: 'tool', callId: 'toolu_1', name: 'read_file', text: 'A' },
        { role: 'user', text: 'Token budget reached: answer now.' },
      ];
      const conversations: LlmConversation[] = [
        start,
        { ...start, messages: replayed },
        { ...start, tools: [], messages: replayed.slice(0, 1) },
        { ...start, tools: [readFile] },
      ];
      for (const conversation of conversations) {
        await converse({ ...anthropic, temperature: 0.7 }, fake.apiKey, conversation, http);
      }
      await callProvider(anthropic, fake.apiKey, call, http);
      expect(fake.requests).toHaveLength(5);
      for (const [n, sent] of fake.requests.entries()) {
        const json = sent.json as { tools?: unknown[]; tool_choice?: unknown };
        const tools = json.tools ?? [];
        // With tools the choice is auto, which may not be forced; without them there is none.
        expect(json.tool_choice, `request ${n}`).toEqual(
          tools.length > 0 ? { type: 'auto' } : undefined,
        );
        expect(JSON.stringify(json.tool_choice ?? null)).not.toMatch(/"any"|"tool"|"none"/);
      }
      expect(body(4)).not.toHaveProperty('tools');
      expect(body(4)).not.toHaveProperty('tool_choice');
    });
  });
});
