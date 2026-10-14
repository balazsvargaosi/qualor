import { crc32 } from 'node:zlib';

/** The classic zip format has 32-bit sizes and offsets, and this writer has no ZIP64. */
const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3 - 1;
/** 0xFFFF in the end record's counts tells some readers to look for a ZIP64 record. */
export const MAX_ZIP_ENTRIES = 0xfffe;

export class ZipTooLargeError extends Error {
  constructor(message = 'the archive would be larger than 4 GiB') {
    super(message);
    this.name = 'ZipTooLargeError';
  }
}

function dosDateTime(now: Date): { time: number; date: number } {
  const year = Math.max(1980, now.getFullYear());
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

/**
 * A zip archive of stored (uncompressed) entries: UTF-8 names (flag bit 11), CRC-32 per entry,
 * the central directory and the end record. No ZIP64: more than 4 GiB or more than
 * {@link MAX_ZIP_ENTRIES} entries is refused.
 */
export function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  if (files.length > MAX_ZIP_ENTRIES) throw new ZipTooLargeError('too many entries for a zip');
  const { time, date } = dosDateTime(new Date());
  const names = files.map((file) => Buffer.from(file.name, 'utf8'));
  let total = 22;
  files.forEach((file, i) => {
    total += 30 + 46 + 2 * (names[i]?.length ?? 0) + file.data.length;
  });
  if (total > MAX_ARCHIVE_BYTES) throw new ZipTooLargeError();

  const out = Buffer.alloc(total);
  let pos = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];
  files.forEach((file, i) => {
    const name = names[i] ?? Buffer.alloc(0);
    const crc = crc32(file.data);
    crcs.push(crc);
    offsets.push(pos);
    pos = out.writeUInt32LE(0x04034b50, pos);
    pos = out.writeUInt16LE(20, pos); // version needed
    pos = out.writeUInt16LE(0x0800, pos); // flags: UTF-8 names
    pos = out.writeUInt16LE(0, pos); // method: stored
    pos = out.writeUInt16LE(time, pos);
    pos = out.writeUInt16LE(date, pos);
    pos = out.writeUInt32LE(crc, pos);
    pos = out.writeUInt32LE(file.data.length, pos);
    pos = out.writeUInt32LE(file.data.length, pos);
    pos = out.writeUInt16LE(name.length, pos);
    pos = out.writeUInt16LE(0, pos); // extra length
    pos += name.copy(out, pos);
    pos += file.data.copy(out, pos);
  });
  const directoryStart = pos;
  files.forEach((file, i) => {
    const name = names[i] ?? Buffer.alloc(0);
    pos = out.writeUInt32LE(0x02014b50, pos);
    pos = out.writeUInt16LE(20, pos); // version made by
    pos = out.writeUInt16LE(20, pos); // version needed
    pos = out.writeUInt16LE(0x0800, pos);
    pos = out.writeUInt16LE(0, pos);
    pos = out.writeUInt16LE(time, pos);
    pos = out.writeUInt16LE(date, pos);
    pos = out.writeUInt32LE(crcs[i] ?? 0, pos);
    pos = out.writeUInt32LE(file.data.length, pos);
    pos = out.writeUInt32LE(file.data.length, pos);
    pos = out.writeUInt16LE(name.length, pos);
    pos = out.writeUInt16LE(0, pos); // extra length
    pos = out.writeUInt16LE(0, pos); // comment length
    pos = out.writeUInt16LE(0, pos); // disk number
    pos = out.writeUInt16LE(0, pos); // internal attributes
    pos = out.writeUInt32LE(0, pos); // external attributes
    pos = out.writeUInt32LE(offsets[i] ?? 0, pos);
    pos += name.copy(out, pos);
  });
  const directorySize = pos - directoryStart;
  pos = out.writeUInt32LE(0x06054b50, pos);
  pos = out.writeUInt16LE(0, pos);
  pos = out.writeUInt16LE(0, pos);
  pos = out.writeUInt16LE(files.length, pos);
  pos = out.writeUInt16LE(files.length, pos);
  pos = out.writeUInt32LE(directorySize, pos);
  pos = out.writeUInt32LE(directoryStart, pos);
  out.writeUInt16LE(0, pos);
  return out;
}
