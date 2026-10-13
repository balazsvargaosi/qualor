import { crc32 } from 'node:zlib';
import { expect } from 'vitest';

export interface ZipEntry {
  name: string;
  data: Buffer;
  flags: number;
}

/**
 * A small reader for the store-only archives of `server/src/support/zip.ts`: walks the central
 * directory and checks each entry against its local header and its CRC-32.
 */
export function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  expect(pos + zip.readUInt32LE(end + 12)).toBe(end);
  const entries: ZipEntry[] = [];
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
