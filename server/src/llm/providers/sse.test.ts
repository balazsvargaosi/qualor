import { describe, expect, it } from 'vitest';
import { parseSse, SseError, type SseEvent } from './sse';

async function* feed(...chunks: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
}

const events = (input: AsyncIterable<Buffer>, maxEventBytes = 1_024): Promise<SseEvent[]> =>
  drain(parseSse(input, { maxEventBytes }));

const event = (data: string, type: string | null = null): SseEvent => ({ event: type, data });

describe('parseSse (the WHATWG event stream rules)', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('reads lines that end in %s', async (_name, eol) => {
    const text = ['event: delta', 'data: one', '', 'data: two', '', ''].join(eol);
    expect(await events(feed(text))).toEqual([event('one', 'delta'), event('two')]);
  });

  it('reads one stream whose lines end in all three ways', async () => {
    expect(await events(feed('data: a\r\ndata: b\ndata: c\r\r'))).toEqual([event('a\nb\nc')]);
  });

  it('takes a CR at the end of a chunk as a line end, and the LF that opens the next chunk as part of it', async () => {
    // The LF is no blank line of its own: that would end the event after its first line.
    expect(await events(feed('data: a\r', '\ndata: b\r\n\r\n'))).toEqual([event('a\nb')]);
    expect(await events(feed('data: a\r\n\r', '\ndata: b\r\n\r\n'))).toEqual([
      event('a'),
      event('b'),
    ]);
    // A CR that no LF follows, in the next chunk, is a line end alone.
    expect(await events(feed('data: a\r', 'data: b\r\r'))).toEqual([event('a\nb')]);
    // The LF waits behind a chunk with nothing to read in it (the rest of a split character).
    expect(await events(feed('data: a\r', Buffer.alloc(0), '\ndata: b\n\n'))).toEqual([
      event('a\nb'),
    ]);
  });

  it('ends a line, and an event, at a CR that ends the input', async () => {
    // A lone CR is a line end as an LF is: here it is the blank line that ends the event.
    expect(await events(feed('data: a\n\r'))).toEqual([event('a')]);
  });

  /**
   * One stream with all of what the format has: a BOM, a type, the three line ends, a comment, a
   * line without a colon, characters of two, three and four bytes, and an event the input ends in.
   */
  const SAMPLE = [
    '\uFEFFevent: ping\r\ndata: 1\r\n\r\n',
    ': a comment\n',
    'data: tw\u00f6\r',
    'data: \u20ac \ud83d\ude00\n\n',
    'data\n\n',
    'event: alone\n\n',
    'data: last\r\n\r\n',
    'data: unended',
  ].join('');
  const SAMPLE_EVENTS = [
    event('1', 'ping'),
    event('tw\u00f6\n\u20ac \ud83d\ude00'),
    event(''),
    event('last'),
  ];

  it('reads a stream the same whole, in two chunks cut anywhere, and a byte at a time', async () => {
    const bytes = Buffer.from(SAMPLE, 'utf8');
    expect(await events(feed(bytes))).toEqual(SAMPLE_EVENTS);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const parts = [bytes.subarray(0, cut), bytes.subarray(cut)];
      expect(await events(feed(...parts)), `cut at ${cut}`).toEqual(SAMPLE_EVENTS);
    }
    expect(await events(feed(...Array.from(bytes, (byte) => Buffer.from([byte]))))).toEqual(
      SAMPLE_EVENTS,
    );
  });

  it('joins the data lines of an event with a line feed', async () => {
    expect(await events(feed('data: a\ndata: b\n\n'))).toEqual([event('a\nb')]);
    // An empty data line is a line of the data too, whether or not it has its colon.
    expect(await events(feed('data: a\ndata\ndata:\ndata: c\n\n'))).toEqual([event('a\n\n\nc')]);
  });

  it('reads comments as nothing: they end no event and break none', async () => {
    expect(await events(feed(': hello\n\n: again\n\n'))).toEqual([]);
    expect(await events(feed('data: a\n: in the middle\ndata: b\n\n'))).toEqual([event('a\nb')]);
    expect(await events(feed(':data: not data\n\n'))).toEqual([]);
    expect(await events(feed(':\n:\n\n'))).toEqual([]);
  });

  it('drops one space after the colon, and no more', async () => {
    expect(await events(feed('data:x\n\ndata: x\n\ndata:  x\n\ndata:\tx\n\n'))).toEqual([
      event('x'),
      event('x'),
      event(' x'),
      event('\tx'),
    ]);
    expect(await events(feed('data: a:b: c\n\n'))).toEqual([event('a:b: c')]);
  });

  it('takes the type from event, the last one winning, and an empty one is none', async () => {
    expect(await events(feed('event: a\nevent: b\ndata: x\n\n'))).toEqual([event('x', 'b')]);
    expect(await events(feed('event: a\nevent:\ndata: x\n\n'))).toEqual([event('x')]);
    // The type comes before or after the data, and is for that event only.
    expect(await events(feed('data: x\nevent: late\n\ndata: y\n\n'))).toEqual([
      event('x', 'late'),
      event('y'),
    ]);
  });

  it('does not yield an event without a data line, and forgets its type', async () => {
    expect(await events(feed('event: ping\n\n'))).toEqual([]);
    expect(await events(feed('event: ping\n\ndata: x\n\n'))).toEqual([event('x')]);
    expect(await events(feed('\n\n\r\n\ndata: x\n\n\n\n'))).toEqual([event('x')]);
    // An empty data line is a data line: the event has data, which is empty.
    expect(await events(feed('data:\n\n'))).toEqual([event('')]);
  });

  it('ignores id, retry and the fields it does not know, and never reconnects', async () => {
    const text = 'id: 7\nretry: 100\nfoo: bar\nevent: e\ndata: x\n\n';
    expect(await events(feed(text))).toEqual([event('x', 'e')]);
    // Names are as they are written: no case folding, no trimming.
    expect(await events(feed('DATA: x\n\n Data: x\n\ndata : x\n\n'))).toEqual([]);
    expect(await events(feed('foo\n\nevent\ndata: x\n\n'))).toEqual([event('x')]);
  });

  it('yields an event as soon as its blank line is read, not when the stream ends', async () => {
    const asked: number[] = [];
    async function* slow(): AsyncGenerator<Buffer> {
      asked.push(1);
      yield Buffer.from('data: a\n\n');
      asked.push(2);
      yield Buffer.from('data: b\n\n');
    }
    const iterator = parseSse(slow(), { maxEventBytes: 100 });
    expect(await iterator.next()).toEqual({ done: false, value: event('a') });
    expect(asked).toEqual([1]);
    expect(await iterator.next()).toEqual({ done: false, value: event('b') });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('does not yield an event that no blank line ended', async () => {
    expect(await events(feed('data: a\n\ndata: b\n'))).toEqual([event('a')]);
    expect(await events(feed('data: a\n\ndata: b'))).toEqual([event('a')]);
    expect(await events(feed('data: a\n\ndata: b\r'))).toEqual([event('a')]);
    expect(await events(feed('data: a\n'))).toEqual([]);
    expect(await events(feed('event: x\ndata: a\ndata: b'))).toEqual([]);
    expect(await events(feed(''))).toEqual([]);
    expect(await events(feed())).toEqual([]);
  });

  it('decodes UTF-8 across the bounds of chunks, whatever the characters are made of', async () => {
    const bytes = Buffer.from('data: \u00e9\u20ac\ud83d\ude00\n\n', 'utf8');
    const heart = bytes.indexOf(0xf0);
    // The euro sign (three bytes) cut after its first byte and after its second, the emoji (four)
    // in three pieces.
    const euro = bytes.indexOf(0xe2);
    expect(
      await events(
        feed(
          bytes.subarray(0, euro + 1),
          bytes.subarray(euro + 1, euro + 2),
          bytes.subarray(euro + 2, heart + 1),
          bytes.subarray(heart + 1, heart + 3),
          bytes.subarray(heart + 3),
        ),
      ),
    ).toEqual([event('\u00e9\u20ac\ud83d\ude00')]);
  });

  it('reads a byte that is no UTF-8 as the replacement character, and goes on', async () => {
    expect(
      await events(feed(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]))),
    ).toEqual([event('\ufffd')]);
  });

  it('drops a BOM at the very start, even one that comes in pieces', async () => {
    const bom = [0xef, 0xbb, 0xbf];
    const line = Buffer.from('data: a\n\n');
    expect(await events(feed(Buffer.concat([Buffer.from(bom), line])))).toEqual([event('a')]);
    expect(
      await events(feed(Buffer.from(bom.slice(0, 1)), Buffer.from(bom.slice(1)), line)),
    ).toEqual([event('a')]);
    expect(
      await events(
        feed(Buffer.from(bom.slice(0, 2)), Buffer.concat([Buffer.from(bom.slice(2)), line])),
      ),
    ).toEqual([event('a')]);
  });

  it('keeps a BOM that is not at the start: it belongs to its line', async () => {
    // So the field of that line is not "data", and the event has no data.
    expect(await events(feed('data: a\n\n\uFEFFdata: b\n\n'))).toEqual([event('a')]);
    expect(await events(feed('data: \uFEFFb\n\n'))).toEqual([event('\uFEFFb')]);
  });

  describe('bounds (maxEventBytes)', () => {
    it('refuses a line over the bound, in bytes and not in characters', async () => {
      // Six characters, sixteen bytes.
      await expect(events(feed(':\u20ac\u20ac\u20ac\u20ac\u20ac\n\n'), 10)).rejects.toMatchObject({
        name: 'SseError',
        cause: 'too_large',
      });
      await expect(events(feed(':\u20ac\u20ac\u20ac\n\n'), 10)).resolves.toEqual([]);
    });

    it('allows a line of exactly the bound, and refuses one byte more', async () => {
      await expect(events(feed(`: ${'x'.repeat(8)}\n\n`), 10)).resolves.toEqual([]);
      await expect(events(feed(`: ${'x'.repeat(9)}\n\n`), 10)).rejects.toBeInstanceOf(SseError);
      // The same with the line end in the next chunk: the half line is at the bound, or over it.
      await expect(events(feed(`: ${'x'.repeat(8)}`, '\n\n'), 10)).resolves.toEqual([]);
      await expect(events(feed(`: ${'x'.repeat(9)}`, '\n\n'), 10)).rejects.toBeInstanceOf(SseError);
    });

    it('refuses the data of an event that passes the bound over its lines, joined by line feeds', async () => {
      // Each line is 15 bytes, with 9 of data: 9, 19 and then 29 with the line feeds.
      const line = 'data: aaaaaaaaa\n';
      await expect(events(feed(`${line}${line}\n`), 20)).resolves.toEqual([
        event('aaaaaaaaa\naaaaaaaaa'),
      ]);
      await expect(events(feed(`${line}${line}${line}\n`), 20)).rejects.toMatchObject({
        name: 'SseError',
        cause: 'too_large',
      });
    });

    it('counts the bytes of the data of an event, not its characters', async () => {
      // Two characters of three bytes on each line: 6 bytes of data, and 20 in three lines
      // with the line feeds, but 27 in four (while the characters are 11).
      const line = 'data: €€\n';
      await expect(events(feed(`${line}${line}${line}\n`), 20)).resolves.toHaveLength(1);
      await expect(events(feed(`${line}${line}${line}${line}\n`), 20)).rejects.toBeInstanceOf(
        SseError,
      );
    });

    it('yields the events before the one that is over the bound', async () => {
      const seen: SseEvent[] = [];
      const reading = (async () => {
        for await (const next of parseSse(feed('data: ok\n\n', `data: ${'x'.repeat(50)}\n\n`), {
          maxEventBytes: 20,
        })) {
          seen.push(next);
        }
      })();
      await expect(reading).rejects.toBeInstanceOf(SseError);
      expect(seen).toEqual([event('ok')]);
    });

    it('refuses a line before its end arrives: it never buffers more than the bound', async () => {
      let pulled = 0;
      async function* endless(): AsyncGenerator<Buffer> {
        for (;;) {
          pulled += 1;
          yield Buffer.from('x'.repeat(60));
        }
      }
      await expect(events(endless(), 100)).rejects.toBeInstanceOf(SseError);
      expect(pulled).toBe(2);
    });

    it('does not count the bytes of many small events against one', async () => {
      const many = 'data: 0123456789\n\n'.repeat(100);
      expect(await events(feed(many), 20)).toHaveLength(100);
    });
  });

  describe('the ends of the reader and of its input', () => {
    it('passes on the failure of its input, after the events before it', async () => {
      async function* breaks(): AsyncGenerator<Buffer> {
        yield Buffer.from('data: a\n\n');
        throw new Error('the input broke');
      }
      const seen: SseEvent[] = [];
      const reading = (async () => {
        for await (const next of parseSse(breaks(), { maxEventBytes: 100 })) seen.push(next);
      })();
      await expect(reading).rejects.toThrow('the input broke');
      expect(seen).toEqual([event('a')]);
    });

    it('closes its input when the reader stops early, and when it is over the bound', async () => {
      let closed = 0;
      async function* input(text: string): AsyncGenerator<Buffer> {
        try {
          yield Buffer.from(text);
          yield Buffer.from('data: more\n\n');
        } finally {
          closed += 1;
        }
      }
      for await (const next of parseSse(input('data: a\n\n'), { maxEventBytes: 100 })) {
        expect(next).toEqual(event('a'));
        break;
      }
      expect(closed).toBe(1);
      await expect(events(input(`data: ${'x'.repeat(200)}\n\n`), 100)).rejects.toBeInstanceOf(
        SseError,
      );
      expect(closed).toBe(2);
    });
  });
});
