import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLlm, llmShape, type FakeLlm, type LlmReply } from '../../../test/fake-llm';
import { withStreamServer, type StreamServer } from '../../../test/stream-server';
import { parseInternalHosts } from '../../scm/url';
import { NOT_UNDERSTOOD, postJson, postStream, type StreamedAnswer } from './http';
import type { SseEvent } from './sse';
import {
  LLM_MAX_ANSWER_BYTES,
  LLM_MAX_EVENT_BYTES,
  LlmCallAborted,
  LlmError,
  WORKSPACE_REQUIRED_TEXT,
  type ProviderConfig,
  type ProviderHttpOptions,
} from './types';

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
}

const event = (data: string, type: string | null = null): SseEvent => ({ event: type, data });

/** The events of a streamed answer: what a test of an event stream reads. */
function eventsOf(answer: StreamedAnswer): AsyncIterable<SseEvent> {
  if (answer.kind !== 'events') throw new Error('the answer is no event stream');
  return answer.events;
}

const LIMITS = {
  firstByteMs: 5_000,
  idleMs: 1_000,
  totalMs: 60_000,
  maxStreamBytes: 16 * 1_024 * 1_024,
};

/** What an LlmError carries, for comparing two of them: a text, a status and the flags. */
function shape(error: unknown): unknown {
  if (error instanceof LlmError) {
    return {
      failure: error.failure,
      message: error.message,
      status: error.status,
      retryAfterSeconds: error.retryAfterSeconds,
      refusedTools: error.refusedTools,
      refusedOutputLimit: error.refusedOutputLimit,
      refusedContext: error.refusedContext,
      needsResponses: error.needsResponses,
      refusedStream: error.refusedStream,
    };
  }
  return error instanceof LlmCallAborted ? 'LlmCallAborted' : error;
}

/** What a body came to: the error's shape, the events it holds drained, or the whole answer. */
async function outcomeOf(got: unknown): Promise<unknown> {
  if (got instanceof Error) return shape(got);
  if ((got as StreamedAnswer).kind === 'events') {
    return { events: await drain(eventsOf(got as StreamedAnswer)) };
  }
  return got;
}

describe('postStream', () => {
  let fake: FakeLlm;
  let http: ProviderHttpOptions;
  let openai: ProviderConfig;
  let anthropic: ProviderConfig;
  const chat = () => ({
    path: '/chat/completions',
    headers: { authorization: `Bearer ${fake.apiKey}` },
  });
  const messages = () => ({
    path: '/v1/messages',
    headers: { 'x-api-key': fake.apiKey, 'anthropic-version': '2023-06-01' },
  });

  beforeAll(async () => {
    fake = await createFakeLlm();
    http = { internalHosts: parseInternalHosts(fake.host), version: '0.0.0' };
  });
  afterAll(async () => {
    await fake.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    fake.requests.length = 0;
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

  it('reads the events of a 2xx, asking for an event stream the way postJson asks for JSON', async () => {
    fake.enqueue({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'event: a\ndata: 1\n\ndata: 2\r\ndata: 3\r\n\r\n: ping\n\ndata: [DONE]\n\n',
    });
    const stream = await postStream(
      openai,
      chat().path,
      chat().headers,
      { model: 'm-1', stream: true },
      http,
      LIMITS,
    );
    expect(await drain(eventsOf(stream))).toEqual([
      event('1', 'a'),
      event('2\n3'),
      event('[DONE]'),
    ]);
    const sent = fake.requests[0]!;
    expect(sent).toMatchObject({ method: 'POST', path: '/v1/chat/completions' });
    expect(sent.headers.accept).toBe('text/event-stream');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers['user-agent']).toBe('Qualor/0.0.0');
    expect(sent.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
    expect(sent.json).toEqual({ model: 'm-1', stream: true });
  });

  it('serves the three wires: the paths it is given, under the base URL, a trailing slash or not', async () => {
    const responses = { ...openai, api: 'responses' } as const;
    for (const [config, path, headers] of [
      [{ ...openai, baseUrl: `${fake.openAiBaseUrl}/` }, '/responses', chat().headers],
      [responses, '/responses', chat().headers],
      [openai, '/chat/completions', chat().headers],
      [anthropic, '/v1/messages', messages().headers],
    ] as const) {
      fake.enqueue({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: x\n\n',
      });
      const stream = await postStream(config, path, headers, {}, http, LIMITS);
      expect(await drain(eventsOf(stream))).toEqual([event('x')]);
    }
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/v1/responses',
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/messages',
    ]);
  });

  it('reads a 2xx whole, as JSON, when its content type is JSON: a server that ignored the stream', async () => {
    const whole = { id: 'chatcmpl-1', choices: [{ message: { content: 'é 😀' } }] };
    for (const type of [
      'application/json',
      'Application/JSON; charset=utf-8',
      'application/vnd.api+json',
      'application/problem+json; charset=utf-8',
    ]) {
      fake.enqueue({ status: 200, headers: { 'content-type': type }, body: whole });
      expect(await postStream(openai, chat().path, chat().headers, {}, http, LIMITS), type).toEqual(
        { kind: 'whole', answer: whole },
      );
    }
  });

  it('reads a 2xx of any other content type as an event stream: a gateway that streams under a wrong type', async () => {
    for (const type of [
      'Text/Event-Stream; charset=utf-8',
      'text/plain',
      'application/octet-stream',
      'application/jsonl',
    ]) {
      fake.enqueue({ status: 200, headers: { 'content-type': type }, body: 'data: x\n\n' });
      const stream = await postStream(openai, chat().path, chat().headers, {}, http, LIMITS);
      expect(await drain(eventsOf(stream)), type).toEqual([event('x')]);
    }
  });

  it('refuses a whole answer that is not JSON, or is over 1 MiB, as postJson refuses it', async () => {
    const outcomes = async (answer: LlmReply) => {
      fake.enqueue(answer, answer);
      const asJson = await postJson(openai, chat().path, chat().headers, {}, http).catch(
        (e: unknown) => e,
      );
      const asStream = await postStream(
        openai,
        chat().path,
        chat().headers,
        {},
        http,
        LIMITS,
      ).catch((e: unknown) => e);
      return { asJson: shape(asJson), asStream: shape(asStream) };
    };
    const notJson = await outcomes(reply(200, 'not json'));
    expect(notJson.asStream).toEqual(notJson.asJson);
    expect(notJson.asStream).toMatchObject({
      failure: 'bad_answer',
      message: NOT_UNDERSTOOD,
      status: 200,
    });
    const tooLarge = await outcomes(reply(200, { pad: 'x'.repeat(LLM_MAX_ANSWER_BYTES) }));
    expect(tooLarge.asStream).toEqual(tooLarge.asJson);
    expect(tooLarge.asStream).toMatchObject({ failure: 'bad_answer', message: NOT_UNDERSTOOD });
  });

  /** A reply of the providers, as the fake serves it. */
  const reply = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): LlmReply => ({
    status,
    headers,
    body,
  });
  const openAiError = () => llmShape('openai-error');
  const refusal = (message: string, over: Record<string, unknown> = {}) => ({
    error: { message, type: 'invalid_request_error', ...over },
  });
  const withTools = { model: 'm-1', tools: [{ type: 'function', function: { name: 'x' } }] };

  type Wire = 'openai' | 'anthropic';
  type Refused = [
    string,
    Wire,
    LlmReply,
    unknown,
    ProviderConfig['maxTokensField'] | undefined,
    Record<string, unknown>,
  ];
  const REFUSED: Refused[] = [
    [
      '429 with Retry-After',
      'openai',
      reply(429, openAiError(), { 'retry-after': '7' }),
      {},
      undefined,
      { failure: 'rate_limited', status: 429, retryAfterSeconds: 7 },
    ],
    [
      '429 of Anthropic',
      'anthropic',
      reply(429, openAiError(), { 'retry-after-ms': '1500' }),
      {},
      undefined,
      { failure: 'rate_limited', retryAfterSeconds: 2 },
    ],
    [
      '401',
      'openai',
      reply(401, openAiError()),
      {},
      undefined,
      {
        failure: 'refused_key',
        status: 401,
        message: 'The provider refused the API key (HTTP 401)',
      },
    ],
    [
      '403',
      'anthropic',
      reply(403, openAiError()),
      {},
      undefined,
      { failure: 'refused_key', status: 403 },
    ],
    [
      '404',
      'openai',
      reply(404, openAiError()),
      {},
      undefined,
      { failure: 'rejected', status: 404 },
    ],
    [
      '400 that says nothing',
      'openai',
      reply(400, openAiError()),
      {},
      undefined,
      {
        failure: 'rejected',
        status: 400,
        message: 'The provider refused the request (HTTP 400); check the base URL and model',
      },
    ],
    [
      '400 that is not JSON',
      'openai',
      reply(400, 'max_tokens'),
      {},
      'max_tokens',
      { failure: 'rejected', status: 400 },
    ],
    [
      '302',
      'openai',
      reply(302, '', { location: 'https://elsewhere.example' }),
      {},
      undefined,
      { failure: 'rejected', status: 302 },
    ],
    [
      '307',
      'anthropic',
      reply(307, '', { location: '/v1/messages' }),
      {},
      undefined,
      { failure: 'rejected', status: 307 },
    ],
    [
      '500',
      'openai',
      reply(500, '<html>Fake error text</html>', { 'content-type': 'text/html' }),
      {},
      undefined,
      { failure: 'unavailable', status: 500, message: 'The model provider could not be reached' },
    ],
    [
      '529',
      'anthropic',
      reply(529, openAiError()),
      {},
      undefined,
      { failure: 'unavailable', status: 529 },
    ],
    [
      '503 with Retry-After',
      'openai',
      reply(503, openAiError(), { 'retry-after': '3' }),
      {},
      undefined,
      { failure: 'unavailable', status: 503, retryAfterSeconds: 3 },
    ],
    [
      'an output limit that is the cap of the model',
      'openai',
      reply(
        400,
        refusal(
          'max_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.',
        ),
      ),
      {},
      undefined,
      { failure: 'rejected', refusedOutputLimit: true, refusedContext: false },
    ],
    [
      'an output limit that is the context window',
      'openai',
      reply(
        400,
        refusal(
          "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (4000 in the messages, 5000 in the completion). Please reduce the length of the messages or completion.",
        ),
      ),
      {},
      undefined,
      { failure: 'rejected', refusedOutputLimit: true, refusedContext: true },
    ],
    [
      'an output limit of Anthropic',
      'anthropic',
      reply(
        400,
        refusal(
          'max_tokens: 20384 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022',
        ),
      ),
      {},
      undefined,
      { failure: 'rejected', refusedOutputLimit: true, refusedContext: false },
    ],
    [
      'the output limit field the model does not accept',
      'openai',
      reply(
        400,
        refusal("Fake error text: Unsupported parameter: 'max_tokens'", {
          param: 'max_tokens',
          code: 'unsupported_parameter',
        }),
      ),
      {},
      'max_tokens',
      {
        failure: 'rejected',
        status: 400,
        message:
          'The model does not accept max_tokens; set the output limit parameter to max_completion_tokens in the AI provider settings',
      },
    ],
    [
      'tools a model does not take',
      'openai',
      reply(
        400,
        refusal('Fake error text: this model does not support tools', {
          param: 'tools',
          code: 'unsupported_parameter',
        }),
      ),
      withTools,
      undefined,
      { failure: 'rejected', refusedTools: true, needsResponses: false },
    ],
    [
      'tools a model takes only through the Responses API',
      'openai',
      reply(
        400,
        refusal(
          "Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
        ),
      ),
      withTools,
      'max_tokens',
      { failure: 'rejected', refusedTools: true, needsResponses: true },
    ],
    [
      'a key that is not scoped to a workspace',
      'anthropic',
      reply(400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'Fake error text: this API key is not scoped to a workspace; name one with the anthropic-workspace-id header.',
        },
      }),
      {},
      undefined,
      { failure: 'workspace_required', message: WORKSPACE_REQUIRED_TEXT },
    ],
  ];

  it.each(REFUSED)(
    'refuses %s exactly as postJson does',
    async (_name, wire, answer, body, field, expected) => {
      const config = wire === 'anthropic' ? anthropic : openai;
      const { path, headers } = wire === 'anthropic' ? messages() : chat();
      fake.enqueue(answer, answer);
      const asJson = await postJson(config, path, headers, body, http, field).catch(
        (e: unknown) => e,
      );
      const asStream = await postStream(config, path, headers, body, http, LIMITS, field).catch(
        (e: unknown) => e,
      );
      expect(asJson).toBeInstanceOf(LlmError);
      expect(asStream).toBeInstanceOf(LlmError);
      expect(shape(asStream)).toEqual(shape(asJson));
      expect(shape(asStream)).toMatchObject(expected);
      expect((asStream as Error).message).not.toContain('Fake error text');
      expect(fake.requests).toHaveLength(2);
    },
  );

  /** The refusals of a server that does not stream, as each kind of server words them. */
  const STREAM_REFUSALS: [string, Wire, unknown][] = [
    [
      'a Chat Completions server that does not know stream_options, by its param',
      'openai',
      {
        error: {
          message: 'Fake error text',
          type: 'invalid_request_error',
          param: 'stream_options',
          code: null,
        },
      },
    ],
    [
      'the Responses API, by its param stream',
      'openai',
      {
        error: {
          message: 'Fake error text',
          type: 'invalid_request_error',
          param: 'stream',
          code: 'unsupported_parameter',
        },
      },
    ],
    [
      'a server that names stream_options in its words (Azure)',
      'openai',
      refusal('Unrecognized request argument supplied: stream_options'),
    ],
    [
      'a server whose validation refuses stream_options (vLLM)',
      'openai',
      {
        object: 'error',
        message: 'stream_options: Extra inputs are not permitted',
        type: 'BadRequestError',
        param: null,
        code: 400,
      },
    ],
    [
      'the Messages API, which names no param',
      'anthropic',
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'stream: Extra inputs are not permitted' },
      },
    ],
    [
      'a server that says it does not stream',
      'openai',
      refusal('Streaming is not supported for this model'),
    ],
    [
      'a server that will not stream tools, which takes them unstreamed',
      'openai',
      refusal('Streaming tool calls is not supported for this model'),
    ],
    [
      'a server that says a response cannot be streamed',
      'openai',
      refusal('A streamed response is not supported by this endpoint'),
    ],
  ];

  it.each(STREAM_REFUSALS)(
    'flags a 400 that refuses the stream of a streamed request: %s',
    async (_name, wire, body) => {
      const config = wire === 'anthropic' ? anthropic : openai;
      const { path, headers } = wire === 'anthropic' ? messages() : chat();
      const sent = { ...withTools, stream: true };
      fake.enqueue(reply(400, body), reply(400, body));
      const err = await postStream(config, path, headers, sent, http, LIMITS).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LlmError);
      expect(shape(err)).toMatchObject({
        failure: 'rejected',
        status: 400,
        refusedStream: true,
        refusedTools: false,
        message: 'The provider refused the request (HTTP 400); check the base URL and model',
      });
      // A request that did not ask for a stream is not refused for one.
      const plain = await postJson(config, path, headers, withTools, http).catch((e: unknown) => e);
      expect(shape(plain)).toMatchObject({ failure: 'rejected', refusedStream: false });
    },
  );

  it.each([
    [
      'a 400 that names stream and says nothing of support',
      400,
      refusal('stream: Input should be a valid boolean'),
    ],
    [
      'a 400 that says something else is not supported',
      400,
      refusal("Unsupported parameter: 'temperature'"),
    ],
    [
      'a refusal of stream_options with another status',
      422,
      {
        error: {
          message: 'Fake error text',
          type: 'invalid_request_error',
          param: 'stream_options',
          code: null,
        },
      },
    ],
  ])('does not flag %s', async (_name, status, body) => {
    fake.enqueue(reply(status, body));
    const err = await postStream(
      openai,
      chat().path,
      chat().headers,
      { stream: true },
      http,
      LIMITS,
    ).catch((e: unknown) => e);
    expect(shape(err)).toMatchObject({ failure: 'rejected', status, refusedStream: false });
  });

  it('refuses a body over 1 MiB as it reads it: the status counts, and nothing is held in full', async () => {
    fake.enqueue({
      status: 400,
      body: JSON.stringify(
        refusal(
          'max_tokens is too large: 20000. This model supports at most 16384 completion tokens.',
        ),
      ).padEnd(LLM_MAX_ANSWER_BYTES + 100, ' '),
    });
    const err = await postStream(openai, chat().path, chat().headers, {}, http, LIMITS).catch(
      (e: unknown) => e,
    );
    // Cut at 1 MiB, the JSON is whole (the padding is blank), so it is classified as ever.
    expect(shape(err)).toMatchObject({ failure: 'rejected', refusedOutputLimit: true });
  });

  /** What a call that fails before any status line does, in the two functions. */
  const closedPort = async (): Promise<number> => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  };
  type Attempt = {
    config: ProviderConfig;
    headers: Record<string, string>;
    http: ProviderHttpOptions;
    expected: Record<string, unknown> | 'LlmCallAborted';
  };
  const BEFORE: [string, () => Promise<Attempt>][] = [
    [
      'a base URL that is not listed',
      () =>
        Promise.resolve({
          config: openai,
          headers: chat().headers,
          http: { ...http, internalHosts: new Set() },
          expected: { failure: 'url_not_allowed' },
        }),
    ],
    [
      'a name that resolves to a private address',
      () =>
        Promise.resolve({
          config: { ...openai, baseUrl: 'https://llm.example.com/v1' },
          headers: chat().headers,
          http: { ...http, resolve: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]) },
          expected: { failure: 'url_not_allowed' },
        }),
    ],
    [
      'a header value that cannot be sent',
      () =>
        Promise.resolve({
          config: openai,
          headers: { authorization: 'Bearer bad\nvalue' },
          http,
          expected: { failure: 'rejected', status: null },
        }),
    ],
    [
      'a provider that nothing listens on',
      async () => {
        const port = await closedPort();
        return {
          config: { ...openai, baseUrl: `http://127.0.0.1:${port}/v1` },
          headers: chat().headers,
          http: { ...http, internalHosts: parseInternalHosts(`127.0.0.1:${port}`) },
          expected: { failure: 'unavailable', message: 'The model provider could not be reached' },
        };
      },
    ],
    [
      'a host that does not resolve',
      () =>
        Promise.resolve({
          config: { ...openai, baseUrl: 'https://llm.example.com/v1' },
          headers: chat().headers,
          http: { ...http, resolve: () => Promise.reject(new Error('ENOTFOUND')) },
          expected: { failure: 'unavailable' },
        }),
    ],
    [
      'a signal that aborted before',
      () => {
        const controller = new AbortController();
        controller.abort();
        return Promise.resolve({
          config: openai,
          headers: chat().headers,
          http: { ...http, signal: controller.signal },
          expected: 'LlmCallAborted' as const,
        });
      },
    ],
  ];

  it.each(BEFORE)(
    'fails before the stream exactly as postJson does, for %s',
    async (_name, attempt) => {
      const { config, headers, http: options, expected } = await attempt();
      const asJson = await postJson(config, chat().path, headers, {}, options).catch(
        (e: unknown) => e,
      );
      const asStream = await postStream(config, chat().path, headers, {}, options, LIMITS).catch(
        (e: unknown) => e,
      );
      expect(shape(asStream)).toEqual(shape(asJson));
      if (expected === 'LlmCallAborted') expect(asStream).toBeInstanceOf(LlmCallAborted);
      else expect(shape(asStream)).toMatchObject(expected);
      expect(fake.requests).toHaveLength(0);
    },
  );

  /** A provider the test answers by hand. */
  const against = (server: StreamServer) => ({
    config: { ...openai, baseUrl: `http://${server.host}/v1` },
    http: { ...http, internalHosts: parseInternalHosts(server.host) },
  });
  const fakeTimers = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  };
  const start = (
    server: StreamServer,
    limits: Partial<typeof LIMITS> = {},
    signal?: AbortSignal,
  ) => {
    const { config, http: options } = against(server);
    return postStream(
      config,
      '/chat/completions',
      {},
      { stream: true },
      signal ? { ...options, signal } : options,
      { ...LIMITS, ...limits },
    ).then(eventsOf);
  };

  /** A call answered by hand whose answer is read whole: one that is no event stream. */
  const startWhole = (
    server: StreamServer,
    limits: Partial<typeof LIMITS> = {},
    signal?: AbortSignal,
  ) => {
    const { config, http: options } = against(server);
    return postStream(
      config,
      '/chat/completions',
      {},
      { stream: true },
      signal ? { ...options, signal } : options,
      { ...LIMITS, ...limits },
    );
  };

  it('reads a whole answer as it arrives, within the timers of the stream, and its caller can give it up', async () => {
    await withStreamServer(async (server) => {
      const pending = startWhole(server);
      const answer = await server.next();
      answer.head(200, { 'content-type': 'application/json' });
      // Cut inside a character of two bytes: the answer is decoded once it is whole.
      const body = Buffer.from('{"text":"é"}');
      await answer.write(body.subarray(0, 10));
      await answer.end(body.subarray(10));
      expect(await pending).toEqual({ kind: 'whole', answer: { text: 'é' } });
    });
    await withStreamServer(async (server) => {
      fakeTimers();
      const quiet = startWhole(server, { idleMs: 1_000 }).catch((e: unknown) => e);
      const answer = await server.next();
      answer.head(200, { 'content-type': 'application/json' });
      await answer.write('{"text":');
      // The status line and the piece have reached the call before the clock moves: the call waits
      // for the rest of a body it began to read, not for its first byte.
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(shape(await quiet)).toMatchObject({
        failure: 'timeout',
        message: 'The model sent nothing for 1 s; raise the timeout in the AI provider settings',
      });
      await answer.closed;
    });
    await withStreamServer(async (server) => {
      const controller = new AbortController();
      const given = startWhole(server, {}, controller.signal).catch((e: unknown) => e);
      const answer = await server.next();
      answer.head(200, { 'content-type': 'application/json' });
      await answer.write('{"text":');
      controller.abort();
      expect(await given).toBeInstanceOf(LlmCallAborted);
      await answer.closed;
    });
  });

  it('reads a 2xx with no content type by its first byte that is not blank: `{` or `[` whole, as JSON, and anything else as an event stream', async () => {
    // What each body, in its pieces, comes to: the answer, its events, or the error.
    const outcomes: unknown[] = [];
    for (const pieces of [
      ['{"text":"x"}'],
      // Blanks first, in pieces of their own: the first byte that is not blank decides.
      [' \r\n\t', '\n', '[1,', '2]'],
      ['{oops'],
      ['data: 1\n\n', 'data: 2\n\n'],
      ['\n', ': ping\n\n', 'data: 1\n\ndata: 2\n\n'],
      // Nothing but blanks: an event stream with no events.
      ['\n\n'],
    ]) {
      await withStreamServer(async (server) => {
        const pending = startWhole(server);
        const answer = await server.next();
        answer.head(200, {});
        for (const piece of pieces) await answer.write(piece);
        await answer.end();
        const got = await pending.catch((e: unknown) => e);
        outcomes.push(await outcomeOf(got));
      });
    }
    expect(outcomes).toEqual([
      { kind: 'whole', answer: { text: 'x' } },
      { kind: 'whole', answer: [1, 2] },
      expect.objectContaining({ failure: 'bad_answer', message: NOT_UNDERSTOOD, status: 200 }),
      { events: [event('1'), event('2')] },
      { events: [event('1'), event('2')] },
      { events: [] },
    ]);
  });

  it('decides on a 2xx with no content type within the timers of the stream, and its caller can give it up', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const quiet = startWhole(server, { idleMs: 1_000 }).catch((e: unknown) => e);
      const answer = await server.next();
      answer.head(200, {});
      await answer.write('  ');
      // The status line and the blanks have reached the call before the clock moves.
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(shape(await quiet)).toMatchObject({
        failure: 'timeout',
        message: 'The model sent nothing for 1 s; raise the timeout in the AI provider settings',
      });
      await answer.closed;
    });
    await withStreamServer(async (server) => {
      const controller = new AbortController();
      const given = startWhole(server, {}, controller.signal).catch((e: unknown) => e);
      const answer = await server.next();
      answer.head(200, {});
      await answer.write('\n');
      controller.abort();
      expect(await given).toBeInstanceOf(LlmCallAborted);
      await answer.closed;
    });
  });

  it('a reader of a 2xx with no content type that stops early closes the connection and leaves no timer', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const pending = startWhole(server);
      const answer = await server.next();
      answer.head(200, {});
      await answer.write('data: 1\n\ndata: 2\n\n');
      for await (const next of eventsOf(await pending)) {
        expect(next).toEqual(event('1'));
        break;
      }
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('yields each event as soon as the chunks that make it have come, whatever their cuts', async () => {
    await withStreamServer(async (server) => {
      const pending = start(server);
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      await answer.write('data: {"a"');
      await answer.write(':1}\n');
      await answer.write('\n');
      expect(await iterator.next()).toEqual({ done: false, value: event('{"a":1}') });
      await answer.write('data: [DO');
      await answer.write('NE]\n\n');
      expect(await iterator.next()).toEqual({ done: false, value: event('[DONE]') });
      await answer.end();
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    });
  });

  it('no first byte in time is a timeout that says how long the model was silent', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const outcome = start(server, { firstByteMs: 5_000 }).catch((e: unknown) => e);
      const answer = await server.next();
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await outcome;
      expect(err).toBeInstanceOf(LlmError);
      expect(shape(err)).toMatchObject({
        failure: 'timeout',
        message: 'The model sent nothing for 5 s; raise the timeout in the AI provider settings',
        status: null,
      });
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('the total limit can end the wait for the first byte, in its own words', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const outcome = start(server, { firstByteMs: 5_000, totalMs: 2_000 }).catch(
        (e: unknown) => e,
      );
      const answer = await server.next();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(shape(await outcome)).toMatchObject({
        failure: 'timeout',
        message: 'The model did not finish answering within 2 s; the call was given up',
      });
      await answer.closed;
    });
  });

  it('a stream that goes quiet is a timeout that says how long, and the events before it were read', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const pending = start(server, { firstByteMs: 5_000, idleMs: 2_000 });
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      await answer.write('data: 1\n\n');
      expect(await iterator.next()).toEqual({ done: false, value: event('1') });
      const quiet = iterator.next().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(shape(await quiet)).toMatchObject({
        failure: 'timeout',
        message: 'The model sent nothing for 2 s; raise the timeout in the AI provider settings',
      });
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('a stream that runs past the total limit is a timeout with the limit in its own words', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const pending = start(server, { idleMs: 1_000, totalMs: 3_000 });
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      for (const n of [1, 2, 3]) {
        await vi.advanceTimersByTimeAsync(800);
        await answer.write(`data: ${n}\n\n`);
        expect(await iterator.next()).toEqual({ done: false, value: event(String(n)) });
      }
      const running = iterator.next().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(600);
      const err = await running;
      expect(shape(err)).toMatchObject({
        failure: 'timeout',
        message: 'The model did not finish answering within 3 s; the call was given up',
      });
      expect((err as Error).message).not.toContain('raise the timeout');
      await answer.closed;
    });
  });

  it('states the total limit in minutes when it is a whole number of them', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const outcome = start(server, { firstByteMs: 20 * 60_000, totalMs: 15 * 60_000 }).catch(
        (e: unknown) => e,
      );
      await server.next();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(shape(await outcome)).toMatchObject({
        failure: 'timeout',
        message: 'The model did not finish answering within 15 min; the call was given up',
      });
    });
  });

  it('refuses a stream over the raw cap as an answer that is not understood', async () => {
    await withStreamServer(async (server) => {
      const pending = start(server, { maxStreamBytes: 64 });
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      await answer.write('data: 1\n\n');
      expect(await iterator.next()).toEqual({ done: false, value: event('1') });
      await answer.write(`: ${'x'.repeat(80)}\n\n`);
      await expect(iterator.next()).rejects.toMatchObject({
        failure: 'bad_answer',
        message: NOT_UNDERSTOOD,
      });
      await answer.closed;
    });
  });

  it('refuses an event over 4 MiB as an answer that is not understood', async () => {
    await withStreamServer(async (server) => {
      const pending = start(server);
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      await answer.write(`data: ${'x'.repeat(LLM_MAX_EVENT_BYTES)}\n\n`);
      await expect(iterator.next()).rejects.toMatchObject({
        failure: 'bad_answer',
        message: NOT_UNDERSTOOD,
      });
      // The connection is not left open behind the refusal.
      await answer.closed;
    });
  });

  it('reads an event over the 1 MiB of an answer: an event may hold more than the answer does', async () => {
    await withStreamServer(async (server) => {
      const pending = start(server);
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      const data = 'x'.repeat(LLM_MAX_ANSWER_BYTES + 1);
      await answer.write(`data: ${data}\n\n`);
      expect(await iterator.next()).toEqual({ done: false, value: event(data) });
      await iterator.return?.();
      await answer.closed;
    });
  });

  it('is unavailable when the connection is lost before the stream ends', async () => {
    await withStreamServer(async (server) => {
      const pending = start(server);
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      await answer.write('data: 1\n\n');
      expect(await iterator.next()).toEqual({ done: false, value: event('1') });
      const lost = iterator.next().catch((e: unknown) => e);
      answer.cut();
      expect(shape(await lost)).toMatchObject({
        failure: 'unavailable',
        message: 'The model provider could not be reached',
      });
    });
  });

  it('gives LlmCallAborted, not an LlmError, when the signal aborts while it streams', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const controller = new AbortController();
      const pending = start(server, {}, controller.signal);
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      await answer.write('data: 1\n\n');
      expect(await iterator.next()).toEqual({ done: false, value: event('1') });
      const running = iterator.next().catch((e: unknown) => e);
      controller.abort();
      const err = await running;
      expect(err).toBeInstanceOf(LlmCallAborted);
      expect(err).not.toBeInstanceOf(LlmError);
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('gives LlmCallAborted when the signal aborts while the answer is awaited', async () => {
    await withStreamServer(async (server) => {
      const controller = new AbortController();
      const outcome = start(server, {}, controller.signal).catch((e: unknown) => e);
      const answer = await server.next();
      controller.abort();
      expect(await outcome).toBeInstanceOf(LlmCallAborted);
      await answer.closed;
    });
  });

  it('a reader that stops early closes the connection and leaves no timer', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const pending = start(server);
      const answer = await server.next();
      answer.head();
      const stream = await pending;
      await answer.write('data: 1\n\ndata: 2\n\n');
      for await (const next of stream) {
        expect(next).toEqual(event('1'));
        break;
      }
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('a reader that stops before its first read closes the connection and leaves no timer', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const pending = start(server);
      const answer = await server.next();
      answer.head();
      const reader = (await pending)[Symbol.asyncIterator]();
      await answer.write('data: 1\n\n');
      expect(await reader.return?.()).toEqual({ done: true, value: undefined });
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
      // Stopped, it stays stopped: nothing that arrived before is read after.
      expect(await reader.next()).toEqual({ done: true, value: undefined });
    });
  });

  it('a reader that stops while it waits for an event closes the connection at once', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const pending = start(server);
      const answer = await server.next();
      answer.head();
      const reader = (await pending)[Symbol.asyncIterator]();
      const waiting = reader.next();
      await reader.return?.();
      expect(await waiting).toEqual({ done: true, value: undefined });
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('a stream that is never read is still ended by its timers, the total limit the last of them', async () => {
    await withStreamServer(async (server) => {
      fakeTimers();
      const pending = start(server, { idleMs: 1_000, totalMs: 3_000 });
      const answer = await server.next();
      answer.head();
      const stream = await pending;
      // The provider keeps the idle timer from running out, and nobody reads.
      for (const n of [1, 2, 3]) {
        await vi.advanceTimersByTimeAsync(800);
        await answer.write(`data: ${n}\n\n`);
      }
      await vi.advanceTimersByTimeAsync(600);
      await answer.closed;
      expect(vi.getTimerCount()).toBe(0);
      // What came before the limit is read first, and then the limit.
      const read: unknown[] = [];
      const err = await (async () => {
        for await (const next of stream) read.push(next);
      })().catch((e: unknown) => e);
      expect(read).toEqual([event('1'), event('2'), event('3')]);
      expect(shape(err)).toMatchObject({
        failure: 'timeout',
        message: 'The model did not finish answering within 3 s; the call was given up',
      });
    });
  });

  it('never puts the API key in what it throws, on the way to the stream or in it', async () => {
    const errors: unknown[] = [];
    for (const answer of [
      reply(401, openAiError()),
      reply(500, openAiError()),
      reply(400, 'not json'),
    ]) {
      fake.enqueue(answer);
      errors.push(
        await postStream(openai, chat().path, chat().headers, {}, http, LIMITS).catch(
          (e: unknown) => e,
        ),
      );
    }
    await withStreamServer(async (server) => {
      const pending = start(server, { maxStreamBytes: 8 });
      const answer = await server.next();
      answer.head();
      const iterator = (await pending)[Symbol.asyncIterator]();
      await answer.write('data: 12345\n\n');
      errors.push(await iterator.next().catch((e: unknown) => e));
    });
    for (const err of errors) {
      expect(err).toBeInstanceOf(LlmError);
      const text = [
        inspect(err, { depth: 10, showHidden: true }),
        JSON.stringify(err),
        String(err),
        (err as Error).stack,
      ].join('\n');
      expect(text).not.toContain(fake.apiKey);
    }
  });
});
