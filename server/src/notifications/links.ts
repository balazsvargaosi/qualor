import type { Config } from '../config';
import type { RenderedMail } from '../mail/payload';
import type { NotifyLinks } from '../mail/templates/notify-common';
import { instanceHost, publicLink } from '../mail/templates/text';
import { unsubscribeHeaders, unsubscribeToken } from './unsubscribe';

export type WatchLinks = NotifyLinks & { token: string };

/** The links of one watcher's message about one project, and the token behind its stop link. */
export function watchLinks(
  config: Pick<Config, 'publicUrl' | 'secretKey'>,
  userId: string,
  projectId: string,
): WatchLinks {
  const token = unsubscribeToken(config.secretKey, userId, projectId);
  return {
    publicUrl: config.publicUrl,
    instanceHost: instanceHost(config.publicUrl),
    token,
    unsubscribeUrl: publicLink(config.publicUrl, `/unsubscribe#t=${token}`),
    settingsUrl: publicLink(config.publicUrl, '/settings/notifications'),
  };
}

/** The message with RFC 8058 headers, when there is a public URL for them to point at. */
export function withUnsubscribe(
  mail: RenderedMail,
  publicUrl: string | null,
  token: string,
): RenderedMail {
  const headers = unsubscribeHeaders(publicUrl, token);
  return headers ? { ...mail, headers } : mail;
}
