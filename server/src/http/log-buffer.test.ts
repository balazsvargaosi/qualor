import { describe, expect, it } from 'vitest';
import { LogBuffer } from './log-buffer';
import { createLogger } from './logger';

describe('LogBuffer', () => {
  it('keeps lines oldest first without the newline', () => {
    const buffer = new LogBuffer();
    buffer.write('one\ntwo\n');
    buffer.write('three\n');
    expect(buffer.snapshot()).toEqual(['one', 'two', 'three']);
  });

  it('joins a line split across writes', () => {
    const buffer = new LogBuffer();
    buffer.write('par');
    buffer.write('tial\nnext\n');
    expect(buffer.snapshot()).toEqual(['partial', 'next']);
  });

  it('drops the oldest lines beyond maxLines', () => {
    const buffer = new LogBuffer({ maxLines: 3 });
    for (let i = 1; i <= 10; i++) buffer.write(`l${i}\n`);
    expect(buffer.snapshot()).toEqual(['l8', 'l9', 'l10']);
  });

  it('drops the oldest lines beyond maxBytes', () => {
    const buffer = new LogBuffer({ maxBytes: 10 });
    for (const line of ['aaaa', 'bbbb', 'cccc', 'dddd']) buffer.write(`${line}\n`);
    expect(buffer.snapshot()).toEqual(['cccc', 'dddd']);
  });

  it('counts bytes, not characters, and drops a line larger than the cap', () => {
    const buffer = new LogBuffer({ maxBytes: 8 });
    buffer.write('日本\n'); // 6 bytes
    buffer.write('日本語\n'); // 9 bytes, over the cap on its own
    expect(buffer.snapshot()).toEqual([]);
    buffer.write('ok\n');
    expect(buffer.snapshot()).toEqual(['ok']);
  });

  it('holds the caps over many writes', () => {
    const buffer = new LogBuffer({ maxLines: 2000 });
    for (let i = 0; i < 10000; i++) buffer.write(`line ${i}\n`);
    const lines = buffer.snapshot();
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toBe('line 8000');
    expect(lines[1999]).toBe('line 9999');
  });

  it('receives the logger lines with redaction applied, next to the destination', () => {
    const buffer = new LogBuffer();
    const out: string[] = [];
    const logger = createLogger('info', { write: (l: string) => void out.push(l) }, buffer);
    logger.info({ password: 'hunter2', user: 'ann' }, 'sign in');
    logger.debug('below the level');
    const lines = buffer.snapshot();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('hunter2');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ password: '[redacted]', user: 'ann' });
    expect(out).toHaveLength(1);
    expect(`${out[0]}`.trimEnd()).toBe(lines[0]);
  });
});
