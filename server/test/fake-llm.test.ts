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
  openAiToolCalls,
  type FakeLlm,
} from './fake-llm';

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
