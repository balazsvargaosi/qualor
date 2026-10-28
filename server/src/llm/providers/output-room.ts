import { pairOf, RememberedPairs } from './remembered-pairs';
import { LlmError, type ProviderConfig } from './types';

/**
 * How the providers word a refusal (a 400) of an output limit for being more than the model takes,
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
 * supported, use `max_completion_tokens`) are none of them. Other servers word the same refusal in
 * words of their own, which are not pinned here (`askWithRoom` asks them again all the same).
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
 * Whose limit a refusal refuses. A `cap` is the model's own and is the same for every prompt:
 * Anthropic's "maximum allowed number of output tokens", OpenAI's "supports at most". A `context`
 * is the window the prompt shares with the output: what the model takes of it depends on how long
 * the prompt is, so a prompt that is short enough is given room that a long one is not.
 */
export type OutputLimitRefusal = 'cap' | 'context';

/**
 * What the message of a provider's refusal says of the output limit asked for: that it is more
 * than the model takes, and whose limit that is; null when it says no such thing in words pinned
 * here.
 */
export function outputLimitRefusal(message: string): OutputLimitRefusal | null {
  if (!OUTPUT_LIMIT_REFUSALS.some((pattern) => pattern.test(message))) return null;
  return CONTEXT_REFUSALS.some((pattern) => pattern.test(message)) ? 'context' : 'cap';
}

/**
 * The statuses of a refusal of a request's contents: a 400, and a 422, which Hugging Face TGI
 * answers for a request that does not validate, a limit past its window among them. The room that
 * is refused (`mayRefuseTheRoom`) and the prompt-cache markers that are refused (`refusedBy`) are
 * read from these.
 */
export const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/**
 * Whether the error of a call that asked for the room may be the room refused, whatever its words
 * say: a refusal (`rejected`, with a status of REFUSAL_STATUSES) that is classified as nothing
 * else. A refusal of the workspace is a failure of its own (`workspace_required`); a refusal of
 * tools (`refusedTools`), the Responses hint among them (`needsResponses`), one of the stream
 * (`refusedStream`) and one of the prompt-cache markers (`refusedCacheControl`) are something else,
 * and so is every other failure.
 */
function mayRefuseTheRoom(error: unknown): error is LlmError {
  return (
    error instanceof LlmError &&
    error.failure === 'rejected' &&
    error.status !== null &&
    REFUSAL_STATUSES.has(error.status) &&
    !error.refusedTools &&
    !error.needsResponses &&
    !error.refusedStream &&
    !error.refusedCacheControl
  );
}

/**
 * The models a process has found to refuse the room, by a cap of their own or in words it does not
 * know: a process asks each of them once, and a restart asks again.
 */
const refusedRooms = new RememberedPairs();

/**
 * One call to a provider that asks for the room to think as well as for the answer: `attempt` is
 * given the output limit to send, which is the answer's own tokens and the allowance together.
 * Some models take less than that (a model with an output limit of 4 096, a server with a small
 * context), and refuse such a call, each server in words of its own: Anthropic, OpenAI and vLLM in
 * the words `outputLimitRefusal` knows (`LlmError.refusedOutputLimit`), others not (Hugging Face
 * TGI with a 422, SGLang, DeepSeek, Groq, whose words name the field). So any refusal of such a call
 * that is classified as nothing else (`mayRefuseTheRoom`) is asked once more, in the same call, for
 * the answer's own tokens alone, which is the limit the call had before the room: one call for the
 * caller, whatever it took.
 *
 * When the second ask is answered, the room is what the model refused, and the pair of that base
 * URL and that model is remembered, as for a refusal in words it does not know: the calls that
 * follow send the answer's limit at once, and such a model costs one quick refusal for each
 * process. A refusal of the context window (`LlmError.refusedContext`) is not remembered: what the
 * model takes of the output depends on how long the prompt is, so the next call asks for the room
 * again, and is asked again without it when its prompt leaves none. When the second ask fails too,
 * its own error stands: a refusal the same as the first keeps the first one's classification and
 * hint (a prompt too long on its own, a field the model does not take), and any other error is that
 * error.
 */
export async function askWithRoom<T>(
  config: ProviderConfig,
  limits: { maxOutputTokens: number; reasoningAllowance?: number },
  attempt: (outputTokens: number) => Promise<T>,
): Promise<T> {
  const room = limits.reasoningAllowance ?? 0;
  const pair = pairOf(config);
  const roomWanted = room > 0 && !refusedRooms.has(pair);
  if (!roomWanted) return await attempt(limits.maxOutputTokens);
  let refusal: LlmError;
  try {
    return await attempt(limits.maxOutputTokens + room);
  } catch (error) {
    if (!mayRefuseTheRoom(error)) throw error;
    refusal = error;
  }
  const answer = await attempt(limits.maxOutputTokens);
  if (!refusal.refusedContext) refusedRooms.add(pair);
  return answer;
}
