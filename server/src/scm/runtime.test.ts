import { describe, expect, it } from 'vitest';
import { CircuitBreaker, ConnectionHealth } from './runtime';

describe('the circuit breaker of a connection (scm.md §4.2)', () => {
  it('opens after the threshold, then lets one probe through; the others wait for its answer', () => {
    let now = 0;
    const circuit = new CircuitBreaker(() => now, 2, 1_000);
    expect(circuit.tryPass('k')).toBe(true);
    circuit.failure('k');
    expect(circuit.tryPass('k')).toBe(true);
    circuit.failure('k');
    expect(circuit.openUntil('k')).toBe(1_000);
    expect(circuit.tryPass('k')).toBe(false);
    now = 1_001;
    expect(circuit.tryPass('k')).toBe(true); // the probe
    expect(circuit.tryPass('k')).toBe(false); // a second job waits for the probe's answer
    circuit.failure('k'); // the probe failed: open again for a whole window
    expect(circuit.openUntil('k')).toBe(2_001);
    expect(circuit.tryPass('k')).toBe(false);
    now = 2_002;
    expect(circuit.tryPass('k')).toBe(true);
    circuit.success('k'); // the probe succeeded: closed, every job goes through
    expect(circuit.openUntil('k')).toBeNull();
    expect(circuit.tryPass('k')).toBe(true);
    expect(circuit.tryPass('k')).toBe(true);
  });

  it('hands the probe to the next job when it ends without an answer from GitLab', () => {
    let now = 0;
    const circuit = new CircuitBreaker(() => now, 1, 1_000);
    circuit.failure('k');
    now = 1_001;
    expect(circuit.tryPass('k')).toBe(true);
    expect(circuit.tryPass('k')).toBe(false);
    circuit.release('k'); // the organisation's slots were taken, say: no request was made
    expect(circuit.tryPass('k')).toBe(true);
    expect(circuit.openUntil('k')).toBeNull(); // the window is over; the probe decides
  });

  it('keeps connections apart, and releasing a closed circuit changes nothing', () => {
    const circuit = new CircuitBreaker(() => 0, 1, 1_000);
    circuit.failure('a');
    expect(circuit.tryPass('a')).toBe(false);
    expect(circuit.tryPass('b')).toBe(true);
    circuit.release('b');
    expect(circuit.tryPass('b')).toBe(true);
  });
});

describe('what the support bundle reads of a connection (4E-3b §1)', () => {
  it('inspects the circuit without changing it', () => {
    let now = 0;
    const circuit = new CircuitBreaker(() => now, 2, 1_000);
    expect(circuit.inspect('k')).toEqual({ state: 'closed', failures: 0, openedAt: null });
    circuit.failure('k');
    expect(circuit.inspect('k')).toEqual({ state: 'closed', failures: 1, openedAt: null });
    now = 50;
    circuit.failure('k');
    expect(circuit.inspect('k')).toEqual({ state: 'open', failures: 2, openedAt: new Date(50) });
    now = 1_051;
    expect(circuit.inspect('k')).toEqual({
      state: 'half-open',
      failures: 2,
      openedAt: new Date(50),
    });
    expect(circuit.tryPass('k')).toBe(true); // inspecting took no probe
  });

  it('keeps the last outcome of each connection', () => {
    const health = new ConnectionHealth(() => 7);
    expect(health.get('a')).toBeNull();
    health.record('a', 'GitLab answered 502');
    expect(health.get('a')).toEqual({ ok: false, error: 'GitLab answered 502', at: new Date(7) });
    health.record('a', null);
    expect(health.get('a')).toEqual({ ok: true, error: null, at: new Date(7) });
  });
});
