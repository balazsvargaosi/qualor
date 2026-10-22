import { scrubCredentials, type Git } from './git';

/** One entry of `git ls-tree -r -z --long`. */
export interface TreeEntry {
  /** `100644`, `100755`, `120000` (a symbolic link), `160000` (a submodule). */
  mode: string;
  /** `blob`, or `commit` for a submodule. */
  type: string;
  oid: string;
  /** The blob's size in bytes; null for a submodule (`-`). */
  size: number | null;
  /** As git gives it: nothing is quoted under `-z`, and nothing is normalised here. */
  path: string;
}

/** `<mode> SP <type> SP <oid> SP <size, padded> TAB <path>` records, NUL-terminated. */
export function parseLsTreeLong(output: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const record of output.split('\u0000')) {
    // The fields hold no tab, the path may: the first tab ends the fields.
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, oid, size, ...rest] = record.slice(0, tab).split(' ').filter(Boolean);
    if (mode === undefined || type === undefined || oid === undefined || size === undefined) {
      continue;
    }
    if (rest.length > 0 || (size !== '-' && !/^\d+$/.test(size))) continue;
    out.push({
      mode,
      type,
      oid,
      size: size === '-' ? null : Number(size),
      path: record.slice(tab + 1),
    });
  }
  return out;
}

const LF = 0x0a;

/** The header git answers each object with: `<oid> <type> <size>`, or `<oid> missing`. */
function objectSize(header: string): number | null {
  const size = /^\S+ \S+ (\d+)$/.exec(header)?.[1];
  return size === undefined ? null : Number(size);
}

/**
 * Reads `oids` through one `git cat-file --batch`, as a stream: `onObject` gets each object in the
 * order asked, with its index, as its raw bytes, or null when git does not have it. Only the object
 * being read is held in memory. `onObject` answers false to stop reading (git is stopped then).
 * Rejects when git fails before it has answered every object.
 */
export async function readObjects(
  git: Git,
  oids: readonly string[],
  onObject: (index: number, content: Buffer | null) => boolean,
): Promise<void> {
  if (oids.length === 0) return;
  let index = 0;
  let stopped = false;
  /** The header line read so far, when it came in pieces. */
  let header: Buffer[] = [];
  /** The object being read, and how much of it has come. */
  let body: Buffer | null = null;
  let filled = 0;
  /** The newline after an object's content, still to come. */
  let newline = false;

  const deliver = (content: Buffer | null): boolean => {
    const more = onObject(index, content);
    index += 1;
    if (!more) stopped = true;
    return more;
  };
  /** Takes the bytes of `chunk` from `at` on; answers where it stopped, or -1 to stop. */
  const step = (chunk: Buffer, at: number): number => {
    if (newline) {
      newline = false;
      return at + 1;
    }
    if (body !== null) {
      const n = Math.min(body.length - filled, chunk.length - at);
      chunk.copy(body, filled, at, at + n);
      filled += n;
      if (filled < body.length) return at + n;
      const done = body;
      body = null;
      newline = true;
      return deliver(done) ? at + n : -1;
    }
    const lf = chunk.indexOf(LF, at);
    if (lf === -1) {
      header.push(chunk.subarray(at));
      return chunk.length;
    }
    const line = Buffer.concat([...header, chunk.subarray(at, lf)]).toString('latin1');
    header = [];
    const size = objectSize(line);
    if (size === null) return deliver(null) ? lf + 1 : -1;
    body = Buffer.allocUnsafe(size);
    filled = 0;
    return lf + 1;
  };
  const consume = (chunk: Buffer): boolean => {
    let at = 0;
    // An object of size 0 is complete before any of its bytes come.
    while (at < chunk.length || (body !== null && filled === body.length)) {
      at = step(chunk, at);
      if (at === -1) return false;
    }
    return true;
  };

  const r = await git(['cat-file', '--batch'], {
    input: oids.map((oid) => `${oid}\n`).join(''),
    onStdout: consume,
  });
  if (stopped || index === oids.length) return;
  const why = r.stderr.trim() === '' ? `exit code ${r.code}` : r.stderr.trim();
  throw new Error(scrubCredentials(`git cat-file --batch failed: ${why}`));
}
