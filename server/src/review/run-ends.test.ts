import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { logRunEnd } from './run-ends';

const logged = () => {
  const lines: unknown[][] = [];
  const logger = { info: (...args: unknown[]) => void lines.push(args) } as unknown as Logger;
  return { logger, lines };
};

describe('logRunEnd', () => {
  it('names the detail of a run that has one, as a window failure is told from a provider error', () => {
    const { logger, lines } = logged();
    logRunEnd(logger, 'run-1', {
      status: 'failed',
      reason: 'provider_error',
      detail: 'window_full',
    });
    logRunEnd(logger, 'run-2', { status: 'failed', reason: 'provider_error' });
    logRunEnd(logger, 'run-3', { status: 'skipped', reason: 'budget_spent', detail: 'too_large' });
    logRunEnd(logger, 'run-4', { status: 'superseded' });
    expect(lines).toEqual([
      [
        { runId: 'run-1', status: 'failed', reason: 'provider_error', detail: 'window_full' },
        'AI review run ended',
      ],
      [{ runId: 'run-2', status: 'failed', reason: 'provider_error' }, 'AI review run ended'],
      [
        { runId: 'run-3', status: 'skipped', reason: 'budget_spent', detail: 'too_large' },
        'AI review run ended',
      ],
      [{ runId: 'run-4', status: 'superseded', reason: null }, 'AI review run ended'],
    ]);
  });
});
