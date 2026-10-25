import type { paths } from '../api/schema';

type TestAnswer =
  paths['/api/v0/system/llm/test']['post']['responses'][200]['content']['application/json'];
/** llm.md §14's codes, from the Test answer's schema (Task 8), so this file needs no DM-1 route. */
export type LlmErrorCode = NonNullable<TestAnswer['problem']>['code'];
/** What a Test found out about one model of the provider. */
type TestModel = TestAnswer['models'][number];

/**
 * llm.md §14 in the UI's own words (plan 1F ruling Y3: the server's English text is never shown),
 * for any page but the AI settings: what it says of a field of the settings points at the page
 * (`settingsProblemText` is for the page itself). `providerStatus`, the provider's HTTP status
 * when the Test answer gives one, tells a wrong key (401) from a key that may not do this (403).
 */
export function llmProblemText(code: LlmErrorCode, providerStatus: number | null = null): string {
  switch (code) {
    case 'PROVIDER_TIMEOUT':
      return $localize`:@@ai.problem.timeout:The model did not answer in time; raise the timeout in the AI assistant settings.`;
    case 'PROVIDER_UNAVAILABLE':
      return $localize`:@@ai.problem.unavailable:The model provider could not be reached.`;
    case 'PROVIDER_RATE_LIMITED':
      return $localize`:@@ai.problem.rateLimited:The model provider is rate limiting Qualor; try later.`;
    case 'PROVIDER_REFUSED_KEY':
      if (providerStatus === 403) {
        return $localize`:@@ai.problem.keyForbidden:The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit.`;
      }
      return providerStatus === null
        ? $localize`:@@ai.problem.key:The provider refused the API key.`
        : $localize`:@@ai.problem.keyStatus:The provider refused the API key (HTTP ${providerStatus}:status:).`;
    case 'PROVIDER_WORKSPACE_REQUIRED':
      return $localize`:@@ai.problem.workspaceRequiredInSettings:This key is not scoped to a workspace: give its workspace ID in the AI assistant settings.`;
    case 'PROVIDER_REJECTED_REQUEST':
      return $localize`:@@ai.problem.rejected:The provider refused the request; check the base URL and the model.`;
    case 'PROVIDER_BAD_ANSWER':
      return $localize`:@@ai.problem.badAnswer:The provider's answer was not understood.`;
    case 'URL_NOT_ALLOWED':
      return $localize`:@@ai.problem.url:The provider's address is not allowed; an internal host must be listed in QUALOR_LLM_INTERNAL_HOSTS.`;
    case 'KEY_UNDECRYPTABLE':
      return $localize`:@@ai.problem.undecryptable:The stored API key can no longer be read; set it again.`;
    case 'MALFORMED_OUTPUT':
    case 'OUTPUT_TRUNCATED':
      return $localize`:@@ai.problem.output:The model's answer could not be used.`;
    case 'MODEL_REFUSED':
      return $localize`:@@ai.problem.refused:The model declined to answer.`;
    case 'OUTPUT_REFUSED':
      return $localize`:@@ai.problem.unsafe:The suggested fix was not safe to show.`;
    case 'AI_DISABLED':
      return $localize`:@@ai.problem.disabled:The AI assistant was turned off for this organisation.`;
    case 'SETTINGS_CHANGED':
    case 'ISSUE_CHANGED':
    case 'ISSUE_GONE':
      return $localize`:@@ai.problem.changed:Something changed since you asked; ask again.`;
    case 'REQUEST_ABANDONED':
      return $localize`:@@ai.problem.abandoned:The request was interrupted; ask again.`;
  }
}

/**
 * `llmProblemText` for the AI settings page, where the field a problem is about is on the page, below
 * the message: a key that is not scoped to a workspace is told where the workspace ID goes.
 */
export function settingsProblemText(
  code: LlmErrorCode,
  providerStatus: number | null = null,
): string {
  return code === 'PROVIDER_WORKSPACE_REQUIRED'
    ? $localize`:@@ai.problem.workspaceRequired:This key is not scoped to a workspace: give its workspace ID below.`
    : llmProblemText(code, providerStatus);
}

/** One model's line after a Test of several models: the model, how it fared, and the words for it. */
export interface TestLine {
  model: string;
  tone: 'success' | 'warn' | 'error';
  text: string;
}

/**
 * A Test's finding about one model as a line that starts with the model, so that it says whom it is
 * about: its connection and whether it calls tools (which AI review needs), or why the call failed.
 * A tool check that could not tell leaves the connection alone.
 */
export function testLine(found: TestModel): TestLine {
  const { model, latencyMs } = found;
  if (found.problem) {
    const problem = settingsProblemText(found.problem.code, found.problem.providerStatus);
    return {
      model,
      tone: 'error',
      text: $localize`:@@ai.test.modelProblem:${model}:model:: ${problem}:problem:`,
    };
  }
  switch (found.toolCalling) {
    case 'supported':
      return {
        model,
        tone: 'success',
        text: $localize`:@@ai.test.modelSupported:${model}:model:: connected in ${latencyMs}:latency: ms · tool calling supported`,
      };
    case 'not_supported':
      return {
        model,
        tone: 'warn',
        text: $localize`:@@ai.test.modelNotSupported:${model}:model:: connected in ${latencyMs}:latency: ms · tool calling not supported`,
      };
    case 'not_checked':
      return {
        model,
        tone: 'success',
        text: $localize`:@@ai.test.modelConnected:${model}:model:: connected in ${latencyMs}:latency: ms`,
      };
  }
}
