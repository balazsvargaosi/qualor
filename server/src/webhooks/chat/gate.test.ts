import type { GateResult } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { chatGateDeliveries, chatGateMessage, type ChatGateInput } from './gate';

const failedGate: GateResult = {
  status: 'failed',
  gate: { id: 'builtin:qualor-way', name: 'Qualor way' },
  conditions: [
    ...Array.from({ length: 6 }, () => ({
      metric: 'new_issues',
      operator: 'gt' as const,
      threshold: 0,
      value: 3,
      status: 'failed' as const,
    })),
    { metric: 'new_coverage', operator: 'lt', threshold: 80, value: 90, status: 'passed' },
  ],
  ignoredConditions: [],
  warnings: [],
};
const passed: GateResult = { ...failedGate, status: 'passed', conditions: [] };
const input = (over: Partial<ChatGateInput> = {}): ChatGateInput => ({
  project: { id: '0190a6c2-0000-7000-8000-0000000000a1', key: 'acme/p', name: 'P' },
  branch: { id: '0190a6c2-0000-7000-8000-0000000000b1', name: 'main', isMain: true },
  analysisId: '0190a6c2-0000-7000-8000-0000000000c1',
  revision: 'abc',
  at: new Date('2026-10-19T07:05:00Z'),
  previous: 'passed',
  next: failedGate,
  measures: { new_security_issues: 1, new_reliability_issues: 2, new_maintainability_issues: 0 },
  cause: 'analysis',
  ...over,
});

describe('chatGateMessage', () => {
  it('builds gate.failed with at most 5 failed conditions and the new-code counts', () => {
    const m = chatGateMessage(input());
    expect(m?.type).toBe('gate');
    if (m?.type !== 'gate') return;
    expect(m.event).toBe('gate.failed');
    expect(m.failed).toHaveLength(5);
    expect(m.failedCount).toBe(6);
    expect(m.newIssues).toEqual({ security: 1, reliability: 2, maintainability: 0 });
    expect(m.at).toBe('2026-10-19T07:05:00.000Z');
  });

  it('builds gate.recovered from failed to passed', () => {
    const m = chatGateMessage(input({ previous: 'failed', next: passed }));
    expect(m?.type === 'gate' && m.event).toBe('gate.recovered');
  });

  it.each([
    [
      'another branch',
      input({
        branch: { id: '0190a6c2-0000-7000-8000-0000000000b2', name: 'feature', isMain: false },
      }),
    ],
    ['failed again', input({ previous: 'failed' })],
    ['passed again', input({ next: passed })],
    ['failed to error', input({ previous: 'failed', next: { ...passed, status: 'error' } })],
  ])('sends nothing for %s', (_label, i) => {
    expect(chatGateMessage(i)).toBeNull();
  });

  it('a first analysis that fails is gate.failed', () => {
    const m = chatGateMessage(input({ previous: null }));
    expect(m?.type === 'gate' && m.event).toBe('gate.failed');
  });
});

describe('chatGateDeliveries', () => {
  const subs = [
    { id: 'g', kind: 'generic' as const, events: ['analysis.completed', 'gate.status_changed'] },
    { id: 's', kind: 'slack' as const, events: ['gate.failed', 'gate.recovered'] },
    { id: 't', kind: 'teams' as const, events: ['gate.recovered', 'digest.weekly'] },
  ];

  it('queues the event for the chat webhooks that subscribe to it, never a generic one', () => {
    expect(chatGateDeliveries(subs, input()).map((d) => [d.subscriptionId, d.event])).toEqual([
      ['s', 'gate.failed'],
    ]);
    expect(
      chatGateDeliveries(subs, input({ previous: 'failed', next: passed })).map(
        (d) => d.subscriptionId,
      ),
    ).toEqual(['s', 't']);
  });
});
