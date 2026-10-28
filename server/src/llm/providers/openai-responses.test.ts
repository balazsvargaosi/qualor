import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeLlm,
  llmShape,
  openAiAnswer,
  responsesAnswer,
  responsesReasoning,
  responsesToolCalls,
  type FakeLlm,
  type RecordedLlmRequest,
} from '../../../test/fake-llm';
import { parseInternalHosts } from '../../scm/url';
import {
  callProvider,
  converse,
  LLM_MAX_ANSWER_BYTES,
  LlmCallAborted,
  LlmError,
  MAX_TOKEN_COUNT,
  RESPONSES_REQUIRED_TEXT,
  type LlmConversation,
  type LlmMessage,
  type LlmToolCall,
  type ProviderConfig,
} from './index';

/*
 * The second wire of the OpenAI provider: the Responses API (`POST <baseUrl>/responses`). The newest
 * OpenAI models take function tools together with reasoning only through it. It is stateless
 * (`store: false`, the reasoning comes back encrypted and goes back as it came), and its answer is a
 * list of items, not a choice.
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
const userItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const GENERIC = 'The provider refused the request (HTTP 400); check the base URL and model';

/** The output of a Responses answer, as the fake wrote it. */
const outputOf = (body: unknown): Record<string, unknown>[] =>
  (body as { output: Record<string, unknown>[] }).output;

describe('the OpenAI Responses API wire', () => {
  let fake: FakeLlm;
  let http: { internalHosts: ReadonlySet<string>; version: string };
  let chat: ProviderConfig;
  let responses: ProviderConfig;
  // One fake per test: a reply a failing test left in the queue never reaches the next test. As the
  // real API does, it refuses a request with an input_text assistant message, an output for a call
  // that was not made, and a limit below 16.
  beforeEach(async () => {
    fake = await createFakeLlm();
    http = { internalHosts: parseInternalHosts(fake.host), version: '0.0.0' };
    chat = {
      kind: 'openai',
      api: 'chat_completions',
      baseUrl: fake.openAiBaseUrl,
      model: 'm-1',
      auth: 'bearer',
      jsonMode: 'json_object',
      maxTokensField: 'max_tokens',
      temperature: null,
      workspaceId: null,
      timeoutSeconds: 5,
    };
    responses = { ...chat, api: 'responses' };
  });
  afterEach(async () => {
    await fake.close();
  });

  const body = (n = 0): Record<string, unknown> =>
    fake.requests[n]!.json as Record<string, unknown>;
  const inputOf = (n = 0): Record<string, unknown>[] => body(n).input as Record<string, unknown>[];

  describe('the request', () => {
    it('a one-shot call (explain, triage, fix and the Test) sends the instructions and one user item', async () => {
      fake.say('{"a":1}');
      // As the real callers' users do, the message says JSON: nothing is added to it.
      const asked = { ...call, user: 'Answer in JSON.' };
      const answer = await callProvider(responses, fake.apiKey, asked, http);
      expect(answer).toEqual({
        text: '{"a":1}',
        finishReason: 'stop',
        usage: { inputTokens: 412, outputTokens: 96, cacheReadTokens: 0 },
        model: 'fake-openai-model',
      });
      const sent = fake.requests[0]!;
      expect(sent.method).toBe('POST');
      expect(sent.path).toBe('/v1/responses');
      expect(sent.json).toEqual({
        model: 'm-1',
        instructions: 'S',
        input: [userItem('Answer in JSON.')],
        max_output_tokens: 50,
        store: false,
        include: ['reasoning.encrypted_content'],
        text: { format: { type: 'json_object' } },
      });
      expect(sent.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
      expect(sent.headers['user-agent']).toBe('Qualor/0.0.0');
      // A single call keeps no replay: nothing of it is sent again.
      expect(answer).not.toHaveProperty('replay');
    });

    it('store is false and reasoning.encrypted_content is asked for', async () => {
      // Nothing stays at OpenAI beyond its abuse monitoring, and the reasoning comes back to Qualor
      // encrypted: in every request, whatever the call, the tools or the settings.
      await callProvider(responses, fake.apiKey, call, http);
      await callProvider(
        { ...responses, jsonMode: 'none', temperature: 0.3 },
        fake.apiKey,
        call,
        http,
      );
      await converse(responses, fake.apiKey, start, http);
      await converse(responses, fake.apiKey, { ...start, tools: [] }, http);
      await converse(
        responses,
        fake.apiKey,
        { ...start, maxOutputTokens: 1_200, reasoningAllowance: 16_000 },
        http,
      );
      expect(fake.requests).toHaveLength(5);
      for (const [n, request] of fake.requests.entries()) {
        expect(request.path, `request ${n}`).toBe('/v1/responses');
        expect(body(n).store, `request ${n}`).toBe(false);
        expect(body(n).include, `request ${n}`).toEqual(['reasoning.encrypted_content']);
        // Nothing of an earlier response is referred to: the whole conversation is sent each time.
        expect(body(n), `request ${n}`).not.toHaveProperty('previous_response_id');
        expect(body(n), `request ${n}`).not.toHaveProperty('conversation');
      }
    });

    it('JSON mode is text.format json_object without tools', async () => {
      const json = { text: { format: { type: 'json_object' } } };
      await converse(responses, fake.apiKey, { ...start, tools: [] }, http);
      await converse(responses, fake.apiKey, start, http);
      await converse(
        { ...responses, jsonMode: 'none' },
        fake.apiKey,
        { ...start, tools: [] },
        http,
      );
      await callProvider(responses, fake.apiKey, call, http);
      await callProvider({ ...responses, jsonMode: 'none' }, fake.apiKey, call, http);
      expect(body(0)).toMatchObject(json);
      // While tools are sent the caller asks for its JSON in the prompt, as on Chat Completions.
      expect(body(1)).not.toHaveProperty('text');
      expect(body(2)).not.toHaveProperty('text');
      expect(body(3)).toMatchObject(json);
      expect(body(4)).not.toHaveProperty('text');
      // Never the `response_format` of Chat Completions.
      for (const [n] of fake.requests.entries()) {
        expect(body(n), `request ${n}`).not.toHaveProperty('response_format');
      }
    });

    describe('JSON mode names JSON in the input', () => {
      // The API refuses JSON mode when no input message says the word json: its instructions do not
      // count. The fake refuses it as the API does, in the API's words.
      const REMINDER = { type: 'input_text', text: 'Reply in JSON.' };
      const noTools: LlmConversation = { ...start, tools: [] };
      const withReminder = (text: string) => ({
        role: 'user',
        content: [{ type: 'input_text', text }, REMINDER],
      });

      it('a one-shot call whose user message does not say JSON gets one fixed part in it, and is taken', async () => {
        fake.say('{"a":1}');
        const answer = await callProvider(responses, fake.apiKey, call, http);
        expect(answer.finishReason).toBe('stop');
        expect(inputOf()).toEqual([withReminder('U')]);
        expect(body()).toMatchObject({ text: { format: { type: 'json_object' } } });
      });

      it('a conversation without tools whose first message does not say it gets it too, and is taken', async () => {
        fake.say('{"findings":[]}');
        const turn = await converse(responses, fake.apiKey, noTools, http);
        expect(turn).toMatchObject({ text: '{"findings":[]}', finishReason: 'stop' });
        expect(inputOf()).toEqual([withReminder('Review this change')]);
      });

      it.each([
        'Answer in JSON.',
        'answer in json',
        'Reply in Json',
        'the diff of package.json',
        'JSON',
      ])('leaves a first message that says json as it is (%s)', async (text) => {
        await callProvider(responses, fake.apiKey, { ...call, user: text }, http);
        await converse(
          responses,
          fake.apiKey,
          { ...noTools, messages: [{ role: 'user', text }] },
          http,
        );
        for (const n of [0, 1]) expect(inputOf(n), `request ${n}`).toEqual([userItem(text)]);
      });

      it('says it once, in the first user message, and every request of a conversation carries that message as it was whatever a later one says', async () => {
        // A conversation without tools that is asked again: the loop's own words for that say JSON.
        const first: LlmMessage = { role: 'user', text: 'Review this change' };
        const history: LlmMessage[] = [
          first,
          { role: 'assistant', text: 'Not what you asked.', toolCalls: [] },
          {
            role: 'user',
            text: 'Your answer did not match the required JSON; answer again with JSON only.',
          },
          { role: 'assistant', text: 'Still not.', toolCalls: [] },
          { role: 'user', text: 'Answer now, in the required JSON.' },
        ];
        for (const upTo of [1, 3, 5]) {
          await converse(
            responses,
            fake.apiKey,
            { ...noTools, messages: history.slice(0, upTo) },
            http,
          );
        }
        expect(fake.requests).toHaveLength(3);
        for (const n of [0, 1, 2]) {
          // The same first message, byte for byte, and the part nowhere else.
          expect(JSON.stringify(inputOf(n)[0]), `request ${n}`).toBe(
            JSON.stringify(withReminder('Review this change')),
          );
          expect(fake.requests[n]!.body.split('Reply in JSON.'), `request ${n}`).toHaveLength(2);
        }
        // So each request begins with all the earlier one held.
        for (const n of [1, 2]) {
          const before = inputOf(n - 1).map((item) => JSON.stringify(item));
          expect(
            inputOf(n)
              .map((item) => JSON.stringify(item))
              .slice(0, before.length),
          ).toEqual(before);
        }
      });

      it('adds it to the first user message only: a later one that does not say json goes as it is', async () => {
        await converse(
          responses,
          fake.apiKey,
          {
            ...noTools,
            messages: [
              { role: 'user', text: 'Review this change' },
              { role: 'assistant', text: 'Reviewed.', toolCalls: [] },
              { role: 'user', text: 'Go on' },
            ],
          },
          http,
        );
        expect(inputOf()).toEqual([
          withReminder('Review this change'),
          { role: 'assistant', content: [{ type: 'output_text', text: 'Reviewed.' }] },
          userItem('Go on'),
        ]);
      });

      it('names JSON only while JSON mode is asked for: not with tools, and not with the mode off', async () => {
        await converse(responses, fake.apiKey, start, http);
        await converse({ ...responses, jsonMode: 'none' }, fake.apiKey, noTools, http);
        await callProvider({ ...responses, jsonMode: 'none' }, fake.apiKey, call, http);
        expect(fake.requests).toHaveLength(3);
        for (const n of [0, 1, 2]) {
          expect(fake.requests[n]!.body, `request ${n}`).not.toContain('Reply in JSON.');
          expect(body(n), `request ${n}`).not.toHaveProperty('text');
        }
      });

      it('adds it in both asks of a call that is asked again without the room, and changes nothing else', async () => {
        const capped = await createFakeLlm({ outputCaps: { 'capped-for-json': 4_096 } });
        try {
          const config = { ...responses, model: 'capped-for-json', baseUrl: capped.openAiBaseUrl };
          const cappedHttp = { ...http, internalHosts: parseInternalHosts(capped.host) };
          await callProvider(
            config,
            capped.apiKey,
            { ...call, maxOutputTokens: 1_200, reasoningAllowance: 4_000 },
            cappedHttp,
          );
          const [first, second] = capped.requests.map((r) => r.json as Record<string, unknown>);
          expect(capped.requests).toHaveLength(2);
          expect([first!.max_output_tokens, second!.max_output_tokens]).toEqual([5_200, 1_200]);
          expect(first!.input).toEqual([withReminder('U')]);
          expect(second!.input).toEqual(first!.input);
        } finally {
          await capped.close();
        }
      });
    });

    it('sends a conversation as items, oldest first, with the tools flattened and not strict', async () => {
      await converse(
        responses,
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
      expect(fake.requests[0]!.json).toEqual({
        model: 'm-1',
        instructions: 'S',
        input: [
          userItem('Review this change'),
          { role: 'assistant', content: [{ type: 'output_text', text: 'Reading two things.' }] },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"src/a.ts"}',
          },
          {
            type: 'function_call',
            call_id: 'call_2',
            name: 'list_files',
            arguments: '{"dir":"src"}',
          },
          { type: 'function_call_output', call_id: 'call_1', output: 'one' },
          { type: 'function_call_output', call_id: 'call_2', output: 'two' },
          { role: 'assistant', content: [{ type: 'output_text', text: 'Both look fine.' }] },
          userItem('Go on'),
        ],
        // A function tool of this API is flat, and strict by default: Qualor's own schemas are not.
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: readFile.description,
            parameters: readFile.parameters,
            strict: false,
          },
          {
            type: 'function',
            name: 'list_files',
            description: listFiles.description,
            parameters: listFiles.parameters,
            strict: false,
          },
        ],
        tool_choice: 'auto',
        max_output_tokens: 50,
        store: false,
        include: ['reasoning.encrypted_content'],
      });
    });

    it('sends no tools and no tool_choice without tools, and only tool_choice auto with them', async () => {
      await converse(responses, fake.apiKey, { ...start, tools: [] }, http);
      await callProvider(responses, fake.apiKey, call, http);
      await converse(responses, fake.apiKey, start, http);
      for (const n of [0, 1]) {
        expect(body(n), `request ${n}`).not.toHaveProperty('tools');
        expect(body(n), `request ${n}`).not.toHaveProperty('tool_choice');
      }
      expect(body(2).tool_choice).toBe('auto');
      expect(fake.requests[0]!.body).not.toContain('"tool');
    });

    it('sends a temperature only when one is set, and the limit in max_output_tokens whatever the settings say', async () => {
      const config = {
        ...responses,
        temperature: 0,
        maxTokensField: 'max_completion_tokens',
      } as const;
      await callProvider(config, fake.apiKey, call, http);
      await converse(config, fake.apiKey, start, http);
      await callProvider(responses, fake.apiKey, call, http);
      for (const n of [0, 1]) {
        expect(body(n), `request ${n}`).toMatchObject({ temperature: 0, max_output_tokens: 50 });
      }
      expect(body(2)).not.toHaveProperty('temperature');
      for (const [n] of fake.requests.entries()) {
        for (const field of ['max_tokens', 'max_completion_tokens']) {
          expect(body(n), `request ${n}`).not.toHaveProperty(field);
        }
      }
    });

    it('sends an assistant turn without a replay as its text, when it has some, and its calls: never a block with no text', async () => {
      const calls = [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }];
      const turn = (text: string, toolCalls: readonly LlmToolCall[] = calls): LlmMessage => ({
        role: 'assistant',
        text,
        toolCalls,
      });
      const sentFor = async (message: LlmMessage): Promise<Record<string, unknown>[]> => {
        await converse(
          responses,
          fake.apiKey,
          {
            ...start,
            messages: [
              { role: 'user', text: 'Review this change' },
              message,
              ...(message.role === 'assistant' && message.toolCalls.length > 0
                ? [{ role: 'tool', callId: 'call_1', name: 'read_file', text: 'A' } as const]
                : []),
            ],
          },
          http,
        );
        return inputOf(fake.requests.length - 1).slice(1);
      };
      const functionCall = {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.ts"}',
      };
      const output = { type: 'function_call_output', call_id: 'call_1', output: 'A' };
      // No text: the calls alone. The API refuses a message of text that is empty, so none is sent.
      expect(await sentFor(turn(''))).toEqual([functionCall, output]);
      expect(await sentFor(turn('   \n'))).toEqual([functionCall, output]);
      expect(await sentFor(turn('Reading.'))).toEqual([
        { role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
        functionCall,
        output,
      ]);
      // A turn with neither says nothing at all.
      expect(await sentFor(turn('', []))).toEqual([]);
      // A call that had no arguments is sent with an empty object.
      expect(
        await sentFor(turn('', [{ id: 'call_1', name: 'read_file', arguments: undefined }])),
      ).toEqual([{ ...functionCall, arguments: '{}' }, output]);
    });

    it('ignores a replay of the other kind: the turn is built as it would be without one', async () => {
      await converse(
        responses,
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
      expect(inputOf().slice(1, 3)).toEqual([
        { role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
        },
      ]);
      expect(fake.requests[0]!.body).not.toContain('SIGNATURE');
    });

    describe('the key', () => {
      it('is sent as Authorization: Bearer, or as api-key for Azure, as on Chat Completions', async () => {
        await callProvider(responses, fake.apiKey, call, http);
        await converse({ ...responses, auth: 'api-key' }, fake.apiKey, start, http);
        const [bearer, azure] = fake.requests;
        expect(bearer!.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
        expect(bearer!.headers['api-key']).toBeUndefined();
        expect(azure!.headers['api-key']).toBe(fake.apiKey);
        expect(azure!.headers.authorization).toBeUndefined();
        // The same two as the chat completions wire sends.
        await callProvider({ ...chat, auth: 'api-key' }, fake.apiKey, call, http);
        expect(fake.requests[2]!.headers['api-key']).toBe(fake.apiKey);
      });

      it('is sent in no header without a key', async () => {
        const open = await createFakeLlm({ apiKey: null });
        try {
          const config = { ...responses, baseUrl: open.openAiBaseUrl };
          const openHttp = { ...http, internalHosts: parseInternalHosts(open.host) };
          // The fake refuses a key header it does not expect.
          expect((await converse(config, null, start, openHttp)).finishReason).toBe('stop');
          expect(
            (await callProvider({ ...config, auth: 'api-key' }, null, call, openHttp)).finishReason,
          ).toBe('stop');
          expect(open.requests).toHaveLength(2);
        } finally {
          await open.close();
        }
      });
    });
  });

  describe('the answer', () => {
    it('reads text, usage and model, and the calls as the arguments they are', async () => {
      fake.enqueue({
        status: 200,
        body: responsesToolCalls(
          [
            { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts', from: 3 } },
            { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
            { id: 'call_3', name: 'list_files', arguments: { dir: 'tests' } },
          ],
          { text: 'Let me look.', usage: { input_tokens: 7, output_tokens: 3 }, model: 'm-x' },
        ),
      });
      const turn = await converse(responses, fake.apiKey, start, http);
      expect(turn).toMatchObject({
        text: 'Let me look.',
        finishReason: 'tool',
        // Arguments that are not JSON stay the model's own text, as on Chat Completions.
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts', from: 3 } },
          { id: 'call_2', name: 'list_files', arguments: '{"dir": "src"' },
          { id: 'call_3', name: 'list_files', arguments: { dir: 'tests' } },
        ],
        usage: { inputTokens: 7, outputTokens: 3 },
        model: 'm-x',
      });
    });

    it('reads a call whose arguments are missing as one with none (an empty object)', async () => {
      const answer = responsesToolCalls([{ id: 'call_1', name: 'list_files', arguments: {} }]);
      delete outputOf(answer)[0]!.arguments;
      fake.enqueue({ status: 200, body: answer });
      expect((await converse(responses, fake.apiKey, start, http)).toolCalls).toEqual([
        { id: 'call_1', name: 'list_files', arguments: {} },
      ]);
    });

    it('joins the text of every output_text part of every message, and ignores the items that are not messages or calls', async () => {
      const answer = responsesAnswer('x');
      const [message] = outputOf(answer);
      (answer as { output: unknown[] }).output = [
        responsesReasoning('enc-1'),
        {
          ...message,
          content: [
            { type: 'output_text', text: '{"a"', annotations: [] },
            { type: 'output_text', text: ':1}', annotations: [] },
          ],
        },
        { id: 'ws_1', type: 'web_search_call', status: 'completed' },
        { ...message, content: [{ type: 'output_text', text: ' done', annotations: [] }] },
      ];
      fake.enqueue({ status: 200, body: answer });
      expect(await converse(responses, fake.apiKey, start, http)).toMatchObject({
        text: '{"a":1} done',
        finishReason: 'stop',
        toolCalls: [],
      });
    });

    it('is a tool turn whatever the status is, once there are calls', async () => {
      const done = responsesToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]);
      const cut = responsesToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]);
      Object.assign(cut as object, {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      });
      fake.enqueue({ status: 200, body: done }, { status: 200, body: cut });
      expect((await converse(responses, fake.apiKey, start, http)).finishReason).toBe('tool');
      expect((await converse(responses, fake.apiKey, start, http)).finishReason).toBe('tool');
    });

    it('an incomplete answer at max_output_tokens is length', async () => {
      fake.enqueue(
        {
          status: 200,
          body: responsesAnswer('{"findings":[{"ti', { incomplete: 'max_output_tokens' }),
        },
        {
          status: 200,
          body: responsesAnswer('', {
            incomplete: 'max_output_tokens',
            reasoning: [responsesReasoning('enc-cut')],
          }),
        },
      );
      // Cut off while it wrote: its words, and the usage it spent.
      expect(await converse(responses, fake.apiKey, start, http)).toMatchObject({
        text: '{"findings":[{"ti',
        finishReason: 'length',
        toolCalls: [],
        usage: { inputTokens: 412, outputTokens: 96 },
      });
      // Cut off while it still thought: no text, and still a turn that ran out of tokens.
      expect(await converse(responses, fake.apiKey, start, http)).toMatchObject({
        text: '',
        finishReason: 'length',
        toolCalls: [],
      });
      fake.enqueue({
        status: 200,
        body: responsesAnswer('Half', { incomplete: 'max_output_tokens' }),
      });
      expect((await callProvider(responses, fake.apiKey, call, http)).finishReason).toBe('length');
    });

    it.each(['content_filter', 'max_messages', 'steered', 'something_new'])(
      'an incomplete answer for another reason (%s) is other',
      async (reason) => {
        fake.enqueue({
          status: 200,
          body: responsesAnswer('Some words', { incomplete: reason }),
        });
        expect(await converse(responses, fake.apiKey, start, http)).toMatchObject({
          text: 'Some words',
          finishReason: 'other',
          toolCalls: [],
        });
        fake.enqueue({
          status: 200,
          body: responsesAnswer('Some words', { incomplete: reason }),
        });
        expect((await callProvider(responses, fake.apiKey, call, http)).finishReason).toBe('other');
      },
    );

    it('is other for a status it does not know, or none, and the text is still the answer', async () => {
      const unknown = responsesAnswer('Words', { status: 'cancelled' });
      const none = responsesAnswer('Words') as Record<string, unknown>;
      delete none.status;
      fake.enqueue({ status: 200, body: unknown }, { status: 200, body: none });
      for (let i = 0; i < 2; i += 1) {
        expect(await converse(responses, fake.apiKey, start, http)).toMatchObject({
          text: 'Words',
          finishReason: 'other',
        });
      }
    });

    it('reads a refusal part as a refusal, with no text and no replay', async () => {
      fake.enqueue({
        status: 200,
        body: responsesAnswer('', {
          refusal: 'I cannot help with that.',
          reasoning: [responsesReasoning('enc-refused')],
        }),
      });
      const turn = await converse(responses, fake.apiKey, start, http);
      expect(turn).toEqual({
        text: '',
        finishReason: 'refusal',
        toolCalls: [],
        usage: { inputTokens: 412, outputTokens: 96, cacheReadTokens: 0 },
        model: 'fake-openai-model',
      });
      fake.enqueue({ status: 200, body: responsesAnswer('', { refusal: 'No.' }) });
      expect((await callProvider(responses, fake.apiKey, call, http)).finishReason).toBe('refusal');
    });

    describe.each([
      [
        'a failed answer',
        () =>
          responsesAnswer('', {
            status: 'failed',
            error: { code: 'server_error', message: 'Fake error text; never logged or shown.' },
          }),
      ],
      [
        'an error object beside a completed status',
        () =>
          responsesAnswer('Some words', {
            error: {
              code: 'rate_limit_exceeded',
              message: 'Fake error text; never logged or shown.',
            },
          }),
      ],
      ['a failed answer with no error object', () => responsesAnswer('', { status: 'failed' })],
    ])('%s', (_name, answer) => {
      it('is the provider’s error, with a fixed text and none of its words', async () => {
        fake.enqueue({ status: 200, body: answer() }, { status: 200, body: answer() });
        for (const run of [
          () => converse(responses, fake.apiKey, start, http),
          () => callProvider(responses, fake.apiKey, call, http),
        ]) {
          const err = await run().catch((e: unknown) => e);
          expect(err).toBeInstanceOf(LlmError);
          expect(err).toMatchObject({
            failure: 'unavailable',
            status: null,
            message: 'The model provider could not complete the answer',
          });
          expect((err as Error).message).not.toContain('Fake error text');
        }
      });
    });

    it('is not understood without an output list, or with one that holds no message, call or refusal', async () => {
      const noOutput = responsesAnswer('x') as Record<string, unknown>;
      delete noOutput.output;
      const notAList = { ...(responsesAnswer('x') as object), output: 'text' };
      const empty = responsesAnswer('');
      const onlyThinking = responsesAnswer('', { reasoning: [responsesReasoning('enc-1')] });
      const blankMessage = responsesAnswer('x');
      outputOf(blankMessage)[0]!.content = [];
      for (const answer of [
        noOutput,
        notAList,
        empty,
        onlyThinking,
        blankMessage,
        'not json at all',
      ]) {
        fake.enqueue({ status: 200, body: answer });
        const err = await converse(responses, fake.apiKey, start, http).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LlmError);
        expect(err).toMatchObject({
          failure: 'bad_answer',
          message: "The provider's answer was not understood",
        });
      }
      // An item that is not even an object with a type is not understood either.
      fake.enqueue({ status: 200, body: { ...(responsesAnswer('x') as object), output: [7] } });
      await expect(converse(responses, fake.apiKey, start, http)).rejects.toMatchObject({
        failure: 'bad_answer',
      });
    });

    describe('a call without an id or a name', () => {
      const broken: [string, (call: Record<string, unknown>) => void][] = [
        ['no call_id', (item) => void delete item.call_id],
        [
          'an empty call_id',
          (item) => {
            item.call_id = '';
          },
        ],
        [
          'a call_id that is not a string',
          (item) => {
            item.call_id = 7;
          },
        ],
        ['no name', (item) => void delete item.name],
        [
          'an empty name',
          (item) => {
            item.name = '';
          },
        ],
        [
          'a name that is not a string',
          (item) => {
            item.name = ['read_file'];
          },
        ],
      ];
      it.each(broken)('is a bad_answer in a conversation: %s', async (_name, change) => {
        const answer = responsesToolCalls([
          { id: 'call_1', name: 'read_file', arguments: {} },
          { id: 'call_2', name: 'read_file', arguments: {} },
        ]);
        change(outputOf(answer)[1]!);
        fake.enqueue({ status: 200, body: answer });
        const err = await converse(responses, fake.apiKey, start, http).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LlmError);
        expect(err).toMatchObject({
          failure: 'bad_answer',
          message: "The provider's answer was not understood",
        });
      });

      it('still reads as a tool turn in a single call, as Chat Completions does', async () => {
        const answer = responsesToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]);
        delete outputOf(answer)[0]!.call_id;
        fake.enqueue({ status: 200, body: answer });
        expect((await callProvider(responses, fake.apiKey, call, http)).finishReason).toBe('tool');
      });
    });

    describe('usage tokens are read as Chat Completions reads them', () => {
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
      ])('%s', async (_name, first, second, expected) => {
        const answer = {
          ...(responsesAnswer('{}') as object),
          usage: { input_tokens: first, output_tokens: second },
        };
        fake.enqueue({ status: 200, body: answer }, { status: 200, body: answer });
        expect((await converse(responses, fake.apiKey, start, http)).usage).toEqual(expected);
        expect((await callProvider(responses, fake.apiKey, call, http)).usage).toEqual(expected);
      });

      it('reads cached_tokens on Chat Completions and on the Responses API, and inputTokens stays the whole prompt (the Responses API here)', async () => {
        const usage = {
          input_tokens: 10_000,
          input_tokens_details: { cached_tokens: 8_000 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 10_050,
        };
        const answer = { ...(responsesAnswer('{}') as object), usage };
        const expected = { inputTokens: 10_000, outputTokens: 50, cacheReadTokens: 8_000 };
        fake.enqueue(
          { status: 200, body: answer },
          { status: 200, body: answer },
          { status: 200, body: answer },
        );
        expect((await converse(responses, fake.apiKey, start, http)).usage).toEqual(expected);
        const stream = {
          firstByteMs: 5_000,
          idleMs: 5_000,
          totalMs: 60_000,
          maxStreamBytes: 16 * 1024 * 1024,
        };
        expect((await converse(responses, fake.apiKey, start, { ...http, stream })).usage).toEqual(
          expected,
        );
        expect((await callProvider(responses, fake.apiKey, call, http)).usage).toEqual(expected);
        // A cached count it did not give is left out.
        fake.enqueue({
          status: 200,
          body: { ...answer, usage: { ...usage, input_tokens_details: null } },
        });
        expect((await converse(responses, fake.apiKey, start, http)).usage).toEqual({
          inputTokens: 10_000,
          outputTokens: 50,
        });
      });

      it('reads a missing usage, and one that is not an object, as unknown', async () => {
        const unknown = { inputTokens: null, outputTokens: null };
        fake.enqueue(
          { status: 200, body: responsesAnswer('{}', { usage: null }) },
          { status: 200, body: { ...(responsesAnswer('{}') as object), usage: 'lots' } },
        );
        expect((await converse(responses, fake.apiKey, start, http)).usage).toEqual(unknown);
        expect((await converse(responses, fake.apiKey, start, http)).usage).toEqual(unknown);
      });

      it('reads a missing model as unknown, and keeps the model the answer names', async () => {
        const noModel = responsesAnswer('{}') as Record<string, unknown>;
        delete noModel.model;
        fake.enqueue({ status: 200, body: noModel });
        expect((await converse(responses, fake.apiKey, start, http)).model).toBeNull();
      });
    });
  });

  describe('the replay', () => {
    const calls = [
      { id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: 'call_2', name: 'list_files', arguments: { dir: 'src' } },
    ];

    it('reasoning items come back verbatim with their function calls on the next turn', async () => {
      const answer = responsesToolCalls(calls, {
        text: 'Let me look.',
        reasoning: [responsesReasoning('enc-A'), responsesReasoning('enc-B', 'rs_second')],
      });
      fake.enqueue({ status: 200, body: answer });
      const turn = await converse(responses, fake.apiKey, start, http);
      // The turn keeps the output items exactly as they came: reasoning, message and calls.
      expect(turn.replay).toEqual({ kind: 'openai', items: outputOf(answer) });
      expect(outputOf(answer).map((item) => item.type)).toEqual([
        'reasoning',
        'reasoning',
        'message',
        'function_call',
        'function_call',
      ]);

      fake.say('{"findings":[]}');
      await converse(
        responses,
        fake.apiKey,
        {
          ...start,
          messages: [
            { role: 'user', text: 'Review this change' },
            { role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, replay: turn.replay! },
            { role: 'tool', callId: 'call_1', name: 'read_file', text: 'const a = 1;' },
            { role: 'tool', callId: 'call_2', name: 'list_files', text: 'a.ts\nb.ts' },
          ],
        },
        http,
      );
      // In order, before the results of its calls; the results answer each call by its id.
      expect(inputOf(1)).toEqual([
        userItem('Review this change'),
        ...outputOf(answer),
        { type: 'function_call_output', call_id: 'call_1', output: 'const a = 1;' },
        { type: 'function_call_output', call_id: 'call_2', output: 'a.ts\nb.ts' },
      ]);
      // Byte for byte: the same keys in the same order, the encrypted content among them.
      const replayed = inputOf(1).slice(1, 1 + outputOf(answer).length);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(outputOf(answer)));
      expect(fake.requests[1]!.body).toContain('enc-A');
      expect(fake.requests[1]!.body).toContain('rs_second');
      // And what the replay held is the whole of it: the text and the calls are not sent twice.
      expect(fake.requests[1]!.body.match(/"call_id":"call_1"/g)).toHaveLength(2);
      expect(fake.requests[1]!.body.match(/Let me look\./g)).toHaveLength(1);
    });

    it('is sent as it came whatever the text and the calls of the message say', async () => {
      const replay = {
        kind: 'openai' as const,
        items: [
          responsesReasoning('enc-kept'),
          {
            id: 'msg_kept',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Kept.', annotations: [] }],
          },
        ],
      };
      await converse(
        responses,
        fake.apiKey,
        {
          ...start,
          messages: [
            { role: 'user', text: 'Review this change' },
            { role: 'assistant', text: 'Other words.', toolCalls: [], replay },
          ],
        },
        http,
      );
      expect(inputOf().slice(1)).toEqual(replay.items);
    });

    it('keeps the output of an answer as it came, items of a kind it does not know and the fields of the newest models included', async () => {
      const odd = responsesAnswer('x') as { output: unknown[] };
      odd.output = [
        responsesReasoning('enc-odd'),
        { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search' } },
        {
          id: 'msg_1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          // The newest models label a message as commentary or as the answer: it goes back as it was.
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Hello', annotations: [], logprobs: null }],
        },
        {
          id: 'fc_9',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_9',
          name: 'read_file',
          arguments: '{"path":"z.ts"}',
        },
      ];
      fake.enqueue({ status: 200, body: odd });
      const turn = await converse(responses, fake.apiKey, start, http);
      expect(turn.replay).toEqual({ kind: 'openai', items: odd.output });
      expect(JSON.stringify(turn.replay?.items)).toBe(JSON.stringify(odd.output));
      // What the loop reads of the turn is still the text and the calls.
      expect(turn).toMatchObject({
        text: 'Hello',
        finishReason: 'tool',
        toolCalls: [{ id: 'call_9', name: 'read_file', arguments: { path: 'z.ts' } }],
      });
    });

    it('gives a turn without thinking a replay too, a final answer and a cut-off one included', async () => {
      fake.enqueue(
        { status: 200, body: responsesAnswer('{"findings":[]}') },
        {
          status: 200,
          body: responsesAnswer('{"findings":[{"ti', { incomplete: 'max_output_tokens' }),
        },
      );
      const done = await converse(responses, fake.apiKey, start, http);
      expect(done.replay?.kind).toBe('openai');
      expect(done.replay?.items).toHaveLength(1);
      // A cut-off answer is sent back with its words, as the loop asks for a shorter one.
      const cut = await converse(responses, fake.apiKey, start, http);
      expect(cut.replay?.items).toEqual([
        expect.objectContaining({ type: 'message', status: 'incomplete' }),
      ]);
    });

    it('keeps a copy of the output as the replay: nothing done to the calls of the turn changes it', async () => {
      fake.enqueue({
        status: 200,
        body: responsesToolCalls(
          [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
          {
            reasoning: [responsesReasoning('enc-copy')],
          },
        ),
      });
      const turn = await converse(responses, fake.apiKey, start, http);
      const before = JSON.stringify(turn.replay?.items);
      expect(before).toContain('enc-copy');
      (turn.toolCalls[0]!.arguments as { path: string }).path = 'changed.ts';
      expect(JSON.stringify(turn.replay?.items)).toBe(before);
      expect(before).not.toContain('changed.ts');
    });

    it('is part of the answer: reasoning that takes the answer past 1 MiB makes it a bad answer', async () => {
      const heavy = responsesAnswer('Done.', {
        reasoning: [responsesReasoning('s'.repeat(LLM_MAX_ANSWER_BYTES))],
      });
      fake.enqueue({ status: 200, body: heavy });
      await expect(converse(responses, fake.apiKey, start, http)).rejects.toMatchObject({
        failure: 'bad_answer',
      });
      // Under the cap the same turn is read, with all of its reasoning kept.
      const light = responsesAnswer('Done.', {
        reasoning: [responsesReasoning('s'.repeat(LLM_MAX_ANSWER_BYTES / 2))],
      });
      fake.enqueue({ status: 200, body: light });
      const turn = await converse(responses, fake.apiKey, start, http);
      expect(turn).toMatchObject({ text: 'Done.', finishReason: 'stop' });
      expect(JSON.stringify(turn.replay?.items)).toBe(JSON.stringify(outputOf(light)));
    });

    describe('an item that nests deeper than JSON can write', () => {
      const DEPTH = 100_000;
      const deep = `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}`;
      /** An answer as the provider's JSON text, from the text of each item of its output. */
      const rawAnswer = (...items: string[]): string =>
        `{"id":"resp_1","object":"response","status":"completed","model":"m","output":[${items.join(',')}],"usage":{"input_tokens":1,"output_tokens":1}}`;
      const REASONING =
        '{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"enc-deep"}';
      const MESSAGE = (extra: string) =>
        `{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Done.","annotations":${extra}}]}`;

      it('ends as the adapter’s own bad answer for a message with deep annotations, never as a turn no request can carry', async () => {
        fake.enqueue({ status: 200, body: rawAnswer(REASONING, MESSAGE(`[${deep}]`)) });
        // Not the turn itself: what a failing test shows of a turn that deep cannot be sent
        // between the processes of the runner.
        const err = await converse(responses, fake.apiKey, start, http).then(
          () => 'a turn',
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(LlmError);
        expect(err).toMatchObject({
          failure: 'bad_answer',
          message: "The provider's answer was not understood",
        });
      });

      it('is still read in a single call, which keeps no replay and sends nothing back', async () => {
        fake.enqueue({ status: 200, body: rawAnswer(REASONING, MESSAGE(`[${deep}]`)) });
        expect(await callProvider(responses, fake.apiKey, call, http)).toMatchObject({
          text: 'Done.',
          finishReason: 'stop',
        });
      });

      it('has no replay for a call whose arguments nest deeper than JSON can write: nothing is thrown', async () => {
        fake.enqueue({
          status: 200,
          body: rawAnswer(
            REASONING,
            `{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"read_file","arguments":${deep}}`,
          ),
        });
        const turn = await converse(responses, fake.apiKey, start, http);
        expect(turn.finishReason).toBe('tool');
        expect(turn.toolCalls).toHaveLength(1);
        expect(turn.replay).toBeUndefined();
      });

      it('keeps the replay of an item nested as deep as JSON still follows, as it came', async () => {
        const nested = `${'{"a":'.repeat(500)}1${'}'.repeat(500)}`;
        const text = rawAnswer(REASONING, MESSAGE(`[${nested}]`));
        fake.enqueue({ status: 200, body: text });
        const turn = await converse(responses, fake.apiKey, start, http);
        expect(turn.text).toBe('Done.');
        expect(JSON.stringify(turn.replay?.items)).toBe(
          JSON.stringify((JSON.parse(text) as { output: unknown[] }).output),
        );
      });

      it('does not lean on how deep a copy can follow: what JSON cannot write is a bad answer however the copy is made', async () => {
        // A copy that follows any depth, as another runtime's may.
        vi.stubGlobal('structuredClone', <T>(value: T): T => value);
        try {
          fake.enqueue({ status: 200, body: rawAnswer(REASONING, MESSAGE(`[${deep}]`)) });
          const err = await converse(responses, fake.apiKey, start, http).then(
            () => 'a turn',
            (e: unknown) => e,
          );
          expect(err).toMatchObject({ failure: 'bad_answer' });
        } finally {
          vi.unstubAllGlobals();
        }
      });
    });
  });

  describe('a failure is classified as Chat Completions classifies it', () => {
    describe.each([
      ['a conversation', () => converse(responses, fake.apiKey, start, http)],
      ['a call', () => callProvider(responses, fake.apiKey, call, http)],
    ])('%s', (_name, run) => {
      it.each([
        [429, { 'retry-after': '7' }, 'rate_limited', 7],
        [401, {}, 'refused_key', null],
        [403, {}, 'refused_key', null],
        [400, {}, 'rejected', null],
        [404, {}, 'rejected', null],
        [500, {}, 'unavailable', null],
        [503, {}, 'unavailable', null],
        [503, { 'retry-after': '3' }, 'unavailable', 3],
      ])('HTTP %i', async (status, headers, failure, retryAfter) => {
        fake.enqueue({ status, headers, body: llmShape('openai-error') });
        const err = await run().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LlmError);
        expect(err).toMatchObject({ failure, status, retryAfterSeconds: retryAfter });
        expect((err as Error).message).not.toContain('Fake error text');
      });
    });

    it('names a refusal of tools by the words that name them, and only when tools were sent', async () => {
      const refusal = (message: string, over: Record<string, unknown> = {}) => ({
        status: 400,
        body: {
          error: { message, type: 'invalid_request_error', param: null, code: null, ...over },
        },
      });
      fake.enqueue(
        refusal('This model does not support tools'),
        refusal('Invalid value', { param: 'tools', code: 'unsupported_parameter' }),
        refusal('This model does not support tools'),
        refusal('Invalid schema for function read_file: In context=(), type is required.'),
      );
      const flagged = await converse(responses, fake.apiKey, start, http).catch((e: unknown) => e);
      expect(flagged).toMatchObject({ failure: 'rejected', status: 400, refusedTools: true });
      expect((flagged as Error).message).toMatch(/\btools\b/);
      expect(
        await converse(responses, fake.apiKey, start, http).catch((e: unknown) => e),
      ).toMatchObject({
        refusedTools: true,
      });
      // No tools were sent: it is some other refusal, whatever its words.
      expect(
        await converse(responses, fake.apiKey, { ...start, tools: [] }, http).catch(
          (e: unknown) => e,
        ),
      ).toMatchObject({ failure: 'rejected', refusedTools: false, message: GENERIC });
      // A refusal of the schema of a tool is Qualor's own schema refused, not a server without tools.
      expect(
        await converse(responses, fake.apiKey, start, http).catch((e: unknown) => e),
      ).toMatchObject({
        failure: 'rejected',
        refusedTools: false,
        message: GENERIC,
      });
    });

    it('never contacts an address that is not listed', async () => {
      const err = await converse(responses, fake.apiKey, start, {
        ...http,
        internalHosts: new Set(),
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ failure: 'url_not_allowed' });
      expect(fake.requests).toHaveLength(0);
    });

    it('reads the body of a refused request once, whatever it is checked for', async () => {
      // A body that none of the checks takes for its own, so that each of them is made on it.
      const text = JSON.stringify({
        error: { message: 'Refused for a reason of its own', param: 'other', code: null },
      });
      const parse = vi.spyOn(JSON, 'parse');
      try {
        for (const conversation of [start, { ...start, tools: [] }]) {
          fake.enqueue({ status: 400, body: text });
          await converse(responses, fake.apiKey, conversation, http).catch(() => undefined);
        }
        expect(parse.mock.calls.filter(([arg]) => arg === text)).toHaveLength(2);
      } finally {
        parse.mockRestore();
      }
    });

    it('is cut at once when its caller gives up the call, and sends nothing once it has', async () => {
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
        return { status: 200, body: responsesAnswer('{}') };
      });
      const controller = new AbortController();
      try {
        const running = converse({ ...responses, timeoutSeconds: 60 }, fake.apiKey, start, {
          ...http,
          signal: controller.signal,
        }).catch((e: unknown) => e);
        await asked;
        controller.abort();
        const err = await running;
        expect(err).toBeInstanceOf(LlmCallAborted);
        expect(err).not.toBeInstanceOf(LlmError);
      } finally {
        release();
      }
      fake.requests.length = 0;
      const aborted = await converse(responses, fake.apiKey, start, {
        ...http,
        signal: AbortSignal.abort(),
      }).catch((e: unknown) => e);
      expect(aborted).toBeInstanceOf(LlmCallAborted);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('a model that takes function tools only through the Responses API', () => {
    // What OpenAI answered on 2026-10-26 to a chat completion with function tools, the same from
    // gpt-6-luna, gpt-5.6-terra and gpt-6.1-sol but for the model.
    const real = (model: string) =>
      `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`;
    const WORDS = real('gpt-5.6-terra');
    const refuse = (message: string, status = 400) => ({
      status,
      body: { error: { message, type: 'invalid_request_error', param: null, code: null } },
    });

    it('is named, on Chat Completions, by a 400 that names /v1/responses, with a fixed hint and none of the provider’s words', async () => {
      fake.enqueue(refuse(WORDS));
      const err = await converse(chat, fake.apiKey, start, http).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(err).toMatchObject({
        failure: 'rejected',
        status: 400,
        // It is a refusal of tools too: a review that meets it fails as a model without tools.
        refusedTools: true,
        needsResponses: true,
        message: RESPONSES_REQUIRED_TEXT,
      });
      expect(RESPONSES_REQUIRED_TEXT).toBe(
        'This model takes tools only through the Responses API: choose Responses in the AI provider settings.',
      );
      expect((err as Error).message).not.toContain('reasoning_effort');
    });

    it.each([
      ['the words of gpt-5.6-terra', real('gpt-5.6-terra')],
      ['the words of gpt-6-luna', real('gpt-6-luna')],
      ['the words of gpt-6.1-sol', real('gpt-6.1-sol')],
      ['the path without its first slash', 'This model is served at v1/responses only'],
      ['any case', 'USE /V1/RESPONSES INSTEAD'],
      // The other trigger alone: the words of the message that say tools do not go with reasoning,
      // with no path to the Responses API in them.
      [
        'the real words without the path',
        "Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions. To use function tools, set reasoning_effort to 'none'.",
      ],
      [
        'the first sentence of the real words alone',
        'Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions.',
      ],
      [
        'those words in another case',
        'FUNCTION TOOLS WITH REASONING_EFFORT are not supported here.',
      ],
      [
        'the same words of a model that has no effort',
        'Function tools with reasoning are not supported here.',
      ],
    ])('is named by %s', async (_what, message) => {
      fake.enqueue(refuse(message));
      expect(await converse(chat, fake.apiKey, start, http).catch((e: unknown) => e)).toMatchObject(
        {
          needsResponses: true,
          message: RESPONSES_REQUIRED_TEXT,
        },
      );
    });

    it.each([
      ['a message that says nothing of it', 'This model does not support tools'],
      [
        'a mention of responses that is not the path',
        'Streaming responses are not supported with tools',
      ],
      ['a path that only starts like it', 'See /v1/responses_api_notes'],
      [
        'a refusal of function tools for another reason',
        'Function tools with strict mode are not supported for this model.',
      ],
      [
        'words that only start like the phrase',
        'Function tools with reasoning_summary are not supported for this model.',
      ],
    ])('is not named by %s', async (_what, message) => {
      fake.enqueue(refuse(message));
      expect(await converse(chat, fake.apiKey, start, http).catch((e: unknown) => e)).toMatchObject(
        {
          needsResponses: false,
        },
      );
    });

    it('is not named for another status, for a request without tools, on the Responses wire, or for Anthropic', async () => {
      // Another status.
      for (const status of [404, 422, 500]) {
        fake.enqueue(refuse(WORDS, status));
        expect(
          await converse(chat, fake.apiKey, start, http).catch((e: unknown) => e),
        ).toMatchObject({
          needsResponses: false,
        });
      }
      // No tools were sent.
      fake.enqueue(refuse(WORDS));
      expect(
        await converse(chat, fake.apiKey, { ...start, tools: [] }, http).catch((e: unknown) => e),
      ).toMatchObject({ needsResponses: false, message: GENERIC });
      fake.enqueue(refuse(WORDS));
      expect(
        await callProvider(chat, fake.apiKey, call, http).catch((e: unknown) => e),
      ).toMatchObject({
        needsResponses: false,
      });
      // Already on the Responses API: it is no suggestion to move there.
      fake.enqueue(refuse(WORDS));
      expect(
        await converse(responses, fake.apiKey, start, http).catch((e: unknown) => e),
      ).toMatchObject({
        needsResponses: false,
        refusedTools: true,
        message:
          'The provider refused the request (HTTP 400): the model or its server does not accept tools',
      });
      // Anthropic has no such API.
      fake.enqueue(refuse(WORDS));
      const anthropic = { ...chat, kind: 'anthropic', baseUrl: fake.anthropicBaseUrl } as const;
      expect(
        await converse(anthropic, fake.apiKey, start, http).catch((e: unknown) => e),
      ).toMatchObject({
        needsResponses: false,
      });
    });

    it('takes the same tools through the Responses API, which is where the model is asked for them', async () => {
      const only = await createFakeLlm({ toolsOnlyThroughResponses: ['gpt-6.1-sol'] });
      try {
        const onlyHttp = { ...http, internalHosts: parseInternalHosts(only.host) };
        const model = { model: 'gpt-6.1-sol', baseUrl: only.openAiBaseUrl };
        const refused = await converse({ ...chat, ...model }, only.apiKey, start, onlyHttp).catch(
          (e: unknown) => e,
        );
        expect(refused).toMatchObject({ needsResponses: true, message: RESPONSES_REQUIRED_TEXT });
        only.enqueue({
          status: 200,
          body: responsesToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }], {
            reasoning: [responsesReasoning('enc-sol')],
          }),
        });
        const turn = await converse({ ...responses, ...model }, only.apiKey, start, onlyHttp);
        expect(turn).toMatchObject({ finishReason: 'tool', toolCalls: [{ id: 'call_1' }] });
      } finally {
        await only.close();
      }
    });
  });

  describe('a model that refuses the room to think', () => {
    // A call carries the room apart from the answer's tokens, and the adapter asks for both in
    // `max_output_tokens`. A model that refuses a limit that large is asked again, in the same call,
    // for the answer's tokens alone, through the code that Chat Completions and Anthropic use.
    const ASKED = { maxOutputTokens: 1_200, reasoningAllowance: 4_000 };
    const room = { system: 'S', user: 'U', ...ASKED };
    const conversation: LlmConversation = { ...start, ...ASKED };
    let models = 0;
    /** A model of its own for each test: what a process learns of one it keeps. */
    const own = (config: ProviderConfig): ProviderConfig => {
      models += 1;
      return { ...config, model: `responses-model-${models}` };
    };
    const limits = () =>
      fake.requests.map((r) => (r.json as { max_output_tokens: number }).max_output_tokens);
    const answer = { status: 200, body: responsesAnswer('{"ok":true}') };
    /** The 400s the Responses API gives for a limit above what the model takes, and their class. */
    const REFUSALS: [string, unknown, boolean][] = [
      [
        'the cap of the model, in the words of its validator',
        {
          error: {
            message:
              "Invalid 'max_output_tokens': integer above maximum value. Expected a value <= 4096, but got 5200 instead.",
            type: 'invalid_request_error',
            param: 'max_output_tokens',
            code: 'integer_above_max_value',
          },
        },
        true,
      ],
      [
        'the cap of the model, in the words Chat Completions uses for max_tokens',
        {
          error: {
            message:
              'max_output_tokens is too large: 5200. This model supports at most 4096 completion tokens, whereas you provided 5200.',
            type: 'invalid_request_error',
            param: 'max_output_tokens',
            code: null,
          },
        },
        true,
      ],
      [
        'the context window of a server that shares it with the prompt',
        {
          error: {
            message:
              "'max_output_tokens' is too large: 5200. This model's maximum context length is 8192 tokens and your request has 4500 input tokens (5200 > 8192 - 4500).",
            type: 'BadRequestError',
            param: 'max_output_tokens',
            code: 400,
          },
        },
        false,
      ],
    ];
    const nextCall = (body: unknown, remembered: boolean) =>
      remembered ? [answer] : [{ status: 400, body }, answer];

    it.each(REFUSALS)(
      'a call is asked again, once, for the answer alone, and the model is remembered only for a cap of its own: %s',
      async (_who, refusal, remembered) => {
        const config = own(responses);
        fake.enqueue({ status: 400, body: refusal }, answer);
        expect((await callProvider(config, fake.apiKey, room, http)).finishReason).toBe('stop');
        expect(limits()).toEqual([5_200, 1_200]);
        // Else the same request.
        const without = (request: RecordedLlmRequest) =>
          Object.fromEntries(
            Object.entries(request.json as Record<string, unknown>).filter(
              ([field]) => field !== 'max_output_tokens',
            ),
          );
        expect(without(fake.requests[1]!)).toEqual(without(fake.requests[0]!));
        fake.enqueue(...nextCall(refusal, remembered));
        await callProvider(config, fake.apiKey, room, http);
        expect(limits()).toEqual(remembered ? [5_200, 1_200, 1_200] : [5_200, 1_200, 5_200, 1_200]);
      },
    );

    it.each(REFUSALS)(
      'a conversation too, with its tools: %s',
      async (_who, refusal, remembered) => {
        const config = own(responses);
        fake.enqueue({ status: 400, body: refusal }, answer);
        expect((await converse(config, fake.apiKey, conversation, http)).finishReason).toBe('stop');
        expect(limits()).toEqual([5_200, 1_200]);
        // The tools went with both asks.
        for (const n of [0, 1]) expect(body(n).tools, `request ${n}`).toHaveLength(2);
        fake.enqueue(...nextCall(refusal, remembered));
        await converse(config, fake.apiKey, conversation, http);
        expect(limits()).toEqual(remembered ? [5_200, 1_200, 1_200] : [5_200, 1_200, 5_200, 1_200]);
      },
    );

    it('remembers a model per base URL and model, as the other wires do, and not for another model', async () => {
      const learned = own(responses);
      fake.enqueue({ status: 400, body: REFUSALS[0]![1] }, answer);
      await callProvider(learned, fake.apiKey, room, http);
      // What the Responses wire learned of this model holds for its Chat Completions calls too: the
      // cap is the model's own, whatever the API it is asked through.
      fake.enqueue({ status: 200, body: openAiAnswer('{"ok":true}') });
      await callProvider({ ...learned, api: 'chat_completions' }, fake.apiKey, room, http);
      expect(
        fake.requests.map((r) => {
          const json = r.json as { max_output_tokens?: number; max_tokens?: number };
          return json.max_output_tokens ?? json.max_tokens;
        }),
      ).toEqual([5_200, 1_200, 1_200]);
      // Another model is asked for the room again.
      fake.enqueue(answer);
      await callProvider(own(responses), fake.apiKey, room, http);
      expect(limits().at(-1)).toBe(5_200);
    });

    it('asks again once after a refusal it does not know, which keeps its own error when the answer alone is refused the same way: a prompt that is too long on its own, a limit below the least, a schema', async () => {
      const unrelated = [
        "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.",
        'Your input exceeds the context window of this model. Please adjust your input and try again.',
        "Invalid schema for function 'read_file': 'type' is required.",
      ];
      for (const message of unrelated) {
        fake.requests.length = 0;
        const refusal = {
          status: 400,
          body: { error: { message, type: 'invalid_request_error', param: 'input', code: null } },
        };
        fake.enqueue(refusal, refusal);
        const err = await callProvider(own(responses), fake.apiKey, room, http).catch(
          (e: unknown) => e,
        );
        expect(err, message).toMatchObject({
          failure: 'rejected',
          status: 400,
          refusedOutputLimit: false,
          message: GENERIC,
        });
        expect(limits(), message).toEqual([5_200, 1_200]);
      }
    });

    it('asks again after a 422 as after a 400, and its words keep their class there', async () => {
      const config = own(responses);
      fake.enqueue({ status: 422, body: REFUSALS[0]![1] }, answer, answer);
      await callProvider(config, fake.apiKey, room, http);
      await callProvider(config, fake.apiKey, room, http);
      // A cap of the model's own: the second call knew it.
      expect(limits()).toEqual([5_200, 1_200, 1_200]);
    });

    it('asks for the answer alone when there is no room, and the refusal then stands, flagged but never asked again', async () => {
      fake.enqueue({ status: 400, body: REFUSALS[0]![1] });
      const refused = await callProvider(
        own(responses),
        fake.apiKey,
        { system: 'S', user: 'U', maxOutputTokens: 5_200 },
        http,
      ).catch((e: unknown) => e);
      expect(refused).toMatchObject({
        failure: 'rejected',
        status: 400,
        refusedOutputLimit: true,
        message: GENERIC,
      });
      expect(limits()).toEqual([5_200]);
    });

    it('is a real cap of a model when the fake says so: a conversation is answered on the second ask, and the Test’s next call goes without the room', async () => {
      const capped = await createFakeLlm({ outputCaps: { 'capped-model': 4_096 } });
      try {
        const cappedHttp = { ...http, internalHosts: parseInternalHosts(capped.host) };
        const config = { ...responses, model: 'capped-model', baseUrl: capped.openAiBaseUrl };
        const turn = await converse(config, capped.apiKey, conversation, cappedHttp);
        expect(turn.finishReason).toBe('stop');
        await callProvider(config, capped.apiKey, room, cappedHttp);
        expect(
          capped.requests.map((r) => (r.json as { max_output_tokens: number }).max_output_tokens),
        ).toEqual([5_200, 1_200, 1_200]);
      } finally {
        await capped.close();
      }
    });
  });
});
