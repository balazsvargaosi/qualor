import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventStream, streamPieces, type StreamFault, type Wire } from './fake-llm-sse';

const SHAPES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-shapes');
const MAX_BODY = 1024 * 1024;

/** One example answer of `server/test/llm-shapes/` (plan 3B ruling LL11), a fresh copy each call. */
export function llmShape<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(SHAPES, `${name}.json`), 'utf8')) as T;
}

export interface RecordedLlmRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: unknown;
}
/**
 * One scripted answer: its status, headers and body (an object is sent as JSON), after `delayMs`.
 * A request that asks for a stream gets a 2xx as the events of that body (fake-llm-sse.ts), with the
 * fault of `stream` if any; a body whose content-type is `text/event-stream` is the test's own
 * stream, and is sent as it is.
 */
export interface LlmReply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  delayMs?: number;
  stream?: StreamFault;
}
export type LlmResponder = (request: RecordedLlmRequest) => LlmReply | Promise<LlmReply>;

/** A chat completion (llm.md §2.2) whose first choice says `text`. */
export function openAiAnswer(
  text: string,
  over: {
    finishReason?: string;
    model?: string;
    usage?: { prompt_tokens: number; completion_tokens: number } | null;
    toolCalls?: boolean;
  } = {},
): unknown {
  const shape = llmShape<{
    choices: { message: Record<string, unknown>; finish_reason: string }[];
    usage?: unknown;
    model: string;
  }>('openai-chat-completion');
  const choice = shape.choices[0]!;
  choice.message.content = text;
  if (over.toolCalls) {
    choice.message.tool_calls = [
      { id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } },
    ];
  }
  choice.finish_reason = over.finishReason ?? 'stop';
  if (over.model) shape.model = over.model;
  if (over.usage === null) delete shape.usage;
  else if (over.usage) {
    shape.usage = {
      ...over.usage,
      total_tokens: over.usage.prompt_tokens + over.usage.completion_tokens,
    };
  }
  return shape;
}

/**
 * The `thinking` block of a current Claude model, as the recorded shape (`anthropic-message-thinking`)
 * has it: `text` is empty, as it is while the request does not ask for a summary, and `signature`
 * binds the block to the conversation.
 */
export function anthropicThinking(signature: string, text = ''): unknown {
  return { type: 'thinking', thinking: text, signature };
}

/** The `redacted_thinking` block of a current Claude model: its encrypted thinking, as `data`. */
export function anthropicRedactedThinking(data: string): unknown {
  return { type: 'redacted_thinking', data };
}

/**
 * A Messages API answer (llm.md §2.3) with one text block saying `text`, after the `thinking`
 * blocks of `over.thinking` (a model that thinks puts them first).
 */
export function anthropicAnswer(
  text: string,
  over: {
    stopReason?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number } | null;
    toolUse?: boolean;
    thinking?: readonly unknown[];
  } = {},
): unknown {
  const shape = llmShape<{
    content: unknown[];
    stop_reason: string;
    usage?: unknown;
    model: string;
  }>('anthropic-message');
  shape.content = [...(over.thinking ?? []), { type: 'text', text }];
  if (over.toolUse) shape.content.push({ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} });
  shape.stop_reason = over.stopReason ?? 'end_turn';
  if (over.model) shape.model = over.model;
  if (over.usage === null) delete shape.usage;
  else if (over.usage) shape.usage = over.usage;
  return shape;
}

/**
 * A chat completion whose first choice asks for tool calls (R5), in the API's shape: `content` is
 * `over.text`, or null without it, and `finish_reason` is `tool_calls`. A string `arguments` is
 * the provider's own text and goes out as it is (so a test can send what is not JSON); any other
 * value is JSON-encoded, as the API does.
 */
export function openAiToolCalls(
  calls: { id: string; name: string; arguments: unknown }[],
  over: {
    text?: string;
    model?: string;
    usage?: { prompt_tokens: number; completion_tokens: number } | null;
  } = {},
): unknown {
  const shape = openAiAnswer(over.text ?? '', {
    finishReason: 'tool_calls',
    ...(over.model !== undefined ? { model: over.model } : {}),
    ...(over.usage !== undefined ? { usage: over.usage } : {}),
  }) as { choices: { message: Record<string, unknown> }[] };
  const { message } = shape.choices[0]!;
  message.content = over.text ?? null;
  message.tool_calls = calls.map((call) => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments:
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
    },
  }));
  return shape;
}

/**
 * A Messages API answer (R5) with a `tool_use` block per call, after a text block when
 * `over.text` is given, and after the `thinking` blocks of `over.thinking`; `stop_reason` is
 * `tool_use`.
 */
export function anthropicToolUse(
  calls: { id: string; name: string; input: unknown }[],
  over: {
    text?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number } | null;
    thinking?: readonly unknown[];
  } = {},
): unknown {
  const shape = anthropicAnswer('', {
    stopReason: 'tool_use',
    ...(over.model !== undefined ? { model: over.model } : {}),
    ...(over.usage !== undefined ? { usage: over.usage } : {}),
  }) as { content: unknown[] };
  shape.content = [
    ...(over.thinking ?? []),
    ...(over.text === undefined ? [] : [{ type: 'text', text: over.text }]),
    ...calls.map((call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  ];
  return shape;
}

/**
 * The `reasoning` item of a model that thinks, as the Responses API returns it with
 * `include: ["reasoning.encrypted_content"]`: `encrypted_content` is the provider's own and opaque
 * (it binds the item to its model), and the summary is empty, as none was asked for.
 */
export function responsesReasoning(
  encrypted: string,
  id = `rs_${encrypted.slice(0, 40)}`,
): unknown {
  return { id, type: 'reasoning', summary: [], encrypted_content: encrypted };
}

/**
 * A Responses API answer (the second wire of the OpenAI provider) with one `message` item saying
 * `text`, after the items of `over.reasoning` (a model that thinks puts them first). `over.incomplete`
 * is the reason an answer was cut off (`max_output_tokens`): the status is then `incomplete` and so
 * is its message; with no text no message is written, as when the cut came while it thought.
 * `over.refusal` makes the message a refusal. `over.status` and `over.error` make the failure of an
 * answer; `over.usage` null leaves the usage out.
 */
export function responsesAnswer(
  text: string,
  over: {
    status?: string;
    incomplete?: string;
    error?: unknown;
    refusal?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number } | null;
    reasoning?: readonly unknown[];
  } = {},
): unknown {
  const shape = llmShape<{
    status: string;
    incomplete_details: unknown;
    error: unknown;
    output: Record<string, unknown>[];
    usage?: Record<string, unknown>;
    model: string;
  }>('openai-response');
  const [message] = shape.output;
  shape.status = over.status ?? (over.incomplete === undefined ? 'completed' : 'incomplete');
  if (over.incomplete !== undefined) shape.incomplete_details = { reason: over.incomplete };
  if (over.error !== undefined) shape.error = over.error;
  const part =
    over.refusal === undefined
      ? { type: 'output_text', text, annotations: [], logprobs: [] }
      : { type: 'refusal', refusal: over.refusal };
  const written = text !== '' || over.refusal !== undefined;
  shape.output = [
    ...(over.reasoning ?? []),
    ...(written
      ? [
          {
            ...message,
            status: over.incomplete === undefined ? 'completed' : 'incomplete',
            content: [part],
          },
        ]
      : []),
  ] as Record<string, unknown>[];
  if (over.model) shape.model = over.model;
  if (over.usage === null) delete shape.usage;
  else if (over.usage) {
    shape.usage = {
      ...shape.usage,
      ...over.usage,
      total_tokens: over.usage.input_tokens + over.usage.output_tokens,
    };
  }
  return shape;
}

/**
 * A Responses API answer (R5) with a `function_call` item per call, after the items of
 * `over.reasoning` and a message when `over.text` is given: `call_id` is the call's id and
 * `arguments` JSON text. A string `arguments` is the provider's own text and goes out as it is (so
 * a test can send what is not JSON); any other value is JSON-encoded, as the API does.
 */
export function responsesToolCalls(
  calls: { id: string; name: string; arguments: unknown }[],
  over: {
    text?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number } | null;
    reasoning?: readonly unknown[];
  } = {},
): unknown {
  const shape = responsesAnswer(over.text ?? '', {
    ...(over.model !== undefined ? { model: over.model } : {}),
    ...(over.usage !== undefined ? { usage: over.usage } : {}),
    ...(over.reasoning !== undefined ? { reasoning: over.reasoning } : {}),
  }) as { output: unknown[] };
  shape.output.push(
    ...calls.map((call) => ({
      id: `fc_${call.id}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.name,
      arguments:
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
    })),
  );
  return shape;
}

const DATA_BLOCK = /<<<QUALOR-DATA-([0-9a-f]{32})\n(.*)\nQUALOR-DATA-\1>>>/;

interface DataObject {
  task: 'explain' | 'triage' | 'fix';
  issue: { startLine: number | null; snippet: { startLine: number; lines: string[] } | null };
}

/**
 * The text of the first user message of a request: the `messages` of a chat completion, or the
 * `input` items of a Responses request (a string, or the text of its first part).
 */
function userText(json: unknown): string {
  const body = json as { messages?: unknown; input?: unknown } | null;
  const messages = Array.isArray(body?.messages) ? body.messages : body?.input;
  if (!Array.isArray(messages)) return '';
  const user = (messages as { role?: unknown; content?: unknown }[]).find(
    (m) => typeof m === 'object' && m !== null && m.role === 'user',
  );
  const content = user?.content;
  if (typeof content === 'string') return content;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = (first as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

/** A valid answer for the task of the request's data block (llm.md §6–§8); `{"ok": true}` without one. */
export function cannedModelText(request: RecordedLlmRequest): string {
  const match = DATA_BLOCK.exec(userText(request.json));
  if (!match) return '{"ok": true}';
  let data: DataObject;
  try {
    data = JSON.parse(match[2] ?? '') as DataObject;
  } catch {
    return '{"ok": true}';
  }
  // A block that is not the data object (a test sending something else) answers like none.
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof data.issue !== 'object' ||
    data.issue === null
  ) {
    return '{"ok": true}';
  }
  if (data.task === 'explain') {
    return JSON.stringify({
      summary: 'Loose equality compares after type coercion.',
      explanation:
        'The == operator converts its operands before comparing them, which hides type mistakes.',
      howToFix: 'Use === and convert the value explicitly when a conversion is intended.',
    });
  }
  if (data.task === 'triage') {
    return JSON.stringify({
      verdict: 'likely_true_positive',
      confidence: 'medium',
      reasons: ['The comparison mixes a number with a value of unknown type.'],
    });
  }
  const { startLine, snippet } = data.issue;
  const line =
    snippet && startLine !== null ? snippet.lines[startLine - snippet.startLine] : undefined;
  if (line === undefined || !/[^=!]==(?!=)/.test(line)) {
    return JSON.stringify({
      status: 'not_applicable',
      startLine: startLine ?? 1,
      endLine: startLine ?? 1,
      replacement: [],
      explanation: 'Nothing to change here.',
    });
  }
  return JSON.stringify({
    status: 'fixed',
    startLine,
    endLine: startLine,
    replacement: [line.replace(/([^=!])==(?!=)/, '$1===')],
    explanation: 'Use strict equality.',
  });
}

/**
 * Where a Messages request holds what the real API refuses: a text block that is empty or only
 * whitespace (a message given as a string too), or a message with no content. Null when it holds
 * neither.
 */
function blankTextProblem(json: unknown): string | null {
  const messages = (json as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return null;
  for (const [i, message] of (messages as ({ content?: unknown } | null)[]).entries()) {
    const content = message?.content;
    if (typeof content === 'string') {
      if (content.trim() === '') {
        return `messages.${i}: text content blocks must contain non-whitespace text`;
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (content.length === 0) return `messages.${i}: all messages must have non-empty content`;
    for (const [j, block] of (content as ({ type?: unknown; text?: unknown } | null)[]).entries()) {
      if (block?.type === 'text' && (typeof block.text !== 'string' || block.text.trim() === '')) {
        return `messages.${i}.content.${j}.text: text content blocks must contain non-whitespace text`;
      }
    }
  }
  return null;
}

/**
 * The 400 of a request whose output limit is above the cap of its model, in the words of its API
 * (Anthropic's; OpenAI's chat completions for the field it asked in; and the Responses API's, in the
 * words of its own validator for a number above its maximum), or null when there is no cap for the
 * model or the limit is within it.
 */
function outputCapProblem(
  caps: Record<string, number> | undefined,
  wire: Wire,
  json: unknown,
): unknown {
  if (caps === undefined || typeof json !== 'object' || json === null) return null;
  const request = json as Record<string, unknown>;
  const model = request.model;
  if (typeof model !== 'string' || !Object.hasOwn(caps, model)) return null;
  const cap = caps[model]!;
  const field =
    wire === 'anthropic'
      ? 'max_tokens'
      : wire === 'responses'
        ? 'max_output_tokens'
        : ['max_tokens', 'max_completion_tokens'].find((name) => typeof request[name] === 'number');
  const asked = field === undefined ? undefined : request[field];
  if (field === undefined || typeof asked !== 'number' || asked <= cap) return null;
  if (wire === 'anthropic') {
    return {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `max_tokens: ${asked} > ${cap}, which is the maximum allowed number of output tokens for ${model}`,
      },
    };
  }
  if (wire === 'responses') {
    return {
      error: {
        message: `Invalid 'max_output_tokens': integer above maximum value. Expected a value <= ${cap}, but got ${asked} instead.`,
        type: 'invalid_request_error',
        param: 'max_output_tokens',
        code: 'integer_above_max_value',
      },
    };
  }
  return {
    error: {
      message: `${field} is too large: ${asked}. This model supports at most ${cap} completion tokens, whereas you provided ${asked}.`,
      type: 'invalid_request_error',
      param: field,
      code: null,
    },
  };
}

/** The 400 body of the OpenAI APIs: a message, the parameter it is about, and its code. */
const openAiProblem = (message: string, param: string | null, code: string | null): unknown => ({
  error: { message, type: 'invalid_request_error', param, code },
});

/**
 * The 400 of a server that does not stream, to a request that asks it to, in the words of each API:
 * a Chat Completions server that does not know `stream_options` names it as the parameter, the
 * Responses API names `stream`, and the Messages API, which names no parameter, says it of
 * `stream` in its message.
 */
function streamRefusal(wire: Wire): unknown {
  if (wire === 'anthropic') {
    return {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'stream: Extra inputs are not permitted' },
    };
  }
  return wire === 'responses'
    ? openAiProblem("Unsupported parameter: 'stream'.", 'stream', 'unsupported_parameter')
    : openAiProblem(
        'Unrecognized request argument supplied: stream_options',
        'stream_options',
        null,
      );
}

/**
 * What the real Responses API refuses that a client can get wrong, as it words it, or null when the
 * request holds none of it: a limit below 16 tokens; an assistant message whose parts are not
 * `output_text` or `refusal` (`input_text` is the user's); and a `function_call_output` for a call that
 * is not in the input.
 */
function responsesProblem(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return null;
  const request = json as { max_output_tokens?: unknown; input?: unknown };
  const limit = request.max_output_tokens;
  if (typeof limit === 'number' && limit < 16) {
    return openAiProblem(
      `Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got ${limit} instead.`,
      'max_output_tokens',
      'integer_below_min_value',
    );
  }
  if (!Array.isArray(request.input)) return null;
  const items = request.input as ({
    type?: unknown;
    role?: unknown;
    content?: unknown;
    call_id?: unknown;
  } | null)[];
  const calls = new Set<unknown>();
  for (const [i, item] of items.entries()) {
    if (item?.type === 'function_call') calls.add(item.call_id);
    if (item?.type === 'function_call_output' && !calls.has(item.call_id)) {
      return openAiProblem(
        `No tool call found for function call output with call_id ${String(item.call_id)}.`,
        'input',
        null,
      );
    }
    if (item?.role === 'assistant' && Array.isArray(item.content)) {
      for (const [j, part] of (item.content as ({ type?: unknown } | null)[]).entries()) {
        if (part?.type !== 'output_text' && part?.type !== 'refusal') {
          return openAiProblem(
            `Invalid value: '${String(part?.type)}'. Supported values are: 'output_text' and 'refusal'.`,
            `input[${i}].content[${j}]`,
            'invalid_value',
          );
        }
      }
    }
  }
  return null;
}

/**
 * The 400 of a Responses request that asks for JSON mode (`text.format` of type `json_object`) when
 * no text of its `input` says json, as the Responses API refuses it: its `instructions` do not
 * count (probed live on 2026-10-26 with the newest models). Null for a request that asks for no
 * JSON mode, or whose input says it.
 */
function jsonWordProblem(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return null;
  const { text, input } = json as {
    text?: { format?: { type?: unknown } };
    input?: unknown;
  };
  if (text?.format?.type !== 'json_object') return null;
  const words: string[] = [];
  const items: unknown[] = Array.isArray(input) ? input : [];
  for (const item of items as ({ content?: unknown; output?: unknown } | null)[]) {
    if (typeof item?.output === 'string') words.push(item.output);
    if (typeof item?.content === 'string') words.push(item.content);
    if (Array.isArray(item?.content)) {
      for (const part of item.content as ({ text?: unknown } | null)[]) {
        if (typeof part?.text === 'string') words.push(part.text);
      }
    }
  }
  if (/json/i.test(words.join('\n'))) return null;
  return openAiProblem(
    "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.",
    'input',
    null,
  );
}

/**
 * The 400 of a chat completion that carries function tools for a model that takes them only through
 * the Responses API (`models`), in the words OpenAI uses for it; null for another model, and for a
 * request without tools.
 */
function chatToolsProblem(models: readonly string[] | undefined, json: unknown): unknown {
  if (models === undefined || typeof json !== 'object' || json === null) return null;
  const { model, tools } = json as { model?: unknown; tools?: unknown };
  if (typeof model !== 'string' || !models.includes(model)) return null;
  if (!Array.isArray(tools) || tools.length === 0) return null;
  return openAiProblem(
    `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`,
    null,
    null,
  );
}

/** A value without its `cache_control` keys, wherever they are. */
function withoutMarks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMarks);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, inner]) => [key, withoutMarks(inner)]),
  );
}

const hasMark = (block: unknown): boolean =>
  typeof block === 'object' && block !== null && 'cache_control' in block;

/**
 * Where a Messages request carries a prompt-cache marker first, as the API names a field (`system.0`,
 * `messages.2.content.1`, `tools.0`, or the top of the request); null when it carries none.
 */
function cacheControlPath(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const request = json as { system?: unknown; messages?: unknown; tools?: unknown };
  if ('cache_control' in request) return '';
  const markedIn = (blocks: unknown, at: string): string | null => {
    const i = Array.isArray(blocks) ? (blocks as unknown[]).findIndex(hasMark) : -1;
    return i === -1 ? null : `${at}.${i}`;
  };
  const inSystem = markedIn(request.system, 'system') ?? markedIn(request.tools, 'tools');
  if (inSystem !== null) return inSystem;
  const messages = Array.isArray(request.messages) ? (request.messages as unknown[]) : [];
  for (const [i, message] of messages.entries()) {
    const found = markedIn(
      (message as { content?: unknown } | null)?.content,
      `messages.${i}.content`,
    );
    if (found !== null) return found;
  }
  return null;
}

/**
 * One part of a prompt, in the order a provider caches it: its text without markers, whether it is
 * marked, and its type when it is a block of a run that counts as one position for the lookback
 * (`tool_use`, `tool_result`).
 */
interface PromptPart {
  text: string;
  marked: boolean;
  run?: string;
}

/**
 * The parts of a request in the order its provider caches them: the tools, then the system prompt
 * (one text block, whether it came as a string or as blocks), then every block of every message
 * (Messages API) or every message or input item (the OpenAI wires).
 */
function promptParts(wire: Wire, json: unknown): PromptPart[] {
  if (typeof json !== 'object' || json === null) return [];
  const request = json as {
    tools?: unknown;
    system?: unknown;
    instructions?: unknown;
    messages?: unknown;
    input?: unknown;
  };
  const part = (value: unknown, marked = false, run?: string): PromptPart => ({
    text: JSON.stringify(withoutMarks(value)),
    marked,
    ...(run === undefined ? {} : { run }),
  });
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);
  const parts = list(request.tools).map((tool) => part(['tool', tool], hasMark(tool)));
  if (wire !== 'anthropic') {
    if (typeof request.instructions === 'string')
      parts.push(part(['system', request.instructions]));
    const items = wire === 'responses' ? request.input : request.messages;
    return [...parts, ...list(items).map((item) => part(['item', item]))];
  }
  const system = request.system;
  if (typeof system === 'string') parts.push(part(['system', { type: 'text', text: system }]));
  for (const block of list(system)) parts.push(part(['system', block], hasMark(block)));
  for (const [i, raw] of list(request.messages).entries()) {
    const message = (raw ?? {}) as { role?: unknown; content?: unknown };
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : list(message.content);
    for (const block of blocks) {
      const type = (block as { type?: unknown } | null)?.type;
      const run = type === 'tool_use' || type === 'tool_result' ? type : undefined;
      parts.push(part(['message', i, message.role, block], hasMark(block), run));
    }
  }
  return parts;
}

/**
 * How far back from a marked block the Messages API looks for an entry an earlier call wrote, in
 * positions: a run of `tool_use` blocks is one, and so is a run of `tool_result` blocks.
 */
const CACHE_LOOKBACK_POSITIONS = 20;

/**
 * A provider's prompt cache, for the fake: the prefixes it holds, each keyed by the model and the
 * hash of the request's parts up to and including its last one, markers stripped.
 * - The Messages API reads the longest prefix ending at or up to 20 positions before a marked part that
 *   an earlier call wrote, and writes the prefix up to each marked part: a hit reads a quarter of
 *   that prefix's characters (`cache_read_input_tokens`), and the call writes the rest up to its
 *   last marker (`cache_creation_input_tokens`). A request without markers reads and writes nothing.
 * - The OpenAI wires read the longest earlier request whose parts this one starts with, at a quarter
 *   of its characters (`cached_tokens`), and keep every request; nothing is marked.
 */
function promptCache(): (wire: Wire, json: unknown) => { read: number; written: number } {
  const held = new Set<string>();
  return (wire, json) => {
    const model = String((json as { model?: unknown } | null)?.model ?? '');
    const parts = promptParts(wire, json);
    const keys: string[] = [];
    const chars: number[] = [];
    const positions: number[] = [];
    let hash = createHash('sha256').update(`${wire}\n${model}`).digest('hex');
    let length = 0;
    for (const [at, part] of parts.entries()) {
      hash = createHash('sha256').update(`${hash}\n${part.text}`).digest('hex');
      length += part.text.length;
      keys.push(hash);
      chars.push(length);
      const sameRun = part.run !== undefined && parts[at - 1]?.run === part.run;
      positions.push((positions.at(-1) ?? -1) + (sameRun ? 0 : 1));
    }
    const tokens = (at: number): number => (at < 0 ? 0 : Math.ceil((chars[at] ?? 0) / 4));
    if (wire !== 'anthropic') {
      let hit = -1;
      for (const [at, key] of keys.entries()) if (held.has(key)) hit = at;
      const last = keys.at(-1);
      if (last !== undefined) held.add(last);
      return { read: tokens(hit), written: 0 };
    }
    const marks = parts.flatMap((part, at) => (part.marked ? [at] : []));
    let hit = -1;
    for (const mark of marks) {
      const from = positions[mark]! - CACHE_LOOKBACK_POSITIONS;
      for (let at = mark; at >= 0 && positions[at]! >= from; at -= 1) {
        if (held.has(keys[at]!)) {
          hit = Math.max(hit, at);
          break;
        }
      }
    }
    const last = marks.at(-1);
    for (const mark of marks) held.add(keys[mark]!);
    const read = tokens(hit);
    return { read, written: last === undefined || last <= hit ? 0 : tokens(last) - read };
  };
}

/** `body`'s usage with what the prompt cache did for the request, in the words of its API. */
function withCacheUsage(
  wire: Wire,
  body: Record<string, unknown>,
  { read, written }: { read: number; written: number },
): Record<string, unknown> {
  const usage = body.usage;
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return body;
  const counts = usage as Record<string, unknown>;
  const atLeast = (value: unknown) => (typeof value === 'number' ? Math.max(value, read) : value);
  if (wire === 'anthropic') {
    return {
      ...body,
      usage: { ...counts, cache_creation_input_tokens: written, cache_read_input_tokens: read },
    };
  }
  const [field, details] =
    wire === 'responses'
      ? (['input_tokens', 'input_tokens_details'] as const)
      : (['prompt_tokens', 'prompt_tokens_details'] as const);
  const before = counts[details];
  return {
    ...body,
    usage: {
      ...counts,
      // The prompt's count holds the cached part.
      [field]: atLeast(counts[field]),
      [details]: {
        ...(typeof before === 'object' && before !== null ? before : {}),
        cached_tokens: read,
      },
    },
  };
}

export interface FakeLlm {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The `openai` base URL (`<url>/v1`). */
  openAiBaseUrl: string;
  /** The `anthropic` base URL (`<url>`). */
  anthropicBaseUrl: string;
  /** `127.0.0.1:<port>`, for `QUALOR_LLM_INTERNAL_HOSTS`. */
  host: string;
  /** The key the fake expects; '' when it expects none. */
  apiKey: string;
  requests: RecordedLlmRequest[];
  /** The requests whose caller hung up before they were answered, in the order they hung up. */
  abandoned: RecordedLlmRequest[];
  /** Replies (or responders) for the next requests, first in first out. */
  enqueue(...replies: (LlmReply | LlmResponder)[]): void;
  /** The model's text for the next answers, in the shape of the path asked. */
  say(...texts: string[]): void;
  close(): Promise<void>;
}

/**
 * A local provider on 127.0.0.1 answering `POST /v1/chat/completions` and `POST /v1/responses`
 * (OpenAI, key as `Authorization: Bearer` or Azure's `api-key`) and `POST /v1/messages`
 * (Anthropic, `x-api-key` and `anthropic-version: 2023-06-01`). It records every request, bodies
 * included; scripted replies are served first, else a canned answer for the request's data block.
 * Nothing here ever calls a real model.
 *
 * With `workspaceId` its key is an organisation-wide one: an Anthropic request must name that
 * workspace in `anthropic-workspace-id`, or it is refused with a 400 saying the key is not scoped
 * to a workspace (a request naming another one, with a 403). With `refuseBlankText` an Anthropic
 * request is refused with a 400, as the real API does, when a text block is empty or only
 * whitespace, or a message has no content. With `outputCaps` (a model's name, and the most output
 * tokens it takes) a request whose limit is above the cap of its model is refused with a 400, in the
 * words of its API, and takes no scripted reply. With `toolsOnlyThroughResponses` (model names) a
 * chat completion that carries function tools for one of them is refused with a 400, in the words
 * OpenAI uses for the models that take them only through the Responses API, and takes no scripted
 * reply. A Responses request is always refused with a 400 for what the real API refuses of it: a
 * limit below 16 tokens, an assistant message of `input_text`, and an output for a call that was not
 * made, and one that asks for JSON mode when the word json is nowhere in its `input` (its
 * instructions do not count).
 *
 * A request that asks for a stream (`stream: true`) is answered with the events its API sends for
 * the answer it would have had (see LlmReply), in pieces. With `refuseStream` it is refused instead,
 * with a 400 in the words of a server that does not stream (`streamRefusal`), and takes no
 * scripted reply: the request asked again without the stream takes it. With `ignoreStream` it is
 * answered as a request that does not ask for a stream, whole, as JSON: a server that ignores it.
 *
 * R49: with `promptCache` the answers report what a provider's prompt cache did for the request
 * (`promptCache`, `withCacheUsage`): Anthropic's `cache_read_input_tokens` and
 * `cache_creation_input_tokens` (its `input_tokens` stays the scripted count, the uncached rest),
 * OpenAI's `cached_tokens` (its prompt count raised to hold them). Without it nothing of a cache is
 * reported. With `refuseCacheControl` it is an Anthropic-compatible gateway that takes no markers:
 * a Messages request that carries one is refused with a 400 naming it, and takes no scripted reply.
 */
export async function createFakeLlm(
  options: {
    apiKey?: string | null;
    workspaceId?: string;
    refuseBlankText?: boolean;
    outputCaps?: Record<string, number>;
    toolsOnlyThroughResponses?: readonly string[];
    refuseStream?: boolean;
    ignoreStream?: boolean;
    promptCache?: boolean;
    refuseCacheControl?: boolean;
  } = {},
): Promise<FakeLlm> {
  const apiKey =
    options.apiKey === null
      ? ''
      : (options.apiKey ?? ['fake', 'llm', 'key', '0123456789'].join('-'));
  const requests: RecordedLlmRequest[] = [];
  const abandoned: RecordedLlmRequest[] = [];
  const queue: (LlmReply | LlmResponder | { say: string })[] = [];
  const cache = options.promptCache === true ? promptCache() : null;

  const shaped = (request: RecordedLlmRequest, text: string): LlmReply => ({
    status: 200,
    body:
      request.path === '/v1/messages'
        ? anthropicAnswer(text)
        : request.path === '/v1/responses'
          ? responsesAnswer(text)
          : openAiAnswer(text),
  });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        const request: RecordedLlmRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body,
          json,
        };
        requests.push(request);
        // The connection closed before the answer was written: the caller gave up on it.
        res.on('close', () => {
          if (!res.writableFinished) abandoned.push(request);
        });
        const send = (reply: LlmReply): void => {
          const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
          setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
            res.end(text);
          }, reply.delayMs ?? 0);
        };
        const anthropic = request.path === '/v1/messages';
        const wire: Wire = anthropic
          ? 'anthropic'
          : request.path === '/v1/responses'
            ? 'responses'
            : 'chat';
        const streamed =
          (json as { stream?: unknown } | null)?.stream === true && options.ignoreStream !== true;
        /**
         * A scripted or canned answer: to a request that streams, the events of its body, written
         * at once unless the reply has a delay (no timer to move for a test that fakes them).
         */
        const answer = (given: LlmReply): void => {
          const own = given.headers?.['content-type']?.startsWith('text/event-stream') === true;
          const ok = given.status >= 200 && given.status < 300;
          const reply =
            cache !== null && ok && !own && typeof given.body === 'object' && given.body !== null
              ? {
                  ...given,
                  body: withCacheUsage(
                    wire,
                    given.body as Record<string, unknown>,
                    cache(wire, json),
                  ),
                }
              : given;
          if (!streamed || own || !ok) return send(reply);
          const fault = reply.stream ?? {};
          const write = (): void => {
            if (res.destroyed) return;
            res.writeHead(reply.status, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              ...reply.headers,
            });
            res.flushHeaders();
            if (fault.silent === true) return;
            for (const piece of streamPieces(eventStream(wire, reply.body, fault)))
              res.write(piece);
            res.end();
          };
          if (reply.delayMs === undefined) write();
          else setTimeout(write, reply.delayMs);
        };
        const error = llmShape(anthropic ? 'anthropic-error' : 'openai-error');
        if (size > MAX_BODY) return send({ status: 413, body: error });
        if (
          request.method !== 'POST' ||
          (wire === 'chat' && request.path !== '/v1/chat/completions')
        ) {
          return send({ status: 404, body: error });
        }
        const key = anthropic
          ? req.headers['x-api-key']
          : (req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers['api-key']);
        if (apiKey === '') {
          // A provider without a key (a local model): a key header sent anyway is a client bug.
          const sent = ['authorization', 'api-key', 'x-api-key'].some((h) => h in req.headers);
          if (sent) return send({ status: 400, body: error });
        } else if (key !== apiKey) {
          return send({ status: 401, body: error });
        }
        if (anthropic && req.headers['anthropic-version'] !== '2023-06-01') {
          return send({ status: 400, body: error });
        }
        if (anthropic && options.workspaceId !== undefined) {
          const named = req.headers['anthropic-workspace-id'];
          if (named === undefined) {
            return send({
              status: 400,
              body: {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message:
                    'Fake error text: this API key is not scoped to a workspace; name one with the anthropic-workspace-id header.',
                },
              },
            });
          }
          if (named !== options.workspaceId) return send({ status: 403, body: error });
        }
        if (anthropic && options.refuseBlankText === true) {
          const blank = blankTextProblem(json);
          if (blank !== null) {
            return send({
              status: 400,
              body: { type: 'error', error: { type: 'invalid_request_error', message: blank } },
            });
          }
        }
        if (streamed && options.refuseStream === true) {
          return send({ status: 400, body: streamRefusal(wire) });
        }
        const markedAt =
          anthropic && options.refuseCacheControl === true ? cacheControlPath(json) : null;
        if (markedAt !== null) {
          const field = markedAt === '' ? 'cache_control' : `${markedAt}.cache_control`;
          return send({
            status: 400,
            body: {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: `${field}: Extra inputs are not permitted`,
              },
            },
          });
        }
        const refused =
          wire === 'responses'
            ? (responsesProblem(json) ?? jsonWordProblem(json))
            : wire === 'chat'
              ? chatToolsProblem(options.toolsOnlyThroughResponses, json)
              : null;
        if (refused !== null) return send({ status: 400, body: refused });
        const capped = outputCapProblem(options.outputCaps, wire, json);
        if (capped !== null) return send({ status: 400, body: capped });
        const next = queue.shift();
        try {
          if (next === undefined) return answer(shaped(request, cannedModelText(request)));
          if (typeof next === 'function') return answer(await next(request));
          if ('say' in next) return answer(shaped(request, next.say));
          return answer(next);
        } catch {
          // A throwing responder answers 500 instead of leaving the request hanging.
          return send({ status: 500, body: error });
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    openAiBaseUrl: `${url}/v1`,
    anthropicBaseUrl: url,
    host: `127.0.0.1:${port}`,
    apiKey,
    requests,
    abandoned,
    enqueue: (...replies) => {
      queue.push(...replies);
    },
    say: (...texts) => {
      queue.push(...texts.map((say) => ({ say })));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
