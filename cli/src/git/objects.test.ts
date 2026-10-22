import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GIT_TEST_ENV, initRepo } from '../../test/git';
import { useTempDirs } from '../../test/tmp';
import { createGit } from './git';
import { parseLsTreeLong, readObjects } from './objects';

const tmp = useTempDirs();

function blob(root: string, content: string | Uint8Array): string {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root,
    env: GIT_TEST_ENV,
    input: content,
    encoding: 'utf8',
  }).trim();
}

describe('parseLsTreeLong', () => {
  it('reads the mode, type, id, size and path of each entry of `git ls-tree -r -z --long`', () => {
    const id = 'a'.repeat(40);
    const sub = 'b'.repeat(40);
    const output = [
      `100644 blob ${id}      12\tsrc/a b.ts`,
      `100755 blob ${id} 1048577\trun.sh`,
      `120000 blob ${id}       6\tlink`,
      `160000 commit ${sub}       -\tvendor/lib`,
      // With -z nothing is quoted: a tab after the first one belongs to the path.
      `100644 blob ${id}       0\ttab\there.txt`,
      '',
    ].join('\u0000');
    expect(parseLsTreeLong(output)).toEqual([
      { mode: '100644', type: 'blob', oid: id, size: 12, path: 'src/a b.ts' },
      { mode: '100755', type: 'blob', oid: id, size: 1_048_577, path: 'run.sh' },
      { mode: '120000', type: 'blob', oid: id, size: 6, path: 'link' },
      { mode: '160000', type: 'commit', oid: sub, size: null, path: 'vendor/lib' },
      { mode: '100644', type: 'blob', oid: id, size: 0, path: 'tab\there.txt' },
    ]);
  });

  it('skips records it cannot read', () => {
    expect(parseLsTreeLong('garbage\u0000100644 blob\tx\u0000')).toEqual([]);
  });
});

describe('readObjects', () => {
  it('hands over each object in the order asked, an empty one and a missing one included', async () => {
    const root = tmp();
    initRepo(root);
    const hello = blob(root, 'hello\n');
    const empty = blob(root, '');
    const bytes = blob(root, new Uint8Array([0, 1, 2, 10, 255]));
    const missing = 'd'.repeat(40);
    const seen: [number, string | null][] = [];
    await readObjects(
      createGit(root, GIT_TEST_ENV),
      [hello, empty, missing, bytes, hello],
      (i, c) => {
        seen.push([i, c === null ? null : c.toString('hex')]);
        return true;
      },
    );
    expect(seen).toEqual([
      [0, Buffer.from('hello\n').toString('hex')],
      [1, ''],
      [2, null],
      [3, '0001020aff'],
      [4, Buffer.from('hello\n').toString('hex')],
    ]);
  });

  it('stops reading once the consumer answers false', async () => {
    const root = tmp();
    initRepo(root);
    const hello = blob(root, 'hello\n');
    const seen: number[] = [];
    await readObjects(
      createGit(root, GIT_TEST_ENV),
      Array.from({ length: 100_000 }, () => hello),
      (i) => {
        seen.push(i);
        return i < 2;
      },
    );
    expect(seen).toEqual([0, 1, 2]);
  });

  it('asks nothing of git for no objects', async () => {
    let calls = 0;
    await readObjects(
      () => {
        calls += 1;
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
      [],
      () => true,
    );
    expect(calls).toBe(0);
  });

  it('fails when git ends before answering every object', async () => {
    const git = () =>
      Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    await expect(readObjects(git, ['a'.repeat(40)], () => true)).rejects.toThrow(
      /git cat-file --batch failed: fatal: not a git repository/,
    );
  });
});
