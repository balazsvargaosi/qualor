import type { FinishReason } from '@qualor/shared';
import { z } from 'zod';
import { NOT_UNDERSTOOD, postJson } from './http';
import { askWithRoom } from './output-room';
import type { SseEvent } from './sse';
import {
  answerAsker,
  cutShort,
  errorInStream,
  eventOf,
  notUnderstood,
  serverFailed,
  withinAnswerCap,
  type StreamWire,
} from './streamed';
import {
  LlmError,
  tokenCount,
  type LlmAnswer,
  type LlmCall,
  type LlmConversation,
  type LlmMessage,
  type LlmToolCall,
  type LlmTurn,
  type LlmUsage,
  type ProviderConfig,
  type ProviderHttpOptions,
} from './types';

// The one answer schema of both calls. A tool call stays `unknown` here, so the single-shot call
// reads (and later refuses) an answer with calls whatever they look like; `converse` checks them.
const answerSchema = z.looseObject({
  model: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(z.unknown()).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  // Read through `tokenCount`: an odd count is unknown, never a reason to refuse the answer.
  usage: z
    .looseObject({
      prompt_tokens: z.unknown(),
      completion_tokens: z.unknown(),
      prompt_tokens_details: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
});

/**
 * What a call used, as Chat Completions counts it (and the Responses API, read into this shape):
 * `prompt_tokens` is every prompt token, the cached ones among them, and the cached part is
 * `prompt_tokens_details.cached_tokens` (R49: OpenAI caches a prefix it has seen by itself, and
 * bills no write). A cached count that is not given, or that is more than the prompt, is left out.
 */
function usageOf(usage: z.infer<typeof answerSchema>['usage']): LlmUsage {
  const inputTokens = tokenCount(usage?.prompt_tokens);
  const details = usage?.prompt_tokens_details;
  const read =
    typeof details === 'object' && details !== null
      ? tokenCount((details as { cached_tokens?: unknown }).cached_tokens)
      : null;
  return {
    inputTokens,
    outputTokens: tokenCount(usage?.completion_tokens),
    ...(read === null || inputTokens === null || read > inputTokens
      ? {}
      : { cacheReadTokens: read }),
  };
}

/** R5: a call the model made; without an id or a function name it cannot be answered. */
const toolCallSchema = z.looseObject({
  id: z.string().min(1),
  function: z.looseObject({
    name: z.string().min(1),
    arguments: z.unknown().optional(),
  }),
});

function finish(reason: string | null | undefined): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'refusal';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool';
  return 'other';
}

/** `Authorization: Bearer` or (Azure) `api-key`; none without a key. */
export function authHeaders(config: ProviderConfig, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey !== null) {
    if (config.auth === 'api-key') headers['api-key'] = apiKey;
    else headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Reads the first choice of a chat completion: the answer, and the provider's own `tool_calls`,
 * which only a conversation reads further. The Responses wire puts its answer in this shape too
 * (`openai-responses.ts`), so that both wires read it, and its finish reason, the same way.
 */
export function readChoice(raw: unknown): { answer: LlmAnswer; toolCalls: readonly unknown[] } {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  const [choice] = parsed.data.choices;
  if (!choice) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  const toolCalls = choice.message.tool_calls ?? [];
  const calls = toolCalls.length > 0;
  const refusal = typeof choice.message.refusal === 'string' && choice.message.refusal !== '';
  const text = choice.message.content;
  if (!calls && !refusal && typeof text !== 'string') {
    throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  }
  return {
    answer: {
      text: text ?? '',
      finishReason: calls ? 'tool' : refusal ? 'refusal' : finish(choice.finish_reason),
      usage: usageOf(parsed.data.usage),
      model: parsed.data.model ?? null,
    },
    toolCalls,
  };
}

/** A chunk of a streamed chat completion, as far as `assembleChat` reads it. */
const chunkSchema = z.looseObject({
  model: z.string().nullable().optional(),
  choices: z
    .array(
      z.looseObject({
        index: z.number().nullable().optional(),
        delta: z
          .looseObject({
            content: z.string().nullable().optional(),
            refusal: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.looseObject({
                  // What tells the calls of a turn apart: a delta without it is not understood,
                  // never taken for a part of the first call.
                  index: z.number().int().min(0),
                  id: z.string().nullable().optional(),
                  type: z.string().nullable().optional(),
                  function: z
                    .looseObject({
                      name: z.string().nullable().optional(),
                      arguments: z.string().nullable().optional(),
                    })
                    .nullable()
                    .optional(),
                }),
              )
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  usage: z.unknown().optional(),
});

/** A call as the deltas of its `index` make it. */
interface CallParts {
  id?: string;
  type?: string;
  name?: string;
  arguments?: string;
}

/** A call, as the `tool_calls` of a completion that is not streamed have it. */
function callOf(parts: CallParts): unknown {
  return {
    ...(parts.id === undefined ? {} : { id: parts.id }),
    ...(parts.type === undefined ? {} : { type: parts.type }),
    function: {
      ...(parts.name === undefined ? {} : { name: parts.name }),
      ...(parts.arguments === undefined ? {} : { arguments: parts.arguments }),
    },
  };
}

/**
 * Puts the chunks of a streamed chat completion together into the completion that is not streamed,
 * for `readChoice` to read, as OpenAI streams it:
 * - the content and the refusal of the first choice are its deltas, joined;
 * - a call is the deltas of its `index`, merged: its id, its type and its name from the first delta
 *   that has each, its arguments joined; the calls come in the order of their index, whatever order
 *   their deltas came in;
 * - the finish reason is the last the choice gives, and the model the last a chunk names;
 * - the usage is the chunk's that has one (`stream_options.include_usage` sends it last, in a chunk
 *   of no choices), the last when there are more.
 * A chunk that carries an `error`, or an `error` event, is the provider's error (`serverFailed`). The
 * stream ends at `[DONE]`; one that ends before it is unavailable.
 */
async function assembleChat(events: AsyncIterable<SseEvent>): Promise<unknown> {
  let model: string | undefined;
  let content: string | null = null;
  let refusal: string | null = null;
  let finishReason: string | null = null;
  let usage: unknown;
  const calls = new Map<number, CallParts>();
  let done = false;
  for await (const event of events) {
    if (event.data.trim() === '[DONE]') {
      done = true;
      break;
    }
    const { data } = eventOf(event);
    const error = event.event === 'error' ? (data?.error ?? data) : data?.error;
    if (event.event === 'error' || (error !== undefined && error !== null)) {
      throw errorInStream(serverFailed(error));
    }
    const parsed = chunkSchema.safeParse(data);
    if (!parsed.success) throw notUnderstood();
    const chunk = parsed.data;
    if (typeof chunk.model === 'string' && chunk.model !== '') model = chunk.model;
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue;
      const delta = choice.delta;
      if (typeof delta?.content === 'string') content = (content ?? '') + delta.content;
      if (typeof delta?.refusal === 'string') refusal = (refusal ?? '') + delta.refusal;
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? {};
        calls.set(part.index, call);
        if (call.id === undefined && part.id) call.id = part.id;
        if (call.type === undefined && part.type) call.type = part.type;
        if (call.name === undefined && part.function?.name) call.name = part.function.name;
        const piece = part.function?.arguments;
        if (typeof piece === 'string') call.arguments = (call.arguments ?? '') + piece;
      }
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    }
  }
  if (!done) throw cutShort();
  const message = {
    content,
    refusal,
    ...(calls.size > 0
      ? {
          tool_calls: [...calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, parts]) => callOf(parts)),
        }
      : {}),
  };
  withinAnswerCap(message);
  return { model, choices: [{ message, finish_reason: finishReason }], usage };
}

/** How a conversation's call streams on Chat Completions: the usage asked for, in a last chunk. */
const CHAT_STREAM: StreamWire = {
  fields: { stream: true, stream_options: { include_usage: true } },
  assemble: assembleChat,
};

/** POST <baseUrl>/chat/completions and read the first choice (`readChoice`). */
async function chat(
  config: ProviderConfig,
  apiKey: string | null,
  body: Record<string, unknown>,
  http: ProviderHttpOptions,
): Promise<{ answer: LlmAnswer; toolCalls: readonly unknown[] }> {
  return readChoice(
    await postJson(
      config,
      '/chat/completions',
      authHeaders(config, apiKey),
      body,
      http,
      config.maxTokensField,
    ),
  );
}

/**
 * llm.md §2.2: POST <baseUrl>/chat/completions, the key as `Authorization: Bearer` or (Azure,
 * `api-key`, none without a key. No streaming, tools or vendor metadata fields. The output limit
 * (in the field of the settings) is the answer's tokens and the reasoning allowance together, and
 * the answer's alone from a model that refuses that much (`askWithRoom`).
 */
export async function openAiChat(
  config: ProviderConfig,
  apiKey: string | null,
  call: LlmCall,
  http: ProviderHttpOptions,
): Promise<LlmAnswer> {
  return await askWithRoom(config, call, async (maxTokens) => {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
      [config.maxTokensField]: maxTokens,
    };
    if (config.jsonMode === 'json_object') body.response_format = { type: 'json_object' };
    if (config.temperature !== null) body.temperature = config.temperature;
    return (await chat(config, apiKey, body, http)).answer;
  });
}

/** A conversation message as OpenAI's chat completions take it (R5). */
function wireMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.text };
    case 'tool':
      return { role: 'tool', tool_call_id: message.callId, content: message.text };
    case 'assistant': {
      const wire: Record<string, unknown> = {
        role: 'assistant',
        content: message.text === '' ? null : message.text,
      };
      if (message.toolCalls.length > 0) {
        wire.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          // `arguments` is JSON text on the wire; a call that had none is sent with `{}`.
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      return wire;
    }
  }
}

/**
 * A call's `function.arguments`: JSON text, read as JSON, and kept as the model's raw text when it
 * is not JSON. Some compatible servers send the object itself, which is kept; none at all is `{}`.
 */
function callArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** A call of the first choice (`readChoice`) as a conversation takes it; one with no id or name is refused. */
export function toolCall(raw: unknown): LlmToolCall {
  const parsed = toolCallSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  return {
    id: parsed.data.id,
    name: parsed.data.function.name,
    arguments: callArguments(parsed.data.function.arguments),
  };
}

/**
 * R5: POST <baseUrl>/chat/completions with the whole conversation: the system message first, then
 * the messages, and the tools as `tools` with `tool_choice: "auto"` (sent only when there are
 * tools). No `response_format` while tools are sent (the R5 ruling): the caller asks for its JSON
 * in the prompt. A conversation without tools keeps the JSON mode of the settings, as `openAiChat`
 * does. The request, the limits and the failures are those of `openAiChat`, but that the answer is
 * streamed when `http.stream` says so (`stream`, and `stream_options` for the usage), and put
 * together into the completion it would have been (`assembleChat`).
 */
export async function openAiConverse(
  config: ProviderConfig,
  apiKey: string | null,
  conversation: LlmConversation,
  http: ProviderHttpOptions,
): Promise<LlmTurn> {
  const messages = [
    { role: 'system', content: conversation.system },
    ...conversation.messages.map(wireMessage),
  ];
  const tools = conversation.tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const ask = answerAsker(config, http, CHAT_STREAM);
  return await askWithRoom(config, conversation, async (maxTokens) => {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      [config.maxTokensField]: maxTokens,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    } else if (config.jsonMode === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (config.temperature !== null) body.temperature = config.temperature;
    const { answer, toolCalls } = readChoice(
      await ask({
        path: '/chat/completions',
        headers: authHeaders(config, apiKey),
        body,
        outputLimitField: config.maxTokensField,
      }),
    );
    return { ...answer, toolCalls: toolCalls.map(toolCall) };
  });
}
