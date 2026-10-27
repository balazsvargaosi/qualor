import type { FinishReason } from '@qualor/shared';
import { z } from 'zod';
import { asRecord, NOT_UNDERSTOOD, postJson } from './http';
import { askWithRoom } from './output-room';
import { pairOf, RememberedPairs } from './remembered-pairs';
import { replayOf } from './replay';
import type { SseEvent } from './sse';
import {
  answerAsker,
  cutShort,
  errorInStream,
  eventOf,
  notUnderstood,
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

export const ANTHROPIC_VERSION = '2023-06-01';

// The one answer schema of both calls. A `tool_use` block is a loose block here, so the single-shot
// call reads (and later refuses) an answer with calls whatever they look like; `converse` checks
// them.
const answerSchema = z.looseObject({
  type: z.literal('message'),
  model: z.string().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable().optional(),
  // Read through `tokenCount`: an odd count is unknown, never a reason to refuse the answer.
  usage: z
    .looseObject({
      input_tokens: z.unknown(),
      output_tokens: z.unknown(),
      cache_creation_input_tokens: z.unknown().optional(),
      cache_read_input_tokens: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
});

/**
 * R49: the prompt-cache marker of a conversation's call, with the 5-minute TTL (the default one):
 * the prefix up to and including the block that carries it is written to the cache, or read from
 * it when an earlier call wrote it within the TTL.
 */
export const CACHE_MARK = { type: 'ephemeral' } as const;

/**
 * What a call used, as the Messages API counts it. With markers, its `input_tokens` is only what
 * comes after the last block marked, and the cache's two counts are the rest of the prompt: every
 * prompt token is the three together, which every budget counts (null when `input_tokens` is not
 * counted, or the three pass the bound of a count). A cache count the API did not give is left out.
 */
function usageOf(usage: z.infer<typeof answerSchema>['usage']): LlmUsage {
  const uncached = tokenCount(usage?.input_tokens);
  const written = tokenCount(usage?.cache_creation_input_tokens);
  const read = tokenCount(usage?.cache_read_input_tokens);
  return {
    inputTokens: uncached === null ? null : tokenCount(uncached + (written ?? 0) + (read ?? 0)),
    outputTokens: tokenCount(usage?.output_tokens),
    ...(read === null ? {} : { cacheReadTokens: read }),
    ...(written === null ? {} : { cacheWriteTokens: written }),
  };
}

/** R5: a call the model made; without an id or a name it cannot be answered. */
const toolUseSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().optional(),
});

function finish(reason: string | null | undefined): FinishReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'refusal') return 'refusal';
  if (reason === 'tool_use') return 'tool';
  return 'other';
}

/**
 * `x-api-key` (none without a key) and `anthropic-version`, and `anthropic-workspace-id` when the
 * provider names a workspace: an organisation-wide key that is not scoped to one needs it.
 */
function headers(config: ProviderConfig, apiKey: string | null): Record<string, string> {
  const result: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
  if (apiKey !== null) result['x-api-key'] = apiKey;
  if (config.workspaceId !== null) result['anthropic-workspace-id'] = config.workspaceId;
  return result;
}

/**
 * Reads the answer of POST <baseUrl>/v1/messages (`raw`, the message as JSON, or as its stream put
 * it together): the text blocks joined, the provider's own `tool_use` blocks, which only a
 * conversation reads further, and the whole `content` exactly as it came, which a conversation
 * turns into the replay that sends the turn back (`replayOf`). A refusal (an answer of HTTP 200
 * whose stop reason says so) has none of it: what its content holds, an apology or half an answer
 * or a call that cannot be read, is not the turn's.
 */
function readMessage(raw: unknown): {
  answer: LlmAnswer;
  toolUse: readonly unknown[];
  content: readonly unknown[] | null;
} {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  const usage = usageOf(parsed.data.usage);
  const model = parsed.data.model ?? null;
  if (parsed.data.stop_reason === 'refusal') {
    return {
      answer: { text: '', finishReason: 'refusal', usage, model },
      toolUse: [],
      content: null,
    };
  }
  const toolUse = parsed.data.content.filter((b) => b.type === 'tool_use');
  return {
    answer: {
      text: parsed.data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      finishReason: toolUse.length > 0 ? 'tool' : finish(parsed.data.stop_reason),
      usage,
      model,
    },
    toolUse,
    // The blocks as the provider sent them (the schema checked that `content` is a list), not the
    // copies the schema made: the thinking in them is signed, and goes back unchanged.
    content: (raw as { content: readonly unknown[] }).content,
  };
}

/** A content block as its events make it: the block, and the JSON its input deltas have joined. */
interface BlockParts {
  block: Record<string, unknown>;
  json: string | null;
}

/** The `index` of a block's event: a whole number from 0, or the events are not understood. */
function blockIndex(data: Record<string, unknown> | null): number {
  const index = data?.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw notUnderstood();
  return index;
}

/** Joins a text delta's `piece` to the `field` of a block. */
function append(block: Record<string, unknown>, field: string, piece: unknown): void {
  if (typeof piece !== 'string') return;
  const before = block[field];
  block[field] = (typeof before === 'string' ? before : '') + piece;
}

/**
 * A block that stops: the JSON its input deltas joined is read once, into its input. JSON that does
 * not make an object (a call cut off at the output limit) leaves the block the input it started
 * with, so that the turn can still go back to the API as it is: the call then has no arguments.
 */
function stopBlock(parts: BlockParts): void {
  const joined = parts.json;
  parts.json = null;
  if (joined === null || joined.trim() === '') return;
  let input: unknown;
  try {
    input = JSON.parse(joined);
  } catch {
    return;
  }
  if (asRecord(input) !== null) parts.block.input = input;
}

/**
 * The counts of a `message_delta`'s usage that say something: a count it leaves null or out (the
 * input's and the cache's, which `message_start` gave) keeps the one there was, and so does a usage
 * that is none.
 */
function countsOf(usage: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(asRecord(usage) ?? {}).filter(
      ([, count]) => count !== null && count !== undefined,
    ),
  );
}

/**
 * The error types of the Messages API that say the server failed, in a stream as before it: it is
 * overloaded (HTTP 529 before the stream), or it failed inside (`api_error`, HTTP 500). Such an
 * error is unavailable, and tried again as the same status before the stream is.
 */
const SERVER_FAILURES: ReadonlySet<unknown> = new Set(['overloaded_error', 'api_error']);

/**
 * Puts the events of a streamed Messages API answer together into the message that is not
 * streamed, for `readMessage` to read: every kind of block into the same content list, in the order
 * of its `index`, so that the replay of the turn is the same.
 * - `message_start` is the message (its model and its input usage);
 * - `content_block_start` opens a block as it is but for what its deltas add: the `text_delta`s of
 *   a text, the `thinking_delta`s of a thinking block and its `signature_delta`, the
 *   `input_json_delta`s of a call, read once when the block stops (`stopBlock`); a block whose
 *   thinking is redacted comes whole, with its `data`, and so does a block of a kind this does not
 *   know, which is kept as it came;
 * - `message_delta` gives the stop reason, and the usage so far, which counts the output (a count
 *   it leaves null keeps the one there was: `countsOf`);
 * - `message_stop` ends the stream: one that ends before it is unavailable;
 * - `ping` is nothing, and `error` is the provider's error: unavailable when the server failed
 *   (`SERVER_FAILURES`), else its refusal.
 */
async function assembleMessage(events: AsyncIterable<SseEvent>): Promise<unknown> {
  let message: Record<string, unknown> | null = null;
  const blocks = new Map<number, BlockParts>();
  let done = false;
  for await (const event of events) {
    const { type, data } = eventOf(event);
    if (type === 'error' || event.event === 'error') {
      throw errorInStream(SERVER_FAILURES.has(asRecord(data?.error)?.type));
    }
    if (type === 'message_stop') {
      done = true;
      break;
    }
    if (type === 'message_start') {
      const started = asRecord(data?.message);
      if (started === null) throw notUnderstood();
      message = { ...started };
    } else if (type === 'content_block_start') {
      const block = asRecord(data?.content_block);
      if (block === null) throw notUnderstood();
      blocks.set(blockIndex(data), { block: { ...block }, json: null });
    } else if (type === 'content_block_delta' || type === 'content_block_stop') {
      const parts = blocks.get(blockIndex(data));
      if (parts === undefined) throw notUnderstood();
      if (type === 'content_block_stop') {
        stopBlock(parts);
        continue;
      }
      const delta = asRecord(data?.delta);
      if (delta?.type === 'text_delta') append(parts.block, 'text', delta.text);
      else if (delta?.type === 'thinking_delta') append(parts.block, 'thinking', delta.thinking);
      else if (delta?.type === 'signature_delta') append(parts.block, 'signature', delta.signature);
      else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        parts.json = (parts.json ?? '') + delta.partial_json;
      }
    } else if (type === 'message_delta') {
      if (message === null) throw notUnderstood();
      Object.assign(message, asRecord(data?.delta));
      const counts = countsOf(data?.usage);
      if (Object.keys(counts).length > 0) message.usage = { ...asRecord(message.usage), ...counts };
    }
  }
  if (!done) throw cutShort();
  if (message === null) throw notUnderstood();
  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, parts]) => {
      stopBlock(parts);
      return parts.block;
    });
  withinAnswerCap(content);
  return { ...message, content };
}

/** How a conversation's call streams on the Messages API. */
const MESSAGES_STREAM: StreamWire = { fields: { stream: true }, assemble: assembleMessage };

/**
 * llm.md §2.3: POST <baseUrl>/v1/messages with `x-api-key` and `anthropic-version`. No streaming,
 * tools, prompt-cache markers (R49: only a conversation's calls carry them), metadata, thinking or
 * sampling parameter: the current models refuse a temperature, a
 * `top_p` and a `top_k`, think as their default says, and count that thinking in `max_tokens`, so
 * `max_tokens` is the answer's tokens and the reasoning allowance together, and the answer's alone
 * from a model that refuses that much (`askWithRoom`).
 */
export async function anthropicMessages(
  config: ProviderConfig,
  apiKey: string | null,
  call: LlmCall,
  http: ProviderHttpOptions,
): Promise<LlmAnswer> {
  return await askWithRoom(config, call, async (maxTokens) => {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: maxTokens,
      system: call.system,
      messages: [{ role: 'user', content: call.user }],
    };
    return readMessage(await postJson(config, '/v1/messages', headers(config, apiKey), body, http))
      .answer;
  });
}

/** A message as the Messages API takes it. */
export interface WireMessage {
  role: 'user' | 'assistant';
  content: unknown[];
}

/**
 * R49: the system prompt and the messages of a conversation's call with its two prompt-cache
 * markers, as copies: the system prompt as one text block that carries one, which caches the tools
 * and the system prompt together (the API caches its prefix in that order), and the last content
 * block of the last message, a user's `text` or `tool_result` block, which carries the other: it
 * moves forward each turn, and the next call reads what this one wrote. An assistant message is
 * never marked, so that a replayed turn (its thinking is signed) goes back exactly as it came. At
 * most these 2 markers, and none at the top of the request, which some Anthropic-compatible
 * gateways refuse. An empty system prompt is no block (the API refuses an empty text block), and
 * then only the last message carries one. Nothing a model reads changes: only the markers are added.
 */
export function markedForCache(
  system: string,
  messages: readonly WireMessage[],
): { system: unknown[]; messages: WireMessage[] } {
  const marked = [...messages];
  const last = marked.at(-1);
  const block = asRecord(last?.content.at(-1));
  if (last?.role === 'user' && block !== null) {
    marked[marked.length - 1] = {
      role: 'user',
      content: [...last.content.slice(0, -1), { ...block, cache_control: CACHE_MARK }],
    };
  }
  return {
    system: system === '' ? [] : [{ type: 'text', text: system, cache_control: CACHE_MARK }],
    messages: marked,
  };
}

/**
 * The models whose server said it takes no prompt-cache markers (`cacheControlUnsupported`): their
 * later calls are sent without them. A process learns each of them once, and a restart learns it
 * again, as `streamed.ts` does for a server that will not stream.
 */
const uncachedPairs = new RememberedPairs();

/**
 * The text of an assistant message that would have nothing in it: the API refuses a message with
 * no content, and a text block that is empty or only whitespace.
 */
const NO_TEXT = '(no text)';

/**
 * What an assistant message is as the Messages API takes it: the replay of an Anthropic turn as it
 * came (its thinking is signed, and must return unchanged, in order, in a history that only
 * grows), else its text block, when it has text, then a `tool_use` block per call. A message that
 * would be empty is the fixed `NO_TEXT`: the loop sends none today (a turn with no text and no
 * calls is not added to the history), and the API's refusal of one must never be what ends a
 * conversation.
 */
function assistantContent(message: Extract<LlmMessage, { role: 'assistant' }>): unknown[] {
  const content =
    message.replay?.kind === 'anthropic'
      ? [...message.replay.items]
      : [
          ...(message.text.trim() === '' ? [] : [{ type: 'text', text: message.text }]),
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            // The API wants an object; a call that had none is sent with `{}`.
            input: call.arguments ?? {},
          })),
        ];
  return content.length > 0 ? content : [{ type: 'text', text: NO_TEXT }];
}

/**
 * The conversation's messages as the Messages API takes them (R5). An assistant turn is its
 * `assistantContent`. The `tool` messages answering one turn's calls (a run of them)
 * become one `user` message of `tool_result` blocks, in order: the API wants every result of a
 * turn together, straight after the turn. A `user` message that comes straight after a user
 * message (the results of a turn, or the message before an assistant turn that had no text to
 * send) is a text block of that message, after the results: a strict endpoint refuses two user
 * messages in a row.
 */
function wireMessages(messages: readonly LlmMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  let results: unknown[] | null = null;
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.callId, content: message.text };
      if (results) results.push(block);
      else {
        results = [block];
        wire.push({ role: 'user', content: results });
      }
      continue;
    }
    results = null;
    if (message.role === 'user') {
      const block = { type: 'text', text: message.text };
      const last = wire.at(-1);
      if (last?.role === 'user') last.content.push(block);
      else wire.push({ role: 'user', content: [block] });
    } else {
      wire.push({ role: 'assistant', content: assistantContent(message) });
    }
  }
  return wire;
}

function toolCall(raw: unknown): LlmToolCall {
  const parsed = toolUseSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    // A call without an input has no arguments, like an OpenAI call without `arguments`.
    arguments: parsed.data.input ?? {},
  };
}

/**
 * R5: POST <baseUrl>/v1/messages with the whole conversation: `system`, the messages, and the
 * tools as `tools` (`input_schema` is the parameters) with `tool_choice` auto, both sent only when
 * there are tools. Only auto: the current models refuse a forced choice (`any`, `tool`) with a 400.
 * The request, the limits and the failures are those of `anthropicMessages`, but that the answer is
 * streamed when `http.stream` says so (`assembleMessage`); the `tool_use` blocks of the answer are
 * the turn's calls, in order, and a copy of its content is the turn's replay.
 *
 * R49: the request carries the two prompt-cache markers (`markedForCache`). A server that refuses
 * them (`refusedCacheControl`) is asked once more, in the same call, with the request as it is
 * without them, its system prompt the plain text, and so are the requests of the call that follow
 * (a call asks more than once when the room to think is refused: `askWithRoom`); the pair of that
 * base URL and that model is then remembered (`uncachedPairs`) if the server said it takes no such
 * field (`cacheControlUnsupported`; a refusal of where a marker was put is not remembered), and its later calls go without
 * markers at once. Each of the three refusals a call may meet (the stream, the markers, the room)
 * is asked again once, the next request without what was refused before: four requests at the most
 * for a call, and one once the pair is learned.
 */
export async function anthropicConverse(
  config: ProviderConfig,
  apiKey: string | null,
  conversation: LlmConversation,
  http: ProviderHttpOptions,
): Promise<LlmTurn> {
  const messages = wireMessages(conversation.messages);
  const marked = markedForCache(conversation.system, messages);
  const tools = conversation.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
  const ask = answerAsker(config, http, MESSAGES_STREAM);
  const pair = pairOf(config);
  let marking = !uncachedPairs.has(pair);
  return await askWithRoom(config, conversation, async (maxTokens) => {
    const bodyOf = (withMarks: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: maxTokens,
        system: withMarks && marked.system.length > 0 ? marked.system : conversation.system,
        messages: withMarks ? marked.messages : messages,
      };
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = { type: 'auto' };
      }
      return body;
    };
    const request = (withMarks: boolean) =>
      ask({ path: '/v1/messages', headers: headers(config, apiKey), body: bodyOf(withMarks) });
    let raw: unknown;
    if (marking) {
      try {
        raw = await request(true);
      } catch (error) {
        if (!(error instanceof LlmError && error.refusedCacheControl)) throw error;
        marking = false;
        if (error.cacheControlUnsupported) uncachedPairs.add(pair);
        raw = await request(false);
      }
    } else {
      raw = await request(false);
    }
    const { answer, toolUse, content } = readMessage(raw);
    const toolCalls = toolUse.map(toolCall);
    const replay = content === null ? undefined : replayOf('anthropic', content, toolUse);
    return { ...answer, toolCalls, ...(replay ? { replay } : {}) };
  });
}
