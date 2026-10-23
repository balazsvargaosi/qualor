import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GIT_TEST_ENV, initRepo } from '../../test/git';
import { useTempDirs } from '../../test/tmp';
import {
  diffHeaderLine,
  DiffSplitter,
  mergeRanges,
  parseBinaryPaths,
  parseNameStatusZ,
  parseUnifiedDiff,
  unquoteGitPath,
} from './diff';
import { createGit, gitText } from './git';

const tmp = useTempDirs();

describe('parseUnifiedDiff', () => {
  it('collects new-side ranges per file, rename-aware, ignoring deletions', () => {
    const out = [
      'diff --git a/src/added.ts b/src/added.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/added.ts',
      '@@ -0,0 +1,2 @@',
      '+n',
      '+++ this added line starts with two pluses',
      'diff --git a/src/del.ts b/src/del.ts',
      'deleted file mode 100644',
      '--- a/src/del.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/src/dir with space/ümlaut.ts b/src/dir with space/ümlaut.ts',
      '--- a/src/dir with space/ümlaut.ts\t',
      '+++ b/src/dir with space/ümlaut.ts\t',
      '@@ -2 +2 @@ a',
      '-b',
      '+B',
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 67%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -3 +3 @@',
      '-3',
      '+THREE',
      '@@ -4,0 +5,2 @@',
      '+x',
      '+y',
      '\\ No newline at end of file',
      '@@ -10,0 +11 @@',
      '+11',
      'diff --git "a/src/q\\"uote.ts" "b/src/q\\"uote.ts"',
      '--- "a/src/q\\"uote.ts"',
      '+++ "b/src/q\\"uote.ts"',
      '@@ -1,0 +2 @@',
      '+more',
      '',
    ].join('\n');
    expect([...parseUnifiedDiff(out)]).toEqual([
      ['src/added.ts', [[1, 2]]],
      ['src/dir with space/ümlaut.ts', [[2, 2]]],
      [
        'src/new.ts',
        [
          [3, 3],
          [5, 6],
          [11, 11],
        ],
      ],
      ['src/q"uote.ts', [[2, 2]]],
    ]);
  });

  it('with deletions, records where each run of removed lines was: the new-side line after it', () => {
    const out = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      // Old lines 4 and 5 removed, after new line 3: the line after them is new line 4.
      '@@ -4,2 +3,0 @@',
      '-four',
      '-five',
      // Old line 9 changed: removed and added again, at new line 7.
      '@@ -9 +7 @@',
      '-nine',
      '+NINE',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      // The first two lines removed: the line after them is new line 1.
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      // The last line of a five-line file removed: after new line 3, past its end.
      '@@ -5 +3,0 @@',
      '-five',
      'diff --git a/src/c.ts b/src/c.ts',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      // Removed lines between two context lines that interHunkContext kept (a user setting).
      '@@ -2,4 +2,2 @@',
      ' two',
      '-three',
      '-four',
      ' five',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      '',
    ].join('\n');
    expect([...parseUnifiedDiff(out, { deletions: true })]).toEqual([
      [
        'src/a.ts',
        [
          [4, 4],
          [7, 7],
        ],
      ],
      [
        'src/b.ts',
        [
          [1, 1],
          [4, 4],
        ],
      ],
      ['src/c.ts', [[3, 3]]],
    ]);
    // Without, only the added lines count, as the report's new lines do.
    expect([...parseUnifiedDiff(out)]).toEqual([['src/a.ts', [[7, 7]]]]);
  });

  it('merges adjacent and overlapping ranges', () => {
    expect(
      mergeRanges([
        [5, 6],
        [1, 2],
        [3, 3],
        [6, 9],
      ]),
    ).toEqual([
      [1, 3],
      [5, 9],
    ]);
  });

  it('never counts an unchanged context line as new, even when interHunkContext merges two hunks into one', () => {
    // What `git -c diff.interHunkContext=3 diff` produces for changes on lines 2 and 4 of a
    // 5-line file: one merged hunk whose body interleaves an unchanged context line (' l3')
    // between the two real changes. A header-count-only reading of "@@ -2,3 +2,3 @@" would
    // wrongly report [2,4] as all new; walking the body must report only [2,2] and [4,4].
    const out = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -2,3 +2,3 @@',
      '-l2',
      '+CHANGED2',
      ' l3',
      '-l4',
      '+CHANGED4',
      '',
    ].join('\n');
    expect([...parseUnifiedDiff(out)]).toEqual([
      [
        'f.txt',
        [
          [2, 2],
          [4, 4],
        ],
      ],
    ]);
  });
});

describe('parseBinaryPaths', () => {
  it('collects the new-side path of every binary file change', () => {
    const out = [
      'diff --git a/img.png b/img.png',
      'index 1234567..89abcde 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/added.bin b/added.bin',
      'new file mode 100644',
      'index 0000000..abcdef1',
      'Binary files /dev/null and b/added.bin differ',
      'diff --git a/removed.bin b/removed.bin',
      'deleted file mode 100644',
      'index abcdef1..0000000',
      'Binary files a/removed.bin and /dev/null differ',
      '',
    ].join('\n');
    expect(parseBinaryPaths(out)).toEqual(new Set(['img.png', 'added.bin']));
  });

  it('returns an empty set for text-only diffs', () => {
    expect(
      parseBinaryPaths('diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n'),
    ).toEqual(new Set());
  });
});

describe('parseNameStatusZ', () => {
  it('reads NUL-separated statuses including renames and copies', () => {
    const out =
      'A\0src/added.ts\0D\0src/del.ts\0M\0src/dir with space/ü.ts\0R067\0src/old.ts\0src/new.ts\0C100\0a.ts\0b.ts\0';
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'A', path: 'src/added.ts' },
      { status: 'D', path: 'src/del.ts' },
      { status: 'M', path: 'src/dir with space/ü.ts' },
      { status: 'R', from: 'src/old.ts', path: 'src/new.ts' },
      { status: 'C', from: 'a.ts', path: 'b.ts' },
    ]);
    expect(parseNameStatusZ('')).toEqual([]);
  });
});

describe('unquoteGitPath', () => {
  it('decodes C-style escapes and octal UTF-8 bytes', () => {
    expect(unquoteGitPath('"b/\\303\\274.ts"')).toBe('b/ü.ts');
    expect(unquoteGitPath('"a\\tb\\\\c\\"d"')).toBe('a\tb\\c"d');
    expect(unquoteGitPath('"😀 \\n"')).toBe('😀 \n');
    expect(unquoteGitPath('plain')).toBe('plain');
  });
});

describe('diffHeaderLine', () => {
  it("is git's `diff --git` line of a pair, each side quoted on its own like git does", () => {
    expect(diffHeaderLine('src/a.ts', 'src/a.ts')).toBe('diff --git a/src/a.ts b/src/a.ts');
    expect(diffHeaderLine('src/old.ts', 'src/new.ts')).toBe('diff --git a/src/old.ts b/src/new.ts');
    // core.quotepath=off (GIT_OPTIONS): bytes over 0x7f are not quoted, spaces never are.
    expect(diffHeaderLine('dir with space/ü.ts', 'dir with space/ü.ts')).toBe(
      'diff --git a/dir with space/ü.ts b/dir with space/ü.ts',
    );
    expect(diffHeaderLine('q"uote.ts', 'plain.ts')).toBe('diff --git "a/q\\"uote.ts" b/plain.ts');
    expect(diffHeaderLine('back\\slash', 'tab\there')).toBe(
      'diff --git "a/back\\\\slash" "b/tab\\there"',
    );
    expect(diffHeaderLine('bad\u0001\u007f', 'x')).toBe('diff --git "a/bad\\001\\177" b/x');
  });

  it('matches the header git writes for every pair of a real diff', async () => {
    const root = tmp();
    initRepo(root);
    const blob = (text: string) =>
      execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: root,
        env: GIT_TEST_ENV,
        input: text,
        encoding: 'utf8',
      }).trim();
    // git mktree takes any name, also one Git for Windows would not check out.
    const tree = (entries: Record<string, string>) =>
      execFileSync('git', ['mktree', '-z'], {
        cwd: root,
        env: GIT_TEST_ENV,
        input: Object.entries(entries)
          .map(([name, text]) => `100644 blob ${blob(text)}\t${name}\u0000`)
          .join(''),
        encoding: 'utf8',
      }).trim();
    const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const before = tree({ 'old.ts': `${ten}\n`, 'q"uote.ts': 'a\n', 'ü space.ts': 'u\n' });
    const after = tree({
      'new.ts': `${ten}\nmore\n`,
      'q"uote.ts': 'b\n',
      'ü space.ts': 'v\n',
      'tab\there.ts': 't\n',
    });
    const git = createGit(root, GIT_TEST_ENV);
    const headers = (await gitText(git, ['diff', '-M', before, after]))
      .split('\n')
      .filter((l) => l.startsWith('diff --git '));
    const pairs = parseNameStatusZ(
      await gitText(git, ['diff', '--name-status', '-z', '-M', before, after]),
    );
    expect(pairs).toHaveLength(4);
    expect(headers).toEqual(pairs.map((p) => diffHeaderLine(p.from ?? p.path, p.path)));
  });
});

describe('DiffSplitter', () => {
  const DIFF = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+diff --git a/not b/a-header',
    'diff --git a/big.ts b/big.ts',
    '--- a/big.ts',
    '+++ b/big.ts',
    '@@ -1 +1 @@',
    `-${'x'.repeat(200)}`,
    `+${'y'.repeat(200)}`,
    'diff --git a/c.ts b/c.ts',
    'new file mode 100644',
    '',
  ].join('\n');

  function split(chunks: Buffer[], maxBytes = 150): { header: string; patch: string | null }[] {
    const out: { header: string; patch: string | null }[] = [];
    const splitter = new DiffSplitter(maxBytes, (header, patch) => {
      out.push({ header, patch: patch === null ? null : patch.toString('utf8') });
    });
    for (const chunk of chunks) splitter.push(chunk);
    splitter.end();
    return out;
  }

  const EXPECTED = [
    {
      header: 'diff --git a/a.ts b/a.ts',
      patch:
        'diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+diff --git a/not b/a-header\n',
    },
    { header: 'diff --git a/big.ts b/big.ts', patch: null },
    {
      header: 'diff --git a/c.ts b/c.ts',
      patch: 'diff --git a/c.ts b/c.ts\nnew file mode 100644\n',
    },
  ];

  it('cuts the output at each `diff --git` line, and drops a piece over the bound', () => {
    expect(split([Buffer.from(DIFF)])).toEqual(EXPECTED);
  });

  it('gives the same pieces whatever the chunks the output comes in', () => {
    const bytes = Buffer.from(DIFF);
    const ones = [...bytes].map((b) => Buffer.from([b]));
    expect(split(ones)).toEqual(EXPECTED);
    for (const size of [2, 7, 11, 12, 64]) {
      const chunks: Buffer[] = [];
      for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
      expect(split(chunks), `chunks of ${size}`).toEqual(EXPECTED);
    }
  });

  it('keeps a last piece without a final newline, and ignores what comes before the first header', () => {
    expect(split([Buffer.from('warning: x\ndiff --git a/a b/a\n+1')])).toEqual([
      { header: 'diff --git a/a b/a', patch: 'diff --git a/a b/a\n+1' },
    ]);
    expect(split([])).toEqual([]);
  });

  it('drops a piece made of one line over the bound without holding the line', () => {
    const long = `diff --git a/a b/a\n+${'z'.repeat(10_000)}\ndiff --git a/b b/b\n`;
    expect(split([Buffer.from(long)], 100)).toEqual([
      { header: 'diff --git a/a b/a', patch: null },
      { header: 'diff --git a/b b/b', patch: 'diff --git a/b b/b\n' },
    ]);
  });
});
