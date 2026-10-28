import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { within } from '../analyzers/binary';
import { gitleaksExtends, MAX_GITLEAKS_CONFIG_BYTES } from '../analyzers/gitleaks-config';
import type { AnalyzerCommand } from '../analyzers/types';

/*
 * The scan's Gitleaks command (analyzers/gitleaks.ts) made to scan the merge base's files as the
 * scan scanned the checkout (ruling R13). What Gitleaks 8.30.1 does that matters here:
 * - it reports the paths it walks from its `dir` argument, and matches the rules' `path` and the
 *   allowlists' `paths` against them;
 * - its configuration is `--config`, else GITLEAKS_CONFIG, else GITLEAKS_CONFIG_TOML, else the
 *   source's `.gitleaks.toml`, else its default rules; a configuration's `[extend] path` is opened
 *   from the working directory (viper's `SetConfigFile`), two levels deep at most;
 * - it reads `.gitleaksignore` from `--gitleaks-ignore-path` (a file, or a directory holding one;
 *   `.` by default) and from the source.
 * So the run keeps `dir .` and takes the merge base's directory as its working directory: the
 * paths it reports and matches are the repository's, as in the scan. What the scan's run read
 * from its own working directory, the checkout, is given to it again: `--config` and
 * GITLEAKS_CONFIG made absolute, the `[extend]` chain copied to its relative paths in the
 * directory, the checkout's `.gitleaksignore` named by `--gitleaks-ignore-path`. What it cannot
 * give exactly it says, and nothing is run.
 */

/** The options of the scan's command after `dir .`, and whether each takes a value. */
const OPTIONS: ReadonlyMap<string, boolean> = new Map([
  ['--report-format', true],
  ['--report-path', true],
  ['--config', true],
  ['--no-banner', false],
  ['--no-color', false],
  ['--log-level', true],
  ['--exit-code', true],
]);
/** Gitleaks follows `[extend] path` this many levels from the configuration it loads. */
const MAX_EXTEND_DEPTH = 2;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `name` as a process started with `env` reads it; undefined when unset or empty, which Gitleaks
 * reads alike. On Windows a name has no case, and Node passes the first in sort order of the
 * names that differ only in case.
 */
function envValue(env: Env, name: string): string | undefined {
  const key =
    process.platform === 'win32'
      ? Object.keys(env)
          .sort()
          .find((k) => k.toUpperCase() === name)
      : name;
  const value = key === undefined ? undefined : env[key];
  return value === '' ? undefined : value;
}

/**
 * The index of `--config`'s value among `args` from `from` on (null without one), or undefined
 * when an option there is not one the scan's command has.
 */
function configAt(args: readonly string[], from: number): number | null | undefined {
  let config: number | null = null;
  let i = from;
  while (i < args.length) {
    const takes = OPTIONS.get(args[i] ?? '');
    if (takes === undefined || (takes && i + 1 >= args.length)) return undefined;
    if (takes && args[i] === '--config') config = i + 1;
    // An option that takes a value is followed by it.
    i += takes ? 2 : 1;
  }
  return config;
}

/** A configuration file's bytes; null when it is not a regular file within the bound. */
function readConfig(file: string): Buffer | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_GITLEAKS_CONFIG_BYTES) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The one file a configuration extends (none: an empty list); why it cannot be known otherwise. */
function extendTargets(bytes: Buffer): { targets: string[] } | { why: string } {
  const parsed = gitleaksExtends(bytes);
  if ('error' in parsed) return { why: `its configuration ${parsed.error}` };
  const targets = parsed.paths.filter((p) => p !== '');
  if (targets.length > 1) return { why: 'its configuration extends more than one file' };
  return { targets };
}

/**
 * One extended file put in `dir` where the run there opens it (see `placeExtends`): its bytes, or
 * why it cannot be.
 */
function placeTarget(
  target: string,
  from: string,
  dir: string,
  placed: Set<string>,
): { content: Buffer } | { why: string } {
  const source = path.resolve(from, target);
  const content = readConfig(source);
  if (content === null) return { why: 'a configuration it extends cannot be read' };
  const opened = path.resolve(dir, target);
  if (opened === source || placed.has(opened)) return { content };
  if (opened === dir || !within(dir, opened)) {
    return { why: 'a configuration it extends lies outside the repository' };
  }
  try {
    mkdirSync(path.dirname(opened), { recursive: true });
    writeFileSync(opened, content, { flag: 'wx', mode: 0o600 });
  } catch {
    return { why: 'a configuration it extends is a file of the merge base too' };
  }
  placed.add(opened);
  return { content };
}

/**
 * The `[extend]` chain of `top` put where the run in `dir` opens it. The scan's run opened each
 * `path` from `from`, its working directory: a path both runs open alike (an absolute one) stays;
 * any other is copied from there to the same relative path in `dir`, where nothing may be yet (the
 * merge base's version of that file would be read in its place). Why it cannot, or null.
 */
function placeExtends(top: Buffer, from: string, dir: string): string | null {
  const placed = new Set<string>();
  let level: Buffer[] = [top];
  for (let depth = 0; depth < MAX_EXTEND_DEPTH; depth++) {
    const next: Buffer[] = [];
    for (const bytes of level) {
      const found = extendTargets(bytes);
      if ('why' in found) return found.why;
      for (const target of found.targets) {
        const result = placeTarget(target, from, dir, placed);
        if ('why' in result) return result.why;
        next.push(result.content);
      }
    }
    level = next;
  }
  return null;
}

/**
 * The scan's Gitleaks command `run` (prepared against the checkout, its working directory) made to
 * scan `dir` as it scanned the checkout, `env` being the environment the scan's run had; or why it
 * cannot be, and then nothing is to run. The files the chain of `[extend]` needs are put in `dir`.
 */
export function gitleaksOverMergeBase(
  run: AnalyzerCommand,
  o: { dir: string; env: Env },
): { run: AnalyzerCommand } | { cannot: string } {
  const at = run.args.findIndex((arg, i) => arg === 'dir' && run.args[i + 1] === '.');
  const before = run.args.slice(0, Math.max(at, 0));
  const config = at === -1 ? undefined : configAt(run.args, at + 2);
  if (config === undefined || before.some((arg) => arg.startsWith('-'))) {
    return { cannot: 'its command is not the one the scan runs' };
  }
  const from = path.resolve(run.cwd);
  const args = [...run.args];
  const env: Record<string, string> = {};
  const fromEnv = envValue(o.env, 'GITLEAKS_CONFIG');
  const inline = envValue(o.env, 'GITLEAKS_CONFIG_TOML');
  let top: Buffer | null = null;
  if (config !== null) {
    args[config] = path.resolve(from, args[config] ?? '');
    top = readConfig(args[config]);
    if (top === null) return { cannot: 'its configuration cannot be read' };
  } else if (fromEnv !== undefined) {
    env['GITLEAKS_CONFIG'] = path.resolve(from, fromEnv);
    top = readConfig(env['GITLEAKS_CONFIG']);
    if (top === null) return { cannot: 'its configuration cannot be read' };
  } else if (inline !== undefined) {
    top = Buffer.from(inline, 'utf8');
  }
  const why = top === null ? null : placeExtends(top, from, o.dir);
  if (why !== null) return { cannot: why };
  const ignore = path.join(from, '.gitleaksignore');
  if (isFile(ignore)) args.push('--gitleaks-ignore-path', ignore);
  return { run: { ...run, cwd: o.dir, args, env: { ...run.env, ...env } } };
}
