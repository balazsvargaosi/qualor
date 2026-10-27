import { describe, expect, it } from 'vitest';
import { isLlmFeature, LLM_FEATURES } from './features';

describe('isLlmFeature', () => {
  it.each(LLM_FEATURES)('is true for %s', (feature) => {
    expect(isLlmFeature(feature)).toBe(true);
  });

  it('is true for explain', () => {
    expect(isLlmFeature('explain')).toBe(true);
  });

  it.each(['review', 'review-reply', '', 'Explain', 'toString'])('is false for %j', (feature) => {
    expect(isLlmFeature(feature)).toBe(false);
  });
});
