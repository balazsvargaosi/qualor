import { describe, expect, it } from 'vitest';
import { outputLimitFieldFor } from '../../server/src/llm/settings';

/**
 * Plan 6I-3 Task 14 (4): the AI settings page picks the output limit parameter of an
 * OpenAI-compatible base URL, and the server (and so the evaluation) picks it for the same URL.
 * They are two copies of one rule, so this pins them equal.
 *
 * The page's module is loaded by a variable path: it reaches the UI's whole API layer, which this
 * folder's TypeScript project does not compile (the UI has its own), and the test needs only the
 * one function.
 */
const DRAFT = '../../ui/src/app/settings/ai/provider-draft';
type Draft = { defaultOutputLimitField: (url: string) => string };

describe('the output limit parameter of a base URL', () => {
  const urls: [string, 'max_tokens' | 'max_completion_tokens'][] = [
    ['https://api.openai.com/v1', 'max_completion_tokens'],
    ['https://API.OpenAI.com/v1/', 'max_completion_tokens'],
    ['https://my-resource.openai.azure.com/openai/v1', 'max_completion_tokens'],
    ['https://eastus.api.cognitive.microsoft.com/openai', 'max_tokens'],
    ['http://vllm.internal:8000/v1', 'max_tokens'],
    ['http://localhost:11434/v1', 'max_tokens'],
    ['https://api.openai.com.evil.example/v1', 'max_tokens'],
    ['not a url', 'max_tokens'],
    ['', 'max_tokens'],
  ];

  it.each(urls)('the page and the server agree for %s', async (url, field) => {
    const { defaultOutputLimitField } = (await import(/* @vite-ignore */ DRAFT)) as Draft;
    expect(defaultOutputLimitField(url)).toBe(field);
    expect(outputLimitFieldFor(url)).toBe(field);
  });
});
