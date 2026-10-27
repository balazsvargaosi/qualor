import { describe, expect, it } from 'vitest';
import { ERROR_TEXTS, errorCodeOf, LLM_ERROR_CODES, TRANSIENT_FAILURES } from './errors';
import { LLM_FAILURES } from './providers';

describe('the failures of a provider call and their codes (llm.md §14)', () => {
  it('gives every failure a code of its own, and every code its text', () => {
    const codes = LLM_FAILURES.map((failure) => errorCodeOf({ failure }));
    expect(new Set(codes).size).toBe(LLM_FAILURES.length);
    for (const code of codes) expect(LLM_ERROR_CODES).toContain(code);
    for (const code of LLM_ERROR_CODES) expect(ERROR_TEXTS[code]).not.toBe('');
  });

  it('gives a key that is not scoped to a workspace a code of its own, with its fixed text, and does not retry it', () => {
    expect(errorCodeOf({ failure: 'workspace_required' })).toBe('PROVIDER_WORKSPACE_REQUIRED');
    expect(ERROR_TEXTS.PROVIDER_WORKSPACE_REQUIRED).toBe(
      'This key is not scoped to a workspace: give its workspace ID in the AI provider settings.',
    );
    // The provider answered and no wait mends a setting: it is neither retried nor held against it.
    expect(TRANSIENT_FAILURES.has('workspace_required')).toBe(false);
  });
});
