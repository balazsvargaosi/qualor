import type { IngestionStage } from '../ingest/process';
import { requireState } from '../ingest/state';
import { notifyGateChangeSafely } from './gate';

/**
 * mail E3: after `webhooks`, in the ingestion transaction (a rollback queues nothing). It writes
 * no analysis column, so the webhook payload still matches the stored analysis.
 */
export const notificationStage: IngestionStage = {
  name: 'notifications',
  async run(ctx) {
    // Nothing to do without notification deps (tests, tools): read no state, so a test may put
    // this stage anywhere.
    if (ctx.notify === null) return;
    await notifyGateChangeSafely(
      ctx.tx,
      ctx.notify,
      {
        project: ctx.project,
        branch: ctx.branch,
        analysis: { id: ctx.analysisId, revision: ctx.report.scm.revision },
        previous: ctx.previousAnalysis?.gateStatus ?? null,
        next: requireState(ctx.state, 'gate'),
        measures: requireState(ctx.state, 'measures'),
        cause: 'analysis',
      },
      ctx.logger,
    );
  },
};
