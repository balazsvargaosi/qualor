import { LlmError, type ProviderConfig } from './types';

/**
 * How the providers word a 400 that refuses an output limit for being more than the model takes,
 * each pinned against a message as the provider gave it (case does not matter):
 * - Anthropic: "max_tokens: 20384 > 8192, which is the maximum allowed number of output tokens for
 *   claude-3-5-sonnet-20241022";
 * - OpenAI: "max_tokens is too large: 20000. This model supports at most 16384 completion tokens,
 *   whereas you provided 20000." (the same of `max_completion_tokens`, and of both names at once
 *   in the newer words of the servers that copy it), and its other words, "Invalid 'max_tokens':
 *   integer above maximum value. Expected a value <= 4096, but got 8000 instead.";
 * - OpenAI, for `max_output_tokens`, the limit of its Responses API, which documents no message of
 *   its own for one that is too large: the two above with that field in them, the second as its
 *   validator words a number below the least ("Invalid 'max_output_tokens': integer below minimum
 *   value. Expected a value >= 16, but got 1 instead."): "Invalid 'max_output_tokens': integer
 *   above maximum value. Expected a value <= 4096, but got 5200 instead.";
 * - vLLM, and the servers that word it as OpenAI's own servers once did: "This model's maximum
 *   context length is 8192 tokens. However, you requested 9000 tokens (4000 in the messages, 5000
 *   in the completion). Please reduce the length of the messages or completion." A completion with
 *   tokens counted in it is the mark of it;
 * - Anthropic, for its older models, when what is sent and what is asked for pass the context window
 *   together (the text as it is remembered, not as a call showed it): "input length and
 *   `max_tokens` exceed context limit: 190000 + 20000 > 200000, decrease input length or
 *   `max_tokens` and try again", read loosely: the quotes are optional, and so are the verb's s and
 *   the article.
 * What these have in common is that a smaller limit may help. A prompt that is too long on its own
 * ("your messages resulted in 9000 tokens") and a refusal of the field (`max_tokens` is not
 * supported, use `max_completion_tokens`) are none of them.
 */
const OUTPUT_LIMIT_REFUSALS: readonly RegExp[] = [
  /\bmaximum\s+allowed\s+number\s+of\s+output\s+tokens\b/i,
  /\bmax_(?:completion_|output_)?tokens\b['"]?\s+is\s+too\s+large\b/i,
  /\bmax_(?:completion_|output_)?tokens\b['"]?:\s*integer\s+above\s+maximum\s+value\b/i,
  /\b\d+\s+in\s+the\s+completion\b/i,
  /\binput\s+length\s+and\s+\W{0,2}max_tokens\W{0,2}\s+exceeds?\s+(?:the\s+)?context\s+limit\b/i,
];

/**
 * What says of such a refusal that the limit it speaks of is the context window, which the prompt
 * and the output share, and not a cap of the model's own: it names the window ("maximum context
 * length", "context limit"), or counts the completion beside the messages ("5000 in the
 * completion"). The newer words of vLLM say "is too large" as OpenAI does, and name the window.
 */
const CONTEXT_REFUSALS: readonly RegExp[] = [
  /\bcontext\s+(?:length|limit)\b/i,
  /\b\d+\s+in\s+the\s+completion\b/i,
];

/**
 * Whose limit a 400 refuses. A `cap` is the model's own and is the same for every prompt:
 * Anthropic's "maximum allowed number of output tokens", OpenAI's "supports at most". A `context`
 * is the window the prompt shares with the output: what the model takes of it depends on how long
 * the prompt is, so a prompt that is short enough is given room that a long one is not.
 */
export type OutputLimitRefusal = 'cap' | 'context';

/**
 * What the message of a provider's 400 says of the output limit asked for: that it is more than
 * the model takes, and whose limit that is; null when it says no such thing.
 */
export function outputLimitRefusal(message: string): OutputLimitRefusal | null {
  if (!OUTPUT_LIMIT_REFUSALS.some((pattern) => pattern.test(message))) return null;
  return CONTEXT_REFUSALS.some((pattern) => pattern.test(message)) ? 'context' : 'cap';
}

/** How many pairs of a base URL and a model a process remembers as refusing the room. */
export const MAX_REFUSED_ROOMS = 1_000;

/**
 * The models a process has found to refuse the room by a cap of their own: a set bounded to
 * `limit`, the oldest dropped first (a pair added again is the newest). It is in memory only, so a
 * process asks each of them once, and a restart asks again.
 */
export class RefusedRooms {
  private readonly pairs = new Set<string>();

  constructor(private readonly limit = MAX_REFUSED_ROOMS) {}

  has(pair: string): boolean {
    return this.pairs.has(pair);
  }

  add(pair: string): void {
    this.pairs.delete(pair);
    this.pairs.add(pair);
    for (const oldest of this.pairs) {
      if (this.pairs.size <= this.limit) break;
      this.pairs.delete(oldest);
    }
  }

  get size(): number {
    return this.pairs.size;
  }
}

const refusedRooms = new RefusedRooms();

/**
 * A model is its address and its name: a base URL pasted with a trailing slash is the same
 * address (as `postJson` reads it).
 */
function pairOf(config: ProviderConfig): string {
  return `${config.baseUrl.replace(/\/+$/, '')}\n${config.model}`;
}

/**
 * One call to a provider that asks for the room to think as well as for the answer: `attempt` is
 * given the output limit to send, which is the answer's own tokens and the allowance together.
 * Some models take less than that (a model with an output limit of 4 096, a server with a small
 * context), and refuse such a call with a 400 that says so (`LlmError.refusedOutputLimit`). That is
 * asked once more, in the same call, for the answer's own tokens alone, which is the limit the call
 * had before the room: one call for the caller, whatever it took. When what the model refused is a
 * cap of its own, the pair of that base URL and that model is then remembered, and the calls that
 * follow send the answer's limit at once; such a model costs one quick 400 for each process. A
 * refusal of the context window (`LlmError.refusedContext`) is not remembered: what the model
 * takes of the output depends on how long the prompt is, so the next call asks for the room again,
 * and is asked again without it when its prompt leaves none. A model is remembered only when the
 * second ask is answered. When it fails too, its own error stands, as a prompt that is too long on
 * its own fails; and an error that is not that refusal is not asked again at all.
 */
export async function askWithRoom<T>(
  config: ProviderConfig,
  limits: { maxOutputTokens: number; reasoningAllowance?: number },
  attempt: (outputTokens: number) => Promise<T>,
): Promise<T> {
  const room = limits.reasoningAllowance ?? 0;
  const pair = pairOf(config);
  if (!(room > 0) || refusedRooms.has(pair)) return await attempt(limits.maxOutputTokens);
  let refusal: LlmError;
  try {
    return await attempt(limits.maxOutputTokens + room);
  } catch (error) {
    if (!(error instanceof LlmError && error.refusedOutputLimit)) throw error;
    refusal = error;
  }
  const answer = await attempt(limits.maxOutputTokens);
  if (!refusal.refusedContext) refusedRooms.add(pair);
  return answer;
}
