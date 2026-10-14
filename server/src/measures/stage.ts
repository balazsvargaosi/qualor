import type { IngestionStage } from '../ingest/process';
import { newCodeClassifier } from '../newcode/lines';
import { issueMeasures, reportMeasures } from './compute';
import {
  replaceBranchDependencies,
  replaceBranchFiles,
  resolvedIssueCounts,
  visibleIssueCounts,
  writeMeasures,
} from './store';

/**
 * Server step 10: the analysis's measures (gates.md §2–§3) from the report plus the issue state
 * tracking just wrote, stored in `measures`, and the branch's latest file snapshot in
 * `branch_files` and dependency inventory in `branch_dependencies`. Runs after the tracking stage.
 */
export const measuresStage: IngestionStage = {
  name: 'measures',
  async run(ctx) {
    const classifier = newCodeClassifier(ctx.report);
    const { accepted, falsePositives } = await resolvedIssueCounts(ctx.tx, ctx.branch.id);
    const values = {
      ...reportMeasures(ctx.report, classifier),
      ...issueMeasures(
        await visibleIssueCounts(ctx.tx, ctx.branch.id),
        accepted,
        falsePositives,
        ctx.report.scm.baseline.status === 'unavailable',
      ),
    };
    await writeMeasures(ctx.tx, ctx.analysisId, values);
    await replaceBranchFiles(ctx.tx, ctx.branch.id, ctx.analysisId, ctx.report, classifier);
    // 6M §4: only a report that carries an inventory (even an empty one) replaces the snapshot.
    if (ctx.report.dependencies !== undefined) {
      await replaceBranchDependencies(
        ctx.tx,
        ctx.branch.id,
        ctx.analysisId,
        ctx.report.dependencies,
      );
    }
    ctx.state.measures = values;
  },
};
