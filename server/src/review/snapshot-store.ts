import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  INSTRUCTION_FILES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_LINE_BYTES,
  MAX_SNAPSHOT_ROWS,
  parseSnapshotLine,
  SnapshotFormatError,
  snapshotPathProblem,
  type InstructionFile,
  type SnapshotChangeLine,
  type SnapshotEndLine,
  type SnapshotFileLine,
  type SnapshotHeaderLine,
  type SnapshotInstructionsLine,
  type SnapshotLine,
  type SnapshotOmittedLine,
} from '@qualor/shared';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Db, Executor, Tx } from '../db/client';
import {
  isForeignKeyViolation,
  PG_UNIQUE_VIOLATION,
  pgConstraint,
  pgErrorCode,
} from '../db/errors';
import { first } from '../db/rows';
import {
  analyses,
  branches,
  jobs,
  reviewSnapshotFiles,
  reviewSnapshots,
  type BranchKind,
  type ReviewSnapshotStatus,
  type SnapshotChange,
  type SnapshotInstruction,
} from '../db/schema';
import { notFound, ProblemError } from '../http/problem';
import { isZlibError } from '../ingest/upload';
import { enqueue } from '../queue/queue';
import { readScmContext } from '../scm/context';
import { scheduleMergeRequestCheck } from './lifecycle';
import { wakeReviewRun } from './runs';

/*
 * The repository snapshot of a merge request (6I-2, rulings R2 and R3): the scanner uploads it as
 * gzip'd JSON Lines next to its report; the upload is kept as sent (`uploaded`) until a job of the
 * analysis worker unpacks it into one `review_snapshot_files` row per path (`ready`), or refuses it
 * whole (`rejected`, with the reason). The job waits for the analysis to be ingested first (6I-3,
 * R22: the analysis' merge request is known only then). A merge request keeps the snapshot of its
 * newest analysis only (`linkSnapshot`); housekeeping deletes the rest (housekeeping/run.ts). A
 * snapshot that is linked, or refused, wakes its analysis' review run (6I-3, R15), and one that is
 * linked has its merge request's state checked every hour from then on (lifecycle.ts, R16).
 */

/** The queue of the job that unpacks an upload (main.ts: the analysis worker runs it). */
export const REVIEW_SNAPSHOT_QUEUE = 'review-snapshot';

/** One unpack at a time per project: a burst of uploads never fills the analysis worker. */
const unpackKey = (projectId: string): string => `review-snapshot:project:${projectId}`;

/**
 * How long an unpack whose analysis is not ingested yet waits before it looks again: 15 seconds,
 * doubling with each wait (`deferrals` before this one), to 1 minute at most (the wait holds the
 * project's unpack key). The ingestion makes
 * the waiting job due at once (unpackDueNow), so this bounds only a wait that ends otherwise.
 */
export function unpackDeferralSeconds(deferrals: number): number {
  return Math.min(60, 15 * 2 ** Math.min(Math.max(deferrals, 0), 5));
}

/** The snapshot's limits: QUALOR_REVIEW_SNAPSHOT_MAX_* (`config.reviewSnapshot`). */
export interface SnapshotLimits {
  /** As sent (gzip'd). */
  maxCompressedBytes: number;
  /** Inflated. */
  maxDecompressedBytes: number;
}

/** Rows per INSERT, and the most one INSERT carries: the size of its lines as sent. */
const BATCH_ROWS = 100;
const BATCH_BYTES = 16 * 1024 * 1024;
/** The stored body is inflated from slices of this size, so it is never copied whole. */
const INFLATE_SLICE = 64 * 1024;
const NEWLINE = 0x0a;
/** A stored reason never holds a line's content; this only bounds the column. */
const MAX_ERROR_CHARS = 500;

/**
 * What unpacking did: `gone` when the snapshot is no longer stored (or went while unpacking);
 * `deferred` when its analysis is not ingested yet, so another job unpacks it later.
 */
export type UnpackOutcome = 'ready' | 'rejected' | 'gone' | 'deferred';

/** The branch an ingestion stores its analysis on: the review snapshot stage's `ctx.branch`. */
export interface IngestedBranch {
  id: string;
  kind: BranchKind;
}

export const snapshotExists = (): ProblemError =>
  new ProblemError(409, 'SNAPSHOT_EXISTS', 'The analysis already has a review snapshot');

const analysisNotFound = (): ProblemError => notFound('Analysis', 'ANALYSIS_NOT_FOUND');

// ─── The upload ──────────────────────────────────────────────────────────────

/** Whether the analysis has a snapshot (the upload route asks before it reads the body). */
export async function hasSnapshot(db: Executor, analysisId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reviewSnapshots.id })
    .from(reviewSnapshots)
    .where(eq(reviewSnapshots.analysisId, analysisId));
  return row !== undefined;
}

/**
 * Stores an upload as sent (`uploaded`) and queues the job that unpacks it, in one transaction.
 * The snapshot's project is its analysis's (Review Focus 4): `projectId` (the uploader's project)
 * must be it, or the analysis is not found (404 ANALYSIS_NOT_FOUND). A second snapshot of the
 * analysis, two uploads racing included, is 409 SNAPSHOT_EXISTS. Answers the snapshot's id.
 */
export async function storeSnapshotUpload(
  db: Db,
  input: { analysisId: string; projectId: string; body: Buffer; compressedBytes: number },
): Promise<string> {
  try {
    return await db.transaction(async (tx) => {
      const [analysis] = await tx
        .select({ projectId: analyses.projectId })
        .from(analyses)
        .where(eq(analyses.id, input.analysisId));
      if (!analysis || analysis.projectId !== input.projectId) throw analysisNotFound();
      const { id } = first(
        await tx
          .insert(reviewSnapshots)
          .values({
            analysisId: input.analysisId,
            projectId: analysis.projectId,
            body: input.body,
            compressedBytes: input.compressedBytes,
          })
          .returning({ id: reviewSnapshots.id }),
      );
      await enqueue(tx, {
        queue: REVIEW_SNAPSHOT_QUEUE,
        payload: { snapshotId: id },
        concurrencyKey: unpackKey(analysis.projectId),
      });
      return id;
    });
  } catch (err) {
    const code = pgErrorCode(err);
    if (
      code === PG_UNIQUE_VIOLATION &&
      pgConstraint(err) === 'review_snapshots_analysis_id_unique'
    ) {
      throw snapshotExists();
    }
    // The analysis was deleted between the check and the insert.
    if (isForeignKeyViolation(code)) throw analysisNotFound();
    throw err;
  }
}

// ─── Unpacking ───────────────────────────────────────────────────────────────

/** The snapshot is refused for `reason` (safe to store and to log: never a line's content). */
class Rejection extends Error {
  constructor(reason: string, line?: number) {
    super(line === undefined ? reason : `${reason} (line ${line})`);
    this.name = 'Rejection';
  }
}

/** The snapshot left `uploaded` while unpacking (another run finished it), or is gone. */
class Stopped extends Error {
  constructor(readonly outcome: UnpackOutcome) {
    super(outcome);
    this.name = 'Stopped';
  }
}

/** One `review_snapshot_files` row: what the lines of one path say. */
interface FileRow {
  path: string;
  text: string | null;
  bytes: number;
  omitted: string | null;
  change: SnapshotChange | null;
  oldPath: string | null;
  patch: string | null;
  since: [number, number][] | null;
}

const emptyRow = (path: string): FileRow => ({
  path,
  text: null,
  bytes: 0,
  omitted: null,
  change: null,
  oldPath: null,
  patch: null,
  since: null,
});

/** Why a run stopped: the snapshot is gone, or another run left it `ready` or `rejected`. */
function stopped(status: ReviewSnapshotStatus | undefined): Stopped {
  return new Stopped(status === 'ready' || status === 'rejected' ? status : 'gone');
}

/**
 * Locks the snapshot row for the rest of `tx`, which goes on only while it is `uploaded`: a run
 * that finished it, a delete (housekeeping, a newer analysis of the merge request) and another
 * run's batch wait for `tx`, and this run stops once any of them has happened.
 */
async function lockUploaded(tx: Tx, snapshotId: string): Promise<void> {
  const [row] = await tx
    .select({ status: reviewSnapshots.status })
    .from(reviewSnapshots)
    .where(eq(reviewSnapshots.id, snapshotId))
    .for('update');
  if (row?.status !== 'uploaded') throw stopped(row?.status);
}

/**
 * Stores a batch of rows in one statement, which locks the snapshot row as {@link lockUploaded}
 * does and stores nothing unless it is still `uploaded` (this run then stops). A path's row comes
 * from up to two lines (its change, and its file or its omission), maybe batches apart: the second
 * merges into the row the first stored. Each column comes from one kind of line only, so a value
 * already stored is kept wherever the new line has none.
 */
async function storeRows(db: Db, snapshotId: string, rows: readonly FileRow[]): Promise<void> {
  const records = rows.map(({ oldPath, ...row }) => ({ ...row, old_path: oldPath }));
  const result = await db.execute(sql`
    WITH snapshot AS (
      SELECT id FROM review_snapshots
       WHERE id = ${snapshotId} AND status = 'uploaded'
         FOR UPDATE)
    INSERT INTO review_snapshot_files AS f
           (snapshot_id, path, text, bytes, omitted, change, old_path, patch, since)
    SELECT snapshot.id, r.path, r.text, r.bytes, r.omitted, r.change, r.old_path, r.patch, r.since
      FROM snapshot,
           jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS r(
             path text, text text, bytes integer, omitted text, change text, old_path text,
             patch text, since jsonb)
    ON CONFLICT (snapshot_id, path) DO UPDATE SET
      text = coalesce(excluded.text, f.text),
      bytes = CASE WHEN excluded.text IS NULL THEN f.bytes ELSE excluded.bytes END,
      omitted = coalesce(excluded.omitted, f.omitted),
      change = coalesce(excluded.change, f.change),
      old_path = coalesce(excluded.old_path, f.old_path),
      patch = coalesce(excluded.patch, f.patch),
      since = coalesce(excluded.since, f.since)`);
  if ((result.rowCount ?? 0) > 0) return;
  const [row] = await db
    .select({ status: reviewSnapshots.status })
    .from(reviewSnapshots)
    .where(eq(reviewSnapshots.id, snapshotId));
  throw stopped(row?.status);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Line `n` of the snapshot, without its terminator: UTF-8 JSON of a line schema. */
function parseLine(raw: Buffer, n: number): SnapshotLine {
  let text: string;
  try {
    text = UTF8.decode(raw);
  } catch {
    throw new Rejection('invalid_utf8', n);
  }
  try {
    return parseSnapshotLine(text);
  } catch (err) {
    if (err instanceof SnapshotFormatError) throw new Rejection(err.reason, n);
    throw err;
  }
}

function* slicesOf(body: Buffer): Generator<Buffer> {
  for (let at = 0; at < body.length; at += INFLATE_SLICE) {
    yield body.subarray(at, at + INFLATE_SLICE);
  }
}

/**
 * Inflates `body` as a stream and hands each line, without its terminator, to `onLine`, numbered
 * from 1 (what follows the last newline is the last line). A line over MAX_SNAPSHOT_LINE_BYTES and
 * an inflated total over `maxInflated` are refused as soon as they are crossed, and nothing past
 * them is inflated (Review Focus 5): at most a line and a chunk are held. Answers the inflated
 * size.
 */
async function forEachLine(
  body: Buffer,
  maxInflated: number,
  onLine: (line: Buffer, n: number) => Promise<void>,
): Promise<number> {
  let inflated = 0;
  let lines = 0;
  /** The line being read: its pieces so far, and their size. */
  let parts: Buffer[] = [];
  let partBytes = 0;
  /** The line being read grows by `bytes`: refused as soon as it is over the bound. */
  const grow = (bytes: number): void => {
    partBytes += bytes;
    if (partBytes > MAX_SNAPSHOT_LINE_BYTES) throw new Rejection('line_too_long', lines + 1);
  };
  const take = async (chunk: Buffer): Promise<void> => {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      grow(newline - start);
      const line = Buffer.concat([...parts, chunk.subarray(start, newline)], partBytes);
      parts = [];
      partBytes = 0;
      lines += 1;
      await onLine(line, lines);
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    grow(chunk.length - start);
    if (start < chunk.length) parts.push(chunk.subarray(start));
  };
  // Read straight from the gunzip stream, not through pipeline(), which can answer an AbortError
  // for an error this loop threw (a refusal, a row the database refused) and so hide it.
  const source = Readable.from(slicesOf(body));
  const gunzip = createGunzip();
  source.pipe(gunzip);
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      inflated += chunk.length;
      if (inflated > maxInflated) throw new Rejection('too_large');
      await take(chunk);
    }
  } catch (err) {
    if (isZlibError(err)) throw new Rejection('invalid_gzip');
    throw err;
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (partBytes > 0) {
    lines += 1;
    await onLine(Buffer.concat(parts, partBytes), lines);
  }
  return inflated;
}

/**
 * Reads the lines of one snapshot in order and stores its rows in batches, each batch one
 * statement (storeRows). The rules over the whole snapshot are checked as each line comes, before
 * its row is stored, so a violation is a reason of its own and never a constraint of the database:
 * the header first and the end line last, each path at most once per kind, never a file and an
 * omission for one path, no text for a deleted path, and at most MAX_SNAPSHOT_FILES files and
 * MAX_SNAPSHOT_ROWS paths.
 */
class Unpacker {
  private header: SnapshotHeaderLine | null = null;
  private end: SnapshotEndLine | null = null;
  private readonly instructions: { name: InstructionFile; text: string }[] = [];
  /** Every path, and the paths of each kind of line. */
  private readonly paths = new Set<string>();
  private readonly withFile = new Set<string>();
  private readonly withOmission = new Set<string>();
  private readonly withChange = new Set<string>();
  private readonly deleted = new Set<string>();
  files = 0;
  private changes = 0;
  private omissions = 0;
  private batch = new Map<string, FileRow>();
  private batchBytes = 0;

  constructor(
    private readonly db: Db,
    private readonly snapshotId: string,
  ) {}

  async line(raw: Buffer, n: number): Promise<void> {
    const line = parseLine(raw, n);
    if (n === 1) {
      if (line.type !== 'header') throw new Rejection('header_missing', n);
      this.header = line;
      return;
    }
    if (this.end !== null) throw new Rejection('line_after_end', n);
    switch (line.type) {
      case 'header':
        throw new Rejection('header_repeated', n);
      case 'end':
        this.end = line;
        return;
      case 'instructions':
        return this.instruction(line, n);
      case 'file':
        return this.file(line, n, raw.length);
      case 'change':
        return this.change(line, n, raw.length);
      case 'omitted':
        return this.omitted(line, n, raw.length);
    }
  }

  /** The header and the end line are there, and the end line counts what came. */
  finish(): SnapshotHeaderLine {
    if (this.header === null) throw new Rejection('header_missing');
    const end = this.end;
    if (end === null) throw new Rejection('end_missing');
    if (
      end.files !== this.files ||
      end.changes !== this.changes ||
      end.omitted !== this.omissions
    ) {
      throw new Rejection('end_counts_differ');
    }
    return this.header;
  }

  /** The instruction files, in the order of INSTRUCTION_FILES. */
  instructionFiles(): SnapshotInstruction[] {
    const order = (name: InstructionFile) => INSTRUCTION_FILES.indexOf(name);
    return [...this.instructions].sort((a, b) => order(a.name) - order(b.name));
  }

  /** Stores the rows not stored yet. */
  async flush(): Promise<void> {
    if (this.batch.size === 0) return;
    const rows = [...this.batch.values()];
    this.batch = new Map();
    this.batchBytes = 0;
    await storeRows(this.db, this.snapshotId, rows);
  }

  private instruction(line: SnapshotInstructionsLine, n: number): void {
    if (this.instructions.some((i) => i.name === line.name)) {
      throw new Rejection('duplicate_instructions', n);
    }
    this.instructions.push({ name: line.name, text: line.text });
  }

  private async file(line: SnapshotFileLine, n: number, size: number): Promise<void> {
    if (this.files >= MAX_SNAPSHOT_FILES) throw new Rejection('too_many_files', n);
    this.claim(line.path, this.withFile, n);
    if (this.withOmission.has(line.path)) throw new Rejection('file_and_omitted', n);
    if (this.deleted.has(line.path)) throw new Rejection('deleted_file_has_text', n);
    this.files += 1;
    await this.add(line.path, size, (row) => {
      row.text = line.text;
      row.bytes = Buffer.byteLength(line.text, 'utf8');
    });
  }

  private async omitted(line: SnapshotOmittedLine, n: number, size: number): Promise<void> {
    this.claim(line.path, this.withOmission, n);
    if (this.withFile.has(line.path)) throw new Rejection('file_and_omitted', n);
    this.omissions += 1;
    await this.add(line.path, size, (row) => {
      row.omitted = line.reason;
    });
  }

  private async change(line: SnapshotChangeLine, n: number, size: number): Promise<void> {
    this.claim(line.path, this.withChange, n);
    if (line.oldPath !== null) this.checkPath(line.oldPath, 'oldPath', n);
    if (line.status === 'deleted') {
      if (this.withFile.has(line.path)) throw new Rejection('deleted_file_has_text', n);
      this.deleted.add(line.path);
    }
    this.changes += 1;
    await this.add(line.path, size, (row) => {
      row.change = line.status;
      row.oldPath = line.status === 'renamed' ? line.oldPath : null;
      row.patch = line.patch;
      row.since =
        line.since === null ? null : line.since.map(([from, to]): [number, number] => [from, to]);
    });
  }

  /**
   * The line schema applies the path rule already; it is applied again where the path is
   * stored, so no change to the schema can let a traversal through (Review Focus 1).
   */
  private checkPath(path: string, field: string, n: number): void {
    const problem = snapshotPathProblem(path);
    if (problem !== null) throw new Rejection(`${field}: invalid path (${problem})`, n);
  }

  /** Records `path` for one kind of line: once per kind, within MAX_SNAPSHOT_ROWS paths. */
  private claim(path: string, kind: Set<string>, n: number): void {
    this.checkPath(path, 'path', n);
    if (kind.has(path)) throw new Rejection('duplicate_path', n);
    if (!this.paths.has(path)) {
      if (this.paths.size >= MAX_SNAPSHOT_ROWS) throw new Rejection('too_many_paths', n);
      this.paths.add(path);
    }
    kind.add(path);
  }

  /** Merges a line of `size` bytes into its path's row of the batch; a full batch is stored. */
  private async add(path: string, size: number, apply: (row: FileRow) => void): Promise<void> {
    let row = this.batch.get(path);
    if (row === undefined) {
      row = emptyRow(path);
      this.batch.set(path, row);
    }
    apply(row);
    this.batchBytes += size;
    if (this.batch.size >= BATCH_ROWS || this.batchBytes >= BATCH_BYTES) await this.flush();
  }
}

/** Why unpacking failed, as stored after `SNAPSHOT_INVALID:`. */
function reasonOf(err: unknown): string {
  if (err instanceof Rejection) return err.message;
  // A row the database refuses (jsonb takes no lone surrogate, which the line schema lets through)
  // rejects the snapshot: the job never crashes on what the scanner sent.
  const code = pgErrorCode(err);
  return code === undefined ? 'unpack_failed' : `store_failed (${code})`;
}

/**
 * Reads the analysis row FOR SHARE, as linkSnapshot does, so that it stays as it is while the
 * transaction changes the analysis' snapshot. The analysis is ingested, or failed, by then
 * (unpackSnapshot waits for it): its review run is there to be woken, and its SCM context to be
 * read. Answers the analysis' stored SCM context, or undefined when the analysis is gone.
 */
async function analysisShared(
  tx: Tx,
  analysisId: string,
): Promise<{ scmContext: unknown } | undefined> {
  const [analysis] = await tx
    .select({ scmContext: analyses.scmContext })
    .from(analyses)
    .where(eq(analyses.id, analysisId))
    .for('share');
  return analysis;
}

/**
 * R22: why a snapshot cannot be of the analysis' merge request, or null. Its header must name the
 * merge request of the analysis' SCM context (the report's). The analysis is ingested, or failed,
 * by now (unpackSnapshot waits for it), so its context is what it will stay: a snapshot of another
 * merge request, or of a branch analysis (which has none), or of an analysis without a context
 * Qualor can read (one that failed before its report was read, say), is refused.
 */
function mergeRequestProblem(scmContext: unknown, header: SnapshotHeaderLine): string | null {
  const stored = readScmContext(scmContext);
  if (stored.kind === 'ok' && stored.context.mergeRequestId === header.mergeRequest.id) return null;
  return 'merge_request_mismatch';
}

/**
 * Refuses the snapshot: the rows stored so far are deleted, then it is `rejected` with its reason
 * and without its body, in one transaction, which wakes the analysis' review run (the run ends for
 * the refused snapshot rather than at its deadline). A snapshot no longer `uploaded` is left as it
 * is.
 */
async function reject(
  db: Db,
  snapshotId: string,
  analysisId: string,
  reason: string,
): Promise<UnpackOutcome> {
  return db.transaction(async (tx) => {
    await analysisShared(tx, analysisId);
    try {
      await lockUploaded(tx, snapshotId);
    } catch (err) {
      if (err instanceof Stopped) return err.outcome;
      throw err;
    }
    await tx.delete(reviewSnapshotFiles).where(eq(reviewSnapshotFiles.snapshotId, snapshotId));
    // Leaving `uploaded` drops the body in the same statement (the CHECK holds per statement).
    await tx
      .update(reviewSnapshots)
      .set({
        status: 'rejected',
        error: `SNAPSHOT_INVALID:${reason}`.slice(0, MAX_ERROR_CHARS),
        body: null,
      })
      .where(eq(reviewSnapshots.id, snapshotId));
    await wakeReviewRun(tx, analysisId);
    return 'rejected';
  });
}

/**
 * The snapshot is unpacked: `ready`, the header's fields and the counts, without the body. Its
 * header must name the analysis' merge request (R22), read as the analysis is committed: a snapshot
 * of another one is refused instead (`merge_request_mismatch`).
 */
async function markReady(
  db: Db,
  snapshotId: string,
  analysisId: string,
  unpacker: Unpacker,
  header: SnapshotHeaderLine,
  inflatedBytes: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const analysis = await analysisShared(tx, analysisId);
    await lockUploaded(tx, snapshotId);
    const problem = mergeRequestProblem(analysis?.scmContext ?? null, header);
    if (problem !== null) throw new Rejection(problem);
    await tx
      .update(reviewSnapshots)
      .set({
        status: 'ready',
        body: null,
        error: null,
        unpackedAt: sql`now()`,
        fileCount: unpacker.files,
        inflatedBytes,
        headSha: header.headSha,
        baseSha: header.baseSha,
        sinceSha: header.sinceSha,
        targetBranch: header.targetBranch,
        mrTitle: header.mergeRequest.title,
        mrDescription: header.mergeRequest.description,
        instructions: unpacker.instructionFiles(),
        partial: header.partial,
      })
      .where(eq(reviewSnapshots.id, snapshotId));
  });
}

async function unpackBody(
  db: Db,
  stored: { snapshotId: string; analysisId: string; body: Buffer | null },
  limits: SnapshotLimits,
): Promise<UnpackOutcome> {
  const { snapshotId, analysisId, body } = stored;
  const unpacker = new Unpacker(db, snapshotId);
  try {
    // The CHECK keeps a body on every `uploaded` snapshot; the limit may have been lowered since.
    if (body === null || body.length > limits.maxCompressedBytes) throw new Rejection('too_large');
    const inflated = await forEachLine(body, limits.maxDecompressedBytes, (line, n) =>
      unpacker.line(line, n),
    );
    const header = unpacker.finish();
    await unpacker.flush();
    await markReady(db, snapshotId, analysisId, unpacker, header, inflated);
    return 'ready';
  } catch (err) {
    if (err instanceof Stopped) return err.outcome;
    return reject(db, snapshotId, analysisId, reasonOf(err));
  }
}

/**
 * R22 is checked against the analysis' SCM context, which its ingestion stores: while the analysis
 * is `queued` or `processing`, the unpack waits. Another job of the queue is queued for later
 * (unpackDeferralSeconds), this one completes, and the outcome is `deferred`. The analysis is read
 * FOR SHARE, which waits for an ingestion in flight: either the job is queued before the ingestion
 * reads the analysis (its review stage then makes the job due at once, unpackDueNow), or this sees
 * the analysis as the ingestion committed it. The wait ends when the analysis is ingested or fails,
 * which `reconcileDeadAnalyses` bounds. Answers whether it waits.
 */
async function deferWhileIngesting(
  db: Db,
  snapshot: { id: string; analysisId: string; projectId: string },
  deferrals: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [analysis] = await tx
      .select({ status: analyses.status })
      .from(analyses)
      .where(eq(analyses.id, snapshot.analysisId))
      .for('share');
    if (analysis?.status !== 'queued' && analysis?.status !== 'processing') return false;
    await enqueue(tx, {
      queue: REVIEW_SNAPSHOT_QUEUE,
      payload: { snapshotId: snapshot.id, deferrals: deferrals + 1 },
      concurrencyKey: unpackKey(snapshot.projectId),
      runAt: sql`now() + make_interval(secs => ${unpackDeferralSeconds(deferrals)})`,
    });
    return true;
  });
}

/**
 * Unpacks an uploaded snapshot (the job of REVIEW_SNAPSHOT_QUEUE), then links it (linkSnapshot).
 * Before anything of it is read, it waits for its analysis to be ingested (deferWhileIngesting;
 * `deferrals`: how often it waited already). On any violation nothing of it is kept but the reason
 * (`rejected`, `SNAPSHOT_INVALID:<reason>`), a header that names another merge request than the
 * analysis' among them (R22). Idempotent: a snapshot already `ready` is only linked again, a
 * `rejected` one is left as it is.
 */
export async function unpackSnapshot(
  db: Db,
  snapshotId: string,
  limits: SnapshotLimits,
  o: { deferrals?: number } = {},
): Promise<UnpackOutcome> {
  const [stored] = await db
    .select({
      analysisId: reviewSnapshots.analysisId,
      projectId: reviewSnapshots.projectId,
      status: reviewSnapshots.status,
    })
    .from(reviewSnapshots)
    .where(eq(reviewSnapshots.id, snapshotId));
  if (!stored) return 'gone';
  if (stored.status === 'rejected') return 'rejected';
  let outcome: UnpackOutcome = 'ready';
  if (stored.status === 'uploaded') {
    if (await deferWhileIngesting(db, { id: snapshotId, ...stored }, o.deferrals ?? 0)) {
      return 'deferred';
    }
    const [upload] = await db
      .select({ body: reviewSnapshots.body })
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.id, snapshotId));
    if (!upload) return 'gone';
    outcome = await unpackBody(
      db,
      { snapshotId, analysisId: stored.analysisId, body: upload.body },
      limits,
    );
  }
  // Also for a snapshot already `ready`: a run may have stopped between unpacking and linking.
  if (outcome === 'ready') await linkSnapshot(db, stored.analysisId);
  return outcome;
}

/**
 * The analysis is being ingested (the review snapshot stage, in the ingestion's transaction): an
 * unpack of its snapshot that waits for it (deferWhileIngesting) is due now, not at its next look.
 */
export async function unpackDueNow(tx: Executor, analysisId: string): Promise<void> {
  await tx
    .update(jobs)
    .set({ runAt: sql`now()` })
    .where(
      and(
        eq(jobs.queue, REVIEW_SNAPSHOT_QUEUE),
        eq(jobs.status, 'queued'),
        sql`${jobs.payload} ->> 'snapshotId' = (SELECT ${reviewSnapshots.id}::text FROM ${reviewSnapshots} WHERE ${reviewSnapshots.analysisId} = ${analysisId})`,
      ),
    );
}

// ─── Linking ─────────────────────────────────────────────────────────────────

/**
 * The analysis is the newest of the merge request `branchId`: its snapshot, once unpacked, is
 * linked to the branch, and every other snapshot of the branch is deleted (linked to it, or of one
 * of its analyses): the copy of an older head is never used again. A snapshot that is linked
 * schedules the check of the merge request's state (one is queued per merge request), so that the
 * copy is deleted when the merge request is merged or closed (R16).
 */
async function keepOnly(db: Executor, analysisId: string, branchId: string): Promise<void> {
  const linked = await db
    .update(reviewSnapshots)
    .set({ branchId })
    .where(and(eq(reviewSnapshots.analysisId, analysisId), eq(reviewSnapshots.status, 'ready')))
    .returning({ id: reviewSnapshots.id });
  if (linked.length > 0) await scheduleMergeRequestCheck(db, branchId);
  await db
    .delete(reviewSnapshots)
    .where(
      and(
        ne(reviewSnapshots.analysisId, analysisId),
        or(
          eq(reviewSnapshots.branchId, branchId),
          inArray(
            reviewSnapshots.analysisId,
            db.select({ id: analyses.id }).from(analyses).where(eq(analyses.branchId, branchId)),
          ),
        ),
      ),
    );
}

/**
 * A merge request keeps the snapshot of its newest analysis only. When the analysis has succeeded
 * on a `merge_request` branch and is that branch's newest, its unpacked snapshot is linked to the
 * branch (`branch_id`) and the branch's other snapshots, of older analyses, are deleted; the
 * snapshot of an analysis that is no longer the newest is deleted itself. A branch analysis's is
 * never linked. Idempotent.
 *
 * `ingesting` is the review snapshot stage's: inside the ingestion transaction the analysis is not
 * `succeeded` yet, but becomes the branch's newest analysis when that transaction commits (an older
 * one fails as STALE_ANALYSIS before the stages), so the branch is the one ingestion stores it on.
 *
 * Without it (the unpack job), the analysis row is read FOR SHARE, which waits for an ingestion of
 * it still in flight: either that ingestion's stage has linked the snapshot, or the analysis is
 * read as it committed. The branch row is then locked, as ingestion locks it, so the links of one
 * merge request are made one at a time. A snapshot linked here wakes the analysis' review run
 * (R15): a snapshot is unpacked only once its analysis is ingested (unpackSnapshot), so the run is
 * there to be woken. Locks are taken in ingestion's order: analysis, branch, snapshots, the review
 * run.
 */
export async function linkSnapshot(
  db: Executor,
  analysisId: string,
  ingesting?: IngestedBranch,
): Promise<void> {
  if (ingesting !== undefined) {
    if (ingesting.kind === 'merge_request') await keepOnly(db, analysisId, ingesting.id);
    return;
  }
  await db.transaction(async (tx) => {
    const [analysis] = await tx
      .select({ status: analyses.status, branchId: analyses.branchId })
      .from(analyses)
      .where(eq(analyses.id, analysisId))
      .for('share');
    if (analysis?.status !== 'succeeded' || analysis.branchId === null) return;
    const [branch] = await tx
      .select({ kind: branches.kind, lastAnalysisId: branches.lastAnalysisId })
      .from(branches)
      .where(eq(branches.id, analysis.branchId))
      .for('update');
    if (branch?.kind !== 'merge_request') return;
    if (branch.lastAnalysisId === analysisId) {
      await keepOnly(tx, analysisId, analysis.branchId);
      await wakeReviewRun(tx, analysisId);
    } else {
      // A newer analysis of the merge request has succeeded since: this copy is of an older head.
      await tx.delete(reviewSnapshots).where(eq(reviewSnapshots.analysisId, analysisId));
    }
  });
}
