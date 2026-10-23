import { GIT_LOCAL_TIMEOUT_MS, type Git } from '../git/git';

/**
 * The longest the snapshot path may take to build its snapshot (6I-3): the gate wait comes after
 * it, and a fetch that stalls must not hold the CI job until its own timeout.
 */
export const SNAPSHOT_DEADLINE_MS = 10 * 60_000;

/** The snapshot path is past its deadline: no snapshot is sent, and one warning says so. */
export class SnapshotTooSlow extends Error {
  override name = 'SnapshotTooSlow';
  constructor() {
    super('the repository snapshot took longer than its deadline');
  }
}

/** When the snapshot path must have built its snapshot by, on the scan's clock. */
export class SnapshotDeadline {
  private readonly at: number;

  constructor(private readonly now: () => number) {
    this.at = now() + SNAPSHOT_DEADLINE_MS;
  }

  /** The time left, in milliseconds: zero or less once it has passed. */
  leftMs(): number {
    return this.at - this.now();
  }

  get passed(): boolean {
    return this.leftMs() <= 0;
  }

  /**
   * `git` that starts no call once the deadline has passed, and stops a call still running at the
   * deadline: its timeout is cut to the time left. A call that failed with the deadline passed was
   * cut by it (or came too late to matter): it throws SnapshotTooSlow rather than answer, so that
   * only the deadline is said, not the failure of the call it cut.
   */
  git(git: Git): Git {
    return async (args, options) => {
      const left = this.leftMs();
      if (left <= 0) throw new SnapshotTooSlow();
      const timeoutMs = Math.min(options?.timeoutMs ?? GIT_LOCAL_TIMEOUT_MS, left);
      const result = await git(args, { ...options, timeoutMs });
      if (result.code !== 0 && this.passed) throw new SnapshotTooSlow();
      return result;
    };
  }
}
