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
 * - vLLM, and the servers that word it as OpenAI's own servers once did: "This model's maximum
 *   context length is 8192 tokens. However, you requested 9000 tokens (4000 in the messages, 5000
 *   in the completion). Please reduce the length of the messages or completion." A completion with
 *   tokens counted in it is the mark of it.
 * What these have in common is that a smaller limit may help. A prompt that is too long on its own
 * ("your messages resulted in 9000 tokens") and a refusal of the field (`max_tokens` is not
 * supported, use `max_completion_tokens`) are none of them.
 */
const OUTPUT_LIMIT_REFUSALS: readonly RegExp[] = [
  /\bmaximum\s+allowed\s+number\s+of\s+output\s+tokens\b/i,
  /\bmax_(?:completion_)?tokens\b['"]?\s+is\s+too\s+large\b/i,
  /\bmax_(?:completion_)?tokens\b['"]?:\s*integer\s+above\s+maximum\s+value\b/i,
  /\b\d+\s+in\s+the\s+completion\b/i,
];

/** Whether the message of a provider's 400 says that the output limit asked for is too large. */
export function outputLimitRefused(message: string): boolean {
  return OUTPUT_LIMIT_REFUSALS.some((pattern) => pattern.test(message));
}

/** How many pairs of a base URL and a model a process remembers as refusing the room. */
export const MAX_REFUSED_ROOMS = 1_000;

/**
 * The models a process has found to refuse the room: a set bounded to `limit`, the oldest dropped
 * first (a pair added again is the newest). It is in memory only, so a process asks each of them
 * once, and a restart asks again.
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
 * had before the room: one call for the caller, whatever it took. The pair of that base URL and that
 * model is then remembered, and the calls that follow send the answer's limit at once; a model that
 * refuses the room costs one quick 400 for each process. A model is remembered only when the second
 * ask is answered. When it fails too, its own error stands, as a prompt that is too long on its own
 * fails; and an error that is not that refusal is not asked again at all.
 */
export async function askWithRoom<T>(
  config: ProviderConfig,
  limits: { maxOutputTokens: number; reasoningAllowance?: number },
  attempt: (outputTokens: number) => Promise<T>,
): Promise<T> {
  const room = limits.reasoningAllowance ?? 0;
  const pair = pairOf(config);
  if (!(room > 0) || refusedRooms.has(pair)) return await attempt(limits.maxOutputTokens);
  try {
    return await attempt(limits.maxOutputTokens + room);
  } catch (error) {
    if (!(error instanceof LlmError && error.refusedOutputLimit)) throw error;
  }
  const answer = await attempt(limits.maxOutputTokens);
  refusedRooms.add(pair);
  return answer;
}
