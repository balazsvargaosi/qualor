import {
  cutAtGrapheme,
  LONE_SURROGATE_SOURCE,
  REDACT_MAX_CHARS,
  REDACTED,
  redactText,
  snapshotPathProblem,
  type OmissionReason,
} from '@qualor/shared';
import { z } from 'zod';
import type { LlmToolCall, LlmToolSpec } from '../llm/providers/types';
import { excludedPathMatcher } from '../llm/settings';
import { MaskedFiles } from './masked-files';
import type { SnapshotReader } from './snapshot-reader';

/*
 * The three read-only tools the model reviews with, over the repository snapshot: `read_file`,
 * `grep` and `list_files`. What a model sends is untrusted: its arguments are checked against a
 * schema, its paths against the snapshot's path rule (so `..`, a leading `/`, a backslash or a NUL
 * is refused before anything is read), its search text is only ever compared as text, and its glob
 * is matched in JavaScript. What the tools answer passes the server's secret redaction (llm.md
 * §5.2) before it leaves, and never shows a path the administrator excluded (llm.md §3.2).
 *
 * The lines of a file are masked as part of the whole file, never a slice at a time (masked-files.ts),
 * and `grep` finds a needle in the masked lines only: the text it matches is the text the model
 * could read, so the number of hits cannot tell it what a mask hides.
 */

export const TOOL_LIMITS = {
  /** Lines of a file one `read_file` returns. */
  readLines: 400,
  /** Characters of a file (line ends counted) one `read_file` returns. */
  readChars: 40_000,
  /** Matching lines one `grep` returns. */
  grepHits: 50,
  /** Characters of a matching line `grep` shows. */
  grepLineChars: 200,
  grepNeedleMin: 2,
  grepNeedleMax: 200,
  /** Entries one `list_files` returns. */
  listEntries: 500,
  /** Tool calls, and of them searches, one review may make. */
  callsPerReview: 120,
  grepsPerReview: 40,
} as const;

/** The longest `path_glob`, as long as an `excludePaths` glob may be. */
const GLOB_MAX_CHARS = 200;
/**
 * The most hits, and entries, asked of the reader to make up a full answer when excluded paths
 * took a share of what it returned. Past it the answer says there is more.
 */
const MAX_FETCHED_HITS = 2_000;
const MAX_FETCHED_ENTRIES = 10_000;

export const REVIEW_TOOLS: readonly LlmToolSpec[] = [
  {
    name: 'read_file',
    description:
      "Read a file of the repository as the merge request's head commit has it, with numbered lines. " +
      `One call returns at most ${TOOL_LIMITS.readLines} lines or ${TOOL_LIMITS.readChars} characters: ` +
      'ask for the rest with from and to. A file the review cannot show (binary, too large, ' +
      'excluded) is answered with the reason.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The file, relative to the repository root, with / separators, such as src/app/main.ts.',
        },
        from: { type: 'integer', minimum: 1, description: 'The first line to read (1-based).' },
        to: { type: 'integer', minimum: 1, description: 'The last line to read, inclusive.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description:
      'Search the repository for a fixed piece of text: not a regular expression, case-sensitive, ' +
      `${TOOL_LIMITS.grepNeedleMin} to ${TOOL_LIMITS.grepNeedleMax} characters, within one line. ` +
      `Returns the matching lines as path:line: text, at most ${TOOL_LIMITS.grepHits}, in path order. ` +
      'Use path_glob to search only some paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: TOOL_LIMITS.grepNeedleMin,
          maxLength: TOOL_LIMITS.grepNeedleMax,
          description:
            'The text to find, taken literally: characters such as . * ( ) | \\ have no special meaning.',
        },
        path_glob: {
          type: 'string',
          maxLength: GLOB_MAX_CHARS,
          description:
            'Search only the paths that match: * matches within one path segment, ** across ' +
            'segments, ? one character; for example src/**/*.ts. Braces and character classes ' +
            'are not supported. Default: every file.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List what is directly in a directory of the repository: file names, and directory names ' +
      `ending in /, sorted, at most ${TOOL_LIMITS.listEntries} entries. Leave dir out for the repository root.`,
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description:
            'The directory, relative to the repository root, without a trailing /, such as src/app. Leave out for the root.',
        },
      },
      additionalProperties: false,
    },
  },
];

/**
 * What a review may still ask, and the paths it may not see. `budget` is counted down by every
 * call: the caller starts it at `callsPerReview` and `grepsPerReview` and shares it between all
 * the conversations of one review.
 */
export interface ToolPolicy {
  /** The administrator's `excludePaths` globs (llm.md §3.2). */
  excludePaths: readonly string[];
  budget: { calls: number; greps: number };
  /**
   * The masked files of the review (see `MaskedFiles`): made by the first call, for the reader it
   * is given, and kept in the policy, so that a file is masked once for all the calls that share it.
   */
  masked?: MaskedFiles;
}

interface ToolAnswer {
  /** What the model is told. */
  text: string;
  /** Secrets masked in it. */
  redactions: number;
}

const INVALID_PATH = 'invalid path';
const BUDGET_USED_UP = 'tool budget used up; answer now with what you have';
const NO_SUCH_FILE = "no such file in this merge request's snapshot";
const NO_SUCH_DIRECTORY = "no such directory in this merge request's snapshot";
const EXCLUDED = 'not available: excluded by the administrator';
const NO_MATCHES = 'no matches';
const MORE_MATCHES = '… more matches; narrow path_glob';
const MORE_ENTRIES = '… more entries; list a subdirectory to see them';

const OMISSIONS_IN_WORDS: Record<OmissionReason, string> = {
  binary: 'binary file',
  too_large: 'file too large',
  excluded: "excluded from the snapshot by the project's source excludes",
  credentials: 'credentials file, never sent',
  symlink: 'symbolic link',
  submodule: 'submodule',
  limit: 'left out to keep the snapshot within its size limits',
  not_utf8: 'not valid UTF-8 text',
};

// ─── Redaction ───────────────────────────────────────────────────────────────

/** An answer in the tool's own words, with nothing of the snapshot in it: no redaction. */
const fixed = (text: string): ToolAnswer => ({ text, redactions: 0 });

/**
 * The redaction of llm.md §5.2 for the names and paths of an answer, which belong to no file's
 * text: it masks a text of 64 KiB or more as a whole, so a longer answer goes through in pieces of
 * whole lines, each under that bound. A single line too long to scan is masked itself. The lines
 * stay as many as they were.
 */
function redactInPieces(text: string): { text: string; count: number } {
  if (text.length < REDACT_MAX_CHARS) return redactText(text);
  const lines: string[] = [];
  let count = 0;
  let piece: string[] = [];
  let size = 0;
  const flush = () => {
    if (piece.length === 0) return;
    const redacted = redactText(piece.join('\n'));
    lines.push(...redacted.text.split('\n'));
    count += redacted.count;
    piece = [];
    size = 0;
  };
  for (const line of text.split('\n')) {
    // The redaction counts a line and its line end against its bound.
    if (line.length + 1 > REDACT_MAX_CHARS) {
      flush();
      lines.push(REDACTED);
      count += 1;
      continue;
    }
    if (size + line.length + 1 > REDACT_MAX_CHARS) flush();
    piece.push(line);
    size += line.length + 1;
  }
  flush();
  return { text: lines.join('\n'), count };
}

/**
 * The answer with its names and paths redacted. `counted` are the replacements made when the files
 * it shows lines of were masked (see `MaskedFiles`), reported with the call that masked them.
 */
function redactedAnswer(text: string, counted = 0): ToolAnswer {
  const result = redactInPieces(text);
  return { text: result.text, redactions: counted + result.count };
}

// ─── Arguments ───────────────────────────────────────────────────────────────

const LONE_SURROGATE = new RegExp(LONE_SURROGATE_SOURCE);

/** Text of 2 to 200 characters (code points) on one line, that PostgreSQL can compare. */
function isSearchText(text: string): boolean {
  if (text.length > 2 * TOOL_LIMITS.grepNeedleMax) return false;
  const characters = Array.from(text).length;
  if (characters < TOOL_LIMITS.grepNeedleMin || characters > TOOL_LIMITS.grepNeedleMax) {
    return false;
  }
  return !/[\n\r]/.test(text) && !text.includes('\u0000') && !LONE_SURROGATE.test(text);
}

const lineNumber = z.number().int().min(1).nullish();

const readFileArguments = z
  .strictObject({ path: z.string(), from: lineNumber, to: lineNumber })
  .refine(({ from, to }) => typeof from !== 'number' || typeof to !== 'number' || to >= from, {
    path: ['to'],
    message: 'to is before from',
  });
const grepArguments = z.strictObject({
  pattern: z.string().refine(isSearchText, 'not 2 to 200 characters within one line'),
  path_glob: z.string().max(GLOB_MAX_CHARS).nullish(),
});
const listFilesArguments = z.strictObject({ dir: z.string().nullish() });

const ARGUMENT_HINTS: Record<string, string> = {
  path: 'a file path, as a string',
  from: 'a line number, a whole number from 1',
  to: 'a line number, a whole number from 1, not before from',
  pattern: `text of ${TOOL_LIMITS.grepNeedleMin} to ${TOOL_LIMITS.grepNeedleMax} characters within one line`,
  path_glob: `a glob of at most ${GLOB_MAX_CHARS} characters`,
  dir: 'a directory path, as a string',
};

/** `invalid arguments: <which>`: the names of the arguments that do not match, never their values. */
function invalidArguments(error: z.ZodError): ToolAnswer {
  const named: { name: string; hint: string | undefined }[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const name = key.slice(0, 40).replace(/[^\w-]/g, '?');
        named.push({ name, hint: 'not an argument of this tool' });
      }
    } else {
      const name = issue.path[0];
      const text = typeof name === 'string' ? name : '';
      named.push({ name: text, hint: ARGUMENT_HINTS[text] });
    }
  }
  const [only] = named;
  if (named.length === 1 && only !== undefined) {
    if (only.name === '') return fixed('invalid arguments: expected an object');
    return fixed(
      `invalid arguments: ${only.name}${only.hint === undefined ? '' : ` (${only.hint})`}`,
    );
  }
  const names = [...new Set(named.map((n) => n.name || 'expected an object'))];
  return fixed(`invalid arguments: ${names.join(', ')}`);
}

// ─── The tools ───────────────────────────────────────────────────────────────

/**
 * The first `want` results of `keep`, over the items of a reader that returns at most `limit` of
 * them. The reader does not know which of its items the administrator excluded, nor which hits are
 * masked away, and `keep` answers null for those. When items were dropped and the reader had more,
 * it is asked again for more, up to `maxFetch`, instead of letting the dropped items use up the
 * cap. The items after the `want`th result are not looked at.
 */
async function takeKept<T, U>(
  want: number,
  maxFetch: number,
  load: (limit: number) => Promise<{ items: T[]; truncated: boolean }>,
  keep: (item: T) => U | null | Promise<U | null>,
): Promise<{ items: U[]; truncated: boolean }> {
  let limit = want + 1;
  for (;;) {
    const page = await load(limit);
    const items: U[] = [];
    for (const item of page.items) {
      const kept = await keep(item);
      if (kept !== null) items.push(kept);
      if (items.length > want) return { items: items.slice(0, want), truncated: true };
    }
    if (!page.truncated) return { items, truncated: false };
    if (limit >= maxFetch) return { items, truncated: true };
    limit = Math.min(limit * 4, maxFetch);
  }
}

const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** A line of a file as `read_file` shows it: without its carriage return, never over the cap. */
function shownLine(line: string): string {
  const text = withoutCr(line);
  return text.length > TOOL_LIMITS.readChars ? cutAtGrapheme(text, TOOL_LIMITS.readChars) : text;
}

/**
 * Lines `from` to `to` (1-based, inclusive) of a file's masked `lines`, numbered, within the caps
 * of one call. The lines are the file's, masked as a whole: nothing is masked here.
 */
function numberedLines(lines: readonly string[], from: number, to: number | null): string {
  const total = lines.length;
  if (total === 0) return 'the file is empty';
  if (from > total) return `the file has ${total} lines; from is past its end`;
  const asked = Math.min(to ?? total, total);
  let last = Math.min(asked, from + TOOL_LIMITS.readLines - 1);
  let chars = 0;
  for (let n = from; n <= last; n += 1) {
    const size = (lines[n - 1] ?? '').length + 1;
    // At least the first line is shown (cut, if it is over the cap by itself).
    if (n > from && chars + size > TOOL_LIMITS.readChars) {
      last = n - 1;
      break;
    }
    chars += size;
  }
  const width = String(last).length;
  const numbered = lines
    .slice(from - 1, last)
    .map((line, index) => `${String(from + index).padStart(width)}│ ${shownLine(line)}`);
  if (last < asked) {
    numbered.push(`… lines ${from}–${last} of ${total}; ask for more with from/to`);
  }
  return numbered.join('\n');
}

async function readFile(
  masked: MaskedFiles,
  rawArguments: unknown,
  excluded: (path: string) => boolean,
): Promise<ToolAnswer> {
  const parsed = readFileArguments.safeParse(rawArguments ?? {});
  if (!parsed.success) return invalidArguments(parsed.error);
  const { path, from, to } = parsed.data;
  if (snapshotPathProblem(path) !== null) return fixed(INVALID_PATH);
  // Whether or not the snapshot holds the path: the answer says nothing about it.
  if (excluded(path)) return fixed(EXCLUDED);
  const file = await masked.file(path);
  switch (file.kind) {
    case 'absent':
      return fixed(NO_SUCH_FILE);
    case 'omitted':
      return fixed(`not available: ${OMISSIONS_IN_WORDS[file.reason]}`);
    case 'text':
      // Whatever the answer, the call that masked the file reports what was masked in it.
      return {
        text: numberedLines(file.lines, from ?? 1, to ?? null),
        redactions: file.redactions,
      };
  }
}

/**
 * The reader finds the lines that hold the needle in the text as the snapshot stores it. That text
 * only narrows the search: a hit is a line whose masked text holds the needle, and what is shown
 * of it is that masked line. So a needle that lies inside what a mask hides finds nothing, and
 * the hits cannot be counted to tell what the mask hides.
 */
async function grep(
  reader: SnapshotReader,
  masked: MaskedFiles,
  rawArguments: unknown,
  excluded: (path: string) => boolean,
  budget: ToolPolicy['budget'],
): Promise<ToolAnswer> {
  const parsed = grepArguments.safeParse(rawArguments ?? {});
  if (!parsed.success) return invalidArguments(parsed.error);
  const { pattern } = parsed.data;
  // An empty glob is no filter, as a missing one.
  const glob = parsed.data.path_glob === '' ? null : (parsed.data.path_glob ?? null);
  if (glob !== null && snapshotPathProblem(glob) !== null) return fixed(INVALID_PATH);
  if (budget.greps <= 0) return fixed(BUDGET_USED_UP);
  budget.greps -= 1;

  let counted = 0;
  const found = await takeKept(
    TOOL_LIMITS.grepHits,
    MAX_FETCHED_HITS,
    async (limit) => {
      const result = await reader.grep(pattern, glob, limit);
      return { items: result.hits, truncated: result.truncated };
    },
    async (hit) => {
      if (excluded(hit.path)) return null;
      const file = await masked.file(hit.path);
      if (file.kind !== 'text') return null;
      counted += file.redactions;
      const line = file.lines[hit.line - 1];
      if (line === undefined || !line.includes(pattern)) return null;
      // Twice what is shown: enough for the cut to land on the right character, and a minified
      // line of a megabyte is not taken apart for it.
      return {
        path: hit.path,
        line: hit.line,
        text: withoutCr(line).slice(0, 2 * TOOL_LIMITS.grepLineChars),
      };
    },
  );
  const lines = found.items.map(
    (hit) => `${hit.path}:${hit.line}: ${cutAtGrapheme(hit.text, TOOL_LIMITS.grepLineChars)}`,
  );
  if (found.truncated) lines.push(MORE_MATCHES);
  return redactedAnswer(lines.length === 0 ? NO_MATCHES : lines.join('\n'), counted);
}

async function listFiles(
  reader: SnapshotReader,
  rawArguments: unknown,
  excluded: (path: string) => boolean,
): Promise<ToolAnswer> {
  const parsed = listFilesArguments.safeParse(rawArguments ?? {});
  if (!parsed.success) return invalidArguments(parsed.error);
  // The root has no path of its own, so it is left out or empty.
  const dir = parsed.data.dir ?? '';
  if (dir !== '') {
    if (snapshotPathProblem(dir) !== null) return fixed(INVALID_PATH);
    if (excluded(dir)) return fixed(EXCLUDED);
  }
  const found = await takeKept(
    TOOL_LIMITS.listEntries,
    MAX_FETCHED_ENTRIES,
    async (limit) => {
      const result = await reader.list(dir, limit);
      return { items: result.entries, truncated: result.truncated };
    },
    (entry) => (excluded(dir === '' ? entry.name : `${dir}/${entry.name}`) ? null : entry),
  );
  if (found.items.length === 0 && !found.truncated) {
    return fixed(dir === '' ? 'the snapshot holds no files' : NO_SUCH_DIRECTORY);
  }
  const lines = found.items.map((entry) => (entry.kind === 'dir' ? `${entry.name}/` : entry.name));
  if (found.truncated) lines.push(MORE_ENTRIES);
  return redactedAnswer(lines.join('\n'));
}

/**
 * Runs one tool call of the model over the snapshot, and answers what to tell it: the answer is
 * always text, also for a call that cannot be run (a refusal is an answer the model can act on).
 * The call counts against the budget first; past it nothing runs and nothing is read. Throws only
 * when the reader does.
 */
export async function runReviewTool(
  reader: SnapshotReader,
  call: LlmToolCall,
  policy: ToolPolicy,
): Promise<ToolAnswer> {
  if (policy.budget.calls <= 0) return fixed(BUDGET_USED_UP);
  policy.budget.calls -= 1;
  const excluded = excludedPathMatcher(policy.excludePaths);
  // A cache serves one reader: the policy of a review keeps it from call to call.
  let masked = policy.masked;
  if (masked?.reader !== reader) {
    masked = new MaskedFiles(reader);
    policy.masked = masked;
  }
  switch (call.name) {
    case 'read_file':
      return readFile(masked, call.arguments, excluded);
    case 'grep':
      return grep(reader, masked, call.arguments, excluded, policy.budget);
    case 'list_files':
      return listFiles(reader, call.arguments, excluded);
    default:
      return fixed('unknown tool; use read_file, grep or list_files');
  }
}
