import { describe, expect, it } from 'vitest';
import { askWithRoom, MAX_REFUSED_ROOMS, outputLimitRefused, RefusedRooms } from './output-room';
import { LlmError, type ProviderConfig } from './types';

/** The words of the providers for a limit that is more than the model takes (each pinned as given). */
const KNOWN: [string, string][] = [
  [
    'Anthropic',
    'max_tokens: 20384 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022',
  ],
  [
    'OpenAI',
    'max_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.',
  ],
  [
    'vLLM and the servers that word it as OpenAI does',
    "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (4000 in the messages, 5000 in the completion). Please reduce the length of the messages or completion.",
  ],
  [
    // As the controller remembers it: Anthropic's older models, when what is sent and what is
    // asked for pass the context window together.
    'Anthropic, when the input and the limit pass the context window together',
    'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000, decrease input length or `max_tokens` and try again',
  ],
];

describe('outputLimitRefused: the words of a refusal of the output limit', () => {
  it.each(KNOWN)('knows what %s says', (_who, message) => {
    expect(outputLimitRefused(message)).toBe(true);
  });

  it.each(KNOWN)('does not mind the case: %s', (_who, message) => {
    expect(outputLimitRefused(message.toUpperCase())).toBe(true);
    expect(outputLimitRefused(message.toLowerCase())).toBe(true);
  });

  it.each([
    // The field of the other API, which is named, never the value.
    [
      'the other field of the OpenAI API',
      'max_completion_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.',
    ],
    [
      'the newer words of vLLM',
      "'max_tokens' or 'max_completion_tokens' is too large: 5000. This model's maximum context length is 8192 tokens and your request has 4500 input tokens (5000 > 8192 - 4500).",
    ],
    [
      'a request whose tools take room too',
      "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (7000 in the messages, 1000 in the functions, 1000 in the completion). Please reduce the length of the messages, functions, or completion.",
    ],
    [
      "OpenAI's other wording",
      "Invalid 'max_tokens': integer above maximum value. Expected a value <= 4096, but got 8000 instead.",
    ],
    [
      "Anthropic's context window wording without its backticks",
      'input length and max_tokens exceed context limit: 190000 + 20000 > 200000, decrease input length or max_tokens and try again',
    ],
    [
      "Anthropic's context window wording in quotes, with the verb and the article of another form",
      "Input length and 'max_tokens' exceeds the context limit: 190000 + 20000 > 200000.",
    ],
  ])('knows %s', (_what, message) => {
    expect(outputLimitRefused(message)).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['another refusal of max_tokens', 'max_tokens: must be at least 1'],
    [
      'the field refused, not the value',
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    ],
    [
      'a prompt that is too long alone',
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.",
    ],
    [
      'a prompt and its tools that are too long, with no completion in them',
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens (8000 in the messages, 1000 in the functions). Please reduce the length of the messages or functions.",
    ],
    ['a refused tool', 'tools.0.input_schema: JSON schema is invalid'],
    ['an unrelated limit', 'The request is too large: 40000000 bytes. The most is 32 MB.'],
    [
      'an integer above the maximum of another parameter',
      "Invalid 'n': integer above maximum value.",
    ],
    [
      "Anthropic's prompt that is too long alone",
      'prompt is too long: 210000 tokens > 200000 maximum',
    ],
    [
      'an input over the context limit on its own, with no max_tokens in it',
      'input length exceeds context limit: 210000 > 200000, decrease input length and try again',
    ],
  ])('does not take %s for one', (_what, message) => {
    expect(outputLimitRefused(message)).toBe(false);
  });
});

describe('RefusedRooms: what a process knows of the models that refuse the room', () => {
  it('keeps at most 1 000 pairs, and drops the oldest first', () => {
    expect(MAX_REFUSED_ROOMS).toBe(1_000);
    const rooms = new RefusedRooms();
    for (let i = 0; i < MAX_REFUSED_ROOMS + 1; i += 1) rooms.add(`pair ${i}`);
    expect(rooms.has('pair 0')).toBe(false);
    expect(rooms.has('pair 1')).toBe(true);
    expect(rooms.has(`pair ${MAX_REFUSED_ROOMS}`)).toBe(true);
    expect(rooms.size).toBe(MAX_REFUSED_ROOMS);
  });

  it('holds a pair once however often it is added, and an old pair added again is the newest', () => {
    const rooms = new RefusedRooms(3);
    for (const pair of ['a', 'b', 'c']) rooms.add(pair);
    rooms.add('a');
    expect(rooms.size).toBe(3);
    rooms.add('d');
    // `b` was the oldest after `a` was added again.
    expect([rooms.has('a'), rooms.has('b'), rooms.has('c'), rooms.has('d')]).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });
});

describe('askWithRoom: one call, asked again without the room that a model refuses', () => {
  let models = 0;
  /** A pair of its own for each test: what the process learns of one is kept for good. */
  const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
    kind: 'anthropic',
    baseUrl: 'https://llm.example',
    model: `model-${(models += 1)}`,
    auth: 'bearer',
    jsonMode: 'json_object',
    maxTokensField: 'max_tokens',
    temperature: null,
    workspaceId: null,
    timeoutSeconds: 5,
    ...over,
  });
  const refused = () => new LlmError('rejected', 'refused', 400, null, false, true);
  /** An attempt that is refused above `most` tokens, and records what it was asked for. */
  const attempts = (most: number, asked: number[] = []) => ({
    asked,
    attempt: (tokens: number) => {
      asked.push(tokens);
      return tokens > most ? Promise.reject(refused()) : Promise.resolve(`answer of ${tokens}`);
    },
  });
  const limits = { maxOutputTokens: 1_200, reasoningAllowance: 4_000 };

  it('asks for the answer and the room, and once for it when it is taken', async () => {
    const run = attempts(100_000);
    expect(await askWithRoom(config(), limits, run.attempt)).toBe('answer of 5200');
    expect(run.asked).toEqual([5_200]);
  });

  it('asks for the answer alone when there is no room to ask for', async () => {
    const run = attempts(100_000);
    expect(await askWithRoom(config(), { maxOutputTokens: 1_200 }, run.attempt)).toBe(
      'answer of 1200',
    );
    expect(await askWithRoom(config(), { ...limits, reasoningAllowance: 0 }, run.attempt)).toBe(
      'answer of 1200',
    );
    expect(run.asked).toEqual([1_200, 1_200]);
  });

  it('asks again without the room when the model refuses the limit, and the next call goes without it at once', async () => {
    const pair = config();
    const run = attempts(4_096);
    expect(await askWithRoom(pair, limits, run.attempt)).toBe('answer of 1200');
    expect(run.asked).toEqual([5_200, 1_200]);
    expect(await askWithRoom(pair, limits, run.attempt)).toBe('answer of 1200');
    expect(run.asked).toEqual([5_200, 1_200, 1_200]);
  });

  it('remembers a pair of a base URL and a model, and no other', async () => {
    const pair = config();
    await askWithRoom(pair, limits, attempts(4_096).attempt);
    for (const other of [
      config({ model: pair.model.concat('-b') }),
      config({ model: pair.model, baseUrl: 'https://other.example' }),
    ]) {
      const run = attempts(100_000);
      await askWithRoom(other, limits, run.attempt);
      expect(run.asked).toEqual([5_200]);
    }
  });

  it('takes a base URL with a trailing slash for the same address', async () => {
    const pair = config({ baseUrl: 'https://slash.example/v1' });
    await askWithRoom(pair, limits, attempts(4_096).attempt);
    const run = attempts(100_000);
    await askWithRoom({ ...pair, baseUrl: 'https://slash.example/v1//' }, limits, run.attempt);
    expect(run.asked).toEqual([1_200]);
  });

  it('lets the error of the retry stand, and learns nothing from a retry that fails', async () => {
    const pair = config();
    const first = attempts(0);
    // The model refuses the answer alone too, as a prompt that is too long does.
    await expect(askWithRoom(pair, limits, first.attempt)).rejects.toMatchObject({
      failure: 'rejected',
      refusedOutputLimit: true,
    });
    expect(first.asked).toEqual([5_200, 1_200]);
    // And a retry that fails otherwise: its own error, not the refusal.
    const calls: number[] = [];
    const other = new LlmError('refused_key', 'key', 401);
    await expect(
      askWithRoom(pair, limits, (tokens) => {
        calls.push(tokens);
        return tokens > 4_096 ? Promise.reject(refused()) : Promise.reject(other);
      }),
    ).rejects.toBe(other);
    // Nothing was remembered: the next call asks for the room again.
    const again = attempts(100_000);
    await askWithRoom(pair, limits, again.attempt);
    expect([calls, again.asked]).toEqual([[5_200, 1_200], [5_200]]);
  });

  it('asks again only for a refusal of the limit', async () => {
    const pair = config();
    const unrelated = [
      new LlmError('rejected', 'refused', 400),
      new LlmError('refused_key', 'key', 401),
      new LlmError('rate_limited', 'slow', 429),
      new Error('not a provider error'),
    ];
    for (const error of unrelated) {
      const asked: number[] = [];
      await expect(
        askWithRoom(pair, limits, (tokens) => {
          asked.push(tokens);
          return Promise.reject(error);
        }),
      ).rejects.toBe(error);
      expect(asked, String(error)).toEqual([5_200]);
    }
  });
});
