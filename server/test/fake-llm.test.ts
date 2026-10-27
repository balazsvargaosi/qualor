import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrompt } from '@qualor/shared';
import { sampleInput } from '../../packages/shared/test/llm';
import {
  anthropicAnswer,
  anthropicRedactedThinking,
  anthropicThinking,
  anthropicToolUse,
  cannedModelText,
  createFakeLlm,
  llmShape,
  openAiAnswer,
  openAiToolCalls,
  responsesAnswer,
  responsesReasoning,
  responsesToolCalls,
  type FakeLlm,
} from './fake-llm';
import { deltasOf, streamPieces } from './fake-llm-sse';

const NONCE = 'f'.repeat(32);

describe('fake LLM', () => {
  let fake: FakeLlm;
  beforeAll(async () => {
    fake = await createFakeLlm();
  });
  afterAll(async () => {
    await fake.close();
  });

  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    fetch(`${fake.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('answers the OpenAI shape with a canned answer for the task in the data block', async () => {
    const p = buildPrompt('fix', sampleInput(), NONCE);
    const res = await post(
      '/v1/chat/completions',
      { authorization: `Bearer ${fake.apiKey}` },
      {
        model: 'm',
        messages: [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user },
        ],
      },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(JSON.parse(json.choices[0]!.message.content)).toEqual({
      status: 'fixed',
      startLine: 2,
      endLine: 2,
      replacement: ['if (a === 1) {}'],
      explanation: 'Use strict equality.',
    });
    expect(fake.requests.at(-1)?.path).toBe('/v1/chat/completions');
  });

  it('answers the Anthropic shape and checks its version header', async () => {
    const p = buildPrompt('triage', sampleInput(), NONCE);
    const body = {
      model: 'm',
      max_tokens: 10,
      system: p.system,
      messages: [{ role: 'user', content: p.user }],
    };
    expect((await post('/v1/messages', { 'x-api-key': fake.apiKey }, body)).status).toBe(400);
    const res = await post(
      '/v1/messages',
      { 'x-api-key': fake.apiKey, 'anthropic-version': '2023-06-01' },
      body,
    );
    const json = (await res.json()) as { content: { text: string }[] };
    expect(JSON.parse(json.content[0]!.text).verdict).toBe('likely_true_positive');
  });

  it('refuses a wrong key with 401 and serves scripted replies first', async () => {
    expect((await post('/v1/chat/completions', { authorization: 'Bearer nope' }, {})).status).toBe(
      401,
    );
    fake.enqueue({
      status: 429,
      headers: { 'retry-after': '7' },
      body: { error: { message: 'x' } },
    });
    fake.say('not json');
    const auth = { authorization: `Bearer ${fake.apiKey}` };
    const first = await post('/v1/chat/completions', auth, { messages: [] });
    expect([first.status, first.headers.get('retry-after')]).toEqual([429, '7']);
    const second = (await (await post('/v1/chat/completions', auth, { messages: [] })).json()) as {
      choices: { message: { content: string } }[];
    };
    expect(second.choices[0]!.message.content).toBe('not json');
  });

  it('survives a malformed data block and a throwing responder, and keeps serving', async () => {
    const auth = { authorization: `Bearer ${fake.apiKey}` };
    const block = (inner: string) => ({
      messages: [
        {
          role: 'user',
          content: `<<<QUALOR-DATA-${NONCE}\n${inner}\nQUALOR-DATA-${NONCE}>>>`,
        },
      ],
    });
    for (const inner of ['{not json', '{"task":"fix"}', 'null']) {
      const res = await post('/v1/chat/completions', auth, block(inner));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(json.choices[0]!.message.content).toBe('{"ok": true}');
    }
    fake.enqueue(() => {
      throw new Error('scripted failure');
    });
    expect((await post('/v1/chat/completions', auth, { messages: [] })).status).toBe(500);
    expect((await post('/v1/chat/completions', auth, { messages: [] })).status).toBe(200);
  });

  it('refuses a key header when it expects none', async () => {
    const open = await createFakeLlm({ apiKey: null });
    try {
      const send = (headers: Record<string, string>, path = '/v1/chat/completions') =>
        fetch(`${open.url}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...headers,
          },
          body: '{}',
        });
      expect((await send({})).status).toBe(200);
      expect((await send({ authorization: 'Bearer x' })).status).toBe(400);
      expect((await send({ 'api-key': 'x' })).status).toBe(400);
      expect((await send({ 'x-api-key': 'x' }, '/v1/messages')).status).toBe(400);
      expect((await send({}, '/v1/messages')).status).toBe(200);
    } finally {
      await open.close();
    }
  });

  it('builds tool-call answers in the providers shapes (R5)', () => {
    const openAi = openAiToolCalls(
      [
        { id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } },
        // A string is the provider's own text: it goes out as it is, JSON or not.
        { id: 'call_2', name: 'grep', arguments: '{not json' },
      ],
      { usage: { prompt_tokens: 7, completion_tokens: 3 }, model: 'm-x' },
    );
    expect(openAi).toMatchObject({
      model: 'm-x',
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'grep', arguments: '{not json' },
              },
            ],
          },
        },
      ],
    });
    const spoken = openAiToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }], {
      text: 'Looking.',
    });
    expect(
      (spoken as { choices: { message: { content: unknown } }[] }).choices[0]!.message,
    ).toMatchObject({
      content: 'Looking.',
    });

    const anthropic = anthropicToolUse(
      [{ id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }],
      {
        text: 'Looking.',
      },
    );
    expect(anthropic).toMatchObject({
      type: 'message',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
    const silent = anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: {} }]);
    expect((silent as { content: unknown[] }).content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
    ]);
  });

  it('builds the thinking blocks of a current model as the recorded shape has them, and puts them first', () => {
    const shape = llmShape<{ content: Record<string, unknown>[] }>('anthropic-message-thinking');
    const [thinking, redacted] = shape.content;
    const blocks = [anthropicThinking('sig-1'), anthropicRedactedThinking('data-1')];
    // The same keys as the documented blocks, in the same order, with the values given.
    expect(Object.keys(blocks[0] as object)).toEqual(Object.keys(thinking!));
    expect(Object.keys(blocks[1] as object)).toEqual(Object.keys(redacted!));
    expect(blocks).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'data-1' },
    ]);
    // A summary in the text is for a request that asks for one; the signature is the same kind of value.
    expect(anthropicThinking('sig-2', 'Weighing it.')).toEqual({
      type: 'thinking',
      thinking: 'Weighing it.',
      signature: 'sig-2',
    });

    const answer = anthropicAnswer('Done.', { thinking: blocks }) as { content: unknown[] };
    expect(answer.content).toEqual([...blocks, { type: 'text', text: 'Done.' }]);
    const calls = anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: {} }], {
      thinking: blocks,
      text: 'Looking.',
    }) as { content: unknown[]; stop_reason: string };
    expect(calls.stop_reason).toBe('tool_use');
    expect(calls.content).toEqual([
      ...blocks,
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
    ]);
    // Nothing given, nothing added: the answers of the older shapes are as they were.
    expect((anthropicAnswer('Done.') as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('refuses what the real Messages API refuses, when it is asked to: a text block that is empty or only whitespace, and a message with no content', async () => {
    const strict = await createFakeLlm({ refuseBlankText: true });
    try {
      const send = (target: FakeLlm, messages: unknown[]) =>
        fetch(`${target.url}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': target.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model: 'm', max_tokens: 10, messages }),
        });
      const text = (value: string) => ({ type: 'text', text: value });
      // What it takes: text, a message given as a string, and blocks of other kinds.
      expect((await send(strict, [{ role: 'user', content: [text('hi')] }])).status).toBe(200);
      expect((await send(strict, [{ role: 'user', content: 'hi' }])).status).toBe(200);
      expect(
        (
          await send(strict, [
            { role: 'user', content: [text('hi')] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
          ])
        ).status,
      ).toBe(200);
      const bad: [string, unknown[], string][] = [
        ['an empty text block', [{ role: 'user', content: [text('')] }], 'messages.0.content.0'],
        [
          'a text block of whitespace',
          [{ role: 'user', content: [text('hi'), text(' \n\t')] }],
          'messages.0.content.1',
        ],
        ['an empty string', [{ role: 'user', content: '' }], 'messages.0'],
        [
          'a message with no content',
          [
            { role: 'user', content: [text('hi')] },
            { role: 'assistant', content: [] },
          ],
          'messages.1',
        ],
      ];
      for (const [name, messages, place] of bad) {
        const res = await send(strict, messages);
        expect(res.status, name).toBe(400);
        expect(JSON.stringify(await res.json()), name).toContain(place);
      }
      // Asked for nothing, it takes them, as it always did.
      expect((await send(fake, [{ role: 'user', content: [text('')] }])).status).toBe(200);
    } finally {
      await strict.close();
    }
  });

  it('refuses a limit above the output cap of a model, in the words of each API, when it is given caps', async () => {
    const capped = await createFakeLlm({ outputCaps: { 'small-model': 4_096 } });
    try {
      const messages = [{ role: 'user', content: 'hi' }];
      const anthropic = (model: string, tokens: number) =>
        fetch(`${capped.url}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': capped.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model, max_tokens: tokens, messages }),
        });
      const openAi = (model: string, field: string, tokens: number) =>
        fetch(`${capped.url}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${capped.apiKey}`,
          },
          body: JSON.stringify({ model, [field]: tokens, messages }),
        });
      // At the cap, under it, and a model that has none: answered.
      expect((await anthropic('small-model', 4_096)).status).toBe(200);
      expect((await openAi('small-model', 'max_tokens', 1)).status).toBe(200);
      expect((await anthropic('other-model', 100_000)).status).toBe(200);
      expect((await openAi('other-model', 'max_tokens', 100_000)).status).toBe(200);
      // Over it, in the words each API has for it; the refusal is no scripted reply, so it takes none.
      capped.enqueue({ status: 200, body: { queued: true } });
      const a = await anthropic('small-model', 5_200);
      expect(a.status).toBe(400);
      expect(await a.json()).toEqual({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'max_tokens: 5200 > 4096, which is the maximum allowed number of output tokens for small-model',
        },
      });
      const o = await openAi('small-model', 'max_tokens', 5_200);
      expect(o.status).toBe(400);
      expect(await o.json()).toEqual({
        error: {
          message:
            'max_tokens is too large: 5200. This model supports at most 4096 completion tokens, whereas you provided 5200.',
          type: 'invalid_request_error',
          param: 'max_tokens',
          code: null,
        },
      });
      const c = await openAi('small-model', 'max_completion_tokens', 5_200);
      expect(c.status).toBe(400);
      expect(JSON.stringify(await c.json())).toContain('max_completion_tokens is too large: 5200.');
      // The scripted reply is still there for the first request that is not refused.
      expect(await (await anthropic('small-model', 10)).json()).toEqual({ queued: true });
    } finally {
      await capped.close();
    }
  });

  it('is an organisation-wide key when it is given a workspace: Anthropic calls name it or are refused', async () => {
    const scoped = await createFakeLlm({ workspaceId: 'wrkspc_Fake01' });
    try {
      const send = (headers: Record<string, string>, path = '/v1/messages') =>
        fetch(`${scoped.url}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': scoped.apiKey,
            authorization: `Bearer ${scoped.apiKey}`,
            'anthropic-version': '2023-06-01',
            ...headers,
          },
          body: '{}',
        });
      const missing = await send({});
      expect(missing.status).toBe(400);
      expect(JSON.stringify(await missing.json())).toMatch(/not scoped to a workspace/);
      // Another workspace is a key that may not do this: a 403, as for a model it may not use.
      expect((await send({ 'anthropic-workspace-id': 'wrkspc_Other02' })).status).toBe(403);
      expect((await send({ 'anthropic-workspace-id': 'wrkspc_Fake01' })).status).toBe(200);
      // OpenAI's wire has no workspace.
      expect((await send({}, '/v1/chat/completions')).status).toBe(200);
    } finally {
      await scoped.close();
    }
    // Without the option the fake is a key of one workspace: the header means nothing to it.
    const plain = await post(
      '/v1/messages',
      { 'x-api-key': fake.apiKey, 'anthropic-version': '2023-06-01' },
      {},
    );
    expect(plain.status).toBe(200);
  });

  describe('the Responses API (POST /v1/responses)', () => {
    const auth = () => ({ authorization: `Bearer ${fake.apiKey}` });
    const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });

    it('answers a canned answer for the task in the data block of the user item, in its own shape', async () => {
      const p = buildPrompt('triage', sampleInput(), NONCE);
      const res = await post('/v1/responses', auth(), {
        model: 'm',
        instructions: p.system,
        input: [user(p.user)],
        store: false,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        object: string;
        status: string;
        output: { type: string; content: { type: string; text: string }[] }[];
      };
      expect([json.object, json.status]).toEqual(['response', 'completed']);
      const [message] = json.output;
      expect(message!.type).toBe('message');
      expect(JSON.parse(message!.content[0]!.text).verdict).toBe('likely_true_positive');
      expect(fake.requests.at(-1)?.path).toBe('/v1/responses');
    });

    it('takes the key as Bearer or api-key, as the chat completions path does, and refuses another with 401', async () => {
      expect((await post('/v1/responses', { authorization: 'Bearer nope' }, {})).status).toBe(401);
      expect((await post('/v1/responses', { 'api-key': fake.apiKey }, {})).status).toBe(200);
      expect((await post('/v1/responses', auth(), {})).status).toBe(200);
    });

    it('serves scripted replies first, and says a text in the shape of its path', async () => {
      fake.say('not json');
      const text = (await (await post('/v1/responses', auth(), {})).json()) as {
        output: { content: { text: string }[] }[];
      };
      expect(text.output[0]!.content[0]!.text).toBe('not json');
      fake.enqueue({ status: 429, body: { error: { message: 'x' } } });
      expect((await post('/v1/responses', auth(), {})).status).toBe(429);
    });

    it('builds an answer as the recorded shape has it: one message item, and the reasoning of a model that thinks before it', () => {
      const shape = llmShape<{ output: Record<string, unknown>[]; usage: unknown }>(
        'openai-response',
      );
      const answer = responsesAnswer('Done.') as typeof shape & Record<string, unknown>;
      // The same keys as the documented answer, and its message item as it is.
      expect(Object.keys(answer)).toEqual(Object.keys(shape));
      expect(answer.output).toEqual([
        {
          ...shape.output[0],
          content: [{ type: 'output_text', text: 'Done.', annotations: [], logprobs: [] }],
        },
      ]);
      expect(answer.status).toBe('completed');
      expect(answer.usage).toEqual(shape.usage);
      const reasoning = [responsesReasoning('enc-1'), responsesReasoning('enc-2', 'rs_custom')];
      expect(reasoning).toEqual([
        { id: 'rs_enc-1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
        { id: 'rs_custom', type: 'reasoning', summary: [], encrypted_content: 'enc-2' },
      ]);
      const thinking = responsesAnswer('Done.', {
        reasoning,
        model: 'm-x',
        usage: { input_tokens: 7, output_tokens: 3 },
      }) as { output: { type: string }[]; model: string; usage: unknown };
      expect(thinking.output.map((item) => item.type)).toEqual([
        'reasoning',
        'reasoning',
        'message',
      ]);
      expect(thinking.model).toBe('m-x');
      expect(thinking.usage).toMatchObject({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
      expect('usage' in (responsesAnswer('x', { usage: null }) as object)).toBe(false);
    });

    it('builds an answer that was cut off, a refusal and a failure the way the API words them', () => {
      const cut = responsesAnswer('Half an ans', { incomplete: 'max_output_tokens' }) as {
        status: string;
        incomplete_details: unknown;
        output: { status: string }[];
      };
      expect([cut.status, cut.incomplete_details, cut.output[0]!.status]).toEqual([
        'incomplete',
        { reason: 'max_output_tokens' },
        'incomplete',
      ]);
      // Cut off while it thought: nothing was written.
      const thinkingOnly = responsesAnswer('', {
        incomplete: 'max_output_tokens',
        reasoning: [responsesReasoning('enc-1')],
      }) as { output: { type: string }[] };
      expect(thinkingOnly.output.map((item) => item.type)).toEqual(['reasoning']);
      const refused = responsesAnswer('', { refusal: 'I cannot help.' }) as {
        output: { content: unknown[] }[];
      };
      expect(refused.output[0]!.content).toEqual([{ type: 'refusal', refusal: 'I cannot help.' }]);
      const failed = responsesAnswer('', {
        status: 'failed',
        error: { code: 'server_error', message: 'Fake error text; never logged or shown.' },
      }) as { status: string; error: unknown };
      expect([failed.status, failed.error]).toEqual([
        'failed',
        { code: 'server_error', message: 'Fake error text; never logged or shown.' },
      ]);
    });

    it('builds function calls as items with their call_id and their arguments as JSON text', () => {
      const answer = responsesToolCalls(
        [
          { id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } },
          // A string is the provider's own text: it goes out as it is, JSON or not.
          { id: 'call_2', name: 'grep', arguments: '{not json' },
        ],
        { text: 'Looking.', reasoning: [responsesReasoning('enc-1')], model: 'm-x' },
      ) as { output: unknown[]; status: string; model: string };
      expect(answer.status).toBe('completed');
      expect(answer.model).toBe('m-x');
      expect(answer.output).toEqual([
        { id: 'rs_enc-1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
        expect.objectContaining({ type: 'message', role: 'assistant' }),
        {
          id: 'fc_call_1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
        },
        {
          id: 'fc_call_2',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_2',
          name: 'grep',
          arguments: '{not json',
        },
      ]);
      const silent = responsesToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }]) as {
        output: { type: string }[];
      };
      expect(silent.output.map((item) => item.type)).toEqual(['function_call']);
    });

    it('refuses what the real API refuses: an assistant message of input_text, an output for a call that was not made, and a limit below 16', async () => {
      const send = (input: unknown[], over: Record<string, unknown> = {}) =>
        post('/v1/responses', auth(), { model: 'm', input, ...over });
      const refusal = async (res: Response) => JSON.stringify(await res.json());
      expect((await send([user('hi')])).status).toBe(200);
      // An assistant turn is output_text (or a refusal): input_text is for the user.
      const wrongPart = await send([
        user('hi'),
        { role: 'assistant', content: [{ type: 'input_text', text: 'hello' }] },
      ]);
      expect(wrongPart.status).toBe(400);
      expect(await refusal(wrongPart)).toContain(
        "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.",
      );
      expect(
        (
          await send([
            user('hi'),
            { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
            { role: 'assistant', content: 'a string is any role’s' },
          ])
        ).status,
      ).toBe(200);
      // An output answers a call that is in the input.
      const call = { type: 'function_call', call_id: 'call_1', name: 'x', arguments: '{}' };
      const output = { type: 'function_call_output', call_id: 'call_1', output: 'ok' };
      expect((await send([user('hi'), call, output])).status).toBe(200);
      const orphan = await send([user('hi'), { ...output, call_id: 'call_9' }]);
      expect(orphan.status).toBe(400);
      expect(await refusal(orphan)).toContain(
        'No tool call found for function call output with call_id call_9.',
      );
      // The least it takes is 16.
      const small = await send([user('hi')], { max_output_tokens: 5 });
      expect(small.status).toBe(400);
      expect(await small.json()).toEqual({
        error: {
          message:
            "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 5 instead.",
          type: 'invalid_request_error',
          param: 'max_output_tokens',
          code: 'integer_below_min_value',
        },
      });
      expect((await send([user('hi')], { max_output_tokens: 16 })).status).toBe(200);
    });

    it('refuses a limit above the output cap of a model in the words of the API, when it is given caps', async () => {
      const capped = await createFakeLlm({ outputCaps: { 'small-model': 4_096 } });
      try {
        const send = (model: string, tokens: number) =>
          fetch(`${capped.url}/v1/responses`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${capped.apiKey}`,
            },
            body: JSON.stringify({ model, max_output_tokens: tokens, input: [user('hi')] }),
          });
        expect((await send('small-model', 4_096)).status).toBe(200);
        expect((await send('other-model', 100_000)).status).toBe(200);
        capped.enqueue({ status: 200, body: { queued: true } });
        const over = await send('small-model', 5_200);
        expect(over.status).toBe(400);
        expect(await over.json()).toEqual({
          error: {
            message:
              "Invalid 'max_output_tokens': integer above maximum value. Expected a value <= 4096, but got 5200 instead.",
            type: 'invalid_request_error',
            param: 'max_output_tokens',
            code: 'integer_above_max_value',
          },
        });
        // It takes no scripted reply: the first request that is not refused still gets it.
        expect(await (await send('small-model', 20)).json()).toEqual({ queued: true });
      } finally {
        await capped.close();
      }
    });
  });

  describe('JSON mode of the Responses API', () => {
    it('is refused when the word json is only in the instructions, as the real API refuses it', async () => {
      const send = (over: Record<string, unknown>) =>
        post(
          '/v1/responses',
          { authorization: `Bearer ${fake.apiKey}` },
          { model: 'm', instructions: 'Answer in JSON.', ...over },
        );
      const json = { text: { format: { type: 'json_object' } } };
      const said = (text: string) => [{ role: 'user', content: [{ type: 'input_text', text }] }];
      const refused = await send({ ...json, input: said('ping') });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: {
          message:
            "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.",
          type: 'invalid_request_error',
          param: 'input',
          code: null,
        },
      });
      // Any case, in a part of a user message or in the result of a call, takes it.
      expect((await send({ ...json, input: said('Reply in Json.') })).status).toBe(200);
      expect(
        (
          await send({
            ...json,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: 'ping' },
                  { type: 'input_text', text: 'in JSON' },
                ],
              },
            ],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send({
            ...json,
            input: [
              ...said('ping'),
              { type: 'function_call', call_id: 'c', name: 'x', arguments: '{}' },
              { type: 'function_call_output', call_id: 'c', output: '{"JSON": true}' },
            ],
          })
        ).status,
      ).toBe(200);
      // No JSON mode asked for: nothing to check.
      expect((await send({ input: said('ping') })).status).toBe(200);
      expect((await send({ input: said('ping'), text: { format: { type: 'text' } } })).status).toBe(
        200,
      );
    });
  });

  describe('a model that takes function tools only through the Responses API', () => {
    it('refuses a chat completion with tools for the models it names, in the words OpenAI uses, and takes everything else', async () => {
      const only = await createFakeLlm({ toolsOnlyThroughResponses: ['sol-model'] });
      try {
        const chat = (model: string, extra: Record<string, unknown>) =>
          fetch(`${only.url}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${only.apiKey}`,
            },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
          });
        const tools = [
          { type: 'function', function: { name: 'x', description: 'x', parameters: {} } },
        ];
        only.enqueue({ status: 200, body: { queued: true } });
        const refused = await chat('sol-model', { tools, tool_choice: 'auto' });
        expect(refused.status).toBe(400);
        const body = (await refused.json()) as { error: { message: string; type: string } };
        expect(body.error.type).toBe('invalid_request_error');
        expect(body.error.message).toBe(
          "Function tools with reasoning_effort are not supported for sol-model in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
        );
        // No tools, or another model: answered, and the refusal took no scripted reply.
        expect(await (await chat('sol-model', {})).json()).toEqual({ queued: true });
        expect((await chat('other-model', { tools })).status).toBe(200);
        // The Responses API takes them, for the same model.
        const responses = await fetch(`${only.url}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${only.apiKey}` },
          body: JSON.stringify({ model: 'sol-model', input: [], tools }),
        });
        expect(responses.status).toBe(200);
      } finally {
        await only.close();
      }
    });
  });

  describe('a request that asks for a stream (R35)', () => {
    const chat = () => ({ authorization: `Bearer ${fake.apiKey}` });
    const messages = () => ({ 'x-api-key': fake.apiKey, 'anthropic-version': '2023-06-01' });
    /** The events of a stream's body: the name of each, and its data as JSON (or as text). */
    const eventsOf = (text: string) =>
      text
        .split('\n\n')
        .filter((event) => event !== '')
        .map((event) => {
          const name = /^event: (.*)$/m.exec(event)?.[1] ?? null;
          const data = /^data: (.*)$/m.exec(event)?.[1] ?? '';
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // `[DONE]`, or a stream that sends what nothing reads.
          }
          return { name, json };
        });
    const streamOf = async (path: string, headers: Record<string, string>, body: object) => {
      const res = await post(path, headers, { model: 'm', ...body, stream: true });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      return eventsOf(await res.text());
    };
    type Chunk = {
      choices: { delta: Record<string, unknown>; finish_reason: unknown }[];
      usage?: unknown;
    };

    it('answers Chat Completions with chunks: the role, the content in several deltas, the calls, the finish, the usage and [DONE]', async () => {
      fake.enqueue({
        status: 200,
        body: openAiToolCalls(
          [
            { id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } },
            { id: 'call_2', name: 'list_files', arguments: { dir: 'src' } },
          ],
          { text: 'Let me look at 😀.' },
        ),
      });
      const events = await streamOf('/v1/chat/completions', chat(), {});
      expect(events.at(-1)).toEqual({ name: null, json: '[DONE]' });
      const chunks = events.slice(0, -1).map((event) => event.json as Chunk);
      expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
      const deltas = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta));
      const content = deltas.flatMap((delta) =>
        typeof delta.content === 'string' && delta.content !== '' ? [delta.content] : [],
      );
      expect(content.length).toBeGreaterThan(1);
      expect(content.join('')).toBe('Let me look at 😀.');
      // The emoji's two halves come in two deltas.
      expect(content.some((piece) => /[\ud800-\udbff]$/.test(piece))).toBe(true);
      const calls = deltas.flatMap(
        (delta) =>
          (delta.tool_calls as { index: number; function: { arguments?: string } }[]) ?? [],
      );
      // Each call's arguments in several deltas, the two calls taking turns.
      const order = calls.map((call) => call.index);
      expect(order.indexOf(1)).toBeLessThan(order.lastIndexOf(0));
      for (const [index, json] of ['{"path":"a.ts"}', '{"dir":"src"}'].entries()) {
        const pieces = calls.filter((call) => call.index === index);
        expect(pieces.map((call) => call.function.arguments ?? '').join('')).toBe(json);
      }
      const finish = chunks.find((chunk) => chunk.choices[0]?.finish_reason !== null);
      expect(finish?.choices[0]?.finish_reason).toBe('tool_calls');
      const counted = chunks.at(-1)!;
      expect(counted.choices).toEqual([]);
      expect(counted.usage).toMatchObject({ prompt_tokens: 412, completion_tokens: 96 });
      // Every other chunk says it has no usage, as OpenAI's do once the usage is asked for.
      expect(chunks.slice(0, -1).every((chunk) => chunk.usage === null)).toBe(true);
    });

    it('answers the Messages API with its events, each block started, filled and stopped, the thinking and its signature included', async () => {
      fake.enqueue({
        status: 200,
        body: anthropicToolUse([{ id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }], {
          text: 'Reading.',
          thinking: [anthropicThinking('SIG', 'Hm.'), anthropicRedactedThinking('ENC')],
        }),
      });
      const events = await streamOf('/v1/messages', messages(), { max_tokens: 10 });
      const names = events.map((event) => event.name);
      expect(names.slice(0, 2)).toEqual(['message_start', 'ping']);
      expect(names.slice(-2)).toEqual(['message_delta', 'message_stop']);
      type Data = {
        index?: number;
        content_block?: Record<string, unknown>;
        delta?: Record<string, unknown>;
      };
      const data = events.map((event) => event.json as Data & Record<string, unknown>);
      expect(data[0]).toMatchObject({
        message: { content: [], stop_reason: null, usage: { input_tokens: 431, output_tokens: 1 } },
      });
      // Each of the four blocks is started, filled by its deltas and stopped, in its order.
      const of = (index: number) => data.filter((event) => event.index === index);
      expect(of(0)[0]).toMatchObject({
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      const thinking = of(0).flatMap((event) => (event.delta ? [event.delta] : []));
      expect(thinking.filter((delta) => delta.type === 'thinking_delta').length).toBeGreaterThan(1);
      expect(thinking.map((delta) => delta.thinking ?? '').join('')).toBe('Hm.');
      expect(thinking.at(-1)).toEqual({ type: 'signature_delta', signature: 'SIG' });
      // The redacted thinking comes whole.
      expect(of(1).map((event) => event.type)).toEqual([
        'content_block_start',
        'content_block_stop',
      ]);
      expect(of(1)[0]).toMatchObject({ content_block: { type: 'redacted_thinking', data: 'ENC' } });
      expect(
        of(2)
          .flatMap((event) => (event.delta ? [event.delta.text] : []))
          .join(''),
      ).toBe('Reading.');
      expect(of(3)[0]).toMatchObject({ content_block: { type: 'tool_use', input: {} } });
      const input = of(3).flatMap((event) => (event.delta ? [event.delta.partial_json] : []));
      expect(input[0]).toBe('');
      expect(input.join('')).toBe('{"path":"a.ts"}');
      expect(data.at(-2)).toMatchObject({
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 102 },
      });
    });

    it('answers the Responses API with its events, the last carrying the whole response', async () => {
      const body = responsesToolCalls([{ id: 'call_1', name: 'read_file', arguments: {} }], {
        text: 'Reading.',
        reasoning: [responsesReasoning('ENC')],
      });
      fake.enqueue({ status: 200, body });
      const events = await streamOf('/v1/responses', chat(), {});
      expect(events[0]).toMatchObject({
        name: 'response.created',
        json: { response: { status: 'in_progress', output: [] } },
      });
      expect(events.at(-1)).toEqual({
        name: 'response.completed',
        json: { type: 'response.completed', sequence_number: events.length - 1, response: body },
      });
      const names = events.map((event) => event.name);
      for (const name of [
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.done',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
      ]) {
        expect(names).toContain(name);
      }
      const done = events.filter((event) => event.name === 'response.output_item.done');
      expect(done.map((event) => (event.json as { item: unknown }).item)).toEqual(
        (body as { output: unknown[] }).output,
      );
    });

    it('ends an incomplete or failed response with its own event', async () => {
      fake.enqueue(
        { status: 200, body: responsesAnswer('{"a', { incomplete: 'max_output_tokens' }) },
        { status: 200, body: responsesAnswer('', { status: 'failed' }) },
      );
      expect((await streamOf('/v1/responses', chat(), {})).at(-1)?.name).toBe(
        'response.incomplete',
      );
      expect((await streamOf('/v1/responses', chat(), {})).at(-1)?.name).toBe('response.failed');
    });

    it('cuts a text in deltas, a pair of surrogates apart, and the bytes inside a character', () => {
      expect(deltasOf('')).toEqual([]);
      expect(deltasOf('a')).toEqual(['a']);
      const text = 'x😀yz';
      const pieces = deltasOf(text);
      expect(pieces.join('')).toBe(text);
      expect(pieces).toContain('x\ud83d');
      const written = streamPieces(['data: a\n\n', 'data: é€\n\n', 'data: 😀\n\n']);
      expect(Buffer.concat(written).toString('utf8')).toBe('data: a\n\ndata: é€\n\ndata: 😀\n\n');
      // The first event with a character of two bytes or more comes in two pieces, cut inside it.
      expect(written).toHaveLength(4);
      expect(written[1]!.at(-1)).toBe(0xc3);
    });

    it('sends the faults it is asked for: an error after the first event, a stream with no end, no usage, silence', async () => {
      fake.enqueue({
        status: 200,
        body: openAiAnswer('{}'),
        stream: { error: { type: 'server_error' } },
      });
      expect((await streamOf('/v1/chat/completions', chat(), {})).map((e) => e.json)).toEqual([
        expect.objectContaining({
          choices: [expect.objectContaining({ delta: { role: 'assistant', content: '' } })],
        }),
        { error: expect.objectContaining({ type: 'server_error' }) },
      ]);
      fake.enqueue({
        status: 200,
        body: anthropicAnswer('{}'),
        stream: { error: { type: 'overloaded_error' } },
      });
      expect((await streamOf('/v1/messages', messages(), {})).map((e) => e.name)).toEqual([
        'message_start',
        'error',
      ]);
      fake.enqueue({ status: 200, body: openAiAnswer('{}'), stream: { cut: true } });
      expect((await streamOf('/v1/chat/completions', chat(), {})).at(-1)?.json).not.toBe('[DONE]');
      fake.enqueue({ status: 200, body: anthropicAnswer('{}'), stream: { cut: true } });
      expect((await streamOf('/v1/messages', messages(), {})).at(-1)?.name).toBe('message_delta');
      fake.enqueue({ status: 200, body: openAiAnswer('{}'), stream: { noUsage: true } });
      const unCounted = await streamOf('/v1/chat/completions', chat(), {});
      expect(JSON.stringify(unCounted)).not.toContain('usage');
      fake.enqueue({ status: 200, body: openAiAnswer('{}'), stream: { silent: true } });
      const controller = new AbortController();
      const silent = await fetch(`${fake.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...chat() },
        body: JSON.stringify({ model: 'm', stream: true }),
        signal: controller.signal,
      });
      // The status line comes, and then nothing.
      expect(silent.status).toBe(200);
      controller.abort();
    });

    it('answers a refusal as JSON, a stream of the test’s own as it is, and a request that does not stream as before', async () => {
      fake.enqueue({ status: 429, body: { error: { message: 'x' } } });
      const refused = await post('/v1/chat/completions', chat(), { stream: true });
      expect([refused.status, refused.headers.get('content-type')]).toEqual([
        429,
        'application/json',
      ]);
      fake.enqueue({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: own\n\n',
      });
      expect(await (await post('/v1/chat/completions', chat(), { stream: true })).text()).toBe(
        'data: own\n\n',
      );
      fake.say('{}');
      const plain = await post('/v1/chat/completions', chat(), {});
      expect(plain.headers.get('content-type')).toBe('application/json');
      expect(((await plain.json()) as { choices: unknown[] }).choices).toHaveLength(1);
    });

    it('refuses every stream when it is a server that does not stream, in the words of each API, and takes no scripted reply for it', async () => {
      const refusing = await createFakeLlm({ refuseStream: true });
      try {
        const ask = (path: string, headers: Record<string, string>, stream: boolean) =>
          fetch(`${refusing.url}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ model: 'm', ...(stream ? { stream: true } : {}) }),
          });
        const key = { authorization: `Bearer ${refusing.apiKey}` };
        refusing.say('{"first":true}');
        const chatRefused = await ask('/v1/chat/completions', key, true);
        expect(chatRefused.status).toBe(400);
        expect(await chatRefused.json()).toMatchObject({ error: { param: 'stream_options' } });
        const responsesRefused = await ask('/v1/responses', key, true);
        expect(await responsesRefused.json()).toMatchObject({ error: { param: 'stream' } });
        const messagesRefused = await ask(
          '/v1/messages',
          { 'x-api-key': refusing.apiKey, 'anthropic-version': '2023-06-01' },
          true,
        );
        expect(await messagesRefused.json()).toMatchObject({
          error: { message: 'stream: Extra inputs are not permitted' },
        });
        // The scripted reply is still there for the request asked without the stream.
        const plain = (await (await ask('/v1/chat/completions', key, false)).json()) as {
          choices: { message: { content: string } }[];
        };
        expect(plain.choices[0]!.message.content).toBe('{"first":true}');
      } finally {
        await refusing.close();
      }
    });
  });

  describe('the prompt cache (R49), when it is asked to report one', () => {
    let cached: FakeLlm;
    beforeAll(async () => {
      cached = await createFakeLlm({ promptCache: true });
    });
    afterAll(async () => {
      await cached.close();
    });
    const MARK = { type: 'ephemeral' };
    const TOOLS = [
      { name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } },
    ];
    const anthropicUsage = async (body: unknown) => {
      const res = await fetch(`${cached.url}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cached.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { usage: Record<string, number> }).usage;
    };
    const messages = (marked: boolean, ...texts: string[]) =>
      texts.map((text, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [
          {
            type: 'text',
            text,
            ...(marked && i === texts.length - 1 ? { cache_control: MARK } : {}),
          },
        ],
      }));
    const marked = (...texts: string[]) => ({
      model: 'claude-cache',
      max_tokens: 10,
      system: [{ type: 'text', text: 'The system prompt.', cache_control: MARK }],
      tools: TOOLS,
      messages: messages(true, ...texts),
    });
    /** The same request without a marker: its system prompt as text. */
    const unmarked = (...texts: string[]) => ({
      ...marked(...texts),
      system: 'The system prompt.',
      messages: messages(false, ...texts),
    });

    it('an Anthropic call whose marked prefix an earlier call wrote reports reads', async () => {
      const first = await anthropicUsage(marked('Review this change'));
      expect(first).toMatchObject({ input_tokens: 431, cache_read_input_tokens: 0 });
      expect(first.cache_creation_input_tokens).toBeGreaterThan(0);
      // The next call extends it: it reads what the first wrote, and writes what it adds.
      const next = await anthropicUsage(marked('Review this change', 'Reading.', 'const a = 1;'));
      expect(next.cache_read_input_tokens).toBe(first.cache_creation_input_tokens);
      expect(next.cache_creation_input_tokens).toBeGreaterThan(0);
      // The same call again reads it all and writes nothing.
      const again = await anthropicUsage(marked('Review this change'));
      expect(again).toMatchObject({
        cache_read_input_tokens: first.cache_creation_input_tokens,
        cache_creation_input_tokens: 0,
      });
      // A call without markers reads and writes nothing, whatever its prefix.
      expect(await anthropicUsage(unmarked('Review this change'))).toMatchObject({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
      // Another model has a cache of its own.
      const other = await anthropicUsage({
        ...marked('Review this change'),
        model: 'claude-other',
      });
      expect(other.cache_read_input_tokens).toBe(0);
    });

    it('an OpenAI call that extends an earlier call’s messages reports cached_tokens', async () => {
      const ask = async (path: string, body: unknown) => {
        const res = await fetch(`${cached.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cached.apiKey}` },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { usage: Record<string, unknown> }).usage;
      };
      const chatOf = (...texts: string[]) => ({
        model: 'gpt-cache',
        messages: [
          { role: 'system', content: 'The system prompt.' },
          ...texts.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content })),
        ],
      });
      const cachedOf = (usage: Record<string, unknown>) =>
        (usage.prompt_tokens_details as { cached_tokens: number }).cached_tokens;
      const first = await ask('/v1/chat/completions', chatOf('Review this change'));
      expect(cachedOf(first)).toBe(0);
      const next = await ask(
        '/v1/chat/completions',
        chatOf('Review this change', 'Reading.', 'const a = 1;'),
      );
      expect(cachedOf(next)).toBeGreaterThan(0);
      // The prompt's count holds the cached part.
      expect(next.prompt_tokens as number).toBeGreaterThanOrEqual(cachedOf(next));
      // One that does not extend an earlier conversation reads nothing.
      expect(cachedOf(await ask('/v1/chat/completions', chatOf('Another change')))).toBe(0);

      const responsesOf = (...texts: string[]) => ({
        model: 'gpt-cache',
        instructions: 'The system prompt.',
        input: texts.map((text) => ({ role: 'user', content: [{ type: 'input_text', text }] })),
      });
      const details = (usage: Record<string, unknown>) =>
        (usage.input_tokens_details as { cached_tokens: number }).cached_tokens;
      expect(details(await ask('/v1/responses', responsesOf('Review this change')))).toBe(0);
      const extended = await ask('/v1/responses', responsesOf('Review this change', 'More.'));
      expect(details(extended)).toBeGreaterThan(0);
      expect(extended.input_tokens as number).toBeGreaterThanOrEqual(details(extended));
    });

    it('reports no cache by default', async () => {
      const res = await post(
        '/v1/messages',
        { 'x-api-key': fake.apiKey, 'anthropic-version': '2023-06-01' },
        marked('Review this change'),
      );
      expect(((await res.json()) as { usage: unknown }).usage).toEqual({
        input_tokens: 431,
        output_tokens: 102,
      });
    });

    it('refuses the markers when it is a gateway that takes none, and takes no scripted reply for it', async () => {
      const gateway = await createFakeLlm({ refuseCacheControl: true });
      try {
        const ask = (body: unknown) =>
          fetch(`${gateway.url}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': gateway.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
          });
        gateway.say('{"first":true}');
        const refused = await ask(marked('Review this change'));
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({
          error: { message: 'system.0.cache_control: Extra inputs are not permitted' },
        });
        const plain = await ask(unmarked('Review this change'));
        expect(plain.status).toBe(200);
        expect(((await plain.json()) as { content: { text: string }[] }).content[0]!.text).toBe(
          '{"first":true}',
        );
      } finally {
        await gateway.close();
      }
    });
  });

  it('says {"ok": true} to a request without a data block', () => {
    const request = {
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: '',
      json: { messages: [{ role: 'user', content: 'ping' }] },
    };
    expect(cannedModelText(request)).toBe('{"ok": true}');
  });
});
