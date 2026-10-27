import { describe, expect, it } from 'vitest';
import { providerToken } from './ai-review';

describe('providerToken (telemetry.md, R39)', () => {
  it('names the provider by its kind and API only', () => {
    expect(providerToken(null)).toBe('none');
    expect(providerToken({ kind: 'anthropic', api: 'chat_completions' })).toBe('anthropic');
    expect(providerToken({ kind: 'openai', api: 'chat_completions' })).toBe(
      'openai_chat_completions',
    );
    expect(providerToken({ kind: 'openai', api: 'responses' })).toBe('openai_responses');
  });
});
