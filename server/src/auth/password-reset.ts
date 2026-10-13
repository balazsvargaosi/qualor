import { mayUsePassword, type PolicyFacts, type SignInSettings } from '../sso/sign-in-policy';
import { isDemoUser } from './demo';
import type { UserRow } from './sessions';

/** Mail E2 A3: "Forgot password?" never answers sooner than this after the request started. */
export const RESET_ANSWER_FLOOR_MS = 250;

/**
 * Waits until `floorMs` after `startedAt`. The request path does no argon2 and renders and encrypts
 * a message only for a qualifying account, so a fixed floor keeps every answer equally slow.
 */
export async function waitForFloor(
  startedAt: number,
  floorMs: number,
  now: () => number = Date.now,
): Promise<void> {
  const left = startedAt + floorMs - now();
  if (left > 0) await new Promise<void>((resolve) => setTimeout(resolve, left));
}

export interface ResetPolicy {
  demoUser: string | null;
  stored: SignInSettings;
  facts: PolicyFacts;
}

/**
 * A3: an active account with an email and a password, not the demo user, that the sign-in policy
 * lets use a password (ruling SS6: mayUsePassword decides). Checked again when the link is used.
 */
export function mayResetPassword(
  user: UserRow,
  policy: ResetPolicy,
): user is UserRow & { email: string } {
  return (
    user.active &&
    user.email !== null &&
    user.passwordHash !== null &&
    !isDemoUser(policy.demoUser, user) &&
    mayUsePassword(user, policy.stored, policy.facts).allowed
  );
}

/**
 * A8: an invitation still applies to an active account without a password and without a single
 * sign-on identity (an SSO-only account never gains a password this way), not the demo user, that
 * the sign-in policy lets use a password. Inspect and accept both decide with this.
 */
export function invitationApplies(
  user: UserRow,
  ssoIdentities: number,
  policy: ResetPolicy,
): boolean {
  return (
    user.active &&
    user.passwordHash === null &&
    ssoIdentities === 0 &&
    !isDemoUser(policy.demoUser, user) &&
    mayUsePassword(user, policy.stored, policy.facts).allowed
  );
}
