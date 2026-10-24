import { describe, expect, it } from 'vitest';
import { sameProvider } from './job';
import type { ReviewProvider } from './settings';

const PROVIDER: ReviewProvider = {
  url: 'https://llm.example/v1',
  host: 'llm.example',
  model: 'sonnet',
  models: ['haiku', 'opus', 'sonnet'],
};

describe('sameProvider', () => {
  it('is true for a provider with the same address, host, model and models', () => {
    expect(sameProvider(PROVIDER, PROVIDER)).toBe(true);
    expect(sameProvider({ ...PROVIDER, models: [...PROVIDER.models] }, PROVIDER)).toBe(true);
    const alone: ReviewProvider = { ...PROVIDER, models: ['sonnet'] };
    expect(sameProvider({ ...alone }, alone)).toBe(true);
  });

  it('sameProvider tells a changed tier', () => {
    // A tier moved to another model, a tier that gained a model, one that lost its model.
    for (const models of [
      ['haiku', 'opus-next', 'sonnet'],
      ['haiku-next', 'opus', 'sonnet'],
      ['opus', 'sonnet'],
      ['sonnet'],
      ['haiku', 'opus', 'sonnet', 'sonnet-next'],
    ]) {
      expect(sameProvider({ ...PROVIDER, models }, PROVIDER), models.join()).toBe(false);
      expect(sameProvider(PROVIDER, { ...PROVIDER, models }), models.join()).toBe(false);
    }
  });

  it('is false for no provider, and for another address, host or standard model', () => {
    expect(sameProvider(null, PROVIDER)).toBe(false);
    expect(sameProvider({ ...PROVIDER, url: 'https://llm.example/tenant/v1' }, PROVIDER)).toBe(
      false,
    );
    expect(sameProvider({ ...PROVIDER, host: 'llm.example:8443' }, PROVIDER)).toBe(false);
    expect(sameProvider({ ...PROVIDER, model: 'opus' }, PROVIDER)).toBe(false);
  });
});
