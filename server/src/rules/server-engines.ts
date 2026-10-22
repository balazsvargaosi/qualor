/** The engine of the licence policy findings, which the server makes itself (6M §6). */
export const LICENSE_ENGINE = 'license';

/** The engine of the AI review's findings, which the server's review runs make (6I-3). */
export const AI_ENGINE = 'ai';

/**
 * Engines only the server runs. A report can neither define their rules (rules/catalog.ts), nor
 * send their findings (rules/stage.ts), nor say that they ran (tracking/plan.ts
 * `serverOkEngines`): each would let a report change, keep or close issues the server alone
 * decides (6M Review Focus 1).
 */
export const SERVER_ENGINES: ReadonlySet<string> = new Set([LICENSE_ENGINE, AI_ENGINE]);
