/*
 * The event streams of the fake provider (fake-llm.ts): a request that asks for a stream
 * (`stream: true`) is answered with the events its API sends for the answer the fake would have
 * given it whole, written from the public API references (Chat Completions' chunks, the Messages
 * API's events, the Responses API's events). The texts, the thinking and the arguments come in
 * several deltas, one of them cut between the two halves of a character outside the Basic
 * Multilingual Plane when there is one, and the stream is written in pieces, one of them cut inside
 * a character of more than one byte when there is one: what a network may do to a stream.
 */

/** The three wires of the fake: Messages, Chat Completions and Responses. */
export type Wire = 'anthropic' | 'chat' | 'responses';

/** What can go wrong with a stream, besides its answer: the faults a test asks the fake for. */
export interface StreamFault {
  /**
   * An error event after the 200 and the first event of the stream, which ends with it: `type` is
   * the error's type (Anthropic's `overloaded_error`, OpenAI's `server_error`, …), as its API puts
   * it in the event.
   */
  error?: { type: string; message?: string };
  /** The stream ends without its terminator: `[DONE]`, `message_stop`, the response's end. */
  cut?: boolean;
  /** The status line, and nothing after it: the provider goes silent. */
  silent?: boolean;
  /** No usage anywhere in the stream, whatever the answer counts. */
  noUsage?: boolean;
}

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;

/**
 * `text` as the deltas of a stream: cut at its thirds, and between the two halves of the first
 * character outside the Basic Multilingual Plane when it has one. An empty text has no delta.
 */
export function deltasOf(text: string): string[] {
  if (text === '') return [];
  const cuts = new Set([Math.ceil(text.length / 3), Math.ceil((2 * text.length) / 3)]);
  const pair = /[\ud800-\udbff][\udc00-\udfff]/.exec(text);
  if (pair) cuts.add(pair.index + 1);
  const at = [0, ...[...cuts].filter((cut) => cut > 0 && cut < text.length).sort((a, b) => a - b)];
  return at.map((from, i) => text.slice(from, at[i + 1] ?? text.length));
}

/** One event of a stream: its type when the API names it (`event:`), and its data as JSON. */
const sse = (data: unknown, type?: string): string => {
  const named = type === undefined ? '' : `event: ${type}\n`;
  return `${named}data: ${JSON.stringify(data)}\n\n`;
};

/** The error event of each API, and the fault's type in it. */
function errorEvent(wire: Wire, error: NonNullable<StreamFault['error']>): string {
  const message = error.message ?? 'Fake error text; never logged or shown.';
  if (wire === 'anthropic') {
    return sse({ type: 'error', error: { type: error.type, message } }, 'error');
  }
  if (wire === 'responses') {
    return sse({ type: 'error', code: error.type, message, param: null }, 'error');
  }
  return sse({ error: { message, type: error.type, param: null, code: null } });
}

/**
 * The chunks of the message's tool calls: each call's id and name first, then the deltas of the
 * arguments, the calls taking turns.
 */
function toolCallChunks(message: Json, chunk: (delta: Json) => string): string[] {
  const events: string[] = [];
  const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
  const pieces = calls.map((raw, index) => {
    const call = asRecord(raw) ?? {};
    const fn = asRecord(call.function) ?? {};
    const { arguments: args, ...rest } = fn;
    const head: Json = { index };
    for (const key of ['id', 'type']) if (key in call) head[key] = call[key];
    head.function = {
      ...rest,
      ...(args === undefined ? {} : { arguments: typeof args === 'string' ? '' : args }),
    };
    events.push(chunk({ tool_calls: [head] }));
    return typeof args === 'string' ? deltasOf(args) : [];
  });
  for (let turn = 0; pieces.some((left) => left.length > turn); turn += 1) {
    for (const [index, left] of pieces.entries()) {
      const piece = left[turn];
      if (piece !== undefined) {
        events.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
      }
    }
  }
  return events;
}

/**
 * The chunks of a chat completion, from the completion `body`: the role first, then the deltas of
 * the content and of a refusal, then each call's id and name with the deltas of its arguments,
 * the arguments of the calls taking turns (a stream may interleave them; their `index` tells them
 * apart), the finish reason, the usage alone in a chunk of no choices, and `[DONE]`. Every chunk
 * but the usage's has `usage: null`, as OpenAI writes them when the usage is asked for.
 */
function chatEvents(body: Json, fault: StreamFault): { events: string[]; end: string } {
  const meta: Json = { object: 'chat.completion.chunk' };
  for (const key of ['id', 'created', 'model', 'system_fingerprint']) {
    if (key in body) meta[key] = body[key];
  }
  const usage = fault.noUsage === true ? {} : { usage: null };
  const chunk = (delta: Json, finish: unknown = null): string =>
    sse({
      ...meta,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
      ...usage,
    });
  const choices = Array.isArray(body.choices) ? (body.choices as unknown[]) : [];
  const choice = asRecord(choices[0]) ?? {};
  const message = asRecord(choice.message) ?? {};
  const { content, refusal } = message;
  const events = [
    chunk({
      role: 'assistant',
      ...('content' in message ? { content: typeof content === 'string' ? '' : content } : {}),
    }),
  ];
  if (typeof content === 'string') {
    events.push(...deltasOf(content).map((piece) => chunk({ content: piece })));
  }
  if (typeof refusal === 'string') {
    events.push(...(refusal === '' ? [''] : deltasOf(refusal)).map((r) => chunk({ refusal: r })));
  }
  events.push(...toolCallChunks(message, chunk));
  events.push(chunk({}, choice.finish_reason ?? null));
  if (fault.noUsage !== true && body.usage !== undefined) {
    events.push(sse({ ...meta, choices: [], usage: body.usage }));
  }
  return { events, end: 'data: [DONE]\n\n' };
}

/** A content block's start, its deltas and its stop. */
function blockEvents(raw: unknown, index: number): string[] {
  const block = asRecord(raw) ?? {};
  const delta = (part: Json): string =>
    sse({ type: 'content_block_delta', index, delta: part }, 'content_block_delta');
  let start: Json = block;
  const deltas: string[] = [];
  if (block.type === 'text' && typeof block.text === 'string') {
    start = { ...block, text: '' };
    deltas.push(...deltasOf(block.text).map((text) => delta({ type: 'text_delta', text })));
  } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
    start = {
      ...block,
      thinking: '',
      ...(typeof block.signature === 'string' ? { signature: '' } : {}),
    };
    deltas.push(
      ...deltasOf(block.thinking).map((thinking) => delta({ type: 'thinking_delta', thinking })),
    );
    if (typeof block.signature === 'string' && block.signature !== '') {
      deltas.push(delta({ type: 'signature_delta', signature: block.signature }));
    }
  } else if (block.type === 'tool_use' && block.input !== undefined) {
    start = { ...block, input: {} };
    deltas.push(
      delta({ type: 'input_json_delta', partial_json: '' }),
      ...deltasOf(JSON.stringify(block.input)).map((partial_json) =>
        delta({ type: 'input_json_delta', partial_json }),
      ),
    );
  }
  return [
    sse({ type: 'content_block_start', index, content_block: start }, 'content_block_start'),
    ...deltas,
    sse({ type: 'content_block_stop', index }, 'content_block_stop'),
  ];
}

/**
 * The events of a Messages API answer, from the message `body`: `message_start` with the message
 * and no content (its output count is 1, as the API's is, and the count comes in `message_delta`),
 * a `ping`, then each block's start, deltas and stop (a text's `text_delta`s, a thinking block's
 * `thinking_delta`s and its `signature_delta`, a call's `input_json_delta`s of its input as JSON;
 * any other block whole in its start), `message_delta` with the stop reason and the output count,
 * and `message_stop`.
 */
function anthropicEvents(body: Json, fault: StreamFault): { events: string[]; end: string } {
  const { content, stop_reason, stop_sequence, usage, ...message } = body;
  const counted = asRecord(usage);
  const startUsage =
    fault.noUsage === true || usage === undefined
      ? {}
      : {
          usage:
            counted !== null && 'output_tokens' in counted
              ? { ...counted, output_tokens: 1 }
              : usage,
        };
  const events = [
    sse(
      {
        type: 'message_start',
        message: { ...message, content: [], stop_reason: null, stop_sequence: null, ...startUsage },
      },
      'message_start',
    ),
    sse({ type: 'ping' }, 'ping'),
  ];
  const blocks = Array.isArray(content) ? (content as unknown[]) : [];
  for (const [index, raw] of blocks.entries()) events.push(...blockEvents(raw, index));
  events.push(
    sse(
      {
        type: 'message_delta',
        delta: { stop_reason, ...(stop_sequence === undefined ? {} : { stop_sequence }) },
        ...(fault.noUsage !== true && counted !== null && 'output_tokens' in counted
          ? { usage: { output_tokens: counted.output_tokens } }
          : {}),
      },
      'message_delta',
    ),
  );
  return { events, end: sse({ type: 'message_stop' }, 'message_stop') };
}

type ResponseEvent = (type: string, data: Json) => string;

/** The terminator of a response with this status. */
function terminatorOf(status: unknown): string {
  if (status === 'incomplete') return 'response.incomplete';
  return status === 'failed' ? 'response.failed' : 'response.completed';
}

/** A message part's added, deltas, done and part done. */
function partEvents(rawPart: unknown, at: Json, event: ResponseEvent): string[] {
  const piece = asRecord(rawPart) ?? {};
  const kind = piece.type === 'refusal' ? 'refusal' : 'output_text';
  const field = kind === 'refusal' ? 'refusal' : 'text';
  const text = typeof piece[field] === 'string' ? (piece[field] as string) : '';
  return [
    event('response.content_part.added', { ...at, part: { ...piece, [field]: '' } }),
    ...deltasOf(text).map((delta) =>
      event(`response.${kind}.delta`, {
        ...at,
        delta,
        ...(kind === 'refusal' ? {} : { logprobs: [] }),
      }),
    ),
    event(`response.${kind}.done`, { ...at, [field]: text }),
    event('response.content_part.done', { ...at, part: piece }),
  ];
}

/** An output item's added, what it streams (a message's parts, a call's arguments) and done. */
function itemEvents(item: Json, index: number, event: ResponseEvent): string[] {
  const where = { item_id: item.id, output_index: index };
  const events: string[] = [];
  if (item.type === 'message' && Array.isArray(item.content)) {
    events.push(
      event('response.output_item.added', {
        output_index: index,
        item: { ...item, status: 'in_progress', content: [] },
      }),
    );
    for (const [part, rawPart] of (item.content as unknown[]).entries()) {
      events.push(...partEvents(rawPart, { ...where, content_index: part }, event));
    }
  } else if (item.type === 'function_call' && typeof item.arguments === 'string') {
    events.push(
      event('response.output_item.added', {
        output_index: index,
        item: { ...item, status: 'in_progress', arguments: '' },
      }),
    );
    for (const delta of deltasOf(item.arguments)) {
      events.push(event('response.function_call_arguments.delta', { ...where, delta }));
    }
    events.push(
      event('response.function_call_arguments.done', { ...where, arguments: item.arguments }),
    );
  } else {
    events.push(event('response.output_item.added', { output_index: index, item }));
  }
  events.push(event('response.output_item.done', { output_index: index, item }));
  return events;
}

/**
 * The events of a Responses API answer, from the response `body`: `response.created` and
 * `response.in_progress` with the response as it starts (no output, no usage); for each output item
 * its `response.output_item.added`, then for a message each part's added, deltas, done and part
 * done, and for a call the deltas and the done of its arguments, then `response.output_item.done`
 * with the whole item; and last the terminator of the response's status, which carries the whole
 * response: `response.completed`, `response.incomplete` or `response.failed`.
 */
function responsesEvents(body: Json, fault: StreamFault): { events: string[]; end: string } {
  let sequence = 0;
  const event: ResponseEvent = (type, data) => {
    const sequenceNumber = sequence;
    sequence += 1;
    return sse({ type, sequence_number: sequenceNumber, ...data }, type);
  };
  const started = {
    ...body,
    status: 'in_progress',
    output: [],
    usage: null,
    error: null,
    incomplete_details: null,
  };
  const events = [
    event('response.created', { response: started }),
    event('response.in_progress', { response: started }),
  ];
  const output = Array.isArray(body.output) ? (body.output as unknown[]) : [];
  for (const [index, raw] of output.entries()) {
    events.push(...itemEvents(asRecord(raw) ?? {}, index, event));
  }
  const terminator = terminatorOf(body.status);
  const { usage, ...rest } = body;
  const final = fault.noUsage === true || usage === undefined ? rest : { ...rest, usage };
  return { events, end: event(terminator, { response: final }) };
}

const EVENTS_OF: Record<
  Wire,
  (body: Json, fault: StreamFault) => { events: string[]; end: string }
> = { anthropic: anthropicEvents, chat: chatEvents, responses: responsesEvents };

/**
 * The stream of `body`, the answer of `wire` as the fake would give it whole (an object, or its
 * JSON text), with `fault`'s fault: the texts of its events, in the order they are written. An
 * answer that is not JSON is one event of that text, as a provider that sends what nothing reads.
 */
export function eventStream(wire: Wire, body: unknown, fault: StreamFault = {}): string[] {
  let answer: unknown = body;
  if (typeof body === 'string') {
    try {
      answer = JSON.parse(body);
    } catch {
      return [`data: ${body}\n\n`];
    }
  }
  const json = asRecord(answer) ?? {};
  const { events, end } = EVENTS_OF[wire](json, fault);
  if (fault.error !== undefined) return [events[0] ?? '', errorEvent(wire, fault.error)];
  return fault.cut === true ? events : [...events, end];
}

/**
 * The events as the network delivers them: one piece for each event, but the first event that has
 * a character of more than one byte in it, which comes in two pieces cut inside that character.
 */
export function streamPieces(events: readonly string[]): Buffer[] {
  let cut = false;
  return events.flatMap((text) => {
    const bytes = Buffer.from(text, 'utf8');
    const lead = cut ? -1 : bytes.findIndex((byte) => byte >= 0xc0);
    if (lead === -1) return [bytes];
    cut = true;
    return [bytes.subarray(0, lead + 1), bytes.subarray(lead + 1)];
  });
}
