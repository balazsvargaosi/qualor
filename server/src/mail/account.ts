import type { Config } from '../config';
import type { Executor } from '../db/client';
import { type MailDeps, queueMail } from './outbox';
import { mailConfigured } from './settings';
import {
  type PasswordChangedVariant,
  renderPasswordChangedMail,
} from './templates/account-password-changed';
import { instanceHost, publicLink } from './templates/text';

export const RESET_PATH = '/reset-password';
export const INVITE_PATH = '/accept-invite';
export const FORGOT_PATH = '/forgot-password';

/**
 * Mail E2 A2: the secret travels in the fragment, which browsers never send to a server, a proxy
 * or a Referer header. `publicUrl` is QUALOR_PUBLIC_URL, kept without a trailing slash.
 */
export function accountLink(
  publicUrl: string,
  path: typeof RESET_PATH | typeof INVITE_PATH,
  token: string,
): string {
  return `${publicUrl}${path}#token=${token}`;
}

export type AccountMailState =
  { ready: true; publicUrl: string } | { ready: false; missing: 'mail' | 'public-url' };

/** A4: reset links and invitations need an SMTP server (E1) and QUALOR_PUBLIC_URL (mail first). */
export async function accountMailState(
  db: Executor,
  config: Pick<Config, 'smtp' | 'publicUrl'>,
): Promise<AccountMailState> {
  if (!(await mailConfigured(db, config))) return { ready: false, missing: 'mail' };
  return config.publicUrl === null
    ? { ready: false, missing: 'public-url' }
    : { ready: true, publicUrl: config.publicUrl };
}

/** `GET /auth/methods` `passwordReset`. */
export async function selfServiceReady(
  db: Executor,
  config: Pick<Config, 'smtp' | 'publicUrl'>,
): Promise<boolean> {
  return (await accountMailState(db, config)).ready;
}

/**
 * A7: "Your Qualor password was changed" to the account's address, in the change's transaction.
 * Nothing for an account without an email; nothing is stored while mail is off (queueMail skips).
 * The reset link appears only while self-service can work (a queued message means mail is on).
 */
export async function queuePasswordChangedNotice(
  tx: Executor,
  deps: MailDeps,
  input: {
    user: { id: string; username: string; email: string | null };
    variant: PasswordChangedVariant;
    ip: string | null;
  },
): Promise<void> {
  const address = input.user.email;
  if (address === null) return;
  const { publicUrl } = deps.config;
  const at = new Date();
  // `skipped` (mail off) and `duplicate` (no dedupe here) need nothing more: the change stands.
  await queueMail(tx, deps, {
    kind: 'account.password-changed',
    to: { address, userId: input.user.id },
    render: () =>
      renderPasswordChangedMail({
        variant: input.variant,
        username: input.user.username,
        host: instanceHost(publicUrl),
        at,
        ip: input.ip,
        forgotUrl: publicLink(publicUrl, FORGOT_PATH),
      }),
  });
}
