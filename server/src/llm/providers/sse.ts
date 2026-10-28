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
  const decoder = new TextDecoder('utf-8');
  const lines = new LineReader(limits.maxEventBytes);
  const event = new EventReader(limits.maxEventBytes);
  for await (const chunk of chunks) {
    for (const whole of lines.feed(decoder.decode(chunk, { stream: true }))) {
      const ended = event.readLine(whole);
      if (ended !== null) yield ended;
    }
  }
}

/** Splits the text of the chunks into lines, which may be cut anywhere between two chunks. */
class LineReader {
  /** The line being read, as far as it has come, and its bytes. */
  private line = '';
  private lineBytes = 0;
  /** Whether the last line ended with a CR, so that an LF next is no line of its own. */
  private afterCr = false;

  constructor(private readonly maxEventBytes: number) {}

  /** The lines that end in `text`, one at a time; what follows the last end is kept for the next. */
  *feed(text: string): Generator<string, void, undefined> {
    let from = 0;
    if (this.afterCr && text !== '') {
      if (text.startsWith('\n')) from = 1;
      this.afterCr = false;
    }
    const ends = /\r\n|\r|\n/g;
    ends.lastIndex = from;
    for (let end = ends.exec(text); end !== null; end = ends.exec(text)) {
      const part = text.slice(from, end.index);
      if (this.lineBytes + Buffer.byteLength(part) > this.maxEventBytes) {
        throw new SseError('too_large');
      }
      const whole = this.line + part;
      this.line = '';
      this.lineBytes = 0;
      from = end.index + end[0].length;
      // A CR at the very end of the chunk may be the first half of a CRLF.
      if (end[0] === '\r' && from === text.length) this.afterCr = true;
      yield whole;
    }
    const rest = text.slice(from);
    this.line += rest;
    this.lineBytes += Buffer.byteLength(rest);
    if (this.lineBytes > this.maxEventBytes) throw new SseError('too_large');
  }
}

/** Builds the event being read from its lines. */
class EventReader {
  /** The event being read: its type, its data and whether it has a data line, and the data's bytes. */
  private type = '';
  private data = '';
  private hasData = false;
  private dataBytes = 0;

  constructor(private readonly maxEventBytes: number) {}

  /** One line, whole; the event it ends, if it is a blank line that ends one with data. */
  readLine(whole: string): SseEvent | null {
    if (whole === '') return this.end();
    const colon = whole.indexOf(':');
    if (colon === 0) return null;
    const field = colon === -1 ? whole : whole.slice(0, colon);
    if (field !== 'data' && field !== 'event') return null;
    let value = colon === -1 ? '' : whole.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.type = value;
    else this.addData(value);
    return null;
  }

  private end(): SseEvent | null {
    const ended = this.hasData
      ? { event: this.type === '' ? null : this.type, data: this.data }
      : null;
    this.type = '';
    this.data = '';
    this.hasData = false;
    this.dataBytes = 0;
    return ended;
  }

  private addData(value: string): void {
    const bytes = this.dataBytes + (this.hasData ? 1 : 0) + Buffer.byteLength(value);
    if (bytes > this.maxEventBytes) throw new SseError('too_large');
    this.data = this.hasData ? `${this.data}\n${value}` : value;
    this.hasData = true;
    this.dataBytes = bytes;
  }
}
