import { Writable } from 'node:stream';

/** The support bundle's log tail (4E-3 B): at most this many lines and bytes are kept. */
export const LOG_BUFFER_MAX_LINES = 5000;
export const LOG_BUFFER_MAX_BYTES = 5 * 1024 * 1024;

export interface LogBufferOptions {
  maxLines?: number;
  maxBytes?: number;
}

/**
 * A pino destination that keeps the newest log lines in memory, dropping the oldest first once
 * either cap is reached. It never blocks: every write completes synchronously.
 */
export class LogBuffer extends Writable {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private lines: { text: string; bytes: number }[] = [];
  private head = 0;
  private bytes = 0;
  private partial = '';

  constructor({
    maxLines = LOG_BUFFER_MAX_LINES,
    maxBytes = LOG_BUFFER_MAX_BYTES,
  }: LogBufferOptions = {}) {
    super({ decodeStrings: false });
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, done: () => void): void {
    const text = this.partial + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) if (line !== '') this.add(line);
    done();
  }

  /** The kept lines, oldest first, each without its trailing newline. */
  snapshot(): string[] {
    return this.lines.slice(this.head).map((entry) => entry.text);
  }

  private add(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    this.lines.push({ text, bytes });
    this.bytes += bytes;
    while (this.lines.length - this.head > this.maxLines || this.bytes > this.maxBytes) {
      const dropped = this.lines[this.head];
      if (!dropped) break;
      this.bytes -= dropped.bytes;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }
}
