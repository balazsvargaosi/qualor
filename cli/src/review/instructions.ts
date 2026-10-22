import {
  encodeSnapshotLine,
  INSTRUCTION_FILES,
  MAX_INSTRUCTIONS_BYTES,
  type InstructionFile,
} from '@qualor/shared';
import { gitText, type Git } from '../git/git';
import { parseLsTreeLong, readObjects } from '../git/objects';
import { maskSecrets, redactLongText } from './redact';

/*
 * The instructions files of the review snapshot (spec C4): AGENTS.md, CLAUDE.md and REVIEW.md of
 * the repository's root as the merge base has them, so the review follows the target branch's
 * rules and never the ones the merge request itself edits.
 */

/** A regular file's mode in a tree (`100644`, `100755`, the old `100664`). */
const REGULAR_FILE = /^100\d{3}$/;
/** An instructions file is cut to MAX_INSTRUCTIONS_BYTES; one beyond this is not read at all. */
const MAX_INSTRUCTIONS_READ = 16 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface InstructionsFile {
  name: InstructionFile;
  /** As the merge base holds it. */
  content: Buffer;
}

/** The instructions files of the repository's root at `base`: regular files, within the bound. */
export async function readInstructionFiles(git: Git, base: string): Promise<InstructionsFile[]> {
  const listed = parseLsTreeLong(
    await gitText(git, [
      'ls-tree',
      '-z',
      '--long',
      '--full-tree',
      base,
      '--',
      ...INSTRUCTION_FILES,
    ]),
  );
  const found = INSTRUCTION_FILES.flatMap((name) => {
    const entry = listed.find((e) => e.path === name);
    const readable =
      entry !== undefined &&
      entry.type === 'blob' &&
      REGULAR_FILE.test(entry.mode) &&
      (entry.size ?? Infinity) <= MAX_INSTRUCTIONS_READ;
    return readable ? [{ name, oid: entry.oid }] : [];
  });
  const files: InstructionsFile[] = [];
  await readObjects(
    git,
    found.map((f) => f.oid),
    (i, content) => {
      const name = found[i]?.name;
      if (name !== undefined && content !== null) files.push({ name, content });
      return true;
    },
  );
  return files;
}

/** `text` cut to at most `maxBytes` UTF-8 bytes: at a line's end, or a character's if none fits. */
export function cutAtLine(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const bytes = Buffer.from(text, 'utf8');
  const lf = bytes.lastIndexOf(0x0a, maxBytes - 1);
  if (lf !== -1) return bytes.subarray(0, lf + 1).toString('utf8');
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * An instructions file as sent, or null (a NUL, or not UTF-8): its secrets masked and the shared
 * redaction run over the whole text (at most MAX_INSTRUCTIONS_READ), so a secret or a key block
 * over the cut is seen whole; then cut at a line's end within the bound.
 */
function instructionsText(
  content: Buffer,
  secrets: readonly string[],
): { text: string; count: number } | null {
  if (content.includes(0)) return null;
  let text: string;
  try {
    text = UTF8.decode(content);
  } catch {
    return null;
  }
  const masked = maskSecrets(text, secrets);
  const redacted = redactLongText(masked.text);
  return {
    text: cutAtLine(redacted.text, MAX_INSTRUCTIONS_BYTES),
    count: masked.count + redacted.count,
  };
}

/** The `instructions` lines of `files`, in their order, and the replacements their masking made. */
export function instructionLines(
  files: readonly InstructionsFile[],
  secrets: readonly string[],
): { lines: string[]; redactions: number } {
  const lines: string[] = [];
  let redactions = 0;
  for (const f of files) {
    const sent = instructionsText(f.content, secrets);
    if (sent === null) continue;
    lines.push(encodeSnapshotLine({ type: 'instructions', name: f.name, text: sent.text }));
    redactions += sent.count;
  }
  return { lines, redactions };
}
