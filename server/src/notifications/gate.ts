import type { GateResult } from '@qualor/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Executor, Tx } from '../db/client';
import type { BranchKind, GateStatus } from '../db/schema';
import { queueMail } from '../mail/outbox';
import { mailConfigured } from '../mail/settings';
import type { MeasureMap } from '../mail/templates/notify-common';
import { renderGateFailed } from '../mail/templates/notify-gate-failed';
import { renderGateRecovered } from '../mail/templates/notify-gate-recovered';
import type { NotifyDeps } from './deps';
import { watchLinks, withUnsubscribe } from './links';
import { watchersFor } from './recipients';

export type GateEvent = 'gate.failed' | 'gate.recovered';

/**
 * mail E3 N2: `gate.failed` when the status becomes failed from anything else (a branch's first
 * analysis included), `gate.recovered` from failed to passed; nothing otherwise (failed → error or
 * none says nothing about the code).
 */
export function gateEvent(previous: GateStatus | null, next: GateStatus): GateEvent | null {
  if (next === 'failed' && previous !== 'failed') return 'gate.failed';
  if (previous === 'failed' && next === 'passed') return 'gate.recovered';
  return null;
}

export interface GateChange {
  project: { id: string; name: string };
  branch: {
    id: string;
    name: string;
    kind: BranchKind;
    isMain: boolean;
    mrTitle: string | null;
    mrTargetBranch: string | null;
  };
  analysis: { id: string; revision: string | null };
  previous: GateStatus | null;
  next: GateResult;
  measures: MeasureMap;
  cause: 'analysis' | 'reevaluation';
}

/**
 * Queues one message per watcher in `tx` (the ingestion's or the re-evaluation's), so a rollback
 * sends nothing. Not deduplicated (N7). Returns how many were queued.
 */
export async function notifyGateChange(
  tx: Executor,
  deps: NotifyDeps,
  change: GateChange,
): Promise<number> {
  const event = gateEvent(change.previous, change.next.status);
  if (event === null) return 0;
  // Once per event: with mail off nobody gets anything, so no recipient query either.
  if (!(await mailConfigured(tx, deps.config))) return 0;
  const watchers = await watchersFor(tx, {
    projectId: change.project.id,
    event,
    branchIsMain: change.branch.isMain,
    demoUser: deps.config.demoUser,
  });
  let count = 0;
  for (const watcher of watchers) {
    const links = watchLinks(deps.config, watcher.userId, change.project.id);
    const input = {
      project: change.project,
      branch: {
        id: change.branch.id,
        name: change.branch.name,
        kind: change.branch.kind,
        mrTitle: change.branch.mrTitle,
        mrTargetBranch: change.branch.mrTargetBranch,
      },
      revision: change.analysis.revision,
      gate: change.next,
      measures: change.measures,
      cause: change.cause,
      links,
    };
    const result = await queueMail(tx, deps, {
      kind: event === 'gate.failed' ? 'notify.gate-failed' : 'notify.gate-recovered',
      to: { address: watcher.email, userId: watcher.userId },
      render: () =>
        withUnsubscribe(
          event === 'gate.failed' ? renderGateFailed(input) : renderGateRecovered(input),
          deps.config.publicUrl,
          links.token,
        ),
    });
    // A `skipped` here is an address mail cannot take: the next watcher still gets theirs.
    if (result.status === 'queued') count += 1;
  }
  return count;
}

/**
 * {@link notifyGateChange} inside a savepoint: a failure (a render bug, a refused row) rolls back
 * only the notifications and is logged, so it never fails the analysis or the re-evaluation.
 */
export async function notifyGateChangeSafely(
  tx: Tx,
  deps: NotifyDeps | null,
  change: GateChange,
  logger?: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  // Most analyses change nothing worth a message: decide before paying for the savepoint (two
  // round trips inside the ingestion transaction).
  if (deps === null || gateEvent(change.previous, change.next.status) === null) return;
  try {
    await tx.transaction((savepoint) => notifyGateChange(savepoint, deps, change));
  } catch (err) {
    // The class only: a database error's message carries the query's parameters (the watchers'
    // addresses, the subject), and an address is never logged above debug (E1's webhook alert).
    logger?.warn(
      {
        analysisId: change.analysis.id,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      },
      'project notifications could not be queued',
    );
  }
}
