import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../test/config';
import type { Tx } from '../db/client';
import type { GateStatus } from '../db/schema';
import { notifyDeps } from './deps';
import { gateEvent, notifyGateChangeSafely, type GateChange } from './gate';

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

describe('notifyGateChangeSafely', () => {
  const change = (previous: GateStatus | null, next: GateStatus): GateChange => ({
    project: { id: 'p', name: 'p' },
    branch: {
      id: 'b',
      name: 'main',
      kind: 'branch',
      isMain: true,
      mrTitle: null,
      mrTargetBranch: null,
    },
    analysis: { id: 'a', revision: null },
    previous,
    next: { status: next, gate: null, conditions: [], ignoredConditions: [], warnings: [] },
    measures: {},
    cause: 'analysis',
  });

  it('opens no savepoint when the change is no event (most analyses)', async () => {
    const transaction = vi.fn(async () => undefined);
    const tx = { transaction } as unknown as Tx;
    await notifyGateChangeSafely(tx, notifyDeps(testConfig()), change('passed', 'passed'));
    await notifyGateChangeSafely(tx, notifyDeps(testConfig()), change('failed', 'failed'));
    expect(transaction).not.toHaveBeenCalled();
    await notifyGateChangeSafely(tx, notifyDeps(testConfig()), change('passed', 'failed'));
    expect(transaction).toHaveBeenCalledOnce();
  });
});
