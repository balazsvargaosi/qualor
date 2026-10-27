import { describe, expect, it } from 'vitest';
import { SCM_CIRCUIT_FAILURES } from '../scm/runtime';
import { CACHE_WRITE_PRICE_FACTOR, costOf, createModelRuntimes, reviewCircuitDeps } from './job';

describe('createModelRuntimes', () => {
  it('keeps the reviews’ circuit apart from the assistant’s', () => {
    const { llm, reviewCircuit } = createModelRuntimes(() => 0);
    const url = 'https://llm.example.test/v1';
    for (let i = 0; i < SCM_CIRCUIT_FAILURES; i += 1) reviewCircuit.failure(url);
    expect(reviewCircuit.tryPass(url)).toBe(false);
    expect(llm.circuit.tryPass(url)).toBe(true);
    for (let i = 0; i < SCM_CIRCUIT_FAILURES; i += 1) llm.circuit.failure('https://other.test/v1');
    expect(reviewCircuit.tryPass('https://other.test/v1')).toBe(true);
  });

  it('wires the review deps to the review circuit, never the llm runtime’s', () => {
    const runtimes = createModelRuntimes(() => 0);
    const { llmCircuit } = reviewCircuitDeps(runtimes);
    expect(llmCircuit).toBe(runtimes.reviewCircuit);
    expect(llmCircuit).not.toBe(runtimes.llm.circuit);
  });
});

describe('costOf (R49)', () => {
  // Fictional prices, in US dollars per million tokens, which is micro-USD per token.
  const pricing = { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cachedInputUsdPerMTok: 0.2 };
  const cachedCall = {
    inputTokens: 10_000,
    outputTokens: 500,
    cacheReadTokens: 8_000,
    cacheWriteTokens: 1_000,
  };

  it('writes to the cache cost 1.25 times the input price', () => {
    expect(CACHE_WRITE_PRICE_FACTOR).toBe(1.25);
  });

  it('prices the uncached input at the input price, the writes at 1.25 times it, the reads at the cached price', () => {
    // 1 000 uncached × 2 + 1 000 written × 2 × 1.25 + 8 000 read × 0.2 + 500 × 10.
    expect(costOf(pricing, cachedCall)).toBe(11_100);
    expect(2_000 + 2_500 + 1_600 + 5_000).toBe(11_100);
  });

  it('prices the reads at the input price when there is no cached price: never understated', () => {
    expect(costOf({ ...pricing, cachedInputUsdPerMTok: null }, cachedCall)).toBe(25_500);
  });

  it('without cache counts is input times its price and output times its price, as before', () => {
    expect(costOf(pricing, { inputTokens: 10_000, outputTokens: 500 })).toBe(25_000);
    expect(
      costOf(pricing, {
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ).toBe(25_000);
    expect(costOf(pricing, { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 0 })).toBe(
      25_000,
    );
  });

  it('is null without prices, or without either count', () => {
    expect(costOf(null, cachedCall)).toBeNull();
    expect(costOf(pricing, { ...cachedCall, inputTokens: null })).toBeNull();
    expect(costOf(pricing, { ...cachedCall, outputTokens: null })).toBeNull();
  });

  it('never prices less than nothing for the uncached rest of counts that pass the input', () => {
    // A provider's counts are its own claim: the rest is no less than 0.
    expect(costOf(pricing, { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 2_000 })).toBe(
      400,
    );
  });
});
