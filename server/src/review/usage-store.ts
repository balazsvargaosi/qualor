import { cutAtGrapheme, LONE_SURROGATE_SOURCE } from '@qualor/shared';
import { jsonbTextBytes, LLM_RESULT_MAX_BYTES } from '../llm/job';
import type { LlmConversation, LlmMessage, LlmToolCall, LlmTurn } from '../llm/providers';

/*
 * The prompt and the result of a review call as its `llm_requests` row keeps them, when the
 * administrator keeps prompts (llm.md §10.1): documents a person can read back, made to fit their
 * columns whatever the model and the repository said. A conversation is far larger than the
 * column, so the prompt shows the newest messages that fit and says how many came before them.
 */

/**
 * The stored prompt stays under the column's CHECK (64 KiB as PostgreSQL writes jsonb text), and
 * the stored result under the one the answers of explain, triage and fix keep to.
 */
export const STORED_PROMPT_BYTES = 60 * 1024;
export const STORED_RESULT_BYTES = LLM_RESULT_MAX_BYTES;
/**
 * The characters a stored text is cut to, widest first: a document that is too big is made again
 * with the next.
 */
const TEXT_CAPS = [16_000, 4_000, 1_000, 250, 60] as const;
const STORED_SYSTEM_CHARS = 1_000;
const STORED_NAME_CHARS = 100;
const STORED_ARGUMENT_CHARS = 300;
const STORED_CALLS = 20;
const STORED_FEWER_CALLS = 5;

const LONE_SURROGATES = new RegExp(LONE_SURROGATE_SOURCE, 'g');

/** U+FFFD, the character that stands for text that could not be read. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * Text a jsonb value can hold: PostgreSQL refuses a NUL and a lone surrogate. Each becomes the
 * replacement character and none is dropped: the provider's key was scrubbed from the text before
 * this, and a key that a NUL splits must not be joined again here.
 */
const storable = (text: string): string =>
  text.replaceAll('\u0000', REPLACEMENT_CHARACTER).replace(LONE_SURROGATES, REPLACEMENT_CHARACTER);

/** `text` made storable and cut to `max` characters, the cut marked. */
function shown(text: string, max: number): string {
  // Twice the characters hold more than `max` code points whenever the text has more: no need to
  // take apart a megabyte to cut it.
  return cutAtGrapheme(storable(text.slice(0, 2 * max + 4)), max);
}

function argumentsText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Arguments nested deeper than JSON.stringify can follow.
    return '[too deeply nested to show]';
  }
}

function storedCall(call: LlmToolCall) {
  return {
    id: shown(call.id, STORED_NAME_CHARS),
    name: shown(call.name, STORED_NAME_CHARS),
    arguments: shown(argumentsText(call.arguments), STORED_ARGUMENT_CHARS),
  };
}

function storedMessage(message: LlmMessage, chars: number) {
  switch (message.role) {
    case 'user':
      return { role: 'user', text: shown(message.text, chars) };
    case 'tool':
      return {
        role: 'tool',
        callId: shown(message.callId, STORED_NAME_CHARS),
        name: shown(message.name, STORED_NAME_CHARS),
        text: shown(message.text, chars),
      };
    case 'assistant':
      return {
        role: 'assistant',
        text: shown(message.text, chars),
        callCount: message.toolCalls.length,
        calls: message.toolCalls.slice(0, STORED_CALLS).map(storedCall),
      };
  }
}

/**
 * The prompt of a call as a person reads it back: the run, the system prompt (cut), and the newest
 * messages of the conversation that fit, oldest first, with how many came before them. The newest
 * are what the call added, which is what a person looks for; each text is cut, to fewer characters
 * until the newest message fits at all.
 */
export function storedPrompt(runId: string, conversation: LlmConversation): unknown {
  const system = shown(conversation.system, STORED_SYSTEM_CHARS);
  const all = conversation.messages;
  for (const chars of TEXT_CAPS) {
    const kept: unknown[] = [];
    let bytes = jsonbTextBytes({ runId, system, omitted: all.length, messages: [] });
    for (const message of [...all].reverse()) {
      const stored = storedMessage(message, chars);
      // The separator between two elements of the list, counted for the first one too.
      const size = jsonbTextBytes(stored) + 2;
      if (bytes + size > STORED_PROMPT_BYTES) break;
      kept.push(stored);
      bytes += size;
    }
    if (kept.length > 0 || all.length === 0) {
      return { runId, system, omitted: all.length - kept.length, messages: kept.reverse() };
    }
  }
  return { runId, system, omitted: all.length, messages: [] };
}

/**
 * The answer of a call as a person reads it back: what the model said, and the calls it made. The
 * text is the answer, so the calls give way first: when both do not fit, the widest text that fits
 * with fewer calls is kept, down to none.
 */
export function storedResult(turn: LlmTurn): unknown {
  for (const chars of TEXT_CAPS) {
    for (const shownCalls of [STORED_CALLS, STORED_FEWER_CALLS, 0]) {
      const document = {
        finishReason: turn.finishReason,
        text: shown(turn.text, chars),
        callCount: turn.toolCalls.length,
        calls: turn.toolCalls.slice(0, shownCalls).map(storedCall),
      };
      if (jsonbTextBytes(document) <= STORED_RESULT_BYTES) return document;
    }
  }
  return { finishReason: turn.finishReason, text: '', callCount: turn.toolCalls.length, calls: [] };
}
