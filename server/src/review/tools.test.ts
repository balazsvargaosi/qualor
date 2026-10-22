import { OMISSION_REASONS, REDACTED } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { memorySnapshot } from '../../test/review';
import type { LlmToolCall } from '../llm/providers/types';
import { compilePathGlob, likePrefix, type SnapshotReader } from './snapshot-reader';
import { REVIEW_TOOLS, runReviewTool, TOOL_LIMITS, type ToolPolicy } from './tools';

const BUDGET_USED_UP = 'tool budget used up; answer now with what you have';
const ABSENT = "no such file in this merge request's snapshot";
const EXCLUDED = 'not available: excluded by the administrator';
const MORE_MATCHES = '… more matches; narrow path_glob';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

let callCount = 0;
const call = (name: string, args: unknown): LlmToolCall => ({
  id: `call-${(callCount += 1)}`,
  name,
  arguments: args,
});
const newPolicy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  excludePaths: [],
  budget: { calls: TOOL_LIMITS.callsPerReview, greps: TOOL_LIMITS.grepsPerReview },
  ...over,
});
const run = (
  reader: SnapshotReader,
  name: string,
  args: unknown,
  policy: ToolPolicy = newPolicy(),
) => runReviewTool(reader, call(name, args), policy);
const answer = async (
  reader: SnapshotReader,
  name: string,
  args: unknown,
  policy?: ToolPolicy,
): Promise<string> => (await run(reader, name, args, policy)).text;

/** `n` lines `line 1` … `line n`, each ended by a newline. */
const numberedFile = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

/** A reader that fails the test when anything reads from it. */
const tripwire: SnapshotReader = {
  meta: memorySnapshot().meta,
  changes: () => Promise.reject(new Error('changes() was called')),
  file: () => Promise.reject(new Error('file() was called')),
  grep: () => Promise.reject(new Error('grep() was called')),
  list: () => Promise.reject(new Error('list() was called')),
};

describe('reading files', () => {
  const reader = memorySnapshot({
    files: {
      'src/big.ts': numberedFile(1000),
      'src/small.ts': 'a\nb\nc\n',
      'src/crlf.ts': 'one\r\ntwo\r\n',
      'src/empty.ts': '',
      'src/wide.ts': `${'x'.repeat(500)}\n`.repeat(100),
      'src/minified.js': 'y'.repeat(100_000),
    },
  });

  it('read_file numbers lines from the requested range and cuts at 400 lines', async () => {
    expect(await answer(reader, 'read_file', { path: 'src/small.ts', from: 2, to: 3 })).toBe(
      '2│ b\n3│ c',
    );
    expect(await answer(reader, 'read_file', { path: 'src/small.ts' })).toBe('1│ a\n2│ b\n3│ c');

    // No range: the first 400 lines, the number as wide as the largest shown, then the way on.
    const first = (await answer(reader, 'read_file', { path: 'src/big.ts' })).split('\n');
    expect(first).toHaveLength(401);
    expect(first[0]).toBe('  1│ line 1');
    expect(first[399]).toBe('400│ line 400');
    expect(first[400]).toBe('… lines 1–400 of 1000; ask for more with from/to');

    // A range wider than the cap is cut the same way; from alone takes the next 400.
    const wide = (
      await answer(reader, 'read_file', { path: 'src/big.ts', from: 1, to: 900 })
    ).split('\n');
    expect(wide).toEqual(first);
    const next = (await answer(reader, 'read_file', { path: 'src/big.ts', from: 401 })).split('\n');
    expect(next[0]).toBe('401│ line 401');
    expect(next[399]).toBe('800│ line 800');
    expect(next[400]).toBe('… lines 401–800 of 1000; ask for more with from/to');

    // Up to the end of the file there is nothing more to ask for.
    expect(await answer(reader, 'read_file', { path: 'src/big.ts', from: 998 })).toBe(
      ' 998│ line 998\n 999│ line 999\n1000│ line 1000',
    );
    expect(await answer(reader, 'read_file', { path: 'src/big.ts', from: 999, to: 5000 })).toBe(
      ' 999│ line 999\n1000│ line 1000',
    );
    // A range of its own is no cut, however long the file.
    expect(await answer(reader, 'read_file', { path: 'src/big.ts', from: 10, to: 11 })).toBe(
      '10│ line 10\n11│ line 11',
    );
  });

  it('read_file cuts at 40 000 characters, whole lines first', async () => {
    const lines = (await answer(reader, 'read_file', { path: 'src/wide.ts' })).split('\n');
    const shown = lines.slice(0, -1);
    // 501 characters with the line end: 79 lines are 39 579 characters, an 80th would pass 40 000.
    expect(shown).toHaveLength(79);
    expect(shown.at(-1)).toBe(`79│ ${'x'.repeat(500)}`);
    expect(lines.at(-1)).toBe('… lines 1–79 of 100; ask for more with from/to');

    // One line over the cap is cut by itself, with its ellipsis.
    const one = await answer(reader, 'read_file', { path: 'src/minified.js' });
    expect(one.startsWith('1│ yyyy')).toBe(true);
    expect(one.endsWith('y…')).toBe(true);
    expect(one.length).toBeLessThanOrEqual(TOOL_LIMITS.readChars + 3);
  });

  it('read_file shows a line without its carriage return, and says so for an empty file or a range past the end', async () => {
    expect(await answer(reader, 'read_file', { path: 'src/crlf.ts' })).toBe('1│ one\n2│ two');
    expect(await answer(reader, 'read_file', { path: 'src/empty.ts' })).toBe('the file is empty');
    expect(await answer(reader, 'read_file', { path: 'src/small.ts', from: 4 })).toBe(
      'the file has 3 lines; from is past its end',
    );
  });

  it('read_file of an omitted, excluded and absent path answers in words', async () => {
    const files = Object.fromEntries(
      OMISSION_REASONS.map((reason) => [`omitted/${reason}`, { kind: 'omitted', reason } as const]),
    );
    const omittedReader = memorySnapshot({
      files: {
        ...files,
        'secrets/key.txt': 'the key is in here',
        'src/ok.ts': 'fine',
      },
    });
    const policy = () => newPolicy({ excludePaths: ['secrets/**', '**/*.pem'] });

    const words = new Set<string>();
    for (const reason of OMISSION_REASONS) {
      const text = await answer(omittedReader, 'read_file', { path: `omitted/${reason}` });
      // In words: no code of the format, no underscore.
      expect(text, reason).toMatch(/^not available: [A-Za-z0-9 ,'-]+$/);
      words.add(text);
    }
    // Eight reasons, eight different answers.
    expect(words.size).toBe(OMISSION_REASONS.length);
    expect(await answer(omittedReader, 'read_file', { path: 'omitted/binary' })).toBe(
      'not available: binary file',
    );

    // An excluded path is refused whether or not the snapshot holds it, and shows nothing of it.
    expect(await answer(omittedReader, 'read_file', { path: 'secrets/key.txt' }, policy())).toBe(
      EXCLUDED,
    );
    expect(await answer(omittedReader, 'read_file', { path: 'keys/server.pem' }, policy())).toBe(
      EXCLUDED,
    );
    expect(await answer(omittedReader, 'read_file', { path: 'src/ok.ts' }, policy())).toBe(
      '1│ fine',
    );
    // Without the setting the same path reads.
    expect(await answer(omittedReader, 'read_file', { path: 'secrets/key.txt' })).toBe(
      '1│ the key is in here',
    );

    expect(await answer(omittedReader, 'read_file', { path: 'src/missing.ts' })).toBe(ABSENT);
    expect(await answer(omittedReader, 'read_file', { path: 'src' })).toBe(ABSENT);
  });

  it('read_file does not take a path for a property of the object that holds the files', async () => {
    const small = memorySnapshot({ files: { 'a.ts': 'a' } });
    for (const path of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await answer(small, 'read_file', { path }), path).toBe(ABSENT);
    }
  });
});

describe('searching', () => {
  it('grep is a fixed-string search: regex metacharacters match literally', async () => {
    const reader = memorySnapshot({
      files: {
        'a.txt': [
          'foo.*bar',
          'foobar',
          '(a|b) either',
          'ab',
          'a digit is \\d here',
          'd5 is a digit',
          'Case and case',
        ].join('\n'),
      },
    });
    expect(await answer(reader, 'grep', { pattern: '.*' })).toBe('a.txt:1: foo.*bar');
    expect(await answer(reader, 'grep', { pattern: '(a|b)' })).toBe('a.txt:3: (a|b) either');
    expect(await answer(reader, 'grep', { pattern: '\\d' })).toBe('a.txt:5: a digit is \\d here');
    // Case-sensitive.
    expect(await answer(reader, 'grep', { pattern: 'case' })).toBe('a.txt:7: Case and case');
    expect(await answer(reader, 'grep', { pattern: 'CASE' })).toBe('no matches');
    // A pattern that would hang a regular expression engine is only text.
    const hostile = memorySnapshot({ files: { 'b.txt': `${'a'.repeat(5000)}!` } });
    expect(await answer(hostile, 'grep', { pattern: '(a+)+$' })).toBe('no matches');
  });

  it('grep prints path:line: text for every matching line, in path and line order', async () => {
    const reader = memorySnapshot({
      files: {
        'src/b.ts': 'x\nneedle b1\ny\nneedle b2',
        'src/a.ts': 'needle a1\nz\n',
        'README.md': 'a needle in the docs\r\nno\r\n',
        'src/c.ts': 'nothing here',
      },
    });
    expect(await answer(reader, 'grep', { pattern: 'needle' })).toBe(
      [
        'README.md:1: a needle in the docs',
        'src/a.ts:1: needle a1',
        'src/b.ts:2: needle b1',
        'src/b.ts:4: needle b2',
      ].join('\n'),
    );
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: 'src/*.ts' })).toBe(
      ['src/a.ts:1: needle a1', 'src/b.ts:2: needle b1', 'src/b.ts:4: needle b2'].join('\n'),
    );
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: null })).toContain(
      'README.md:1:',
    );
  });

  it('grep glob prefixes escape LIKE metacharacters', async () => {
    const reader = memorySnapshot({
      files: {
        'a_b/one.ts': 'needle',
        'axb/two.ts': 'needle',
        'a%b/three.ts': 'needle',
        'src/%/pct.ts': 'needle',
        'src/x/other.ts': 'needle',
      },
    });
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: 'a_b/**' })).toBe(
      'a_b/one.ts:1: needle',
    );
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: 'src/%/*.ts' })).toBe(
      'src/%/pct.ts:1: needle',
    );
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: 'a%b/**' })).toBe(
      'a%b/three.ts:1: needle',
    );

    // What SQL gets: the literal part of the glob, every LIKE metacharacter escaped.
    expect(compilePathGlob('src/%/*.ts').prefix).toBe('src/%/');
    expect(likePrefix('src/%/')).toBe('src/\\%/%');
    expect(likePrefix('a_b/')).toBe('a\\_b/%');
    expect(likePrefix('a\\b')).toBe('a\\\\b%');
    expect(likePrefix('')).toBe('%');
  });

  it('grep caps hits and says so', async () => {
    const same = (n: number) => Array.from({ length: n }, (_, i) => `needle ${i + 1}`).join('\n');
    const reader = memorySnapshot({
      files: {
        'src/a.ts': same(30),
        'src/b.ts': same(30),
        'src/c.ts': same(30),
        'exact/a.ts': same(50),
        'long/a.ts': `${'x'.repeat(300)} needle`,
      },
    });
    const hits = (await answer(reader, 'grep', { pattern: 'needle', path_glob: 'src/**' })).split(
      '\n',
    );
    expect(hits).toHaveLength(TOOL_LIMITS.grepHits + 1);
    expect(hits[0]).toBe('src/a.ts:1: needle 1');
    expect(hits[29]).toBe('src/a.ts:30: needle 30');
    expect(hits[30]).toBe('src/b.ts:1: needle 1');
    expect(hits[49]).toBe('src/b.ts:20: needle 20');
    expect(hits[50]).toBe(MORE_MATCHES);

    // Exactly the cap is not more.
    const exact = (
      await answer(reader, 'grep', { pattern: 'needle', path_glob: 'exact/**' })
    ).split('\n');
    expect(exact).toHaveLength(50);
    expect(exact.at(-1)).toBe('exact/a.ts:50: needle 50');

    // A long line is cut at 200 characters, the cut marked.
    const long = await answer(reader, 'grep', { pattern: 'needle', path_glob: 'long/**' });
    const text = long.slice('long/a.ts:1: '.length);
    expect([...text]).toHaveLength(TOOL_LIMITS.grepLineChars);
    expect(text.endsWith('…')).toBe(true);
  });

  it('grep does not search an excluded file, and the cap counts what is shown', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `needle ${i + 1}`).join('\n');
    const reader = memorySnapshot({
      files: {
        'vendor/big.js': many,
        'secrets/a.txt': 'needle',
        'z/ok.ts': 'needle 1\nneedle 2\nneedle 3',
        'omitted.bin': { kind: 'omitted', reason: 'binary' },
      },
    });
    const policy = () => newPolicy({ excludePaths: ['vendor/**', 'secrets/**'] });
    // The excluded files sort first and would fill the cap: they must not use it up.
    expect(await answer(reader, 'grep', { pattern: 'needle' }, policy())).toBe(
      ['z/ok.ts:1: needle 1', 'z/ok.ts:2: needle 2', 'z/ok.ts:3: needle 3'].join('\n'),
    );
    // Without the setting they are searched.
    expect(await answer(reader, 'grep', { pattern: 'needle' })).toContain('vendor/big.js:1:');
    // Nothing but excluded hits is no match.
    expect(
      await answer(reader, 'grep', { pattern: 'needle', path_glob: 'secrets/**' }, policy()),
    ).toBe('no matches');
  });

  it('grep refuses a pattern that is not 2 to 200 characters on one line', async () => {
    const reader = memorySnapshot({ files: { 'a.txt': 'x' } });
    for (const pattern of [
      'x',
      '',
      'x'.repeat(TOOL_LIMITS.grepNeedleMax + 1),
      'one\ntwo',
      'one\rtwo',
      `nul${NUL}nul`,
      `lone${LONE_SURROGATE}surrogate`,
    ]) {
      expect(await answer(reader, 'grep', { pattern }), JSON.stringify(pattern)).toMatch(
        /^invalid arguments: pattern\b/,
      );
    }
    // The bounds are inclusive; a character is a code point.
    expect(await answer(reader, 'grep', { pattern: 'xy' })).toBe('no matches');
    expect(await answer(reader, 'grep', { pattern: 'x'.repeat(TOOL_LIMITS.grepNeedleMax) })).toBe(
      'no matches',
    );
    expect(await answer(reader, 'grep', { pattern: '😀' })).toMatch(/^invalid arguments: pattern/);
    expect(await answer(reader, 'grep', { pattern: '😀😀' })).toBe('no matches');
  });
});

describe('the path_glob language', () => {
  const matches = (glob: string, path: string) => compilePathGlob(glob).matches(path);

  it('matches * within a segment, ** across segments and ? one character', () => {
    expect(matches('*.ts', 'a.ts')).toBe(true);
    expect(matches('*.ts', 'src/a.ts')).toBe(false);
    expect(matches('*.ts', 'a.tsx')).toBe(false);
    expect(matches('src/*/c.ts', 'src/lib/c.ts')).toBe(true);
    expect(matches('src/*/c.ts', 'src/lib/deep/c.ts')).toBe(false);
    expect(matches('src/*/c.ts', 'src/c.ts')).toBe(false);
    expect(matches('**/*.ts', 'a.ts')).toBe(true);
    expect(matches('**/*.ts', 'src/lib/a.ts')).toBe(true);
    expect(matches('**/*.ts', 'src/lib/a.js')).toBe(false);
    expect(matches('src/**', 'src/a')).toBe(true);
    expect(matches('src/**', 'src/a/b/c')).toBe(true);
    expect(matches('src/**', 'src')).toBe(false);
    expect(matches('src/**', 'srcs/a')).toBe(false);
    expect(matches('src/**/c.ts', 'src/c.ts')).toBe(true);
    expect(matches('src/**/c.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matches('src/**/c.ts', 'src/a/b/d.ts')).toBe(false);
    expect(matches('src/**/c.ts', 'src/xc.ts')).toBe(false);
    expect(matches('**', 'any/path/at.all')).toBe(true);
    expect(matches('**.ts', 'src/lib/a.ts')).toBe(true);
    expect(matches('?.ts', 'a.ts')).toBe(true);
    expect(matches('?.ts', 'ab.ts')).toBe(false);
    expect(matches('?.ts', '/.ts')).toBe(false);
    expect(matches('a?c', 'a/c')).toBe(false);
    expect(matches('a?c', 'a😀c')).toBe(true);
    // Case matters.
    expect(matches('SRC/**', 'src/a')).toBe(false);
  });

  it('takes every other character as itself', () => {
    expect(matches('a.b(c)[d]+e^$|f{g}', 'a.b(c)[d]+e^$|f{g}')).toBe(true);
    expect(matches('a.b', 'aXb')).toBe(false);
    expect(matches('[ab].ts', 'a.ts')).toBe(false);
    expect(matches('[ab].ts', '[ab].ts')).toBe(true);
    expect(matches('{a,b}.ts', 'a.ts')).toBe(false);
    expect(matches('src/%/x', 'src/%/x')).toBe(true);
    expect(matches('src/%/x', 'src/y/x')).toBe(false);
    expect(matches('a_b', 'axb')).toBe(false);
  });

  it('takes the literal text before the first wildcard as the prefix', () => {
    expect(compilePathGlob('src/lib/*.ts').prefix).toBe('src/lib/');
    expect(compilePathGlob('src/ut?l.ts').prefix).toBe('src/ut');
    expect(compilePathGlob('src/**/c.ts').prefix).toBe('src/');
    expect(compilePathGlob('**/*.ts').prefix).toBe('');
    expect(compilePathGlob('exact/path.ts').prefix).toBe('exact/path.ts');
    // Every path a glob matches starts with its prefix.
    for (const [glob, path] of [
      ['src/**/c.ts', 'src/c.ts'],
      ['src/ut?l.ts', 'src/utel.ts'],
      ['a**/b', 'a/x/b'],
    ] as const) {
      expect(matches(glob, path)).toBe(true);
      expect(path.startsWith(compilePathGlob(glob).prefix)).toBe(true);
    }
  });

  it('cannot be made to take exponential time', () => {
    const glob = `${'*a'.repeat(40)}*b`;
    const started = performance.now();
    expect(matches(glob, 'a'.repeat(1_000))).toBe(false);
    expect(matches(`${'**/'.repeat(40)}x`, `${'d/'.repeat(500)}y`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('listing', () => {
  const reader = memorySnapshot({
    files: {
      'a.ts': 'a',
      'src/b.ts': 'b',
      'src/lib/c.ts': 'c',
      'src/lib/deep/d.ts': 'd',
      'src/lib/deep/e.ts': 'e',
      'Zeta.md': 'z',
      '.hidden/f': 'f',
      'bin/logo.png': { kind: 'omitted', reason: 'binary' },
      'gone.ts': { kind: 'absent' },
    },
  });

  it('list_files lists immediate children only', async () => {
    expect(await answer(reader, 'list_files', {})).toBe(
      ['.hidden/', 'Zeta.md', 'a.ts', 'bin/', 'src/'].join('\n'),
    );
    expect(await answer(reader, 'list_files', { dir: '' })).toBe(
      await answer(reader, 'list_files', {}),
    );
    expect(await answer(reader, 'list_files', { dir: null })).toBe(
      await answer(reader, 'list_files', {}),
    );
    expect(await answer(reader, 'list_files', { dir: 'src' })).toBe(['b.ts', 'lib/'].join('\n'));
    expect(await answer(reader, 'list_files', { dir: 'src/lib' })).toBe(
      ['c.ts', 'deep/'].join('\n'),
    );
    expect(await answer(reader, 'list_files', { dir: 'src/lib/deep' })).toBe(
      ['d.ts', 'e.ts'].join('\n'),
    );
    // An omitted file is still there to see, so the model can say it is not available.
    expect(await answer(reader, 'list_files', { dir: 'bin' })).toBe('logo.png');
  });

  it('list_files says so for a directory that is not there, and for a file given as a directory', async () => {
    const none = "no such directory in this merge request's snapshot";
    expect(await answer(reader, 'list_files', { dir: 'nope' })).toBe(none);
    expect(await answer(reader, 'list_files', { dir: 'a.ts' })).toBe(none);
    expect(await answer(reader, 'list_files', { dir: 'sr' })).toBe(none);
    expect(await answer(memorySnapshot(), 'list_files', {})).toBe('the snapshot holds no files');
  });

  it('list_files cuts at 500 entries and says so', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`dir/f${String(i).padStart(3, '0')}.ts`, 'x']),
    );
    const lines = (await answer(memorySnapshot({ files }), 'list_files', { dir: 'dir' })).split(
      '\n',
    );
    expect(lines).toHaveLength(TOOL_LIMITS.listEntries + 1);
    expect(lines[0]).toBe('f000.ts');
    expect(lines[499]).toBe('f499.ts');
    expect(lines[500]).toBe('… more entries; list a subdirectory to see them');
    const exact = Object.fromEntries(Object.entries(files).slice(0, 500));
    expect(
      (await answer(memorySnapshot({ files: exact }), 'list_files', { dir: 'dir' })).split('\n'),
    ).toHaveLength(500);
  });

  it('list_files hides an excluded path, and refuses an excluded directory', async () => {
    const policy = () => newPolicy({ excludePaths: ['src/lib/**', '**/*.md', '.hidden'] });
    expect(await answer(reader, 'list_files', {}, policy())).toBe(
      ['a.ts', 'bin/', 'src/'].join('\n'),
    );
    expect(await answer(reader, 'list_files', { dir: 'src' }, policy())).toBe('b.ts');
    expect(await answer(reader, 'list_files', { dir: 'src/lib' }, policy())).toBe(EXCLUDED);
    expect(await answer(reader, 'list_files', { dir: 'src/lib/deep' }, policy())).toBe(EXCLUDED);
    // Hidden entries do not use up the cap.
    const files = Object.fromEntries(
      Array.from({ length: 700 }, (_, i) => [
        `${i < 600 ? 'a' : 'b'}${String(i).padStart(3, '0')}.ts`,
        'x',
      ]),
    );
    const listed = (
      await answer(memorySnapshot({ files }), 'list_files', {}, newPolicy({ excludePaths: ['a*'] }))
    ).split('\n');
    expect(listed).toHaveLength(100);
    expect(listed[0]).toBe('b600.ts');
  });
});

describe('all tools', () => {
  const bad = [
    '../etc/passwd',
    'a/../b',
    '..',
    '/etc/passwd',
    'a\\b',
    `a${NUL}b`,
    './a',
    '.',
    'a//b',
    'a/',
    'a\nb',
    `a${RIGHT_TO_LEFT_OVERRIDE}b`,
  ];
  const tooLong = 'long/'.repeat(300);

  it('paths with .., a leading /, a backslash or NUL are refused', async () => {
    // Before the reader is asked anything: the tripwire fails the test when it is read.
    for (const path of ['', tooLong, ...bad]) {
      expect(await run(tripwire, 'read_file', { path }), JSON.stringify(path)).toEqual({
        text: 'invalid path',
        redactions: 0,
      });
    }
    for (const dir of [tooLong, ...bad]) {
      expect(await answer(tripwire, 'list_files', { dir }), JSON.stringify(dir)).toBe(
        'invalid path',
      );
    }
    for (const path_glob of bad) {
      expect(
        await answer(tripwire, 'grep', { pattern: 'needle', path_glob }),
        JSON.stringify(path_glob),
      ).toBe('invalid path');
    }
    // A glob has its own bound, which is checked first.
    expect(await answer(tripwire, 'grep', { pattern: 'needle', path_glob: tooLong })).toMatch(
      /^invalid arguments: path_glob\b/,
    );
  });

  it('an empty glob is no glob, and an empty path is refused', async () => {
    const reader = memorySnapshot({ files: { 'a.ts': 'needle' } });
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: '' })).toBe(
      'a.ts:1: needle',
    );
    expect(await answer(tripwire, 'read_file', { path: '' })).toBe('invalid path');
  });

  it('arguments that do not match the tool are refused, naming the argument', async () => {
    const cases: [string, unknown, string][] = [
      ['read_file', {}, 'path'],
      ['read_file', { path: 7 }, 'path'],
      ['read_file', { path: null }, 'path'],
      ['read_file', { path: 'a', from: 0 }, 'from'],
      ['read_file', { path: 'a', from: -3 }, 'from'],
      ['read_file', { path: 'a', from: 1.5 }, 'from'],
      ['read_file', { path: 'a', from: '2' }, 'from'],
      ['read_file', { path: 'a', to: 0 }, 'to'],
      ['read_file', { path: 'a', from: 5, to: 2 }, 'to'],
      ['read_file', { path: 'a', offset: 3 }, 'offset'],
      ['grep', {}, 'pattern'],
      ['grep', { pattern: 5 }, 'pattern'],
      ['grep', { pattern: 'ab', path_glob: 3 }, 'path_glob'],
      ['grep', { pattern: 'ab', path_glob: 'x'.repeat(201) }, 'path_glob'],
      ['grep', { pattern: 'ab', regex: true }, 'regex'],
      ['list_files', { dir: 3 }, 'dir'],
      ['list_files', { directory: 'src' }, 'directory'],
    ];
    for (const [tool, args, which] of cases) {
      const { text, redactions } = await run(tripwire, tool, args);
      expect(text, `${tool} ${JSON.stringify(args)}`).toMatch(
        new RegExp(`^invalid arguments: ${which}\\b`),
      );
      expect(redactions).toBe(0);
    }
    // Two wrong arguments are both named.
    expect(await answer(tripwire, 'read_file', { path: 7, from: 0 })).toMatch(
      /^invalid arguments: path, from$/,
    );
    // Arguments that are not an object at all (a model's text the provider could not parse).
    for (const args of ['not json', 7, ['a'], true]) {
      for (const tool of ['read_file', 'grep', 'list_files']) {
        expect(await answer(tripwire, tool, args), `${tool} ${JSON.stringify(args)}`).toBe(
          'invalid arguments: expected an object',
        );
      }
    }
    // No arguments at all is an empty object.
    for (const args of [null, undefined]) {
      expect(await answer(tripwire, 'read_file', args)).toMatch(/^invalid arguments: path\b/);
      expect(await answer(tripwire, 'grep', args)).toMatch(/^invalid arguments: pattern\b/);
      expect(await answer(memorySnapshot({ files: { 'a.ts': 'a' } }), 'list_files', args)).toBe(
        'a.ts',
      );
    }
  });

  it('an optional argument that is null is left out', async () => {
    const reader = memorySnapshot({ files: { 'a.ts': 'one\ntwo' } });
    expect(await answer(reader, 'read_file', { path: 'a.ts', from: null, to: null })).toBe(
      '1│ one\n2│ two',
    );
    expect(await answer(reader, 'grep', { pattern: 'tw', path_glob: null })).toBe('a.ts:2: two');
  });

  it('a tool it does not have is answered, not run', async () => {
    const { text, redactions } = await run(tripwire, 'write_file', { path: 'a', text: 'b' });
    expect(text).toBe('unknown tool; use read_file, grep or list_files');
    expect(redactions).toBe(0);
  });

  it('tool output is redacted', async () => {
    const privateKey = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP',
      'QRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
      '-----END RSA PRIVATE KEY-----',
    ];
    const reader = memorySnapshot({
      files: {
        'src/config.ts': `const region = 'eu';\nconst key = "${AWS_KEY}";\nconst other = 1;\n`,
        'deploy/app.yml': 'name: app\npassword: hunter2hunter2\nreplicas: 2\n',
        'deploy/app.env': 'API_TOKEN=abcdefgh12345678\n',
        'keys/server.txt': `before\n${privateKey.join('\n')}\nafter\n`,
        [`names/${AWS_KEY}.txt`]: 'x',
      },
    });
    const read = await run(reader, 'read_file', { path: 'src/config.ts' });
    expect(read.text).toBe(
      `1│ const region = 'eu';\n2│ const key = "${REDACTED}";\n3│ const other = 1;`,
    );
    expect(read.redactions).toBe(1);

    const found = await run(reader, 'grep', { pattern: AWS_KEY });
    expect(found.text).toBe(`src/config.ts:2: const key = "${REDACTED}";`);
    expect(found.redactions).toBe(1);

    // A key in a name is masked in a listing too.
    const listed = await run(reader, 'list_files', { dir: 'names' });
    expect(listed.text).toBe(`${REDACTED}.txt`);
    expect(listed.redactions).toBe(1);

    // A line the line number or the path would put out of reach of the patterns for a line start
    // (a YAML key, an ENV line) is masked all the same: the text is redacted before it is dressed.
    const yaml = await run(reader, 'read_file', { path: 'deploy/app.yml' });
    expect(yaml.text).toBe(`1│ name: app\n2│ password: ${REDACTED}\n3│ replicas: 2`);
    expect(yaml.redactions).toBe(1);
    const grepYaml = await run(reader, 'grep', { pattern: 'password' });
    expect(grepYaml.text).toBe(`deploy/app.yml:2: password: ${REDACTED}`);
    expect(grepYaml.redactions).toBe(1);
    const env = await run(reader, 'grep', { pattern: 'API_TOKEN' });
    expect(env.text).toBe(`deploy/app.env:1: API_TOKEN=${REDACTED}`);

    // A private key block is masked line by line: the numbers stay the file's.
    const whole = await run(reader, 'read_file', { path: 'keys/server.txt' });
    expect(whole.text).toBe(
      ['1│ before', ...[2, 3, 4, 5].map((n) => `${n}│ ${REDACTED}`), '6│ after'].join('\n'),
    );
    expect(whole.redactions).toBe(4);
    // ... also when the range starts inside it, after the line that begins it.
    const inside = await run(reader, 'read_file', { path: 'keys/server.txt', from: 3, to: 6 });
    expect(inside.text).not.toContain('QRSTUV');
    expect(inside.text.split('\n').map((line) => line.slice(0, 2))).toEqual([
      '3│',
      '4│',
      '5│',
      '6│',
    ]);
  });

  it('a long answer is redacted in pieces, so that none becomes one marker', async () => {
    // 600 names of 200 characters are about 120 000: past what the redaction scans at once.
    const name = (i: number) => `${'n'.repeat(190)}${String(i).padStart(4, '0')}.ts`;
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`big/${name(i)}`] = 'x';
    files[`big/${'n'.repeat(190)}0450${AWS_KEY}.ts`] = 'x';
    files[`big/${'n'.repeat(190)}0100${AWS_KEY}.ts`] = 'x';
    const { text, redactions } = await run(memorySnapshot({ files }), 'list_files', {
      dir: 'big',
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(TOOL_LIMITS.listEntries + 1);
    expect(text.length).toBeGreaterThan(65_536);
    // Only the two names with a key are masked, one in each piece.
    expect(redactions).toBe(2);
    expect(lines.filter((line) => line.includes(REDACTED))).toHaveLength(2);
    expect(text).not.toContain(AWS_KEY);
    expect(lines[0]).toBe(name(0));
  });

  it('budgets stop calls and greps', async () => {
    const reader = memorySnapshot({ files: { 'a.ts': 'needle' } });
    const policy = newPolicy({ budget: { calls: 4, greps: 1 } });
    expect(await answer(reader, 'grep', { pattern: 'needle' }, policy)).toBe('a.ts:1: needle');
    expect(policy.budget).toEqual({ calls: 3, greps: 0 });
    // The grep budget is spent; reading is not.
    expect(await answer(reader, 'grep', { pattern: 'needle' }, policy)).toBe(BUDGET_USED_UP);
    expect(policy.budget).toEqual({ calls: 2, greps: 0 });
    expect(await answer(reader, 'read_file', { path: 'a.ts' }, policy)).toBe('1│ needle');
    expect(await answer(reader, 'list_files', {}, policy)).toBe('a.ts');
    expect(policy.budget).toEqual({ calls: 0, greps: 0 });
    // The call budget is spent: nothing runs, whatever the tool or the arguments, and nothing is read.
    for (const [name, args] of [
      ['read_file', { path: 'a.ts' }],
      ['grep', { pattern: 'needle' }],
      ['list_files', {}],
      ['read_file', {}],
      ['no_such_tool', {}],
    ] as const) {
      expect(await run(tripwire, name, args, policy)).toEqual({
        text: BUDGET_USED_UP,
        redactions: 0,
      });
    }
    expect(policy.budget).toEqual({ calls: 0, greps: 0 });
    // A call with arguments the tool refuses still counts as a call, but a refused grep is no search.
    const strict = newPolicy({ budget: { calls: 5, greps: 1 } });
    await run(reader, 'read_file', {}, strict);
    await run(reader, 'grep', { pattern: 'x' }, strict);
    expect(strict.budget).toEqual({ calls: 3, greps: 1 });
  });
});

describe('memorySnapshot (the test helper)', () => {
  it('fills in what a test leaves out, and keeps the changes in path order', async () => {
    const reader = memorySnapshot({
      meta: { targetBranch: 'develop', partial: true },
      changes: [{ path: 'b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+b' }, { path: 'a.ts' }],
      files: { 'a.ts': 'a', 'b.ts': 'b', 'bin/x': { kind: 'omitted', reason: 'binary' } },
    });
    expect(reader.meta).toEqual({
      snapshotId: null,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      sinceSha: null,
      targetBranch: 'develop',
      mrTitle: null,
      mrDescription: null,
      instructions: [],
      partial: true,
    });
    expect(await reader.changes()).toEqual([
      { path: 'a.ts', oldPath: null, status: 'modified', patch: null, since: null },
      { path: 'b.ts', oldPath: null, status: 'added', patch: '@@ -0,0 +1 @@\n+b', since: null },
    ]);
    expect(await reader.file('a.ts')).toEqual({ kind: 'text', text: 'a' });
    expect(await reader.file('bin/x')).toEqual({ kind: 'omitted', reason: 'binary' });
    expect(await reader.file('c.ts')).toEqual({ kind: 'absent' });
  });
});

describe('REVIEW_TOOLS', () => {
  it('describes the three tools and their limits', () => {
    expect(REVIEW_TOOLS.map((tool) => tool.name)).toEqual(['read_file', 'grep', 'list_files']);
    expect(TOOL_LIMITS).toEqual({
      readLines: 400,
      readChars: 40_000,
      grepHits: 50,
      grepLineChars: 200,
      grepNeedleMin: 2,
      grepNeedleMax: 200,
      listEntries: 500,
      callsPerReview: 120,
      grepsPerReview: 40,
    });
    for (const tool of REVIEW_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
    const grep = REVIEW_TOOLS.find((tool) => tool.name === 'grep');
    expect(grep?.description).toMatch(/not a regular expression/i);
  });

  it('declares the arguments the tools accept, and no others', async () => {
    const reader = memorySnapshot({ files: { 'a.ts': 'needle' } });
    const declared = (name: string) => {
      const tool = REVIEW_TOOLS.find((t) => t.name === name);
      const properties = (tool?.parameters.properties ?? {}) as Record<string, unknown>;
      return { names: Object.keys(properties), required: tool?.parameters.required };
    };
    expect(declared('read_file')).toEqual({ names: ['path', 'from', 'to'], required: ['path'] });
    expect(declared('grep')).toEqual({ names: ['pattern', 'path_glob'], required: ['pattern'] });
    expect(declared('list_files')).toEqual({ names: ['dir'], required: undefined });
    // Each declared argument is accepted by the tool.
    expect(await answer(reader, 'read_file', { path: 'a.ts', from: 1, to: 1 })).toBe('1│ needle');
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: '*.ts' })).toBe(
      'a.ts:1: needle',
    );
    expect(await answer(reader, 'list_files', { dir: '' })).toBe('a.ts');
  });
});
