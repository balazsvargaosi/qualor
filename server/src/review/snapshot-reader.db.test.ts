import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { OmissionReason, SnapshotLine } from '@qualor/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { budgetMs } from '../../test/perf';
import { memorySnapshot, storeTestSnapshot } from '../../test/review';
import { first } from '../db/rows';
import { analyses, organizations, projects, reviewSnapshots } from '../db/schema';
import { excludedPathMatcher } from '../llm/settings';
import { Masker } from './masker';
import { MAX_GLOB_WILDCARDS } from './path-glob';
import {
  MAX_HIT_TEXT_CHARS,
  openSnapshotReader,
  type SnapshotChange,
  type SnapshotReader,
} from './snapshot-reader';
import { storeSnapshotUpload, unpackSnapshot } from './snapshot-store';
import { runReviewTool, type ToolPolicy } from './tools';

const SINCE = 'c'.repeat(40);
/** U+FF5E: a character of the Basic Multilingual Plane above the surrogates of UTF-16. */
const FULLWIDTH_TILDE = String.fromCodePoint(0xff5e);

const j = (...parts: string[]) => parts.join('');
/** A fake private key, built at run time so no scanner takes it for a real one. */
const KEY_BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
const KEY_END = j('-----END ', 'RSA PRIVATE KEY-----');
const keyLine = (i: number): string =>
  j('lQOYBF', String(i).padStart(4, '0'), 'Qm9ndXMga2V5IGJvZHk'.repeat(2));

/** `n` numbers from 0, as `00`, `01` … so that they sort as they count. */
const pad = (n: number) => String(n).padStart(2, '0');

const TEXTS: Record<string, string> = {
  'README.md': '# Title\nSee the docs for the needle.\n',
  'src/main.ts': 'import { x } from "./util";\nconst foo = (a|b);\nneedle(main)\n',
  'src/util.ts': 'export const x = 1;\n// needle in util\n',
  'src/new.ts': 'needle new file',
  'src/renamed.ts': 'moved\nneedle\n',
  'src/lib/a.ts': 'a\nneedle a\n',
  'src/lib/b.ts': 'b\n',
  'src/lib/deep/c.ts': 'needle c\n',
  // LIKE metacharacters in names: _ is any character and % any run of them to LIKE.
  'a_b/one.ts': 'needle one\n',
  'axb/two.ts': 'needle two\n',
  'a%b/three.ts': 'needle three\n',
  'src/%/pct.ts': 'needle pct\n',
  'src/q/q.ts': 'needle q\n',
  // Names that a collation and UTF-16 order sort differently from code point order.
  'Zeta.ts': 'needle Z\n',
  'alpha.ts': 'needle alpha\n',
  'éclair.ts': 'needle é\n',
  '日本.ts': 'needle 日本\n',
  [`${FULLWIDTH_TILDE}.ts`]: 'needle fullwidth tilde\n',
  '😀.ts': 'needle 😀 emoji\n',
  // Directories whose names take more than one UTF-16 unit or UTF-8 byte a character.
  'dir😀/inner.ts': 'needle astral dir\n',
  'データ/inner.ts': 'needle katakana dir\n',
  // Line ends and the lines of a file.
  'crlf.txt': 'one\r\ntwo needle\r\nthree\r\n',
  'no-newline.txt': 'ends with needle',
  'empty.txt': '',
  'blank-lines.txt': '\n\nneedle\n\n',
  'long.txt': `${'y'.repeat(3000)} needle ${'z'.repeat(3000)}\nshort needle\n`,
  'many.txt': Array.from({ length: 120 }, (_, i) => `needle ${i + 1}`).join('\n'),
  'big.log': Array.from({ length: 20_000 }, (_, i) =>
    i === 6 || i === 19_998 ? `row ${i + 1} needle` : `row ${i + 1}`,
  ).join('\n'),
  '.hidden/dot.txt': 'needle hidden\n',
  // Secrets the tools mask when they show a file: a YAML value, and a private key block.
  'conf/app.yml': `name: app\n${j('password: ', 'hunter2', 'hunter2')}\nreplicas: 2\n`,
  'keys/server.txt': [
    'before',
    KEY_BEGIN,
    ...Array.from({ length: 30 }, (_, i) => keyLine(i)),
    KEY_END,
    'after',
  ].join('\n'),
  // More files than one fetch of the reader's takes.
  ...Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`many/f${pad(i)}.ts`, `batch-needle ${i}\n`]),
  ),
};
const OMITTED: Record<string, OmissionReason> = {
  'bin/logo.png': 'binary',
  '.env': 'credentials',
  'db/dump.sql': 'too_large',
  'vendor/lib.js': 'excluded',
  link: 'symlink',
  sub: 'submodule',
  'gen/out.ts': 'limit',
  'latin1.txt': 'not_utf8',
};
const CHANGES: SnapshotChange[] = [
  {
    path: 'src/main.ts',
    oldPath: null,
    status: 'modified',
    patch: '@@ -1,2 +1,3 @@\n import { x } from "./util";\n+const foo = (a|b);\n+needle(main)\n',
    since: [
      [2, 3],
      [9, 9],
    ],
  },
  {
    path: 'src/new.ts',
    oldPath: null,
    status: 'added',
    patch: '@@ -0,0 +1 @@\n+needle new file',
    since: [],
  },
  {
    path: 'src/renamed.ts',
    oldPath: 'src/old-name.ts',
    status: 'renamed',
    patch: null,
    since: [[1, 2]],
  },
  {
    path: 'old/gone.ts',
    oldPath: null,
    status: 'deleted',
    patch: '@@ -1 +0,0 @@\n-gone\n',
    since: null,
  },
  { path: 'bin/logo.png', oldPath: null, status: 'added', patch: null, since: null },
];
const INSTRUCTIONS = [
  { name: 'AGENTS.md', text: 'Use two spaces.\n' },
  { name: 'REVIEW.md', text: 'Look for needles.\n' },
];

/** The lines of the fixture, in the order the scanner writes them. */
function fixtureLines(): SnapshotLine[] {
  return [
    ...INSTRUCTIONS.map((i): SnapshotLine => ({
      type: 'instructions',
      name: i.name as 'AGENTS.md' | 'REVIEW.md',
      text: i.text,
    })),
    ...CHANGES.map((c): SnapshotLine => ({
      type: 'change',
      ...c,
      since: c.since?.map(([from, to]): [number, number] => [from, to]) ?? null,
    })),
    ...Object.entries(TEXTS).map(([path, text]): SnapshotLine => ({ type: 'file', path, text })),
    ...Object.entries(OMITTED).map(([path, reason]): SnapshotLine => ({
      type: 'omitted',
      path,
      reason,
    })),
  ];
}

/** The same snapshot, as the memory reader takes it. */
function fixtureMemory(): SnapshotReader {
  return memorySnapshot({
    meta: {
      sinceSha: SINCE,
      targetBranch: 'develop',
      mrTitle: 'Parse the config',
      mrDescription: 'It parses it.',
      instructions: INSTRUCTIONS,
      partial: true,
    },
    changes: CHANGES,
    files: {
      ...TEXTS,
      ...Object.fromEntries(
        Object.entries(OMITTED).map(([path, reason]) => [
          path,
          { kind: 'omitted', reason } as const,
        ]),
      ),
    },
  });
}

describe('the snapshot reader (6I-3)', () => {
  let t: TestDatabase;
  let projectId: string;
  let snapshotId: string;
  let db: SnapshotReader;
  let memory: SnapshotReader;
  /** The masker of the review tools of these tests: one worker, stopped with them. */
  const masker = new Masker();

  const newAnalysis = async (): Promise<string> =>
    first(await t.db.insert(analyses).values({ projectId }).returning()).id;

  beforeAll(async () => {
    t = await createTestDatabase();
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'reader', name: 'Reader' }).returning(),
    ).id;
    projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'reader/api', name: 'api' })
        .returning(),
    ).id;
    snapshotId = await storeTestSnapshot(t.db, await newAnalysis(), fixtureLines(), {
      sinceSha: SINCE,
      targetBranch: 'develop',
      mergeRequest: { id: '7', title: 'Parse the config', description: 'It parses it.' },
      partial: true,
    });
    const opened = await openSnapshotReader(t.db, snapshotId);
    if (opened === null) throw new Error('the fixture snapshot did not open');
    db = opened;
    memory = fixtureMemory();
  });
  afterAll(async () => {
    await masker.close();
    await t.close();
  });

  describe('the DB reader agrees with the memory reader', () => {
    it('on the meta and the changes', async () => {
      expect(db.meta).toEqual({ ...memory.meta, snapshotId });
      expect(db.meta).toMatchObject({
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        sinceSha: SINCE,
        targetBranch: 'develop',
        mrTitle: 'Parse the config',
        mrDescription: 'It parses it.',
        instructions: INSTRUCTIONS,
        partial: true,
      });
      expect(await db.changes()).toEqual(await memory.changes());
      const changes = await db.changes();
      expect(changes.map((c) => c.path)).toEqual([
        'bin/logo.png',
        'old/gone.ts',
        'src/main.ts',
        'src/new.ts',
        'src/renamed.ts',
      ]);
      expect(changes.find((c) => c.path === 'src/renamed.ts')).toEqual({
        path: 'src/renamed.ts',
        oldPath: 'src/old-name.ts',
        status: 'renamed',
        patch: null,
        since: [[1, 2]],
      });
      expect(changes.find((c) => c.path === 'src/main.ts')?.since).toEqual([
        [2, 3],
        [9, 9],
      ]);
    });

    it('on every file', async () => {
      const paths = [
        ...Object.keys(TEXTS),
        ...Object.keys(OMITTED),
        'old/gone.ts',
        'src/old-name.ts',
        'src',
        'src/',
        'nope.ts',
        'constructor',
        '__proto__',
        'src/MAIN.ts',
      ];
      for (const path of paths) {
        expect(await db.file(path), path).toEqual(await memory.file(path));
      }
      expect(await db.file('src/main.ts')).toEqual({ kind: 'text', text: TEXTS['src/main.ts'] });
      expect(await db.file('empty.txt')).toEqual({ kind: 'text', text: '' });
      expect(await db.file('bin/logo.png')).toEqual({ kind: 'omitted', reason: 'binary' });
      // A deleted file has no text and no omission: it is not there at the head.
      expect(await db.file('old/gone.ts')).toEqual({ kind: 'absent' });
      expect(await db.file('nope.ts')).toEqual({ kind: 'absent' });
    });

    it('on grep, across needles, globs and limits', async () => {
      const searches: [string, string | null, number][] = [
        ['needle', null, 1],
        ['needle', null, 5],
        ['needle', null, 50],
        ['needle', null, 51],
        ['needle', null, 500],
        ['needle', null, 5_000],
        ['needle', 'src/**', 50],
        ['needle', '*.ts', 50],
        ['needle', '**/*.ts', 100],
        ['needle', 'src/lib/*.ts', 10],
        ['needle', 'src/*/*.ts', 10],
        ['needle', 'src/**/c.ts', 10],
        ['needle', 'a_b/**', 10],
        ['needle', 'a%b/**', 10],
        ['needle', 'axb/**', 10],
        ['needle', 'src/%/*.ts', 10],
        ['needle', '**/*.txt', 20],
        ['needle', '?????.txt', 20],
        ['needle', '.hidden/**', 10],
        ['needle', 'dir😀/**', 10],
        ['needle', 'データ/?????.ts', 10],
        ['needle', 'デ?タ/*.ts', 10],
        ['needle', 'データ/*.ts', 10],
        ['needle', 'big.log', 10],
        ['needle', 'nomatch/**', 10],
        ['batch-needle', null, 100],
        ['batch-needle', 'many/**', 100],
        ['batch-needle', 'many/f3?.ts', 100],
        ['batch-needle', '**/f1*', 7],
        ['batch-needle', '**/f39.ts', 7],
        ['batch-needle', null, 33],
        ['batch-needle', null, 40],
        ['batch-needle', null, 39],
        ['(a|b)', null, 10],
        ['.*', null, 10],
        ['\\d', null, 10],
        ['é', null, 10],
        ['😀', null, 10],
        ['日本', null, 10],
        ['fullwidth', null, 10],
        ['yyy', null, 10],
        ['row 7', null, 10],
        ['zz', 'long.txt', 10],
        ['absent text', null, 10],
      ];
      for (const [needle, glob, limit] of searches) {
        expect(await db.grep(needle, glob, limit), JSON.stringify([needle, glob, limit])).toEqual(
          await memory.grep(needle, glob, limit),
        );
      }
    });

    it('on grep with an exclusion, as it narrows the files the search is about', async () => {
      const exclusions: [string, (path: string) => boolean][] = [
        ['some directories and a kind of file', excludedPathMatcher(['src/lib/**', '**/*.md'])],
        ['the first files of a group', excludedPathMatcher(['many/f0*.ts', 'many/f1*.ts'])],
        ['all but a few', excludedPathMatcher(['many/f0*.ts', 'many/f1*.ts', 'many/f2*.ts'])],
        ['a name that is no directory', excludedPathMatcher(['many', 'src'])],
        ['every file', () => true],
        ['no file', () => false],
      ];
      const searches: [string, string | null, number][] = [
        ['needle', null, 1],
        ['needle', null, 5],
        ['needle', null, 50],
        ['needle', 'src/**', 10],
        ['needle', '**/*.ts', 100],
        ['batch-needle', null, 5],
        ['batch-needle', null, 10],
        ['batch-needle', null, 40],
        ['batch-needle', 'many/f3?.ts', 5],
        ['batch-needle', '**/f1*', 3],
      ];
      for (const [name, exclude] of exclusions) {
        for (const [needle, glob, limit] of searches) {
          const label = JSON.stringify([name, needle, glob, limit]);
          expect(await db.grep(needle, glob, limit, exclude), label).toEqual(
            await memory.grep(needle, glob, limit, exclude),
          );
        }
      }
    });

    it('on list, across directories and limits', async () => {
      const dirs: [string, number][] = [
        ['', 1],
        ['', 10],
        ['', 500],
        ['', 5_000],
        ['src', 10],
        ['src', 2],
        ['src', 3],
        ['src/lib', 10],
        ['src/lib/deep', 10],
        ['src/%', 10],
        ['a_b', 10],
        ['a%b', 10],
        ['dir😀', 10],
        ['データ', 10],
        ['many', 39],
        ['many', 40],
        ['many', 41],
        ['many', 5],
        ['bin', 10],
        ['old', 10],
        ['nope', 10],
        ['src/lib/a.ts', 10],
        ['sr', 10],
      ];
      for (const [dir, limit] of dirs) {
        expect(await db.list(dir, limit), JSON.stringify([dir, limit])).toEqual(
          await memory.list(dir, limit),
        );
      }
    });
  });

  it('the review tools answer alike over the DB reader and the memory reader', async () => {
    const policy = (): ToolPolicy => ({
      excludePaths: ['vendor/**', 'src/lib/deep/**'],
      budget: { calls: 1_000, greps: 1_000, maskedBytes: 256 * 1024 * 1024 },
      masker,
    });
    const overDb = policy();
    const overMemory = policy();
    const calls: [string, unknown][] = [
      ['read_file', { path: 'src/main.ts' }],
      ['read_file', { path: 'src/main.ts', from: 2, to: 3 }],
      ['read_file', { path: 'crlf.txt' }],
      ['read_file', { path: 'empty.txt' }],
      ['read_file', { path: 'big.log', from: 19_990 }],
      ['read_file', { path: 'big.log' }],
      ['read_file', { path: 'long.txt', from: 1, to: 1 }],
      ['read_file', { path: 'conf/app.yml' }],
      ['read_file', { path: 'keys/server.txt', from: 16, to: 16 }],
      ['read_file', { path: 'keys/server.txt', from: 1, to: 3 }],
      ['read_file', { path: 'bin/logo.png' }],
      ['read_file', { path: 'src/lib/deep/c.ts' }],
      ['read_file', { path: 'old/gone.ts' }],
      ['grep', { pattern: 'needle' }],
      ['grep', { pattern: 'needle', path_glob: 'src/**' }],
      ['grep', { pattern: 'needle', path_glob: '**/*.ts' }],
      ['grep', { pattern: 'needle', path_glob: 'a_b/**' }],
      ['grep', { pattern: 'needle', path_glob: 'src/lib/deep/**' }],
      ['grep', { pattern: 'needle', path_glob: 'src/lib/*/*.ts' }],
      ['grep', { pattern: 'batch-needle', path_glob: 'many/**' }],
      ['grep', { pattern: 'password' }],
      ['grep', { pattern: 'hunter2' }],
      ['grep', { pattern: 'Qm9ndXMga2V5' }],
      ['grep', { pattern: 'lQOYBF0016' }],
      ['grep', { pattern: 'before' }],
      ['grep', { pattern: 'row 19999' }],
      ['list_files', {}],
      ['list_files', { dir: 'src' }],
      ['list_files', { dir: 'src/lib' }],
      ['list_files', { dir: 'src/lib/deep' }],
      ['list_files', { dir: 'many' }],
      ['list_files', { dir: 'nope' }],
    ];
    for (const [name, args] of calls) {
      const id = JSON.stringify([name, args]);
      const call = { id, name, arguments: args };
      expect(await runReviewTool(db, call, overDb), id).toEqual(
        await runReviewTool(memory, call, overMemory),
      );
    }
    // The answers are what is meant: a key is masked from the middle, a needle in a mask finds nothing.
    const call = (name: string, args: unknown) => ({ id: name, name, arguments: args });
    const middle = await runReviewTool(
      db,
      call('read_file', { path: 'keys/server.txt', from: 16, to: 16 }),
      policy(),
    );
    expect(middle.text).toBe('16│ «redacted»');
    const inKey = await runReviewTool(db, call('grep', { pattern: 'lQOYBF0016' }), policy());
    expect(inKey.text).toBe('no matches');
    const yaml = await runReviewTool(db, call('grep', { pattern: 'hunter2' }), policy());
    expect(yaml.text).toBe('no matches');
    // Each file the tools read or searched was masked once, over the database too.
    expect(overDb.masked?.maskings).toBe(overDb.masked?.files);
    expect(overDb.masked?.maskings).toBe(overMemory.masked?.maskings);
  });

  describe('what the DB reader answers', () => {
    it('finds a line by fixed text, with its line number and without its line end', async () => {
      const { hits, truncated } = await db.grep('needle', 'crlf.txt', 10);
      expect(hits).toEqual([{ path: 'crlf.txt', line: 2, text: 'two needle' }]);
      expect(truncated).toBe(false);
      expect((await db.grep('needle', 'no-newline.txt', 10)).hits).toEqual([
        { path: 'no-newline.txt', line: 1, text: 'ends with needle' },
      ]);
      // A newline ends a line, it does not start another: the blank lines are lines 1, 2 and 4.
      expect((await db.grep('needle', 'blank-lines.txt', 10)).hits).toEqual([
        { path: 'blank-lines.txt', line: 3, text: 'needle' },
      ]);
      expect((await db.grep('needle', 'big.log', 10)).hits).toEqual([
        { path: 'big.log', line: 7, text: 'row 7 needle' },
        { path: 'big.log', line: 19_999, text: 'row 19999 needle' },
      ]);
      // A hit's text is bounded, whatever the line.
      const long = (await db.grep('needle', 'long.txt', 10)).hits;
      expect(long.map((h) => h.line)).toEqual([1, 2]);
      expect(long[0]?.text.length).toBeLessThanOrEqual(MAX_HIT_TEXT_CHARS);
      expect(long[1]?.text).toBe('short needle');
    });

    it('searches the text of the files, not the patches, the instructions or the omitted', async () => {
      // `gone` is in the patch of a deleted file, `two spaces` in an instructions file, `png` in a name.
      for (const needle of ['gone', 'two spaces', 'png', 'credentials']) {
        expect(await db.grep(needle, null, 100), needle).toEqual({ hits: [], truncated: false });
      }
    });

    /** A reader of the fixture snapshot over a database that counts the queries made through it. */
    async function countingReader(): Promise<{
      reader: SnapshotReader;
      queries: () => number;
      reset: () => void;
    }> {
      let queries = 0;
      const counted = new Proxy(t.db, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          const method = value as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            if (property === 'select' || property === 'execute') queries += 1;
            return method.apply(target, args);
          };
        },
      });
      const reader = await openSnapshotReader(counted, snapshotId);
      if (reader === null) throw new Error('the fixture snapshot did not open');
      queries = 0;
      return {
        reader,
        queries: () => queries,
        reset: () => {
          queries = 0;
        },
      };
    }

    it('reads the text only of the files that hold the needle, a few at a time', async () => {
      const { reader, queries, reset } = await countingReader();
      // No file holds it: the query that names the files is the only one.
      await reader.grep('a needle nobody wrote', null, 10);
      expect(queries()).toBe(1);
      // One file holds it: that query and one for its text.
      reset();
      expect((await reader.grep('needle in util', null, 10)).hits).toHaveLength(1);
      expect(queries()).toBe(2);
      // Forty files: their texts come 16 at a time.
      reset();
      expect((await reader.grep('batch-needle', null, 100)).hits).toHaveLength(40);
      expect(queries()).toBe(1 + 3);
      // A glob that takes none of them asks for no text at all.
      reset();
      expect((await reader.grep('batch-needle', 'src/**', 100)).hits).toEqual([]);
      expect(queries()).toBe(1);
      // And a full answer stops asking: the first group holds the one hit that is asked for.
      reset();
      expect((await reader.grep('batch-needle', null, 1)).truncated).toBe(true);
      expect(queries()).toBe(1 + 1);
    });

    it('reads no text of a file the exclusion names, and does not count it', async () => {
      const { reader, queries, reset } = await countingReader();
      // All forty are excluded: no text is read, and there is nothing more to find.
      expect(await reader.grep('batch-needle', null, 10, excludedPathMatcher(['many/**']))).toEqual(
        {
          hits: [],
          truncated: false,
        },
      );
      expect(queries()).toBe(1);
      // Thirty are: the ten that are not come in one group, and fit a limit of ten.
      const most = excludedPathMatcher(['many/f0*.ts', 'many/f1*.ts', 'many/f2*.ts']);
      reset();
      const ten = await reader.grep('batch-needle', null, 10, most);
      expect(ten.hits.map((h) => h.path)).toEqual(
        Array.from({ length: 10 }, (_, i) => `many/f${30 + i}.ts`),
      );
      expect(ten.truncated).toBe(false);
      expect(queries()).toBe(1 + 1);
      // A limit of nine leaves one more.
      const nine = await reader.grep('batch-needle', null, 9, most);
      expect(nine.hits).toHaveLength(9);
      expect(nine.truncated).toBe(true);
    });

    it('asks again for more of one search without finding its files again', async () => {
      const { reader, queries, reset } = await countingReader();
      const exclude = excludedPathMatcher(['nothing/**']);
      expect((await reader.grep('batch-needle', null, 5, exclude)).hits).toHaveLength(5);
      expect(queries()).toBe(1 + 1);
      // The same search with a higher limit: the files are known, the texts are read.
      reset();
      const more = await reader.grep('batch-needle', null, 20, exclude);
      expect(more).toEqual(await memory.grep('batch-needle', null, 20, exclude));
      expect(queries()).toBe(2);
      reset();
      expect(await reader.grep('batch-needle', null, 100, exclude)).toEqual(
        await memory.grep('batch-needle', null, 100, exclude),
      );
      expect(queries()).toBe(3);
      // Another exclusion, glob or needle is another search.
      reset();
      await reader.grep('batch-needle', null, 5, excludedPathMatcher(['nothing/**']));
      expect(queries()).toBe(1 + 1);
      reset();
      await reader.grep('batch-needle', 'many/**', 5, exclude);
      expect(queries()).toBe(1 + 1);
      reset();
      await reader.grep('needle in util', null, 5, exclude);
      expect(queries()).toBe(1 + 1);
    });

    it('ends a search whose glob takes too much work with the hits it has, and says there is more', async () => {
      const analysisId = await newAnalysis();
      const hostile = `${'*a'.repeat(MAX_GLOB_WILDCARDS - 1)}*b`;
      // The first path matches the glob; the 4 000 long ones after it are walked to their ends.
      const match = `0${'a'.repeat(20)}b`;
      const longPaths = Array.from(
        { length: 4_000 },
        (_, i) => `${'a'.repeat(990)}${String(i).padStart(6, '0')}`,
      );
      const id = await storeTestSnapshot(
        t.db,
        analysisId,
        [match, ...longPaths].map((path): SnapshotLine => ({
          type: 'file',
          path,
          text: 'needle\n',
        })),
      );
      const reader = await openSnapshotReader(t.db, id);
      const started = performance.now();
      const found = await reader!.grep('needle', hostile, 50);
      expect(performance.now() - started).toBeLessThan(budgetMs(5_000));
      expect(found).toEqual({ hits: [{ path: match, line: 1, text: 'needle' }], truncated: true });
    });

    it('escapes LIKE metacharacters in the prefix of a glob', async () => {
      const paths = async (glob: string) =>
        (await db.grep('needle', glob, 100)).hits.map((h) => h.path);
      expect(await paths('a_b/**')).toEqual(['a_b/one.ts']);
      expect(await paths('a%b/**')).toEqual(['a%b/three.ts']);
      expect(await paths('src/%/*.ts')).toEqual(['src/%/pct.ts']);
      expect(await paths('src/q/*.ts')).toEqual(['src/q/q.ts']);
      expect(await db.list('a_b', 10)).toEqual({
        entries: [{ name: 'one.ts', kind: 'file' }],
        truncated: false,
      });
      expect(await db.list('a%b', 10)).toEqual({
        entries: [{ name: 'three.ts', kind: 'file' }],
        truncated: false,
      });
      expect(await db.list('src/%', 10)).toEqual({
        entries: [{ name: 'pct.ts', kind: 'file' }],
        truncated: false,
      });
    });

    it('orders by code point', async () => {
      const root = (await db.list('', 5_000)).entries.map((e) => e.name);
      expect(root.slice(0, 6)).toEqual(['.env', '.hidden', 'README.md', 'Zeta.ts', 'a%b', 'a_b']);
      // é, デ, 日, U+FF5E, 😀: the order of code points, which UTF-16 and a collation both change.
      expect(root.slice(-5)).toEqual([
        'éclair.ts',
        'データ',
        '日本.ts',
        `${FULLWIDTH_TILDE}.ts`,
        '😀.ts',
      ]);
      const hits = (await db.grep('needle', '?*.ts', 5_000)).hits.map((h) => h.path);
      expect(hits.slice(-4)).toEqual(['éclair.ts', '日本.ts', `${FULLWIDTH_TILDE}.ts`, '😀.ts']);
    });

    it('lists the immediate children, directories marked, without what the merge request deleted', async () => {
      expect(await db.list('src', 10)).toEqual({
        entries: [
          { name: '%', kind: 'dir' },
          { name: 'lib', kind: 'dir' },
          { name: 'main.ts', kind: 'file' },
          { name: 'new.ts', kind: 'file' },
          { name: 'q', kind: 'dir' },
          { name: 'renamed.ts', kind: 'file' },
          { name: 'util.ts', kind: 'file' },
        ],
        truncated: false,
      });
      // The omitted files are listed; the deleted one, and the old name of a rename, are not.
      expect((await db.list('old', 10)).entries).toEqual([]);
      expect((await db.list('bin', 10)).entries).toEqual([{ name: 'logo.png', kind: 'file' }]);
      expect((await db.list('', 5_000)).entries.map((e) => e.name)).not.toContain('old/');
      expect((await db.list('src', 10)).entries.map((e) => e.name)).not.toContain('old-name.ts');
      expect(await db.list('many', 5)).toMatchObject({ truncated: true });
      expect((await db.list('many', 5)).entries).toHaveLength(5);
    });
  });

  describe('readers', () => {
    it('a snapshot deleted while a reader is open answers absent', async () => {
      const id = await storeTestSnapshot(t.db, await newAnalysis(), [
        { type: 'file', path: 'src/a.ts', text: 'needle\n' },
        {
          type: 'change',
          path: 'src/a.ts',
          oldPath: null,
          status: 'added',
          patch: null,
          since: null,
        },
      ]);
      const reader = await openSnapshotReader(t.db, id);
      expect(reader).not.toBeNull();
      expect(await reader!.file('src/a.ts')).toEqual({ kind: 'text', text: 'needle\n' });
      expect((await reader!.grep('needle', null, 5)).hits).toHaveLength(1);
      expect((await reader!.list('', 5)).entries).toHaveLength(1);

      // Housekeeping, a newer analysis or a merged merge request deletes the snapshot.
      await t.db.delete(reviewSnapshots).where(eq(reviewSnapshots.id, id));

      expect(await reader!.file('src/a.ts')).toEqual({ kind: 'absent' });
      expect(await reader!.changes()).toEqual([]);
      expect(await reader!.grep('needle', null, 5)).toEqual({ hits: [], truncated: false });
      expect(await reader!.grep('needle', 'src/**', 5)).toEqual({ hits: [], truncated: false });
      expect(await reader!.list('', 5)).toEqual({ entries: [], truncated: false });
      expect(await reader!.list('src', 5)).toEqual({ entries: [], truncated: false });
      // What it was opened with is still there to read.
      expect(reader!.meta.headSha).toBe('a'.repeat(40));
      expect(await openSnapshotReader(t.db, id)).toBeNull();
    });

    it('storeTestSnapshot throws with the stored reason when the unpacker refuses the snapshot', async () => {
      await expect(
        storeTestSnapshot(t.db, await newAnalysis(), [
          { type: 'file', path: '../outside.ts', text: 'x' },
        ]),
      ).rejects.toThrow(
        'the test snapshot did not unpack (rejected): SNAPSHOT_INVALID:path: invalid path',
      );
    });

    it('openSnapshotReader returns null for an uploaded or rejected snapshot', async () => {
      const upload = async (text: string) => {
        const analysisId = await newAnalysis();
        const body = gzipSync(text);
        const id = await storeSnapshotUpload(t.db, {
          analysisId,
          projectId,
          body,
          compressedBytes: body.length,
        });
        return id;
      };
      const uploaded = await upload('{"type":"header"}\n');
      expect(
        first(await t.db.select().from(reviewSnapshots).where(eq(reviewSnapshots.id, uploaded)))
          .status,
      ).toBe('uploaded');
      expect(await openSnapshotReader(t.db, uploaded)).toBeNull();

      const rejected = await upload('this is not a snapshot\n');
      const limits = { maxCompressedBytes: 1 << 20, maxDecompressedBytes: 1 << 20 };
      expect(await unpackSnapshot(t.db, rejected, limits)).toBe('rejected');
      expect(await openSnapshotReader(t.db, rejected)).toBeNull();

      // The status decides, not the fields that only a ready snapshot has: with them set, an upload
      // and a refused snapshot still open nothing.
      for (const id of [uploaded, rejected]) {
        await t.db
          .update(reviewSnapshots)
          .set({ headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), targetBranch: 'main' })
          .where(eq(reviewSnapshots.id, id));
        expect(await openSnapshotReader(t.db, id)).toBeNull();
      }

      // Nor does a snapshot that is not there open; a ready one does.
      expect(await openSnapshotReader(t.db, randomUUID())).toBeNull();
      expect(await openSnapshotReader(t.db, snapshotId)).not.toBeNull();
    });
  });
});

describe('the snapshot reader on a database with another collation (6I-3)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    // The database's own collation orders text its own way; the reader must not depend on it.
    await t.db.execute(
      sql`ALTER TABLE review_snapshot_files ALTER COLUMN path TYPE text COLLATE "und-x-icu"`,
    );
  });
  afterAll(async () => {
    await t.close();
  });

  it('orders by code point whatever the collation of the path column', async () => {
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'collation', name: 'Collation' }).returning(),
    ).id;
    const projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'collation/api', name: 'api' })
        .returning(),
    ).id;
    const analysisId = first(await t.db.insert(analyses).values({ projectId }).returning()).id;
    const names = ['B.ts', 'a.ts', 'Z.ts', '_x.ts', 'é.ts', 'a_b/x.ts', 'a%b/x.ts', 'ab/x.ts'];
    const id = await storeTestSnapshot(t.db, analysisId, [
      ...names.map((path): SnapshotLine => ({ type: 'file', path, text: 'needle\n' })),
      ...names.slice(0, 5).map((path): SnapshotLine => ({
        type: 'change',
        path,
        oldPath: null,
        status: 'modified',
        patch: null,
        since: null,
      })),
    ]);
    // The collation really differs from the code point order here.
    const collated = await t.db.execute<{ path: string }>(
      sql`SELECT path FROM review_snapshot_files WHERE snapshot_id = ${id} AND path NOT LIKE '%/%' ORDER BY path`,
    );
    expect(collated.rows.map((r) => r.path)).not.toEqual(['B.ts', 'Z.ts', '_x.ts', 'a.ts', 'é.ts']);

    const reader = await openSnapshotReader(t.db, id);
    expect((await reader!.list('', 100)).entries.map((e) => e.name)).toEqual([
      'B.ts',
      'Z.ts',
      '_x.ts',
      'a%b',
      'a.ts',
      'a_b',
      'ab',
      'é.ts',
    ]);
    expect((await reader!.grep('needle', null, 100)).hits.map((h) => h.path)).toEqual([
      'B.ts',
      'Z.ts',
      '_x.ts',
      'a%b/x.ts',
      'a.ts',
      'a_b/x.ts',
      'ab/x.ts',
      'é.ts',
    ]);
    expect((await reader!.changes()).map((c) => c.path)).toEqual([
      'B.ts',
      'Z.ts',
      '_x.ts',
      'a.ts',
      'é.ts',
    ]);
    expect((await reader!.grep('needle', 'a_b/**', 100)).hits.map((h) => h.path)).toEqual([
      'a_b/x.ts',
    ]);
    expect((await reader!.list('a_b', 100)).entries).toEqual([{ name: 'x.ts', kind: 'file' }]);
  });
});
