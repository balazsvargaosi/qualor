import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as shared from '../index';
import { cutAtGrapheme } from '../markdown/code-span';
import {
  encodeSnapshotLine,
  INSTRUCTION_FILES,
  MAX_INSTRUCTIONS_BYTES,
  MAX_MR_DESCRIPTION_CHARS,
  MAX_MR_TITLE_CHARS,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_LINE_BYTES,
  MAX_SNAPSHOT_PATCH_BYTES,
  MAX_SNAPSHOT_PATH_BYTES,
  MAX_SNAPSHOT_ROWS,
  OMISSION_REASONS,
  parseSnapshotLine,
  REVIEW_SNAPSHOT_CONTENT_TYPE,
  SNAPSHOT_CHANGES,
  SNAPSHOT_VERSION,
  snapshotChangeSchema,
  snapshotEndSchema,
  snapshotFileSchema,
  snapshotHeaderSchema,
  snapshotInstructionsSchema,
  snapshotLineSchema,
  snapshotOmittedSchema,
  snapshotPathProblem,
  SnapshotFormatError,
  type SnapshotLine,
} from './snapshot';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const header = {
  type: 'header',
  v: 1,
  headSha: HEAD,
  baseSha: BASE,
  sinceSha: 'c'.repeat(40),
  targetBranch: 'main',
  mergeRequest: {
    id: '42',
    title: 'Add the thing',
    description: 'It adds the thing.\n\nCloses #7.',
  },
  partial: false,
  generator: 'qualor-cli/0.12.0',
} satisfies SnapshotLine;
const file = {
  type: 'file',
  path: 'src/a.ts',
  text: 'export const a = 1;\n',
} satisfies SnapshotLine;
const change = {
  type: 'change',
  path: 'src/b.ts',
  oldPath: 'src/old-b.ts',
  status: 'renamed',
  patch: '@@ -1 +1 @@\n-a\n+b\n',
  since: [
    [1, 1],
    [5, 9],
  ],
} satisfies SnapshotLine;
const omitted = {
  type: 'omitted',
  path: 'assets/logo.png',
  reason: 'binary',
} satisfies SnapshotLine;
const instructions = {
  type: 'instructions',
  name: 'AGENTS.md',
  text: '# Rules\n',
} satisfies SnapshotLine;
const end = { type: 'end', files: 1, changes: 1, omitted: 1 } satisfies SnapshotLine;

const LINES: [string, SnapshotLine][] = [
  ['header', header],
  ['file', file],
  ['change', change],
  ['omitted', omitted],
  ['instructions', instructions],
  ['end', end],
];

/** The reason a line is refused with, or null when it is accepted (a string is parsed as is). */
function refusal(line: unknown): string | null {
  const text = typeof line === 'string' ? line : JSON.stringify(line);
  try {
    parseSnapshotLine(text);
    return null;
  } catch (error) {
    if (error instanceof SnapshotFormatError) return error.reason;
    throw error;
  }
}

describe('the snapshot format constants (6I-2 Global Constraints)', () => {
  it('has the transport, the version and the bounds of the plan', () => {
    expect(REVIEW_SNAPSHOT_CONTENT_TYPE).toBe('application/vnd.qualor.review-snapshot+jsonl');
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(MAX_SNAPSHOT_FILE_BYTES).toBe(1_048_576);
    expect(MAX_SNAPSHOT_FILES).toBe(50_000);
    // The paths of one snapshot, its files, changes and omissions together: the rows it unpacks into.
    expect(MAX_SNAPSHOT_ROWS).toBe(100_000);
    expect(MAX_SNAPSHOT_PATCH_BYTES).toBe(262_144);
    expect(MAX_SNAPSHOT_LINE_BYTES).toBe(8_388_608);
    expect(MAX_SNAPSHOT_PATH_BYTES).toBe(1_024);
    expect(MAX_INSTRUCTIONS_BYTES).toBe(65_536);
    expect(MAX_MR_TITLE_CHARS).toBe(255);
    expect(MAX_MR_DESCRIPTION_CHARS).toBe(12_000);
  });

  it('lists the instruction files, the changes and the eight omission reasons (ruling P3)', () => {
    expect([...INSTRUCTION_FILES]).toEqual(['AGENTS.md', 'CLAUDE.md', 'REVIEW.md']);
    expect([...SNAPSHOT_CHANGES]).toEqual(['added', 'modified', 'renamed', 'deleted']);
    // The CHECK of review_snapshot_files.omitted (migration 0015) lists exactly these. A path that
    // fails the path rule is never sent at all, so `path_too_long` is not a reason.
    expect([...OMISSION_REASONS]).toEqual([
      'binary',
      'too_large',
      'excluded',
      'credentials',
      'symlink',
      'submodule',
      'limit',
      'not_utf8',
    ]);
  });

  it('is exported from the package index, without a clash with another export', () => {
    expect(shared.parseSnapshotLine).toBe(parseSnapshotLine);
    expect(shared.encodeSnapshotLine).toBe(encodeSnapshotLine);
    expect(shared.snapshotPathProblem).toBe(snapshotPathProblem);
    expect(shared.snapshotLineSchema).toBe(snapshotLineSchema);
    expect(shared.OMISSION_REASONS).toBe(OMISSION_REASONS);
    expect(shared.MAX_SNAPSHOT_FILE_BYTES).toBe(MAX_SNAPSHOT_FILE_BYTES);
    expect(shared.MAX_SNAPSHOT_ROWS).toBe(MAX_SNAPSHOT_ROWS);
  });
});

describe('encodeSnapshotLine and parseSnapshotLine', () => {
  it.each(LINES)('round-trips a %s line', (_name, line) => {
    const text = encodeSnapshotLine(line);
    expect(text.indexOf('\n')).toBe(text.length - 1);
    expect(parseSnapshotLine(text)).toEqual(line);
  });

  it('round-trips a header without title, description and last reviewed commit, and a bare change', () => {
    const bare = {
      ...header,
      sinceSha: null,
      mergeRequest: { id: '1', title: null, description: null },
      partial: true,
    } satisfies SnapshotLine;
    expect(parseSnapshotLine(encodeSnapshotLine(bare))).toEqual(bare);
    const modified = {
      ...change,
      oldPath: null,
      status: 'modified',
      patch: null,
      since: null,
    } satisfies SnapshotLine;
    expect(parseSnapshotLine(encodeSnapshotLine(modified))).toEqual(modified);
  });

  it('keeps every line on one line, whatever the text holds', () => {
    const text =
      'one\ntwo\r\nthree\ttab "quote" \\ back \u0001 \u{2028} \u{2029} \u0085 😀 é \ud800';
    const line = { ...file, text };
    const encoded = encodeSnapshotLine(line);
    expect(encoded.slice(0, -1)).not.toMatch(/[\n\r]/);
    expect(parseSnapshotLine(encoded)).toEqual(line);
  });

  it('accepts a line without its terminator and with a CRLF one', () => {
    const encoded = encodeSnapshotLine(file);
    expect(parseSnapshotLine(encoded.slice(0, -1))).toEqual(file);
    expect(parseSnapshotLine(`${encoded.slice(0, -1)}\r\n`)).toEqual(file);
  });

  it('refuses two lines in one, an empty line and text that is not JSON', () => {
    expect(refusal(`${JSON.stringify(file)}\n${JSON.stringify(end)}`)).toBe('invalid_json');
    expect(refusal('')).toBe('invalid_json');
    expect(refusal('\n')).toBe('invalid_json');
    expect(refusal('{"type":')).toBe('invalid_json');
    expect(refusal('not json')).toBe('invalid_json');
  });

  it('reads a whole snapshot back after gzip and a split at the newlines', () => {
    const lines: SnapshotLine[] = [
      header,
      instructions,
      change,
      { ...file, text: 'line 1\nline 2\n\u{2028}😀\n' },
      omitted,
      end,
    ];
    const upload = gzipSync(lines.map(encodeSnapshotLine).join(''));
    const records = gunzipSync(upload).toString('utf8').split('\n');
    expect(records.pop()).toBe('');
    expect(records).toHaveLength(lines.length);
    expect(records.map(parseSnapshotLine)).toEqual(lines);
  });

  it('is a SnapshotFormatError that carries the reason', () => {
    let caught: unknown;
    try {
      parseSnapshotLine('{');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SnapshotFormatError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as SnapshotFormatError).reason).toBe('invalid_json');
    expect((caught as SnapshotFormatError).name).toBe('SnapshotFormatError');
    expect((caught as SnapshotFormatError).message).toContain('invalid_json');
  });
});

describe('unknown lines and versions', () => {
  it.each([
    [{}],
    [{ type: 'bogus' }],
    [{ type: 'File', path: 'a', text: '' }],
    [{ type: 7 }],
    [{ type: null }],
    [{ ...file, type: undefined }],
  ])('refuses %j as an unknown type', (line) => {
    expect(refusal(line)).toBe('unknown_type');
  });

  it.each([[[]], [null], ['header'], [42], [true]])(
    'refuses %j, which is not an object',
    (line) => {
      // As JSON text: `refusal` would take a string as the line itself.
      expect(refusal(JSON.stringify(line))).toBe('unknown_type');
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'refuses the type %s, a property that every object has',
    (type) => {
      expect(refusal({ type })).toBe('unknown_type');
    },
  );

  it('refuses a __proto__ key as an unknown field, and pollutes nothing', () => {
    const line = '{"type":"end","files":0,"changes":0,"omitted":0,"__proto__":{"polluted":1}}';
    expect(refusal(line)).toBe('unknown field');
    expect(refusal(`{"__proto__":{"type":"end"},${line.slice(1)}`)).toBe('unknown field');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses deeply nested JSON like any other line that is not a snapshot line', () => {
    const depth = 100_000;
    expect(refusal('['.repeat(depth) + ']'.repeat(depth))).toBe('unknown_type');
    expect(refusal('{"a":'.repeat(depth) + '1' + '}'.repeat(depth))).toBe('unknown_type');
  });

  it.each([2, 0, '1', 1.5, null])('refuses a header with v %j', (v) => {
    expect(refusal({ ...header, v })).toBe('unsupported_version');
  });

  it('refuses a header without v', () => {
    const noVersion = JSON.stringify(header, (key, value: unknown) =>
      key === 'v' ? undefined : value,
    );
    expect(noVersion).not.toContain('"v"');
    expect(refusal(noVersion)).toBe('unsupported_version');
  });

  it('refuses a field a line type does not have, and says so without naming it', () => {
    for (const line of [header, file, change, omitted, instructions, end]) {
      expect(refusal({ ...line, extra: 1 }), line.type).toBe('unknown field');
    }
    expect(refusal({ ...header, mergeRequest: { ...header.mergeRequest, extra: 1 } })).toBe(
      'mergeRequest: unknown field',
    );
  });

  it('refuses a missing field and a field of the wrong type', () => {
    expect(refusal({ type: 'file', path: 'a.ts' })).toMatch(/^text: /);
    expect(refusal({ ...file, text: 5 })).toMatch(/^text: /);
    expect(refusal({ ...file, text: null })).toMatch(/^text: /);
    expect(refusal({ ...header, partial: 'false' })).toMatch(/^partial: /);
    expect(refusal({ ...header, generator: '' })).toMatch(/^generator: /);
    expect(refusal({ ...header, generator: 'g'.repeat(129) })).toMatch(/^generator: /);
    expect(refusal({ ...change, status: 'copied' })).toMatch(/^status: /);
    expect(refusal({ ...change, patch: 5 })).toMatch(/^patch: /);
  });

  it('never echoes the content of a refused line in the reason', () => {
    const secret = 'AKIA-NOT-FOR-LOGS-'.repeat(40);
    const reasons = [
      refusal({ ...end, [secret]: 1 }),
      refusal({ ...file, [secret]: 1 }),
      refusal({ ...header, mergeRequest: { ...header.mergeRequest, [secret]: 1 } }),
      refusal({ ...file, path: `../${secret}` }),
      refusal({ ...file, text: secret.length }),
      refusal({ ...omitted, reason: secret }),
      refusal({ ...instructions, name: secret }),
      refusal({ ...change, status: secret }),
      refusal({ ...header, headSha: secret }),
      refusal({ ...header, v: secret }),
      refusal({ type: secret }),
      refusal(`{"${secret}"`),
    ];
    for (const reason of reasons) {
      expect(reason).not.toBeNull();
      expect(reason).not.toContain('AKIA');
      expect(reason?.length).toBeLessThan(160);
    }
  });
});

describe('snapshotPathProblem', () => {
  it.each([
    'a/b.ts',
    'src/a.ts',
    'a',
    'dir.with.dots/.hidden/file',
    '.gitignore',
    '...',
    'a..b/c',
    'with space/and\u00a0nbsp.ts',
    'café/ünï.ts',
    '日本語/ファイル.ts',
  ])('accepts %j', (path) => {
    expect(snapshotPathProblem(path)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['../x', 'dot-segment'],
    ['..', 'dot-segment'],
    ['.', 'dot-segment'],
    ['a/../b', 'dot-segment'],
    ['a/..', 'dot-segment'],
    ['a/./b', 'dot-segment'],
    ['./a', 'dot-segment'],
    ['/x', 'absolute'],
    ['/', 'absolute'],
    ['a\\b', 'backslash'],
    ['..\\x', 'backslash'],
    ['a//b', 'double-slash'],
    ['a/', 'double-slash'],
    ['a\u0000b', 'nul'],
    ['\u0000', 'nul'],
    ['a\nb', 'control-char'],
    ['a\tb', 'control-char'],
    ['a\u001bb', 'control-char'],
    ['a\u007fb', 'control-char'],
    ['a\u0085b', 'control-char'],
    ['a\u009bb', 'control-char'],
    ['a\u{2028}b', 'control-char'],
    ['invoice\u{202e}gpj.exe', 'control-char'],
  ])('refuses %j (%s)', (path, problem) => {
    expect(snapshotPathProblem(path)).toBe(problem);
  });

  it('refuses a path of 1 025 bytes and accepts one of 1 024', () => {
    expect(snapshotPathProblem('a'.repeat(MAX_SNAPSHOT_PATH_BYTES))).toBeNull();
    expect(snapshotPathProblem('a'.repeat(MAX_SNAPSHOT_PATH_BYTES + 1))).toBe('too-long');
    // The same with directories: a long path made of valid segments.
    expect(snapshotPathProblem(`${'ab/'.repeat(341)}c`)).toBeNull();
    expect(snapshotPathProblem(`${'ab/'.repeat(342)}c`)).toBe('too-long');
  });

  it('counts UTF-8 bytes, not characters, for the length limit (ruling P5)', () => {
    expect('é'.repeat(513)).toHaveLength(513);
    expect(snapshotPathProblem('é'.repeat(513))).toBe('too-long');
    expect(snapshotPathProblem('é'.repeat(512))).toBeNull();
    // 3 bytes each: 341 characters are 1 023 bytes, 342 are 1 026.
    expect(snapshotPathProblem('日'.repeat(341))).toBeNull();
    expect(snapshotPathProblem('日'.repeat(342))).toBe('too-long');
    // 4 bytes each, 2 UTF-16 units each.
    expect(snapshotPathProblem('😀'.repeat(256))).toBeNull();
    expect(snapshotPathProblem('😀'.repeat(257))).toBe('too-long');
  });

  it('refuses a path of many megabytes at once', () => {
    expect(snapshotPathProblem('x'.repeat(10_000_000))).toBe('too-long');
  });

  // Review Focus 1: whichever line carries it, the whole snapshot is refused.
  it.each(['../x', 'a/../b', '/etc/passwd', 'a\\b', 'a\u0000b', 'a//b', './a', 'a/', ''])(
    'refuses %j as the path of a file, change or omitted line, and as the old path',
    (path) => {
      expect(refusal({ ...file, path })).toMatch(/^path: invalid path \(/);
      expect(refusal({ ...change, path })).toMatch(/^path: invalid path \(/);
      expect(refusal({ ...omitted, path })).toMatch(/^path: invalid path \(/);
      expect(refusal({ ...change, oldPath: path })).toMatch(/^oldPath: invalid path \(/);
    },
  );

  it('refuses a path that is not a string', () => {
    expect(refusal({ ...file, path: null })).toMatch(/^path: /);
    expect(refusal({ ...file, path: ['a'] })).toMatch(/^path: /);
    expect(refusal({ ...change, oldPath: 5 })).toMatch(/^oldPath: /);
    expect(refusal({ type: 'file', text: '' })).toMatch(/^path: /);
  });
});

describe('the since ranges of a change line', () => {
  const withSince = (since: unknown) => refusal({ ...change, since });

  it.each([
    [null],
    [[]],
    [[[1, 1]]],
    [[[1, 3]]],
    [
      [
        [1, 3],
        [4, 6],
      ],
    ],
    [
      [
        [1, 2],
        [10, 20],
        [30, 30],
      ],
    ],
    [[[2_000_000, 2_000_005]]],
  ])('accepts %j', (since) => {
    expect(withSince(since)).toBeNull();
  });

  it.each([
    ['start below 1', [[0, 3]]],
    ['negative start', [[-4, 3]]],
    ['end before start', [[5, 3]]],
    [
      'a range that overlaps the previous one',
      [
        [1, 5],
        [3, 8],
      ],
    ],
    [
      'a range inside the previous one',
      [
        [1, 9],
        [3, 4],
      ],
    ],
    [
      'ranges that share a line',
      [
        [1, 2],
        [2, 3],
      ],
    ],
    [
      'the same range twice',
      [
        [1, 2],
        [1, 2],
      ],
    ],
    [
      'ranges out of order',
      [
        [3, 4],
        [1, 2],
      ],
    ],
    [
      'a later range that starts first',
      [
        [5, 6],
        [1, 9],
      ],
    ],
    ['a fractional line', [[1.5, 3]]],
    ['a line as a string', [['1', '3']]],
    ['a null line', [[null, 3]]],
    ['a triple', [[1, 2, 3]]],
    ['a single number', [[1]]],
    ['a range that is not an array', [{ start: 1, end: 2 }]],
    ['since as an object', { 0: [1, 2] }],
    ['since as a number', 5],
    ['a line beyond the safe integers', [[1, 1e300]]],
  ])('refuses %s', (_name, since) => {
    expect(withSince(since)).toMatch(/^since/);
  });

  it('says which rule a refused range breaks', () => {
    expect(withSince([[5, 3]])).toBe('since.0: a range must end at or after its start');
    expect(
      withSince([
        [1, 5],
        [3, 8],
      ]),
    ).toBe('since.1: ranges must be sorted and must not overlap');
  });
});

describe('the byte and character bounds count UTF-8 bytes and code points (ruling P5)', () => {
  const MAX = (n: number) => 'a'.repeat(n);

  it('refuses a file text over 1 MiB, and accepts one of exactly 1 MiB', () => {
    expect(refusal({ ...file, text: MAX(MAX_SNAPSHOT_FILE_BYTES) })).toBeNull();
    expect(refusal({ ...file, text: MAX(MAX_SNAPSHOT_FILE_BYTES + 1) })).toBe(
      `text: too long (limit ${MAX_SNAPSHOT_FILE_BYTES} bytes)`,
    );
    expect(refusal({ ...file, text: '' })).toBeNull();
  });

  it('counts the bytes of a file text, not its characters', () => {
    const half = MAX_SNAPSHOT_FILE_BYTES / 2;
    expect(refusal({ ...file, text: 'é'.repeat(half) })).toBeNull();
    expect(refusal({ ...file, text: 'é'.repeat(half + 1) })).toMatch(/^text: too long/);
    expect(refusal({ ...file, text: '😀'.repeat(MAX_SNAPSHOT_FILE_BYTES / 4) })).toBeNull();
    expect(refusal({ ...file, text: '😀'.repeat(MAX_SNAPSHOT_FILE_BYTES / 4 + 1) })).toMatch(
      /^text: too long/,
    );
  });

  it('keeps even a worst-case valid file within the line limit', () => {
    // 1 MiB of control characters is escaped to 6 bytes each (\u0001), the longest JSON can be.
    const text = '\u0001'.repeat(MAX_SNAPSHOT_FILE_BYTES);
    const encoded = encodeSnapshotLine({ ...file, text });
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(MAX_SNAPSHOT_LINE_BYTES);
    expect(parseSnapshotLine(encoded)).toEqual({ ...file, text });
  });

  it('refuses a patch over 256 KiB and accepts null and one of exactly 256 KiB', () => {
    expect(refusal({ ...change, patch: null })).toBeNull();
    expect(refusal({ ...change, patch: MAX(MAX_SNAPSHOT_PATCH_BYTES) })).toBeNull();
    expect(refusal({ ...change, patch: MAX(MAX_SNAPSHOT_PATCH_BYTES + 1) })).toMatch(
      /^patch: too long/,
    );
    expect(refusal({ ...change, patch: 'é'.repeat(MAX_SNAPSHOT_PATCH_BYTES / 2 + 1) })).toMatch(
      /^patch: too long/,
    );
  });

  it('refuses an instructions text over 64 KiB', () => {
    expect(refusal({ ...instructions, text: MAX(MAX_INSTRUCTIONS_BYTES) })).toBeNull();
    expect(refusal({ ...instructions, text: MAX(MAX_INSTRUCTIONS_BYTES + 1) })).toMatch(
      /^text: too long/,
    );
    expect(refusal({ ...instructions, text: 'é'.repeat(MAX_INSTRUCTIONS_BYTES / 2 + 1) })).toMatch(
      /^text: too long/,
    );
  });

  it('refuses a line over 8 MiB before reading it as JSON', () => {
    expect(refusal(MAX(MAX_SNAPSHOT_LINE_BYTES + 1))).toBe('line_too_long');
    // 4 194 305 characters, 8 388 610 bytes.
    expect(refusal('é'.repeat(MAX_SNAPSHOT_LINE_BYTES / 2 + 1))).toBe('line_too_long');
    // Exactly at the limit it is read: not JSON, not too long.
    expect(refusal(MAX(MAX_SNAPSHOT_LINE_BYTES))).toBe('invalid_json');
    expect(refusal('é'.repeat(MAX_SNAPSHOT_LINE_BYTES / 2))).toBe('invalid_json');
  });

  it('refuses a description over 12 000 characters, since the CLI cuts it before sending', () => {
    const mergeRequest = (description: string | null) => ({
      ...header,
      mergeRequest: { id: '1', title: null, description },
    });
    expect(refusal(mergeRequest(MAX(MAX_MR_DESCRIPTION_CHARS)))).toBeNull();
    expect(refusal(mergeRequest(MAX(MAX_MR_DESCRIPTION_CHARS + 1)))).toBe(
      `mergeRequest.description: too long (limit ${MAX_MR_DESCRIPTION_CHARS} characters)`,
    );
    expect(refusal(mergeRequest(''))).toBeNull();
    expect(refusal(mergeRequest(null))).toBeNull();
    // Millions of characters are refused too, by their length alone.
    expect(refusal(mergeRequest(MAX(2_000_000)))).toMatch(/^mergeRequest\.description: too long/);
  });

  it('refuses a title over 255 characters', () => {
    const mergeRequest = (title: string | null) => ({
      ...header,
      mergeRequest: { id: '1', title, description: null },
    });
    expect(refusal(mergeRequest(MAX(MAX_MR_TITLE_CHARS)))).toBeNull();
    expect(refusal(mergeRequest(MAX(MAX_MR_TITLE_CHARS + 1)))).toBe(
      `mergeRequest.title: too long (limit ${MAX_MR_TITLE_CHARS} characters)`,
    );
    expect(refusal(mergeRequest(null))).toBeNull();
  });

  it('counts the characters of a title and a description as code points, as cutAtGrapheme does', () => {
    const description = (text: string) => ({
      ...header,
      mergeRequest: { id: '1', title: null, description: text },
    });
    const title = (text: string) => ({
      ...header,
      mergeRequest: { id: '1', title: text, description: null },
    });
    // An emoji is one character here, though two UTF-16 units.
    expect(refusal(description('😀'.repeat(MAX_MR_DESCRIPTION_CHARS)))).toBeNull();
    expect(refusal(description('😀'.repeat(MAX_MR_DESCRIPTION_CHARS + 1)))).toMatch(
      /^mergeRequest\.description: too long/,
    );
    expect(refusal(title('😀'.repeat(MAX_MR_TITLE_CHARS)))).toBeNull();
    expect(refusal(title('😀'.repeat(MAX_MR_TITLE_CHARS + 1)))).toMatch(
      /^mergeRequest\.title: too long/,
    );
    // A mix: 6 000 astral characters and 6 000 BMP ones are 12 000 characters and 18 000 units.
    expect(refusal(description('😀'.repeat(6_000) + 'é'.repeat(6_000)))).toBeNull();
    expect(refusal(description('😀'.repeat(6_000) + 'é'.repeat(6_001)))).toMatch(/too long/);
    // What the CLI sends, cut to the bound, is always accepted.
    const long = '😀 mixed text é 日本語 '.repeat(5_000);
    const cutDescription = cutAtGrapheme(long, MAX_MR_DESCRIPTION_CHARS);
    expect([...cutDescription]).toHaveLength(MAX_MR_DESCRIPTION_CHARS);
    expect(refusal(description(cutDescription))).toBeNull();
    const cutTitle = cutAtGrapheme('😀'.repeat(1_000), MAX_MR_TITLE_CHARS);
    expect([...cutTitle]).toHaveLength(MAX_MR_TITLE_CHARS);
    expect(refusal(title(cutTitle))).toBeNull();
  });

  it('bounds the other short header fields', () => {
    const mergeRequest = (id: string) => ({
      ...header,
      mergeRequest: { ...header.mergeRequest, id },
    });
    expect(refusal(mergeRequest('7'))).toBeNull();
    expect(refusal(mergeRequest(MAX(64)))).toBeNull();
    expect(refusal(mergeRequest(''))).toMatch(/^mergeRequest\.id: /);
    expect(refusal(mergeRequest(MAX(65)))).toMatch(/^mergeRequest\.id: /);
    expect(refusal({ ...header, targetBranch: MAX(255) })).toBeNull();
    expect(refusal({ ...header, targetBranch: '' })).toMatch(/^targetBranch: /);
    expect(refusal({ ...header, targetBranch: MAX(256) })).toMatch(/^targetBranch: /);
  });

  it('refuses a NUL in any text, which PostgreSQL cannot store', () => {
    expect(refusal({ ...file, text: 'a\u0000b' })).toBe('text: must not contain NUL');
    expect(refusal({ ...change, patch: '\u0000' })).toBe('patch: must not contain NUL');
    expect(refusal({ ...instructions, text: 'a\u0000' })).toBe('text: must not contain NUL');
    expect(refusal({ ...header, targetBranch: 'ma\u0000in' })).toBe(
      'targetBranch: must not contain NUL',
    );
    expect(refusal({ ...header, generator: 'q\u0000' })).toBe('generator: must not contain NUL');
    expect(
      refusal({ ...header, mergeRequest: { id: '1', title: 'a\u0000', description: null } }),
    ).toBe('mergeRequest.title: must not contain NUL');
    expect(
      refusal({ ...header, mergeRequest: { id: '1', title: null, description: '\u0000' } }),
    ).toBe('mergeRequest.description: must not contain NUL');
    expect(
      refusal({ ...header, mergeRequest: { id: '\u0000', title: null, description: null } }),
    ).toBe('mergeRequest.id: must not contain NUL');
  });

  it('allows the other control characters in a text, which source files hold', () => {
    expect(
      refusal({ ...file, text: 'tab\there\r\nform\ffeed\u001b[0m \u0085 \u{202e}' }),
    ).toBeNull();
  });
});

describe('the other fields of the lines', () => {
  it('takes the revisions as lowercase hex, 40 or 64 digits, and a since revision that may be null', () => {
    expect(
      refusal({ ...header, headSha: 'a'.repeat(64), baseSha: '0123456789abcdef'.repeat(4) }),
    ).toBeNull();
    expect(refusal({ ...header, sinceSha: null })).toBeNull();
    for (const bad of [
      'A'.repeat(40),
      'a'.repeat(39),
      'a'.repeat(41),
      'a'.repeat(65),
      'g'.repeat(40),
      '',
      null,
    ]) {
      expect(refusal({ ...header, headSha: bad }), `headSha ${String(bad)}`).toMatch(/^headSha: /);
      expect(refusal({ ...header, baseSha: bad }), `baseSha ${String(bad)}`).toMatch(/^baseSha: /);
    }
    for (const bad of ['A'.repeat(40), 'a'.repeat(39), '', 5]) {
      expect(refusal({ ...header, sinceSha: bad }), `sinceSha ${String(bad)}`).toMatch(
        /^sinceSha: /,
      );
    }
    expect(refusal({ ...header, sinceSha: undefined })).toMatch(/^sinceSha: /);
  });

  it('takes each change status of the database and nothing else', () => {
    for (const status of SNAPSHOT_CHANGES)
      expect(refusal({ ...change, status }), status).toBeNull();
    for (const status of ['copied', 'renamed ', 'ADDED', '', null, 3]) {
      expect(refusal({ ...change, status }), String(status)).toMatch(/^status: /);
    }
  });

  it('takes the eight omission reasons, and not path_too_long (ruling P3)', () => {
    for (const reason of OMISSION_REASONS)
      expect(refusal({ ...omitted, reason }), reason).toBeNull();
    for (const reason of ['path_too_long', 'Binary', '', null, 'other']) {
      expect(refusal({ ...omitted, reason }), String(reason)).toMatch(/^reason: /);
    }
  });

  it('takes the three instruction files and nothing else', () => {
    for (const name of INSTRUCTION_FILES)
      expect(refusal({ ...instructions, name }), name).toBeNull();
    for (const name of [
      'README.md',
      'agents.md',
      'AGENTS.MD',
      '.cursorrules',
      '',
      'docs/AGENTS.md',
    ]) {
      expect(refusal({ ...instructions, name }), name).toMatch(/^name: /);
    }
  });

  it('takes the counts of the end line as whole numbers', () => {
    expect(refusal({ ...end, files: 0, changes: 0, omitted: 0 })).toBeNull();
    expect(refusal({ ...end, files: MAX_SNAPSHOT_FILES })).toBeNull();
    expect(refusal({ ...end, files: MAX_SNAPSHOT_FILES + 1 })).toMatch(/^files: /);
    for (const key of ['files', 'changes', 'omitted']) {
      for (const bad of [-1, 1.5, '3', null, 1e300]) {
        expect(refusal({ ...end, [key]: bad }), `${key} ${String(bad)}`).toMatch(
          new RegExp(`^${key}: `),
        );
      }
    }
  });

  it('is a union on the type of its members', () => {
    for (const [name, line] of LINES) {
      const parsed = snapshotLineSchema.safeParse(line);
      expect(parsed.success, name).toBe(true);
      if (parsed.success) expect(parsed.data.type).toBe(line.type);
    }
    expect(snapshotLineSchema.safeParse({ type: 'bogus' }).success).toBe(false);
  });

  it('exports the schema of each line type, which accepts its own line and no other', () => {
    const schemas = [
      ['header', snapshotHeaderSchema, header],
      ['file', snapshotFileSchema, file],
      ['change', snapshotChangeSchema, change],
      ['omitted', snapshotOmittedSchema, omitted],
      ['instructions', snapshotInstructionsSchema, instructions],
      ['end', snapshotEndSchema, end],
    ] as const;
    for (const [name, schema, line] of schemas) {
      expect(schema.safeParse(line).success, name).toBe(true);
      for (const [otherName, , other] of schemas) {
        if (otherName !== name)
          expect(schema.safeParse(other).success, `${name} ${otherName}`).toBe(false);
      }
    }
  });
});
