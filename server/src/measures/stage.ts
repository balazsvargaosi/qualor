import type { IngestionStage } from '../ingest/process';
import { newCodeClassifier } from '../newcode/lines';
import { dependencyMeasures, issueMeasures, reportMeasures } from './compute';
import {
  dependencyLicenseCounts,
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
    // 6M §4: only a report that carries an inventory (even an empty one) replaces the snapshot.
    if (ctx.report.dependencies !== undefined) {
      await replaceBranchDependencies(
        ctx.tx,
        ctx.branch.id,
        ctx.analysisId,
        ctx.report.dependencies,
      );
    }
    const { accepted, falsePositives } = await resolvedIssueCounts(ctx.tx, ctx.branch.id);
    const values = {
      ...reportMeasures(ctx.report, classifier),
      ...issueMeasures(
        await visibleIssueCounts(ctx.tx, ctx.branch.id),
        accepted,
        falsePositives,
        ctx.report.scm.baseline.status === 'unavailable',
      ),
      // 6M §7: from the snapshot just replaced (this report's inventory, its duplicates merged),
      // or from the one an earlier report left when this one carries none.
      ...dependencyMeasures(await dependencyLicenseCounts(ctx.tx, ctx.branch.id)),
    };
    await writeMeasures(ctx.tx, ctx.analysisId, values);
    await replaceBranchFiles(ctx.tx, ctx.branch.id, ctx.analysisId, ctx.report, classifier);
    ctx.state.measures = values;
  },
};
