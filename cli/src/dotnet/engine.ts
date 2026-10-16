import { createHash } from 'node:crypto';
import {
  lstatSync,
  opendirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dir,
  type Stats,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sarifLogSchema, type SarifLog } from '@qualor/shared';
import { resolveBinary } from '../analyzers/binary';
import { runProcess, type ProcessResult, type ProcessSpec } from '../analyzers/process';
import type { QualorPack } from '../analyzers/qualor';
import { detailLine } from '../analyzers/reason';
import {
  createWorkDir,
  execEnv,
  installEmergencyCleanup,
  releaseWorkDir,
} from '../analyzers/runner';
import type { TaintFallbackReason, TaintRun } from '../analyzers/types';
import type { Logger } from '../log';

/** The engine's budgets (spec §6): 10 minutes and 4 GB, as on nopCommerce in `scanner-dotnet`. */
export const TAINT_TIME_LIMIT_S = 600;
export const TAINT_MEMORY_LIMIT_MB = 4096;
/** What the build and the other analyzers keep, and the least the engine is given. */
const MEMORY_KEPT_FREE_MB = 1024;
const MIN_MEMORY_LIMIT_MB = 1024;

/**
 * Past its own time limit the engine still writes its SARIF; loading the compilations comes before
 * the limit starts. Only a process still running this long after the limit is killed.
 */
const KILL_GRACE_S = 300;

const MAX_ENGINE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENGINE_ENTRIES = 10_000;
const MAX_SARIF_BYTES = 256 * 1024 * 1024;

export interface TaintEngineOptions {
  /** The checkout: the engine reports paths relative to it. */
  root: string;
  /** The verified rules pack, or null when there is none (no rules installed, or refused). */
  pack: QualorPack | null;
  /** `<root>/.qualor/dotnet`: the hook's `compilations/` and `generated/` are read from it. */
  sessionDir: string;
  /** The CLI's environment; sanitized and confined like an analyzer's (config.md §6). */
  env: Readonly<Record<string, string | undefined>>;
  timeLimitS: number;
  memoryLimitMb: number;
  log: Logger;
  /** Runs the engine (tests replace it). */
  run?: (spec: ProcessSpec, log: Logger) => Promise<ProcessResult>;
  /** `dotnet` from PATH or the scanner image, never from the checkout (ruling V3). */
  resolveDotnet?: () => string | null;
}

/** Where the memory figures come from (tests replace it). */
export interface MemorySources {
  totalmem(): number;
  /** The file's text, or null when it does not exist; it may throw. */
  readFile(path: string): string | null;
}

const realMemory: MemorySources = {
  totalmem: () => os.totalmem(),
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
};

/** A cgroup v1 "no limit" is a value near 2^63; anything above 1 PB is none. */
const UNLIMITED_BYTES = 2 ** 50;

function cgroupBytes(memory: MemorySources, file: string): number | null {
  let text: string | null;
  try {
    text = memory.readFile(file);
  } catch {
    return null;
  }
  const raw = text?.trim() ?? '';
  if (!/^\d{1,19}$/.test(raw)) return null; // "max", empty or garbage
  const bytes = Number(raw);
  return bytes > 0 && bytes < UNLIMITED_BYTES ? bytes : null;
}

/** The `memory` limits above `path` (itself, then each parent) below `base`, as bytes. */
function walkLimits(
  memory: MemorySources,
  base: string,
  groupPath: string,
  file: string,
): number[] {
  const out: number[] = [];
  const parts = groupPath.split('/').filter((p) => p !== '' && p !== '..' && p !== '.');
  for (let n = parts.length; n >= 0; n--) {
    const bytes = cgroupBytes(
      memory,
      `${base}/${parts.slice(0, n).join('/')}/${file}`.replace('//', '/'),
    );
    if (bytes !== null) out.push(bytes);
  }
  return out;
}

/** The smaller of the host's memory and the container's cgroup limit, in MB, with its source. */
export function effectiveMemory(memory: MemorySources = realMemory): {
  mb: number;
  source: string;
} {
  let best = { bytes: memory.totalmem(), source: 'host memory' };
  const take = (bytes: number[], source: string) => {
    for (const b of bytes) if (b < best.bytes) best = { bytes: b, source };
  };
  // The top-level files (a container sees its own limit there), then the process's own group
  // from /proc/self/cgroup and its parents.
  take(walkLimits(memory, '/sys/fs/cgroup', '', 'memory.max'), 'cgroup v2 memory');
  take(
    walkLimits(memory, '/sys/fs/cgroup/memory', '', 'memory.limit_in_bytes'),
    'cgroup v1 memory',
  );
  let own: string | null;
  try {
    own = memory.readFile('/proc/self/cgroup');
  } catch {
    own = null;
  }
  for (const line of own?.split(/\r?\n/) ?? []) {
    const [, controllers, ...rest] = line.split(':');
    const groupPath = rest.join(':');
    if (controllers === undefined) continue;
    if (controllers === '') {
      take(walkLimits(memory, '/sys/fs/cgroup', groupPath, 'memory.max'), 'cgroup v2 memory');
    } else if (controllers.split(',').includes('memory')) {
      take(
        walkLimits(memory, '/sys/fs/cgroup/memory', groupPath, 'memory.limit_in_bytes'),
        'cgroup v1 memory',
      );
    }
  }
  return { mb: Math.floor(best.bytes / (1024 * 1024)), source: best.source };
}

/**
 * The default memory limit: half of the effective memory, at least 4096 MB, but always leaving
 * 1024 MB for the build and the other analyzers, and never below 1024 MB.
 */
export function defaultMemoryLimitMb(effectiveMb: number): number {
  const wanted = Math.max(TAINT_MEMORY_LIMIT_MB, Math.floor(effectiveMb / 2));
  return Math.max(MIN_MEMORY_LIMIT_MB, Math.min(wanted, effectiveMb - MEMORY_KEPT_FREE_MB));
}

/** A budget variable's value: a whole number from 1 to `max`, else null (with a warning if set). */
function envBudget(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  unit: string,
  max: number,
  fallback: number,
  warn: (message: string) => void,
): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (value >= 1 && value <= max) return value;
  warn(`${name} must be a whole number of ${unit} from 1 to ${max}; using ${fallback}`);
  return null;
}

/**
 * The engine's budgets: QUALOR_TAINT_TIME_LIMIT (s) and QUALOR_TAINT_MEMORY_LIMIT (MB). Without
 * the memory variable the limit is adaptive (`defaultMemoryLimitMb`), and `info` says which.
 */
export function taintBudgets(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  o: { memory?: MemorySources; info?: (message: string) => void } = {},
): { timeLimitS: number; memoryLimitMb: number } {
  const time = envBudget(
    env,
    'QUALOR_TAINT_TIME_LIMIT',
    'seconds',
    86_400,
    TAINT_TIME_LIMIT_S,
    warn,
  );
  const machine = effectiveMemory(o.memory);
  const adaptive = defaultMemoryLimitMb(machine.mb);
  const fromEnv = envBudget(
    env,
    'QUALOR_TAINT_MEMORY_LIMIT',
    'megabytes',
    1_048_576,
    adaptive,
    warn,
  );
  const memoryLimitMb = fromEnv ?? adaptive;
  o.info?.(
    `taint engine memory limit: ${memoryLimitMb} MB (${
      fromEnv !== null
        ? 'QUALOR_TAINT_MEMORY_LIMIT'
        : `adaptive, from ${machine.mb} MB of ${machine.source}`
    })`,
  );
  return { timeLimitS: time ?? TAINT_TIME_LIMIT_S, memoryLimitMb };
}

/** Every entry below `<dir>/dotnet` that is not a directory, as `dotnet/…` paths; or why not. */
function engineEntries(dir: string): { files: string[] } | { problem: string } {
  const files: string[] = [];
  const stack = ['dotnet'];
  let entries = 0;
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    let handle: Dir;
    try {
      handle = opendirSync(path.join(dir, ...rel.split('/')));
    } catch {
      return { problem: 'the engine cannot be read' };
    }
    try {
      for (let e = handle.readSync(); e !== null; e = handle.readSync()) {
        entries += 1;
        if (entries > MAX_ENGINE_ENTRIES) return { problem: 'the engine has too many files' };
        const child = `${rel}/${e.name}`;
        if (e.isSymbolicLink()) return { problem: `the engine holds a symbolic link (${child})` };
        if (e.isDirectory()) stack.push(child);
        else files.push(child);
      }
    } finally {
      handle.closeSync();
    }
  }
  return { files };
}

/**
 * R-4, Review Focus 4: why the pack's engine must not run, or null. Every file the manifest's
 * `dotnetEngine` lists is a regular file with that SHA-256, and `dotnet/` holds nothing else (the
 * runtime may load an assembly placed next to the tool, and the engine loads every model file).
 */
export function verifyTaintEngine(pack: QualorPack): string | null {
  const engine = pack.manifest.dotnetEngine;
  if (engine === undefined) {
    return `the rules pack ${pack.manifest.version} has no Roslyn taint engine`;
  }
  if ('invalid' in engine) return `the rules pack's dotnetEngine is not valid (${engine.invalid})`;
  for (const { path: file, sha256 } of engine.files) {
    const full = path.join(pack.dir, ...file.split('/'));
    let s: Stats;
    try {
      s = lstatSync(full);
    } catch {
      return `the engine is missing ${file}`;
    }
    if (!s.isFile() || s.size > MAX_ENGINE_FILE_BYTES) {
      return `the engine file ${file} is not a regular file`;
    }
    if (createHash('sha256').update(readFileSync(full)).digest('hex') !== sha256) {
      return `the engine file ${file} does not match its manifest checksum`;
    }
  }
  const found = engineEntries(pack.dir);
  if ('problem' in found) return found.problem;
  const listed = new Set(engine.files.map((f) => f.path));
  const extra = found.files.sort().find((f) => !listed.has(f));
  return extra === undefined ? null : `the engine holds ${extra}, which its manifest does not list`;
}

/** True when the hook recorded at least one project's compiler inputs. */
function hasInputs(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.txt'));
  } catch {
    return false;
  }
}

/** The line of the engine's stderr that says why it failed: its crash line, else its first line. */
function failureLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map(detailLine)
    .filter((l) => l !== '');
  return (
    lines.find((l) => l.startsWith('crash:')) ?? lines.find((l) => !l.startsWith('input:')) ?? null
  );
}

/** Why an incomplete run stopped: from the engine's last stderr line, else a fixed text. */
function incompleteReason(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map(detailLine)
    .reverse()
    .find((l) => l.includes('; incomplete: '));
  const reason = line?.slice(line.indexOf('; incomplete: ') + '; incomplete: '.length).trim();
  return reason !== undefined && reason !== '' ? reason : 'the analysis was incomplete';
}

/** R-E42: the engine's reason when a project's sources did not all load. */
const LOAD_REASON = /^the sources of \d+ project\(s\) could not be loaded/;

interface LoadStats {
  /** `analysisStats.incompleteKind` of an engine that writes it: budget, load or failed. */
  kind: string | null;
  withErrors: number;
  withoutSources: number;
  unresolved: number;
}

/** The R-E42 counts of the engine's `analysisStats` (0 when missing, as from an older engine). */
function loadStats(log: SarifLog | null): LoadStats {
  const properties = (log?.runs[0] as { properties?: unknown } | undefined)?.properties;
  const raw =
    typeof properties === 'object' && properties !== null
      ? (properties as { analysisStats?: unknown }).analysisStats
      : undefined;
  const stats = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const count = (k: string) => (typeof stats[k] === 'number' ? (stats[k] as number) : 0);
  return {
    kind: typeof stats['incompleteKind'] === 'string' ? stats['incompleteKind'] : null,
    withErrors: count('projectsWithErrors'),
    withoutSources: count('projectsWithoutSources'),
    unresolved: count('unresolvedReferences'),
  };
}

const BUDGET_REASON = /\b(time|memory) limit\b/i;

/**
 * Why an incomplete run falls back: the engine's own `incompleteKind` (budget first) when it
 * writes one; else, for an older engine, `load` when the reason says so, or when sources are
 * missing and the stop was not a budget stop.
 */
function incompleteFallback(why: string, stats: LoadStats): TaintFallbackReason {
  if (stats.kind === 'budget') return 'budget';
  if (stats.kind === 'load') return 'load';
  if (stats.kind === 'failed') return 'crash';
  if (LOAD_REASON.test(why)) return 'load';
  return stats.withoutSources > 0 && !BUDGET_REASON.test(why) ? 'load' : 'budget';
}

const MAX_LOGGED_PROJECTS = 20;

/** The engine's per-project warning lines (`project: …`), for the log only. */
function projectWarnings(log: SarifLog): string[] {
  const invocations = (log.runs[0] as { invocations?: unknown } | undefined)?.invocations;
  const first: unknown = Array.isArray(invocations) ? invocations[0] : undefined;
  const notes =
    typeof first === 'object' && first !== null
      ? (first as { toolExecutionNotifications?: unknown }).toolExecutionNotifications
      : undefined;
  const lines: string[] = [];
  for (const n of Array.isArray(notes) ? notes : []) {
    const text = (n as { message?: { text?: unknown } } | null)?.message?.text;
    if (typeof text === 'string' && text.startsWith('project: ')) lines.push(detailLine(text));
  }
  return lines.slice(0, MAX_LOGGED_PROJECTS);
}

/** The engine's SARIF, or null when it is missing, too large or not SARIF 2.1.0. */
function readEngineSarif(file: string): SarifLog | null {
  try {
    if (statSync(file).size > MAX_SARIF_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return sarifLogSchema.safeParse(parsed).success ? (parsed as SarifLog) : null;
  } catch {
    return null;
  }
}

/** False when the engine's own invocation record says the analysis did not complete. */
function executionSuccessful(log: SarifLog): boolean {
  const invocations = (log.runs[0] as { invocations?: unknown } | undefined)?.invocations;
  if (!Array.isArray(invocations)) return true;
  const first: unknown = invocations[0];
  return !(
    typeof first === 'object' &&
    first !== null &&
    (first as { executionSuccessful?: unknown }).executionSuccessful === false
  );
}

/** The engine's count of analysed projects (`runs[0].properties.analysisStats.projects`), or null. */
function projectsRead(log: SarifLog): number | null {
  const properties = (log.runs[0] as { properties?: unknown } | undefined)?.properties;
  const stats =
    typeof properties === 'object' && properties !== null
      ? (properties as { analysisStats?: unknown }).analysisStats
      : undefined;
  const projects =
    typeof stats === 'object' && stats !== null
      ? (stats as { projects?: unknown }).projects
      : undefined;
  return typeof projects === 'number' ? projects : null;
}

const fallback = (reason: TaintFallbackReason, detail: string): TaintRun => ({
  kind: 'fallback',
  reason,
  detail,
});

/**
 * 6B-C# R, spec §4.2 and R-4: runs Qualor's Roslyn taint engine from the rules pack on the
 * compiler inputs the MSBuild hook recorded in this session. `ok` only for a complete analysis;
 * anything else is a fallback with its reason, and the OpenGrep C# rules run in its place. The
 * engine never runs unless every one of its files matches the pack manifest.
 */
export async function runTaintEngine(o: TaintEngineOptions): Promise<TaintRun> {
  try {
    return await attempt(o);
  } catch (err) {
    // A file that cannot be read after its checks, a full temporary directory, a spawn that
    // throws: R-4 falls back to OpenGrep whatever went wrong, and the scan still runs.
    const message = err instanceof Error ? err.message : String(err);
    return fallback('crash', detailLine(message.split(/\r?\n/)[0] ?? '') || 'unexpected error');
  }
}

/** The files the hook recorded as compiled (`source=` of every compilation input, format v1). */
function recordedSources(inputs: string, root: string): string[] {
  const roots = [path.resolve(root)];
  try {
    roots.push(realpathSync.native(root));
  } catch {
    // The written path only.
  }
  const found = new Set<string>();
  for (const name of readdirSync(inputs).filter((n) => n.endsWith('.txt'))) {
    for (const source of compilationSources(path.join(inputs, name))) {
      const rel = rootRelative(source, roots);
      if (rel !== null) found.add(rel);
    }
  }
  return [...found].sort();
}

/** The `source=` paths of one compilation input file, resolved; none when it is not format v1. */
function compilationSources(file: string): string[] {
  const s = lstatSync(file);
  if (!s.isFile() || s.size > MAX_ENGINE_FILE_BYTES) return [];
  const lines = readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  if (lines[0] !== 'qualor-compilation=1') return [];
  return lines
    .filter((line) => line.startsWith('source=') && line.length !== 'source='.length)
    .map((line) => path.resolve(line.slice('source='.length)));
}

/** `source` relative to the first of `roots` it lies inside, with `/` separators, or null. */
function rootRelative(source: string, roots: readonly string[]): string | null {
  for (const base of roots) {
    const rel = path.relative(base, source);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      continue;
    }
    return rel.split(path.sep).join('/');
  }
  return null;
}

async function attempt(o: TaintEngineOptions): Promise<TaintRun> {
  if (o.pack === null) return fallback('no-engine', 'no valid rules pack');
  const engine = o.pack.manifest.dotnetEngine;
  if (engine === undefined) {
    return fallback(
      'no-engine',
      `the rules pack ${o.pack.manifest.version} has no Roslyn taint engine`,
    );
  }
  if ('invalid' in engine) {
    return fallback('no-engine', `the rules pack's dotnetEngine is not valid (${engine.invalid})`);
  }
  const problem = verifyTaintEngine(o.pack);
  if (problem !== null) return fallback('engine-mismatch', problem);
  const inputs = path.join(o.sessionDir, 'compilations');
  if (!hasInputs(inputs)) return fallback('no-inputs', 'the build recorded no compiler inputs');
  const dotnet = (
    o.resolveDotnet ?? (() => resolveBinary('dotnet', { root: o.root, env: o.env }))
  )();
  if (dotnet === null) return fallback('dotnet-missing', 'dotnet is not installed');

  // Tracked, so Ctrl+C removes it too.
  const work = createWorkDir('taint');
  const sarif = path.join(work, 'taint.sarif');
  const timeoutS = o.timeLimitS + KILL_GRACE_S;
  const uninstall = installEmergencyCleanup(o.log);
  try {
    const result = await (o.run ?? runProcess)(
      {
        command: dotnet,
        args: [
          path.join(o.pack.dir, ...engine.entry.split('/')),
          'analyze',
          '--inputs',
          inputs,
          '--models',
          path.join(o.pack.dir, ...engine.models.split('/'), 'csharp'),
          '--sarif',
          sarif,
          '--time-limit',
          String(o.timeLimitS),
          '--memory-limit',
          String(o.memoryLimitMb),
          '--root',
          o.root,
          '--version',
          engine.version,
        ],
        // Never the checkout: a relative path in the environment would resolve into it.
        cwd: o.pack.dir,
        env: execEnv(o.env, {}, o.root),
        timeoutMs: timeoutS * 1000,
      },
      o.log,
    );
    return taintOutcome(o, result, { sarif, inputs, timeoutS });
  } finally {
    uninstall();
    releaseWorkDir(work, o.log);
  }
}

/** The engine's run read: `ok` only for a complete analysis, else the fallback with its reason. */
function taintOutcome(
  o: TaintEngineOptions,
  result: ProcessResult,
  run: { sarif: string; inputs: string; timeoutS: number },
): TaintRun {
  const { sarif, timeoutS } = run;
  if (result.timedOut) return fallback('budget', `the engine did not finish within ${timeoutS} s`);
  if (result.spawnError !== undefined) {
    return result.spawnErrorCode === 'ENOENT'
      ? fallback('dotnet-missing', 'dotnet is not installed')
      : fallback('crash', 'dotnet could not be started');
  }
  if (result.exitCode === 3) {
    const why = incompleteReason(result.stderr);
    return fallback(incompleteFallback(why, loadStats(readEngineSarif(sarif))), why);
  }
  if (result.exitCode !== 0) {
    const line = failureLine(result.stderr);
    const code = `exited with code ${result.exitCode ?? 'null'}`;
    return fallback('crash', line === null ? code : `${code}: ${line}`);
  }
  const log = readEngineSarif(sarif);
  if (log === null) return fallback('crash', "the engine's SARIF could not be read");
  return analysedOutcome(o, log, result.stderr, run.inputs);
}

/** The outcome of an engine run that exited 0 with a readable SARIF log. */
function analysedOutcome(
  o: TaintEngineOptions,
  log: SarifLog,
  stderr: string,
  inputs: string,
): TaintRun {
  const stats = loadStats(log);
  if (!executionSuccessful(log)) {
    const why = incompleteReason(stderr);
    const kind = incompleteFallback(why, stats);
    return fallback(
      kind,
      why === 'the analysis was incomplete' && kind === 'load'
        ? 'the sources of a project could not be loaded'
        : why,
    );
  }
  if (projectsRead(log) === 0) {
    return fallback('no-inputs', 'the engine read no project from the compiler inputs');
  }
  for (const line of projectWarnings(log)) o.log.warn(`taint engine: ${line}`);
  return {
    kind: 'ok',
    sarif: log,
    sources: recordedSources(inputs, o.root),
    ...(stats.withErrors > 0 || stats.unresolved > 0
      ? { problems: { projects: stats.withErrors, unresolvedReferences: stats.unresolved } }
      : {}),
  };
}
