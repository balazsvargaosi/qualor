import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicAnswer,
  createFakeLlm,
  llmShape,
  openAiAnswer,
  type FakeLlm,
  type RecordedLlmRequest,
} from '../../../test/fake-llm';
import { parseInternalHosts } from '../../scm/url';
import {
  callProvider,
  converse,
  LlmCallAborted,
  LlmError,
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

  const configFor = (kind: (typeof KINDS)[number]): ProviderConfig =>
    kind === 'anthropic' ? anthropic : openai;

  describe('a model that refuses the room to think', () => {
    // A call carries the room apart from the answer's tokens, and the adapter asks for both. A model
    // that refuses a limit that large is asked again, in the same call, for the answer's tokens
    // alone, and the process does not ask it for the room again when a cap of its own is what it
    // refused.
    const ASKED = { maxOutputTokens: 1_200, reasoningAllowance: 4_000 };
    const call = { system: 'S', user: 'U', ...ASKED };
    const conversation: LlmConversation = { ...start, ...ASKED };
    let models = 0;
    /** A model of its own for each test: what a process learns of one it keeps. */
    const own = (config: ProviderConfig): ProviderConfig => ({
      ...config,
      model: `refusing-model-${(models += 1)}`,
    });
    /** The limit a request asked for, in the field of its wire. */
    const limitOf = (request: RecordedLlmRequest): unknown => {
      const json = request.json as { max_tokens?: unknown; max_completion_tokens?: unknown };
      return json.max_tokens ?? json.max_completion_tokens;
    };
    const limits = () => fake.requests.map(limitOf);
    /** What a request says besides its limit. */
    const withoutLimit = (request: RecordedLlmRequest) =>
      Object.fromEntries(
        Object.entries(request.json as Record<string, unknown>).filter(
          ([field]) => field !== 'max_tokens' && field !== 'max_completion_tokens',
        ),
      );
    const answer = (kind: (typeof KINDS)[number]) => ({
      status: 200,
      body: kind === 'anthropic' ? anthropicAnswer('{"ok":true}') : openAiAnswer('{"ok":true}'),
    });
    const GENERIC = 'The provider refused the request (HTTP 400); check the base URL and model';
    /**
     * What each provider says of a limit that is more than the model takes, and whether a process
     * remembers the model for it: only a cap of the model's own is the same for every prompt. A
     * refusal of the context window, which the prompt and the limit share, is not: what the model
     * takes depends on how long the prompt is.
     */
    const REFUSALS: [string, (typeof KINDS)[number], unknown, boolean][] = [
      [
        'Anthropic (the cap of the model)',
        'anthropic',
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'max_tokens: 20384 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022',
          },
        },
        true,
      ],
      [
        'OpenAI (the cap of the model)',
        'openai',
        {
          error: {
            message:
              'max_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.',
            type: 'invalid_request_error',
            param: 'max_tokens',
            code: null,
          },
        },
        true,
      ],
      [
        'vLLM (the context window)',
        'openai',
        {
          object: 'error',
          message:
            "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (4000 in the messages, 5000 in the completion). Please reduce the length of the messages or completion.",
          type: 'BadRequestError',
          param: null,
          code: 400,
        },
        false,
      ],
      [
        'vLLM, in its newer words (the context window)',
        'openai',
        {
          object: 'error',
          message:
            "'max_tokens' or 'max_completion_tokens' is too large: 5200. This model's maximum context length is 8192 tokens and your request has 4500 input tokens (5200 > 8192 - 4500).",
          type: 'BadRequestError',
          param: 'max_tokens',
          code: 400,
        },
        false,
      ],
      [
        'Anthropic (the context window)',
        'anthropic',
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000, decrease input length or `max_tokens` and try again',
          },
        },
        false,
      ],
    ];
    /** The replies for the next call of a model that was refused, as a process remembers it or not. */
    const nextCall = (kind: (typeof KINDS)[number], body: unknown, remembered: boolean) =>
      remembered ? [answer(kind)] : [{ status: 400, body }, answer(kind)];
    /** The limits of the two calls of such a model: the second asks for the room only if it must. */
    const afterTwoCalls = (remembered: boolean) =>
      remembered ? [5_200, 1_200, 1_200] : [5_200, 1_200, 5_200, 1_200];

    it.each(REFUSALS)(
      '%s: a call is asked again, once, for the answer alone, and the model is remembered only for a cap of its own',
      async (_who, kind, body, remembered) => {
        const config = own(configFor(kind));
        fake.enqueue({ status: 400, body }, answer(kind));
        expect((await callProvider(config, fake.apiKey, call, http)).finishReason).toBe('stop');
        expect(limits()).toEqual([5_200, 1_200]);
        // Else the same request.
        expect(withoutLimit(fake.requests[1]!)).toEqual(withoutLimit(fake.requests[0]!));
        // The next call of that model asks for the answer alone at once for a cap of its own, and
        // for the room again, and the same two asks, for a refusal of the context.
        fake.enqueue(...nextCall(kind, body, remembered));
        await callProvider(config, fake.apiKey, call, http);
        expect(limits()).toEqual(afterTwoCalls(remembered));
      },
    );

    it.each(REFUSALS)(
      '%s: a conversation too, with its tools, and its other turns go without the room only for a cap of its own',
      async (_who, kind, body, remembered) => {
        const config = own(configFor(kind));
        fake.enqueue({ status: 400, body }, answer(kind));
        const turn = await converse(config, fake.apiKey, conversation, http);
        expect(turn.finishReason).toBe('stop');
        expect(limits()).toEqual([5_200, 1_200]);
        expect(withoutLimit(fake.requests[1]!)).toEqual(withoutLimit(fake.requests[0]!));
        fake.enqueue(...nextCall(kind, body, remembered));
        await converse(config, fake.apiKey, conversation, http);
        expect(limits()).toEqual(afterTwoCalls(remembered));
      },
    );

    it('learns a cap of the model’s own after refusals of the context, and only from it', async () => {
      const config = own(anthropic);
      const cap = REFUSALS[0]![2];
      const context = REFUSALS[4]![2];
      fake.enqueue(
        { status: 400, body: context },
        answer('anthropic'),
        { status: 400, body: cap },
        answer('anthropic'),
        answer('anthropic'),
      );
      for (let i = 0; i < 3; i += 1) await callProvider(config, fake.apiKey, call, http);
      // The first call was refused for the context and the second for the cap; the third knows it.
      expect(limits()).toEqual([5_200, 1_200, 5_200, 1_200, 1_200]);
    });

    it('does not pass on what it learned to another model', async () => {
      const learned = own(anthropic);
      fake.enqueue({ status: 400, body: REFUSALS[0]![2] }, answer('anthropic'));
      await callProvider(learned, fake.apiKey, call, http);
      fake.enqueue(answer('anthropic'));
      await callProvider(own(anthropic), fake.apiKey, call, http);
      expect(limits()).toEqual([5_200, 1_200, 5_200]);
    });

    it('asks in the field of the settings, again', async () => {
      const config = own({ ...openai, maxTokensField: 'max_completion_tokens' });
      fake.enqueue({ status: 400, body: REFUSALS[1]![2] }, answer('openai'));
      await callProvider(config, fake.apiKey, call, http);
      expect(
        fake.requests.map((r) => (r.json as Record<string, unknown>).max_completion_tokens),
      ).toEqual([5_200, 1_200]);
      for (const request of fake.requests) expect(request.json).not.toHaveProperty('max_tokens');
    });

    it.each(KINDS)(
      '%s: asks again once, without the room, after a 400 it does not know, which keeps its own error when the retry is refused the same way',
      async (kind) => {
        const unrelated = [
          'max_tokens: must be at least 1',
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.",
          'tools.0.input_schema: JSON schema is invalid',
        ];
        for (const message of unrelated) {
          fake.requests.length = 0;
          const refusal = {
            status: 400,
            body:
              kind === 'anthropic'
                ? { type: 'error', error: { type: 'invalid_request_error', message } }
                : { error: { message, type: 'invalid_request_error', param: null, code: null } },
          };
          fake.enqueue(refusal, refusal);
          const err = await callProvider(own(configFor(kind)), fake.apiKey, call, http).catch(
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
      },
    );

    it('asks again after a 422 too, and the words it knows keep their class there: a cap of the model’s own is remembered', async () => {
      const config = own(anthropic);
      fake.enqueue(
        { status: 422, body: REFUSALS[0]![2] },
        answer('anthropic'),
        answer('anthropic'),
      );
      await callProvider(config, fake.apiKey, call, http);
      await callProvider(config, fake.apiKey, call, http);
      expect(limits()).toEqual([5_200, 1_200, 1_200]);
    });

    /**
     * What other servers say of a limit that is more than they take, each in its own words and with
     * its own status, from their sources or as their users quote them: none is a wording the
     * classifier knows, so each is asked again without the room as a refusal it does not know, and
     * the model is remembered as for a cap of its own once that is answered.
     */
    const VENDORS: [string, number, unknown][] = [
      [
        // Its router: `MaxTotalTokens` (router/src/validation.rs), "Input validation error: …"
        // (router/src/infer/mod.rs), and HTTP 422 for a validation error (router/src/server.rs).
        'Hugging Face TGI, which answers 422',
        422,
        {
          error:
            'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 8192. Given: 3000 `inputs` tokens and 5200 `max_new_tokens`',
          error_type: 'validation',
        },
      ],
      [
        // As khoj-ai/khoj#1236 quotes it for `max_completion_tokens`, here for the field asked in.
        'Groq, whose words name the field',
        400,
        {
          error: {
            message:
              '`max_tokens` must be less than or equal to `4096`, the maximum value for `max_tokens` is less than the `context_window` for this model',
            type: 'invalid_request_error',
            param: 'max_tokens',
          },
        },
      ],
      [
        // python/sglang/srt/managers/tokenizer_manager.py, answered as a 400 (serving_base.py).
        'SGLang',
        400,
        {
          object: 'error',
          message:
            "Requested token count exceeds the model's maximum context length of 8192 tokens. You requested a total of 9200 tokens: 4000 tokens from the input messages and 5200 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.",
          type: 'BadRequest',
          param: null,
          code: 400,
        },
      ],
      [
        // As deepseek-ai/DeepSeek-V3#69 quotes it.
        'DeepSeek',
        400,
        {
          error: {
            message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 4096]',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request_error',
          },
        },
      ],
    ];

    it.each(VENDORS)(
      '%s: a call is asked again, once, for the answer alone, and the model is remembered',
      async (_who, status, body) => {
        const config = own(openai);
        fake.enqueue({ status, body }, answer('openai'), answer('openai'));
        expect((await callProvider(config, fake.apiKey, call, http)).finishReason).toBe('stop');
        expect(limits()).toEqual([5_200, 1_200]);
        expect(withoutLimit(fake.requests[1]!)).toEqual(withoutLimit(fake.requests[0]!));
        await callProvider(config, fake.apiKey, call, http);
        expect(limits()).toEqual([5_200, 1_200, 1_200]);
      },
    );

    it.each(VENDORS)(
      '%s: a conversation too, with its tools, and its other turns go without the room',
      async (_who, status, body) => {
        const config = own(openai);
        fake.enqueue({ status, body }, answer('openai'), answer('openai'));
        expect((await converse(config, fake.apiKey, conversation, http)).finishReason).toBe('stop');
        await converse(config, fake.apiKey, conversation, http);
        expect(limits()).toEqual([5_200, 1_200, 1_200]);
      },
    );

    it('Groq: the hint of the field comes only when the answer alone is refused the same way', async () => {
      const groq = { status: 400, body: VENDORS[1]![2] };
      fake.enqueue(groq, groq);
      const err = await callProvider(own(openai), fake.apiKey, call, http).catch((e: unknown) => e);
      expect(err).toMatchObject({
        failure: 'rejected',
        status: 400,
        message:
          'The model does not accept max_tokens; set the output limit parameter to max_completion_tokens in the AI provider settings',
      });
      expect(limits()).toEqual([5_200, 1_200]);
    });

    it('does not ask again after a refusal that is something else: the workspace, the tools, the Responses API', async () => {
      const responsesWords =
        "Function tools with reasoning_effort are not supported for m-1 in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
      const cases: [string, ProviderConfig, unknown, Record<string, unknown>][] = [
        [
          'a key that is not scoped to a workspace',
          own(anthropic),
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                'Fake error text: this API key is not scoped to a workspace; name one with the anthropic-workspace-id header.',
            },
          },
          { failure: 'workspace_required', status: 400 },
        ],
        [
          'a server without tools',
          own(openai),
          {
            error: {
              message: 'registry.ollama.ai/library/gemma:2b does not support tools',
              type: 'invalid_request_error',
              param: null,
              code: null,
            },
          },
          { failure: 'rejected', status: 400, refusedTools: true, needsResponses: false },
        ],
        [
          'a model that takes its tools only through the Responses API',
          own(openai),
          { error: { message: responsesWords, type: 'invalid_request_error', param: null } },
          { failure: 'rejected', status: 400, refusedTools: true, needsResponses: true },
        ],
      ];
      for (const [what, config, body, expected] of cases) {
        fake.requests.length = 0;
        fake.enqueue({ status: 400, body });
        const err = await converse(config, fake.apiKey, conversation, http).catch(
          (e: unknown) => e,
        );
        expect(err, what).toMatchObject(expected);
        expect(limits(), what).toEqual([5_200]);
      }
    });

    it.each(KINDS)(
      '%s: does not ask again after a refusal of another status, or a failure',
      async (kind) => {
        for (const status of [401, 403, 404, 409, 429, 500, 503]) {
          fake.requests.length = 0;
          fake.enqueue({ status, body: llmShape('openai-error') });
          await callProvider(own(configFor(kind)), fake.apiKey, call, http).catch(() => undefined);
          expect(limits(), String(status)).toEqual([5_200]);
        }
      },
    );

    it('lets the error of the second call stand, and learns nothing from it: a prompt that is too long alone', async () => {
      const config = own(openai);
      const tooLong = (completion: number) => ({
        object: 'error',
        message: `This model's maximum context length is 8192 tokens. However, you requested ${8_500 + completion} tokens (8500 in the messages, ${completion} in the completion). Please reduce the length of the messages or completion.`,
        type: 'BadRequestError',
        param: null,
        code: 400,
      });
      fake.enqueue(
        { status: 400, body: tooLong(5_200) },
        { status: 400, body: tooLong(1_200) },
        { status: 400, body: tooLong(5_200) },
        { status: 400, body: tooLong(1_200) },
      );
      for (let i = 0; i < 2; i += 1) {
        const err = await callProvider(config, fake.apiKey, call, http).catch((e: unknown) => e);
        expect(err).toMatchObject({ failure: 'rejected', status: 400, message: GENERIC });
      }
      // The second call asked for the room again, as the first had: nothing was remembered.
      expect(limits()).toEqual([5_200, 1_200, 5_200, 1_200]);
    });

    it('lets the error of the second call stand when it is another one', async () => {
      fake.enqueue(
        { status: 400, body: REFUSALS[0]![2] },
        { status: 401, body: llmShape('openai-error') },
      );
      const err = await callProvider(own(anthropic), fake.apiKey, call, http).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'refused_key', status: 401 });
      expect(limits()).toEqual([5_200, 1_200]);
    });

    it('has no room to drop when it asks for none: the refusal stands, and is not mistaken for a refusal of the field', async () => {
      fake.enqueue({ status: 400, body: REFUSALS[1]![2] });
      const refused = await callProvider(
        own(openai),
        fake.apiKey,
        { system: 'S', user: 'U', maxOutputTokens: 20_000 },
        http,
      ).catch((e: unknown) => e);
      // The body names the parameter max_tokens, and the field is not what it refuses.
      expect(refused).toMatchObject({
        failure: 'rejected',
        status: 400,
        refusedOutputLimit: true,
        message: GENERIC,
      });
      expect(limits()).toEqual([20_000]);
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

  it.each(KINDS)(
    '%s: reads the body of a refused request once, whatever it is checked for',
    async (kind) => {
      // A body that none of the checks takes for its own, so that each of them is made on it: the
      // key not scoped to a workspace (Anthropic), the output limit and its field, and the tools.
      const text = JSON.stringify({
        error: { message: 'Refused for a reason of its own', param: 'other', code: null },
      });
      const parse = vi.spyOn(JSON, 'parse');
      try {
        for (const conversation of [start, { ...start, tools: [] }]) {
          fake.enqueue({ status: 400, body: text });
          await converse(configFor(kind), fake.apiKey, conversation, http).catch(() => undefined);
        }
        expect(parse.mock.calls.filter(([arg]) => arg === text)).toHaveLength(2);
      } finally {
        parse.mockRestore();
      }
    },
  );

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

    it("an error in Gemini's array form gives its message", async () => {
      // Gemini's OpenAI endpoint wraps its error in a list: `[{"error":{"message":"x"}}]`.
      const err = await refusal([
        {
          error: {
            code: 400,
            message: 'This model does not support tools',
            status: 'INVALID_ARGUMENT',
          },
        },
      ]);
      expect(err).toMatchObject({ failure: 'rejected', status: 400, refusedTools: true });
    });

    it("a 'model my-tool-model is not available' refusal is not a refusal of tools", async () => {
      // The model's own id names `tool`, and the message says it is not available.
      fake.enqueue({ status: 404, body: errorBody('model my-tool-model is not available') });
      const err = await converse(
        { ...configFor(kind), model: 'my-tool-model' },
        fake.apiKey,
        start,
        http,
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ failure: 'rejected', status: 404, refusedTools: false });
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
