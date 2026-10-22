import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, fileUrl, GIT_TEST_ENV, gitSync, initRepo } from '../../test/git';
import { useTempDirs, writeTree } from '../../test/tmp';
import { silentLogger } from '../log';
import { Warnings } from '../warnings';
import { ensureCommit, mergeBaseBaseline, type FetchPolicy } from './baseline';
import { createGit } from './git';

const tmp = useTempDirs();
const OFFLINE: FetchPolicy = { autoFetch: false, deepenSteps: [] };
const ONLINE: FetchPolicy = { autoFetch: true, deepenSteps: [50] };

describe('mergeBaseBaseline: the revision', () => {
  it('takes the merge base of the revision it is given, and of HEAD by default', async () => {
    const root = tmp();
    initRepo(root);
    writeTree(root, { 'a.txt': 'a\n' });
    const c1 = commitAll(root, 'c1');
    gitSync(root, 'checkout', '-q', '-b', 'other');
    writeTree(root, { 'b.txt': 'b\n' });
    const other = commitAll(root, 'c2');
    gitSync(root, 'checkout', '-q', 'main');
    writeTree(root, { 'c.txt': 'c\n' });
    const c3 = commitAll(root, 'c3');
    gitSync(root, 'update-ref', 'refs/remotes/origin/main', c3);
    gitSync(root, 'checkout', '-q', '-b', 'feature');
    writeTree(root, { 'd.txt': 'd\n' });
    commitAll(root, 'c4');
    const git = createGit(root, GIT_TEST_ENV);
    const ctx = { log: silentLogger, warnings: new Warnings() };

    expect(await mergeBaseBaseline(git, 'main', OFFLINE, ctx)).toEqual({
      revision: c3,
      kind: 'merge_base',
      status: 'ok',
    });
    expect(await mergeBaseBaseline(git, 'main', OFFLINE, ctx, other)).toEqual({
      revision: c1,
      kind: 'merge_base',
      status: 'ok',
    });
    expect(ctx.warnings.list()).toEqual([]);
  });
});

describe('ensureCommit', () => {
  /** An origin with `main` (two commits) and a branch `other` the clones below do not fetch. */
  function origin(): { url: string; dir: string; other: string } {
    const dir = tmp();
    initRepo(dir);
    writeTree(dir, { 'a.txt': 'a\n' });
    commitAll(dir, 'c1');
    writeTree(dir, { 'b.txt': 'b\n' });
    commitAll(dir, 'c2');
    gitSync(dir, 'checkout', '-q', '-b', 'other');
    writeTree(dir, { 'c.txt': 'c\n' });
    const other = commitAll(dir, 'c3');
    gitSync(dir, 'checkout', '-q', 'main');
    return { url: fileUrl(dir), dir, other };
  }

  function clone(url: string, ...args: string[]): string {
    const parent = tmp();
    gitSync(parent, 'clone', '-q', '--single-branch', '--branch', 'main', ...args, url, 'clone');
    return path.join(parent, 'clone');
  }

  it('answers true at once for a commit the clone has', async () => {
    const { url } = origin();
    const root = clone(url);
    const head = gitSync(root, 'rev-parse', 'HEAD');
    expect(await ensureCommit(createGit(root, GIT_TEST_ENV), head, OFFLINE, silentLogger)).toBe(
      true,
    );
  });

  it('never fetches when scm.autoFetch is false, and never takes a value that is not a commit id', async () => {
    const { url, other } = origin();
    const root = clone(url);
    const git = createGit(root, GIT_TEST_ENV);
    expect(await ensureCommit(git, other, OFFLINE, silentLogger)).toBe(false);
    expect(await ensureCommit(git, 'HEAD', ONLINE, silentLogger)).toBe(false);
    expect(await ensureCommit(git, '--upload-pack=x', ONLINE, silentLogger)).toBe(false);
  });

  it(
    'fetches a missing commit by its id: one commit into a shallow clone, with its history otherwise',
    { timeout: 60_000 },
    async () => {
      const { url, dir, other } = origin();
      const shallow = clone(url, '--depth', '1');
      const git = createGit(shallow, GIT_TEST_ENV);
      expect(await ensureCommit(git, other, ONLINE, silentLogger)).toBe(true);
      expect(gitSync(shallow, 'rev-list', '--count', other)).toBe('1');

      const full = clone(url);
      writeTree(dir, { 'd.txt': 'd\n' });
      const next = commitAll(dir, 'c4');
      expect(await ensureCommit(createGit(full, GIT_TEST_ENV), next, ONLINE, silentLogger)).toBe(
        true,
      );
      // A complete clone stays complete: the commit came with its parents.
      expect(gitSync(full, 'rev-parse', '--is-shallow-repository')).toBe('false');
      expect(gitSync(full, 'rev-list', '--count', next)).toBe('3');

      const missing = 'd'.repeat(40);
      expect(await ensureCommit(git, missing, ONLINE, silentLogger)).toBe(false);
    },
  );
});
