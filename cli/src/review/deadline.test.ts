import { describe, expect, it } from 'vitest';
import { GIT_LOCAL_TIMEOUT_MS, type Git, type GitCallOptions, type GitResult } from '../git/git';
import { SNAPSHOT_DEADLINE_MS, SnapshotDeadline, SnapshotTooSlow } from './deadline';

const OK: GitResult = { code: 0, stdout: 'out', stderr: '' };
const FAILED: GitResult = { code: 1, stdout: '', stderr: 'killed' };

/** A git that records each call's options and answers `answer`, moving the clock by `takes`. */
function recordingGit(clock: { t: number }, answer: GitResult, takes = 0) {
  const calls: (GitCallOptions | undefined)[] = [];
  const git: Git = (_args, options) => {
    calls.push(options);
    clock.t += takes;
    return Promise.resolve(answer);
  };
  return { git, calls };
}

describe('the snapshot deadline (6I-3)', () => {
  it("cuts a call's timeout to the time left, and keeps its own when that is shorter", async () => {
    const clock = { t: 0 };
    const deadline = new SnapshotDeadline(() => clock.t);
    const { git, calls } = recordingGit(clock, OK);
    const cut = deadline.git(git);
    await cut(['status']);
    await cut(['fetch'], { timeoutMs: 300_000 });
    expect(calls.map((o) => o?.timeoutMs)).toEqual([GIT_LOCAL_TIMEOUT_MS, 300_000]);
    clock.t = SNAPSHOT_DEADLINE_MS - 5_000;
    await cut(['fetch'], { timeoutMs: 300_000 });
    await cut(['status']);
    await cut(['status'], { timeoutMs: 1_000 });
    expect(calls.slice(2).map((o) => o?.timeoutMs)).toEqual([5_000, 5_000, 1_000]);
  });

  it('starts no call once the deadline has passed', async () => {
    const clock = { t: 0 };
    const deadline = new SnapshotDeadline(() => clock.t);
    const { git, calls } = recordingGit(clock, OK);
    clock.t = SNAPSHOT_DEADLINE_MS;
    expect(deadline.passed).toBe(true);
    await expect(deadline.git(git)(['status'])).rejects.toBeInstanceOf(SnapshotTooSlow);
    expect(calls).toEqual([]);
  });

  it('a call that fails with the deadline passed throws, so that only the deadline is said', async () => {
    const clock = { t: 0 };
    const deadline = new SnapshotDeadline(() => clock.t);
    clock.t = SNAPSHOT_DEADLINE_MS - 1_000;
    // The call runs into the deadline and is stopped there: it fails as git does.
    const stopped = recordingGit(clock, FAILED, 1_000);
    await expect(deadline.git(stopped.git)(['fetch'])).rejects.toBeInstanceOf(SnapshotTooSlow);
    expect(stopped.calls.map((o) => o?.timeoutMs)).toEqual([1_000]);
  });

  it('answers a call that succeeds past the deadline, and a failure before it', async () => {
    const clock = { t: 0 };
    const deadline = new SnapshotDeadline(() => clock.t);
    // A failure before the deadline is the call's own: the caller reads it.
    expect(await deadline.git(recordingGit(clock, FAILED).git)(['merge-base'])).toEqual(FAILED);
    // A call that ends well, even past the deadline, answers: the caller checks the deadline.
    clock.t = SNAPSHOT_DEADLINE_MS - 1;
    const late = recordingGit(clock, OK, 10);
    expect(await deadline.git(late.git)(['cat-file'])).toEqual(OK);
    expect(deadline.passed).toBe(true);
  });
});
