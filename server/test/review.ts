import { gzipSync } from 'node:zlib';
import {
  encodeSnapshotLine,
  hex32,
  type SnapshotEndLine,
  type SnapshotHeaderLine,
  type SnapshotLine,
} from '@qualor/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db, Executor } from '../src/db/client';
import { first } from '../src/db/rows';
import { analyses, branches, issues, reviewSnapshots, type AiCategory } from '../src/db/schema';
import { AI_RULES, ensureAiRules } from '../src/review/rules';
import {
  memorySnapshotReader,
  type SnapshotChange,
  type SnapshotFile,
  type SnapshotMeta,
  type SnapshotReader,
} from '../src/review/snapshot-reader';
import { storeSnapshotUpload, unpackSnapshot } from '../src/review/snapshot-store';

export interface AiIssueSeed {
  branchId: string;
  category: AiCategory;
  path: string;
  line: number;
  /** The rule's default severity unless given. */
  severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
  status?: 'open' | 'resolved' | 'wont_fix' | 'false_positive' | 'closed';
  snippet?: unknown;
}

let seedCounter = 0;

/**
 * Inserts one issue of engine `ai` on a branch, as a review run leaves it: the category's builtin
 * rule (created when missing), the rule's quality, in new code, no duplicate, `high` confidence.
 * The issue alone: no `review_findings` row and no run. Returns its id.
 */
export async function seedAiIssue(db: Executor, seed: AiIssueSeed): Promise<string> {
  seedCounter += 1;
  const branch = first(
    await db
      .select({ projectId: branches.projectId })
      .from(branches)
      .where(eq(branches.id, seed.branchId)),
  );
  const ruleId = (await ensureAiRules(db)).get(seed.category);
  const rule = AI_RULES.find((r) => r.category === seed.category);
  if (ruleId === undefined || rule === undefined) throw new Error(`no AI rule ${seed.category}`);
  const status = seed.status ?? 'open';
  const row = first(
    await db
      .insert(issues)
      .values({
        projectId: branch.projectId,
        branchId: seed.branchId,
        ruleId,
        fingerprint: hex32(`ai-fp:${seedCounter}`),
        lineHash: hex32(`ai-line:${seedCounter}`),
        contextHash: hex32(`ai-context:${seedCounter}`),
        path: seed.path,
        startLine: seed.line,
        endLine: seed.line,
        message: `AI finding ${seedCounter}`,
        severity: seed.severity ?? rule.defaultSeverity,
        quality: rule.quality,
        kind: 'issue',
        status,
        inNewCode: true,
        confidence: 'high',
        snippet: seed.snippet ?? null,
        firstSeenAt: sql`now()`,
        closedAt: status === 'closed' ? sql`now()` : null,
      })
      .returning({ id: issues.id }),
  );
  return row.id;
}

// ─── Repository snapshots ────────────────────────────────────────────────────

const TEST_HEAD_SHA = 'a'.repeat(40);
const TEST_BASE_SHA = 'b'.repeat(40);
const MiB = 1024 * 1024;

/**
 * Stores `lines` (what follows the header and precedes the end line) as the snapshot of
 * `analysisId` and unpacks it with the real unpacker: the snapshot comes back `ready`, as the
 * scanner's upload does after the job ran. The header is a fixed test one (head `aaaa…`, base
 * `bbbb…`, merge request `7`) unless `header` changes fields; the end line counts `lines`. A
 * snapshot the unpacker refuses throws with the reason it stored. Returns the snapshot's id.
 */
export async function storeTestSnapshot(
  db: Db,
  analysisId: string,
  lines: readonly SnapshotLine[],
  header: Partial<SnapshotHeaderLine> = {},
): Promise<string> {
  const analysis = first(
    await db
      .select({ projectId: analyses.projectId })
      .from(analyses)
      .where(eq(analyses.id, analysisId)),
  );
  const count = (type: SnapshotLine['type']) => lines.filter((line) => line.type === type).length;
  const head: SnapshotHeaderLine = {
    type: 'header',
    v: 1,
    headSha: TEST_HEAD_SHA,
    baseSha: TEST_BASE_SHA,
    sinceSha: null,
    targetBranch: 'main',
    mergeRequest: { id: '7', title: 'A change', description: 'It changes things.' },
    partial: false,
    generator: 'qualor-cli/test',
    ...header,
  };
  const end: SnapshotEndLine = {
    type: 'end',
    files: count('file'),
    changes: count('change'),
    omitted: count('omitted'),
  };
  const body = gzipSync([head, ...lines, end].map(encodeSnapshotLine).join(''));
  const snapshotId = await storeSnapshotUpload(db, {
    analysisId,
    projectId: analysis.projectId,
    body,
    compressedBytes: body.length,
  });
  const outcome = await unpackSnapshot(db, snapshotId, {
    maxCompressedBytes: 50 * MiB,
    maxDecompressedBytes: 500 * MiB,
  });
  if (outcome !== 'ready') {
    const stored = first(
      await db
        .select({ error: reviewSnapshots.error })
        .from(reviewSnapshots)
        .where(eq(reviewSnapshots.id, snapshotId)),
    );
    throw new Error(
      `the test snapshot did not unpack (${outcome}): ${stored.error ?? 'no reason'}`,
    );
  }
  return snapshotId;
}

export interface MemorySnapshotInput {
  /** The meta fields to set; the others read as a test default (see {@link storeTestSnapshot}). */
  meta?: Partial<SnapshotMeta>;
  /** A change needs its path; the rest reads as a modified file with no patch and no ranges. */
  changes?: readonly (Pick<SnapshotChange, 'path'> & Partial<SnapshotChange>)[];
  /** The files by path: a string is a text file, anything else is the file as the reader gives it. */
  files?: Readonly<Record<string, string | SnapshotFile>>;
}

/**
 * A snapshot reader in memory, from a short description. The same reader the evaluation set uses
 * (`memorySnapshotReader`), with the meta, the changes and the files filled in where a test leaves
 * them out.
 */
export function memorySnapshot(input: MemorySnapshotInput = {}): SnapshotReader {
  return memorySnapshotReader({
    meta: {
      snapshotId: null,
      headSha: TEST_HEAD_SHA,
      baseSha: TEST_BASE_SHA,
      sinceSha: null,
      targetBranch: 'main',
      mrTitle: null,
      mrDescription: null,
      instructions: [],
      partial: false,
      ...input.meta,
    },
    changes: (input.changes ?? []).map((change) => ({
      oldPath: null,
      status: 'modified',
      patch: null,
      since: null,
      ...change,
    })),
    files: Object.fromEntries(
      Object.entries(input.files ?? {}).map(([path, file]) => [
        path,
        typeof file === 'string' ? ({ kind: 'text', text: file } as const) : file,
      ]),
    ),
  });
}

/**
 * A text the shared redaction takes seconds to mask (about 9 s here): fifty lines of 4 000
 * characters that are nothing but the start of a JWT, over and over. For the tests of the time a
 * masking may take.
 */
export const HOSTILE_TEXT = Array.from({ length: 50 }, () => 'eyJ'.repeat(1_333)).join('\n');
