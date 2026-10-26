import type { IncomingHttpHeaders } from 'node:http';
import {
  outboundRequest,
  outboundStream,
  OutboundStreamError,
  type OutboundFailure,
  type OutboundRequest,
  type OutboundStreamLimits,
  type OutboundStreamTimer,
} from '../../http/outbound';
import { isInternalHostAllowed, scmRefusedAddress } from '../../scm/url';
import { llmBaseUrlProblem } from '../url';
import { outputLimitRefusal } from './output-room';
import { parseSse, SseError, type SseEvent } from './sse';
import {
  LLM_MAX_ANSWER_BYTES,
  LlmCallAborted,
  LlmError,
  RESPONSES_REQUIRED_TEXT,
  WORKSPACE_REQUIRED_TEXT,
  type ProviderConfig,
  type ProviderHttpOptions,
} from './types';

export const NOT_UNDERSTOOD = "The provider's answer was not understood";
const UNREACHABLE = 'The model provider could not be reached';
const NOT_SENT = 'The request to the model provider could not be made; check the settings';

/**
 * llm.md §14: `Retry-After` (seconds or an HTTP date) first, else `retry-after-ms`, in whole
 * seconds; null when neither is present and readable.
 */
export function retryAfterSeconds(
  headers: IncomingHttpHeaders,
  now: () => number = Date.now,
): number | null {
  const raw = headers['retry-after'];
  if (typeof raw === 'string') {
    if (/^\d{1,9}$/.test(raw.trim())) return Number(raw.trim());
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now()) / 1_000));
  }
  const ms = headers['retry-after-ms'];
  if (typeof ms === 'string' && /^\d{1,9}$/.test(ms.trim())) {
    return Math.ceil(Number(ms.trim()) / 1_000);
  }
  return null;
}

/**
 * The address of a call, `<baseUrl><path>`, once the base URL is allowed (llm.md §4: it is checked
 * first, before anything is sent); an LlmError when it is not.
 */
function callUrl(config: ProviderConfig, path: string, http: ProviderHttpOptions): URL {
  const problem = llmBaseUrlProblem(config.baseUrl, http.internalHosts);
  if (problem) throw new LlmError('url_not_allowed', problem);
  // A base URL pasted with a trailing slash is the same address (plan 3B review focus 1).
  return new URL(`${config.baseUrl.replace(/\/+$/, '')}${path}`);
}

/** The POST of a call: `body` as JSON, and `accept` says what answer the call reads. */
function callRequest(
  url: URL,
  headers: Record<string, string>,
  body: unknown,
  http: ProviderHttpOptions,
  accept: string,
): OutboundRequest {
  return {
    url: url.href,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept,
      'user-agent': `Qualor/${http.version}`,
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

/** What a call tells the outbound core of the provider it reaches, and of who may give it up. */
function reach(url: URL, http: ProviderHttpOptions) {
  return {
    allowInternalHosts: isInternalHostAllowed(url, http.internalHosts),
    refuseAddress: scmRefusedAddress(url),
    names: { noun: 'model provider', target: 'the model provider' },
    ...(http.resolve ? { resolve: http.resolve } : {}),
    ...(http.signal ? { signal: http.signal } : {}),
  };
}

/**
 * What a call that got no answer, or lost it, is: LlmCallAborted for the caller's own signal (the
 * provider neither failed nor was slow), else the LlmError of what went wrong. `timedOut` is the
 * error of a timeout, which each call words by the limit that it ran out of.
 */
function failureOf(
  failed: { cause: OutboundFailure; reason: string },
  timedOut: () => LlmError,
): LlmError | LlmCallAborted {
  switch (failed.cause) {
    case 'aborted':
      return new LlmCallAborted();
    case 'timeout':
      return timedOut();
    case 'not_public':
    case 'refused_address':
    case 'invalid_url':
      return new LlmError('url_not_allowed', failed.reason);
    case 'too_large':
      return new LlmError('bad_answer', NOT_UNDERSTOOD);
    case 'request':
      // The request could not be built (an invalid header value): retrying cannot help.
      return new LlmError('rejected', NOT_SENT);
    default:
      // 'unresolved', 'connect_timeout' (no connection within 3 s), 'connection' (llm.md §14).
      return new LlmError('unavailable', UNREACHABLE);
  }
}

/**
 * One JSON POST to `<baseUrl><path>` through the outbound core (llm.md §4: the base URL checked
 * first, every resolved address checked and pinned, no proxy, no redirect followed, at most 1 MiB
 * read, the whole exchange within `timeoutSeconds`): the parsed JSON of a 2xx, else an LlmError.
 * An error body is read once, and only to classify (llm.md §14): a 400 that says the output limit
 * is more than the model takes is flagged (`refusedOutputLimit`), for the call to be asked again
 * with less, and also `refusedContext` when the limit is the context window that the prompt
 * shares; `outputLimitField`, the output limit field the request carried, is matched against the
 * error's `param` (the Responses API has none to name: its field is fixed); a request to Chat
 * Completions that carries tools and is refused in words that name the Responses API is flagged
 * (`needsResponses`); nothing of the body is shown or logged. A call that `http.signal` gives up is
 * cut where it is, as the timeout cuts it, and throws LlmCallAborted: no LlmError, since the
 * provider neither failed nor was slow. {@link postStream} classifies a refused answer the same
 * way, with the same function (`refusedBy`).
 */
export async function postJson(
  config: ProviderConfig,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  http: ProviderHttpOptions,
  outputLimitField?: ProviderConfig['maxTokensField'],
): Promise<unknown> {
  const url = callUrl(config, path, http);
  const result = await outboundRequest(callRequest(url, headers, body, http, 'application/json'), {
    ...reach(url, http),
    timeoutMs: config.timeoutSeconds * 1_000,
    maxResponseBytes: LLM_MAX_ANSWER_BYTES,
    overflow: 'fail',
  });
  if (result.kind === 'failed') {
    throw failureOf(
      result,
      () =>
        new LlmError(
          'timeout',
          `The model did not answer within ${config.timeoutSeconds} s; raise the timeout in the AI assistant settings`,
        ),
    );
  }
  const { status } = result;
  if (status < 200 || status >= 300) throw refusedBy(config, result, body, outputLimitField);
  try {
    return JSON.parse(result.body.toString('utf8')) as unknown;
  } catch {
    throw new LlmError('bad_answer', NOT_UNDERSTOOD, { status });
  }
}

/**
 * The limits of a streamed call, which its caller sets: `firstByteMs` until the status line, then
 * `idleMs` between chunks, `totalMs` for the whole call, and at most `maxStreamBytes` raw bytes of
 * the body.
 */
export type StreamLimits = Omit<OutboundStreamLimits, 'maxErrorBytes'>;

/**
 * What a streamed call that ran out of a timer is told: for the first byte and the idle timer, how
 * long the model sent nothing, and that the timeout of the settings is what to raise; for the total
 * limit, which no setting changes, the limit in its own words.
 */
function streamTimeout(
  timer: OutboundStreamTimer | null | undefined,
  limits: StreamLimits,
): LlmError {
  if (timer === 'total') {
    const minutes = limits.totalMs / 60_000;
    const span = Number.isInteger(minutes)
      ? `${minutes} min`
      : `${Math.round(limits.totalMs / 1_000)} s`;
    return new LlmError(
      'timeout',
      `The model did not finish answering within ${span}; the call was given up`,
    );
  }
  const silent = Math.round((timer === 'idle' ? limits.idleMs : limits.firstByteMs) / 1_000);
  return new LlmError(
    'timeout',
    `The model sent nothing for ${silent} s; raise the timeout in the AI assistant settings`,
  );
}

/**
 * The events of a 2xx's body, read as the chunks arrive. What goes wrong while it streams is thrown
 * from here as what the same would be before the stream: the signal's giving up is LlmCallAborted;
 * a timer that ran out is the `streamTimeout`; a stream over its raw cap, or an event over the answer
 * cap, is an answer that is not understood; a connection that breaks is the provider being
 * unavailable.
 */
async function* streamEvents(
  chunks: AsyncIterable<Buffer>,
  limits: StreamLimits,
): AsyncGenerator<SseEvent, void, undefined> {
  try {
    yield* parseSse(chunks, { maxEventBytes: LLM_MAX_ANSWER_BYTES });
  } catch (error) {
    if (error instanceof OutboundStreamError) {
      throw failureOf(error, () => streamTimeout(error.timer, limits));
    }
    if (error instanceof SseError) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
    throw error;
  }
}

/**
 * One streamed POST to `<baseUrl><path>`: everything before the answer is `postJson`'s (the base
 * URL checked first, every resolved address checked and pinned, no proxy, no redirect followed, the
 * same headers), but the call asks for an event stream, and reads it as it arrives, within the
 * caller's `limits`. Resolves with the events of a 2xx when its status line has come, and the events
 * are read from it as they arrive (`for await`; a reader that stops early closes the connection).
 * An answer with any other status throws what `postJson` throws for it, with the one function that
 * classifies a refusal for both (`refusedBy`), so that a streamed call is asked again, as a call
 * that is not, when its output limit is refused; the body of such an answer is read up to 1 MiB, only
 * to classify it. What goes wrong before the status line is `postJson`'s failure too, and what goes
 * wrong while the events stream is thrown from them (`streamEvents`). The terminator of a stream is
 * the provider's to require; a stream that ends without one is still an end here.
 */
export async function postStream(
  config: ProviderConfig,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  http: ProviderHttpOptions,
  limits: StreamLimits,
  outputLimitField?: ProviderConfig['maxTokensField'],
): Promise<AsyncIterable<SseEvent>> {
  const url = callUrl(config, path, http);
  const result = await outboundStream(callRequest(url, headers, body, http, 'text/event-stream'), {
    ...reach(url, http),
    limits: { ...limits, maxErrorBytes: LLM_MAX_ANSWER_BYTES },
  });
  switch (result.kind) {
    case 'failed':
      throw failureOf(result, () => streamTimeout(result.timer, limits));
    case 'response':
      throw refusedBy(config, result, body, outputLimitField);
    case 'stream':
      return streamEvents(result.chunks, limits);
  }
}

/**
 * The LlmError of an answer whose status is outside 2xx, which is the same for every call that
 * reads one (`postJson` and `postStream`): `refusal` is its status, headers and body (read once, and
 * only to classify), `request` the body that was sent, and `outputLimitField` the output limit field
 * that it carried.
 */
function refusedBy(
  config: ProviderConfig,
  refusal: { status: number; headers: IncomingHttpHeaders; body: Buffer },
  request: unknown,
  outputLimitField: ProviderConfig['maxTokensField'] | undefined,
): LlmError {
  const { status } = refusal;
  const retryAfter = retryAfterSeconds(refusal.headers);
  if (status === 429) {
    return new LlmError('rate_limited', 'The model provider is rate limiting Qualor; try later', {
      status,
      retryAfterSeconds: retryAfter,
    });
  }
  // Both keep the code `refused_key`; the status (in the text, the Test answer and the log) tells
  // a wrong key (401) from a key that may not do this (403: the model, the workspace, billing).
  if (status === 401) {
    return new LlmError('refused_key', 'The provider refused the API key (HTTP 401)', { status });
  }
  if (status === 403) {
    return new LlmError(
      'refused_key',
      'The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit',
      { status },
    );
  }
  if (status >= 500) {
    return new LlmError('unavailable', UNREACHABLE, { status, retryAfterSeconds: retryAfter });
  }
  // Read once, whatever it is checked for.
  const refused = errorOf(refusal.body);
  if (
    status === 400 &&
    config.kind === 'anthropic' &&
    config.workspaceId === null &&
    namesMissingWorkspace(refused)
  ) {
    return new LlmError('workspace_required', WORKSPACE_REQUIRED_TEXT, { status });
  }
  // Before the refusal of the field: OpenAI names the parameter of a limit that is too large
  // too, and it is the value that is refused then, not the field.
  const limit = status === 400 ? outputLimitRefusal(refused.message) : null;
  if (limit !== null) {
    return new LlmError('rejected', refusedText(status), {
      status,
      refusedOutputLimit: true,
      refusedContext: limit === 'context',
    });
  }
  if (outputLimitField !== undefined && refusedParam(refused) === outputLimitField) {
    const other = outputLimitField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    return new LlmError(
      'rejected',
      `The model does not accept ${outputLimitField}; set the output limit field to ${other} in the AI assistant settings`,
      { status },
    );
  }
  // A model that takes tools only through the Responses API says so: the Test passes it on.
  if (
    status === 400 &&
    config.kind === 'openai' &&
    config.api === 'chat_completions' &&
    carriesTools(request) &&
    namesResponsesApi(refused)
  ) {
    return new LlmError('rejected', RESPONSES_REQUIRED_TEXT, {
      status,
      refusedTools: true,
      needsResponses: true,
    });
  }
  if (carriesTools(request) && refusesTools(refused)) {
    return new LlmError(
      'rejected',
      `The provider refused the request (HTTP ${status}): the model or its server does not accept tools`,
      { status, refusedTools: true },
    );
  }
  return new LlmError('rejected', refusedText(status), { status });
}

/** What a request that the provider refused is told, whatever it was refused for. */
function refusedText(status: number): string {
  return `The provider refused the request (HTTP ${status}); check the base URL and model`;
}

/** Whether the request body offers the model tools (the key every wire uses for them). */
function carriesTools(body: unknown): boolean {
  const tools = (body as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) && tools.length > 0;
}

/** The parameters of a request that servers without tool calling refuse by name. */
const TOOL_PARAMS: ReadonlySet<string> = new Set([
  'tools',
  'tool_choice',
  'functions',
  'function_call',
]);
/** Words that name tools or functions: `tool use`, `--enable-auto-tool-choice`, `function calling`. */
const TOOL_WORDS = /\b(?:tools?|functions?|tool_choice|function_call)\b/i;
/**
 * Phrases that say something is not supported: "does not support tools", "function calling is not
 * enabled", "unsupported parameter", "unrecognized request argument", "extra inputs are not
 * permitted", "requires --enable-auto-tool-choice", and what OpenRouter says (HTTP 404) when no
 * provider behind the model can: "No endpoints found that support tool use". A message that names a
 * tool and says none of them (a name that does not match, an empty list, a role) is some other
 * refusal.
 */
const NOT_SUPPORTED =
  /\bunsupported\b|\bunrecognized\b|(?:\bnot|n't|\bcannot)\s+(?:currently\s+)?(?:support|enabled|available|allowed|permitted|implemented)|\bthat\s+supports?\s+(?:tools?|functions?)\b|\brequires?\s+--/i;
/**
 * The refusal of a tool's schema is Qualor's own schema refused, not a server without tools; it
 * names the tools and the functions all the same, and may say "not permitted" of one of its keywords.
 */
const SCHEMA = /\bschema\b|input_schema/i;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** What an error body holds: the object with the detail (its `param` and `code`), and its message. */
interface ErrorBody {
  detail: Record<string, unknown> | null;
  /** '' when there is none. */
  message: string;
}

/**
 * What an error body holds, as the providers shape it. The error is at `error` (OpenAI, Anthropic,
 * Ollama's OpenAI endpoint), is `error` itself when that is a string (Ollama's own API), or is at
 * the top of the body (vLLM). A body that is not JSON holds nothing. Callers use only a yes or no
 * of it: nothing of the text is shown, stored or logged.
 */
function errorOf(body: Buffer): ErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { detail: null, message: '' };
  }
  const top = asRecord(parsed);
  const detail = asRecord(top?.error) ?? top;
  const message =
    typeof detail?.message === 'string'
      ? detail.message
      : typeof top?.error === 'string'
        ? top.error
        : '';
  return { detail, message };
}

/**
 * Whether an error body says that the model or its server cannot call tools or functions: it is
 * about tools (the parameter it refuses is one of the tool parameters, or its message names tools
 * or functions) and it says they are not supported (a phrase of that, or the code
 * `unsupported_parameter`). A refusal of a schema is not it, and neither is a request that is too
 * long, although OpenAI's message for that counts the tokens "in the functions". Only this yes or
 * no is used.
 */
function refusesTools({ detail, message }: ErrorBody): boolean {
  const code = detail?.code;
  if (SCHEMA.test(message)) return false;
  const param = detail?.param;
  const aboutTools =
    (typeof param === 'string' && TOOL_PARAMS.has(param)) || TOOL_WORDS.test(message);
  const unsupported =
    NOT_SUPPORTED.test(message) || (typeof code === 'string' && code.startsWith('unsupported'));
  return aboutTools && unsupported;
}

/**
 * What the newest OpenAI models say of function tools asked for through Chat Completions, as
 * gpt-6-luna, gpt-5.6-terra and gpt-6.1-sol answered on 2026-10-26, the same but for the model:
 * "Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions.
 * To use function tools, use /v1/responses or set reasoning_effort to 'none'." Either of its two
 * halves is the mark of the message: that tools do not go with reasoning (`reasoning_effort` as it
 * is worded now, or `reasoning`), or the path to the Responses API, matched whole (not
 * `/v1/responses_api`, nor any word about responses).
 */
const RESPONSES_API =
  /\bv1\/responses(?![\w-])|\bfunction\s+tools\s+with\s+reasoning(?:_effort)?\b/i;

/**
 * Whether an error body says that the model takes its function tools only through the Responses
 * API. Only this yes or no is used: nothing of the text is shown, stored or logged.
 */
function namesResponsesApi({ message }: ErrorBody): boolean {
  return RESPONSES_API.test(message);
}

/**
 * Anthropic's words for an organisation-wide key that is sent without a workspace: that the key is
 * not scoped to one, or the header that names it.
 */
const WORKSPACE_REQUIRED = /\bnot\s+scoped\s+to\s+a\s+workspace\b|\banthropic-workspace-id\b/i;

/**
 * Whether an Anthropic error body says that the key is not scoped to a workspace. Only this yes or
 * no is used: nothing of the text is shown, stored or logged.
 */
function namesMissingWorkspace({ message }: ErrorBody): boolean {
  return WORKSPACE_REQUIRED.test(message);
}

/** The `param` of an error body (OpenAI's names the parameter it refuses), when it is a string. */
function refusedParam({ detail }: ErrorBody): string | null {
  const param = detail?.param;
  return typeof param === 'string' ? param : null;
}
