import { z } from 'zod';
import { NOT_UNDERSTOOD, postJson } from './http';
import { authHeaders, readChoice, toolCall } from './openai';
import { askWithRoom } from './output-room';
import { replayOf } from './replay';
import type { SseEvent } from './sse';
import {
  answerAsker,
  cutShort,
  errorInStream,
  eventOf,
  NOT_COMPLETED,
  serverFailed,
  withinAnswerCap,
  type StreamWire,
} from './streamed';
import {
  LlmError,
  type LlmAnswer,
  type LlmCall,
  type LlmConversation,
  type LlmMessage,
  type LlmTurn,
  type ProviderConfig,
  type ProviderHttpOptions,
} from './types';

/*
 * The Responses API (`POST <baseUrl>/responses`), the second wire of the OpenAI provider. The newest
 * OpenAI models take function tools together with reasoning only through it, and Chat Completions
 * stays the wire of the OpenAI-compatible servers. It is used statelessly: every request carries the
 * whole conversation (`store: false`), nothing of an earlier response is referred to, and the
 * reasoning the model did comes back encrypted (`include: reasoning.encrypted_content`) to go back
 * as it came, beside the calls it led to. What an answer holds is read into the shape of a chat
 * completion's first choice and then by the code of the Chat Completions wire (`readChoice`), so
 * that a turn of either wire is read the same way: its text, its calls, its finish reason, its usage.
 * JSON mode has a condition of its own here: see `userItem`. A conversation's answer is streamed
 * when the call's options say so (`assembleResponse`).
 */

// What an answer is read from. Everything else in it is the provider's, and an item of its output
// is read only as far as its text and its calls: the items themselves go back as they came.
const responseSchema = z.looseObject({
  status: z.string().nullable().optional(),
  model: z.string().optional(),
  error: z.unknown().optional(),
  incomplete_details: z
    .looseObject({ reason: z.string().nullable().optional() })
    .nullable()
    .optional()
    .catch(undefined),
  output: z.unknown().optional(),
  // Read through `tokenCount`: an odd count is unknown, never a reason to refuse the answer.
  usage: z
    .looseObject({
      input_tokens: z.unknown(),
      output_tokens: z.unknown(),
      input_tokens_details: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
});

const itemSchema = z.looseObject({ type: z.string() });
const messageSchema = z.looseObject({
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      refusal: z.string().optional(),
    }),
  ),
});
const callItemSchema = z.looseObject({
  call_id: z.unknown().optional(),
  name: z.unknown().optional(),
  arguments: z.unknown().optional(),
});

/** What the answer holds, read: as Chat Completions reads its choice, and the items as they came. */
interface Read {
  answer: LlmAnswer;
  /** The calls, as the `tool_calls` of a chat completion have them: `readChoice`'s own. */
  toolCalls: readonly unknown[];
  /** The `output` as the provider sent it; null for a refusal, which has no turn to send back. */
  output: readonly unknown[] | null;
  /** The `function_call` items among them. */
  calls: readonly unknown[];
}

/** The response as parsed; a failed one, or one that carries an error, is the provider's failure. */
function completedResponse(raw: unknown): z.infer<typeof responseSchema> {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  const response = parsed.data;
  if (response.status === 'failed' || (response.error !== undefined && response.error !== null)) {
    throw new LlmError('unavailable', NOT_COMPLETED);
  }
  return response;
}

/** Whether the response is incomplete at `max_output_tokens`. */
function isCutOff(response: z.infer<typeof responseSchema>): boolean {
  return (
    response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
  );
}

/** Adds the text and the refusal parts of a message to their lists. */
function sortParts(
  content: readonly { type: string; text?: string; refusal?: string }[],
  texts: string[],
  refusals: string[],
): void {
  for (const part of content) {
    if (part.type === 'output_text') texts.push(part.text ?? '');
    else if (part.type === 'refusal') refusals.push(part.refusal ?? '');
  }
}

/** The text, refusal and call items of the `output`; a malformed item is not understood. */
function sortItems(output: readonly unknown[]): {
  texts: string[];
  refusals: string[];
  calls: unknown[];
} {
  const texts: string[] = [];
  const refusals: string[] = [];
  const calls: unknown[] = [];
  for (const item of output) {
    const typed = itemSchema.safeParse(item);
    if (!typed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
    if (typed.data.type === 'message') {
      const message = messageSchema.safeParse(item);
      if (!message.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
      sortParts(message.data.content, texts, refusals);
    } else if (typed.data.type === 'function_call') {
      calls.push(item);
    }
  }
  return { texts, refusals, calls };
}

/** The joined text; an answer cut off before it wrote anything (while it thought) is no text and no fault. */
function textOf(texts: readonly string[], cutOff: boolean): string | null {
  if (texts.length > 0) return texts.join('');
  return cutOff ? '' : null;
}

function finishReasonOf(status: unknown, cutOff: boolean): 'length' | 'stop' | null {
  if (cutOff) return 'length';
  return status === 'completed' ? 'stop' : null;
}

/** `input_tokens` holds the cached part, as `prompt_tokens` does: its details say how much (R49). */
function usageOf(usage: z.infer<typeof responseSchema>['usage']) {
  if (usage === undefined) return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    prompt_tokens_details: usage.input_tokens_details,
  };
}

/**
 * Reads the answer of POST <baseUrl>/responses:
 * - a failed answer, or one that carries an error, is the provider's failure (`unavailable`, with a
 *   fixed text), and one with no `output` list is not understood;
 * - the text is the `output_text` parts of the `message` items, joined, and a `refusal` part makes
 *   it a refusal; a `function_call` item is a call (`call_id`, `name` and `arguments` as text);
 *   `reasoning` items, and items of a kind it does not know, are none of these;
 * - it stopped short (`length`) when it is incomplete at `max_output_tokens`, and for any other
 *   reason (a content filter, a status it does not know, none) it is `other`.
 */
function readResponse(raw: unknown): Read {
  const response = completedResponse(raw);
  const { output } = response;
  if (!Array.isArray(output)) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  const { texts, refusals, calls } = sortItems(output as unknown[]);
  const cutOff = isCutOff(response);
  const { answer, toolCalls } = readChoice({
    model: response.model,
    choices: [
      {
        message: {
          content: textOf(texts, cutOff),
          refusal: refusals.length > 0 ? refusals.join('') : null,
          tool_calls: calls.map(asToolCall),
        },
        finish_reason: finishReasonOf(response.status, cutOff),
      },
    ],
    usage: usageOf(response.usage),
  });
  return {
    answer,
    toolCalls,
    output: answer.finishReason === 'refusal' ? null : output,
    calls,
  };
}

/** A `function_call` item as the `tool_calls` entry of a chat completion; its `call_id` is the id. */
function asToolCall(item: unknown): unknown {
  const call = callItemSchema.parse(item);
  return {
    id: call.call_id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  };
}

/** The events of a streamed response that end it, each with the whole response as it ended. */
const TERMINATORS: ReadonlySet<string> = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);

/**
 * Puts the events of a streamed response together into the response that is not streamed, for
 * `readResponse` to read. The event that ends the stream (`response.completed`, `.incomplete` or
 * `.failed`) carries the whole response, its output and its usage, as the answer that is not
 * streamed has them, and that is the answer, as OpenAI's own client takes it. The events before it
 * (the items as they are added and done, the deltas of their texts and arguments) say what that
 * response holds, and are read only for an `error`, which is the provider's error (`serverFailed`).
 * A stream that ends before its terminator is unavailable. What the model wrote, the output, is held
 * to the cap of an answer; the event that carries it may hold more, as it repeats the instructions
 * and the tools of the request.
 */
async function assembleResponse(events: AsyncIterable<SseEvent>): Promise<unknown> {
  for await (const event of events) {
    const { type, data } = eventOf(event);
    if (type === 'error' || event.event === 'error') {
      throw errorInStream(serverFailed(data?.error ?? data));
    }
    if (type !== null && TERMINATORS.has(type)) {
      const response = data?.response;
      withinAnswerCap((response as { output?: unknown } | null | undefined)?.output);
      return response;
    }
  }
  throw cutShort();
}

/** How a conversation's call streams on the Responses API. */
const RESPONSES_STREAM: StreamWire = { fields: { stream: true }, assemble: assembleResponse };

/** POST <baseUrl>/responses and read the answer. */
async function send(
  config: ProviderConfig,
  apiKey: string | null,
  body: Record<string, unknown>,
  http: ProviderHttpOptions,
): Promise<Read> {
  return readResponse(
    await postJson(config, '/responses', authHeaders(config, apiKey), body, http),
  );
}

/**
 * JSON mode, as on Chat Completions: the settings ask for it, and only while there are no tools (the
 * caller then asks for its JSON in the prompt).
 */
const asksForJson = (config: ProviderConfig, tools: readonly unknown[]): boolean =>
  tools.length === 0 && config.jsonMode === 'json_object';

/** What JSON mode adds to the message that opens a conversation when it does not say json. */
const JSON_REMINDER = 'Reply in JSON.';

/**
 * A user message as an input item. With JSON mode the API refuses a request unless an input
 * message says the word json, and does not count the `instructions` (it answers a 400, "Response
 * input messages must contain the word 'json'…"), so `named` gives a message that does not say it
 * one fixed part more, `Reply in JSON.`. It is asked of the message that opens the conversation
 * alone, which every request of the conversation carries as it was: every request then carries the
 * same prefix, whatever a later message says (the words of a retry say JSON), and the word is in
 * the input of each of them.
 */
const userItem = (text: string, named = false) => ({
  role: 'user',
  content: [
    { type: 'input_text', text },
    ...(named && !/json/i.test(text) ? [{ type: 'input_text', text: JSON_REMINDER }] : []),
  ],
});

/**
 * The request: the model, the system prompt as `instructions`, the conversation as `input`, and
 * the limit as `max_output_tokens` whatever the settings' output limit field says. Always stateless
 * (`store: false`, with the encrypted reasoning asked for). The tools go as `tools` with
 * `tool_choice: "auto"`, and while they are sent there is no JSON mode, which a call without tools
 * keeps (`asksForJson`; its input is made for it by the caller, see `userItem`). A temperature goes
 * only when the settings give one.
 */
function requestBody(
  config: ProviderConfig,
  instructions: string,
  input: readonly unknown[],
  tools: readonly unknown[],
  maxTokens: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    instructions,
    input,
    max_output_tokens: maxTokens,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (asksForJson(config, tools)) body.text = { format: { type: 'json_object' } };
  if (config.temperature !== null) body.temperature = config.temperature;
  return body;
}

/**
 * llm.md §2.2, on the Responses API: POST <baseUrl>/responses with the system prompt as
 * `instructions` and one user item. The key is sent as on Chat Completions, the output limit (in
 * `max_output_tokens`) is the answer's tokens and the reasoning allowance together, and the
 * answer's alone from a model that refuses that much (`askWithRoom`); the failures are those of
 * `postJson`.
 */
export async function openAiResponses(
  config: ProviderConfig,
  apiKey: string | null,
  call: LlmCall,
  http: ProviderHttpOptions,
): Promise<LlmAnswer> {
  const input = [userItem(call.user, asksForJson(config, []))];
  return await askWithRoom(config, call, async (maxTokens) => {
    const body = requestBody(config, call.system, input, [], maxTokens);
    return (await send(config, apiKey, body, http)).answer;
  });
}

/**
 * The conversation as input items, oldest first. An assistant turn that carries the replay of an
 * OpenAI turn is its items exactly as they came, the reasoning among them; any other is its text,
 * when it has some, as an `output_text` message and then its calls as `function_call` items (the
 * API refuses a message with no text, so a turn with none sends none). The result of a call is a
 * `function_call_output`, which the API wants after the call and answers it by its `call_id`. With
 * `jsonMode` the first user message names JSON (`userItem`).
 */
function inputItems(messages: readonly LlmMessage[], jsonMode: boolean): unknown[] {
  const opening = messages.findIndex((message) => message.role === 'user');
  return messages.flatMap((message, at): unknown[] => {
    switch (message.role) {
      case 'user':
        return [userItem(message.text, jsonMode && at === opening)];
      case 'tool':
        return [{ type: 'function_call_output', call_id: message.callId, output: message.text }];
      case 'assistant':
        if (message.replay?.kind === 'openai') return [...message.replay.items];
        return [
          ...(message.text.trim() === ''
            ? []
            : [{ role: 'assistant', content: [{ type: 'output_text', text: message.text }] }]),
          ...message.toolCalls.map((call) => ({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            // `arguments` is JSON text on the wire; a call that had none is sent with `{}`.
            arguments: JSON.stringify(call.arguments ?? {}),
          })),
        ];
    }
  });
}

/**
 * R5, on the Responses API: POST <baseUrl>/responses with the whole conversation as `input`, the
 * tools as flat function tools that are not strict (the API makes them strict unless told not to,
 * and Qualor's own schemas are not) with `tool_choice: "auto"`. The request, the limits and the
 * failures are those of `openAiResponses`, but that the answer is streamed when `http.stream` says
 * so (`assembleResponse`); the `function_call` items of the answer are the turn's calls, in order,
 * and a copy of its whole output (the reasoning items, the message and the calls) is the turn's
 * replay, which goes back as it came with the results of the calls.
 */
export async function openAiResponsesConverse(
  config: ProviderConfig,
  apiKey: string | null,
  conversation: LlmConversation,
  http: ProviderHttpOptions,
): Promise<LlmTurn> {
  const tools = conversation.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
  const input = inputItems(conversation.messages, asksForJson(config, tools));
  const ask = answerAsker(config, http, RESPONSES_STREAM);
  return await askWithRoom(config, conversation, async (maxTokens) => {
    const body = requestBody(config, conversation.system, input, tools, maxTokens);
    const { answer, toolCalls, output, calls } = readResponse(
      await ask({ path: '/responses', headers: authHeaders(config, apiKey), body }),
    );
    const replay = output === null ? undefined : replayOf('openai', output, calls);
    return { ...answer, toolCalls: toolCalls.map(toolCall), ...(replay ? { replay } : {}) };
  });
}
