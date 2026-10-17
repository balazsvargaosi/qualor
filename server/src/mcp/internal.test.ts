import { describe, expect, it, vi } from 'vitest';
import type { OAuthPrincipal } from '../auth/principal';
import { InternalCalls } from './internal';

const principal = { kind: 'oauth', grantId: 'g' } as unknown as OAuthPrincipal;

describe('InternalCalls (ruling R4)', () => {
  it('hands a principal out once per key', () => {
    const calls = new InternalCalls();
    const key = calls.issue(principal);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls.take(key)).toBe(principal);
    expect(calls.take(key)).toBeNull();
  });

  it('forgets a key after 30 seconds and refuses unknown keys', () => {
    vi.useFakeTimers();
    try {
      const calls = new InternalCalls();
      const key = calls.issue(principal);
      vi.advanceTimersByTime(30_001);
      expect(calls.take(key)).toBeNull();
      expect(calls.take('made-up')).toBeNull();
      expect(calls.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
