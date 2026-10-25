import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
export interface LlmReply {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  delayMs?: number;
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

/** The three wires of the fake: Messages, chat completions and Responses. */
type Wire = 'anthropic' | 'chat' | 'responses';

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
    `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. Please use /v1/responses or set reasoning_effort to 'none'.`,
    null,
    null,
  );
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
 */
export async function createFakeLlm(
  options: {
    apiKey?: string | null;
    workspaceId?: string;
    refuseBlankText?: boolean;
    outputCaps?: Record<string, number>;
    toolsOnlyThroughResponses?: readonly string[];
  } = {},
): Promise<FakeLlm> {
  const apiKey =
    options.apiKey === null
      ? ''
      : (options.apiKey ?? ['fake', 'llm', 'key', '0123456789'].join('-'));
  const requests: RecordedLlmRequest[] = [];
  const abandoned: RecordedLlmRequest[] = [];
  const queue: (LlmReply | LlmResponder | { say: string })[] = [];

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
          if (next === undefined) return send(shaped(request, cannedModelText(request)));
          if (typeof next === 'function') return send(await next(request));
          if ('say' in next) return send(shaped(request, next.say));
          return send(next);
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
