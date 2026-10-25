import type { ScmConnectionRow } from '../scm/connections';
import { readMergeRequestState } from '../scm/mr-state';
import { ScmError } from '../scm/provider';
import type { ReviewJobDeps } from './job';
import { endReply, type ReplyEnd, type ReplyRow } from './replies';
import { queueAfterCircuit, REPLY_CIRCUIT_WAIT_SECONDS } from './reply-queue';
import type { ThreadSide } from './reply-sides';

/*
 * What the two kinds of row of the `ai-reply` job share: a reply's flow (reply-job.ts) and a
 * command's (reply-commands.ts). The merge request of a row, what a go through the circuit and the
 * first go answer, and the steps both flows take: the merge request's state, a go through the
 * connection's circuit, and the row's end.
 */

/** What a go through the circuit answers when the circuit did not let it through: the row waits. */
export const WAITING = Symbol('waiting');

/** What the first go answers for a merge request that is merged or closed. */
export const CLOSED = Symbol('closed');

/** The merge request of a row, its project and the connection the project is mapped to now. */
export interface Target {
  branch: { id: string; name: string; lastAnalysisId: string | null };
  project: {
    id: string;
    organizationId: string;
    scmConnectionId: string | null;
    scmProjectRef: string | null;
  };
  connection: ScmConnectionRow | null;
}

export const THREAD_GONE: ReplyEnd = { status: 'skipped', reason: 'thread_gone' };

/** The job of one row, in the steps both flows take. */
export abstract class JobSteps {
  constructor(protected readonly deps: ReviewJobDeps) {}

  /**
   * Whether the merge request is merged or closed, read as the review job reads it, through no
   * organisation slot: a state that cannot be read lets the job go on.
   */
  protected async closed(row: Pick<ReplyRow, 'projectId'>, target: Target): Promise<boolean> {
    const { db, scm } = this.deps;
    const state = await readMergeRequestState({ db, scm }, row.projectId, target.branch.name);
    return state !== null && state.state !== 'open';
  }

  /**
   * `step`, a go of the job's own requests, through the connection's circuit as the `scm` worker's
   * jobs pass it (scm.md §4.2). A circuit that is open, or half-open with another job's probe in
   * flight, does not let it through: the row goes back to the queue for when the circuit reopens,
   * or {@link REPLY_CIRCUIT_WAIT_SECONDS} on when that is not known, no try of the job is spent, and
   * the answer is WAITING. The circuit hears what came of a go it let through: a request that came
   * back, whatever it says, is an answer (the provider is up), and one that failed is reported by
   * its error ({@link CircuitBreaker.reportError}); an error of Qualor's own hands a probe on.
   */
  protected async throughCircuit<T>(
    row: ReplyRow,
    side: Pick<ThreadSide, 'connectionId'>,
    step: () => Promise<T>,
  ): Promise<T | typeof WAITING> {
    const { circuit } = this.deps.scmRuntime;
    const { connectionId } = side;
    if (!circuit.tryPass(connectionId)) {
      const until = circuit.openUntil(connectionId);
      const waitSeconds =
        until === null
          ? REPLY_CIRCUIT_WAIT_SECONDS
          : Math.max(1, Math.ceil((until - Date.now()) / 1000));
      if (await queueAfterCircuit(this.deps.db, row, waitSeconds)) {
        this.deps.logger.info(
          { replyId: row.id, connectionId, retryInSeconds: waitSeconds },
          'AI reply waits for the circuit of its SCM connection',
        );
      }
      return WAITING;
    }
    try {
      const done = await step();
      circuit.success(connectionId);
      return done;
    } catch (err) {
      if (err instanceof ScmError) circuit.reportError(connectionId, err);
      else circuit.release(connectionId);
      throw err;
    }
  }

  /** Ends the row, and says so once: its id and how it ended. */
  protected async end(row: Pick<ReplyRow, 'id'>, end: ReplyEnd): Promise<void> {
    await endReply(this.deps.db, row.id, end);
    this.deps.logger.info(
      {
        replyId: row.id,
        status: end.status,
        outcome: end.outcome ?? null,
        reason: end.reason ?? null,
      },
      'AI reply ended',
    );
  }

  /** Ends the row `failed: internal`, with why, in Qualor's words. */
  protected async failInternal(row: Pick<ReplyRow, 'id'>, why: string): Promise<void> {
    this.deps.logger.warn({ replyId: row.id }, `AI reply not answered: ${why}`);
    await this.end(row, { status: 'failed', reason: 'internal' });
  }
}
