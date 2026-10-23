import { MIN_SCRUBBED_KEY_LENGTH, scrub } from '../llm/job';
import type { LlmTurn } from '../llm/providers';
import { CONVERSATION_LIMITS } from './conversation';

/*
 * The provider's API key, taken out of what the model says (llm.md §5.2 item 2, §9.3). The model
 * never sees the key, but a repository can hold it, and what the model writes is posted to the
 * merge request: the key is scrubbed from the answer before anything is stored, returned or
 * posted, as the llm job scrubs the answer of explain, triage and fix.
 */

/** One escape of a JSON string, as a unit: `s` is one, and so is the `\\` before a `u`. */
const ESCAPE = /\\(?:u([0-9a-fA-F]{4})|[\s\S])/g;

/**
 * `text` with the `\uXXXX` escapes of JSON written out, except the ones that would change a JSON
 * text: the quote, the backslash, a control character and half of a surrogate pair stay as they
 * are. A JSON string in it keeps its value.
 */
function withEscapesWrittenOut(text: string): string {
  return text.replace(ESCAPE, (escape: string, hex: string | undefined) => {
    if (hex === undefined) return escape;
    const unit = Number.parseInt(hex, 16);
    const structural =
      unit < 0x20 || unit === 0x22 || unit === 0x5c || (unit >= 0xd800 && unit <= 0xdfff);
    return structural ? escape : String.fromCharCode(unit);
  });
}

/**
 * `text` without the key. The text may spell the key with JSON escapes (`sk-…`), which the
 * parsed answer then holds; when it does, the escapes that do not change the JSON are written out,
 * and the key is taken out of that. A key of fewer than 8 characters, and none, are not looked for.
 */
export function scrubText(text: string, key: string | null): string {
  if (key === null || key.length < MIN_SCRUBBED_KEY_LENGTH) return text;
  const plain = scrub(text, key);
  const written = withEscapesWrittenOut(plain);
  return written.includes(key) ? scrub(written, key) : plain;
}

/**
 * `value` with the key taken out of every string and every name in it. A container deeper than
 * the loop takes arguments (`CONVERSATION_LIMITS.maxArgumentDepth`) is not followed, nor needs to
 * be: the loop refuses such arguments, and an empty object in its place keeps them too deep for it.
 */
function scrubValue(value: unknown, key: string, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value, key);
  if (value === null || typeof value !== 'object') return value;
  if (depth > CONVERSATION_LIMITS.maxArgumentDepth) return {};
  if (Array.isArray(value)) return value.map((item: unknown) => scrubValue(item, key, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      scrubText(name, key),
      scrubValue(item, key, depth + 1),
    ]),
  );
}

/** The turn with the key taken out of its text and of everything in its calls. */
export function scrubTurn(turn: LlmTurn, key: string | null): LlmTurn {
  if (key === null || key.length < MIN_SCRUBBED_KEY_LENGTH) return turn;
  return {
    ...turn,
    text: scrubText(turn.text, key),
    toolCalls: turn.toolCalls.map((call) => ({
      id: scrubText(call.id, key),
      name: scrubText(call.name, key),
      arguments: scrubValue(call.arguments, key, 1),
    })),
  };
}
