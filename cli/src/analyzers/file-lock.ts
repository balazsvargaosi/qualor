import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileLockOptions {
  /** A lock file older than this belongs to a process that died while it held it. */
  staleMs?: number;
  /** How often a waiting process looks again. */
  pollMs?: number;
}

const STALE_MS = 180_000;
const POLL_MS = 200;

const errorCode = (err: unknown): unknown =>
  typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;

/** Whether the lock file is older than `staleMs`, or already gone. */
function isStale(file: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

/**
 * Creates `file` exclusively (`O_EXCL`, also across processes and containers that share its
 * directory) with a token of its own, waiting while another process holds it. Returns the token,
 * or null when no lock file can be created there at all.
 */
async function acquire(file: string, staleMs: number, pollMs: number): Promise<string | null> {
  const token = randomUUID();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return null;
  }
  for (;;) {
    try {
      writeFileSync(file, token, { flag: 'wx' });
      return token;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') return null;
    }
    if (isStale(file, staleMs)) rmSync(file, { force: true });
    else await sleep(pollMs);
  }
}

/** Removes the lock file if it still holds `token`: one taken over as stale is not ours. */
function release(file: string, token: string): void {
  try {
    if (readFileSync(file, 'utf8') === token) rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}

/**
 * Runs `work` while this process holds the lock file `file`: no other process that locks the same
 * file runs its own work at the same time. A lock file older than `staleMs` is removed (its holder
 * died), so the work it guards must end well within that time. Where no lock file can be created
 * (a read-only directory), the work runs unlocked.
 */
export async function withFileLock<T>(
  file: string,
  work: () => Promise<T>,
  o: FileLockOptions = {},
): Promise<T> {
  const token = await acquire(file, o.staleMs ?? STALE_MS, o.pollMs ?? POLL_MS);
  try {
    return await work();
  } finally {
    if (token !== null) release(file, token);
  }
}
