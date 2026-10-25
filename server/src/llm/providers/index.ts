import { anthropicConverse, anthropicMessages } from './anthropic';
import { openAiChat, openAiConverse } from './openai';
import { openAiResponses, openAiResponsesConverse } from './openai-responses';
import type {
  LlmAnswer,
  LlmCall,
  LlmConversation,
  LlmTurn,
  ProviderConfig,
  ProviderHttpOptions,
} from './types';

export * from './types';
export { retryAfterSeconds } from './http';

/**
 * llm.md §2.1: one call to the configured provider; an answer or an LlmError. An OpenAI provider
 * asks through the API its settings choose: Chat Completions, or the Responses API.
 */
export function callProvider(
  config: ProviderConfig,
  apiKey: string | null,
  call: LlmCall,
  http: ProviderHttpOptions,
): Promise<LlmAnswer> {
  if (config.kind === 'anthropic') return anthropicMessages(config, apiKey, call, http);
  return config.api === 'responses'
    ? openAiResponses(config, apiKey, call, http)
    : openAiChat(config, apiKey, call, http);
}

/**
 * R5: the next turn of a conversation with read-only tools, to the configured provider; a turn or
 * an LlmError, or LlmCallAborted for a call its signal gave up (`http.signal`). Only the review
 * features use it; explain, triage and fix stay `callProvider` calls and never send tools. A turn
 * with `toolCalls` asks the caller to answer them (as `tool` messages) and call again; the provider
 * layer runs no tool and keeps no state.
 */
export function converse(
  config: ProviderConfig,
  apiKey: string | null,
  conversation: LlmConversation,
  http: ProviderHttpOptions,
): Promise<LlmTurn> {
  if (config.kind === 'anthropic') return anthropicConverse(config, apiKey, conversation, http);
  return config.api === 'responses'
    ? openAiResponsesConverse(config, apiKey, conversation, http)
    : openAiConverse(config, apiKey, conversation, http);
}
