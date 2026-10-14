import { describe, expect, it } from 'vitest';
import { readZip } from '../../test/zip';
import { MAX_ZIP_ENTRIES, ZipTooLargeError, zipStore } from './zip';

describe('zipStore', () => {
  it('stores an empty file, a 6 MiB file and a non-ASCII name, with matching CRCs', () => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 0xff;
    const zip = zipStore([
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'big.bin', data: big },
      { name: 'dir/größe-日本.txt', data: Buffer.from('héllo') },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['empty.txt', 'big.bin', 'dir/größe-日本.txt']);
    expect(entries[0]?.data.length).toBe(0);
    expect(entries[1]?.data.equals(big)).toBe(true);
    expect(entries[2]?.data.toString('utf8')).toBe('héllo');
    for (const entry of entries) expect(entry.flags & 0x0800).toBe(0x0800);
  });

  it('writes a valid archive with no entries', () => {
    expect(readZip(zipStore([]))).toEqual([]);
  });

  it('refuses an archive over 4 GiB', () => {
    const huge = { length: 4 * 1024 ** 3 } as unknown as Buffer;
    expect(() => zipStore([{ name: 'x', data: huge }])).toThrow(ZipTooLargeError);
  });

  it('writes 65 534 entries and refuses one more (0xFFFF marks ZIP64 to some readers)', () => {
    expect(MAX_ZIP_ENTRIES).toBe(65_534);
    const files = Array.from({ length: MAX_ZIP_ENTRIES }, (_, i) => ({
      name: `f${i}`,
      data: Buffer.alloc(0),
    }));
    expect(readZip(zipStore(files))).toHaveLength(MAX_ZIP_ENTRIES);
    files.push({ name: 'one-more', data: Buffer.alloc(0) });
    expect(() => zipStore(files)).toThrow(ZipTooLargeError);
  });
});
