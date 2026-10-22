import { redactLongText, REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { memorySnapshot } from '../../test/review';
import { MASKED_CACHE_BYTES, MaskedFiles } from './masked-files';
import { linesOf, type SnapshotReader } from './snapshot-reader';

const j = (...parts: string[]) => parts.join('');
const KEY_BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
const KEY_END = j('-----END ', 'RSA PRIVATE KEY-----');
const keyLine = (i: number): string =>
  j('lQOYBF', String(i).padStart(4, '0'), 'Qm9ndXMga2V5IGJvZHk'.repeat(2));
const KEY_FILE = ['before', KEY_BEGIN, ...Array.from({ length: 30 }, (_, i) => keyLine(i)), KEY_END]
  .concat('after')
  .join('\n');

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

describe('MaskedFiles', () => {
  it('masks a file as a whole: the lines, as many as the file has, and what was masked', async () => {
    const reader = memorySnapshot({
      files: { 'key.txt': KEY_FILE, 'code.ts': 'const a = 1;\nconst b = 2;\n' },
    });
    const files = new MaskedFiles(reader);
    const key = await files.file('key.txt');
    expect(key).toEqual({
      kind: 'text',
      lines: ['before', ...Array.from({ length: 32 }, () => REDACTED), 'after'],
      redactions: 32,
    });
    // The same lines as the shared redaction gives for the whole text.
    expect(key.kind === 'text' && key.lines).toEqual(linesOf(redactLongText(KEY_FILE).text));
    expect(await files.file('code.ts')).toEqual({
      kind: 'text',
      lines: ['const a = 1;', 'const b = 2;'],
      redactions: 0,
    });
    expect(await new MaskedFiles(memorySnapshot({ files: { 'e.txt': '' } })).file('e.txt')).toEqual(
      { kind: 'text', lines: [], redactions: 0 },
    );
  });

  it('masks a file once: a later request has its lines and no redactions', async () => {
    const { reader, asked } = counting(memorySnapshot({ files: { 'key.txt': KEY_FILE } }));
    const files = new MaskedFiles(reader);
    const first = await files.file('key.txt');
    const second = await files.file('key.txt');
    const third = await files.file('key.txt');
    expect(first).toMatchObject({ kind: 'text', redactions: 32 });
    expect(second).toMatchObject({ kind: 'text', redactions: 0 });
    expect(third).toMatchObject({ kind: 'text', redactions: 0 });
    if (first.kind !== 'text' || second.kind !== 'text') throw new Error('not text');
    expect(second.lines).toBe(first.lines);
    expect(asked).toEqual(['key.txt']);
    expect(files.maskings).toBe(1);
    expect(files.files).toBe(1);
  });

  it('makes one masking of requests that overlap, and reports it to one of them', async () => {
    const { reader, asked } = counting(memorySnapshot({ files: { 'key.txt': KEY_FILE } }));
    const files = new MaskedFiles(reader);
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

  it('keeps masked files up to a bound in UTF-8 bytes, and masks the others each time they are asked for', async () => {
    const text = (c: string) => `${c.repeat(400)}\n`;
    const secret = `${j('const password = "', 'hunter2-very-secret";')}\n`;
    const { reader, asked } = counting(
      memorySnapshot({
        files: {
          'a.txt': text('a'),
          'b.txt': text('b'),
          'c.txt': secret + text('c'),
          'é.txt': text('é'),
        },
      }),
    );
    const files = new MaskedFiles(reader, 1_300);
    const redactions = async (path: string) => {
      const file = await files.file(path);
      return file.kind === 'text' ? file.redactions : -1;
    };
    // 401 bytes for a, 401 for b, 434 for c (the marker takes 12 bytes), 801 for é (2 bytes each).
    expect(await redactions('a.txt')).toBe(0);
    expect(await redactions('b.txt')).toBe(0);
    expect(files.bytes).toBe(802);
    expect(await redactions('c.txt')).toBe(1);
    expect(files.bytes).toBe(802 + 434);
    // Past 1 300 bytes: é is not kept, and each request masks it again.
    expect(await redactions('é.txt')).toBe(0);
    expect(await redactions('é.txt')).toBe(0);
    expect(files.bytes).toBe(802 + 434);
    expect(files.files).toBe(3);
    expect(asked).toEqual(['a.txt', 'b.txt', 'c.txt', 'é.txt', 'é.txt']);
    expect(files.maskings).toBe(5);
    // What is kept is served without a read.
    await files.file('a.txt');
    await files.file('c.txt');
    expect(asked).toHaveLength(5);
    expect(files.bytes).toBeLessThanOrEqual(1_300);
  });

  it('counts the replacements of a file once, also when it is masked again', async () => {
    const reader = memorySnapshot({ files: { 'k.txt': KEY_FILE } });
    const files = new MaskedFiles(reader, 100);
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
    const secret = `${j('const password = "', 'hunter2-very-secret";')}\n`;
    const text = (c: string) => `${c.repeat(400)}\n`;
    const { reader, asked } = counting(
      memorySnapshot({ files: { 'a.txt': text('a'), 'b.txt': text('b'), 's.txt': secret } }),
    );
    const files = new MaskedFiles(reader);
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
    const poor = new MaskedFiles(reader);
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
    expect(await new MaskedFiles(reader).file('a.txt')).toMatchObject({ kind: 'text' });
  });

  it('charges a file again each time it is masked again', async () => {
    const reader = memorySnapshot({ files: { 'k.txt': KEY_FILE } });
    const files = new MaskedFiles(reader, 100);
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
    const files = new MaskedFiles(reader);
    const budget = { maskedBytes: 10_000 };
    const all = await Promise.all(Array.from({ length: 5 }, () => files.file('key.txt', budget)));
    expect(all.every((file) => file.kind === 'text')).toBe(true);
    expect(budget.maskedBytes).toBe(10_000 - Buffer.byteLength(KEY_FILE));
    expect([files.maskings, asked.length]).toEqual([1, 1]);
    // Requests that wait for a refusal are refused too, and nothing is charged.
    const none = { maskedBytes: 10 };
    const fresh = new MaskedFiles(reader);
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
    const files = new MaskedFiles(reader);
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
    const files = new MaskedFiles(reader);
    for (let i = 0; i < 2; i++) {
      expect(await files.file('logo.png')).toEqual({ kind: 'omitted', reason: 'binary' });
      expect(await files.file('missing.ts')).toEqual({ kind: 'absent' });
    }
    expect(asked).toEqual(['logo.png', 'missing.ts', 'logo.png', 'missing.ts']);
    expect([files.maskings, files.files, files.bytes]).toEqual([0, 0, 0]);
  });

  it('serves the reader it was made for, and bounds a review at 64 MiB', () => {
    const reader = memorySnapshot();
    expect(new MaskedFiles(reader).reader).toBe(reader);
    expect(MASKED_CACHE_BYTES).toBe(64 * 1024 * 1024);
  });
});
