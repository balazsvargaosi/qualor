import type { IncomingHttpHeaders } from 'node:http';
import { outboundRequest } from '../../http/outbound';
import { isInternalHostAllowed, scmRefusedAddress } from '../../scm/url';
import { llmBaseUrlProblem } from '../url';
import { outputLimitRefused } from './output-room';
import {
  LLM_MAX_ANSWER_BYTES,
  LlmCallAborted,
  LlmError,
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
 * One JSON POST to `<baseUrl><path>` through the outbound core (llm.md §4: the base URL checked
 * first, every resolved address checked and pinned, no proxy, no redirect followed, at most 1 MiB
 * read, the whole exchange within `timeoutSeconds`): the parsed JSON of a 2xx, else an LlmError.
 * An error body is read once, and only to classify (llm.md §14): a 400 that says the output limit
 * is more than the model takes is flagged (`refusedOutputLimit`), for the call to be asked again
 * with less; `outputLimitField`, the output limit field the request carried, is matched against
 * the error's `param`; nothing of the body is shown or logged. A call that `http.signal` gives up
 * is cut where it is, as the timeout cuts it, and throws LlmCallAborted: no LlmError, since the
 * provider neither failed nor was slow.
 */
export async function postJson(
  config: ProviderConfig,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  http: ProviderHttpOptions,
  outputLimitField?: ProviderConfig['maxTokensField'],
): Promise<unknown> {
  const problem = llmBaseUrlProblem(config.baseUrl, http.internalHosts);
  if (problem) throw new LlmError('url_not_allowed', problem);
  // A base URL pasted with a trailing slash is the same address (plan 3B review focus 1).
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}${path}`);
  const result = await outboundRequest(
    {
      url: url.href,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `Qualor/${http.version}`,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    {
      allowInternalHosts: isInternalHostAllowed(url, http.internalHosts),
      refuseAddress: scmRefusedAddress(url),
      timeoutMs: config.timeoutSeconds * 1_000,
      maxResponseBytes: LLM_MAX_ANSWER_BYTES,
      overflow: 'fail',
      names: { noun: 'model provider', target: 'the model provider' },
      ...(http.resolve ? { resolve: http.resolve } : {}),
      ...(http.signal ? { signal: http.signal } : {}),
    },
  );
  if (result.kind === 'failed') {
    switch (result.cause) {
      case 'aborted':
        throw new LlmCallAborted();
      case 'timeout':
        throw new LlmError(
          'timeout',
          `The model did not answer within ${config.timeoutSeconds} s; raise the timeout in the AI assistant settings`,
        );
      case 'not_public':
      case 'refused_address':
      case 'invalid_url':
        throw new LlmError('url_not_allowed', result.reason);
      case 'too_large':
        throw new LlmError('bad_answer', NOT_UNDERSTOOD);
      case 'request':
        // The request could not be built (an invalid header value): retrying cannot help.
        throw new LlmError('rejected', NOT_SENT);
      default:
        // 'unresolved', 'connect_timeout' (no connection within 3 s), 'connection' (llm.md §14).
        throw new LlmError('unavailable', UNREACHABLE);
    }
  }
  const { status } = result;
  const retryAfter = retryAfterSeconds(result.headers);
  if (status === 429) {
    throw new LlmError(
      'rate_limited',
      'The model provider is rate limiting Qualor; try later',
      status,
      retryAfter,
    );
  }
  // Both keep the code `refused_key`; the status (in the text, the Test answer and the log) tells
  // a wrong key (401) from a key that may not do this (403: the model, the workspace, billing).
  if (status === 401) {
    throw new LlmError('refused_key', 'The provider refused the API key (HTTP 401)', status);
  }
  if (status === 403) {
    throw new LlmError(
      'refused_key',
      'The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit',
      status,
    );
  }
  if (status >= 500) throw new LlmError('unavailable', UNREACHABLE, status, retryAfter);
  if (status < 200 || status >= 300) {
    // Read once, whatever it is checked for.
    const refused = errorOf(result.body);
    if (
      status === 400 &&
      config.kind === 'anthropic' &&
      config.workspaceId === null &&
      namesMissingWorkspace(refused)
    ) {
      throw new LlmError('workspace_required', WORKSPACE_REQUIRED_TEXT, status);
    }
    // Before the refusal of the field: OpenAI names the parameter of a limit that is too large
    // too, and it is the value that is refused then, not the field.
    if (status === 400 && outputLimitRefused(refused.message)) {
      throw new LlmError('rejected', refusedText(status), status, null, false, true);
    }
    if (outputLimitField !== undefined && refusedParam(refused) === outputLimitField) {
      const other = outputLimitField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
      throw new LlmError(
        'rejected',
        `The model does not accept ${outputLimitField}; set the output limit field to ${other} in the AI assistant settings`,
        status,
      );
    }
    if (carriesTools(body) && refusesTools(refused)) {
      throw new LlmError(
        'rejected',
        `The provider refused the request (HTTP ${status}): the model or its server does not accept tools`,
        status,
        null,
        true,
      );
    }
    throw new LlmError('rejected', refusedText(status), status);
  }
  try {
    return JSON.parse(result.body.toString('utf8')) as unknown;
  } catch {
    throw new LlmError('bad_answer', NOT_UNDERSTOOD, status);
  }
}

/** What a request that the provider refused is told, whatever it was refused for. */
function refusedText(status: number): string {
  return `The provider refused the request (HTTP ${status}); check the base URL and model`;
}

/** Whether the request body offers the model tools (the key both wires use for them). */
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
