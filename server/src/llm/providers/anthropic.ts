import type { FinishReason } from '@qualor/shared';
import { z } from 'zod';
import { NOT_UNDERSTOOD, postJson } from './http';
import {
  LlmError,
  tokenCount,
  type LlmAnswer,
  type LlmCall,
  type LlmConversation,
  type LlmMessage,
  type LlmToolCall,
  type LlmTurn,
  type ProviderConfig,
  type ProviderHttpOptions,
  type ProviderReplay,
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
    .looseObject({ input_tokens: z.unknown(), output_tokens: z.unknown() })
    .optional()
    .catch(undefined),
});

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

/** Whether the blocks can be written out again: an input nested deeper than JSON.stringify follows cannot. */
function writable(blocks: readonly unknown[]): boolean {
  try {
    JSON.stringify(blocks);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST <baseUrl>/v1/messages and read the answer: the text blocks joined, the provider's own
 * `tool_use` blocks, which only a conversation reads further, and the whole `content` exactly as
 * it came, as the replay that sends the turn back. A refusal (an answer of HTTP 200 whose stop
 * reason says so) has none of it: what its content holds, an apology or half an answer or a call
 * that cannot be read, is not the turn's.
 */
async function send(
  config: ProviderConfig,
  apiKey: string | null,
  body: Record<string, unknown>,
  http: ProviderHttpOptions,
): Promise<{ answer: LlmAnswer; toolUse: readonly unknown[]; replay?: ProviderReplay }> {
  const raw = await postJson(config, '/v1/messages', headers(config, apiKey), body, http);
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  const usage = {
    inputTokens: tokenCount(parsed.data.usage?.input_tokens),
    outputTokens: tokenCount(parsed.data.usage?.output_tokens),
  };
  const model = parsed.data.model ?? null;
  if (parsed.data.stop_reason === 'refusal') {
    return { answer: { text: '', finishReason: 'refusal', usage, model }, toolUse: [] };
  }
  const toolUse = parsed.data.content.filter((b) => b.type === 'tool_use');
  // The blocks as the provider sent them (the schema checked that `content` is a list), not the
  // copies the schema made: the thinking in them is signed, and goes back unchanged. A call that
  // cannot be written out again leaves the turn without a replay, as no history may hold it.
  const items = (raw as { content: readonly unknown[] }).content;
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
    ...(writable(toolUse) ? { replay: { kind: 'anthropic' as const, items } } : {}),
  };
}

/**
 * llm.md §2.3: POST <baseUrl>/v1/messages with `x-api-key` and `anthropic-version`. No streaming,
 * tools, metadata, thinking or sampling parameter: the current models refuse a temperature, a
 * `top_p` and a `top_k`, think as their default says, and count that thinking in `max_tokens`.
 */
export async function anthropicMessages(
  config: ProviderConfig,
  apiKey: string | null,
  call: LlmCall,
  http: ProviderHttpOptions,
): Promise<LlmAnswer> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: call.maxOutputTokens,
    system: call.system,
    messages: [{ role: 'user', content: call.user }],
  };
  return (await send(config, apiKey, body, http)).answer;
}

/** A message as the Messages API takes it. */
interface WireMessage {
  role: 'user' | 'assistant';
  content: unknown[];
}

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
 * The request, the limits and the failures are those of `anthropicMessages`; the `tool_use` blocks
 * of the answer are the turn's calls, in order, and its content is the turn's replay.
 */
export async function anthropicConverse(
  config: ProviderConfig,
  apiKey: string | null,
  conversation: LlmConversation,
  http: ProviderHttpOptions,
): Promise<LlmTurn> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: conversation.maxOutputTokens,
    system: conversation.system,
    messages: wireMessages(conversation.messages),
  };
  if (conversation.tools.length > 0) {
    body.tools = conversation.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    body.tool_choice = { type: 'auto' };
  }
  const { answer, toolUse, replay } = await send(config, apiKey, body, http);
  return { ...answer, toolCalls: toolUse.map(toolCall), ...(replay ? { replay } : {}) };
}
