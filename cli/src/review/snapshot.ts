import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_EXCLUDES,
  encodeSnapshotLine,
  isCredentialsFile,
  MAX_MR_DESCRIPTION_CHARS,
  MAX_MR_TITLE_CHARS,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_LINE_BYTES,
  MAX_SNAPSHOT_PATH_BYTES,
  SNAPSHOT_VERSION,
  snapshotHeaderSchema,
  snapshotPathProblem,
  type LineRange,
  type OmissionReason,
  type QualorConfig,
  type SnapshotChange,
  type SnapshotHeaderLine,
} from '@qualor/shared';
import { globMatcher } from '../discovery/discover';
import { ensureCommit, mergeBaseBaseline, REVISION, type FetchPolicy } from '../git/baseline';
import { parseBinaryPaths, parseNameStatusZ, parseUnifiedDiff, type NameStatus } from '../git/diff';
import { gitText, type Git } from '../git/git';
import { parseLsTreeLong, readObjects, type TreeEntry } from '../git/objects';
import { VERSION } from '../index';
import type { Logger } from '../log';
import { Warnings } from '../warnings';
import { scanMergeBase, type BaseSecretScan, type MergeBaseScan } from './base-secrets';
import { instructionLines, readInstructionFiles, type InstructionsFile } from './instructions';
import { DIFF_OPTIONS, finishPatch, readRawPatches, type Patch } from './patches';
import { mergeRequestText, prepareSecrets, redactSnapshotText, secretLines } from './redact';
import { planSnapshot, writeSnapshot, type Candidate, type SnapshotParts } from './snapshot-plan';

/*
 * The repository snapshot of a merge request for the AI review (6I-2, rulings R2, R4, R12, R13,
 * C3, C4): gzip'd JSON Lines of the merge request's head commit, read from git objects (never the
 * working tree), its diff against the merge base, the lines changed since the last reviewed
 * commit, and the instructions files of the merge base. The snapshot leaves the CI machine with
 * the customer's code: credentials files and excluded files are never sent, and every text is
 * masked (./redact.ts), with the secrets the scan found and those the scan's secret engine finds
 * in the merge base's files (./base-secrets.ts).
 *
 * Paths are those of the scan's root, as the report's are: `git ls-tree` lists the root's part of
 * the tree, and every diff runs with `--relative`. They are kept exactly as git gives them.
 */

export interface SnapshotInput {
  git: Git;
  /** `sources.exclude`. */
  config: QualorConfig;
  headSha: string;
  targetBranch: string;
  /** The last reviewed commit, from the server. */
  sinceSha: string | null;
  mergeRequest: { id: string; title: string | null; description: string | null };
  /** The analyzers' secret texts and the token. */
  secrets: readonly string[];
  /**
   * The scan's secret engine over the merge base's files (`baseSecretScan`, ruling R13): what it
   * finds is masked too. Null when the scan runs none: then no patch sends a removed line.
   */
  baseSecrets: BaseSecretScan | null;
  /** The server's limits (`GET /projects/review-context`). */
  limits: {
    maxCompressedBytes: number;
    maxDecompressedBytes: number;
    maxFileBytes: number;
    maxFiles: number;
  };
  policy: FetchPolicy;
  log: Logger;
  /** Where the private directory of the snapshot is made (the system's temporary directory). */
  tempRoot?: string;
}

export type BuiltSnapshot =
  | {
      kind: 'built';
      file: string;
      /** Bytes, gzip'd. */
      size: number;
      /** `file` lines. */
      files: number;
      partial: boolean;
      /** Replacements made by the masking. */
      redactions: number;
      /** Removes the snapshot and its directory. */
      cleanup: () => Promise<void>;
    }
  | { kind: 'unavailable'; reason: 'head_missing' | 'no_merge_base' | 'too_large' };

type Unavailable = Extract<BuiltSnapshot, { kind: 'unavailable' }>;
const unavailable = (reason: Unavailable['reason']): Unavailable => ({
  kind: 'unavailable',
  reason,
});

const GENERATOR = `qualor-cli/${VERSION}`;
const SNAPSHOT_FILE = 'review-snapshot.jsonl.gz';
const LINES_FILE = 'files.jsonl';
/** A rebuilt snapshot aims at this share of the compressed limit. */
const REBUILD_SHARE = 0.9;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** What git's bytes that are not UTF-8 read as (the Git runner decodes its output as UTF-8). */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** The scan's log, with the merge base's warnings demoted: this snapshot reports what it lacks. */
function quiet(log: Logger): Logger {
  return {
    level: log.level,
    error: (m) => log.error(m),
    warn: (m) => log.debug(m),
    info: (m) => log.info(m),
    debug: (m) => log.debug(m),
  };
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * The paths the snapshot cannot send, not even as an omission: a path the format refuses, one git
 * gave in bytes that are not UTF-8 (they read as U+FFFD, and two of them could read the same), or
 * one that holds a secret. They are counted, never named, in one warning.
 */
class LeftOut {
  private readonly paths = new Set<string>();
  private secrets: readonly string[];

  constructor(secrets: readonly string[]) {
    this.secrets = secrets;
  }

  /** Secrets found later (in the merge base's files): a path holding one is left out too. */
  addSecrets(secrets: readonly string[]): void {
    this.secrets = [...this.secrets, ...secrets];
  }

  sendable(p: string): boolean {
    const ok =
      snapshotPathProblem(p) === null &&
      !p.includes(REPLACEMENT_CHARACTER) &&
      !this.secrets.some((s) => p.includes(s));
    if (!ok) this.paths.add(p);
    return ok;
  }

  warn(log: Logger): void {
    const n = this.paths.size;
    if (n === 0) return;
    const paths = n === 1 ? '1 path' : `${n} paths`;
    log.warn(
      `AI review: ${paths} left out of the repository snapshot, which cannot hold them safely: over ${MAX_SNAPSHOT_PATH_BYTES} bytes, with a character a snapshot path may not have, or holding a secret`,
    );
  }
}

function byPath(a: { path: string }, b: { path: string }): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

const dirOf = (p: string): string => {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? '' : p.slice(0, slash);
};

const parentOf = (dir: string): string | null => (dir === '' ? null : dirOf(dir));

/**
 * For every directory of `targets`, its distance to the nearest of `sources` in the tree of
 * directories: the segments of the one plus those of the other, less twice their common prefix.
 * A breadth-first walk from all the sources at once.
 */
function directoryDistances(
  targets: Iterable<string>,
  sources: Iterable<string>,
): Map<string, number> {
  /** Each directory's neighbours: its parent and its children. */
  const links = new Map<string, string[]>();
  /** Adds `dir` and its ancestors up to the first one known, each linked to the one below it. */
  const add = (dir: string): void => {
    let child: string | null = null;
    for (let d: string | null = dir; d !== null; d = parentOf(d)) {
      const known = links.get(d);
      if (known !== undefined) {
        if (child !== null) known.push(child);
        return;
      }
      const parent = parentOf(d);
      links.set(d, [...(parent === null ? [] : [parent]), ...(child === null ? [] : [child])]);
      child = d;
    }
  };
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const dir of sources) {
    add(dir);
    if (distance.has(dir)) continue;
    distance.set(dir, 0);
    queue.push(dir);
  }
  for (const dir of targets) add(dir);
  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i] ?? '';
    const next = (distance.get(dir) ?? 0) + 1;
    for (const near of links.get(dir) ?? []) {
      if (distance.has(near)) continue;
      distance.set(near, next);
      queue.push(near);
    }
  }
  return distance;
}

/**
 * The order the budget is filled in: the changed files first, by path; then the rest by the
 * directory distance of each to the nearest change (ties by path).
 */
function ordered(candidates: Candidate[], changes: readonly Change[]): Candidate[] {
  const changed = candidates.filter((c) => c.changed).sort(byPath);
  const rest = candidates.filter((c) => !c.changed);
  const sources = new Set(changes.flatMap((c) => [dirOf(c.path), dirOf(c.from)]));
  const distance = directoryDistances(new Set(rest.map((c) => dirOf(c.path))), sources);
  const far = Number.MAX_SAFE_INTEGER;
  const of = (c: Candidate) => distance.get(dirOf(c.path)) ?? far;
  rest.sort((a, b) => of(a) - of(b) || byPath(a, b));
  return [...changed, ...rest];
}

// ─── The changes and their patches ───────────────────────────────────────────

interface Change {
  path: string;
  /** The path before a rename, as sent: null for another status. */
  oldPath: string | null;
  status: SnapshotChange;
  /** The path git compared it with: a rename's or a copy's source, else the path itself. */
  from: string;
  /** Its patch may be sent: never one from a path that cannot be, which its header would name. */
  patchable: boolean;
}

const STATUSES: Record<string, SnapshotChange> = {
  A: 'added',
  C: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
};

/**
 * A pair of `git diff --name-status`, as sent: null when its path cannot be. A rename from a path
 * that cannot be sent is sent as `added` (the path did not exist at the merge base either way),
 * without its patch, whose `rename from` line would name that path.
 */
function changeOf(entry: NameStatus, left: LeftOut): Change | null {
  const status = STATUSES[entry.status];
  if (status === undefined || !left.sendable(entry.path)) return null;
  const from = entry.from ?? entry.path;
  const patchable = from === entry.path || left.sendable(from);
  if (status !== 'renamed') return { path: entry.path, oldPath: null, status, from, patchable };
  if (patchable) return { path: entry.path, oldPath: from, status, from, patchable };
  return { path: entry.path, oldPath: null, status: 'added', from, patchable };
}

/** What the merge request did, one change per path. */
async function readChanges(git: Git, base: string, head: string, left: LeftOut): Promise<Change[]> {
  const output = await gitText(git, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    '--relative',
    '--no-ext-diff',
    base,
    head,
    '--',
  ]);
  const seen = new Set<string>();
  const changes: Change[] = [];
  for (const entry of parseNameStatusZ(output)) {
    const change = changeOf(entry, left);
    if (change === null || seen.has(change.path)) continue;
    seen.add(change.path);
    changes.push(change);
  }
  return changes;
}

/** A change has an old side, the merge base's lines its patch removes: all but a plain add. */
const hasOldSide = (c: Change): boolean => c.status !== 'added' || c.from !== c.path;

/**
 * The changes and the candidates without a path that holds a secret found since they were read
 * (in the merge base's files): a rename or a copy from such a path loses its old path and patch.
 */
function stillSendable(
  changes: readonly Change[],
  candidates: readonly Candidate[],
  left: LeftOut,
): { changes: Change[]; candidates: Candidate[] } {
  const kept = changes
    .filter((c) => left.sendable(c.path))
    .map((c): Change => {
      if (c.from === c.path || left.sendable(c.from)) return c;
      return {
        ...c,
        status: c.status === 'renamed' ? 'added' : c.status,
        oldPath: null,
        patchable: false,
      };
    });
  return { changes: kept, candidates: candidates.filter((c) => left.sendable(c.path)) };
}

interface PathRules {
  excluded: (p: string) => boolean;
  maxFileBytes: number;
}

/** A credentials or excluded file is never sent, nor what its patch shows of it. */
const mayShow = (p: string, rules: PathRules): boolean =>
  !isCredentialsFile(p) && !rules.excluded(p);

/**
 * The patches as sent. A patch's removed lines are sent only when the scan of the merge base held
 * its old side; `secrets` holds the lines of the multi-line ones too (a patch shows them apart).
 */
function finishPatches(
  raw: ReadonlyMap<string, Buffer>,
  changes: readonly Change[],
  o: { secrets: readonly string[]; scanned: ReadonlySet<string> },
): Map<string, Patch> {
  const patches = new Map<string, Patch>();
  for (const c of changes) {
    const bytes = raw.get(c.path);
    if (bytes === undefined || !c.patchable) continue;
    const removedLinesScanned = !hasOldSide(c) || o.scanned.has(c.from);
    const patch = finishPatch(bytes, { secrets: o.secrets, removedLinesScanned });
    if (patch !== null) patches.set(c.path, patch);
  }
  return patches;
}

/** The lines changed since the last reviewed commit, when it is an ancestor of the head (R4). */
interface Since {
  sha: string;
  ranges: Map<string, LineRange[]>;
  /** Paths git shows as a binary change: their lines are unknown. */
  binary: Set<string>;
}

async function readSince(
  git: Git,
  sinceSha: string | null,
  head: string,
  log: Logger,
): Promise<Since | null> {
  if (sinceSha === null || !REVISION.test(sinceSha)) return null;
  if ((await git(['cat-file', '-e', `${sinceSha}^{commit}`])).code !== 0) {
    log.debug(`AI review: the last reviewed commit ${sinceSha} is not in the clone`);
    return null;
  }
  if ((await git(['merge-base', '--is-ancestor', sinceSha, head])).code !== 0) {
    log.debug(
      `AI review: the last reviewed commit ${sinceSha} is not an ancestor of the head (a rebase)`,
    );
    return null;
  }
  const r = await git([
    'diff',
    '-U0',
    '--inter-hunk-context=0',
    ...DIFF_OPTIONS,
    sinceSha,
    head,
    '--',
  ]);
  if (r.code !== 0) {
    log.debug(
      `AI review: the diff since the last reviewed commit could not be read: ${r.stderr.trim()}`,
    );
    return null;
  }
  return { sha: sinceSha, ranges: parseUnifiedDiff(r.stdout), binary: parseBinaryPaths(r.stdout) };
}

/**
 * A change's `since`: the ranges changed since the last review, `[]` for a path unchanged since;
 * every line of a text file whose change git shows as binary (its lines are unknown, not none).
 */
function sinceOf(
  change: Change,
  since: Since | null,
  text: Candidate['line'] | undefined,
): LineRange[] | null {
  if (since === null) return null;
  if (since.binary.has(change.path) && text !== undefined && text !== null && text.lines > 0) {
    return [[1, text.lines]];
  }
  return since.ranges.get(change.path) ?? [];
}

function changeLines(
  changes: readonly Change[],
  patches: Map<string, Patch>,
  since: Since | null,
  candidates: readonly Candidate[],
): Buffer[] {
  const text = new Map(candidates.map((c) => [c.path, c.line]));
  return [...changes].sort(byPath).map((c) =>
    Buffer.from(
      encodeSnapshotLine({
        type: 'change',
        path: c.path,
        oldPath: c.oldPath,
        status: c.status,
        patch: patches.get(c.path)?.text ?? null,
        since: sinceOf(c, since, text.get(c.path)),
      }),
    ),
  );
}

// ─── The files ───────────────────────────────────────────────────────────────

interface FileRules extends PathRules {
  secrets: readonly string[];
}

/** Why a tree entry has no text, before it is read; null when it is to be read. */
function treeReason(entry: TreeEntry, rules: PathRules): OmissionReason | null {
  if (entry.mode === '120000') return 'symlink';
  if (entry.mode === '160000' || entry.type !== 'blob') return 'submodule';
  if (rules.excluded(entry.path)) return 'excluded';
  if (isCredentialsFile(entry.path)) return 'credentials';
  if (entry.size === null || entry.size > rules.maxFileBytes) return 'too_large';
  return null;
}

/**
 * The head commit's files that can be sent, as candidates (not yet ordered). A file renamed or
 * copied from a credentials file is one, whatever its new name: it holds what that held.
 */
async function readTree(
  git: Git,
  head: string,
  changes: readonly Change[],
  rules: PathRules,
  left: LeftOut,
): Promise<Candidate[]> {
  const changed = new Set(changes.filter((c) => c.status !== 'deleted').map((c) => c.path));
  const fromCredentials = new Set(
    changes.filter((c) => c.from !== c.path && isCredentialsFile(c.from)).map((c) => c.path),
  );
  const entries = parseLsTreeLong(await gitText(git, ['ls-tree', '-r', '-z', '--long', head]));
  return entries
    .filter((e) => left.sendable(e.path))
    .map((e) => ({
      path: e.path,
      oid: e.oid,
      changed: changed.has(e.path),
      reason: treeReason(e, rules) ?? (fromCredentials.has(e.path) ? 'credentials' : null),
      line: null,
      missing: false,
    }));
}

const lineCount = (text: string): number => {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
};

/** Writes all of `bytes` at the end of the open file `fd`. */
function append(fd: number, bytes: Buffer): void {
  for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at);
}

/**
 * A blob as the snapshot sends it, or why it does not: `binary` with a NUL anywhere (no
 * snapshot string may hold one), `not_utf8`, or `too_large` once its secrets are masked (the
 * masking can lengthen a text).
 * A text goes to the lines file, in the candidates' order.
 */
function takeBlob(c: Candidate, content: Buffer, rules: FileRules, fd: number): void {
  if (content.includes(0)) {
    c.reason = 'binary';
    return;
  }
  let text: string;
  try {
    text = UTF8.decode(content);
  } catch {
    c.reason = 'not_utf8';
    return;
  }
  const masked = redactSnapshotText(text, rules.secrets);
  if (Buffer.byteLength(masked.text, 'utf8') > rules.maxFileBytes) {
    c.reason = 'too_large';
    return;
  }
  const line = Buffer.from(encodeSnapshotLine({ type: 'file', path: c.path, text: masked.text }));
  // JSON at most sextuples a text (a control character takes six bytes): far below the line bound.
  if (line.length > MAX_SNAPSHOT_LINE_BYTES) {
    c.reason = 'too_large';
    return;
  }
  append(fd, line);
  c.line = { bytes: line.length, redactions: masked.count, lines: lineCount(masked.text) };
}

/**
 * The blobs, in the candidates' order, through one `git cat-file --batch`. Every changed
 * file is read (false when they alone are over the limits); the others until more text has been
 * read than any plan can send.
 */
async function readFiles(
  git: Git,
  candidates: readonly Candidate[],
  o: FileRules & { budget: number; maxFiles: number; fd: number },
): Promise<boolean> {
  const readable = candidates.filter((c) => c.reason === null);
  let bytes = 0;
  let files = 0;
  let fits = true;
  await readObjects(
    git,
    readable.map((c) => c.oid),
    (i, content) => {
      const c = readable[i];
      if (c === undefined) return false;
      if (content === null) c.missing = true;
      else takeBlob(c, content, o, o.fd);
      if (c.line !== null) {
        bytes += c.line.bytes;
        files += 1;
      }
      const within = bytes <= o.budget && files <= o.maxFiles;
      if (c.changed && !within) fits = false;
      return within;
    },
  );
  return fits;
}

// ─── The snapshot ────────────────────────────────────────────────────────────

type Header = Omit<SnapshotHeaderLine, 'partial'>;

function headerOf(
  input: SnapshotInput,
  base: string,
  since: Since | null,
  texts: { title: string | null; description: string | null },
): Header {
  return {
    type: 'header',
    v: SNAPSHOT_VERSION,
    headSha: input.headSha,
    baseSha: base,
    sinceSha: since?.sha ?? null,
    targetBranch: input.targetBranch,
    mergeRequest: { id: input.mergeRequest.id, ...texts },
    generator: GENERATOR,
  };
}

function checkedHeader(header: Header): Header {
  const parsed = snapshotHeaderSchema.safeParse({ ...header, partial: false });
  if (parsed.success) return header;
  const issue = parsed.error.issues[0];
  const where = issue?.path.map(String).join('.') ?? '';
  throw new Error(
    `AI review: the snapshot's header cannot be sent (${where}: ${issue?.message ?? 'invalid'})`,
  );
}

function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // best effort: a temporary directory
  }
}

/**
 * The lines that fit, written; a gzip over the compressed limit is built once
 * more, with an inflated budget of its own inflated size scaled to 90 % of the compressed limit.
 */
async function writeWithinLimits(
  file: string,
  parts: SnapshotParts,
  limits: SnapshotInput['limits'],
  redactions: number,
): Promise<BuiltSnapshot> {
  let budget = limits.maxDecompressedBytes;
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = planSnapshot(parts, { budget, maxFiles: limits.maxFiles });
    if (plan === null) return unavailable('too_large');
    const written = await writeSnapshot(file, parts, plan);
    if (written.size <= limits.maxCompressedBytes) {
      const dir = path.dirname(file);
      return {
        kind: 'built',
        file,
        size: written.size,
        files: plan.files,
        partial: plan.partial,
        redactions: redactions + plan.redactions,
        cleanup: () => {
          removeQuietly(dir);
          return Promise.resolve();
        },
      };
    }
    budget = Math.floor(
      (written.inflated * REBUILD_SHARE * limits.maxCompressedBytes) / written.size,
    );
  }
  return unavailable('too_large');
}

/** What the snapshot is made of, before any file is read. */
interface Sources {
  header: Header;
  rules: FileRules;
  limits: SnapshotInput['limits'];
  changes: Change[];
  candidates: Candidate[];
  patches: Map<string, Patch>;
  since: Since | null;
  instructions: string[];
  /** The masked secrets of the title, the description, the instructions and the patches. */
  redactions: number;
}

/** What `readSources` read from git, before anything is masked. */
interface Read {
  base: string;
  since: Since | null;
  limits: SnapshotInput['limits'];
  paths: PathRules;
  left: LeftOut;
  changes: Change[];
  tree: Candidate[];
  raw: Map<string, Buffer>;
  instructions: InstructionsFile[];
  scanned: MergeBaseScan;
}

/**
 * What the snapshot is made of, once the head and the merge base are known: too large when its
 * patches are. The merge base's files the snapshot shows parts of (the old side of each patch,
 * the instructions files) go to the scan's secret engine first (R13), so the secrets of the
 * merge base are masked with the scan's own, everywhere.
 */
async function readSources(input: SnapshotInput, base: string): Promise<Sources | 'too_large'> {
  const { git, headSha: head, log } = input;
  // The input's own fields of the header, before any work: an id or a branch it cannot hold.
  checkedHeader(headerOf(input, base, null, { title: null, description: null }));
  const since = await readSince(git, input.sinceSha, head, log);
  const limits = { ...input.limits, maxFiles: Math.min(input.limits.maxFiles, MAX_SNAPSHOT_FILES) };
  const paths: PathRules = {
    excluded: globMatcher([...BUILTIN_EXCLUDES, ...input.config.sources.exclude], true),
    maxFileBytes: Math.min(input.limits.maxFileBytes, MAX_SNAPSHOT_FILE_BYTES),
  };
  const left = new LeftOut(prepareSecrets(input.secrets));
  const changes = await readChanges(git, base, head, left);
  const tree = await readTree(git, head, changes, paths, left);
  const shown = changes.filter(
    (c) => c.patchable && mayShow(c.path, paths) && mayShow(c.from, paths),
  );
  const budget = limits.maxDecompressedBytes;
  const raw = await readRawPatches(git, { base, head }, shown, { budget, log });
  if (raw === 'too_large') return 'too_large';
  const instructions = await readInstructionFiles(git, base);
  const oldSides = [
    ...new Set(shown.filter((c) => raw.has(c.path) && hasOldSide(c)).map((c) => c.from)),
  ];
  const scanned = await scanMergeBase(
    git,
    base,
    { paths: oldSides, instructions },
    {
      scan: input.baseSecrets,
      budget,
      log,
      ...(input.tempRoot !== undefined && { tempRoot: input.tempRoot }),
    },
  );
  return maskedSources(input, {
    base,
    since,
    limits,
    paths,
    left,
    changes,
    tree,
    raw,
    instructions,
    scanned,
  });
}

/** The sources as sent: every text masked with the scan's secrets and the merge base's. */
function maskedSources(input: SnapshotInput, read: Read): Sources {
  const secrets = prepareSecrets([...input.secrets, ...read.scanned.secrets]);
  read.left.addSecrets(secrets);
  const { changes, candidates } = stillSendable(read.changes, read.tree, read.left);
  read.left.warn(input.log);
  const patches = finishPatches(read.raw, changes, {
    secrets: [...secrets, ...secretLines(secrets)],
    scanned: read.scanned.scanned,
  });
  const instructions = instructionLines(read.instructions, secrets);
  const title = mergeRequestText(input.mergeRequest.title, MAX_MR_TITLE_CHARS, secrets);
  const description = mergeRequestText(
    input.mergeRequest.description,
    MAX_MR_DESCRIPTION_CHARS,
    secrets,
  );
  const texts = { title: title.text, description: description.text };
  const patchRedactions = [...patches.values()].reduce((n, p) => n + p.redactions, 0);
  return {
    header: checkedHeader(headerOf(input, read.base, read.since, texts)),
    rules: { ...read.paths, secrets },
    limits: read.limits,
    changes,
    candidates: ordered(candidates, changes),
    patches,
    since: read.since,
    instructions: instructions.lines,
    redactions: title.count + description.count + instructions.redactions + patchRedactions,
  };
}

/** The files read, and the snapshot written, in its private directory `dir`. */
async function buildIn(
  dir: string,
  input: SnapshotInput,
  sources: Sources,
): Promise<BuiltSnapshot> {
  const linesFile = path.join(dir, LINES_FILE);
  const fd = openSync(linesFile, 'wx', 0o600);
  let fits: boolean;
  try {
    fits = await readFiles(input.git, sources.candidates, {
      ...sources.rules,
      budget: sources.limits.maxDecompressedBytes,
      maxFiles: sources.limits.maxFiles,
      fd,
    });
  } finally {
    closeSync(fd);
  }
  const missing = sources.candidates.filter((c) => c.missing).length;
  if (missing > 0) {
    input.log.warn(
      `AI review: ${missing} files are not in the clone's objects and were left out of the snapshot`,
    );
  }
  const parts: SnapshotParts = {
    header: sources.header,
    instructions: sources.instructions,
    changes: changeLines(sources.changes, sources.patches, sources.since, sources.candidates),
    candidates: sources.candidates,
    linesFile,
  };
  const file = path.join(dir, SNAPSHOT_FILE);
  const built = fits
    ? await writeWithinLimits(file, parts, sources.limits, sources.redactions)
    : unavailable('too_large');
  rmSync(linesFile, { force: true });
  return built;
}

/**
 * Builds the review snapshot of a merge request's head (6I-2) in a private temporary
 * directory, or says why it cannot: the head commit is not in the clone and cannot be fetched
 * (R12), it has no merge base with the target branch, or the changes alone are over the limits.
 * Throws on a failure of git or of the disk, and leaves nothing behind then.
 */
export async function buildReviewSnapshot(input: SnapshotInput): Promise<BuiltSnapshot> {
  const { git, headSha: head, log } = input;
  if (!(await ensureCommit(git, head, input.policy, log))) return unavailable('head_missing');
  const ctx = { log: quiet(log), warnings: new Warnings() };
  const baseline = await mergeBaseBaseline(git, input.targetBranch, input.policy, ctx, head);
  if (baseline.status !== 'ok' || baseline.revision === null) return unavailable('no_merge_base');
  const sources = await readSources(input, baseline.revision);
  if (sources === 'too_large') return unavailable('too_large');
  const dir = mkdtempSync(path.join(input.tempRoot ?? os.tmpdir(), 'qualor-review-'));
  try {
    const built = await buildIn(dir, input, sources);
    if (built.kind !== 'built') removeQuietly(dir);
    return built;
  } catch (err) {
    removeQuietly(dir);
    throw err;
  }
}
