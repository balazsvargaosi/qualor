/** llm.md §6–§8: the three AI features, each with its prompt version and output token limit. */
export const LLM_FEATURES = ['explain', 'triage', 'fix'] as const;
export type LlmFeature = (typeof LLM_FEATURES)[number];

/** Whether a request row’s feature is one of the three single-shot features (not `review` or `review-reply`). */
export function isLlmFeature(feature: string): feature is LlmFeature {
  return (LLM_FEATURES as readonly string[]).includes(feature);
}

export const PROMPT_VERSIONS = {
  explain: 'explain.v1',
  triage: 'triage.v1',
  fix: 'fix.v1',
} as const satisfies Record<LlmFeature, string>;

export const MAX_OUTPUT_TOKENS = {
  explain: 1_200,
  triage: 800,
  fix: 1_500,
} as const satisfies Record<LlmFeature, number>;

/** llm.md §5.1: what leaves the server, as the settings page and the issue view name it. */
export const LLM_DATA_FIELDS = ['rule', 'message', 'path', 'language', 'snippet'] as const;
