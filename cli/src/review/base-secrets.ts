import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { QualorConfig } from '@qualor/shared';
import { fileLines, normalizeCaptures } from '../analyzers/normalize';
import {
  createWorkDir,
  execEnv,
  releaseWorkDir,
  runAnalyzers,
  withEmergencyCleanup,
} from '../analyzers/runner';
import type { Analyzer } from '../analyzers/types';
import { gitText, type Git } from '../git/git';
import { parseLsTreeLong, readObjects, type TreeEntry } from '../git/objects';
import type { Logger } from '../log';
import { gitleaksOverMergeBase } from './base-gitleaks';

/*
 * The secrets of the merge base (ruling R13). The analyzers scan the merge request's head, so a
 * secret the merge request removes is in no list the scan gives the snapshot; yet a patch shows
 * it, on its removed lines. The scan's own secret engine is run again, as the scan runs it, over a
 * directory holding the merge base's versions of what the snapshot sends of it.
 */

/**
 * What the scan's secret engine found in a directory of the merge base's files: the secrets' texts,
 * or why it did not run there to the end (not installed, cannot run there as in the scan, failed,
 * timed out) or its output could not be read.
 */
export type BaseSecretScanResult = { secrets: readonly string[] } | { failed: string };

/** The scan of `dir`, a directory of files of the merge base (`paths`, relative to it). */
export type BaseSecretScan = (
  dir: string,
  paths: readonly string[],
) => Promise<BaseSecretScanResult>;

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
export const SECRET_ENGINE = 'gitleaks';

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
 * The scan's secret engine for the merge base's files, or null when the scan runs none (Gitleaks
 * is not among its analyzers, or is disabled in qualor.yml). The engine is the scan's analyzer,
 * prepared against the checkout as the scan prepares it, then run by the analyzers' runner in
 * `dir` as it ran in the checkout (`gitleaksOverMergeBase`): over `.`, so the paths it reports and
 * its rules and allowlists match are the repository's, with the scan's configuration file, its
 * extends, `GITLEAKS_CONFIG` and `.gitleaksignore`. When it cannot run there exactly as in the
 * scan, it does not run, as when it is not installed. Its secrets are collected as the report
 * collects them (`normalizeCaptures`).
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
        // The environment the scan's run had: the runner's, with the command's own on top.
        const env = execEnv(
          ctx.env,
          {
            ...(prep.run.env !== undefined && { env: prep.run.env }),
            ...(prep.run.dropEnv !== undefined && { dropEnv: prep.run.dropEnv }),
          },
          ctx.root,
        );
        const there = gitleaksOverMergeBase(prep.run, { dir, env });
        if ('run' in there) return there;
        return { unavailable: `${engine.id} cannot run there as in the scan: ${there.cannot}` };
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
    if (capture?.status !== 'ok') return { failed: capture?.reason ?? 'it did not run' };
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
    return found.texts === null
      ? { failed: 'its output could not be read' }
      : { secrets: found.texts };
  };
}

// ─── The merge base's files ──────────────────────────────────────────────────

/** A merge-base file larger than this is not scanned (its patch then sends no removed line). */
const MAX_BASE_FILE_BYTES = 16 * 1024 * 1024;
/** On Windows, names a file system takes for a device, a stream or nothing like the name. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*]|[. ]$/;

/**
 * Whether the merge base's version of `p` can go into the scanned directory as itself: never a root
 * `.gitleaksignore` or `.gitleaks.*` in any case, which Gitleaks would read as its own there on a
 * file system that ignores case (`.GITLEAKS.TOML`, or a dotless i, U+0131, whose capital is `I`);
 * on Windows, never a name the file system would turn into something else (a device, a stream).
 */
function placeable(p: string): boolean {
  const names = [p.toLowerCase(), p.toUpperCase().toLowerCase()];
  if (names.some((n) => n === '.gitleaksignore' || n.startsWith('.gitleaks.'))) return false;
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
  /**
   * The instructions files the snapshot sends, as the merge base has them, that lie within the
   * scan's root: at their paths there, the ones the head scan read them at.
   */
  instructions: readonly { path: string; content: Buffer }[];
}

/** Whether the file at `rel` below `dir` holds `content`. */
function holds(dir: string, rel: string, content: Buffer): boolean {
  try {
    return readFileSync(path.join(dir, ...rel.split('/'))).equals(content);
  } catch {
    return false;
  }
}

/**
 * The instructions files put where the scan reads them, at their own paths: one that is the old
 * side of a changed file is already there (the same blob of the merge base), and is scanned once,
 * as that copy. The paths of those it holds, and of those it cannot (their name is taken, on a
 * file system that ignores case).
 */
function placeInstructions(
  dir: string,
  files: MergeBaseFiles['instructions'],
  o: { written: ReadonlySet<string>; names: Set<string> },
): { placed: string[]; unplaced: string[] } {
  const placed: string[] = [];
  const unplaced: string[] = [];
  for (const f of files) {
    const there = o.written.has(f.path)
      ? holds(dir, f.path, f.content)
      : placeable(f.path) && writeBelow(dir, f.path, f.content, o.names);
    (there ? placed : unplaced).push(f.path);
  }
  return { placed, unplaced };
}

/** `scan` over `dir`: a scan that throws did not run to the end either. */
async function scanned(
  scan: BaseSecretScan,
  dir: string,
  paths: readonly string[],
  log: Logger,
): Promise<BaseSecretScanResult> {
  try {
    return await scan(dir, paths);
  } catch (err) {
    log.debug(`AI review: the secret scan of the merge base threw: ${String(err)}`);
    return { failed: 'the scan threw' };
  }
}

/**
 * Runs `scan` over the merge base's `files`, written at their paths within the scan's root to a
 * private work directory that the analyzers' signal handler covers for its whole life and that is
 * removed on every path. With no secret engine (`scan` null), or one that did not run to the end,
 * could not run there as in the scan, or threw, nothing is found and no old side is held (said
 * once, at warn, but for no engine): the patches then send no removed line, and the instructions
 * files go with the shared patterns only, as one that cannot be put at its path does (said once).
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
  const scan = o.scan;
  if (scan === null) {
    if (files.paths.length > 0) o.log.info(`AI review: the scan runs no secret engine, ${cut}`);
    return none;
  }
  return withEmergencyCleanup(o.log, async () => {
    const dir = createWorkDir('review-base', o.tempRoot);
    try {
      const names = new Set<string>();
      const written = await writeBaseFiles(git, base, {
        dir,
        paths: files.paths,
        budget: o.budget,
        names,
      });
      const instructions = placeInstructions(dir, files.instructions, { written, names });
      if (instructions.unplaced.length > 0) {
        o.log.info(
          `AI review: the instructions files ${instructions.unplaced.join(', ')} cannot be scanned for secrets where the scan reads them, so the snapshot sends them with the shared redaction only`,
        );
      }
      const paths = [...new Set([...written, ...instructions.placed])];
      const result = await scanned(scan, dir, paths, o.log);
      if ('failed' in result) {
        o.log.warn(
          `AI review: the merge base's files could not be scanned for secrets (${result.failed}), ${cut}`,
        );
        return none;
      }
      return { secrets: result.secrets, scanned: written };
    } finally {
      releaseWorkDir(dir, o.log);
    }
  });
}
