import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tmp';
import { withFileLock } from './file-lock';

const tmp = useTempDirs();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withFileLock (the OpenGrep cache across qualor scan processes)', () => {
  it('never lets two holders in at once, and removes the lock file afterwards', async () => {
    const file = path.join(tmp(), 'cache', 'opengrep', '.lock');
    const log: string[] = [];
    const hold = (name: string) =>
      withFileLock(
        file,
        async () => {
          log.push(`start ${name}`);
          expect(existsSync(file)).toBe(true);
          await pause(30);
          log.push(`end ${name}`);
          return name;
        },
        { pollMs: 5 },
      );
    expect(await Promise.all([hold('a'), hold('b'), hold('c')])).toEqual(['a', 'b', 'c']);
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]?.replace('start', 'end')).toBe(log[i + 1]);
    }
    expect(log).toHaveLength(6);
    expect(existsSync(file)).toBe(false);
  });

  it('waits while another process holds the lock, then takes it', async () => {
    const file = path.join(tmp(), '.lock');
    writeFileSync(file, 'another process');
    let ran = false;
    const held = withFileLock(
      file,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { pollMs: 5 },
    );
    await pause(50);
    expect(ran).toBe(false);
    // The other process releases it.
    rmSync(file);
    await held;
    expect(ran).toBe(true);
  });

  it('breaks a lock older than staleMs (a process killed while it held it)', async () => {
    const file = path.join(tmp(), '.lock');
    writeFileSync(file, 'killed process');
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    expect(await withFileLock(file, () => Promise.resolve('ran'), { staleMs: 30_000 })).toBe('ran');
    expect(existsSync(file)).toBe(false);
  });

  it('releases the lock when the work fails', async () => {
    const file = path.join(tmp(), '.lock');
    await expect(withFileLock(file, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(existsSync(file)).toBe(false);
  });

  it('never removes a lock that is no longer its own', async () => {
    const file = path.join(tmp(), '.lock');
    await withFileLock(file, () => {
      // Taken over as stale by another process meanwhile.
      writeFileSync(file, 'another process');
      return Promise.resolve();
    });
    expect(readFileSync(file, 'utf8')).toBe('another process');
  });

  it('runs the work without a lock when none can be created (a read-only cache)', async () => {
    const parent = path.join(tmp(), 'not-a-directory');
    writeFileSync(parent, '');
    expect(
      await withFileLock(path.join(parent, '.lock'), () => Promise.resolve('ran'), { pollMs: 5 }),
    ).toBe('ran');
  });
});
