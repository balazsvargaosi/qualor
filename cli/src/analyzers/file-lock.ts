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
}

const STALE_MS = 180_000;
const POLL_MS = 200;
const NOTICE_MS = 2_000;

type Options = Required<Omit<FileLockOptions, 'onWait'>> & Pick<FileLockOptions, 'onWait'>;

const errorCode = (err: unknown): unknown =>
  typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;

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

/**
 * Removes the stale lock whose content is `content`, or leaves it to whoever does. Never by path
 * alone: the stale file is first claimed under a name of its own (a hard link `<file>.<hash of
 * its content>.stale`, which only one process can create); the claimer checks that the claimed
 * file is the one it judged stale (each lock holds a random token), so a fresh lock that took the
 * path meanwhile is never removed. Returns whether to try again at once or wait.
 */
function takeOver(file: string, content: string): 'retry' | 'wait' {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const claim = `${file}.${digest}.stale`;
  try {
    linkSync(file, claim);
  } catch (err) {
    // EEXIST: another process is taking it over; anything else: it cannot be taken over.
    return errorCode(err) === 'ENOENT' ? 'retry' : 'wait';
  }
  try {
    if (readFileSync(claim, 'utf8') !== content) return 'wait';
    unlinkSync(file);
    return 'retry';
  } catch {
    return 'wait';
  } finally {
    try {
      rmSync(claim, { force: true });
    } catch {
      // A claim left behind blocks nothing but the takeover of that one stale lock.
    }
  }
}

/** Takes over the lock at `file` when it is stale; `unusable` when it is not a lock file at all. */
function breakIfStale(file: string, staleMs: number): 'retry' | 'wait' | 'unusable' {
  let stat: Stats;
  try {
    stat = lstatSync(file);
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? 'retry' : 'wait';
  }
  if (!stat.isFile()) return 'unusable';
  // A time in the future (clocks of hosts that share the cache disagree) is as suspect as an old one.
  if (Math.abs(Date.now() - stat.mtimeMs) <= staleMs) return 'wait';
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return 'wait';
  }
  return takeOver(file, content);
}

/**
 * Takes the lock: returns its token, or null when the work must run without it (no lock file can
 * be created there, or the wait reached `maxWaitMs`).
 */
async function acquire(file: string, o: Options): Promise<string | null> {
  const token = randomUUID();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return null;
  }
  const started = Date.now();
  let noticed = false;
  for (;;) {
    const created = create(file, token);
    if (created !== 'busy') return created === 'held' ? token : null;
    const next = breakIfStale(file, o.staleMs);
    const waited = Date.now() - started;
    if (next === 'unusable' || waited >= o.maxWaitMs) return null;
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
 * sake: where no lock file can be created, or after waiting `maxWaitMs`, the work runs unlocked.
 */
export async function withFileLock<T>(
  file: string,
  work: () => Promise<T>,
  o: FileLockOptions = {},
): Promise<T> {
  const staleMs = o.staleMs ?? STALE_MS;
  const token = await acquire(file, {
    staleMs,
    pollMs: o.pollMs ?? POLL_MS,
    maxWaitMs: o.maxWaitMs ?? staleMs + 10_000,
    noticeMs: o.noticeMs ?? NOTICE_MS,
    onWait: o.onWait,
  });
  if (token !== null) {
    held.set(token, file);
    releaseAllOnExit();
  }
  try {
    return await work();
  } finally {
    if (token !== null) release(file, token);
  }
}
