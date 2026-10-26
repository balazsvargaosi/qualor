/**
 * An event of an event stream: `event` is its type (null when it names none), and `data` its data
 * lines, joined with a line feed.
 */
export interface SseEvent {
  event: string | null;
  data: string;
}

/** Why an event stream could not be read on: a line or an event's data over its bound. */
export type SseFailure = 'too_large';

/** An event stream that cannot be read on. Its message is a fixed text, never the stream's own. */
export class SseError extends Error {
  constructor(override readonly cause: SseFailure) {
    super('A line or an event of the event stream is over the size limit');
    this.name = 'SseError';
  }
}

/**
 * Reads an event stream as the WHATWG standard says it is read (there is no reconnection here, so
 * `id` and `retry` are ignored, as is any field it does not name):
 * - the bytes are UTF-8, decoded across the bounds of chunks (a character may be cut anywhere);
 *   a byte order mark at the very start is dropped, and a byte that is no UTF-8 is read as the
 *   replacement character;
 * - lines end at CRLF, LF or CR: a CR ends its line at once, and an LF that comes right after it, in
 *   this chunk or the next, is part of that end and no line of its own;
 * - a line that starts with `:` is a comment; any other is a field up to its first `:` (the whole
 *   line, when it has none) and a value after it, less one space; `data` lines join with LF, and
 *   `event` sets the type of the event;
 * - a blank line ends an event, which is yielded when it has a data line (an empty one counts); an
 *   event with none is not, and its type is forgotten;
 * - an event that no blank line ended when the input ends is not yielded, nor is a half line.
 * A line, or the data of an event, over `limits.maxEventBytes` (bytes of UTF-8, the line end not
 * counted) throws `SseError('too_large')` as soon as it is known, never after it has been buffered
 * in full. The terminator of a stream (OpenAI's `[DONE]`, Anthropic's `message_stop`) is the
 * provider's to require: this reader knows none. It reads its input as it is asked for events, and
 * closes it when the reader stops early.
 */
export async function* parseSse(
  chunks: AsyncIterable<Buffer>,
  limits: { maxEventBytes: number },
): AsyncGenerator<SseEvent, void, undefined> {
  const { maxEventBytes } = limits;
  const decoder = new TextDecoder('utf-8');
  /** The line being read, as far as it has come, and its bytes. */
  let line = '';
  let lineBytes = 0;
  /** Whether the last line ended with a CR, so that an LF next is no line of its own. */
  let afterCr = false;
  /** The event being read: its type, its data and whether it has a data line, and the data's bytes. */
  let type = '';
  let data = '';
  let hasData = false;
  let dataBytes = 0;

  /** One line, whole; the event it ends, if it is a blank line that ends one with data. */
  const readLine = (whole: string): SseEvent | null => {
    if (whole === '') {
      const ended = hasData ? { event: type === '' ? null : type, data } : null;
      type = '';
      data = '';
      hasData = false;
      dataBytes = 0;
      return ended;
    }
    const colon = whole.indexOf(':');
    if (colon === 0) return null;
    const field = colon === -1 ? whole : whole.slice(0, colon);
    if (field !== 'data' && field !== 'event') return null;
    let value = colon === -1 ? '' : whole.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      type = value;
      return null;
    }
    const bytes = dataBytes + (hasData ? 1 : 0) + Buffer.byteLength(value);
    if (bytes > maxEventBytes) throw new SseError('too_large');
    data = hasData ? `${data}\n${value}` : value;
    hasData = true;
    dataBytes = bytes;
    return null;
  };

  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    let from = 0;
    if (afterCr && text !== '') {
      if (text.startsWith('\n')) from = 1;
      afterCr = false;
    }
    const ends = /\r\n|\r|\n/g;
    ends.lastIndex = from;
    for (let end = ends.exec(text); end !== null; end = ends.exec(text)) {
      const part = text.slice(from, end.index);
      if (lineBytes + Buffer.byteLength(part) > maxEventBytes) throw new SseError('too_large');
      const whole = line + part;
      line = '';
      lineBytes = 0;
      from = end.index + end[0].length;
      // A CR at the very end of the chunk may be the first half of a CRLF.
      if (end[0] === '\r' && from === text.length) afterCr = true;
      const ended = readLine(whole);
      if (ended !== null) yield ended;
    }
    const rest = text.slice(from);
    line += rest;
    lineBytes += Buffer.byteLength(rest);
    if (lineBytes > maxEventBytes) throw new SseError('too_large');
  }
}
