import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileLockOptions {
  /** A lock file older than this (or this far in the future) belongs to a process that died. */
  staleMs?: number;
  /** How often a waiting process looks again. */
  pollMs?: number;
  /** After waiting this long, the work runs without the lock (default: staleMs + 10 s). */
  maxWaitMs?: number;
  /** `onWait` is called once, when the wait has lasted this long. */
  noticeMs?: number;
  onWait?: () => void;
  /** Called with the reason when the work runs without the lock. */
  onUnlocked?: (reason: string) => void;
}

const STALE_MS = 180_000;
const POLL_MS = 200;
const NOTICE_MS = 2_000;

type Options = Required<Omit<FileLockOptions, 'onWait' | 'onUnlocked'>> &
  Pick<FileLockOptions, 'onWait'>;

/** What to do next about a lock another process holds. */
type Next = 'retry' | 'wait' | { unusable: string };

const errorCode = (err: unknown): unknown =>
  typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;

/** Further than `staleMs` from now, in either direction (clocks of hosts sharing a cache differ). */
const isOld = (timeMs: number, staleMs: number) => Math.abs(Date.now() - timeMs) > staleMs;

/** The lock files this process holds (token → file), released on exit too. */
const held = new Map<string, string>();
let exitHook = false;

/** Removes the lock file if it still holds `token`: one taken over as stale is not ours. */
function release(file: string, token: string): void {
  held.delete(token);
  try {
    if (readFileSync(file, 'utf8') === token) unlinkSync(file);
  } catch {
    // Already gone, or no longer ours to remove.
  }
}

/**
 * `process.exit()` (the runner's Ctrl+C and SIGTERM handler) skips every pending `finally`; the
 * 'exit' event still runs synchronous code, so the locks are released there.
 */
function releaseAllOnExit(): void {
  if (exitHook) return;
  exitHook = true;
  process.on('exit', () => {
    for (const [token, file] of held) release(file, token);
  });
}

/** Creates the lock file exclusively (`O_EXCL`, also across processes sharing its directory). */
function create(file: string, token: string): 'held' | 'busy' | 'failed' {
  try {
    writeFileSync(file, token, { flag: 'wx' });
    return 'held';
  } catch (err) {
    const code = errorCode(err);
    if (code === 'EEXIST') return 'busy';
    // Windows refuses to create a file again while its deletion is pending.
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) return 'busy';
    return 'failed';
  }
}

/** The name under which the stale lock holding `content` is claimed (one per lock: tokens differ). */
export function claimOf(file: string, content: string): string {
  return `${file}.${createHash('sha256').update(content).digest('hex').slice(0, 16)}.stale`;
}

/**
 * Why claiming failed: another claimer (EEXIST) or, on Windows, a lock pending deletion means
 * wait; a vanished lock means try again; anything else means no hard link can ever be made there
 * (a file system without them, Linux's protected_hardlinks, a directory we may not write).
 */
function claimFailed(file: string, claim: string, code: unknown, staleMs: number): Next {
  if (code === 'ENOENT') return 'retry';
  if (code === 'EEXIST') return deadClaim(file, claim, staleMs);
  if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) return 'wait';
  return { unusable: `no hard link can be made next to ${file} (${String(code)})` };
}

/**
 * A claim lives for a moment; one whose change time (set when it was linked) is older than
 * `staleMs` was left by a claimer that died before cleaning up. Removing it by path could remove
 * a live claimer's, so the lock is given up and both files are named instead.
 */
function deadClaim(file: string, claim: string, staleMs: number): Next {
  try {
    if (!isOld(lstatSync(claim).ctimeMs, staleMs)) return 'wait';
  } catch {
    return 'retry';
  }
  return {
    unusable: `${claim} is left from a process that died while it took over ${file}; remove both`,
  };
}

/**
 * Removes the stale lock whose content is `content`, or leaves it to whoever does. Never by path
 * alone: the lock is first claimed under a name of its own (a hard link, `claimOf`, which only one
 * process can create), and the claim — the very file the claimer will remove — must hold that
 * content and still be stale. The age is checked on the claim again because the path may have
 * changed hands since it was first judged: a fresh lock that took it is left alone. Exported for
 * direct testing (`link` too).
 */
export function takeOverStale(
  file: string,
  content: string,
  staleMs: number,
  link: (from: string, to: string) => void = linkSync,
): Next {
  const claim = claimOf(file, content);
  try {
    link(file, claim);
  } catch (err) {
    return claimFailed(file, claim, errorCode(err), staleMs);
  }
  try {
    if (readFileSync(claim, 'utf8') !== content) return 'wait';
    if (!isOld(lstatSync(claim).mtimeMs, staleMs)) return 'wait';
    unlinkSync(file);
    return 'retry';
  } catch {
    return 'wait';
  } finally {
    try {
      rmSync(claim, { force: true });
    } catch {
      // A claim left behind is reported by the next waiter once it is old (`deadClaim`).
    }
  }
}

/** Takes over the lock at `file` when it is stale; `unusable` when it can never be taken. */
function breakIfStale(file: string, staleMs: number): Next {
  let stat: Stats;
  try {
    stat = lstatSync(file);
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? 'retry' : 'wait';
  }
  if (!stat.isFile()) return { unusable: `${file} is not a lock file` };
  if (!isOld(stat.mtimeMs, staleMs)) return 'wait';
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return 'wait';
  }
  return takeOverStale(file, content, staleMs);
}

/**
 * Takes the lock: returns its token, or why the work must run without it (no lock file can be
 * created there, it can never be taken over, or the wait reached `maxWaitMs`).
 */
async function acquire(
  file: string,
  o: Options,
): Promise<{ token: string } | { unlocked: string }> {
  const token = randomUUID();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return { unlocked: `no lock file can be created at ${file}` };
  }
  const started = Date.now();
  let noticed = false;
  for (;;) {
    const created = create(file, token);
    if (created === 'held') return { token };
    if (created === 'failed') return { unlocked: `no lock file can be created at ${file}` };
    const next = breakIfStale(file, o.staleMs);
    if (typeof next === 'object') return { unlocked: next.unusable };
    const waited = Date.now() - started;
    if (waited >= o.maxWaitMs) return { unlocked: `waited ${o.maxWaitMs / 1000} s for ${file}` };
    if (next === 'wait' && !noticed && waited >= o.noticeMs) {
      noticed = true;
      o.onWait?.();
    }
    await sleep(next === 'retry' ? 1 : o.pollMs);
  }
}

/**
 * Runs `work` while this process holds the lock file `file`: no other process that locks the same
 * file runs its own work at the same time. A lock file older than `staleMs` belongs to a holder
 * that died and is taken over, so the work it guards must end well within that time. The lock is
 * released when the work ends, and when the process exits during it. Never fails for the lock's
 * sake: where no lock can be had, or after waiting `maxWaitMs`, the work runs unlocked and
 * `onUnlocked` says why.
 */
export async function withFileLock<T>(
  file: string,
  work: () => Promise<T>,
  o: FileLockOptions = {},
): Promise<T> {
  const staleMs = o.staleMs ?? STALE_MS;
  const lock = await acquire(file, {
    staleMs,
    pollMs: o.pollMs ?? POLL_MS,
    maxWaitMs: o.maxWaitMs ?? staleMs + 10_000,
    noticeMs: o.noticeMs ?? NOTICE_MS,
    onWait: o.onWait,
  });
  if ('unlocked' in lock) {
    o.onUnlocked?.(lock.unlocked);
    return work();
  }
  held.set(lock.token, file);
  releaseAllOnExit();
  try {
    return await work();
  } finally {
    release(file, lock.token);
  }
}
