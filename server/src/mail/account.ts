import type { Config } from '../config';
import type { Executor } from '../db/client';
import { mailConfigured } from './settings';

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
