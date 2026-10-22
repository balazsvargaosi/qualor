import { readdirSync } from 'node:fs';
import { parseConfig } from '@qualor/shared';
import { describe, expect, it, vi } from 'vitest';
import { commitAll, GIT_TEST_ENV, gitSync, initRepo } from '../../test/git';
import { useTempDirs, writeTree } from '../../test/tmp';
import { createGit } from '../git/git';
import { silentLogger } from '../log';
import type * as Patches from './patches';
import { buildReviewSnapshot } from './snapshot';

// The cap on the patches held in memory is a constant (M4): a test cannot afford 64 MiB of diffs,
// so the snapshot builder gets a cap of 2 000 bytes here, in place of the real constant, which is
// pinned below.
vi.mock('./patches', async (importOriginal) => ({
  ...(await importOriginal<typeof Patches>()),
  MAX_PATCH_BUDGET_BYTES: 2_000,
}));

const tmp = useTempDirs();
const MiB = 1024 * 1024;
/** The server's limits as the review context answers them by default: the inflated one is 500 MiB. */
const LIMITS = {
  maxCompressedBytes: 50 * MiB,
  maxDecompressedBytes: 500 * MiB,
  maxFileBytes: MiB,
  maxFiles: 50_000,
};

const lines = (tag: string, n: number): string =>
  `${Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n')}\n`;

/**
 * A clone whose origin/main is the base commit, and a head that rewrites `a.txt` and `b.txt` of
 * `changed` lines each on top of it: two patches, so that the first is counted when the second
 * starts.
 */
function mergeRequest(changed: number): { root: string; head: string } {
  const root = tmp();
  initRepo(root);
  writeTree(root, { 'a.txt': lines('old', changed), 'b.txt': lines('old', changed) });
  const base = commitAll(root, 'base');
  gitSync(root, 'update-ref', 'refs/remotes/origin/main', base);
  writeTree(root, { 'a.txt': lines('new', changed), 'b.txt': lines('new', changed) });
  return { root, head: commitAll(root, 'head') };
}

const build = (mr: { root: string; head: string }, tempRoot: string) =>
  buildReviewSnapshot({
    git: createGit(mr.root, GIT_TEST_ENV),
    config: parseConfig({ version: 1, project: { key: 'acme/app' } }),
    headSha: mr.head,
    targetBranch: 'main',
    sinceSha: null,
    mergeRequest: { id: '7', title: null, description: null },
    secrets: [],
    // These repositories have no checkout: the head's own files stand for the scanned ones.
    secretsFrom: 'head',
    limits: LIMITS,
    policy: { autoFetch: false, deepenSteps: [] },
    log: silentLogger,
    tempRoot,
    baseSecrets: null,
  });

describe('the budget of the patches a snapshot holds (M4)', () => {
  it('is 64 MiB, whatever inflated size the server accepts', async () => {
    const real = await vi.importActual<typeof Patches>('./patches');
    expect(real.MAX_PATCH_BUDGET_BYTES).toBe(64 * MiB);
  });

  it('makes a merge request whose patches pass it too_large, though the server accepts 500 MiB', async () => {
    // Two patches of 100 lines out and 100 in: about 2 500 bytes each, over the cap of 2 000 bytes,
    // and far under the limits.
    const tempRoot = tmp();
    const mr = mergeRequest(100);
    expect(await build(mr, tempRoot)).toEqual({ kind: 'unavailable', reason: 'too_large' });
    // As any other overflow: nothing is left behind.
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('builds one whose patches are within it', async () => {
    const mr = mergeRequest(10);
    const built = await build(mr, tmp());
    expect(built).toMatchObject({ kind: 'built', files: 2, partial: false });
    if (built.kind === 'built') await built.cleanup();
  });
});
