import { NOT_UNDERSTOOD } from './http';
import { LlmError, type ProviderKind, type ProviderReplay } from './types';

/**
 * A copy of blocks or items that can be written out again (what is nested deeper than
 * JSON.stringify follows cannot) and copied, or null when they cannot be. The copy is its own: the
 * blocks are the provider's, and what shares objects with them is not.
 */
function copyOf(items: readonly unknown[]): unknown[] | null {
  try {
    JSON.stringify(items);
    return structuredClone(items) as unknown[];
  } catch {
    return null;
  }
}

/**
 * The replay of a turn: its whole content as the provider sent it (the content of an Anthropic
 * answer, the output of an OpenAI Responses one), in a copy of its own. What the provider asks to
 * have back unchanged (signed thinking, encrypted reasoning) goes back as it came, and nothing done
 * later to the turn's calls, which share their input with the content, may change it. What cannot
 * be written out again must not be in a history that is sent again and again, whatever it is in:
 * - a call whose input cannot leaves the turn without a replay, and the loop refuses those
 *   arguments and sends the turn from its text and its calls (`calls` are the blocks or items that
 *   are the calls, and are part of `content`);
 * - anything else that cannot is a fault of the provider's, which no model sends, and its answer is
 *   not understood.
 */
export function replayOf(
  kind: ProviderKind,
  content: readonly unknown[],
  calls: readonly unknown[],
): ProviderReplay | undefined {
  const items = copyOf(content);
  if (items !== null) return { kind, items };
  if (copyOf(calls) === null) return undefined;
  throw new LlmError('bad_answer', NOT_UNDERSTOOD);
}
