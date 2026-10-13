import { gateStage } from '../gates/stage';
import { measuresStage } from '../measures/stage';
import { notificationStage } from '../notifications/stage';
import { rulesStage } from '../rules/stage';
import { scmStage } from '../scm/stage';
import { trackingStage } from '../tracking/stage';
import { webhookStage } from '../webhooks/stage';
import type { IngestionStage } from './process';

/**
 * Order matters: each stage reads what earlier ones put in `ctx.state` (state.ts). The SCM stage
 * only enqueues a decoration job (scm.md §4.1). The webhook stage is the last stage that may
 * touch the analysis (stages.test.ts): its payload is the analysis as ingestion stores it. Only
 * the notification stage (mail E3), which writes no analysis column, comes after it.
 */
export const DEFAULT_STAGES: readonly IngestionStage[] = [
  rulesStage,
  trackingStage,
  measuresStage,
  gateStage,
  scmStage,
  webhookStage,
  notificationStage,
];
