import type { IncomingHttpHeaders } from 'node:http';
import {
  outboundRequest,
  outboundStream,
  OutboundStreamError,
  type OutboundFailure,
  type OutboundRequest,
  type OutboundStreamTimer,
} from '../../http/outbound';
import { isInternalHostAllowed, scmRefusedAddress } from '../../scm/url';
import { llmBaseUrlProblem } from '../url';
import { outputLimitRefusal, ROOM_REFUSAL_STATUSES } from './output-room';
import { parseSse, SseError, type SseEvent } from './sse';
import {
  LLM_MAX_ANSWER_BYTES,
  LLM_MAX_EVENT_BYTES,
  LlmCallAborted,
  LlmError,
  RESPONSES_REQUIRED_TEXT,
  WORKSPACE_REQUIRED_TEXT,
  type ProviderConfig,
  type ProviderHttpOptions,
  type StreamLimits,
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
 * An error body is read once, and only to classify (llm.md §14): a 400 or a 422 that says, in words
 * pinned in `outputLimitRefusal`, that the output limit is more than the model takes is flagged
 * (`refusedOutputLimit`), and also `refusedContext` when the limit is the context window that the
 * prompt shares; `outputLimitField`, the output limit field the request carried, is matched against
 * the error's `param` (the Responses API has none to name: its field is fixed); a request to Chat
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
          `The model did not answer within ${config.timeoutSeconds} s; raise the timeout in the AI provider settings`,
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
    `The model sent nothing for ${silent} s; raise the timeout in the AI provider settings`,
  );
}

/**
 * The events of a 2xx's body, read as the chunks arrive. What goes wrong while it streams is thrown
 * from here as what the same would be before the stream: the signal's giving up is LlmCallAborted;
 * a timer that ran out is the `streamTimeout`; a stream over its raw cap, or an event over its bound
 * (LLM_MAX_EVENT_BYTES, more than an answer may hold: the answer is capped once it is put together),
 * is an answer that is not understood; a connection that breaks is the provider being unavailable.
 */
async function* streamEvents(
  chunks: AsyncIterable<Buffer>,
  limits: StreamLimits,
): AsyncGenerator<SseEvent, void, undefined> {
  try {
    yield* parseSse(chunks, { maxEventBytes: LLM_MAX_EVENT_BYTES });
  } catch (error) {
    if (error instanceof OutboundStreamError) {
      throw failureOf(error, () => streamTimeout(error.timer, limits));
    }
    if (error instanceof SseError) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
    throw error;
  }
}

/**
 * The events of a 2xx's body (`streamEvents`), for the one that reads them, whose `return()` closes
 * the connection at once: before the first read too, and while a read waits. A generator's own
 * `return()` does neither (before its body has started it has nothing to clean up, and while it
 * waits the `return()` waits behind it), and the provider would go on answering until a timer ran
 * out. The body is closed first, which ends the wait of a read with the end of the events; a stream
 * that is never read is ended by its timers.
 */
function eventsOf(
  chunks: AsyncIterable<Buffer>,
  limits: StreamLimits,
): AsyncIterableIterator<SseEvent, void, undefined> {
  const body = chunks[Symbol.asyncIterator]();
  const events = streamEvents({ [Symbol.asyncIterator]: () => body }, limits);
  return {
    next: () => events.next(),
    async return() {
      await body.return?.();
      return await events.return(undefined);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * What a streamed call is answered with: the events of its stream, or the whole answer of a server
 * that does not stream. Such a server answers a request that asks for a stream as one that does
 * not: with a 2xx whose body is the answer as JSON, as `postJson` parses it.
 */
export type StreamedAnswer =
  { kind: 'events'; events: AsyncIterable<SseEvent> } | { kind: 'whole'; answer: unknown };

/** A JSON content type, with any parameters: `application/json`, or any type that ends in `+json`. */
const JSON_TYPE = /^\s*(?:application\/json|[\w.!#$&^+-]+\/[\w.!#$&^+-]+\+json)\s*(?:;|$)/i;

/**
 * How a 2xx's body is read, by its content type: whole, as JSON, for a JSON type; as an event
 * stream for any other, so that a gateway that streams under a type of its own still streams; and,
 * for a body with no content type, by its first byte that is not blank (`firstByteOf`).
 */
function bodyKindOf(headers: IncomingHttpHeaders): 'json' | 'events' | 'untyped' {
  const type = headers['content-type'];
  if (typeof type !== 'string' || type.trim() === '') return 'untyped';
  return JSON_TYPE.test(type) ? 'json' : 'events';
}

/** The bytes JSON allows before a value: space, tab, line feed and carriage return. */
const BLANKS: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * The start of a 2xx's body that has no content type, read until a byte that is not blank, or the
 * body's end, or LLM_MAX_ANSWER_BYTES of blanks (more than a JSON answer may hold): whether that
 * byte opens JSON (`{` or `[`), and the body from its start, the chunks read here first, for the
 * reader that reads it next, whose `return()` closes the connection. What goes wrong while it is
 * read is thrown as what goes wrong while the events stream.
 */
async function firstByteOf(
  chunks: AsyncIterable<Buffer>,
  limits: StreamLimits,
): Promise<{ json: boolean; chunks: AsyncIterable<Buffer> }> {
  const body = chunks[Symbol.asyncIterator]();
  const read: Buffer[] = [];
  let size = 0;
  let first: number | undefined;
  try {
    while (first === undefined && size <= LLM_MAX_ANSWER_BYTES) {
      const next = await body.next();
      if (next.done === true) break;
      read.push(next.value);
      size += next.value.length;
      first = next.value.find((byte) => !BLANKS.has(byte));
    }
  } catch (error) {
    if (error instanceof OutboundStreamError) {
      throw failureOf(error, () => streamTimeout(error.timer, limits));
    }
    throw error;
  }
  const replayed: AsyncIterator<Buffer> = {
    next: async () => {
      const chunk = read.shift();
      return chunk === undefined ? body.next() : { done: false, value: chunk };
    },
    return: async () => {
      read.length = 0;
      return (await body.return?.()) ?? { done: true, value: undefined };
    },
  };
  return {
    json: first === 0x7b || first === 0x5b,
    chunks: { [Symbol.asyncIterator]: () => replayed },
  };
}

/**
 * The body of a 2xx read whole as it arrives and then parsed as JSON, as `postJson` reads an
 * answer: more than LLM_MAX_ANSWER_BYTES is an answer not understood (and the connection is
 * closed), and so is a body that is not JSON. What goes wrong while it is read is thrown as what
 * goes wrong while events stream (`streamEvents`): the signal's giving up, a timer that ran out, a
 * connection that breaks.
 */
async function wholeAnswer(
  chunks: AsyncIterable<Buffer>,
  status: number,
  limits: StreamLimits,
): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > LLM_MAX_ANSWER_BYTES) throw new LlmError('bad_answer', NOT_UNDERSTOOD);
      parts.push(chunk);
    }
  } catch (error) {
    if (error instanceof OutboundStreamError) {
      throw failureOf(error, () => streamTimeout(error.timer, limits));
    }
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } catch {
    throw new LlmError('bad_answer', NOT_UNDERSTOOD, { status });
  }
}

/**
 * One streamed POST to `<baseUrl><path>`: everything before the answer is `postJson`'s (the base
 * URL checked first, every resolved address checked and pinned, no proxy, no redirect followed, the
 * same headers), but the call asks for an event stream, and reads it as it arrives, within the
 * caller's `limits`. Resolves when the status line of a 2xx has come: with its events, which are
 * read from it as they arrive (`for await`; a reader that stops early closes the connection, even
 * before its first read: `eventsOf`); or, when its content type is JSON, with the whole answer, as
 * JSON (`wholeAnswer`): a server that does not stream may ignore the ask and answer as it does to a
 * request that makes none. Any other content type is read as an event stream, and a body with none
 * by its first byte that is not blank (`bodyKindOf`).
 * An answer with any other status throws what `postJson` throws for it, with the one function that
 * classifies a refusal for both (`refusedBy`), so that a streamed call is asked again, as a call
 * that is not, when its output limit is refused; a server that does not stream says so in it too
 * (`refusedStream`). The body of such an answer is read up to 1 MiB, only to classify it. What goes
 * wrong before the status line is `postJson`'s failure too, and what goes wrong while the events
 * stream is thrown from them (`streamEvents`). The terminator of a stream is the provider's to
 * require; a stream that ends without one is still an end here.
 */
export async function postStream(
  config: ProviderConfig,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  http: ProviderHttpOptions,
  limits: StreamLimits,
  outputLimitField?: ProviderConfig['maxTokensField'],
): Promise<StreamedAnswer> {
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
    case 'stream': {
      const kind = bodyKindOf(result.headers);
      const start =
        kind === 'untyped'
          ? await firstByteOf(result.chunks, limits)
          : { json: kind === 'json', chunks: result.chunks };
      return start.json
        ? { kind: 'whole', answer: await wholeAnswer(start.chunks, result.status, limits) }
        : { kind: 'events', events: eventsOf(start.chunks, limits) };
    }
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
  // A server that does not stream is asked again without the stream. Before the other refusals,
  // which such a server may word with the stream in them: one that does not stream tool calls
  // takes the same tools unstreamed.
  if (status === 400 && streamed(request) && refusesStream(refused)) {
    return new LlmError('rejected', refusedText(status), { status, refusedStream: true });
  }
  // Before the refusal of the field: OpenAI names the parameter of a limit that is too large
  // too, and it is the value that is refused then, not the field.
  const limit = ROOM_REFUSAL_STATUSES.has(status) ? outputLimitRefusal(refused.message) : null;
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
      `The model does not accept ${outputLimitField}; set the output limit parameter to ${other} in the AI provider settings`,
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
  if (carriesTools(request) && refusesTools(refused, config.model)) {
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

/** Whether the request body asks for a streamed answer (the key every wire uses for it). */
function streamed(body: unknown): boolean {
  return (body as { stream?: unknown } | null)?.stream === true;
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

/** A JSON object, as an error body or the data of an event holds one; null for anything else. */
export const asRecord = (value: unknown): Record<string, unknown> | null =>
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
 * the top of the body (vLLM), and in the first element when the body is a list (Gemini). A body that is not JSON holds nothing. Callers use only a yes or no
 * of it: nothing of the text is shown, stored or logged.
 */
function errorOf(body: Buffer): ErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { detail: null, message: '' };
  }
  // Gemini's OpenAI endpoint wraps its error in a list: `[{"error":{"message":"…"}}]`.
  const top = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
  const detail = asRecord(top?.error) ?? top;
  const message =
    typeof detail?.message === 'string'
      ? detail.message
      : typeof top?.error === 'string'
        ? top.error
        : '';
  return { detail, message };
}

/** The parameters of a streamed request, which a server that does not stream refuses by name. */
const STREAM_PARAMS: ReadonlySet<string> = new Set(['stream', 'stream_options']);
/** Words that name the stream: `stream`, `stream_options`, `streaming`, `streamed`. */
const STREAM_WORDS = /\bstream(?:_options|ing|ed)?\b/i;

/**
 * Whether an error body says that the server does not stream: the parameter it refuses is one of
 * the stream's (Chat Completions' `stream_options`, the Responses API's `stream`), or its message
 * names the stream and says that it is not supported, in the phrases of `refusesTools` ("stream:
 * Extra inputs are not permitted", "Unrecognized request argument supplied: stream_options").
 * Only this yes or no is used.
 */
function refusesStream({ detail, message }: ErrorBody): boolean {
  const param = detail?.param;
  if (typeof param === 'string' && STREAM_PARAMS.has(param)) return true;
  return STREAM_WORDS.test(message) && NOT_SUPPORTED.test(message);
}

/**
 * Whether an error body says that the model or its server cannot call tools or functions: it is
 * about tools (the parameter it refuses is one of the tool parameters, or its message names tools
 * or functions) and it says they are not supported (a phrase of that, or the code
 * `unsupported_parameter`). A refusal of a schema is not it, and neither is a request that is too
 * long, although OpenAI's message for that counts the tokens "in the functions". Only this yes or
 * no is used. The model's own id is taken out of the message first: a model named `my-tool-model`
 * would make "model my-tool-model is not available" a refusal of tools.
 */
function refusesTools({ detail, message: asked }: ErrorBody, model: string): boolean {
  const code = detail?.code;
  // The model's own id is no word of the refusal (`my-tool-model is not available`).
  const message = model === '' ? asked : asked.split(model).join(' ');
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
