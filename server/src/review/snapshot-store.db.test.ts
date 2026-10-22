import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gzipSync } from 'node:zlib';
import {
  encodeSnapshotLine,
  MAX_SNAPSHOT_LINE_BYTES,
  OMISSION_REASONS,
  type OmissionReason,
  type SnapshotChangeLine,
  type SnapshotEndLine,
  type SnapshotHeaderLine,
  type SnapshotLine,
} from '@qualor/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { reportWith, uploadReport, gzipJson } from '../../test/reports';
import { bearer } from '../../test/app';
import { mergeRequestReport } from '../../test/scm';
import { PG_CHECK_VIOLATION, pgConstraint, pgErrorCode } from '../db/errors';
import { first } from '../db/rows';
import { analyses, branches, jobs, reviewSnapshotFiles, reviewSnapshots } from '../db/schema';
import { gateHandlers } from '../gates/reevaluate';
import { jobHandlers } from '../ingest/handlers';
import { ProblemError } from '../http/problem';
import { runUntilIdle } from '../queue/worker';
import { reviewSnapshotHandlers } from './jobs';
import {
  linkSnapshot,
  MAX_SNAPSHOT_ROWS,
  REVIEW_SNAPSHOT_QUEUE,
  storeSnapshotUpload,
  unpackSnapshot,
} from './snapshot-store';

const MiB = 1024 * 1024;
const LIMITS = { maxCompressedBytes: 50 * MiB, maxDecompressedBytes: 500 * MiB };
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SINCE = 'c'.repeat(64);

function headerLine(over: Partial<SnapshotHeaderLine> = {}): SnapshotHeaderLine {
  return {
    type: 'header',
    v: 1,
    headSha: HEAD,
    baseSha: BASE,
    sinceSha: null,
    targetBranch: 'main',
    mergeRequest: { id: '7', title: 'Parse the config', description: 'It parses it.' },
    partial: false,
    generator: 'qualor-cli/test',
    ...over,
  };
}
const fileLine = (path: string, text = `// ${path}\n`): SnapshotLine => ({
  type: 'file',
  path,
  text,
});
const changeLine = (path: string, over: Partial<SnapshotChangeLine> = {}): SnapshotLine => ({
  type: 'change',
  path,
  oldPath: null,
  status: 'modified',
  patch: null,
  since: null,
  ...over,
});
const omittedLine = (path: string, reason: OmissionReason = 'binary'): SnapshotLine => ({
  type: 'omitted',
  path,
  reason,
});
/** `n` file lines, `src/<prefix>000.ts` on. */
const manyFiles = (n: number, prefix = 'f'): SnapshotLine[] =>
  Array.from({ length: n }, (_, i) => fileLine(`src/${prefix}${String(i).padStart(3, '0')}.ts`));

/**
 * The text of a snapshot: the header, `lines`, then an end line counting them. `end` changes the
 * counts; `end: null` leaves the end line out.
 */
function snapshotText(
  lines: readonly SnapshotLine[],
  options: { header?: SnapshotHeaderLine; end?: Partial<SnapshotEndLine> | null } = {},
): string {
  const count = (type: SnapshotLine['type']) => lines.filter((l) => l.type === type).length;
  const end: SnapshotEndLine[] =
    options.end === null
      ? []
      : [
          {
            type: 'end',
            files: count('file'),
            changes: count('change'),
            omitted: count('omitted'),
            ...options.end,
          },
        ];
  return [options.header ?? headerLine(), ...lines, ...end].map(encodeSnapshotLine).join('');
}

/** Gzips `parts` as a stream, so a test never holds the inflated text in memory at once. */
async function gzipParts(parts: Iterable<string | Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(Readable.from(parts), createGzip(), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) out.push(chunk);
  });
  return Buffer.concat(out);
}

describe('review snapshots: store, unpack and link (6I-2, R2, R3)', () => {
  let h: IngestHarness;
  let p: IngestProject;

  const newAnalysis = async (): Promise<string> =>
    first(await h.ctx.db.insert(analyses).values({ projectId: p.id }).returning()).id;
  const store = async (body: Buffer, analysisId?: string) => {
    const id = analysisId ?? (await newAnalysis());
    const snapshotId = await storeSnapshotUpload(h.ctx.db, {
      analysisId: id,
      projectId: p.id,
      body,
      compressedBytes: body.length,
    });
    return { snapshotId, analysisId: id };
  };
  /** The snapshot row without its body, which says only whether it is there. */
  const snapshotRow = async (snapshotId: string) => {
    const [row] = await h.ctx.db
      .select({
        analysisId: reviewSnapshots.analysisId,
        projectId: reviewSnapshots.projectId,
        branchId: reviewSnapshots.branchId,
        status: reviewSnapshots.status,
        error: reviewSnapshots.error,
        hasBody: sql<boolean>`${reviewSnapshots.body} IS NOT NULL`,
        compressedBytes: reviewSnapshots.compressedBytes,
        inflatedBytes: reviewSnapshots.inflatedBytes,
        headSha: reviewSnapshots.headSha,
        baseSha: reviewSnapshots.baseSha,
        sinceSha: reviewSnapshots.sinceSha,
        targetBranch: reviewSnapshots.targetBranch,
        mrTitle: reviewSnapshots.mrTitle,
        mrDescription: reviewSnapshots.mrDescription,
        instructions: reviewSnapshots.instructions,
        partial: reviewSnapshots.partial,
        fileCount: reviewSnapshots.fileCount,
        unpacked: sql<boolean>`${reviewSnapshots.unpackedAt} IS NOT NULL`,
      })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.id, snapshotId));
    return row;
  };
  const fileRows = (snapshotId: string) =>
    h.ctx.db
      .select({
        path: reviewSnapshotFiles.path,
        text: reviewSnapshotFiles.text,
        bytes: reviewSnapshotFiles.bytes,
        omitted: reviewSnapshotFiles.omitted,
        change: reviewSnapshotFiles.change,
        oldPath: reviewSnapshotFiles.oldPath,
        patch: reviewSnapshotFiles.patch,
        since: reviewSnapshotFiles.since,
      })
      .from(reviewSnapshotFiles)
      .where(eq(reviewSnapshotFiles.snapshotId, snapshotId))
      .orderBy(asc(reviewSnapshotFiles.path));
  const unpacked = async (body: string | Buffer, limits = LIMITS) => {
    const { snapshotId, analysisId } = await store(
      typeof body === 'string' ? gzipSync(body) : body,
    );
    const outcome = await unpackSnapshot(h.ctx.db, snapshotId, limits);
    return { snapshotId, analysisId, outcome, row: await snapshotRow(snapshotId) };
  };
  /** Unpacking refuses the whole snapshot for `error`: nothing of it is kept but the reason. */
  const expectRejected = async (body: string | Buffer, error: string, limits = LIMITS) => {
    const { snapshotId, outcome, row } = await unpacked(body, limits);
    expect(outcome).toBe('rejected');
    expect(row).toMatchObject({ status: 'rejected', hasBody: false, fileCount: 0 });
    expect(row!.error).toBe(`SNAPSHOT_INVALID:${error}`);
    expect(await fileRows(snapshotId)).toEqual([]);
  };

  beforeAll(async () => {
    h = await createIngestHarness();
    p = await h.project('snap/p');
  });
  afterAll(async () => {
    await h.close();
  });

  describe('storeSnapshotUpload', () => {
    it('stores the upload as sent, with the project of its analysis, and queues its job', async () => {
      const body = gzipSync(snapshotText([]));
      const { snapshotId, analysisId } = await store(body);
      expect(await snapshotRow(snapshotId)).toMatchObject({
        analysisId,
        projectId: p.id,
        branchId: null,
        status: 'uploaded',
        hasBody: true,
        compressedBytes: body.length,
      });
      const [stored] = await h.ctx.db
        .select({ body: reviewSnapshots.body })
        .from(reviewSnapshots)
        .where(eq(reviewSnapshots.id, snapshotId));
      expect(stored!.body!.equals(body)).toBe(true);
      const queued = await h.ctx.db
        .select({ payload: jobs.payload, status: jobs.status, key: jobs.concurrencyKey })
        .from(jobs)
        .where(
          and(
            eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE),
            sql`${jobs.payload} ->> 'snapshotId' = ${snapshotId}`,
          ),
        );
      expect(queued).toEqual([
        { payload: { snapshotId }, status: 'queued', key: `review-snapshot:project:${p.id}` },
      ]);
    });

    it('refuses a second snapshot of one analysis with 409 SNAPSHOT_EXISTS, even racing', async () => {
      const body = gzipSync(snapshotText([]));
      const { analysisId } = await store(body);
      const again = await Promise.allSettled([store(body, analysisId), store(body, analysisId)]);
      for (const outcome of again) {
        expect(outcome.status).toBe('rejected');
        const reason = (outcome as PromiseRejectedResult).reason as ProblemError;
        expect(reason).toBeInstanceOf(ProblemError);
        expect([reason.status, reason.code]).toEqual([409, 'SNAPSHOT_EXISTS']);
      }
      const rows = await h.ctx.db
        .select({ id: reviewSnapshots.id })
        .from(reviewSnapshots)
        .where(eq(reviewSnapshots.analysisId, analysisId));
      expect(rows).toHaveLength(1);
    });

    it('stores nothing for an analysis of another project (Review Focus 4)', async () => {
      const other = await h.project('snap/other');
      const foreign = first(
        await h.ctx.db.insert(analyses).values({ projectId: other.id }).returning(),
      ).id;
      const attempt = storeSnapshotUpload(h.ctx.db, {
        analysisId: foreign,
        projectId: p.id,
        body: gzipSync('x'),
        compressedBytes: 20,
      });
      await expect(attempt).rejects.toMatchObject({ status: 404, code: 'ANALYSIS_NOT_FOUND' });
      expect(
        await h.ctx.db
          .select({ id: reviewSnapshots.id })
          .from(reviewSnapshots)
          .where(eq(reviewSnapshots.analysisId, foreign)),
      ).toEqual([]);
    });
  });

  describe('unpackSnapshot', () => {
    it('a valid snapshot is unpacked into one row per path', async () => {
      const text = snapshotText(
        [
          { type: 'instructions', name: 'REVIEW.md', text: 'Check the tests.\n' },
          { type: 'instructions', name: 'AGENTS.md', text: 'Be kind.\n' },
          changeLine('src/a.ts', { patch: '@@ -1 +1 @@\n-a\n+b\n', since: [[1, 1]] }),
          changeLine('src/new.ts', { status: 'added', patch: '@@ -0,0 +1 @@\n+new\n' }),
          changeLine('src/old.ts', { status: 'deleted' }),
          changeLine('src/moved.ts', { status: 'renamed', oldPath: 'src/was.ts' }),
          fileLine('src/a.ts', 'b\n'),
          fileLine('src/new.ts', 'new\n'),
          fileLine('src/moved.ts', 'moved\n'),
          fileLine('README.md', 'Grüße\n'),
          omittedLine('logo.png', 'binary'),
          omittedLine('.env', 'credentials'),
        ],
        {
          header: headerLine({
            sinceSha: SINCE,
            partial: true,
            mergeRequest: { id: '7', title: 'Parse the config', description: null },
          }),
        },
      );
      const { snapshotId, outcome, row } = await unpacked(text);
      expect(outcome).toBe('ready');
      expect(row).toEqual({
        analysisId: row!.analysisId,
        projectId: p.id,
        branchId: null,
        status: 'ready',
        error: null,
        hasBody: false,
        compressedBytes: row!.compressedBytes,
        inflatedBytes: Buffer.byteLength(text),
        headSha: HEAD,
        baseSha: BASE,
        sinceSha: SINCE,
        targetBranch: 'main',
        mrTitle: 'Parse the config',
        mrDescription: null,
        // In the order of INSTRUCTION_FILES, whatever the order they came in.
        instructions: [
          { name: 'AGENTS.md', text: 'Be kind.\n' },
          { name: 'REVIEW.md', text: 'Check the tests.\n' },
        ],
        partial: true,
        // The files with text, as the end line counts them.
        fileCount: 4,
        unpacked: true,
      });
      const none = { text: null, bytes: 0, omitted: null, change: null, oldPath: null };
      expect(await fileRows(snapshotId)).toEqual([
        { path: '.env', ...none, omitted: 'credentials', patch: null, since: null },
        { path: 'README.md', ...none, text: 'Grüße\n', bytes: 8, patch: null, since: null },
        { path: 'logo.png', ...none, omitted: 'binary', patch: null, since: null },
        {
          path: 'src/a.ts',
          ...none,
          text: 'b\n',
          bytes: 2,
          change: 'modified',
          patch: '@@ -1 +1 @@\n-a\n+b\n',
          since: [[1, 1]],
        },
        {
          path: 'src/moved.ts',
          ...none,
          text: 'moved\n',
          bytes: 6,
          change: 'renamed',
          oldPath: 'src/was.ts',
          patch: null,
          since: null,
        },
        {
          path: 'src/new.ts',
          ...none,
          text: 'new\n',
          bytes: 4,
          change: 'added',
          patch: '@@ -0,0 +1 @@\n+new\n',
          since: null,
        },
        { path: 'src/old.ts', ...none, change: 'deleted', patch: null, since: null },
      ]);
    });

    it('merges each change into its file across batches of rows', async () => {
      // 120 changes before 250 files, as the scanner writes them: the change of a path is
      // stored batches before its file line comes.
      const changes = Array.from({ length: 120 }, (_, i) =>
        changeLine(`src/f${String(i * 2).padStart(3, '0')}.ts`, { since: [[i + 1, i + 1]] }),
      );
      const text = snapshotText([...changes, ...manyFiles(250)]);
      const { snapshotId, outcome, row } = await unpacked(text);
      expect(outcome).toBe('ready');
      expect(row!.fileCount).toBe(250);
      const rows = await fileRows(snapshotId);
      expect(rows).toHaveLength(250);
      expect(rows.filter((r) => r.change === 'modified')).toHaveLength(120);
      expect(rows.find((r) => r.path === 'src/f238.ts')).toMatchObject({
        text: '// src/f238.ts\n',
        change: 'modified',
        since: [[120, 120]],
      });
      expect(rows.find((r) => r.path === 'src/f239.ts')).toMatchObject({ change: null });
    });

    it('stores every omission reason of the shared list, and the database refuses any other', async () => {
      const lines = OMISSION_REASONS.map((reason) => omittedLine(`omitted/${reason}`, reason));
      const { snapshotId, outcome } = await unpacked(snapshotText(lines));
      expect(outcome).toBe('ready');
      expect((await fileRows(snapshotId)).map((r) => r.omitted).sort()).toEqual(
        [...OMISSION_REASONS].sort(),
      );
      // The CHECK is the shared list: a reason it does not name is refused (ruling P3).
      const refused = await h.ctx.db
        .insert(reviewSnapshotFiles)
        .values({ snapshotId, path: 'too/long', omitted: 'path_too_long' })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect([pgErrorCode(refused), pgConstraint(refused)]).toEqual([
        PG_CHECK_VIOLATION,
        'review_snapshot_files_omitted_check',
      ]);
    });

    describe('a path traversal anywhere rejects the whole snapshot (Review Focus 1)', () => {
      it.each([
        [
          'a parent segment',
          [fileLine('../etc/passwd')],
          'path: invalid path (dot-segment) (line 2)',
        ],
        [
          'a parent segment after more than a batch of rows',
          [...manyFiles(150), fileLine('src/../../x.ts')],
          'path: invalid path (dot-segment) (line 152)',
        ],
        ['a leading slash', [omittedLine('/etc/shadow')], 'path: invalid path (absolute) (line 2)'],
        ['a backslash', [fileLine('src\\a.ts')], 'path: invalid path (backslash) (line 2)'],
        ['a NUL', [fileLine('src/a\u0000.ts')], 'path: invalid path (nul) (line 2)'],
        [
          'the old path of a rename',
          [changeLine('src/b.ts', { status: 'renamed', oldPath: '../b.ts' })],
          'oldPath: invalid path (dot-segment) (line 2)',
        ],
      ] as [string, SnapshotLine[], string][])('%s', async (_name, lines, error) => {
        await expectRejected(snapshotText(lines), error);
      });
    });

    describe('a duplicate path rejects it', () => {
      it.each([
        ['two files', [fileLine('src/a.ts'), fileLine('src/a.ts')], 'duplicate_path (line 3)'],
        [
          'two changes',
          [changeLine('src/a.ts'), changeLine('src/a.ts', { status: 'added' })],
          'duplicate_path (line 3)',
        ],
        ['two omissions', [omittedLine('a.png'), omittedLine('a.png')], 'duplicate_path (line 3)'],
        [
          'a file sent after a batch of rows again',
          [fileLine('src/f001.ts'), ...manyFiles(140, 'g'), fileLine('src/f001.ts')],
          'duplicate_path (line 143)',
        ],
        [
          'a file and an omission',
          [fileLine('src/a.ts'), omittedLine('src/a.ts')],
          'file_and_omitted (line 3)',
        ],
        [
          'an omission and a file',
          [omittedLine('src/a.ts'), fileLine('src/a.ts')],
          'file_and_omitted (line 3)',
        ],
        [
          'a deleted file with text',
          [changeLine('src/a.ts', { status: 'deleted' }), fileLine('src/a.ts')],
          'deleted_file_has_text (line 3)',
        ],
        [
          'a file then deleted',
          [fileLine('src/a.ts'), changeLine('src/a.ts', { status: 'deleted' })],
          'deleted_file_has_text (line 3)',
        ],
        [
          'two instruction files of one name',
          [
            { type: 'instructions', name: 'AGENTS.md', text: 'a' },
            { type: 'instructions', name: 'AGENTS.md', text: 'b' },
          ],
          'duplicate_instructions (line 3)',
        ],
      ] as [string, SnapshotLine[], string][])('%s', async (_name, lines, error) => {
        await expectRejected(snapshotText(lines), error);
      });
    });

    describe('a missing end line, or counts that differ, reject it', () => {
      const lines = [changeLine('src/a.ts'), fileLine('src/a.ts'), omittedLine('b.png')];
      it.each([
        ['no end line', snapshotText(lines, { end: null }), 'end_missing'],
        ['one file more counted', snapshotText(lines, { end: { files: 2 } }), 'end_counts_differ'],
        [
          'one change fewer counted',
          snapshotText(lines, { end: { changes: 0 } }),
          'end_counts_differ',
        ],
        [
          'one omission more counted',
          snapshotText(lines, { end: { omitted: 2 } }),
          'end_counts_differ',
        ],
        [
          'a line after the end line',
          snapshotText(lines) + encodeSnapshotLine(fileLine('late.ts')),
          'line_after_end (line 6)',
        ],
        [
          'no header first',
          [fileLine('src/a.ts'), headerLine()].map(encodeSnapshotLine).join(''),
          'header_missing (line 1)',
        ],
        [
          'a second header',
          snapshotText([headerLine({ targetBranch: 'other' })]),
          'header_repeated (line 2)',
        ],
        ['nothing at all', '', 'header_missing'],
        ['an empty line', snapshotText([]).replace('\n', '\n\n'), 'invalid_json (line 2)'],
      ])('%s', async (_name, text, error) => {
        await expectRejected(text, error);
      });

      it('reads the last line without its terminator', async () => {
        const text = snapshotText(lines);
        const { outcome } = await unpacked(text.slice(0, -1));
        expect(outcome).toBe('ready');
      });
    });

    describe('size limits (Review Focus 5)', () => {
      it('a line over 8 MiB rejects it without reading on', async () => {
        // A file line that never ends: 100 MiB of text after its opening. Reading on, the
        // unpacker would reach the 64 MiB inflated limit (too_large); it stops at the line limit.
        const MiB_OF_A = Buffer.alloc(MiB, 'a');
        const body = await gzipParts([
          encodeSnapshotLine(headerLine()),
          '{"type":"file","path":"big.txt","text":"',
          ...Array.from({ length: 100 }, () => MiB_OF_A),
        ]);
        await expectRejected(body, 'line_too_long (line 2)', {
          maxCompressedBytes: 50 * MiB,
          maxDecompressedBytes: 64 * MiB,
        });
      });

      it('reads a line of exactly 8 MiB, and refuses one byte more', async () => {
        const open = '{"type":"file","path":"big.txt","text":"';
        const close = '"}';
        const line = (bytes: number) =>
          `${open}${'a'.repeat(bytes - open.length - close.length)}${close}`;
        const header = encodeSnapshotLine(headerLine());
        // At the bound the line is read and parsed: its text is what is too long.
        await expectRejected(
          `${header}${line(MAX_SNAPSHOT_LINE_BYTES)}\n`,
          'text: too long (limit 1048576 bytes) (line 2)',
        );
        await expectRejected(
          `${header}${line(MAX_SNAPSHOT_LINE_BYTES + 1)}\n`,
          'line_too_long (line 2)',
        );
      });

      it('a snapshot inflating past the limit is rejected', async () => {
        const text = snapshotText(manyFiles(40));
        await expectRejected(text, 'too_large', {
          maxCompressedBytes: 50 * MiB,
          maxDecompressedBytes: Buffer.byteLength(text) - 1,
        });
        const { outcome } = await unpacked(text, {
          maxCompressedBytes: 50 * MiB,
          maxDecompressedBytes: Buffer.byteLength(text),
        });
        expect(outcome).toBe('ready');
      });

      it('a stored body over the compressed limit is rejected', async () => {
        const body = gzipSync(snapshotText([]));
        await expectRejected(body, 'too_large', {
          maxCompressedBytes: body.length - 1,
          maxDecompressedBytes: 500 * MiB,
        });
      });

      it(`refuses more than ${MAX_SNAPSHOT_ROWS} paths, and keeps none of them`, async () => {
        const lines = Array.from({ length: MAX_SNAPSHOT_ROWS + 1 }, (_, i) =>
          omittedLine(`o/${i}`, 'limit'),
        );
        await expectRejected(snapshotText(lines), `too_many_paths (line ${MAX_SNAPSHOT_ROWS + 2})`);
      }, 120_000);
    });

    describe('what is not a snapshot', () => {
      it.each([
        ['a body that is not gzip', Buffer.from('{"type":"header"}\n'), 'invalid_gzip'],
        ['a gzip cut short', gzipSync(snapshotText([])).subarray(0, 30), 'invalid_gzip'],
        [
          'text that is not UTF-8',
          gzipSync(
            Buffer.concat([
              Buffer.from(encodeSnapshotLine(headerLine())),
              Buffer.from([0xff, 0x0a]),
            ]),
          ),
          'invalid_utf8 (line 2)',
        ],
        [
          'a line that is not JSON',
          gzipSync(`${encodeSnapshotLine(headerLine())}{\n`),
          'invalid_json (line 2)',
        ],
        [
          'a header of another format version',
          gzipSync(snapshotText([]).replace('"v":1', '"v":2')),
          'unsupported_version (line 1)',
        ],
      ] as [string, Buffer, string][])('%s', async (_name, body, error) => {
        await expectRejected(body, error);
      });

      // A lone surrogate passes the line schema, but jsonb refuses the escape it is sent as: the
      // instructions are stored as jsonb, and the rows reach the database as a jsonb record set.
      it.each([
        [
          'an instructions text',
          [
            { type: 'instructions', name: 'AGENTS.md', text: 'broken \ud800 text' },
            fileLine('src/a.ts'),
          ],
        ],
        ['a file text', [fileLine('src/a.ts', 'broken \udc00 text')]],
      ] as [string, SnapshotLine[]][])(
        '%s the database cannot store rejects it; the job completes (hand-off e)',
        async (_name, lines) => {
          const text = snapshotText(lines);
          const { snapshotId } = await store(gzipSync(text));
          const logs: unknown[][] = [];
          const logger = {
            info: (...args: unknown[]) => void logs.push(args),
            warn: (...args: unknown[]) => void logs.push(args),
          };
          await runUntilIdle(
            h.ctx.db,
            reviewSnapshotHandlers({ db: h.ctx.db, logger, limits: LIMITS }),
            h.ctx.app.log,
          );
          const row = await snapshotRow(snapshotId);
          expect(row).toMatchObject({ status: 'rejected', hasBody: false });
          expect(row!.error).toMatch(/^SNAPSHOT_INVALID:store_failed \(22P02\)$/);
          expect(await fileRows(snapshotId)).toEqual([]);
          const [job] = await h.ctx.db
            .select({ status: jobs.status, attempts: jobs.attempts })
            .from(jobs)
            .where(sql`${jobs.payload} ->> 'snapshotId' = ${snapshotId}`);
          expect(job).toEqual({ status: 'succeeded', attempts: 1 });
          expect(logs).toContainEqual([
            { snapshotId, error: row!.error },
            'review snapshot rejected',
          ]);
        },
      );
    });

    it('is idempotent: a snapshot already unpacked or rejected stays as it is', async () => {
      const { snapshotId, row } = await unpacked(snapshotText([fileLine('src/a.ts')]));
      expect(await unpackSnapshot(h.ctx.db, snapshotId, LIMITS)).toBe('ready');
      expect(await snapshotRow(snapshotId)).toEqual(row);
      expect(await fileRows(snapshotId)).toHaveLength(1);
      const rejected = await unpacked(snapshotText([fileLine('../a.ts')]));
      expect(await unpackSnapshot(h.ctx.db, rejected.snapshotId, LIMITS)).toBe('rejected');
      expect(await snapshotRow(rejected.snapshotId)).toEqual(rejected.row);
    });

    it('answers gone for a snapshot no longer stored', async () => {
      const { snapshotId, analysisId } = await store(gzipSync(snapshotText([])));
      await h.ctx.db.delete(analyses).where(eq(analyses.id, analysisId));
      expect(await unpackSnapshot(h.ctx.db, snapshotId, LIMITS)).toBe('gone');
    });

    it('completes a job whose payload does not parse, without retrying it', async () => {
      const [job] = await h.ctx.db
        .insert(jobs)
        .values({ queue: REVIEW_SNAPSHOT_QUEUE, payload: { snapshotId: 'nope' } })
        .returning({ id: jobs.id });
      const warnings: unknown[] = [];
      await runUntilIdle(
        h.ctx.db,
        reviewSnapshotHandlers({
          db: h.ctx.db,
          logger: {
            info: () => undefined,
            warn: (...args: unknown[]) => void warnings.push(args[1]),
          },
          limits: LIMITS,
        }),
        h.ctx.app.log,
      );
      const [row] = await h.ctx.db
        .select({ status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, job!.id));
      expect(row).toEqual({ status: 'succeeded' });
      expect(warnings).toContain('malformed review snapshot job payload; completing without retry');
    });
  });

  describe('linkSnapshot', () => {
    let mr: number;
    /** A merge request of its own, so each test has its own branch. */
    const nextMergeRequest = () => {
      mr += 1;
      return mr;
    };
    const revision = (n: number) => String(n % 10).repeat(40);
    const report = (iid: number, n: number) =>
      mergeRequestReport(iid, revision(n), {
        projectKey: p.key,
        analysisDate: `2026-10-0${n}T10:00:00Z`,
      });
    const snapshotBody = () => gzipSync(snapshotText([fileLine('src/a.ts')]));
    /** Stores and unpacks the snapshot of `analysisId`, as its job does. */
    const unpackFor = async (analysisId: string) => {
      const { snapshotId } = await store(snapshotBody(), analysisId);
      expect(await unpackSnapshot(h.ctx.db, snapshotId, LIMITS)).toBe('ready');
      return snapshotId;
    };
    const branchOf = async (analysisId: string) =>
      first(
        await h.ctx.db
          .select({ id: analyses.branchId })
          .from(analyses)
          .where(eq(analyses.id, analysisId)),
      ).id!;
    /** The snapshots kept, each with the branch it is linked to. */
    const kept = async (snapshotIds: string[]) =>
      (
        await h.ctx.db
          .select({ id: reviewSnapshots.id, branchId: reviewSnapshots.branchId })
          .from(reviewSnapshots)
          .where(inArray(reviewSnapshots.id, snapshotIds))
      ).sort((a, b) => a.id.localeCompare(b.id));
    /** Uploads a report without processing it: the analysis stays queued. */
    const queuedAnalysis = (iid: number, n: number) =>
      uploadReport(h.ctx, bearer(p.token), p.key, gzipJson(report(iid, n)));
    /** The analysis worker's queues, as the harness runs them. */
    const runIngestion = () =>
      runUntilIdle(
        h.ctx.db,
        {
          ...jobHandlers({ db: h.ctx.db, upload: h.ctx.config.upload, logger: h.ctx.app.log }),
          ...gateHandlers({ db: h.ctx.db }),
        },
        h.ctx.app.log,
      );

    beforeAll(() => {
      mr = 100;
    });

    it('linking keeps only the newest snapshot of a merge request', async () => {
      const iid = nextMergeRequest();
      // The first analysis succeeds, then its snapshot is unpacked: it is linked by its job.
      const first1 = await p.ingestOk(report(iid, 1));
      const s1 = await unpackFor(first1);
      const branchId = await branchOf(first1);
      expect(await kept([s1])).toEqual([{ id: s1, branchId }]);
      // The second analysis's snapshot is unpacked while the analysis is still queued: the
      // ingestion links it, and deletes the older one.
      const second = await queuedAnalysis(iid, 2);
      const s2 = await unpackFor(second);
      expect(await kept([s1, s2])).toEqual(
        [
          { id: s1, branchId },
          { id: s2, branchId: null },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      await runIngestion();
      expect(await kept([s1, s2])).toEqual([{ id: s2, branchId }]);
      // Linking again changes nothing.
      await linkSnapshot(h.ctx.db, second);
      expect(await kept([s1, s2])).toEqual([{ id: s2, branchId }]);
    });

    it('a newer analysis replaces the snapshot even before its own is unpacked', async () => {
      const iid = nextMergeRequest();
      const a1 = await p.ingestOk(report(iid, 1));
      const s1 = await unpackFor(a1);
      const a2 = await p.ingestOk(report(iid, 2));
      // The copy of the older head goes with the newer analysis; the newer copy is linked when
      // its job has unpacked it.
      expect(await kept([s1])).toEqual([]);
      const s2 = await unpackFor(a2);
      expect(await kept([s2])).toEqual([{ id: s2, branchId: await branchOf(a2) }]);
    });

    it('an older snapshot unpacked after a newer analysis is not kept', async () => {
      const iid = nextMergeRequest();
      const a1 = await p.ingestOk(report(iid, 1));
      const a2 = await p.ingestOk(report(iid, 2));
      const s2 = await unpackFor(a2);
      // Unpacked, then deleted by its own link: its analysis is no longer the newest.
      const s1 = await unpackFor(a1);
      expect(await kept([s1, s2])).toEqual([{ id: s2, branchId: await branchOf(a2) }]);
    });

    it('a newer snapshot deletes an older one still waiting for its job', async () => {
      const iid = nextMergeRequest();
      const a1 = await p.ingestOk(report(iid, 1));
      const a2 = await p.ingestOk(report(iid, 2));
      const waiting = await store(snapshotBody(), a1);
      const s2 = await unpackFor(a2);
      expect(await unpackSnapshot(h.ctx.db, waiting.snapshotId, LIMITS)).toBe('gone');
      expect(await kept([waiting.snapshotId, s2])).toEqual([
        { id: s2, branchId: await branchOf(a2) },
      ]);
    });

    it('a snapshot of a branch analysis is never linked', async () => {
      // Unpacked after the analysis, and before it.
      const done = await p.ingestOk(
        reportWith({
          projectKey: p.key,
          branch: 'feature/linked',
          analysisDate: '2026-10-01T10:00:00Z',
        }),
      );
      const s1 = await unpackFor(done);
      const pending = await uploadReport(
        h.ctx,
        bearer(p.token),
        p.key,
        gzipJson(
          reportWith({
            projectKey: p.key,
            branch: 'feature/linked',
            analysisDate: '2026-10-02T10:00:00Z',
          }),
        ),
      );
      const s2 = await unpackFor(pending);
      await runIngestion();
      expect(await kept([s1, s2])).toEqual(
        [
          { id: s1, branchId: null },
          { id: s2, branchId: null },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      const [branch] = await h.ctx.db
        .select({ kind: branches.kind })
        .from(branches)
        .where(eq(branches.id, await branchOf(pending)));
      expect(branch).toEqual({ kind: 'branch' });
    });

    it('never links a snapshot that is not unpacked, nor one of a failed analysis', async () => {
      const iid = nextMergeRequest();
      const a1 = await queuedAnalysis(iid, 1);
      const uploaded = await store(snapshotBody(), a1);
      await runIngestion();
      // Ingested while the snapshot was still waiting for its job: linked once it is unpacked.
      expect(await kept([uploaded.snapshotId])).toEqual([
        { id: uploaded.snapshotId, branchId: null },
      ]);
      expect(await unpackSnapshot(h.ctx.db, uploaded.snapshotId, LIMITS)).toBe('ready');
      expect(await kept([uploaded.snapshotId])).toEqual([
        { id: uploaded.snapshotId, branchId: await branchOf(a1) },
      ]);
      const failed = first(
        await h.ctx.db.insert(analyses).values({ projectId: p.id, status: 'failed' }).returning(),
      ).id;
      const s = await unpackFor(failed);
      expect(await kept([s])).toEqual([{ id: s, branchId: null }]);
    });
  });
});
