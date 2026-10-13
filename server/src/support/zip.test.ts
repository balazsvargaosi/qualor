import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipTooLargeError, zipStore } from './zip';

/** A small reader: walks the central directory and checks each entry against its local header. */
function readZip(zip: Buffer): { name: string; data: Buffer; flags: number }[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  expect(pos + zip.readUInt32LE(end + 12)).toBe(end);
  const entries: { name: string; data: Buffer; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(pos + 8);
    expect(zip.readUInt16LE(pos + 10)).toBe(0);
    const crc = zip.readUInt32LE(pos + 16);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.readUInt32LE(local + 14)).toBe(crc);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data, flags });
    pos += 46 + nameLength;
  }
  return entries;
}

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
});
