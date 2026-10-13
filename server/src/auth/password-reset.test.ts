import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRow } from './sessions';
import {
  invitationApplies,
  mayResetPassword,
  RESET_ANSWER_FLOOR_MS,
  waitForFloor,
} from './password-reset';

const USER: UserRow = {
  id: '0192f5a4-7c1e-7d3a-9b2e-5f1a2c3d4e5f',
  username: 'rita',
  email: 'rita@example.test',
  displayName: null,
  passwordHash: 'argon2-hash',
  passwordChangeRequired: false,
  isInstanceAdmin: false,
  active: true,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const EVERYONE = { passwordSignIn: 'everyone' as const, breakGlassUserIds: [] };
const POLICY = { demoUser: 'guest', stored: EVERYONE, facts: { sso: false, forced: false } };

describe('the answer floor (mail E2 A3, fake clock)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers no sooner than 250 ms after the request started', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let done = false;
    const waiting = waitForFloor(started, RESET_ANSWER_FLOOR_MS).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });

  it('does not wait once the floor has passed', async () => {
    vi.useFakeTimers();
    const waiting = waitForFloor(1_000, 250, () => 1_400);
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe('who may reset a password (mail E2 A3)', () => {
  it('allows an active password account with an email', () => {
    expect(mayResetPassword(USER, POLICY)).toBe(true);
  });

  it.each([
    ['inactive', { active: false }],
    ['without an email', { email: null }],
    ['without a password', { passwordHash: null }],
    ['the demo user', { username: 'guest' }],
  ] as const)('refuses %s', (_name, change) => {
    expect(mayResetPassword({ ...USER, ...change }, POLICY)).toBe(false);
  });

  it('follows the break-glass policy, and its emergency switch', () => {
    const stored = { passwordSignIn: 'break_glass_only' as const, breakGlassUserIds: [] };
    const sso = { sso: true, forced: false };
    expect(mayResetPassword(USER, { ...POLICY, stored, facts: sso })).toBe(false);
    expect(mayResetPassword(USER, { ...POLICY, stored, facts: { sso: true, forced: true } })).toBe(
      true,
    );
    const admin = { ...USER, isInstanceAdmin: true };
    expect(
      mayResetPassword(admin, {
        ...POLICY,
        stored: { ...stored, breakGlassUserIds: [USER.id] },
        facts: sso,
      }),
    ).toBe(true);
  });
});

describe('whom an invitation still applies to (mail E2 A8)', () => {
  const INVITED = { ...USER, passwordHash: null };

  it('applies to an active account without a password or an SSO identity', () => {
    expect(invitationApplies(INVITED, 0, POLICY)).toBe(true);
  });

  it.each([
    ['inactive', { active: false }, 0],
    ['with a password', { passwordHash: 'argon2-hash' }, 0],
    ['the demo user', { username: 'guest' }, 0],
    ['linked to single sign-on', {}, 1],
  ] as const)('not to one %s', (_name, change, identities) => {
    expect(invitationApplies({ ...INVITED, ...change }, identities, POLICY)).toBe(false);
  });

  it('follows the sign-in policy', () => {
    const stored = { passwordSignIn: 'break_glass_only' as const, breakGlassUserIds: [] };
    expect(
      invitationApplies(INVITED, 0, { ...POLICY, stored, facts: { sso: true, forced: false } }),
    ).toBe(false);
  });
});
