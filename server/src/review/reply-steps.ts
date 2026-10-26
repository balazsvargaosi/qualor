import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { pgErrorCode } from '../db/errors';
import { branches, projects, scmConnections, type BranchKind } from '../db/schema';
import type { ScmConnectionRow } from '../scm/connections';
import { readMergeRequestState } from '../scm/mr-state';
import { ScmError } from '../scm/provider';
import type { CircuitBreaker } from '../scm/runtime';
import type { ReviewJobDeps } from './job';
import { endReply, type ReplyEnd, type ReplyRow } from './replies';
import { queueAfterCircuit, REPLY_CIRCUIT_WAIT_SECONDS } from './reply-queue';
import type { ThreadSide } from './reply-sides';
import { errorClass } from './run-ends';

/*
 * What the jobs of the `ai-reply` queue share: a reply's flow (reply-job.ts), a command's
 * (reply-commands.ts) and a scan's (reply-scan.ts). The merge request of a job, what a go through
 * the circuit and the first go answer, and the steps they take: the merge request's state, a go
 * through the connection's circuit, the failure of the job, and the end of a row.
 */

/** What a go through the circuit answers when the circuit did not let it through: the job waits. */
export const WAITING = Symbol('waiting');

/** What the first go answers for a merge request that is merged or closed. */
export const CLOSED = Symbol('closed');

/** The merge request of a job, its project and the connection the project is mapped to now. */
export interface Target {
  branch: { id: string; kind: BranchKind; name: string; lastAnalysisId: string | null };
  project: {
    id: string;
    organizationId: string;
    scmConnectionId: string | null;
    scmProjectRef: string | null;
  };
  connection: ScmConnectionRow | null;
}

/**
 * The merge request of a branch: the branch, its project and the connection the project is mapped
 * to now. A row of the ledger names its project too, which must be the branch's. Null when there
 * is none such.
 */
export async function targetOf(
  db: Db,
  branchId: string,
  projectId?: string,
): Promise<Target | null> {
  const [found] = await db
    .select({
      branch: {
        id: branches.id,
        kind: branches.kind,
        name: branches.name,
        lastAnalysisId: branches.lastAnalysisId,
      },
      project: {
        id: projects.id,
        organizationId: projects.organizationId,
        scmConnectionId: projects.scmConnectionId,
        scmProjectRef: projects.scmProjectRef,
      },
      connection: scmConnections,
    })
    .from(branches)
    .innerJoin(projects, eq(projects.id, branches.projectId))
    .leftJoin(scmConnections, eq(scmConnections.id, projects.scmConnectionId))
    .where(
      and(
        eq(branches.id, branchId),
        projectId === undefined ? undefined : eq(projects.id, projectId),
      ),
    );
  return found ?? null;
}

export const THREAD_GONE: ReplyEnd = { status: 'skipped', reason: 'thread_gone' };

/**
 * In how many seconds a circuit that let no job through reopens: when its pause ends, or
 * {@link REPLY_CIRCUIT_WAIT_SECONDS} when that is not known (it is half-open, and another job's
 * probe has no answer yet). The SCM connection's circuit and the model provider's are both read so.
 */
export function circuitWaitSeconds(circuit: CircuitBreaker, key: string): number {
  const until = circuit.openUntil(key);
  return until === null
    ? REPLY_CIRCUIT_WAIT_SECONDS
    : Math.max(1, Math.ceil((until - Date.now()) / 1000));
}

/** The job of one merge request or one row, in the steps all its flows take. */
export abstract class JobSteps {
  constructor(protected readonly deps: ReviewJobDeps) {}

  /**
   * Whether the merge request is merged or closed, read as the review job reads it, through no
   * organisation slot, with the installation tokens the job's other requests use: a state that
   * cannot be read lets the job go on.
   */
  protected async closed(row: Pick<ReplyRow, 'projectId'>, target: Target): Promise<boolean> {
    const { db, scm, scmRuntime } = this.deps;
    const state = await readMergeRequestState(
      { db, scm, tokens: scmRuntime },
      row.projectId,
      target.branch.name,
    );
    return state !== null && state.state !== 'open';
  }

  /**
   * `step`, a go of the job's own requests, through the connection's circuit as the `scm` worker's
   * jobs pass it (scm.md §4.2). A circuit that is open, or half-open with another job's probe in
   * flight, does not let it through: `waitFor` is told in how many seconds the circuit reopens, or
   * {@link REPLY_CIRCUIT_WAIT_SECONDS} when that is not known, and puts the job back in the queue for
   * then, with no try of it spent; the answer is WAITING. The circuit hears what came of a go it
   * let through: a request that came back, whatever it says, is an answer (the provider is up),
   * and one that failed is reported by its error ({@link CircuitBreaker.reportError}); an error of
   * Qualor's own hands a probe on.
   */
  protected async passCircuit<T>(
    connectionId: string,
    waitFor: (waitSeconds: number) => Promise<void>,
    step: () => Promise<T>,
  ): Promise<T | typeof WAITING> {
    const { circuit } = this.deps.scmRuntime;
    if (!circuit.tryPass(connectionId)) {
      await waitFor(circuitWaitSeconds(circuit, connectionId));
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

  /**
   * `step` as a go through the circuit ({@link passCircuit}) of a row's job: a refusal queues the
   * row again for when the circuit reopens, and says so once.
   */
  protected throughCircuit<T>(
    row: ReplyRow,
    side: Pick<ThreadSide, 'connectionId'>,
    step: () => Promise<T>,
  ): Promise<T | typeof WAITING> {
    const { connectionId } = side;
    return this.passCircuit(
      connectionId,
      async (waitSeconds) => {
        if (await queueAfterCircuit(this.deps.db, row, waitSeconds)) {
          this.deps.logger.info(
            { replyId: row.id, connectionId, retryInSeconds: waitSeconds },
            'AI reply waits for the circuit of its SCM connection',
          );
        }
      },
      step,
    );
  }

  /**
   * Says once that the job failed, and whether its second try is to come: the codes of the error
   * (its class, the database's code, what the SCM answered), never its message, which may hold
   * what a person or the provider wrote. `what` names the job; `subject` is its row or its branch.
   */
  protected logFailure(
    what: string,
    subject: { replyId: string } | { branchId: string },
    err: unknown,
    lastTry: boolean,
  ): void {
    const fields = {
      ...subject,
      errorClass: errorClass(err),
      code: pgErrorCode(err) ?? null,
      // What the SCM said, never its message.
      ...(err instanceof ScmError ? { errorKind: err.kind, httpStatus: err.status } : {}),
    };
    if (lastTry) this.deps.logger.error(fields, `${what} failed on its last try`);
    else this.deps.logger.warn(fields, `${what} did not finish; its job is tried again`);
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
