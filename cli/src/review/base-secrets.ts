import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { QualorConfig } from '@qualor/shared';
import { fileLines, normalizeCaptures } from '../analyzers/normalize';
import { createWorkDir, releaseWorkDir, runAnalyzers } from '../analyzers/runner';
import type { Analyzer, AnalyzerCommand } from '../analyzers/types';
import { gitText, type Git } from '../git/git';
import { parseLsTreeLong, readObjects, type TreeEntry } from '../git/objects';
import type { Logger } from '../log';

/*
 * The secrets of the merge base (ruling R13). The analyzers scan the merge request's head, so a
 * secret the merge request removes is in no list the scan gives the snapshot; yet a patch shows
 * it, on its removed lines. The scan's own secret engine is run again, as the scan runs it, over a
 * directory holding the merge base's versions of what the snapshot sends of it.
 */

/**
 * The secrets in `dir`, a directory of files of the merge base (`paths`, relative to it): the
 * texts the scan's secret engine finds there, or null when it did not run there to the end (not
 * installed, failed, timed out) or its output could not be read.
 */
export type BaseSecretScan = (
  dir: string,
  paths: readonly string[],
) => Promise<readonly string[] | null>;

export interface BaseSecretScanOptions {
  /** The scan's analyzers: its secret engine is Gitleaks, when the scan runs it. */
  analyzers: readonly Analyzer[];
  /** The checkout, whose configuration the engine reads exactly as in the scan. */
  root: string;
  config: QualorConfig;
  /** The CLI's environment, as the scan's runner gets it. */
  env?: Readonly<Record<string, string | undefined>>;
  log: Logger;
  /** Where the runner makes its work directory (the system's temporary directory). */
  tempRoot?: string;
}

/** The engine whose findings are secrets the report redacts (its mapping's `redactRegion`). */
const SECRET_ENGINE = 'gitleaks';

/** `log` with every line at debug: what the snapshot lacks, it says itself, once. */
function debugOnly(log: Logger): Logger {
  return {
    level: log.level,
    error: (m) => log.debug(m),
    warn: (m) => log.debug(m),
    info: (m) => log.debug(m),
    debug: (m) => log.debug(m),
  };
}

/**
 * The engine's command pointed at `dir`: Gitleaks scans the directory its `dir` argument names
 * (the scan's is `.`, the checkout), while its working directory, against which it resolves its
 * configuration's `[extend] path` and reads `.gitleaksignore`, stays the checkout, as in the scan.
 * Null for a command of another shape, which is then not run at all.
 */
function pointedAt(run: AnalyzerCommand, dir: string): AnalyzerCommand | null {
  const at = run.args.findIndex((arg, i) => arg === 'dir' && run.args[i + 1] === '.');
  if (at === -1) return null;
  return { ...run, args: [...run.args.slice(0, at + 1), dir, ...run.args.slice(at + 2)] };
}

/**
 * The scan's secret engine for the merge base's files, or null when the scan runs none (Gitleaks
 * is not among its analyzers, or is disabled in qualor.yml). The engine is the scan's analyzer,
 * prepared against the checkout as the scan prepares it (so its configuration file, its extends,
 * `GITLEAKS_CONFIG` and `.gitleaksignore` are the scan's), and run by the analyzers' runner over
 * `dir` (`pointedAt`). Its secrets are collected as the report collects them (`normalizeCaptures`).
 */
export function baseSecretScan(o: BaseSecretScanOptions): BaseSecretScan | null {
  const engine = o.analyzers.find((a) => a.id === SECRET_ENGINE);
  if (engine === undefined || o.config.analyzers.gitleaks.enabled === false) return null;
  const log = debugOnly(o.log);
  return async (dir, paths) => {
    const inDir: Analyzer = {
      ...engine,
      prepare: async (ctx) => {
        const prep = await engine.prepare(ctx);
        if (!('run' in prep)) return prep;
        const run = pointedAt(prep.run, dir);
        return run === null ? { unavailable: 'cannot scan another directory' } : { run };
      },
    };
    const [capture] = await runAnalyzers([inDir], {
      root: o.root,
      config: o.config,
      files: [],
      log,
      concurrency: 1,
      ...(o.env !== undefined && { env: o.env }),
      ...(o.tempRoot !== undefined && { tempRoot: o.tempRoot }),
    });
    if (capture?.status !== 'ok') return null;
    const found: { texts: readonly string[] | null } = { texts: null };
    normalizeCaptures([capture], {
      repoRoot: dir,
      readLines: fileLines(dir),
      knownPaths: new Set(paths),
      log,
      onSecrets: (texts, unknown) => {
        found.texts = unknown ? null : texts;
      },
    });
    return found.texts;
  };
}

// ─── The merge base's files ──────────────────────────────────────────────────

/** A merge-base file larger than this is not scanned (its patch then sends no removed line). */
const MAX_BASE_FILE_BYTES = 16 * 1024 * 1024;
/** Where the instructions files go in the directory, apart from the changed files' paths. */
const INSTRUCTIONS_DIR = '.qualor-instructions';
/** On Windows, names a file system takes for a device, a stream or nothing like the name. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*]|[. ]$/;

/**
 * Whether the merge base's version of `p` can go into the scanned directory as itself: never a root
 * `.gitleaksignore` or `.gitleaks.*`, which Gitleaks would read as its own there; on Windows, never
 * a name the file system would turn into something else (a device, a stream).
 */
function placeable(p: string): boolean {
  if (p === '.gitleaksignore' || p.startsWith('.gitleaks.')) return false;
  if (process.platform !== 'win32') return true;
  return p.split('/').every((s) => !WINDOWS_RESERVED.test(s) && !WINDOWS_FORBIDDEN.test(s));
}

/**
 * Writes `content` to `rel` below `dir`, once per name a case-insensitive file system tells apart:
 * a second path that would land on the first is not written (it was not scanned, then).
 */
function writeBelow(dir: string, rel: string, content: Buffer, names: Set<string>): boolean {
  const name = rel.normalize('NFC').toLowerCase();
  if (names.has(name)) return false;
  try {
    const file = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }
  names.add(name);
  return true;
}

/** The blobs of `paths` at `base` (regular files and links, within the bounds), in `dir`. */
async function writeBaseFiles(
  git: Git,
  base: string,
  o: { dir: string; paths: readonly string[]; budget: number; names: Set<string> },
): Promise<Set<string>> {
  const wanted = new Set(o.paths.filter(placeable));
  const written = new Set<string>();
  if (wanted.size === 0) return written;
  const listed = parseLsTreeLong(await gitText(git, ['ls-tree', '-r', '-z', '--long', base]));
  let total = 0;
  const chosen = listed.filter((e: TreeEntry) => {
    if (!wanted.has(e.path) || e.type !== 'blob' || e.size === null) return false;
    if (e.size > MAX_BASE_FILE_BYTES || total + e.size > o.budget) return false;
    total += e.size;
    return true;
  });
  await readObjects(
    git,
    chosen.map((e) => e.oid),
    (i, content) => {
      const entry = chosen[i];
      if (
        entry !== undefined &&
        content !== null &&
        writeBelow(o.dir, entry.path, content, o.names)
      ) {
        written.add(entry.path);
      }
      return true;
    },
  );
  return written;
}

/** What the scan of the merge base gave: its secrets, and the paths whose old side it held. */
export interface MergeBaseScan {
  secrets: readonly string[];
  scanned: ReadonlySet<string>;
}

export interface MergeBaseFiles {
  /** The merge base's paths whose lines patches show (the old side of each patch sent). */
  paths: readonly string[];
  /** The instructions files the snapshot sends, as the merge base has them. */
  instructions: readonly { name: string; content: Buffer }[];
}

/**
 * Runs `scan` over the merge base's `files`, written to a private work directory removed on every
 * path (and by the analyzers' signal handler). With no secret engine (`scan` null), or one that
 * did not run to the end (or threw), nothing is found and no old side is held: the patches then
 * send no removed line, and the instructions files go with the shared patterns only.
 */
export async function scanMergeBase(
  git: Git,
  base: string,
  files: MergeBaseFiles,
  o: { scan: BaseSecretScan | null; budget: number; tempRoot?: string; log: Logger },
): Promise<MergeBaseScan> {
  const none: MergeBaseScan = { secrets: [], scanned: new Set() };
  if (files.paths.length === 0 && files.instructions.length === 0) return none;
  const cut = 'so the snapshot sends none of the lines the merge request removes';
  if (o.scan === null) {
    if (files.paths.length > 0) o.log.info(`AI review: the scan runs no secret engine, ${cut}`);
    return none;
  }
  const dir = createWorkDir('review-base', o.tempRoot);
  try {
    const names = new Set<string>();
    const written = await writeBaseFiles(git, base, {
      dir,
      paths: files.paths,
      budget: o.budget,
      names,
    });
    const instructions = files.instructions
      .map((f) => `${INSTRUCTIONS_DIR}/${f.name}`)
      .filter((rel, i) =>
        writeBelow(dir, rel, files.instructions[i]?.content ?? Buffer.alloc(0), names),
      );
    let found: readonly string[] | null;
    try {
      found = await o.scan(dir, [...written, ...instructions]);
    } catch (err) {
      o.log.debug(`AI review: the secret scan of the merge base threw: ${String(err)}`);
      found = null;
    }
    if (found === null) {
      o.log.warn(`AI review: the secret scan of the merge base's files did not complete, ${cut}`);
      return none;
    }
    return { secrets: found, scanned: written };
  } finally {
    releaseWorkDir(dir, o.log);
  }
}
