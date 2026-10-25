import { OMISSION_REASONS, REDACTED } from '@qualor/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { HOSTILE_TEXT, memorySnapshot } from '../../test/review';
import type { LlmToolCall } from '../llm/providers/types';
import { MaskedFiles } from './masked-files';
import { Masker } from './masker';
import { compilePathGlob, likePrefix, MAX_GLOB_WILDCARDS } from './path-glob';
import type { SnapshotReader } from './snapshot-reader';
import { REVIEW_TOOLS, runReviewTool, TOOL_LIMITS, type ToolPolicy } from './tools';

const BUDGET_USED_UP = 'tool budget used up; answer now with what you have';
const ABSENT = "no such file in this merge request's snapshot";
const EXCLUDED = 'not available: excluded by the administrator';
const MORE_MATCHES = '… more matches; narrow path_glob';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

const j = (...parts: string[]) => parts.join('');
/** A fake password and the line that sets it, built at run time as the fake key below is. */
const PASSWORD_VALUE = j('"hunter2', '-very-secret"');
const PASSWORD_LINE = j('const password = ', PASSWORD_VALUE, ';');
/** A fake private key, built at run time so no scanner takes it for a real one. */
const KEY_BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
const KEY_END = j('-----END ', 'RSA PRIVATE KEY-----');
/** Line `i` of a key body: base64 letters and digits, never a real key. */
const keyLine = (i: number): string =>
  j('lQOYBF', String(i).padStart(4, '0'), 'Qm9ndXMga2V5IGJvZHk'.repeat(2));

/** The masker of the tests: one worker for all of them, stopped when they are done. */
const masker = new Masker();
afterAll(() => masker.close());

let callCount = 0;
const call = (name: string, args: unknown): LlmToolCall => ({
  id: `call-${(callCount += 1)}`,
  name,
  arguments: args,
});
const newPolicy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  excludePaths: [],
  budget: {
    calls: TOOL_LIMITS.callsPerReview,
    greps: TOOL_LIMITS.grepsPerReview,
    maskedBytes: TOOL_LIMITS.maskedBytesPerReview,
  },
  masker,
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
      'src/minified.js': 'y'.repeat(50_000),
      'src/bundle.js': 'z'.repeat(70_000),
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
    // 506 characters with the line end and the number (three digits, the 100th line's): 79 lines
    // are 39 974 characters, an 80th would pass 40 000.
    expect(shown).toHaveLength(79);
    expect(shown.at(-1)).toBe(`79│ ${'x'.repeat(500)}`);
    expect(lines.at(-1)).toBe('… lines 1–79 of 100; ask for more with from/to');

    // One line over the cap is cut by itself, with its ellipsis, the number and the bar included.
    const one = await answer(reader, 'read_file', { path: 'src/minified.js' });
    expect(one.startsWith('1│ yyyy')).toBe(true);
    expect(one.endsWith('y…')).toBe(true);
    expect(one.length).toBe(TOOL_LIMITS.readChars);
  });

  it('read_file counts the numbers and bars it puts before the lines against its 40 000 characters', async () => {
    // The lines alone are 498 characters with their ends: 80 of them are 39 840. With a number and
    // a bar each (a line is 502) they are 40 159, over the cap, and 79 are not.
    const narrow = memorySnapshot({
      files: { 'src/narrow.ts': `${'x'.repeat(497)}\n`.repeat(100) },
    });
    const lines = (await answer(narrow, 'read_file', { path: 'src/narrow.ts' })).split('\n');
    expect(lines.at(-1)).toBe('… lines 1–79 of 100; ask for more with from/to');
    const shown = lines.slice(0, -1);
    expect(shown).toHaveLength(79);
    expect(shown.join('\n').length).toBeLessThanOrEqual(TOOL_LIMITS.readChars);
  });

  it('read_file shows a line too long for the redaction to scan as redacted, as the scanner masked it', async () => {
    // Over 64 KiB, a line cannot be scanned for secrets: it is masked whole, in the file the
    // scanner uploads and again here.
    expect(await run(reader, 'read_file', { path: 'src/bundle.js' })).toEqual({
      text: `1│ ${REDACTED}`,
      redactions: 1,
      read: ['src/bundle.js'],
    });
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
    // Nothing but excluded paths in the glob is answered as the path of an excluded file is.
    expect(
      await answer(reader, 'grep', { pattern: 'needle', path_glob: 'secrets/**' }, policy()),
    ).toBe(EXCLUDED);
    // Nothing but excluded hits among the paths of the glob is no match.
    expect(
      await answer(reader, 'grep', { pattern: 'needle', path_glob: 'vendor*/**' }, policy()),
    ).toBe('no matches');
  });

  it('grep is refused for a glob that can name only excluded paths, before anything is read or counted', async () => {
    const policy = (...excludePaths: string[]) => newPolicy({ excludePaths });
    const refused = async (glob: string, excludePaths: string[]) => {
      const used = policy(...excludePaths);
      const { text, redactions } = await run(
        tripwire,
        'grep',
        { pattern: 'needle', path_glob: glob },
        used,
      );
      // It counts as a call and is no search.
      expect(used.budget.calls).toBe(TOOL_LIMITS.callsPerReview - 1);
      expect(used.budget.greps).toBe(TOOL_LIMITS.grepsPerReview);
      return { text, redactions };
    };
    const excluded = { text: EXCLUDED, redactions: 0 };
    // The directory the glob starts in is excluded, with what is in it.
    expect(await refused('secrets/**', ['secrets/**'])).toEqual(excluded);
    expect(await refused('secrets/*.key', ['secrets/**'])).toEqual(excluded);
    expect(await refused('secrets/keys/ut?l.key', ['secrets/**'])).toEqual(excluded);
    expect(await refused('a/secrets/**/*.key', ['**/secrets/**'])).toEqual(excluded);
    // The glob names one path, and it is excluded.
    expect(await refused('config/prod.env', ['**/*.env'])).toEqual(excluded);
  });

  it('grep is not refused for a glob that can name a path that is not excluded', async () => {
    const reader = memorySnapshot({
      files: {
        'vendor/a.js': 'needle',
        'secrets/a.key': 'needle',
        'secrets/deep/b.key': 'needle',
        'config/prod.env': 'needle',
        'config/dev.txt': 'needle',
        'src/lib/c.ts': 'needle',
      },
    });
    const run1 = (path_glob: string, ...excludePaths: string[]) =>
      answer(reader, 'grep', { pattern: 'needle', path_glob }, newPolicy({ excludePaths }));
    // The name of a directory is a glob for the one path, not for what is in it.
    expect(await run1('vendor/*.js', 'vendor')).toBe('vendor/a.js:1: needle');
    // Only what is directly in the directory is excluded: the files deeper in it are not.
    expect(await run1('secrets/**/*.key', 'secrets/*')).toBe('secrets/deep/b.key:1: needle');
    // A glob that starts with a wildcard, or in the root, may name paths that are not excluded.
    expect(await run1('**/*.env', '**/*.env')).toBe('no matches');
    expect(await run1('*/a.key', 'secrets/**')).toBe('no matches');
    expect(await run1('config/*', 'config/*.env')).toBe('config/dev.txt:1: needle');
    // A glob that does not start in an excluded directory.
    expect(await run1('src/**', 'secrets/**')).toBe('src/lib/c.ts:1: needle');
    expect(await run1('src/lib/c.ts', 'secrets/**')).toBe('src/lib/c.ts:1: needle');
  });

  it('grep never shows an excluded path, whether or not the reader leaves it out', async () => {
    const inner = memorySnapshot({
      files: {
        'a/vendor.js': 'needle in vendor',
        'b/ok.ts': 'needle in ok',
        'c/vendor.js': 'needle in more vendor',
      },
    });
    const received: ((path: string) => boolean)[] = [];
    // A reader that does not take the exclusion in: it gives the hits of every path.
    const careless: SnapshotReader = {
      ...inner,
      grep: (needle, glob, limit) => inner.grep(needle, glob, limit),
    };
    const watching: SnapshotReader = {
      ...inner,
      grep: (needle, glob, limit, exclude) => {
        if (exclude !== undefined) received.push(exclude);
        return inner.grep(needle, glob, limit, exclude);
      },
    };
    const policy = () => newPolicy({ excludePaths: ['**/vendor.js'] });
    expect(await answer(careless, 'grep', { pattern: 'needle' }, policy())).toBe(
      'b/ok.ts:1: needle in ok',
    );
    // The tool hands the reader the exclusion, which tells the excluded paths from the others.
    expect(await answer(watching, 'grep', { pattern: 'needle' }, policy())).toBe(
      'b/ok.ts:1: needle in ok',
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.('a/vendor.js')).toBe(true);
    expect(received[0]?.('b/ok.ts')).toBe(false);
  });

  it('grep asks a reader that has no more to give once, and says nothing of what it left out', async () => {
    let asked = 0;
    // A search the reader ended early (a glob that took too much work): it has less, and more.
    const ended = (hits: { path: string; line: number; text: string }[]): SnapshotReader => ({
      ...memorySnapshot({ files: { 'a.ts': 'needle\n' } }),
      grep: () => {
        asked += 1;
        return Promise.resolve({ hits, truncated: true });
      },
    });
    expect(await answer(ended([]), 'grep', { pattern: 'needle' })).toBe('no matches');
    expect(asked).toBe(1);
    // The lines it did find are the answer. Whether the reader had more is a fact about the text
    // as stored, which the model may not see, and it is not told.
    asked = 0;
    const one = [{ path: 'a.ts', line: 1, text: 'needle' }];
    expect(await answer(ended(one), 'grep', { pattern: 'needle' })).toBe('a.ts:1: needle');
    expect(asked).toBe(1);
  });

  it('grep does not say there is more when what it could not show is the reason it stopped', async () => {
    // A private key of 2 100 lines that hold the needle in the text as stored: the 2 000 hits the
    // reader is asked for at most are used up on lines that are masked away, and it has more. That
    // is a fact about text the model may not see, and it is not told.
    const key = [
      KEY_BEGIN,
      ...Array.from({ length: 2_100 }, (_, i) => `needle ${i}`),
      KEY_END,
    ].join('\n');
    const reader = memorySnapshot({ files: { 'a/key.txt': key } });
    expect(await answer(reader, 'grep', { pattern: 'needle' })).toBe('no matches');
    // A listing is names the model may see, and says that it has more.
    const files = Object.fromEntries(
      Array.from({ length: 10_100 }, (_, i) => [`a${String(i).padStart(5, '0')}.ts`, 'x']),
    );
    const names = memorySnapshot({ files: { ...files, 'z.ts': 'z' } });
    const listed = await answer(names, 'list_files', {}, newPolicy({ excludePaths: ['a*'] }));
    expect(listed).toBe('… more entries; list a subdirectory to see them');
  });

  it('grep takes a glob of at most 16 wildcards', async () => {
    const reader = memorySnapshot({ files: { 'a.ts': 'needle' } });
    const globs = (wildcards: number) => '*a'.repeat(wildcards).replace(/a$/, '.ts');
    expect(MAX_GLOB_WILDCARDS).toBe(16);
    expect(compilePathGlob(globs(16)).wildcards).toBe(16);
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: globs(16) })).toBe(
      'no matches',
    );
    // One wildcard more is refused, naming the argument, before the reader is asked anything.
    const refused = await answer(tripwire, 'grep', { pattern: 'needle', path_glob: globs(17) });
    expect(refused).toMatch(/^invalid arguments: path_glob\b/);
    expect(refused).toContain(`${MAX_GLOB_WILDCARDS} wildcards`);
    // Questions marks and the stars of **/ count as well.
    for (const path_glob of [
      '?'.repeat(17),
      '**/'.repeat(17),
      `${'*/'.repeat(8)}${'?'.repeat(9)}`,
    ]) {
      expect(await answer(tripwire, 'grep', { pattern: 'needle', path_glob })).toMatch(
        /^invalid arguments: path_glob\b/,
      );
    }
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: '?'.repeat(16) })).toBe(
      'no matches',
    );
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

  describe('with exclusions, which are globs for files', () => {
    const tree = memorySnapshot({
      files: {
        'README.md': 'r',
        'a.ts': 'a',
        'secrets/a.txt': 'secret a',
        'secrets/sub/b.txt': 'secret b',
        'secrets/sub/deeper/c.txt': 'secret c',
        'keys/readme.txt': 'k',
        'keys/server.pem': 'pem',
        'keys/only/pair.pem': 'pem',
        'certs/ca.pem': 'pem',
        'src/b.ts': 'b',
      },
    });
    const policy = (...excludePaths: string[]) => newPolicy({ excludePaths });
    const list = (dir: string, ...excludePaths: string[]) =>
      answer(tree, 'list_files', { dir }, policy(...excludePaths));

    it('a directory the exclusions cover whole is hidden from its parent, and refused when listed, whether or not it exists', async () => {
      const covered = ['secrets/**'];
      expect(await answer(tree, 'list_files', {}, policy(...covered))).toBe(
        ['README.md', 'a.ts', 'certs/', 'keys/', 'src/'].join('\n'),
      );
      expect(await list('secrets', ...covered)).toBe(EXCLUDED);
      expect(await list('secrets/sub', ...covered)).toBe(EXCLUDED);
      // The snapshot holds no such directory: the answer is the same, so it tells nothing.
      expect(await list('secrets/nothing/here', ...covered)).toBe(EXCLUDED);
      // Nothing is read for it.
      expect(await answer(tripwire, 'list_files', { dir: 'secrets' }, policy(...covered))).toBe(
        EXCLUDED,
      );
      // A directory that no exclusion covers is not there, if it is not.
      expect(await list('nope', ...covered)).toBe(
        "no such directory in this merge request's snapshot",
      );
      // The same for a directory covered by a glob that reaches it from anywhere.
      expect(await list('secrets', '**/secrets/**')).toBe(EXCLUDED);
    });

    it('a directory the exclusions cover only in part is listed, with the files they do not name', async () => {
      // `secrets/*` names what is directly in secrets: the files deeper in it are not excluded.
      const direct = ['secrets/*'];
      expect(await answer(tree, 'list_files', {}, policy(...direct))).toBe(
        ['README.md', 'a.ts', 'certs/', 'keys/', 'secrets/', 'src/'].join('\n'),
      );
      expect(await list('secrets', ...direct)).toBe('sub/');
      expect(await list('secrets/sub', ...direct)).toBe(['b.txt', 'deeper/'].join('\n'));
      // read_file and grep keep to the same files: the one directly in secrets is refused, the
      // ones deeper in it are shown.
      expect(await answer(tree, 'read_file', { path: 'secrets/a.txt' }, policy(...direct))).toBe(
        EXCLUDED,
      );
      expect(
        await answer(tree, 'read_file', { path: 'secrets/sub/b.txt' }, policy(...direct)),
      ).toBe('1│ secret b');
      expect(await answer(tree, 'grep', { pattern: 'secret' }, policy(...direct))).toBe(
        ['secrets/sub/b.txt:1: secret b', 'secrets/sub/deeper/c.txt:1: secret c'].join('\n'),
      );
      // The name of a directory is a glob for the one path.
      expect(await list('secrets', 'secrets')).toBe(['a.txt', 'sub/'].join('\n'));
    });

    it('a kind of file is left out wherever it is, and the directories are all listed', async () => {
      const pem = ['**/*.pem'];
      expect(await answer(tree, 'list_files', {}, policy(...pem))).toBe(
        ['README.md', 'a.ts', 'certs/', 'keys/', 'secrets/', 'src/'].join('\n'),
      );
      expect(await list('keys', ...pem)).toBe(['only/', 'readme.txt'].join('\n'));
      // A directory whose files are all left out is answered as an excluded file is.
      expect(await list('keys/only', ...pem)).toBe(EXCLUDED);
      expect(await list('certs', ...pem)).toBe(EXCLUDED);
      expect(await list('src', ...pem)).toBe('b.ts');
    });

    it('a root with nothing in it but excluded files is answered as an excluded file is', async () => {
      const flat = memorySnapshot({ files: { 'a.ts': 'a', 'b.ts': 'b' } });
      expect(await answer(flat, 'list_files', {}, newPolicy({ excludePaths: ['*.ts'] }))).toBe(
        EXCLUDED,
      );
    });

    it('hidden entries do not use up the cap', async () => {
      const files = Object.fromEntries(
        Array.from({ length: 700 }, (_, i) => [
          `${i < 600 ? 'a' : 'b'}${String(i).padStart(3, '0')}.ts`,
          'x',
        ]),
      );
      const listed = (
        await answer(
          memorySnapshot({ files }),
          'list_files',
          {},
          newPolicy({ excludePaths: ['a*'] }),
        )
      ).split('\n');
      expect(listed).toHaveLength(100);
      expect(listed[0]).toBe('b600.ts');
    });
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
      ['grep', { pattern: 'ab', path_glob: '*a'.repeat(MAX_GLOB_WILDCARDS + 1) }, 'path_glob'],
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
    const privateKey = [KEY_BEGIN, keyLine(1), keyLine(2), KEY_END];
    const reader = memorySnapshot({
      files: {
        'src/config.ts': `const region = 'eu';\nconst key = "${AWS_KEY}";\nconst other = 1;\n`,
        'deploy/app.yml': `name: app\n${j('password: ', 'hunter2', 'hunter2')}\nreplicas: 2\n`,
        'deploy/app.env': `${j('API_TOKEN', '=', 'abcdefgh', '12345678')}\n`,
        'keys/server.txt': `before\n${privateKey.join('\n')}\nafter\n`,
        [`names/${AWS_KEY}.txt`]: 'x',
      },
    });
    const read = await run(reader, 'read_file', { path: 'src/config.ts' });
    expect(read.text).toBe(
      `1│ const region = 'eu';\n2│ const key = "${REDACTED}";\n3│ const other = 1;`,
    );
    expect(read.redactions).toBe(1);

    // The secret itself finds nothing: grep matches the lines as the model could read them. The
    // file was masked for the search, and what was masked in it is reported.
    const found = await run(reader, 'grep', { pattern: AWS_KEY });
    expect(found.text).toBe('no matches');
    expect(found.redactions).toBe(1);
    // What is left of the line can be found, and shows as masked.
    const around = await run(reader, 'grep', { pattern: 'const key' });
    expect(around.text).toBe(`src/config.ts:2: const key = "${REDACTED}";`);

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
    expect(inside.text).toBe([3, 4, 5].map((n) => `${n}│ ${REDACTED}`).join('\n') + '\n6│ after');
  });

  describe('a file is masked as a whole, never a slice at a time', () => {
    const KEY_PATH = 'keys/server.txt';
    const body = Array.from({ length: 30 }, (_, i) => keyLine(i));
    // Line 1 is code, 2 the BEGIN line, 3 to 32 the body, 33 the END line, 34 code.
    const keyFile = ['before', KEY_BEGIN, ...body, KEY_END, 'after'].join('\n');

    it('read_file of the middle lines of a private key, its BEGIN and END outside the range, shows «redacted»', async () => {
      const reader = memorySnapshot({ files: { [KEY_PATH]: keyFile } });
      // One line of base64 on its own is not recognised as a key: a slice is not masked alone.
      for (const [from, to] of [
        [16, 16],
        [10, 12],
        [3, 3],
        [32, 32],
        [20, 25],
      ] as const) {
        const lines = (await answer(reader, 'read_file', { path: KEY_PATH, from, to })).split('\n');
        expect(lines, `lines ${from} to ${to}`).toHaveLength(to - from + 1);
        for (const line of lines) expect(line).toMatch(/^ ?\d+│ «redacted»$/);
      }
      // The code around the key is not part of it.
      expect(await answer(reader, 'read_file', { path: KEY_PATH, from: 1, to: 1 })).toBe(
        '1│ before',
      );
      expect(await answer(reader, 'read_file', { path: KEY_PATH, from: 34, to: 34 })).toBe(
        '34│ after',
      );
    });

    it('grep for a substring of a key body line finds no hit', async () => {
      const reader = memorySnapshot({ files: { [KEY_PATH]: keyFile } });
      // Each body line, a piece of one, and the piece they all share.
      for (const pattern of [keyLine(16), 'lQOYBF0016', keyLine(16).slice(7, 30), 'Qm9ndXMga2V5']) {
        expect(await answer(reader, 'grep', { pattern }), pattern).toBe('no matches');
      }
      // The code around it is searched as ever.
      expect(await answer(reader, 'grep', { pattern: 'before' })).toBe(`${KEY_PATH}:1: before`);
    });

    it('grep for a substring of a masked password value finds no hit', async () => {
      const reader = memorySnapshot({
        files: {
          'src/config.ts': `const user = "admin";\n${PASSWORD_LINE}\nconst port = 8080;\n`,
        },
      });
      for (const pattern of ['very-secret', 'hunter2', PASSWORD_VALUE]) {
        expect(await answer(reader, 'grep', { pattern }), pattern).toBe('no matches');
      }
      // What the mask leaves is found, and shown as the model could read it.
      expect(await answer(reader, 'grep', { pattern: 'password' })).toBe(
        `src/config.ts:2: const password = "${REDACTED}";`,
      );
    });

    it('a hit line next to a key block is masked as in the whole file', async () => {
      // A line of base64 next to a key block is part of the key; the same line alone is code.
      const reader = memorySnapshot({
        files: {
          'keys/with-block.txt': [
            KEY_BEGIN,
            ...body.slice(0, 3),
            KEY_END,
            keyLine(99),
            'after',
          ].join('\n'),
          'notes/alone.txt': ['x', keyLine(99), 'y'].join('\n'),
        },
      });
      expect(await answer(reader, 'grep', { pattern: 'lQOYBF0099' })).toBe(
        `notes/alone.txt:2: ${keyLine(99)}`,
      );
      expect(
        await answer(reader, 'read_file', { path: 'keys/with-block.txt', from: 5, to: 7 }),
      ).toBe(`5│ ${REDACTED}\n6│ ${REDACTED}\n7│ after`);
    });

    it('grep counts as hits the lines of the masked text only: masked-away lines do not use up the cap', async () => {
      const many = Array.from({ length: 80 }, (_, i) => keyLine(i));
      const files = {
        'a/key.txt': [KEY_BEGIN, ...many, KEY_END].join('\n'),
        'b/notes.md': 'see Qm9ndXMga2V5 here\nand Qm9ndXMga2V5 there\n',
      };
      // 80 lines of the key hold the needle in the file as stored, and come first; only the two
      // of the notes are hits.
      expect(await answer(memorySnapshot({ files }), 'grep', { pattern: 'Qm9ndXMga2V5' })).toBe(
        'b/notes.md:1: see Qm9ndXMga2V5 here\nb/notes.md:2: and Qm9ndXMga2V5 there',
      );
      // With more hits than the cap among the masked ones, the message is about those hits.
      const crowded = {
        ...files,
        'c/more.md': Array.from({ length: 60 }, (_, i) => `line ${i} Qm9ndXMga2V5`).join('\n'),
      };
      const hits = (
        await answer(memorySnapshot({ files: crowded }), 'grep', { pattern: 'Qm9ndXMga2V5' })
      ).split('\n');
      expect(hits).toHaveLength(TOOL_LIMITS.grepHits + 1);
      expect(hits[0]).toBe('b/notes.md:1: see Qm9ndXMga2V5 here');
      expect(hits[50]).toBe(MORE_MATCHES);
    });

    it('grep masks no file past the hit that fills the cap', async () => {
      const files: Record<string, string> = {
        'a/key.txt': [KEY_BEGIN, ...Array.from({ length: 80 }, (_, i) => keyLine(i)), KEY_END].join(
          '\n',
        ),
      };
      for (let i = 1; i <= 60; i++)
        files[`b/f${String(i).padStart(2, '0')}.md`] = 'see Qm9ndXMga2V5';
      const { reader, asked } = counting(memorySnapshot({ files }));
      const hits = (await answer(reader, 'grep', { pattern: 'Qm9ndXMga2V5' })).split('\n');
      expect(hits).toHaveLength(TOOL_LIMITS.grepHits + 1);
      expect(hits[50]).toBe(MORE_MATCHES);
      // The key file, and the 51 notes that decide that there are more than 50 hits.
      expect(asked).toHaveLength(1 + 51);
      expect(asked).not.toContain('b/f52.md');
    });

    it('a file is masked once for the whole review, however many calls read it', async () => {
      const files = { [KEY_PATH]: keyFile, 'src/other.ts': 'const other = 1;\n' };
      const { reader, asked } = counting(memorySnapshot({ files }));
      const policy = newPolicy();
      const first = await run(reader, 'read_file', { path: KEY_PATH }, policy);
      const second = await run(reader, 'read_file', { path: KEY_PATH, from: 2, to: 3 }, policy);
      const searched = await run(reader, 'grep', { pattern: 'before' }, policy);
      const listed = await run(reader, 'list_files', {}, policy);
      // The key block is masked once, and reported once, by the call that masked it.
      expect(first.redactions).toBe(1 + 30 + 1);
      expect([second.redactions, searched.redactions, listed.redactions]).toEqual([0, 0, 0]);
      expect(asked).toEqual([KEY_PATH]);
      expect(policy.masked?.maskings).toBe(1);

      // Another file is masked when it is first asked for; another review masks again.
      await run(reader, 'read_file', { path: 'src/other.ts' }, policy);
      expect(policy.masked?.maskings).toBe(2);
      await run(reader, 'read_file', { path: KEY_PATH }, newPolicy());
      expect(asked).toEqual([KEY_PATH, 'src/other.ts', KEY_PATH]);
    });

    it('the masked files are kept up to a bound, and a file past it is masked again each time', async () => {
      const files = {
        'a.txt': `${'a'.repeat(400)}\n`,
        'b.txt': `${'b'.repeat(400)}\n`,
        'c.txt': `${PASSWORD_LINE}\n${'c'.repeat(400)}\n`,
      };
      const { reader, asked } = counting(memorySnapshot({ files }));
      const policy = newPolicy({ masked: new MaskedFiles(reader, { maxBytes: 900, masker }) });
      const redactions: number[] = [];
      for (const path of ['a.txt', 'b.txt', 'c.txt', 'a.txt', 'b.txt', 'c.txt']) {
        redactions.push((await run(reader, 'read_file', { path }, policy)).redactions);
      }
      // a and b are 401 bytes each and fit in 900; c does not, so it is read and masked again.
      expect(asked).toEqual(['a.txt', 'b.txt', 'c.txt', 'c.txt']);
      expect(policy.masked?.files).toBe(2);
      expect(policy.masked?.bytes).toBe(2 * (400 + 4));
      expect(policy.masked?.maskings).toBe(4);
      // Its replacement is reported once all the same.
      expect(redactions).toEqual([0, 0, 1, 0, 0, 0]);
    });

    it('concurrent calls on one path mask it once', async () => {
      const { reader, asked } = counting(memorySnapshot({ files: { [KEY_PATH]: keyFile } }));
      const policy = newPolicy();
      const results = await Promise.all([
        run(reader, 'read_file', { path: KEY_PATH }, policy),
        run(reader, 'read_file', { path: KEY_PATH, from: 2, to: 4 }, policy),
        run(reader, 'grep', { pattern: 'before' }, policy),
        run(reader, 'grep', { pattern: 'after' }, policy),
        run(reader, 'read_file', { path: KEY_PATH, from: 30, to: 34 }, policy),
      ]);
      expect(policy.masked?.maskings).toBe(1);
      expect(asked).toEqual([KEY_PATH]);
      // What was masked is reported once, by one of the calls; the budget is spent once.
      expect(results.map((r) => r.redactions).sort((a, b) => a - b)).toEqual([0, 0, 0, 0, 32]);
      expect(policy.budget.maskedBytes).toBe(
        TOOL_LIMITS.maskedBytesPerReview - Buffer.byteLength(keyFile),
      );
      // Every call got its answer from the masked file.
      expect(results[1]?.text).toBe(`2│ ${REDACTED}\n3│ ${REDACTED}\n4│ ${REDACTED}`);
      expect(results[2]?.text).toBe(`${KEY_PATH}:1: before`);
    });

    it('grep over many hits in one file masks it once, whether or not the masked files are kept', async () => {
      const notes = Array.from({ length: 60 }, (_, i) => `line ${i} Qm9ndXMga2V5`);
      const mixed = [
        KEY_BEGIN,
        ...Array.from({ length: 80 }, (_, i) => keyLine(i)),
        KEY_END,
        ...notes,
      ].join('\n');
      for (const [name, text] of [
        ['sixty hits', notes.join('\n')],
        // 80 of the lines that hold the needle are masked away: the reader is asked again for more.
        ['masked-away lines and then sixty hits', mixed],
      ] as const) {
        const { reader, asked } = counting(memorySnapshot({ files: { 'big.txt': text } }));
        // A bound too small to keep the file: it is masked for the search, once.
        const policy = newPolicy({ masked: new MaskedFiles(reader, { maxBytes: 10, masker }) });
        const hits = (await answer(reader, 'grep', { pattern: 'Qm9ndXMga2V5' }, policy)).split(
          '\n',
        );
        expect(hits, name).toHaveLength(TOOL_LIMITS.grepHits + 1);
        expect(hits[50], name).toBe(MORE_MATCHES);
        expect(policy.masked?.maskings, name).toBe(1);
        expect(asked, name).toEqual(['big.txt']);
        expect(policy.budget.maskedBytes, name).toBe(
          TOOL_LIMITS.maskedBytesPerReview - Buffer.byteLength(text),
        );
      }
    });

    it('every hit is looked at once, however often the reader is asked for more', async () => {
      const key = (n: number) => [
        KEY_BEGIN,
        ...Array.from({ length: n }, (_, i) => keyLine(i)),
        KEY_END,
      ];
      const files = {
        // 19 and 39 lines that hold the needle in the file as stored, and are masked away.
        'f1.txt': key(19).join('\n'),
        'f2.txt': key(39).join('\n'),
        'f3.txt': Array.from({ length: 60 }, (_, i) => `line ${i} Qm9ndXMga2V5`).join('\n'),
      };
      const { reader, asked } = counting(memorySnapshot({ files }));
      // Nothing is kept: a file looked at again would be masked again.
      const policy = newPolicy({ masked: new MaskedFiles(reader, { maxBytes: 10, masker }) });
      const hits = (await answer(reader, 'grep', { pattern: 'Qm9ndXMga2V5' }, policy)).split('\n');
      expect(hits).toHaveLength(TOOL_LIMITS.grepHits + 1);
      expect(hits[0]).toBe('f3.txt:1: line 0 Qm9ndXMga2V5');
      expect(hits[50]).toBe(MORE_MATCHES);
      // The first 51 hits of the reader are lines of f1 and f2; the 204 it is asked for next begin
      // with them again, and go on from there.
      expect(policy.masked?.maskings).toBe(3);
      expect(asked).toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
    });

    it('the text a review masks is budgeted: the call that would pass the budget fails closed', async () => {
      const text = (c: string) => `${c.repeat(400)}\n`;
      const files = { 'a.txt': text('a'), 'b.txt': text('b'), 'c.txt': text('c') };
      const { reader, asked } = counting(memorySnapshot({ files }));
      // 401 bytes each: the budget fits two files and 100 bytes more.
      const policy = newPolicy({ budget: { calls: 99, greps: 99, maskedBytes: 902 } });
      expect(await answer(reader, 'read_file', { path: 'a.txt' }, policy)).toBe(
        `1│ ${'a'.repeat(400)}`,
      );
      expect(await answer(reader, 'read_file', { path: 'b.txt' }, policy)).toBe(
        `1│ ${'b'.repeat(400)}`,
      );
      expect(policy.budget.maskedBytes).toBe(100);
      // The third would pass it: nothing is masked or shown, and the budget is as it was.
      const maskings = policy.masked?.maskings;
      expect(await run(reader, 'read_file', { path: 'c.txt' }, policy)).toEqual({
        text: BUDGET_USED_UP,
        redactions: 0,
      });
      expect(policy.budget.maskedBytes).toBe(100);
      expect(policy.masked?.maskings).toBe(maskings);
      // The files masked already are still there to read, for nothing; a file that is not there,
      // and one that is not text, need no masking.
      expect(await answer(reader, 'read_file', { path: 'a.txt', from: 1, to: 1 }, policy)).toBe(
        `1│ ${'a'.repeat(400)}`,
      );
      expect(await answer(reader, 'read_file', { path: 'nope.txt' }, policy)).toBe(ABSENT);
      expect(policy.budget.maskedBytes).toBe(100);
      expect(asked).toEqual(['a.txt', 'b.txt', 'c.txt', 'nope.txt']);
    });

    it('a grep leaves out a file it cannot afford to mask, and says nothing of it', async () => {
      const files = {
        'a/one.txt': `${'a'.repeat(300)} needle\n`,
        'b/two.txt': `${'b'.repeat(300)} needle\n`,
        'c/three.txt': `${'c'.repeat(300)} needle\n`,
        // It fits in what is left after the first.
        'd/four.txt': 'needle\n',
      };
      const { reader } = counting(memorySnapshot({ files }));
      // 308 bytes a file: the first fits, the second and the third do not, the fourth does.
      const policy = newPolicy({ budget: { calls: 99, greps: 99, maskedBytes: 400 } });
      const out = (await answer(reader, 'grep', { pattern: 'needle' }, policy)).split('\n');
      expect(out).toEqual([`a/one.txt:1: ${'a'.repeat(199)}…`, 'd/four.txt:1: needle']);
      expect(policy.budget.maskedBytes).toBe(400 - 308 - 7);
      // With nothing left to mask a file with, the answer is the one for a needle that is nowhere:
      // the files the reader found it in are not named, counted or hinted at.
      const nothing = () => newPolicy({ budget: { calls: 99, greps: 99, maskedBytes: 0 } });
      const nowhere = await run(reader, 'grep', { pattern: 'a needle that is nowhere' }, nothing());
      const refused = await run(reader, 'grep', { pattern: 'needle' }, nothing());
      expect(refused).toEqual(nowhere);
      expect(refused.text).toBe('no matches');
    });

    it('a file masked again after the bound kept it out is spent again', async () => {
      const text = (c: string) => `${c.repeat(400)}\n`;
      const { reader, asked } = counting(
        memorySnapshot({ files: { 'a.txt': text('a'), 'b.txt': text('b') } }),
      );
      // The masked files kept are bounded at one file; the budget is for two and a half.
      const policy = newPolicy({
        masked: new MaskedFiles(reader, { maxBytes: 450, masker }),
        budget: { calls: 99, greps: 99, maskedBytes: 1_000 },
      });
      const read = (path: string) => answer(reader, 'read_file', { path }, policy);
      expect(await read('a.txt')).toBe(`1│ ${'a'.repeat(400)}`);
      expect(await read('b.txt')).toBe(`1│ ${'b'.repeat(400)}`);
      expect(policy.budget.maskedBytes).toBe(1_000 - 802);
      // b did not fit in what is kept: it is masked again, and the budget does not allow it.
      expect(await read('b.txt')).toBe(BUDGET_USED_UP);
      expect(policy.budget.maskedBytes).toBe(1_000 - 802);
      // a is kept, and free.
      expect(await read('a.txt')).toBe(`1│ ${'a'.repeat(400)}`);
      expect(asked).toEqual(['a.txt', 'b.txt', 'b.txt']);
    });

    it('an excluded file is not read at all, to be masked or to be searched', async () => {
      const files = {
        'secrets/key.txt': `before\n${KEY_BEGIN}\n${body[0]}\n${KEY_END}\n`,
        'src/ok.ts': 'before\n',
      };
      const { reader, asked } = counting(memorySnapshot({ files }));
      const policy = newPolicy({ excludePaths: ['secrets/**'] });
      expect(await answer(reader, 'read_file', { path: 'secrets/key.txt' }, policy)).toBe(EXCLUDED);
      expect(await answer(reader, 'grep', { pattern: 'before' }, policy)).toBe(
        'src/ok.ts:1: before',
      );
      expect(asked).toEqual(['src/ok.ts']);
    });

    it('a policy used with another reader masks the files of that reader', async () => {
      const policy = newPolicy();
      const one = memorySnapshot({ files: { 'a.ts': 'from the first snapshot' } });
      const two = memorySnapshot({ files: { 'a.ts': 'from the second snapshot' } });
      expect(await answer(one, 'read_file', { path: 'a.ts' }, policy)).toBe(
        '1│ from the first snapshot',
      );
      expect(await answer(two, 'read_file', { path: 'a.ts' }, policy)).toBe(
        '1│ from the second snapshot',
      );
    });
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
    const policy = newPolicy({ budget: { calls: 4, greps: 1, maskedBytes: 100 } });
    expect(await answer(reader, 'grep', { pattern: 'needle' }, policy)).toBe('a.ts:1: needle');
    // The file was masked for the search: its 6 bytes are spent, once.
    expect(policy.budget).toEqual({ calls: 3, greps: 0, maskedBytes: 94 });
    // The grep budget is spent; reading is not.
    expect(await answer(reader, 'grep', { pattern: 'needle' }, policy)).toBe(BUDGET_USED_UP);
    expect(policy.budget).toEqual({ calls: 2, greps: 0, maskedBytes: 94 });
    expect(await answer(reader, 'read_file', { path: 'a.ts' }, policy)).toBe('1│ needle');
    expect(await answer(reader, 'list_files', {}, policy)).toBe('a.ts');
    expect(policy.budget).toEqual({ calls: 0, greps: 0, maskedBytes: 94 });
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
    expect(policy.budget).toEqual({ calls: 0, greps: 0, maskedBytes: 94 });
    // A call with arguments the tool refuses still counts as a call, but a refused grep is no search.
    const strict = newPolicy({ budget: { calls: 5, greps: 1, maskedBytes: 100 } });
    await run(reader, 'read_file', {}, strict);
    await run(reader, 'grep', { pattern: 'x' }, strict);
    expect(strict.budget).toEqual({ calls: 3, greps: 1, maskedBytes: 100 });
  });
});

describe('masking that takes too long', () => {
  const NOT_IN_TIME = 'not available: it could not be masked in time';
  const slowMaskers: Masker[] = [];
  afterAll(async () => {
    await Promise.all(slowMaskers.map((m) => m.close()));
  });
  /** A policy whose masker gives a text 500 ms, and the review `budgetMs` for all of them. */
  const slowPolicy = (budgetMs = 90_000): ToolPolicy => {
    const slow = new Masker({ timeoutMs: 500, budgetMs });
    slowMaskers.push(slow);
    return newPolicy({ masker: slow });
  };
  const reader = memorySnapshot({
    files: {
      'a/hostile.txt': `${HOSTILE_TEXT}\nneedle`,
      'b/ok.ts': 'const needle = 1;\n',
      'c/hostile2.txt': `${HOSTILE_TEXT}\nneedle`,
      'd/ok.ts': 'const needle = 2;\n',
    },
  });

  it('read_file says that a file could not be masked in time, and answers so again without masking it again', async () => {
    const policy = slowPolicy();
    const bytes = policy.budget.maskedBytes;
    expect(await run(reader, 'read_file', { path: 'a/hostile.txt' }, policy)).toEqual({
      text: NOT_IN_TIME,
      redactions: 0,
    });
    // The time was spent, and so were the bytes, once.
    const spent = bytes - Buffer.byteLength(`${HOSTILE_TEXT}\nneedle`);
    expect(policy.budget.maskedBytes).toBe(spent);
    // Asked again, it is not masked again: no bytes are spent, and the masker is not asked.
    const masked = policy.masker?.spentMs;
    expect(
      await answer(reader, 'read_file', { path: 'a/hostile.txt', from: 2, to: 3 }, policy),
    ).toBe(NOT_IN_TIME);
    expect(policy.budget.maskedBytes).toBe(spent);
    expect(policy.masker?.spentMs).toBe(masked);
    // The other files are read as ever.
    expect(await answer(reader, 'read_file', { path: 'b/ok.ts' }, policy)).toBe(
      '1│ const needle = 1;',
    );
  });

  it('grep leaves a file that could not be masked in time out of its search, and says nothing of it', async () => {
    const policy = slowPolicy();
    // The two files that take too long are not named, counted or hinted at.
    expect(await answer(reader, 'grep', { pattern: 'needle' }, policy)).toBe(
      ['b/ok.ts:1: const needle = 1;', 'd/ok.ts:1: const needle = 2;'].join('\n'),
    );
    // Asked again, the files that took too long are not masked again: the masker is not asked.
    const masked = policy.masker?.spentMs;
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: 'a/**' }, policy)).toBe(
      'no matches',
    );
    expect(policy.masker?.spentMs).toBe(masked);
    expect(await answer(reader, 'grep', { pattern: 'needle', path_glob: 'b/**' }, policy)).toBe(
      'b/ok.ts:1: const needle = 1;',
    );
  });

  it('grep answers for a needle that is only in a file that took too long as for one that is nowhere', async () => {
    const only = memorySnapshot({
      files: {
        'a/hostile.txt': `${HOSTILE_TEXT}\nthe needle that is only here`,
        'b/other.ts': 'x\n',
      },
    });
    const policy = slowPolicy();
    const nowhere = await run(only, 'grep', { pattern: 'a needle that is nowhere' }, policy);
    // The file is masked now, and takes too long.
    const first = await run(only, 'grep', { pattern: 'needle that is only here' }, policy);
    expect(first).toEqual(nowhere);
    expect(first.text).toBe('no matches');
    // And once it is known to be one that takes too long: the same.
    const again = await run(only, 'grep', { pattern: 'needle that is only here' }, policy);
    expect(again).toEqual(nowhere);
    // A glob that names only it: the same.
    expect(
      await run(only, 'grep', { pattern: 'needle that is only', path_glob: 'a/*' }, policy),
    ).toEqual(nowhere);
    // read_file of it says so, as its answer depends on the path asked for and not on a needle.
    expect(await answer(only, 'read_file', { path: 'a/hostile.txt' }, policy)).toBe(NOT_IN_TIME);
  });

  it('the "more matches" line of a grep is that of the lines the model can see, whatever a file that took too long holds', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `needle ${i + 1}`).join('\n');
    const slow = (extra: string) => `${HOSTILE_TEXT}\n${extra}`;
    // 60, 50 and 10 lines in the other file; a file that takes too long holds 100, 50 or none.
    for (const [visible, hidden] of [
      [60, 100],
      [50, 100],
      [50, 51],
      [10, 100],
      [0, 100],
    ] as const) {
      const base: Record<string, string> = visible === 0 ? {} : { 'b/many.ts': lines(visible) };
      const withSlow = memorySnapshot({ files: { 'a/slow.txt': slow(lines(hidden)), ...base } });
      const without = memorySnapshot({ files: { ...base, 'a/quiet.txt': 'nothing\n' } });
      const label = JSON.stringify([visible, hidden]);
      const a = await answer(withSlow, 'grep', { pattern: 'needle' }, slowPolicy());
      const b = await answer(without, 'grep', { pattern: 'needle' }, slowPolicy());
      expect(a, label).toBe(b);
      const rows = a.split('\n');
      if (visible > TOOL_LIMITS.grepHits) expect(rows.at(-1), label).toBe(MORE_MATCHES);
      else expect(a, label).not.toContain(MORE_MATCHES);
    }
  });

  it('a review that has spent its time for masking gets the budget line from read_file, and masks no more', async () => {
    const policy = slowPolicy(900);
    // 500 ms for the first, and the 400 that are left are not enough for the second.
    expect(await answer(reader, 'read_file', { path: 'a/hostile.txt' }, policy)).toBe(NOT_IN_TIME);
    expect(await answer(reader, 'read_file', { path: 'c/hostile2.txt' }, policy)).toBe(
      BUDGET_USED_UP,
    );
    // The bytes of a text that was not masked are not spent.
    const left = policy.budget.maskedBytes;
    expect(await answer(reader, 'read_file', { path: 'b/ok.ts' }, policy)).toBe(BUDGET_USED_UP);
    // A grep leaves out what it can no longer mask, and says nothing of it.
    expect(await answer(reader, 'grep', { pattern: 'needle' }, policy)).toBe('no matches');
    expect(policy.budget.maskedBytes).toBe(left);
  });

  it('once the review has spent its time, read_file answers alike for a file an earlier grep tried and one it never did', async () => {
    const burning = Object.fromEntries(
      [1, 2, 3, 4].map((n) => [`e/burn${n}.txt`, HOSTILE_TEXT] as const),
    );
    const files = memorySnapshot({
      files: {
        'a/hostile.txt': `${HOSTILE_TEXT}\nneedle`,
        'b/ok.ts': 'const needle = 1;\n',
        'c/never.ts': 'const other = 1;\n',
        'd/never-hostile.txt': HOSTILE_TEXT,
        ...burning,
      },
    });
    const policy = slowPolicy(1_800);
    // A grep tries the two files that hold the needle: one takes too long, one is masked and kept.
    expect(await answer(files, 'grep', { pattern: 'needle' }, policy)).toBe(
      'b/ok.ts:1: const needle = 1;',
    );
    // While there is time, what read_file says tells the two apart, and from a file not tried.
    expect(await answer(files, 'read_file', { path: 'a/hostile.txt' }, policy)).toBe(NOT_IN_TIME);
    expect(await answer(files, 'read_file', { path: 'b/ok.ts' }, policy)).toBe(
      '1│ const needle = 1;',
    );
    expect(await answer(files, 'read_file', { path: 'c/never.ts' }, policy)).toBe(
      '1│ const other = 1;',
    );
    // Texts that take too long spend the time of the review.
    for (const path of Object.keys(burning)) {
      if (policy.masker?.exhausted === true) break;
      await answer(files, 'read_file', { path }, policy);
    }
    expect(policy.masker?.exhausted).toBe(true);
    // Now every file with text gets the budget line: tried and slow, tried and kept, and not tried
    // at all (a text that would take too long too, or one that would not).
    for (const path of ['a/hostile.txt', 'b/ok.ts', 'c/never.ts', 'd/never-hostile.txt']) {
      expect(await answer(files, 'read_file', { path }, policy), path).toBe(BUDGET_USED_UP);
    }
    // A file that needs no masking is answered as it is without the budget.
    expect(await answer(files, 'read_file', { path: 'nope.ts' }, policy)).toBe(ABSENT);
  });

  it('the files are masked by the masker of the policy', async () => {
    const own = new Masker();
    slowMaskers.push(own);
    const policy = newPolicy({ masker: own });
    expect(await answer(reader, 'read_file', { path: 'b/ok.ts' }, policy)).toBe(
      '1│ const needle = 1;',
    );
    expect(own.workersStarted).toBe(1);
    // A policy without one has files that make their own, and leave the shared one alone.
    const before = masker.workersStarted;
    const bare = newPolicy();
    delete bare.masker;
    expect(await answer(reader, 'read_file', { path: 'b/ok.ts' }, bare)).toBe(
      '1│ const needle = 1;',
    );
    expect(masker.workersStarted).toBe(before);
    await bare.masked?.close();
  });

  it('a masker that has been closed fails the call, as a reader that fails does', async () => {
    const closed = new Masker();
    await closed.close();
    const policy = newPolicy({ masker: closed });
    await expect(run(reader, 'read_file', { path: 'b/ok.ts' }, policy)).rejects.toThrow('closed');
    await expect(run(reader, 'grep', { pattern: 'needle' }, policy)).rejects.toThrow('closed');
    // A tool that masks nothing is not stopped by it.
    expect(await answer(reader, 'list_files', {}, policy)).toBe(
      ['a/', 'b/', 'c/', 'd/'].join('\n'),
    );
  });
});

describe('what a call reports it showed of the files', () => {
  const reader = memorySnapshot({
    files: {
      'src/a.ts': 'const needle = 1;\nconst two = 2;\n',
      'src/b.ts': 'const needle = 2;\nneedle again\n',
      'src/empty.ts': '',
      'src/secret.ts': `const key = '${AWS_KEY}';\n`,
      'src/bundle.js': 'z'.repeat(70_000),
      'vendor/x.js': 'needle\n',
      'bin/blob': { kind: 'omitted', reason: 'binary' },
    },
  });
  /** The files a call says it showed lines of: undefined when it says nothing, as a call that showed none does. */
  const shownBy = async (
    name: string,
    args: unknown,
    policy?: ToolPolicy,
  ): Promise<readonly string[] | undefined> => (await run(reader, name, args, policy)).read;

  it('read_file reports the file it showed lines of, whatever the lines are', async () => {
    expect(await shownBy('read_file', { path: 'src/a.ts' })).toEqual(['src/a.ts']);
    expect(await shownBy('read_file', { path: 'src/a.ts', from: 2, to: 2 })).toEqual(['src/a.ts']);
    // A line that was masked is a line of the file, and so is one too long to scan.
    expect(await shownBy('read_file', { path: 'src/secret.ts' })).toEqual(['src/secret.ts']);
    expect(await shownBy('read_file', { path: 'src/bundle.js' })).toEqual(['src/bundle.js']);
  });

  it('read_file reports nothing when it showed no line of a file', async () => {
    const answered: [string, unknown][] = [
      ['an empty file', { path: 'src/empty.ts' }],
      ['a range past the end', { path: 'src/a.ts', from: 3 }],
      ['a path that is not there', { path: 'src/missing.ts' }],
      ['a directory', { path: 'src' }],
      ['a file the snapshot omitted', { path: 'bin/blob' }],
      ['a path that is none', { path: '../src/a.ts' }],
      ['a range that is none', { path: 'src/a.ts', from: 0 }],
      ['no arguments', {}],
    ];
    for (const [name, args] of answered) {
      expect(await shownBy('read_file', args), name).toBeUndefined();
    }
    // The administrator excluded it.
    const excluded = newPolicy({ excludePaths: ['src/**'] });
    expect(await shownBy('read_file', { path: 'src/a.ts' }, excluded)).toBeUndefined();
    // The review used its calls up.
    const used = newPolicy({ budget: { calls: 0, greps: 1, maskedBytes: 1_000_000 } });
    expect(await shownBy('read_file', { path: 'src/a.ts' }, used)).toBeUndefined();
    // Its masker has no time left to mask the file.
    const spent = new Masker({ budgetMs: 0 });
    try {
      expect(
        await shownBy('read_file', { path: 'src/a.ts' }, newPolicy({ masker: spent })),
      ).toBeUndefined();
    } finally {
      await spent.close();
    }
  });

  it('grep reports the files it showed a match of, each once, in the order of the hits', async () => {
    expect(await shownBy('grep', { pattern: 'needle' })).toEqual([
      'src/a.ts',
      'src/b.ts',
      'vendor/x.js',
    ]);
    expect(await shownBy('grep', { pattern: 'needle', path_glob: 'src/b.*' })).toEqual([
      'src/b.ts',
    ]);
    // A line that was masked is still a line that matches.
    expect(await shownBy('grep', { pattern: 'const key' })).toEqual(['src/secret.ts']);
  });

  it('grep reports only what it showed: no search with no match, no file it left out', async () => {
    expect(await shownBy('grep', { pattern: 'nothing like this anywhere' })).toBeUndefined();
    // A needle inside what a mask hides finds nothing.
    expect(await shownBy('grep', { pattern: AWS_KEY })).toBeUndefined();
    // The excluded files are not searched.
    const policy = () => newPolicy({ excludePaths: ['vendor/**'] });
    expect(await shownBy('grep', { pattern: 'needle' }, policy())).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(
      await shownBy('grep', { pattern: 'needle', path_glob: 'vendor/**' }, policy()),
    ).toBeUndefined();
    const refused: [string, unknown, ToolPolicy?][] = [
      ['a pattern that is none', { pattern: 'n' }],
      ['an argument that is none', { pattern: 'needle', where: 'src' }],
      ['a glob that is none', { pattern: 'needle', path_glob: '../src/**' }],
      [
        'a search budget used up',
        { pattern: 'needle' },
        newPolicy({ budget: { calls: 5, greps: 0, maskedBytes: 1_000_000 } }),
      ],
      [
        'a call budget used up',
        { pattern: 'needle' },
        newPolicy({ budget: { calls: 0, greps: 5, maskedBytes: 1_000_000 } }),
      ],
    ];
    for (const [name, args, over] of refused) {
      expect(await shownBy('grep', args, over), name).toBeUndefined();
    }
  });

  it('list_files and a tool that is not there report nothing: a name is no line of a file', async () => {
    expect(await shownBy('list_files', { dir: 'src' })).toBeUndefined();
    expect(await shownBy('list_files', {})).toBeUndefined();
    expect(await shownBy('write_file', { path: 'src/a.ts' })).toBeUndefined();
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
      maskedBytesPerReview: 256 * 1024 * 1024,
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
