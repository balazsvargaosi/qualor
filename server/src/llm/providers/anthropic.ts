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

function authHeaders(apiKey: string | null): Record<string, string> {
  const result: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
  if (apiKey !== null) result['x-api-key'] = apiKey;
  return result;
}

/**
 * POST <baseUrl>/v1/messages and read the answer: the text blocks joined, and the provider's own
 * `tool_use` blocks, which only a conversation reads further.
 */
async function send(
  config: ProviderConfig,
  apiKey: string | null,
  body: Record<string, unknown>,
  http: ProviderHttpOptions,
): Promise<{ answer: LlmAnswer; toolUse: readonly unknown[] }> {
  const parsed = answerSchema.safeParse(
    await postJson(config, '/v1/messages', authHeaders(apiKey), body, http),
  );
  if (!parsed.success) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
  const toolUse = parsed.data.content.filter((b) => b.type === 'tool_use');
  return {
    answer: {
      text: parsed.data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      finishReason: toolUse.length > 0 ? 'tool' : finish(parsed.data.stop_reason),
      usage: {
        inputTokens: tokenCount(parsed.data.usage?.input_tokens),
        outputTokens: tokenCount(parsed.data.usage?.output_tokens),
      },
      model: parsed.data.model ?? null,
    },
    toolUse,
  };
}

/**
 * llm.md §2.3: POST <baseUrl>/v1/messages with `x-api-key` and `anthropic-version`. No streaming,
 * tools, metadata or thinking.
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
  if (config.temperature !== null) body.temperature = config.temperature;
  return (await send(config, apiKey, body, http)).answer;
}

/**
 * The conversation's messages as the Messages API takes them (R5). An assistant turn is its text
 * block (when it has text: the API refuses a text block that is empty or only whitespace) then a
 * `tool_use` block per call. The `tool` messages answering one turn's calls (a run of them)
 * become one `user` message of `tool_result` blocks, in order: the API wants every result of a
 * turn together, straight after the turn.
 */
function wireMessages(messages: readonly LlmMessage[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [];
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
      wire.push({ role: 'user', content: [{ type: 'text', text: message.text }] });
    } else {
      wire.push({
        role: 'assistant',
        content: [
          ...(message.text.trim() === '' ? [] : [{ type: 'text', text: message.text }]),
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            // The API wants an object; a call that had none is sent with `{}`.
            input: call.arguments ?? {},
          })),
        ],
      });
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
 * tools as `tools` (`input_schema` is the parameters; sent only when there are tools). The
 * request, the limits and the failures are those of `anthropicMessages`; the `tool_use` blocks of
 * the answer are the turn's calls, in order.
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
  }
  if (config.temperature !== null) body.temperature = config.temperature;
  const { answer, toolUse } = await send(config, apiKey, body, http);
  return { ...answer, toolCalls: toolUse.map(toolCall) };
}
