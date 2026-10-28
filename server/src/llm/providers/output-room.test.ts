import { describe, expect, it } from 'vitest';
import { askWithRoom, outputLimitRefusal } from './output-room';
import { LlmError, type ProviderConfig } from './types';

/**
 * The words of the providers for a limit that is more than the model takes (each pinned as given),
 * and whose limit it is: a cap of the model's own, or the context window that the prompt shares.
 */
const KNOWN: [string, string, 'cap' | 'context'][] = [
  [
    'Anthropic',
    'max_tokens: 20384 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022',
    'cap',
  ],
  [
    'OpenAI',
    'max_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.',
    'cap',
  ],
  [
    // The Responses API documents no message for it: the words its validator uses for a number
    // below the least ("Invalid 'max_output_tokens': integer below minimum value. Expected a value
    // >= 16, but got 1 instead.") with the ones that Chat Completions has for a number above its
    // maximum.
    'OpenAI, for max_output_tokens, the limit of its Responses API',
    "Invalid 'max_output_tokens': integer above maximum value. Expected a value <= 128000, but got 200000 instead.",
    'cap',
  ],
  [
    'vLLM and the servers that word it as OpenAI does',
    "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (4000 in the messages, 5000 in the completion). Please reduce the length of the messages or completion.",
    'context',
  ],
  [
    // As the controller remembers it: Anthropic's older models, when what is sent and what is
    // asked for pass the context window together.
    'Anthropic, when the input and the limit pass the context window together',
    'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000, decrease input length or `max_tokens` and try again',
    'context',
  ],
];

describe('outputLimitRefusal: the words of a refusal of the output limit, and whose limit it is', () => {
  it.each(KNOWN)('knows what %s says, and whose limit it is', (_who, message, whose) => {
    expect(outputLimitRefusal(message)).toBe(whose);
  });

  it.each(KNOWN)('does not mind the case: %s', (_who, message, whose) => {
    expect(outputLimitRefusal(message.toUpperCase())).toBe(whose);
    expect(outputLimitRefusal(message.toLowerCase())).toBe(whose);
  });

  it.each([
    // The field of the other API, which is named, never the value.
    [
      'the other field of the OpenAI API',
      'max_completion_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.',
      'cap',
    ],
    [
      'the words of Chat Completions for the field of the Responses API',
      'max_output_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.',
      'cap',
    ],
    [
      'the newer words of vLLM, for the field of the Responses API',
      "'max_output_tokens' is too large: 5000. This model's maximum context length is 8192 tokens and your request has 4500 input tokens (5000 > 8192 - 4500).",
      'context',
    ],
    [
      'the newer words of vLLM',
      "'max_tokens' or 'max_completion_tokens' is too large: 5000. This model's maximum context length is 8192 tokens and your request has 4500 input tokens (5000 > 8192 - 4500).",
      // It says "is too large" as OpenAI does, but it names the window the prompt shares.
      'context',
    ],
    [
      'a request whose tools take room too',
      "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (7000 in the messages, 1000 in the functions, 1000 in the completion). Please reduce the length of the messages, functions, or completion.",
      'context',
    ],
    [
      "OpenAI's other wording",
      "Invalid 'max_tokens': integer above maximum value. Expected a value <= 4096, but got 8000 instead.",
      'cap',
    ],
    [
      "Anthropic's context window wording without its backticks",
      'input length and max_tokens exceed context limit: 190000 + 20000 > 200000, decrease input length or max_tokens and try again',
      'context',
    ],
    [
      "Anthropic's context window wording in quotes, with the verb and the article of another form",
      "Input length and 'max_tokens' exceeds the context limit: 190000 + 20000 > 200000.",
      'context',
    ],
    [
      'the completion counted beside the messages, with the window not named',
      'You requested 9000 tokens (4000 in the messages, 5000 in the completion). Please reduce the length of the messages or completion.',
      'context',
    ],
  ])('knows %s, and whose limit it is', (_what, message, whose) => {
    expect(outputLimitRefusal(message)).toBe(whose);
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
    [
      'a limit below the least of the Responses API',
      "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.",
    ],
    [
      'an input over the context window of the Responses API',
      'Your input exceeds the context window of this model. Please adjust your input and try again.',
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
    expect(outputLimitRefusal(message)).toBeNull();
  });
});

describe('askWithRoom: one call, asked again without the room that a model refuses', () => {
  let models = 0;
  const nextModel = (): number => {
    models += 1;
    return models;
  };
  /** A pair of its own for each test: what the process learns of one is kept for good. */
  const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
    kind: 'anthropic',
    baseUrl: 'https://llm.example',
    model: `model-${nextModel()}`,
    auth: 'bearer',
    jsonMode: 'json_object',
    maxTokensField: 'max_tokens',
    temperature: null,
    api: 'chat_completions',
    workspaceId: null,
    timeoutSeconds: 5,
    ...over,
  });
  /** A refusal of a cap the model has of its own. */
  const refused = () =>
    new LlmError('rejected', 'refused', { status: 400, refusedOutputLimit: true });
  /** A refusal of the context window, which the prompt shares with the limit. */
  const refusedContext = () =>
    new LlmError('rejected', 'refused', {
      status: 400,
      refusedOutputLimit: true,
      refusedContext: true,
    });
  /** An attempt that is refused above `most` tokens, and records what it was asked for. */
  const attempts = (most: number, asked: number[] = [], refusal = refused) => ({
    asked,
    attempt: (tokens: number) => {
      asked.push(tokens);
      return tokens > most ? Promise.reject(refusal()) : Promise.resolve(`answer of ${tokens}`);
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

  it('asks again without the room when the context is refused, and does not remember the model: the next call asks for the room again', async () => {
    const pair = config();
    const run = attempts(4_096, [], refusedContext);
    expect(await askWithRoom(pair, limits, run.attempt)).toBe('answer of 1200');
    expect(await askWithRoom(pair, limits, run.attempt)).toBe('answer of 1200');
    // What the model takes depends on how long the prompt is: each call asks for the room, and is
    // asked again without it when the prompt leaves none.
    expect(run.asked).toEqual([5_200, 1_200, 5_200, 1_200]);
    // A prompt that leaves room is given it.
    const roomy = attempts(100_000);
    expect(await askWithRoom(pair, limits, roomy.attempt)).toBe('answer of 5200');
  });

  it('remembers a model only for a cap of its own, whatever the context refused before', async () => {
    const pair = config();
    const asked: number[] = [];
    let refusal = refusedContext;
    const attempt = (tokens: number) => {
      asked.push(tokens);
      return tokens > 4_096 ? Promise.reject(refusal()) : Promise.resolve('answer');
    };
    await askWithRoom(pair, limits, attempt);
    refusal = refused;
    await askWithRoom(pair, limits, attempt);
    await askWithRoom(pair, limits, attempt);
    // The context first, which is not remembered; then the cap, which is; and then the model goes
    // without the room at once.
    expect(asked).toEqual([5_200, 1_200, 5_200, 1_200, 1_200]);
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
    const other = new LlmError('refused_key', 'key', { status: 401 });
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

  it.each([
    ['a 400', 400],
    // As Hugging Face TGI answers a limit past its window.
    ['a 422', 422],
  ])(
    'asks again without the room after %s in words it does not know, and remembers the model as for a cap of its own when that is answered',
    async (_what, status) => {
      const pair = config();
      const unknown = () => new LlmError('rejected', 'refused', { status });
      const run = attempts(4_096, [], unknown);
      expect(await askWithRoom(pair, limits, run.attempt)).toBe('answer of 1200');
      expect(await askWithRoom(pair, limits, run.attempt)).toBe('answer of 1200');
      // The second call knew the model: it went without the room at once.
      expect(run.asked).toEqual([5_200, 1_200, 1_200]);
    },
  );

  it('keeps the error of a refusal it does not know when the retry fails the same way, and learns nothing', async () => {
    const pair = config();
    // As for a field the model does not take: its words name the field, and the hint is the first's.
    const hint = () =>
      new LlmError('rejected', 'The model does not accept max_tokens; set the output limit…', {
        status: 400,
      });
    const run = attempts(0, [], hint);
    await expect(askWithRoom(pair, limits, run.attempt)).rejects.toMatchObject({
      failure: 'rejected',
      status: 400,
      message: 'The model does not accept max_tokens; set the output limit…',
      refusedOutputLimit: false,
    });
    expect(run.asked).toEqual([5_200, 1_200]);
    const again = attempts(100_000);
    await askWithRoom(pair, limits, again.attempt);
    expect(again.asked).toEqual([5_200]);
  });

  it('does not ask again after a refusal that is something else, nor after a failure that is no refusal', async () => {
    const pair = config();
    const otherwise = [
      new LlmError('workspace_required', 'workspace', { status: 400 }),
      new LlmError('rejected', 'tools', { status: 400, refusedTools: true }),
      new LlmError('rejected', 'tools', { status: 422, refusedTools: true }),
      new LlmError('rejected', 'responses', {
        status: 400,
        refusedTools: true,
        needsResponses: true,
      }),
      new LlmError('rejected', 'stream', { status: 400, refusedStream: true }),
      new LlmError('refused_key', 'key', { status: 401 }),
      new LlmError('refused_key', 'forbidden', { status: 403 }),
      new LlmError('rejected', 'missing', { status: 404 }),
      new LlmError('rejected', 'other', { status: 409 }),
      new LlmError('rate_limited', 'slow', { status: 429 }),
      new LlmError('unavailable', 'down', { status: 503 }),
      new LlmError('timeout', 'late'),
      new LlmError('bad_answer', 'garbled', { status: 200 }),
      new Error('not a provider error'),
    ];
    for (const error of otherwise) {
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
