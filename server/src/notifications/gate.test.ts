import { describe, expect, it } from 'vitest';
import { gateEvent } from './gate';

describe('gateEvent (mail E3 N2)', () => {
  it.each([
    [null, 'failed', 'gate.failed'],
    ['passed', 'failed', 'gate.failed'],
    ['error', 'failed', 'gate.failed'],
    ['none', 'failed', 'gate.failed'],
    ['failed', 'failed', null],
    ['failed', 'passed', 'gate.recovered'],
    ['failed', 'error', null],
    ['failed', 'none', null],
    [null, 'passed', null],
    ['passed', 'passed', null],
    ['error', 'passed', null],
    ['none', 'passed', null],
    [null, 'error', null],
    [null, 'none', null],
  ] as const)('%s → %s: %s', (previous, next, event) => {
    expect(gateEvent(previous, next)).toBe(event);
  });
});
