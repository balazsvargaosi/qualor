import type { Config } from '../config';
import { mailDeps, type MailDeps } from '../mail/outbox';

/**
 * What queueing a project notification needs: E1's mail deps (SMTP config, public URL, secret
 * key), with the whole config for the demo user's name.
 */
export type NotifyDeps = MailDeps & { config: Config };

/** The one place NotifyDeps is built (main.ts, tests). */
export function notifyDeps(config: Config): NotifyDeps {
  return { ...mailDeps(config), config };
}
