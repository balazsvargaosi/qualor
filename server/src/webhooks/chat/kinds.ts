import type { WebhookKind } from '../../db/schema';
import { isInternalHostAllowed } from '../../scm/url';
import { CHAT_EVENTS, GENERIC_EVENTS, type WebhookEvent } from '../deliveries';
import { hostOf, webhookUrlProblem, type WebhookSettings } from '../url';

export const WEBHOOK_KINDS = [
  'generic',
  'slack',
  'teams',
] as const satisfies readonly WebhookKind[];
export type ChatKind = Exclude<WebhookKind, 'generic'>;

export function isChatKind(kind: WebhookKind): kind is ChatKind {
  return kind !== 'generic';
}

/** How messages and the guide name the service. */
export function chatServiceName(kind: ChatKind): 'Slack' | 'Teams' {
  return kind === 'slack' ? 'Slack' : 'Teams';
}

/** 6G spec §3: each kind its own events. */
export function eventsOf(kind: WebhookKind): readonly WebhookEvent[] {
  return kind === 'generic' ? GENERIC_EVENTS : CHAT_EVENTS;
}

/** Null when every event belongs to the kind; else the message of the 422 on `body.events`. */
export function eventsProblem(kind: WebhookKind, events: readonly string[]): string | null {
  const allowed = eventsOf(kind) as readonly string[];
  if (events.every((e) => allowed.includes(e))) return null;
  return `A ${kind} webhook takes only these events: ${allowed.join(', ')}`;
}

/** Microsoft 365 connector hosts, disabled by Microsoft in May 2026 (R1). */
const RETIRED_TEAMS_HOST = /(^|\.)webhook\.office\.com$|(^|\.)outlook\.office(365)?\.com$/;
const TEAMS_HOST_SUFFIXES = ['.environment.api.powerplatform.com', '.logic.azure.com'];

/**
 * 6G R1: the URL rules of every webhook (webhookUrlProblem: https, no credentials, no fragment,
 * public literal hosts) plus the kind's own host. A host listed in QUALOR_CHAT_TEST_HOSTS (R7)
 * skips only the kind's host rule. Checked when the URL is saved and before every delivery.
 */
export function chatUrlProblem(
  kind: ChatKind,
  raw: string,
  settings: WebhookSettings,
  testHosts: ReadonlySet<string>,
): string | null {
  const base = webhookUrlProblem(raw, settings);
  // Chat webhooks have no secret to move credentials to; the base message points at one.
  if (base) return base.replace('; use the webhook secret', '');
  const url = new URL(raw);
  if (testHosts.size > 0 && isInternalHostAllowed(url, testHosts)) return null;
  const host = hostOf(url).toLowerCase();
  if (host.endsWith('.')) return 'Remove the trailing dot from the host name';
  const httpsDefaultPort = url.protocol === 'https:' && url.port === '';
  if (kind === 'slack') {
    const ok =
      httpsDefaultPort &&
      host === 'hooks.slack.com' &&
      (url.pathname.startsWith('/services/') || url.pathname.startsWith('/triggers/'));
    return ok ? null : 'Use a Slack incoming webhook URL (https://hooks.slack.com/services/…)';
  }
  if (RETIRED_TEAMS_HOST.test(host)) {
    return 'Office 365 connectors are retired; create a Workflows webhook in Teams instead';
  }
  const ok = httpsDefaultPort && TEAMS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return ok
    ? null
    : 'Use a Teams Workflows webhook URL (https://….environment.api.powerplatform.com/…)';
}

/** The last `n` characters (code points) of a text. */
function tail(text: string, n: number): string {
  return [...text].slice(-n).join('');
}

/**
 * 6G R3: what `url` stores and the API shows for a chat webhook: enough to recognise it, never
 * enough to post to it. Slack keeps `/services/` or `/triggers/`, the first letter of the
 * workspace id and the last 4 characters; Teams keeps the host and the last 4 characters.
 */
export function maskChatUrl(kind: ChatKind, href: string): string {
  const url = new URL(href);
  const end = tail(href, 4);
  if (kind === 'slack') {
    const [, section = 'services', workspace = ''] = url.pathname.split('/');
    return `${url.origin}/${section}/${workspace.slice(0, 1)}…/…/${end}`;
  }
  return `${url.origin}/…${end}`;
}

const MAX_ZONE_LENGTH = 64;

/**
 * The IANA zone name (offset forms such as `+02:00` are refused) as the runtime spells it
 * (`europe/berlin` → `Europe/Berlin`, `utc` → `UTC`), or null for a zone it does not know. `Intl.DateTimeFormat` throws a RangeError for an unknown one.
 */
export function canonicalTimeZone(zone: string): string | null {
  if (zone === '' || zone.length > MAX_ZONE_LENGTH || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
