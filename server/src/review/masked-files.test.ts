import { redactLongText, REDACTED } from '@qualor/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { HOSTILE_TEXT, memorySnapshot } from '../../test/review';
import {
  lineCountOf,
  MASKED_CACHE_BYTES,
  MaskedFiles,
  MaskedText,
  type MaskedFile,
  type MaskedFilesOptions,
} from './masked-files';
import { Masker, type MaskerOptions } from './masker';
import { linesOf, type SnapshotReader } from './snapshot-reader';

const j = (...parts: string[]) => parts.join('');
const KEY_BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
const KEY_END = j('-----END ', 'RSA PRIVATE KEY-----');
const keyLine = (i: number): string =>
  j('lQOYBF', String(i).padStart(4, '0'), 'Qm9ndXMga2V5IGJvZHk'.repeat(2));
const KEY_FILE = ['before', KEY_BEGIN, ...Array.from({ length: 30 }, (_, i) => keyLine(i)), KEY_END]
  .concat('after')
  .join('\n');
/** A fake password line, built at run time. */
const PASSWORD_LINE = j('const password = "', 'hunter2', '-very-secret";');

/** The masker the tests share; one that must differ is made, and closed, by the test. */
const masker = new Masker();
const made: Masker[] = [];
afterAll(async () => {
  await Promise.all([masker.close(), ...made.map((m) => m.close())]);
});
const maskerOf = (options: MaskerOptions): Masker => {
  const m = new Masker(options);
  made.push(m);
  return m;
};
const filesOf = (reader: SnapshotReader, options: MaskedFilesOptions = {}) =>
  new MaskedFiles(reader, { masker, ...options });

/** The lines of a masked file, whole. */
function linesOfFile(file: MaskedFile): string[] {
  if (file.kind !== 'text') throw new Error(`not text: ${file.kind}`);
  return Array.from({ length: file.text.lineCount }, (_, i) => file.text.line(i));
}

/** The reader, and the paths `file()` was asked for. */
function counting(inner: SnapshotReader): { reader: SnapshotReader; asked: string[] } {
  const asked: string[] = [];
  return {
    reader: {
      ...inner,
      file: (path) => {
        asked.push(path);
        return inner.file(path);
      },
    },
    asked,
  };
}

describe('lineCountOf and MaskedText', () => {
  const texts = [
    '',
    '\n',
    '\n\n',
    'a',
    'a\n',
    'a\nb',
    'a\nb\n',
    'a\n\nb\n\n',
    'one\r\ntwo\r\n',
    'é\n日本\n😀',
    '\n\n\nx',
    'x'.repeat(10_000),
    `${'line\n'.repeat(500)}last`,
  ];

  it('count the lines of a text as linesOf does, and give them as it does', () => {
    for (const text of texts) {
      const lines = linesOf(text);
      expect(lineCountOf(text), JSON.stringify(text)).toBe(lines.length);
      const masked = MaskedText.of(text, lines.length);
      expect(masked.lineCount).toBe(lines.length);
      expect(
        Array.from({ length: masked.lineCount }, (_, i) => masked.line(i)),
        JSON.stringify(text),
      ).toEqual(lines);
      expect(Array.from({ length: masked.lineCount }, (_, i) => masked.lineLength(i))).toEqual(
        lines.map((line) => line.length),
      );
    }
  });

  it('give the empty line for a line that is not there, and take the first lines of a longer text', () => {
    const masked = MaskedText.of('a\nb\nc\n', 2);
    expect([masked.lineCount, masked.line(0), masked.line(1)]).toEqual([2, 'a', 'b']);
    expect([masked.line(2), masked.line(-1), masked.line(99)]).toEqual(['', '', '']);
    expect([masked.lineLength(2), masked.lineLength(-1)]).toEqual([0, 0]);
    // The text past the last line is not kept.
    expect(masked.length).toBe('a\nb'.length);
    // Fewer lines than asked for: the lines there are.
    const short = MaskedText.of('a\nb', 5);
    expect([short.lineCount, short.line(1), short.line(2)]).toEqual([2, 'b', '']);
    // No line asked for: no text kept.
    const none = MaskedText.of('abc', 0);
    expect([none.lineCount, none.length, none.bytes, none.line(0)]).toEqual([0, 0, 0, '']);
  });

  it('cost the UTF-8 bytes of the text and four for each line', () => {
    expect(MaskedText.of('', 0).bytes).toBe(0);
    expect(MaskedText.of('abc\n', 1).bytes).toBe(3 + 4);
    expect(MaskedText.of('a\nb\nc\n', 3).bytes).toBe(5 + 12);
    expect(MaskedText.of('é\n日本\n', 2).bytes).toBe(Buffer.byteLength('é\n日本') + 8);
    const many = 'x\n'.repeat(1_000);
    expect(MaskedText.of(many, 1_000).bytes).toBe(1_999 + 4_000);
  });
});

describe('MaskedFiles', () => {
  it('masks a file as a whole: the lines, as many as the file has, and what was masked', async () => {
    const reader = memorySnapshot({
      files: { 'key.txt': KEY_FILE, 'code.ts': 'const a = 1;\nconst b = 2;\n' },
    });
    const files = filesOf(reader);
    const key = await files.file('key.txt');
    expect(linesOfFile(key)).toEqual([
      'before',
      ...Array.from({ length: 32 }, () => REDACTED),
      'after',
    ]);
    expect(key).toMatchObject({ kind: 'text', redactions: 32 });
    // The same lines as the shared redaction gives for the whole text.
    expect(linesOfFile(key)).toEqual(linesOf(redactLongText(KEY_FILE).text));
    const code = await files.file('code.ts');
    expect(linesOfFile(code)).toEqual(['const a = 1;', 'const b = 2;']);
    expect(code).toMatchObject({ kind: 'text', redactions: 0 });
    const empty = await filesOf(memorySnapshot({ files: { 'e.txt': '' } })).file('e.txt');
    expect(linesOfFile(empty)).toEqual([]);
    expect(empty).toMatchObject({ kind: 'text', redactions: 0 });
  });

  it('masks a file once: a later request has its lines and no redactions', async () => {
    const { reader, asked } = counting(memorySnapshot({ files: { 'key.txt': KEY_FILE } }));
    const files = filesOf(reader);
    const first = await files.file('key.txt');
    const second = await files.file('key.txt');
    const third = await files.file('key.txt');
    expect(first).toMatchObject({ kind: 'text', redactions: 32 });
    expect(second).toMatchObject({ kind: 'text', redactions: 0 });
    expect(third).toMatchObject({ kind: 'text', redactions: 0 });
    if (first.kind !== 'text' || second.kind !== 'text') throw new Error('not text');
    expect(second.text).toBe(first.text);
    expect(asked).toEqual(['key.txt']);
    expect(files.maskings).toBe(1);
    expect(files.files).toBe(1);
  });

  it('makes one masking of requests that overlap, and reports it to one of them', async () => {
    const { reader, asked } = counting(memorySnapshot({ files: { 'key.txt': KEY_FILE } }));
    const files = filesOf(reader);
    const all = await Promise.all([
      files.file('key.txt'),
      files.file('key.txt'),
      files.file('key.txt'),
    ]);
    expect(all.map((file) => (file.kind === 'text' ? file.redactions : -1)).sort()).toEqual([
      0, 0, 32,
    ]);
    expect(asked).toEqual(['key.txt']);
    expect(files.maskings).toBe(1);
  });

  it('keeps masked files up to a bound in UTF-8 bytes and four a line, and masks the others each time they are asked for', async () => {
    const text = (c: string) => `${c.repeat(400)}\n`;
    const { reader, asked } = counting(
      memorySnapshot({
        files: {
          'a.txt': text('a'),
          'b.txt': text('b'),
          'c.txt': `${PASSWORD_LINE}\n${text('c')}`,
          'é.txt': text('é'),
        },
      }),
    );
    const files = filesOf(reader, { maxBytes: 1_300 });
    const redactions = async (path: string) => {
      const file = await files.file(path);
      return file.kind === 'text' ? file.redactions : -1;
    };
    // 401 bytes and a line for a, the same for b, 434 and two lines for c (the marker takes 12
    // bytes), 801 and a line for é (2 bytes each).
    expect(await redactions('a.txt')).toBe(0);
    expect(await redactions('b.txt')).toBe(0);
    expect(files.bytes).toBe(2 * (400 + 4));
    expect(await redactions('c.txt')).toBe(1);
    expect(files.bytes).toBe(2 * (400 + 4) + 433 + 8);
    // Past 1 300 bytes: é is not kept, and each request masks it again.
    expect(await redactions('é.txt')).toBe(0);
    expect(await redactions('é.txt')).toBe(0);
    expect(files.bytes).toBe(2 * (400 + 4) + 433 + 8);
    expect(files.files).toBe(3);
    expect(asked).toEqual(['a.txt', 'b.txt', 'c.txt', 'é.txt', 'é.txt']);
    expect(files.maskings).toBe(5);
    // What is kept is served without a read.
    await files.file('a.txt');
    await files.file('c.txt');
    expect(asked).toHaveLength(5);
    expect(files.bytes).toBeLessThanOrEqual(1_300);
  });

  it('gives the text of a file it keeps without masking anything, and none for a file it does not', async () => {
    const { reader, asked } = counting(
      memorySnapshot({ files: { 'a.txt': 'a\n', 'big.txt': 'x\n'.repeat(50) } }),
    );
    // 6 bytes for a (the text and a line), 300 for big: the bound keeps the first and not the second.
    const files = filesOf(reader, { maxBytes: 100 });
    expect(files.keptText('a.txt')).toBeNull();
    const a = await files.file('a.txt');
    await files.file('big.txt');
    expect(a.kind === 'text' ? files.keptText('a.txt') === a.text : null).toBe(true);
    expect(files.keptText('big.txt')).toBeNull();
    expect(files.keptText('missing.txt')).toBeNull();
    // Asking for the text reads and masks nothing.
    expect(asked).toEqual(['a.txt', 'big.txt']);
    expect(files.maskings).toBe(2);
  });

  it('counts the lines of a file against the bound, so that many short lines cost more than their text', async () => {
    // 1 000 lines of "x": 1 999 bytes of text and 4 000 of index.
    const reader = memorySnapshot({ files: { 'many.txt': 'x\n'.repeat(1_000) } });
    const exact = filesOf(reader, { maxBytes: 1_999 + 4_000 });
    await exact.file('many.txt');
    expect([exact.files, exact.bytes]).toEqual([1, 5_999]);
    // The text alone would fit; with its lines it does not.
    const tight = filesOf(reader, { maxBytes: 5_998 });
    await tight.file('many.txt');
    expect([tight.files, tight.bytes]).toEqual([0, 0]);
  });

  it('counts the replacements of a file once, also when it is masked again', async () => {
    const reader = memorySnapshot({ files: { 'k.txt': KEY_FILE } });
    const files = filesOf(reader, { maxBytes: 100 });
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const file = await files.file('k.txt');
      counts.push(file.kind === 'text' ? file.redactions : -1);
    }
    expect(counts).toEqual([32, 0, 0]);
    expect(files.maskings).toBe(3);
    expect(files.files).toBe(0);
  });

  it('charges the text it masks to a budget, once, and fails closed when it does not fit', async () => {
    const text = (c: string) => `${c.repeat(400)}\n`;
    const { reader, asked } = counting(
      memorySnapshot({
        files: { 'a.txt': text('a'), 'b.txt': text('b'), 's.txt': `${PASSWORD_LINE}\n` },
      }),
    );
    const files = filesOf(reader);
    const budget = { maskedBytes: 1_000 };
    // The text before it is masked is what is charged: 40 bytes here, 33 after.
    expect(await files.file('s.txt', budget)).toMatchObject({ kind: 'text', redactions: 1 });
    expect(budget.maskedBytes).toBe(1_000 - 40);
    // A file kept costs nothing, nor one that is being masked.
    await files.file('s.txt', budget);
    expect(budget.maskedBytes).toBe(1_000 - 40);
    expect(await files.file('a.txt', budget)).toMatchObject({ kind: 'text' });
    expect(budget.maskedBytes).toBe(1_000 - 40 - 401);
    expect(await files.file('b.txt', budget)).toMatchObject({ kind: 'text' });
    expect(budget.maskedBytes).toBe(1_000 - 40 - 401 - 401);
    // What is kept is free whatever is left of the budget.
    const again = { maskedBytes: 100 };
    expect(await files.file('a.txt', again)).toMatchObject({ kind: 'text' });
    expect(again.maskedBytes).toBe(100);
    // A file that does not fit is neither masked nor kept, and the budget stays as it was.
    const poor = filesOf(reader);
    expect(await poor.file('a.txt', again)).toEqual({ kind: 'budget' });
    expect(again.maskedBytes).toBe(100);
    expect([poor.maskings, poor.files, poor.bytes]).toEqual([0, 0, 0]);
    // It is not remembered as refused: with the budget for it, it is masked.
    again.maskedBytes = 401;
    expect(await poor.file('a.txt', again)).toMatchObject({ kind: 'text' });
    expect(again.maskedBytes).toBe(0);
    // A file that is not there, or not text, needs no masking and costs nothing.
    expect(await poor.file('nope.txt', { maskedBytes: 0 })).toEqual({ kind: 'absent' });
    expect(asked.filter((path) => path === 'nope.txt')).toHaveLength(1);
    // Without a budget there is no limit.
    expect(await filesOf(reader).file('a.txt')).toMatchObject({ kind: 'text' });
  });

  it('charges a file again each time it is masked again', async () => {
    const reader = memorySnapshot({ files: { 'k.txt': KEY_FILE } });
    const files = filesOf(reader, { maxBytes: 100 });
    const size = Buffer.byteLength(KEY_FILE);
    const budget = { maskedBytes: 3 * size };
    for (let i = 0; i < 3; i++) {
      expect(await files.file('k.txt', budget)).toMatchObject({ kind: 'text' });
    }
    expect(budget.maskedBytes).toBe(0);
    expect(files.maskings).toBe(3);
    expect(await files.file('k.txt', budget)).toEqual({ kind: 'budget' });
    expect(files.maskings).toBe(3);
  });

  it('shares a masking in progress with every request for the file, and charges it once', async () => {
    const { reader, asked } = counting(memorySnapshot({ files: { 'key.txt': KEY_FILE } }));
    const files = filesOf(reader);
    const budget = { maskedBytes: 10_000 };
    const all = await Promise.all(Array.from({ length: 5 }, () => files.file('key.txt', budget)));
    expect(all.every((file) => file.kind === 'text')).toBe(true);
    expect(budget.maskedBytes).toBe(10_000 - Buffer.byteLength(KEY_FILE));
    expect([files.maskings, asked.length]).toEqual([1, 1]);
    // Requests that wait for a refusal are refused too, and nothing is charged.
    const none = { maskedBytes: 10 };
    const fresh = filesOf(reader);
    const refused = await Promise.all([fresh.file('key.txt', none), fresh.file('key.txt', none)]);
    expect(refused).toEqual([{ kind: 'budget' }, { kind: 'budget' }]);
    expect(none.maskedBytes).toBe(10);
  });

  it('does not keep a failed read: the request fails, those that waited for it fail, and the next tries again', async () => {
    const inner = memorySnapshot({ files: { 'key.txt': KEY_FILE } });
    let failures = 1;
    let reads = 0;
    const reader: SnapshotReader = {
      ...inner,
      file: async (path) => {
        reads += 1;
        // Long enough for the second request to arrive while the first waits.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (failures > 0) {
          failures -= 1;
          throw new Error('connection lost');
        }
        return inner.file(path);
      },
    };
    const files = filesOf(reader);
    const budget = { maskedBytes: 10_000 };
    const first = await Promise.allSettled([
      files.file('key.txt', budget),
      files.file('key.txt', budget),
    ]);
    expect(first.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(reads).toBe(1);
    // Nothing was charged or kept; the next request reads the file again and masks it.
    expect(budget.maskedBytes).toBe(10_000);
    expect(await files.file('key.txt', budget)).toMatchObject({ kind: 'text', redactions: 32 });
    expect(reads).toBe(2);
    expect(budget.maskedBytes).toBe(10_000 - Buffer.byteLength(KEY_FILE));
    expect(files.maskings).toBe(1);
  });

  it('passes an omitted or an absent file on, and keeps nothing of it', async () => {
    const { reader, asked } = counting(
      memorySnapshot({ files: { 'logo.png': { kind: 'omitted', reason: 'binary' } } }),
    );
    const files = filesOf(reader);
    for (let i = 0; i < 2; i++) {
      expect(await files.file('logo.png')).toEqual({ kind: 'omitted', reason: 'binary' });
      expect(await files.file('missing.ts')).toEqual({ kind: 'absent' });
    }
    expect(asked).toEqual(['logo.png', 'missing.ts', 'logo.png', 'missing.ts']);
    expect([files.maskings, files.files, files.bytes]).toEqual([0, 0, 0]);
  });

  it('serves the reader it was made for, and bounds a review at 64 MiB', () => {
    const reader = memorySnapshot();
    expect(filesOf(reader).reader).toBe(reader);
    expect(MASKED_CACHE_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('MaskedFiles keeps the lines the file has', () => {
  // A private key with no END line is masked to the end of the text, and the shared redaction
  // masks the empty line after the final newline too: the text comes back with a line more.
  const lone = ['before', KEY_BEGIN, keyLine(1), keyLine(2), ''].join('\n');
  const loneLong = [
    ...Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`),
    KEY_BEGIN,
    keyLine(1),
    '',
  ].join('\n');

  it('as many as the text of the snapshot has, with a private key with no END line at its end', async () => {
    // The premise: the masked text has a line more than the file.
    expect(linesOf(redactLongText(lone).text)).toHaveLength(linesOf(lone).length + 1);
    expect(linesOf(redactLongText(loneLong).text)).toHaveLength(linesOf(loneLong).length + 1);
    const files = filesOf(memorySnapshot({ files: { 'lone.txt': lone, 'long.txt': loneLong } }));
    const file = await files.file('lone.txt');
    expect(linesOfFile(file)).toEqual(['before', REDACTED, REDACTED, REDACTED]);
    const long = await files.file('long.txt');
    expect(linesOfFile(long)).toHaveLength(302);
    expect(linesOfFile(long).slice(-2)).toEqual([REDACTED, REDACTED]);
    expect(linesOfFile(long)[299]).toBe('const x299 = 299;');
  });

  it('and reports the replacements of those lines only', async () => {
    const files = filesOf(memorySnapshot({ files: { 'lone.txt': lone, 'long.txt': loneLong } }));
    // The shared redaction counts the line it added.
    expect(redactLongText(lone).count).toBe(4);
    expect(await files.file('lone.txt')).toMatchObject({ kind: 'text', redactions: 3 });
    expect(redactLongText(loneLong).count).toBe(3);
    expect(await files.file('long.txt')).toMatchObject({ kind: 'text', redactions: 2 });
  });

  it('a final newline does not start a line, and a text with none keeps its last line', async () => {
    const files = filesOf(
      memorySnapshot({
        files: { 'a.txt': 'one\ntwo\n', 'b.txt': 'one\ntwo', 'c.txt': '\n', 'd.txt': 'x\n\n' },
      }),
    );
    expect(linesOfFile(await files.file('a.txt'))).toEqual(['one', 'two']);
    expect(linesOfFile(await files.file('b.txt'))).toEqual(['one', 'two']);
    expect(linesOfFile(await files.file('c.txt'))).toEqual(['']);
    expect(linesOfFile(await files.file('d.txt'))).toEqual(['x', '']);
  });
});

describe('MaskedFiles and the time a masking may take', () => {
  const hostile = memorySnapshot({
    files: {
      'hostile.txt': HOSTILE_TEXT,
      'code.ts': 'const a = 1;\n',
      'other.ts': 'const b = 2;\n',
    },
  });

  it('answers timeout for a file that takes too long, now and for every request after it', async () => {
    const { reader, asked } = counting(hostile);
    const slow = maskerOf({ timeoutMs: 600 });
    const files = new MaskedFiles(reader, { masker: slow });
    const budget = { maskedBytes: 10_000_000 };
    expect(await files.file('hostile.txt', budget)).toEqual({ kind: 'timeout' });
    // The time was spent: so are the bytes. A request after it costs nothing and reads nothing.
    const spent = 10_000_000 - Buffer.byteLength(HOSTILE_TEXT);
    expect(budget.maskedBytes).toBe(spent);
    const workers = slow.workersStarted;
    expect(await files.file('hostile.txt', budget)).toEqual({ kind: 'timeout' });
    expect(await files.file('hostile.txt')).toEqual({ kind: 'timeout' });
    expect(budget.maskedBytes).toBe(spent);
    expect(asked).toEqual(['hostile.txt']);
    expect(slow.workersStarted).toBe(workers);
    expect([files.maskings, files.files, files.bytes]).toEqual([0, 0, 0]);
    // The other files are masked as ever, by a new worker.
    expect(linesOfFile(await files.file('code.ts', budget))).toEqual(['const a = 1;']);
    expect(slow.workersStarted).toBe(workers + 1);
  });

  it('gives the same answer to the requests that wait for a file that takes too long', async () => {
    const files = new MaskedFiles(hostile, { masker: maskerOf({ timeoutMs: 600 }) });
    const all = await Promise.all([files.file('hostile.txt'), files.file('hostile.txt')]);
    expect(all).toEqual([{ kind: 'timeout' }, { kind: 'timeout' }]);
  });

  it('answers budget, and refunds the bytes, when the review has spent the time it may spend masking', async () => {
    const files = new MaskedFiles(hostile, {
      masker: maskerOf({ timeoutMs: 5_000, budgetMs: 300 }),
    });
    const budget = { maskedBytes: 10_000_000 };
    // The text would pass the time that is left: it is neither masked nor shown.
    expect(await files.file('hostile.txt', budget)).toEqual({ kind: 'budget' });
    expect(budget.maskedBytes).toBe(10_000_000);
    // Nothing more is masked, and nothing is charged.
    expect(await files.file('code.ts', budget)).toEqual({ kind: 'budget' });
    expect(budget.maskedBytes).toBe(10_000_000);
    expect([files.maskings, files.files]).toEqual([0, 0]);
    // A file that needs no masking is not refused.
    const logo = memorySnapshot({ files: { 'logo.png': { kind: 'omitted', reason: 'binary' } } });
    expect(
      await new MaskedFiles(logo, { masker: maskerOf({ budgetMs: 1 }) }).file('logo.png'),
    ).toEqual({ kind: 'omitted', reason: 'binary' });
  });

  it('answers budget for every file with text once the time is spent, the files kept and the ones that took too long among them', async () => {
    const files = new MaskedFiles(
      memorySnapshot({
        files: {
          'kept.ts': 'const kept = 1;\n',
          'slow.txt': HOSTILE_TEXT,
          'never.ts': 'const never = 1;\n',
          'burn1.txt': HOSTILE_TEXT,
          'burn2.txt': HOSTILE_TEXT,
          'burn3.txt': HOSTILE_TEXT,
          'logo.png': { kind: 'omitted', reason: 'binary' },
        },
      }),
      // 600 ms a text, 1 500 ms for the review.
      { masker: maskerOf({ timeoutMs: 600, budgetMs: 1_500 }) },
    );
    expect(linesOfFile(await files.file('kept.ts'))).toEqual(['const kept = 1;']);
    expect(await files.file('slow.txt')).toEqual({ kind: 'timeout' });
    // While there is time, the three kinds of file are told apart.
    expect(linesOfFile(await files.file('kept.ts'))).toEqual(['const kept = 1;']);
    expect(await files.file('slow.txt')).toEqual({ kind: 'timeout' });
    expect(linesOfFile(await files.file('never.ts'))).toEqual(['const never = 1;']);
    // Texts that take too long spend what is left.
    for (const path of ['burn1.txt', 'burn2.txt', 'burn3.txt']) await files.file(path);
    // Now they are not: a file that was kept, one that took too long and one not asked for before
    // are all the same to the answer, and none of them is charged.
    const budget = { maskedBytes: 1_000 };
    for (const path of ['kept.ts', 'slow.txt', 'never.ts', 'burn1.txt', 'new.ts']) {
      expect(await files.file(path, budget), path).toEqual(
        path === 'new.ts' ? { kind: 'absent' } : { kind: 'budget' },
      );
    }
    expect(budget.maskedBytes).toBe(1_000);
    // A file that needs no masking is answered as ever.
    expect(await files.file('logo.png', budget)).toEqual({ kind: 'omitted', reason: 'binary' });
  });

  it('fails the request, and refunds the bytes, when the masker has been closed', async () => {
    const closed = maskerOf({});
    await closed.close();
    const files = new MaskedFiles(hostile, { masker: closed });
    const budget = { maskedBytes: 1_000 };
    await expect(files.file('code.ts', budget)).rejects.toThrow('closed');
    expect(budget.maskedBytes).toBe(1_000);
    expect(files.maskings).toBe(0);
  });

  it('makes a masker of its own when it is not given one, and closes it with close()', async () => {
    const files = new MaskedFiles(hostile);
    expect(linesOfFile(await files.file('code.ts'))).toEqual(['const a = 1;']);
    await files.close();
    await expect(files.file('other.ts')).rejects.toThrow('closed');
    // A masker it was given is its owner's: close() leaves it alone.
    const shared = maskerOf({});
    const given = new MaskedFiles(hostile, { masker: shared });
    await given.close();
    expect(linesOfFile(await given.file('other.ts'))).toEqual(['const b = 2;']);
  });
});
