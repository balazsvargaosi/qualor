import { NOT_UNDERSTOOD, postJson, postStream } from './http';
import type { SseEvent } from './sse';
import {
  LLM_MAX_ANSWER_BYTES,
  LlmError,
  type ProviderConfig,
  type ProviderHttpOptions,
} from './types';

/*
 * What the three wires share in reading a streamed answer (R35): asking for it (streamed when the
 * call's options give the limits of a stream, and once more without it of a server that will not
 * stream), the data of an event, an error the provider sends in its stream, a stream that ends
 * before its terminator, and the cap of the answer the events make. Each wire puts its events
 * together into the very answer it reads when it is not streamed, so that from there a streamed
 * turn and one that is not are one path.
 */

/** What a provider that could not finish an answer is told, whatever it said of it: a fixed text. */
export const NOT_COMPLETED = 'The model provider could not complete the answer';

/** What a provider that refused the request in its stream is told: a fixed text. */
const REFUSED_IN_STREAM =
  'The provider refused the request while it answered; check the base URL and model';

/**
 * How a wire streams: what a streamed request adds to its body, and how the events of its answer
 * are put together into the answer the request has when it is not streamed.
 */
export interface StreamWire {
  fields: Readonly<Record<string, unknown>>;
  assemble: (events: AsyncIterable<SseEvent>) => Promise<unknown>;
}

/** One request of a call: where it goes, and what it sends. */
export interface AnswerRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The output limit field the request carries, which a refusal may name (Chat Completions'). */
  outputLimitField?: ProviderConfig['maxTokensField'];
}

/**
 * The asker of one call of a conversation: it gives each request of the call the answer as
 * `postJson` parses it. With `http.stream` set, a request asks for its answer streamed (with
 * `wire.fields`) within those limits, and `wire.assemble` puts the events together; a server that
 * ignores the ask and answers whole, as JSON, gives that answer as it is. A server that refuses the
 * stream (`refusedStream`) is asked once more without it, as `postJson` asks, with the timeout of
 * the settings, and so are the requests of the call that follow (a call asks more than once when
 * the room to think is refused: `askWithRoom`). Nothing is remembered from one call to the next: a
 * server that does not stream costs one quick 400 a call.
 */
export function answerAsker(
  config: ProviderConfig,
  http: ProviderHttpOptions,
  wire: StreamWire,
): (request: AnswerRequest) => Promise<unknown> {
  let limits = http.stream;
  return async ({ path, headers, body, outputLimitField }) => {
    if (limits !== undefined) {
      try {
        const streamed = { ...body, ...wire.fields };
        const answer = await postStream(
          config,
          path,
          headers,
          streamed,
          http,
          limits,
          outputLimitField,
        );
        return answer.kind === 'whole' ? answer.answer : await wire.assemble(answer.events);
      } catch (error) {
        if (!(error instanceof LlmError && error.refusedStream)) throw error;
        limits = undefined;
      }
    }
    return await postJson(config, path, headers, body, http, outputLimitField);
  };
}

/** A JSON object of an event's data, or null for anything else. */
export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** An answer whose events were not understood: the text of an answer that was not. */
export function notUnderstood(): LlmError {
  return new LlmError('bad_answer', NOT_UNDERSTOOD);
}

/**
 * What a provider's error in its stream, after the 200, is: the provider failing when `serverSide`
 * (unavailable, which is tried again as an unreachable provider is), else its refusal of the
 * request; in a fixed text, never the provider's own words.
 */
export function errorInStream(serverSide: boolean): LlmError {
  return serverSide
    ? new LlmError('unavailable', NOT_COMPLETED)
    : new LlmError('rejected', REFUSED_IN_STREAM);
}

/** What a stream that ended before its terminator is: an answer the provider did not complete. */
export function cutShort(): LlmError {
  return new LlmError('unavailable', NOT_COMPLETED);
}

/**
 * The data of an event, as JSON, and its type: the data's own `type`, else the event's name. Data
 * that is not JSON is not understood, but in an `error` event, which is the provider's refusal
 * whatever it holds.
 */
export function eventOf(event: SseEvent): {
  type: string | null;
  data: Record<string, unknown> | null;
} {
  let data: unknown;
  try {
    data = JSON.parse(event.data);
  } catch {
    if (event.event === 'error') throw errorInStream(false);
    throw notUnderstood();
  }
  const record = asRecord(data);
  const own = record?.type;
  return { type: typeof own === 'string' ? own : event.event, data: record };
}

/**
 * The error types and codes of the OpenAI wires that say the server failed: OpenAI's (and Azure's)
 * `server_error`, vLLM's `InternalServerError`, and the `api_error` of Ollama's OpenAI endpoint.
 */
const SERVER_ERROR = /server_?error$|^api_error$/i;

/** Whether an error object of the OpenAI wires says, by its type or its code, that the server failed. */
export function serverFailed(error: unknown): boolean {
  const record = asRecord(error);
  return [record?.type, record?.code].some(
    (value) => typeof value === 'string' && SERVER_ERROR.test(value),
  );
}

/**
 * Refuses, as an answer not understood, what a stream's events make once they are put together
 * when it is over the cap of an answer (LLM_MAX_ANSWER_BYTES): `written` is what the model wrote, as
 * the wire's answer holds it (its texts, calls and thinking), and not what the provider repeats of
 * the request around it. What cannot be written out as JSON at all (nested past what JSON.stringify
 * follows) is not measured here: the wire's reader refuses it as it does in an answer that was not
 * streamed (`replayOf`).
 */
export function withinAnswerCap(written: unknown): void {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(written) ?? '', 'utf8');
  } catch {
    return;
  }
  if (size > LLM_MAX_ANSWER_BYTES) throw notUnderstood();
}
