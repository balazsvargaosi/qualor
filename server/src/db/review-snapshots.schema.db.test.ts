import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, expectPgError, type TestDatabase } from '../../test/db';
import { PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION, pgConstraint, pgErrorCode } from './errors';
import { first } from './rows';
import {
  analyses,
  branches,
  organizations,
  projects,
  REVIEW_SNAPSHOT_STATUSES,
  reviewSnapshotFiles,
  reviewSnapshots,
  SNAPSHOT_CHANGES,
} from './schema';

/**
 * Ruling P3: exactly these eight. `path_too_long` is not a reason: a path that fails the path rule
 * is never sent, not even as an omitted line.
 */
const OMISSION_REASONS = [
  'binary',
  'too_large',
  'excluded',
  'credentials',
  'symlink',
  'submodule',
  'limit',
  'not_utf8',
] as const;
const SHA1 = 'a'.repeat(40);
const SHA256 = '0123456789abcdef'.repeat(4);

/** The action is refused by the named CHECK (23514), not by some other constraint. */
async function expectCheckViolation(action: PromiseLike<unknown>, constraint: string) {
  const err = await Promise.resolve(action).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(pgErrorCode(err), `expected ${constraint} to refuse it`).toBe(PG_CHECK_VIOLATION);
  expect(pgConstraint(err)).toBe(constraint);
}

describe('review_snapshots and review_snapshot_files (6I-2, migration 0015_review_snapshots)', () => {
  let t: TestDatabase;
  let organizationId: string;
  let projectId: string;
  let mergeRequestId: string;

  const newProject = async (key: string) =>
    first(await t.db.insert(projects).values({ organizationId, key, name: key }).returning()).id;
  const newBranch = async (name: string) =>
    first(
      await t.db.insert(branches).values({ projectId, kind: 'merge_request', name }).returning(),
    ).id;
  const newAnalysis = async () =>
    first(await t.db.insert(analyses).values({ projectId }).returning()).id;

  /** Values of an uploaded snapshot of a fresh analysis, unless `over` says otherwise. */
  const uploaded = async (over: Partial<typeof reviewSnapshots.$inferInsert> = {}) => ({
    analysisId: await newAnalysis(),
    projectId,
    compressedBytes: 40,
    body: Buffer.from('gzip bytes'),
    ...over,
  });
  const snapshot = async (over: Partial<typeof reviewSnapshots.$inferInsert> = {}) =>
    first(
      await t.db
        .insert(reviewSnapshots)
        .values(await uploaded(over))
        .returning(),
    );
  const fileRow = (
    snapshotId: string,
    path: string,
    over: Partial<typeof reviewSnapshotFiles.$inferInsert> = {},
  ) => ({
    snapshotId,
    path,
    ...over,
  });
  const survivors = async (ids: string[]) =>
    (
      await t.db
        .select({ id: reviewSnapshots.id })
        .from(reviewSnapshots)
        .where(inArray(reviewSnapshots.id, ids))
    )
      .map((row) => row.id)
      .sort();
  const pathsOf = async (snapshotId: string) =>
    (
      await t.db
        .select({ path: reviewSnapshotFiles.path })
        .from(reviewSnapshotFiles)
        .where(eq(reviewSnapshotFiles.snapshotId, snapshotId))
    )
      .map((row) => row.path)
      .sort();

  beforeAll(async () => {
    t = await createTestDatabase();
    organizationId = first(
      await t.db.insert(organizations).values({ key: 'snap', name: 'Snap' }).returning(),
    ).id;
    projectId = await newProject('snap/api');
    mergeRequestId = await newBranch('7');
  });
  afterAll(async () => {
    await t.close();
  });

  it('stores an uploaded snapshot with its defaults', async () => {
    const stored = await snapshot();
    expect(stored).toMatchObject({
      status: 'uploaded',
      error: null,
      branchId: null,
      inflatedBytes: null,
      headSha: null,
      baseSha: null,
      sinceSha: null,
      targetBranch: null,
      mrTitle: null,
      mrDescription: null,
      instructions: [],
      partial: false,
      fileCount: 0,
      unpackedAt: null,
    });
    expect(stored.body?.toString()).toBe('gzip bytes');
    expect(stored.compressedBytes).toBe(40);
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it('keeps what unpacking learns: the header, the instruction files and a size past 2 GiB', async () => {
    const stored = await snapshot({
      status: 'ready',
      body: null,
      branchId: mergeRequestId,
      inflatedBytes: 3_000_000_000,
      headSha: SHA1,
      baseSha: SHA256,
      sinceSha: SHA1,
      targetBranch: 'main',
      mrTitle: 'Fix the parser',
      mrDescription: 'It reads one byte too far.',
      instructions: [{ name: 'AGENTS.md', text: 'Use tabs.' }],
      partial: true,
      fileCount: 12,
      unpackedAt: new Date('2026-10-22T08:00:00Z'),
    });
    expect(stored).toMatchObject({
      status: 'ready',
      body: null,
      branchId: mergeRequestId,
      inflatedBytes: 3_000_000_000,
      headSha: SHA1,
      baseSha: SHA256,
      sinceSha: SHA1,
      targetBranch: 'main',
      mrTitle: 'Fix the parser',
      mrDescription: 'It reads one byte too far.',
      instructions: [{ name: 'AGENTS.md', text: 'Use tabs.' }],
      partial: true,
      fileCount: 12,
    });
    expect(stored.unpackedAt).toEqual(new Date('2026-10-22T08:00:00Z'));
  });

  it('uploaded needs a body, ready and rejected have none', async () => {
    const bodyByStatus = 'review_snapshots_body_by_status';
    await expectCheckViolation(
      t.db.insert(reviewSnapshots).values(await uploaded({ body: null })),
      bodyByStatus,
    );
    await expectCheckViolation(
      t.db.insert(reviewSnapshots).values(await uploaded({ status: 'ready' })),
      bodyByStatus,
    );
    await expectCheckViolation(
      t.db
        .insert(reviewSnapshots)
        .values(await uploaded({ status: 'rejected', error: 'SNAPSHOT_INVALID:end_missing' })),
      bodyByStatus,
    );
    // Every status of the exported list has exactly one allowed shape.
    for (const status of REVIEW_SNAPSHOT_STATUSES) {
      const stored = await snapshot(status === 'uploaded' ? {} : { status, body: null });
      expect(stored.status).toBe(status);
      expect(stored.body !== null).toBe(status === 'uploaded');
    }
    await expectCheckViolation(
      t.db
        .insert(reviewSnapshots)
        .values(await uploaded({ status: 'unpacking' as never, body: null })),
      'review_snapshots_status_check',
    );
    expect(REVIEW_SNAPSHOT_STATUSES).toEqual(['uploaded', 'ready', 'rejected']);
  });

  it('a bad SHA is refused', async () => {
    const columns = [
      ['review_snapshots_head_sha_format', (sha: string) => ({ headSha: sha })],
      ['review_snapshots_base_sha_format', (sha: string) => ({ baseSha: sha })],
      ['review_snapshots_since_sha_format', (sha: string) => ({ sinceSha: sha })],
    ] as const;
    const bad = [
      '',
      'HEAD',
      'A'.repeat(40),
      'g'.repeat(40),
      ...[39, 41, 63, 65].map((n) => 'a'.repeat(n)),
    ];
    for (const [constraint, set] of columns) {
      for (const sha of bad) {
        await expectCheckViolation(
          t.db.insert(reviewSnapshots).values(await uploaded(set(sha))),
          constraint,
        );
      }
      // A SHA-1 or a SHA-256 object name, in lower case, and no SHA at all.
      for (const sha of [SHA1, SHA256]) await snapshot(set(sha));
      await snapshot();
    }
  });

  it('keeps one snapshot per analysis', async () => {
    const stored = await snapshot();
    await expectPgError(
      t.db.insert(reviewSnapshots).values(await uploaded({ analysisId: stored.analysisId })),
      PG_UNIQUE_VIOLATION,
    );
  });

  it('stores a file, a change and an omission as rows of one table', async () => {
    const { id } = await snapshot();
    const rows = await t.db
      .insert(reviewSnapshotFiles)
      .values([
        fileRow(id, 'src/a.ts', { text: 'export const a = 1;\n', bytes: 20 }),
        fileRow(id, 'src/b.ts', {
          text: 'new\n',
          bytes: 4,
          change: 'renamed',
          oldPath: 'src/old.ts',
          patch: '@@ -1 +1 @@\n-old\n+new\n',
          since: [
            [1, 3],
            [10, 12],
          ],
        }),
        fileRow(id, 'logo.png', { bytes: 5000, omitted: 'binary' }),
        fileRow(id, 'gone.ts', { change: 'deleted', patch: '@@ -1 +0,0 @@\n-x\n' }),
      ])
      .returning();
    const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
    expect(byPath['src/a.ts']).toEqual({
      snapshotId: id,
      path: 'src/a.ts',
      text: 'export const a = 1;\n',
      bytes: 20,
      omitted: null,
      change: null,
      oldPath: null,
      patch: null,
      since: null,
    });
    expect(byPath['src/b.ts']).toMatchObject({
      change: 'renamed',
      oldPath: 'src/old.ts',
      since: [
        [1, 3],
        [10, 12],
      ],
    });
    expect(byPath['logo.png']).toMatchObject({ text: null, bytes: 5000, omitted: 'binary' });
    // `bytes` defaults to 0.
    expect(byPath['gone.ts']).toMatchObject({ text: null, bytes: 0, change: 'deleted' });
  });

  it('keeps one row per path of a snapshot', async () => {
    const one = await snapshot();
    const other = await snapshot();
    await t.db.insert(reviewSnapshotFiles).values(fileRow(one.id, 'x.ts', { text: '1' }));
    await expectPgError(
      t.db.insert(reviewSnapshotFiles).values(fileRow(one.id, 'x.ts', { text: '2' })),
      PG_UNIQUE_VIOLATION,
    );
    // The same path in another snapshot is another row.
    await t.db.insert(reviewSnapshotFiles).values(fileRow(other.id, 'x.ts', { text: '3' }));
  });

  it('an unknown omission reason or change is refused', async () => {
    const { id } = await snapshot();
    for (const reason of OMISSION_REASONS) {
      await t.db
        .insert(reviewSnapshotFiles)
        .values(fileRow(id, `omitted/${reason}`, { omitted: reason }));
    }
    for (const reason of ['path_too_long', 'too-large', 'BINARY', '']) {
      await expectCheckViolation(
        t.db.insert(reviewSnapshotFiles).values(fileRow(id, `bad/${reason}`, { omitted: reason })),
        'review_snapshot_files_omitted_check',
      );
    }
    for (const change of SNAPSHOT_CHANGES) {
      await t.db.insert(reviewSnapshotFiles).values(fileRow(id, `change/${change}`, { change }));
    }
    for (const change of ['copied', 'MODIFIED', 'deleted ', '']) {
      await expectCheckViolation(
        t.db
          .insert(reviewSnapshotFiles)
          .values(fileRow(id, `bad/${change}`, { change: change as never })),
        'review_snapshot_files_change_check',
      );
    }
    expect(SNAPSHOT_CHANGES).toEqual(['added', 'modified', 'renamed', 'deleted']);
  });

  it('a deleted file has no text', async () => {
    const { id } = await snapshot();
    await expectCheckViolation(
      t.db
        .insert(reviewSnapshotFiles)
        .values(fileRow(id, 'old.ts', { change: 'deleted', text: 'what it held' })),
      'review_snapshot_files_deleted_has_no_text',
    );
    // Its patch says what went; every other change keeps its text.
    await t.db
      .insert(reviewSnapshotFiles)
      .values(fileRow(id, 'old.ts', { change: 'deleted', patch: '@@ -1 +0,0 @@\n-old\n' }));
    for (const change of ['added', 'modified', 'renamed'] as const) {
      await t.db
        .insert(reviewSnapshotFiles)
        .values(fileRow(id, `${change}.ts`, { change, text: 'content' }));
    }
  });

  it('a file is its text or an omission, never both', async () => {
    const { id } = await snapshot();
    const either = 'review_snapshot_files_omitted_has_no_text';
    await expectCheckViolation(
      t.db
        .insert(reviewSnapshotFiles)
        .values(fileRow(id, 'a.bin', { text: 'x', omitted: 'binary' })),
      either,
    );
    // An empty file is still text.
    await expectCheckViolation(
      t.db.insert(reviewSnapshotFiles).values(fileRow(id, 'b.ts', { text: '', omitted: 'limit' })),
      either,
    );
    await t.db.insert(reviewSnapshotFiles).values(fileRow(id, 'c.ts', { text: '' }));
    await t.db.insert(reviewSnapshotFiles).values(fileRow(id, 'd.bin', { omitted: 'binary' }));
    // Known only by its change line.
    await t.db.insert(reviewSnapshotFiles).values(fileRow(id, 'e.ts', { change: 'modified' }));
  });

  it('deleting the analysis deletes the snapshot and its files', async () => {
    const mine = await snapshot();
    const other = await snapshot();
    await t.db
      .insert(reviewSnapshotFiles)
      .values([
        fileRow(mine.id, 'a.ts', { text: 'a' }),
        fileRow(mine.id, 'b.ts', { text: 'b' }),
        fileRow(other.id, 'a.ts', { text: 'a' }),
      ]);
    await t.db.delete(analyses).where(eq(analyses.id, mine.analysisId));
    expect(await survivors([mine.id, other.id])).toEqual([other.id]);
    expect(await pathsOf(mine.id)).toEqual([]);
    expect(await pathsOf(other.id)).toEqual(['a.ts']);
  });

  it('deleting the branch deletes its snapshots', async () => {
    const doomed = await newBranch('8');
    const linked = await snapshot({ branchId: doomed });
    const unlinked = await snapshot();
    const elsewhere = await snapshot({ branchId: mergeRequestId });
    await t.db.insert(reviewSnapshotFiles).values(fileRow(linked.id, 'a.ts', { text: 'a' }));
    await t.db.delete(branches).where(eq(branches.id, doomed));
    expect(await survivors([linked.id, unlinked.id, elsewhere.id])).toEqual(
      [unlinked.id, elsewhere.id].sort(),
    );
    expect(await pathsOf(linked.id)).toEqual([]);
    // The snapshot's own branch FK did it: the analysis was never on that branch and stays.
    const kept = await t.db.select().from(analyses).where(eq(analyses.id, linked.analysisId));
    expect(kept).toHaveLength(1);
  });

  it('deleting the project deletes its snapshots', async () => {
    const doomed = await newProject('snap/doomed');
    // The snapshot's own project FK, on its own: its analysis belongs to the surviving project.
    const row = await snapshot({ projectId: doomed });
    await t.db.delete(projects).where(eq(projects.id, doomed));
    expect(await survivors([row.id])).toEqual([]);
    const kept = await t.db.select().from(analyses).where(eq(analyses.id, row.analysisId));
    expect(kept).toHaveLength(1);
  });
});
