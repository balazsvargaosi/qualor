import { anthropicConverse, anthropicMessages } from './anthropic';
import { openAiChat, openAiConverse } from './openai';
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

/** llm.md §2.1: one call to the configured provider; an answer or an LlmError. */
export function callProvider(
  config: ProviderConfig,
  apiKey: string | null,
  call: LlmCall,
  http: ProviderHttpOptions,
): Promise<LlmAnswer> {
  return config.kind === 'anthropic'
    ? anthropicMessages(config, apiKey, call, http)
    : openAiChat(config, apiKey, call, http);
}

/**
 * R5: the next turn of a conversation with read-only tools, to the configured provider; a turn or
 * an LlmError. Only the review features use it; explain, triage and fix stay `callProvider` calls
 * and never send tools. A turn with `toolCalls` asks the caller to answer them (as `tool`
 * messages) and call again; the provider layer runs no tool and keeps no state.
 */
export function converse(
  config: ProviderConfig,
  apiKey: string | null,
  conversation: LlmConversation,
  http: ProviderHttpOptions,
): Promise<LlmTurn> {
  return config.kind === 'anthropic'
    ? anthropicConverse(config, apiKey, conversation, http)
    : openAiConverse(config, apiKey, conversation, http);
}
