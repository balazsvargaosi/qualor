import { describe, expect, it } from 'vitest';
import { SCM_CIRCUIT_FAILURES } from '../scm/runtime';
import { createModelRuntimes, reviewCircuitDeps } from './job';

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
