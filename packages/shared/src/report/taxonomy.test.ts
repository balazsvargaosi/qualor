import { describe, expect, it } from 'vitest';
import { findingConfidence } from './taxonomy';

describe('findingConfidence', () => {
  it("reads the C# taint engine's high and medium from Qualor's findings", () => {
    expect(findingConfidence({ engineId: 'qualor', properties: { confidence: 'medium' } })).toBe(
      'medium',
    );
    expect(findingConfidence({ engineId: 'qualor', properties: { confidence: 'high' } })).toBe(
      'high',
    );
  });

  it('is not set without the property (the OpenGrep rules) or with another value', () => {
    expect(findingConfidence({ engineId: 'qualor' })).toBeUndefined();
    expect(findingConfidence({ engineId: 'qualor', properties: {} })).toBeUndefined();
    expect(findingConfidence({ engineId: 'qualor', properties: { confidence: 'HIGH' } })).toBe(
      undefined,
    );
    expect(findingConfidence({ engineId: 'qualor', properties: { confidence: 0.9 } })).toBe(
      undefined,
    );
  });

  it("ignores another analyzer's property of the same name", () => {
    expect(findingConfidence({ engineId: 'bandit', properties: { confidence: 'medium' } })).toBe(
      undefined,
    );
  });
});
