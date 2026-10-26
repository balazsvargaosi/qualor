import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLlm, llmShape, type FakeLlm, type LlmReply } from '../../../test/fake-llm';
import { withStreamServer, type StreamServer } from '../../../test/stream-server';
import { parseInternalHosts } from '../../scm/url';
import { NOT_UNDERSTOOD, postJson, postStream } from './http';
import { parseSse, SseError, type SseEvent } from './sse';
import {
  LLM_MAX_ANSWER_BYTES,
  LLM_MAX_EVENT_BYTES,
  LlmCallAborted,
  LlmError,
  WORKSPACE_REQUIRED_TEXT,
  type ProviderConfig,
  type ProviderHttpOptions,
} from './types';

async function* feed(...chunks: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
}

const events = (input: AsyncIterable<Buffer>, maxEventBytes = 1_024): Promise<SseEvent[]> =>
  drain(parseSse(input, { maxEventBytes }));

const event = (data: string, type: string | null = null): SseEvent => ({ event: type, data });

describe('parseSse (the WHATWG event stream rules)', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('reads lines that end in %s', async (_name, eol) => {
    const text = ['event: delta', 'data: one', '', 'data: two', '', ''].join(eol);
    expect(await events(feed(text))).toEqual([event('one', 'delta'), event('two')]);
  });

  it('reads one stream whose lines end in all three ways', async () => {
    expect(await events(feed('data: a\r\ndata: b\ndata: c\r\r'))).toEqual([event('a\nb\nc')]);
  });

  it('takes a CR at the end of a chunk as a line end, and the LF that opens the next chunk as part of it', async () => {
    // The LF is no blank line of its own: that would end the event after its first line.
    expect(await events(feed('data: a\r', '\ndata: b\r\n\r\n'))).toEqual([event('a\nb')]);
    expect(await events(feed('data: a\r\n\r', '\ndata: b\r\n\r\n'))).toEqual([
      event('a'),
      event('b'),
    ]);
    // A CR that no LF follows, in the next chunk, is a line end alone.
    expect(await events(feed('data: a\r', 'data: b\r\r'))).toEqual([event('a\nb')]);
    // The LF waits behind a chunk with nothing to read in it (the rest of a split character).
    expect(await events(feed('data: a\r', Buffer.alloc(0), '\ndata: b\n\n'))).toEqual([
      event('a\nb'),
    ]);
  });

  it('ends a line, and an event, at a CR that ends the input', async () => {
    // A lone CR is a line end as an LF is: here it is the blank line that ends the event.
    expect(await events(feed('data: a\n\r'))).toEqual([event('a')]);
  });

  /**
   * One stream with all of what the format has: a BOM, a type, the three line ends, a comment, a
   * line without a colon, characters of two, three and four bytes, and an event the input ends in.
   */
  const SAMPLE = [
    '\uFEFFevent: ping\r\ndata: 1\r\n\r\n',
    ': a comment\n',
    'data: tw\u00f6\r',
    'data: \u20ac \ud83d\ude00\n\n',
    'data\n\n',
    'event: alone\n\n',
    'data: last\r\n\r\n',
    'data: unended',
  ].join('');
  const SAMPLE_EVENTS = [
    event('1', 'ping'),
    event('tw\u00f6\n\u20ac \ud83d\ude00'),
    event(''),
    event('last'),
  ];

  it('reads a stream the same whole, in two chunks cut anywhere, and a byte at a time', async () => {
    const bytes = Buffer.from(SAMPLE, 'utf8');
    expect(await events(feed(bytes))).toEqual(SAMPLE_EVENTS);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const parts = [bytes.subarray(0, cut), bytes.subarray(cut)];
      expect(await events(feed(...parts)), `cut at ${cut}`).toEqual(SAMPLE_EVENTS);
    }
    expect(await events(feed(...Array.from(bytes, (byte) => Buffer.from([byte]))))).toEqual(
      SAMPLE_EVENTS,
    );
  });

  it('joins the data lines of an event with a line feed', async () => {
    expect(await events(feed('data: a\ndata: b\n\n'))).toEqual([event('a\nb')]);
    // An empty data line is a line of the data too, whether or not it has its colon.
    expect(await events(feed('data: a\ndata\ndata:\ndata: c\n\n'))).toEqual([event('a\n\n\nc')]);
  });

  it('reads comments as nothing: they end no event and break none', async () => {
    expect(await events(feed(': hello\n\n: again\n\n'))).toEqual([]);
    expect(await events(feed('data: a\n: in the middle\ndata: b\n\n'))).toEqual([event('a\nb')]);
    expect(await events(feed(':data: not data\n\n'))).toEqual([]);
    expect(await events(feed(':\n:\n\n'))).toEqual([]);
  });

  it('drops one space after the colon, and no more', async () => {
    expect(await events(feed('data:x\n\ndata: x\n\ndata:  x\n\ndata:\tx\n\n'))).toEqual([
      event('x'),
      event('x'),
      event(' x'),
      event('\tx'),
    ]);
    expect(await events(feed('data: a:b: c\n\n'))).toEqual([event('a:b: c')]);
  });

  it('takes the type from event, the last one winning, and an empty one is none', async () => {
    expect(await events(feed('event: a\nevent: b\ndata: x\n\n'))).toEqual([event('x', 'b')]);
    expect(await events(feed('event: a\nevent:\ndata: x\n\n'))).toEqual([event('x')]);
    // The type comes before or after the data, and is for that event only.
    expect(await events(feed('data: x\nevent: late\n\ndata: y\n\n'))).toEqual([
      event('x', 'late'),
      event('y'),
    ]);
  });

  it('does not yield an event without a data line, and forgets its type', async () => {
    expect(await events(feed('event: ping\n\n'))).toEqual([]);
    expect(await events(feed('event: ping\n\ndata: x\n\n'))).toEqual([event('x')]);
    expect(await events(feed('\n\n\r\n\ndata: x\n\n\n\n'))).toEqual([event('x')]);
    // An empty data line is a data line: the event has data, which is empty.
    expect(await events(feed('data:\n\n'))).toEqual([event('')]);
  });

  it('ignores id, retry and the fields it does not know, and never reconnects', async () => {
    const text = 'id: 7\nretry: 100\nfoo: bar\nevent: e\ndata: x\n\n';
    expect(await events(feed(text))).toEqual([event('x', 'e')]);
    // Names are as they are written: no case folding, no trimming.
    expect(await events(feed('DATA: x\n\n Data: x\n\ndata : x\n\n'))).toEqual([]);
    expect(await events(feed('foo\n\nevent\ndata: x\n\n'))).toEqual([event('x')]);
  });

  it('yields an event as soon as its blank line is read, not when the stream ends', async () => {
    const asked: number[] = [];
    async function* slow(): AsyncGenerator<Buffer> {
      asked.push(1);
      yield Buffer.from('data: a\n\n');
      asked.push(2);
      yield Buffer.from('data: b\n\n');
    }
    const iterator = parseSse(slow(), { maxEventBytes: 100 });
    expect(await iterator.next()).toEqual({ done: false, value: event('a') });
    expect(asked).toEqual([1]);
    expect(await iterator.next()).toEqual({ done: false, value: event('b') });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('does not yield an event that no blank line ended', async () => {
    expect(await events(feed('data: a\n\ndata: b\n'))).toEqual([event('a')]);
    expect(await events(feed('data: a\n\ndata: b'))).toEqual([event('a')]);
    expect(await events(feed('data: a\n\ndata: b\r'))).toEqual([event('a')]);
    expect(await events(feed('data: a\n'))).toEqual([]);
    expect(await events(feed('event: x\ndata: a\ndata: b'))).toEqual([]);
    expect(await events(feed(''))).toEqual([]);
    expect(await events(feed())).toEqual([]);
  });

  it('decodes UTF-8 across the bounds of chunks, whatever the characters are made of', async () => {
    const bytes = Buffer.from('data: \u00e9\u20ac\ud83d\ude00\n\n', 'utf8');
    const heart = bytes.indexOf(0xf0);
    // The euro sign (three bytes) cut after its first byte and after its second, the emoji (four)
    // in three pieces.
    const euro = bytes.indexOf(0xe2);
    expect(
      await events(
        feed(
          bytes.subarray(0, euro + 1),
          bytes.subarray(euro + 1, euro + 2),
          bytes.subarray(euro + 2, heart + 1),
          bytes.subarray(heart + 1, heart + 3),
          bytes.subarray(heart + 3),
        ),
      ),
    ).toEqual([event('\u00e9\u20ac\ud83d\ude00')]);
  });

  it('reads a byte that is no UTF-8 as the replacement character, and goes on', async () => {
    expect(
      await events(feed(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]))),
    ).toEqual([event('\ufffd')]);
  });

  it('drops a BOM at the very start, even one that comes in pieces', async () => {
    const bom = [0xef, 0xbb, 0xbf];
    const line = Buffer.from('data: a\n\n');
    expect(await events(feed(Buffer.concat([Buffer.from(bom), line])))).toEqual([event('a')]);
    expect(
      await events(feed(Buffer.from(bom.slice(0, 1)), Buffer.from(bom.slice(1)), line)),
    ).toEqual([event('a')]);
    expect(
      await events(
        feed(Buffer.from(bom.slice(0, 2)), Buffer.concat([Buffer.from(bom.slice(2)), line])),
      ),
    ).toEqual([event('a')]);
  });

  it('keeps a BOM that is not at the start: it belongs to its line', async () => {
    // So the field of that line is not "data", and the event has no data.
    expect(await events(feed('data: a\n\n\uFEFFdata: b\n\n'))).toEqual([event('a')]);
    expect(await events(feed('data: \uFEFFb\n\n'))).toEqual([event('\uFEFFb')]);
  });

  describe('bounds (maxEventBytes)', () => {
    it('refuses a line over the bound, in bytes and not in characters', async () => {
      // Six characters, sixteen bytes.
      await expect(events(feed(':\u20ac\u20ac\u20ac\u20ac\u20ac\n\n'), 10)).rejects.toMatchObject({
        name: 'SseError',
        cause: 'too_large',
      });
      await expect(events(feed(':\u20ac\u20ac\u20ac\n\n'), 10)).resolves.toEqual([]);
    });

    it('allows a line of exactly the bound, and refuses one byte more', async () => {
      await expect(events(feed(`: ${'x'.repeat(8)}\n\n`), 10)).resolves.toEqual([]);
      await expect(events(feed(`: ${'x'.repeat(9)}\n\n`), 10)).rejects.toBeInstanceOf(SseError);
      // The same with the line end in the next chunk: the half line is at the bound, or over it.
      await expect(events(feed(`: ${'x'.repeat(8)}`, '\n\n'), 10)).resolves.toEqual([]);
      await expect(events(feed(`: ${'x'.repeat(9)}`, '\n\n'), 10)).rejects.toBeInstanceOf(SseError);
    });

    it('refuses the data of an event that passes the bound over its lines, joined by line feeds', async () => {
      // Each line is 15 bytes, with 9 of data: 9, 19 and then 29 with the line feeds.
      const line = 'data: aaaaaaaaa\n';
      await expect(events(feed(`${line}${line}\n`), 20)).resolves.toEqual([
        event('aaaaaaaaa\naaaaaaaaa'),
      ]);
      await expect(events(feed(`${line}${line}${line}\n`), 20)).rejects.toMatchObject({
        name: 'SseError',
        cause: 'too_large',
      });
    });

    it('counts the bytes of the data of an event, not its characters', async () => {
      // Two characters of three bytes on each line: 6 bytes of data, and 20 in three lines
      // with the line feeds, but 27 in four (while the characters are 11).
      const line = 'data: €€\n';
      await expect(events(feed(`${line}${line}${line}\n`), 20)).resolves.toHaveLength(1);
      await expect(events(feed(`${line}${line}${line}${line}\n`), 20)).rejects.toBeInstanceOf(
        SseError,
      );
    });

    it('yields the events before the one that is over the bound', async () => {
      const seen: SseEvent[] = [];
      const reading = (async () => {
        for await (const next of parseSse(feed('data: ok\n\n', `data: ${'x'.repeat(50)}\n\n`), {
          maxEventBytes: 20,
        })) {
          seen.push(next);
        }
      })();
      await expect(reading).rejects.toBeInstanceOf(SseError);
      expect(seen).toEqual([event('ok')]);
    });

    it('refuses a line before its end arrives: it never buffers more than the bound', async () => {
      let pulled = 0;
      async function* endless(): AsyncGenerator<Buffer> {
        for (;;) {
          pulled += 1;
          yield Buffer.from('x'.repeat(60));
        }
      }
      await expect(events(endless(), 100)).rejects.toBeInstanceOf(SseError);
      expect(pulled).toBe(2);
    });

    it('does not count the bytes of many small events against one', async () => {
      const many = 'data: 0123456789\n\n'.repeat(100);
      expect(await events(feed(many), 20)).toHaveLength(100);
    });
  });

  describe('the ends of the reader and of its input', () => {
    it('passes on the failure of its input, after the events before it', async () => {
      async function* breaks(): AsyncGenerator<Buffer> {
        yield Buffer.from('data: a\n\n');
        throw new Error('the input broke');
      }
      const seen: SseEvent[] = [];
      const reading = (async () => {
        for await (const next of parseSse(breaks(), { maxEventBytes: 100 })) seen.push(next);
      })();
      await expect(reading).rejects.toThrow('the input broke');
      expect(seen).toEqual([event('a')]);
    });

    it('closes its input when the reader stops early, and when it is over the bound', async () => {
      let closed = 0;
      async function* input(text: string): AsyncGenerator<Buffer> {
        try {
          yield Buffer.from(text);
          yield Buffer.from('data: more\n\n');
        } finally {
          closed += 1;
        }
      }
      for await (const next of parseSse(input('data: a\n\n'), { maxEventBytes: 100 })) {
        expect(next).toEqual(event('a'));
        break;
      }
      expect(closed).toBe(1);
      await expect(events(input(`data: ${'x'.repeat(200)}\n\n`), 100)).rejects.toBeInstanceOf(
        SseError,
      );
      expect(closed).toBe(2);
    });
  });
});

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
    expect(await drain(stream)).toEqual([event('1', 'a'), event('2\n3'), event('[DONE]')]);
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
      expect(await drain(stream)).toEqual([event('x')]);
    }
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/v1/responses',
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/messages',
    ]);
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
          'The model does not accept max_tokens; set the output limit field to max_completion_tokens in the AI assistant settings',
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
    );
  };

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
        message: 'The model sent nothing for 5 s; raise the timeout in the AI assistant settings',
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
        message: 'The model sent nothing for 2 s; raise the timeout in the AI assistant settings',
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
