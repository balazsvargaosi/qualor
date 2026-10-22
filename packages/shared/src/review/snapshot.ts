import { z } from 'zod';
import { CONTROL_CHARS } from '../markdown/code-span';

/*
 * The repository snapshot the scanner uploads for the AI review of a merge request (6I-2, ruling
 * R2): gzip'd JSON Lines, one JSON object per line. The CLI writes a `header`, the `instructions`
 * files, one `change` per changed path, one `file` per text file at the head commit, one `omitted`
 * per file it left out, and an `end` line with the counts. The server reads it line by line, so
 * nothing needs the whole snapshot in memory, and validates every line with these schemas.
 *
 * Every byte bound counts UTF-8 bytes and every character bound counts code points, the unit
 * `cutAtGrapheme` cuts to, so a value the CLI has cut to its bound is always accepted.
 */

/** The `Content-Type` of the upload; `Content-Encoding: gzip` is required with it. */
export const REVIEW_SNAPSHOT_CONTENT_TYPE = 'application/vnd.qualor.review-snapshot+jsonl';
/** The format version, the `v` of the header line. */
export const SNAPSHOT_VERSION = 1;

/** One file's text, in UTF-8 bytes (after the scanner has masked secrets). */
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
/** Files with text in one snapshot. */
export const MAX_SNAPSHOT_FILES = 50_000;
/**
 * Paths one snapshot names, its `file`, `change` and `omitted` lines together: the rows of
 * `review_snapshot_files` it unpacks into. The end line bounds the files with text, but neither
 * the changes nor the omissions, so the paths of the three together are bounded here.
 */
export const MAX_SNAPSHOT_ROWS = 2 * MAX_SNAPSHOT_FILES;
/** One change's patch, in UTF-8 bytes; a larger patch is not sent (it is `null`). */
export const MAX_SNAPSHOT_PATCH_BYTES = 256 * 1024;
/** One line of the snapshot, without its terminator, in UTF-8 bytes. */
export const MAX_SNAPSHOT_LINE_BYTES = 8 * 1024 * 1024;
/** A path, in UTF-8 bytes. */
export const MAX_SNAPSHOT_PATH_BYTES = 1_024;
/** One instructions file, in UTF-8 bytes; the CLI cuts a longer one at a line boundary. */
export const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
/** The merge request's title, in code points; the CLI cuts a longer one. */
export const MAX_MR_TITLE_CHARS = 255;
/** The merge request's description, in code points; the CLI cuts a longer one. */
export const MAX_MR_DESCRIPTION_CHARS = 12_000;

/**
 * The files read at the merge base and sent as `instructions` lines, so that the review follows
 * the target branch's rules and never the ones the merge request itself edits (spec C4).
 */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'REVIEW.md'] as const;
export type InstructionFile = (typeof INSTRUCTION_FILES)[number];

/**
 * Why a file of the head commit has no text in the snapshot. The list is the CHECK of
 * `review_snapshot_files.omitted` (migration 0015): keep the two identical. A path that fails
 * {@link snapshotPathProblem} is never sent, not even as an `omitted` line, so it is no reason.
 * - `binary`: a NUL byte, so not text; `not_utf8`: text that is not valid UTF-8;
 * - `too_large`: over {@link MAX_SNAPSHOT_FILE_BYTES}, counted after secrets were masked;
 * - `excluded`: matched the built-in or the project's `sources.exclude` globs;
 * - `credentials`: a credentials file, which is never sent;
 * - `symlink` and `submodule`: the tree entry is not a file;
 * - `limit`: left out to keep the snapshot within its limits (the header says `partial`).
 */
export const OMISSION_REASONS = [
  'binary',
  'too_large',
  'excluded',
  'credentials',
  'symlink',
  'submodule',
  'limit',
  'not_utf8',
] as const;
export type OmissionReason = (typeof OMISSION_REASONS)[number];

/**
 * What a change line says happened to a path since the merge base. The list is the CHECK of
 * `review_snapshot_files.change` (migration 0015), like `SNAPSHOT_CHANGES` of the server's schema.
 */
export const SNAPSHOT_CHANGES = ['added', 'modified', 'renamed', 'deleted'] as const;
export type SnapshotChange = (typeof SNAPSHOT_CHANGES)[number];

// The short header fields use the report's bounds for the same CI values (`scm.mergeRequest`).
const MR_ID_CHARS = 64;
const BRANCH_CHARS = 255;
const GENERATOR_CHARS = 128;

// ─── Paths ───────────────────────────────────────────────────────────────────

export type SnapshotPathProblem =
  | 'empty'
  | 'too-long'
  | 'nul'
  | 'control-char'
  | 'absolute'
  | 'backslash'
  | 'dot-segment'
  | 'double-slash';

const CONTROL = new RegExp(`[${CONTROL_CHARS}]`, 'u');

/**
 * Why `path` cannot be a snapshot path, or null when it can: a POSIX path relative to the
 * repository root, as `git ls-tree` prints it. It has no empty, `.` or `..` segment (so no leading
 * or trailing `/` and no `//`), no `\`, no NUL or other control character (the C0 and C1 controls,
 * line and paragraph separators and bidirectional controls of `CONTROL_CHARS`), and at most
 * {@link MAX_SNAPSHOT_PATH_BYTES} UTF-8 bytes. The reasons are short codes that are safe to log.
 */
export function snapshotPathProblem(path: string): SnapshotPathProblem | null {
  if (path.length === 0) return 'empty';
  // A UTF-16 unit is at least one byte: a longer string is too long, without scanning it.
  if (path.length > MAX_SNAPSHOT_PATH_BYTES) return 'too-long';
  if (path.includes('\u0000')) return 'nul';
  if (CONTROL.test(path)) return 'control-char';
  if (path.startsWith('/')) return 'absolute';
  if (path.includes('\\')) return 'backslash';
  for (const segment of path.split('/')) {
    if (segment === '') return 'double-slash';
    if (segment === '.' || segment === '..') return 'dot-segment';
  }
  if (Buffer.byteLength(path, 'utf8') > MAX_SNAPSHOT_PATH_BYTES) return 'too-long';
  return null;
}

const snapshotPath = z.string().superRefine((path, ctx) => {
  const problem = snapshotPathProblem(path);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: `invalid path (${problem})` });
});

// ─── Strings ─────────────────────────────────────────────────────────────────

// PostgreSQL `text` and `jsonb` cannot hold a NUL: it would fail the insert, not the format.
const noNul = (text: string) => !text.includes('\u0000');
const NUL_MESSAGE = { message: 'must not contain NUL' };

/** Text of at most `maxBytes` UTF-8 bytes (ruling P5), without NUL. */
function utf8Text(maxBytes: number) {
  return z
    .string()
    .refine(noNul, NUL_MESSAGE)
    .refine((text) => text.length <= maxBytes && Buffer.byteLength(text, 'utf8') <= maxBytes, {
      message: `too long (limit ${maxBytes} bytes)`,
    });
}

/**
 * Text of at most `maxChars` code points (ruling P5), without NUL. A code point is at most two
 * UTF-16 units, so a longer string is too long without counting it.
 */
function charText(maxChars: number) {
  return z
    .string()
    .refine(noNul, NUL_MESSAGE)
    .refine((text) => text.length <= 2 * maxChars && [...text].length <= maxChars, {
      message: `too long (limit ${maxChars} characters)`,
    });
}

/** A commit id, as the CHECKs of `review_snapshots` read it: 40 or 64 lowercase hex digits. */
const gitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

// ─── Line ranges ─────────────────────────────────────────────────────────────

const lineNumber = z.number().int().min(1);

/**
 * 1-based inclusive `[start, end]` line ranges (the report's `LineRange`), sorted and without
 * overlap: the next range starts after the end of the one before. Ranges that touch are allowed.
 */
const sinceRanges = z.array(z.tuple([lineNumber, lineNumber])).superRefine((ranges, ctx) => {
  let previousEnd = 0;
  ranges.forEach(([start, end], index) => {
    if (end < start) {
      ctx.addIssue({
        code: 'custom',
        message: 'a range must end at or after its start',
        path: [index],
      });
    } else if (index > 0 && start <= previousEnd) {
      ctx.addIssue({
        code: 'custom',
        message: 'ranges must be sorted and must not overlap',
        path: [index],
      });
    }
    previousEnd = Math.max(previousEnd, end);
  });
});

// ─── The lines ───────────────────────────────────────────────────────────────

/** The first line: what the snapshot is a snapshot of. */
export const snapshotHeaderSchema = z.strictObject({
  type: z.literal('header'),
  v: z.literal(SNAPSHOT_VERSION),
  /** The merge request's head commit, whose files the snapshot holds. */
  headSha: gitSha,
  /** The merge base with the target branch, whose version of the instructions files is sent. */
  baseSha: gitSha,
  /** The last reviewed commit that is an ancestor of the head; null when there is none (a rebase). */
  sinceSha: gitSha.nullable(),
  targetBranch: charText(BRANCH_CHARS).min(1),
  mergeRequest: z.strictObject({
    id: charText(MR_ID_CHARS).min(1),
    title: charText(MAX_MR_TITLE_CHARS).nullable(),
    description: charText(MAX_MR_DESCRIPTION_CHARS).nullable(),
  }),
  /** The scanner left files out to stay within the limits. */
  partial: z.boolean(),
  /** What wrote it, such as `qualor-cli/0.12.0`. */
  generator: charText(GENERATOR_CHARS).min(1),
});

/** A text file at the head commit, secrets masked. */
export const snapshotFileSchema = z.strictObject({
  type: z.literal('file'),
  path: snapshotPath,
  text: utf8Text(MAX_SNAPSHOT_FILE_BYTES),
});

/** What the merge request did to a path, merged into the path's row by the server. */
export const snapshotChangeSchema = z.strictObject({
  type: z.literal('change'),
  path: snapshotPath,
  /** The path before a rename; null for any other status. */
  oldPath: snapshotPath.nullable(),
  status: z.enum(SNAPSHOT_CHANGES),
  /** The unified diff against the merge base; null when it is over the bound. */
  patch: utf8Text(MAX_SNAPSHOT_PATCH_BYTES).nullable(),
  /** The line ranges changed since `sinceSha`; null when the header has no `sinceSha`. */
  since: sinceRanges.nullable(),
});

/** A file of the head commit that has no `file` line, and why. */
export const snapshotOmittedSchema = z.strictObject({
  type: z.literal('omitted'),
  path: snapshotPath,
  reason: z.enum(OMISSION_REASONS),
});

/** An instructions file as the merge base held it. */
export const snapshotInstructionsSchema = z.strictObject({
  type: z.literal('instructions'),
  name: z.enum(INSTRUCTION_FILES),
  text: utf8Text(MAX_INSTRUCTIONS_BYTES),
});

/** The last line, with the number of lines of each kind: a snapshot cut short has none. */
export const snapshotEndSchema = z.strictObject({
  type: z.literal('end'),
  files: z.number().int().min(0).max(MAX_SNAPSHOT_FILES),
  changes: z.number().int().min(0),
  omitted: z.number().int().min(0),
});

export const snapshotLineSchema = z.discriminatedUnion('type', [
  snapshotHeaderSchema,
  snapshotFileSchema,
  snapshotChangeSchema,
  snapshotOmittedSchema,
  snapshotInstructionsSchema,
  snapshotEndSchema,
]);

export type SnapshotHeaderLine = z.infer<typeof snapshotHeaderSchema>;
export type SnapshotFileLine = z.infer<typeof snapshotFileSchema>;
export type SnapshotChangeLine = z.infer<typeof snapshotChangeSchema>;
export type SnapshotOmittedLine = z.infer<typeof snapshotOmittedSchema>;
export type SnapshotInstructionsLine = z.infer<typeof snapshotInstructionsSchema>;
export type SnapshotEndLine = z.infer<typeof snapshotEndSchema>;
export type SnapshotLine = z.infer<typeof snapshotLineSchema>;

// ─── Encoding and parsing ────────────────────────────────────────────────────

/**
 * A line is refused for `reason`: `line_too_long`, `invalid_json`, `unknown_type` (not an object,
 * or no known `type`), `unsupported_version` (the header's `v`), `unknown field`, or
 * `<field path>: <what is wrong>`. A reason never holds the line's content, so it is safe to store
 * and to log.
 */
export class SnapshotFormatError extends Error {
  constructor(readonly reason: string) {
    super(`invalid review snapshot line (${reason})`);
    this.name = 'SnapshotFormatError';
  }
}

/**
 * `line` as JSON followed by `\n`. JSON escapes every newline inside a string, so the result is
 * exactly one line. It does not validate: the reader does, and a test may write a bad line.
 */
export function encodeSnapshotLine(line: SnapshotLine): string {
  return `${JSON.stringify(line)}\n`;
}

function reasonOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'unknown_type';
  const where = issue.path.map(String).join('.');
  // The message of an unknown key names it, and that is the sender's text: say it without.
  if (issue.code === 'unrecognized_keys') {
    return where === '' ? 'unknown field' : `${where}: unknown field`;
  }
  if (issue.code === 'invalid_union' || (where === '' && issue.code === 'invalid_type')) {
    return 'unknown_type';
  }
  if (where === 'v') return 'unsupported_version';
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}

/**
 * One line of a snapshot, without or with its terminator, checked against the schema of its
 * `type`. Throws {@link SnapshotFormatError}; the first line of a snapshot must be a header and
 * the last an end line, and paths must be unique: that is for the reader of the whole snapshot.
 */
export function parseSnapshotLine(text: string): SnapshotLine {
  // A UTF-16 unit is at least one byte: a longer string is too long, without counting its bytes.
  if (
    text.length > MAX_SNAPSHOT_LINE_BYTES ||
    Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_LINE_BYTES
  ) {
    throw new SnapshotFormatError('line_too_long');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SnapshotFormatError('invalid_json');
  }
  const parsed = snapshotLineSchema.safeParse(value);
  if (!parsed.success) throw new SnapshotFormatError(reasonOf(parsed.error));
  return parsed.data;
}
