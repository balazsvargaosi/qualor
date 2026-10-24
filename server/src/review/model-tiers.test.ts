import { describe, expect, it } from 'vitest';
import type { StoredProvider } from '../llm/settings';
import { distinctModels, modelFor, tierModels } from './model-tiers';

const PROVIDER: StoredProvider = {
  kind: 'openai',
  baseUrl: 'https://llm.example/v1',
  model: 'sonnet',
  strongModel: null,
  fastModel: null,
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_tokens',
  temperature: null,
  timeoutSeconds: 60,
  apiKeyEnc: null,
};

const withTiers = (strongModel: string | null, fastModel: string | null): StoredProvider => ({
  ...PROVIDER,
  strongModel,
  fastModel,
});

describe('the models of the provider’s tiers', () => {
  it('an empty tier falls back to the standard model', () => {
    for (const tier of ['strong', 'standard', 'fast'] as const) {
      expect(modelFor(PROVIDER, tier)).toBe('sonnet');
    }
    // Only the tier that is empty falls back.
    expect(modelFor(withTiers('opus', null), 'fast')).toBe('sonnet');
    expect(modelFor(withTiers(null, 'haiku'), 'strong')).toBe('sonnet');
  });

  it('gives a tier its own model, and the standard tier always the standard one', () => {
    const provider = withTiers('opus', 'haiku');
    expect(modelFor(provider, 'strong')).toBe('opus');
    expect(modelFor(provider, 'standard')).toBe('sonnet');
    expect(modelFor(provider, 'fast')).toBe('haiku');
  });

  describe('tierModels', () => {
    it('is the standard model alone while no tier has a model of its own', () => {
      expect(tierModels(PROVIDER)).toEqual([{ tier: 'standard', model: 'sonnet' }]);
    });

    it('lists the standard model first, then the strong and the fast one', () => {
      expect(tierModels(withTiers('opus', 'haiku'))).toEqual([
        { tier: 'standard', model: 'sonnet' },
        { tier: 'strong', model: 'opus' },
        { tier: 'fast', model: 'haiku' },
      ]);
      expect(tierModels(withTiers(null, 'haiku'))).toEqual([
        { tier: 'standard', model: 'sonnet' },
        { tier: 'fast', model: 'haiku' },
      ]);
      expect(tierModels(withTiers('opus', null))).toEqual([
        { tier: 'standard', model: 'sonnet' },
        { tier: 'strong', model: 'opus' },
      ]);
    });

    it('lists a model once: a tier set to the standard model, or to a model listed before', () => {
      expect(tierModels(withTiers('sonnet', 'haiku'))).toEqual([
        { tier: 'standard', model: 'sonnet' },
        { tier: 'fast', model: 'haiku' },
      ]);
      expect(tierModels(withTiers('sonnet', 'sonnet'))).toEqual([
        { tier: 'standard', model: 'sonnet' },
      ]);
      // The first tier to name a model keeps it.
      expect(tierModels(withTiers('haiku', 'haiku'))).toEqual([
        { tier: 'standard', model: 'sonnet' },
        { tier: 'strong', model: 'haiku' },
      ]);
    });
  });

  describe('distinctModels', () => {
    it('is the standard model alone without tier models', () => {
      expect(distinctModels(PROVIDER)).toEqual(['sonnet']);
    });

    it('sorts the models, whichever tier each one serves', () => {
      expect(distinctModels(withTiers('opus', 'haiku'))).toEqual(['haiku', 'opus', 'sonnet']);
      expect(distinctModels({ ...withTiers('alpha', 'mid'), model: 'zeta' })).toEqual([
        'alpha',
        'mid',
        'zeta',
      ]);
    });

    it('names a model once', () => {
      expect(distinctModels(withTiers('sonnet', 'sonnet'))).toEqual(['sonnet']);
      expect(distinctModels(withTiers('haiku', 'haiku'))).toEqual(['haiku', 'sonnet']);
    });
  });
});
