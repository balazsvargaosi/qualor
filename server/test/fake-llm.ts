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

const DATA_BLOCK = /<<<QUALOR-DATA-([0-9a-f]{32})\n(.*)\nQUALOR-DATA-\1>>>/;

interface DataObject {
  task: 'explain' | 'triage' | 'fix';
  issue: { startLine: number | null; snippet: { startLine: number; lines: string[] } | null };
}

function userText(json: unknown): string {
  const messages = (json as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return '';
  const user = (messages as { role?: unknown; content?: unknown }[]).find(
    (m) => typeof m === 'object' && m !== null && m.role === 'user',
  );
  return typeof user?.content === 'string' ? user.content : '';
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
 * A local provider on 127.0.0.1 answering `POST /v1/chat/completions` (OpenAI-compatible, key as
 * `Authorization: Bearer` or Azure's `api-key`) and `POST /v1/messages` (Anthropic, `x-api-key`
 * and `anthropic-version: 2023-06-01`). It records every request; scripted replies are served
 * first, else a canned answer for the request's data block. Nothing here ever calls a real model.
 *
 * With `workspaceId` its key is an organisation-wide one: an Anthropic request must name that
 * workspace in `anthropic-workspace-id`, or it is refused with a 400 saying the key is not scoped
 * to a workspace (a request naming another one, with a 403).
 */
export async function createFakeLlm(
  options: { apiKey?: string | null; workspaceId?: string } = {},
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
    body: request.path === '/v1/messages' ? anthropicAnswer(text) : openAiAnswer(text),
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
        const error = llmShape(anthropic ? 'anthropic-error' : 'openai-error');
        if (size > MAX_BODY) return send({ status: 413, body: error });
        if (request.method !== 'POST' || (!anthropic && request.path !== '/v1/chat/completions')) {
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
