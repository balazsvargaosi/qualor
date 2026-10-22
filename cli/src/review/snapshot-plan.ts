import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  encodeSnapshotLine,
  MAX_SNAPSHOT_ROWS,
  type OmissionReason,
  type SnapshotHeaderLine,
  type SnapshotLine,
} from '@qualor/shared';

/*
 * The review snapshot within its limits (6I-2): which lines fit, and writing them.
 * The `file` lines are written to a plain lines file as the files are read, in the order of the
 * candidates; a plan sends a prefix of it, so the snapshot can be built again smaller without
 * reading or redacting anything twice.
 */

/** A path of the head commit, in the order the snapshot fills its budget. */
export interface Candidate {
  path: string;
  oid: string;
  /** A path of the merge request's changes: it always goes in, or the snapshot is too large. */
  changed: boolean;
  /** Why it has no text: known from the tree, or once it is read. */
  reason: OmissionReason | null;
  /** Its `file` line in the lines file, once it is read as text: bytes, masked secrets, lines. */
  line: { bytes: number; redactions: number; lines: number } | null;
  /** git has no such object (a partial clone): the path is left out. */
  missing: boolean;
}

/** What a snapshot holds besides the candidates' lines. */
export interface SnapshotParts {
  header: Omit<SnapshotHeaderLine, 'partial'>;
  /** Encoded `instructions` lines. */
  instructions: readonly string[];
  /** Encoded `change` lines, one per path. */
  changes: readonly Buffer[];
  candidates: readonly Candidate[];
  /** The `file` lines of the candidates read as text, in their order. */
  linesFile: string;
}

export interface Plan {
  partial: boolean;
  files: number;
  /** The bytes of the lines file sent: the `file` lines of the candidates that go in. */
  fileBytes: number;
  /** The secrets masked in the files sent. */
  redactions: number;
  omitted: { path: string; reason: OmissionReason }[];
}

export interface PlanLimits {
  /** Inflated bytes. */
  budget: number;
  maxFiles: number;
}

const omittedLine = (path: string, reason: OmissionReason): SnapshotLine => ({
  type: 'omitted',
  path,
  reason,
});
const endLine = (files: number, changes: number, omitted: number): SnapshotLine => ({
  type: 'end',
  files,
  changes,
  omitted,
});
const bytesOf = (line: SnapshotLine): number => Buffer.byteLength(encodeSnapshotLine(line));
const sum = (values: readonly number[]): number => values.reduce((n, v) => n + v, 0);

/**
 * The lines every snapshot of `parts` holds, at their longest: the header (`false` is longer than
 * `true`), the instructions, the changes, and the end line with counts no plan exceeds.
 */
function fixedBytes(parts: SnapshotParts): number {
  const n = parts.candidates.length;
  return (
    bytesOf({ ...parts.header, partial: false }) +
    sum(parts.instructions.map((l) => Buffer.byteLength(l))) +
    sum(parts.changes.map((l) => l.length)) +
    bytesOf(endLine(n, parts.changes.length, n))
  );
}

/** The changed candidates' lines, which always go in: null when they do not fit. */
function planChanged(parts: SnapshotParts, limits: PlanLimits): (Plan & { total: number }) | null {
  const plan: Plan & { total: number } = {
    partial: false,
    files: 0,
    fileBytes: 0,
    redactions: 0,
    omitted: [],
    total: fixedBytes(parts),
  };
  for (const c of parts.candidates) {
    if (!c.changed || c.missing) continue;
    if (c.line !== null) {
      plan.total += c.line.bytes;
      plan.files += 1;
      plan.fileBytes += c.line.bytes;
      plan.redactions += c.line.redactions;
    } else if (c.reason !== null) {
      plan.total += bytesOf(omittedLine(c.path, c.reason));
      plan.omitted.push({ path: c.path, reason: c.reason });
    } else {
      // Not read: reading stopped once the changed files alone were over the limits.
      return null;
    }
  }
  if (plan.total > limits.budget || plan.files > limits.maxFiles) return null;
  return plan;
}

/**
 * The lines that fit `limits`, or null when the changes and the changed files alone do
 * not, or name more than MAX_SNAPSHOT_ROWS paths. The other candidates follow in their order (by
 * nearness to the changes):
 * - each has one line, so at most MAX_SNAPSHOT_ROWS paths are named in all; the farthest beyond
 *   that, and beyond what the budget can hold of their `omitted` lines, are left out entirely;
 * - one left out without a reason of its own is `limit`, which every one read as text is too,
 *   once one did not fit (or was not read): the files sent are a prefix of the lines file.
 * The total counted is never below the snapshot's inflated size.
 */
export function planSnapshot(parts: SnapshotParts, limits: PlanLimits): Plan | null {
  const plan = planChanged(parts, limits);
  if (plan === null || parts.changes.length > MAX_SNAPSHOT_ROWS) return null;
  const rest = parts.candidates.filter((c) => !c.changed && !c.missing);
  // Every other candidate counts as an `omitted` line until its text is taken in its stead.
  const reserves = rest
    .slice(0, MAX_SNAPSHOT_ROWS - parts.changes.length)
    .map((c) => bytesOf(omittedLine(c.path, c.reason ?? 'limit')));
  let reserved = sum(reserves);
  while (reserves.length > 0 && plan.total + reserved > limits.budget) {
    reserved -= reserves.pop() ?? 0;
  }
  plan.partial = reserves.length < rest.length;
  plan.total += reserved;
  let open = true;
  reserves.forEach((reserve, i) => {
    const c = rest[i];
    if (c === undefined) return;
    if (c.reason !== null) {
      plan.omitted.push({ path: c.path, reason: c.reason });
      return;
    }
    const delta = c.line === null ? Infinity : c.line.bytes - reserve;
    if (
      open &&
      c.line !== null &&
      plan.total + delta <= limits.budget &&
      plan.files < limits.maxFiles
    ) {
      plan.total += delta;
      plan.files += 1;
      plan.fileBytes += c.line.bytes;
      plan.redactions += c.line.redactions;
      return;
    }
    open = false;
    plan.partial = true;
    plan.omitted.push({ path: c.path, reason: 'limit' });
  });
  return plan;
}

/** Omitted lines are written in batches of about this many characters. */
const BATCH_CHARS = 64 * 1024;

/**
 * Writes the snapshot of `plan`: `header`, `instructions`, `change`, `file`, `omitted`
 * and `end` lines, in that order, through gzip to `file` (created with mode 0600). Answers the
 * gzip's size and the inflated size.
 */
export async function writeSnapshot(
  file: string,
  parts: SnapshotParts,
  plan: Plan,
): Promise<{ size: number; inflated: number }> {
  let inflated = 0;
  const header: SnapshotHeaderLine = { ...parts.header, partial: plan.partial };
  async function* lines(): AsyncGenerator<Buffer> {
    yield Buffer.from(encodeSnapshotLine(header) + parts.instructions.join(''));
    yield* parts.changes;
    if (plan.fileBytes > 0) {
      const range = { start: 0, end: plan.fileBytes - 1 };
      yield* createReadStream(parts.linesFile, range) as AsyncIterable<Buffer>;
    }
    let batch = '';
    for (const o of plan.omitted) {
      batch += encodeSnapshotLine(omittedLine(o.path, o.reason));
      if (batch.length >= BATCH_CHARS) {
        yield Buffer.from(batch);
        batch = '';
      }
    }
    yield Buffer.from(
      batch + encodeSnapshotLine(endLine(plan.files, parts.changes.length, plan.omitted.length)),
    );
  }
  async function* counted(): AsyncGenerator<Buffer> {
    for await (const chunk of lines()) {
      inflated += chunk.length;
      yield chunk;
    }
  }
  await pipeline(Readable.from(counted()), createGzip(), createWriteStream(file, { mode: 0o600 }));
  return { size: statSync(file).size, inflated };
}
