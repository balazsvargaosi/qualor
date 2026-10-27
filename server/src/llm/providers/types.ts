import type { FinishReason } from '@qualor/shared';
import type { OutboundStreamLimits, Resolver } from '../../http/outbound';

export const PROVIDER_KINDS = ['openai', 'anthropic'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * The two wires of the OpenAI provider. `chat_completions` is what the OpenAI-compatible servers
 * (vLLM, Ollama, LiteLLM, Azure deployments) serve. `responses` is OpenAI's own newer API, and the
 * only one that takes function tools together with reasoning from its newest models.
 */
export const PROVIDER_APIS = ['chat_completions', 'responses'] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/**
 * llm.md §3.2: the provider settings a call needs; the API key is passed on its own. `api` is the
 * OpenAI adapter's (Anthropic has one wire), as are `auth`, `jsonMode` and `maxTokensField`; the
 * Responses wire reads the first two, and its limit is always `max_output_tokens`. `temperature` is
 * the OpenAI adapter's (Anthropic's current models refuse sampling parameters, so its adapter
 * never sends one); `workspaceId` is Anthropic's, for an organisation-wide key that is not scoped
 * to a workspace, and the OpenAI adapter never sends it.
 */
export interface ProviderConfig {
  kind: ProviderKind;
  api: ProviderApi;
  baseUrl: string;
  model: string;
  auth: 'bearer' | 'api-key';
  jsonMode: 'json_object' | 'none';
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  temperature: number | null;
  workspaceId: string | null;
  timeoutSeconds: number;
}

/**
 * llm.md §2.1. `maxOutputTokens` is the tokens the answer itself may take; `reasoningAllowance`
 * is the room asked for besides, for a model that thinks before it answers
 * (REASONING_ALLOWANCE_TOKENS). The adapter asks for both together, and for the first alone from a
 * model that refuses a limit that large.
 */
export interface LlmCall {
  system: string;
  user: string;
  maxOutputTokens: number;
  reasoningAllowance?: number;
}

/** llm.md §2.1 */
export interface LlmAnswer {
  text: string;
  finishReason: FinishReason;
  usage: { inputTokens: number | null; outputTokens: number | null };
  model: string | null;
}

/**
 * R5: a tool the model may call during a conversation. `parameters` is a JSON Schema object. The
 * tools are read-only (the review features run them over a repository snapshot); the provider
 * layer only describes them to the model and never runs one.
 */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * R5: a call the model made. `arguments` is the parsed JSON the model sent, or its raw text when
 * that was not JSON (a truncated or malformed call); the caller validates it against the tool.
 */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * What the adapter of a provider keeps of a turn so that the turn goes back to that provider as the
 * model made it: the current Anthropic models bind their thinking blocks to the conversation, and
 * the current OpenAI models want their reasoning items beside the calls they made (the Responses
 * API, which is stateless here), so the blocks or items must return unchanged, in order, in a
 * history that only grows. `items` is the provider's own data and is opaque to everything but the
 * adapter that made it: the loop passes it on, never reads it, and it is never logged, stored,
 * shown, scrubbed or masked (the reasoning in it is encrypted by the provider, and holds no
 * thinking text with the default display). It is part of the answer, so it counts against the
 * answer's size and the conversation's. A turn of the Chat Completions API has none.
 */
export interface ProviderReplay {
  kind: ProviderKind;
  items: readonly unknown[];
}

/**
 * R5: one message of a conversation; `tool` answers the call `callId` of an `assistant` message. An
 * `assistant` message that carries the `replay` of its turn is sent as that replay, the adapter of
 * its kind ignoring the text and the calls; one without it, or with the replay of another kind, is
 * built from them. So is one that reaches the wire that keeps no replay (Chat Completions) with a
 * replay of the Responses wire, as when the API of the settings changes while a conversation runs.
 */
export type LlmMessage =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string;
      toolCalls: readonly LlmToolCall[];
      replay?: ProviderReplay;
    }
  | { role: 'tool'; callId: string; name: string; text: string };

/**
 * R5: the whole conversation so far, sent again on every turn. The limits are those of an
 * {@link LlmCall}: the answer's tokens, and the room asked for besides.
 */
export interface LlmConversation {
  system: string;
  messages: readonly LlmMessage[];
  tools: readonly LlmToolSpec[];
  maxOutputTokens: number;
  reasoningAllowance?: number;
}

/**
 * R5: the model's next turn: its text, and the calls it wants answered (none: it is done). `replay`
 * is what its adapter keeps to send the turn back as it came: the loop puts it on the assistant
 * message it appends, unchanged.
 */
export interface LlmTurn extends LlmAnswer {
  toolCalls: LlmToolCall[];
  replay?: ProviderReplay;
}

/**
 * Output tokens a call asks for beyond the answer it wants, for the models that reason before they
 * answer: the current models of both providers count their reasoning against the output limit, so
 * a limit sized for the answer alone can be used up before the answer begins. A review or reply
 * call (the conversations) is given 16 000, and the short answers of explain, triage and fix
 * (`singleShot`) 4 000, and so does the provider test, on its own small limit. A model that does
 * not reason spends none of it, and every budget counts the tokens a call used, so the room costs
 * nothing. A call carries it apart from the answer's own limit (`reasoningAllowance`), as a model
 * with a smaller output limit than the two together refuses the call, and is asked again without
 * it (see `askWithRoom`).
 */
export const REASONING_ALLOWANCE_TOKENS = { conversation: 16_000, singleShot: 4_000 } as const;

/**
 * What a key that is not scoped to a workspace is told: the provider refused a request (a 400)
 * because an organisation-wide key needs the workspace it is for. A fixed text, never the
 * provider's own words.
 */
export const WORKSPACE_REQUIRED_TEXT =
  'This key is not scoped to a workspace: give its workspace ID in the AI provider settings.';

/**
 * What the Test is told of a model that takes function tools only through the Responses API, when
 * it was asked for them through Chat Completions and said so (a 400 that names the Responses API).
 * A fixed text, never the provider's own words.
 */
export const RESPONSES_REQUIRED_TEXT =
  'This model takes tools only through the Responses API: choose Responses in the AI provider settings.';

/** llm.md §14: why a provider call gave no usable answer. */
export const LLM_FAILURES = [
  'timeout',
  'unavailable',
  'rate_limited',
  'refused_key',
  'workspace_required',
  'rejected',
  'bad_answer',
  'url_not_allowed',
] as const;
export type LlmFailure = (typeof LLM_FAILURES)[number];

/**
 * What an LlmError carries besides its failure and its message, each of it optional. `status` is
 * the provider's HTTP status when it answered, and `retryAfterSeconds` what it asked to wait.
 * `refusedTools`, `refusedOutputLimit`, `refusedContext` and `needsResponses` are each a yes or no
 * read from the provider's error body: the request carried tools and was refused in words that
 * name tools or functions (the model or its server cannot call tools); the request was refused (a
 * 400 or a 422) in words that say its output limit is more than the model takes; and, always with
 * that, the limit that was passed is the context window that the prompt shares with the output, so
 * that what the model takes depends on how long the prompt is, and is no cap of the model's own;
 * and, always with the first, a request to the Chat Completions API was refused in words that name
 * the Responses API, which is where the model takes its tools. `refusedStream` is a request that
 * asked for a streamed answer and was refused (a 400) in words that name the stream: the server
 * does not stream, and the request is asked again without it.
 */
export interface LlmErrorOptions {
  status?: number | null;
  retryAfterSeconds?: number | null;
  refusedTools?: boolean;
  refusedOutputLimit?: boolean;
  refusedContext?: boolean;
  needsResponses?: boolean;
  refusedStream?: boolean;
}

/**
 * A provider call that did not answer usably. `message` is a fixed text, never the provider's
 * body, a header or the API key; what else it says is in `LlmErrorOptions`.
 */
export class LlmError extends Error {
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly refusedTools: boolean;
  readonly refusedOutputLimit: boolean;
  readonly refusedContext: boolean;
  readonly needsResponses: boolean;
  readonly refusedStream: boolean;

  constructor(
    readonly failure: LlmFailure,
    message: string,
    options: LlmErrorOptions = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.refusedTools = options.refusedTools ?? false;
    this.refusedOutputLimit = options.refusedOutputLimit ?? false;
    this.refusedContext = options.refusedContext ?? false;
    this.needsResponses = options.needsResponses ?? false;
    this.refusedStream = options.refusedStream ?? false;
  }
}

/**
 * A call its caller gave up before the provider answered: the call's signal aborted it
 * (`ProviderHttpOptions.signal`), as the server stopping does to the calls of a review. It is no
 * failure of the provider's, so it is no LlmError: it is not a timeout, it is not tried again, and
 * the provider's circuit hears nothing of it.
 */
export class LlmCallAborted extends Error {
  constructor() {
    super('The call to the model provider was given up');
    this.name = 'LlmCallAborted';
  }
}

/**
 * The limits of a streamed call, which its caller sets: `firstByteMs` until the status line, then
 * `idleMs` between two chunks of the body, `totalMs` for the whole call, and at most
 * `maxStreamBytes` raw bytes of the body.
 */
export type StreamLimits = Omit<OutboundStreamLimits, 'maxErrorBytes'>;

export interface ProviderHttpOptions {
  internalHosts: ReadonlySet<string>;
  /** Qualor's version, for `User-Agent`. */
  version: string;
  resolve?: Resolver;
  /**
   * Gives the call up when it aborts: the request is cut at once, as its timeout would cut it, and
   * the call throws {@link LlmCallAborted}. One that aborted before sends nothing.
   */
  signal?: AbortSignal;
  /**
   * Set, a conversation's call (`converse`) asks for a streamed answer and reads it as it comes,
   * within these limits; a server that will not stream is asked once more without it, and the later
   * calls of the model are not streamed. Left out, the call is not streamed, as a single-shot call
   * (`callProvider`) never is.
   */
  stream?: StreamLimits;
  /**
   * Told when the server refuses to stream a call: the call is asked once more without the stream,
   * and the later calls of its model are not streamed, so a process is told of a model about once.
   * Nothing of the refusal is passed on.
   */
  onStreamRefused?: () => void;
}

/**
 * llm.md §10.1: the largest token count stored. A provider's count is its own claim: one that is
 * not a whole number from 0 to this bound (a negative, a fraction, 1e300, a string) is stored as
 * unknown (null), never refused (the answer itself may be fine) and never allowed to overflow the
 * `integer` columns or inflate the token and cost budgets without bound.
 */
export const MAX_TOKEN_COUNT = 10_000_000;

/** A provider's token count, or null when it is missing or out of range. */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TOKEN_COUNT
    ? value
    : null;
}

/** llm.md §4: answers over 1 MiB are refused. */
export const LLM_MAX_ANSWER_BYTES = 1024 * 1024;

/**
 * The most one event of a streamed answer may hold. An answer streamed is held to the cap of an
 * answer (LLM_MAX_ANSWER_BYTES) once it is put together, but one of its events may hold more than
 * the answer: the Responses API's last event repeats the whole response, with its instructions and
 * its tools besides what the model wrote.
 */
export const LLM_MAX_EVENT_BYTES = 4 * LLM_MAX_ANSWER_BYTES;
