import type { RenderedMail } from '../payload';
import { html } from './html';
import { renderLayout } from './layout';
import { adminAlertReason, formatDay, instanceHost, publicLink } from './text';

/** E1 spec: 30, 7 and 1 day before expiry, the grace period, and its end. */
export const LICENSE_ALERT_VARIANTS = ['30d', '7d', '1d', 'grace', 'expired'] as const;
export type LicenseAlertVariant = (typeof LICENSE_ALERT_VARIANTS)[number];

export interface LicenseExpiryInput {
  variant: LicenseAlertVariant;
  /** The licence's `customer`. */
  licensee: string;
  /** "Business" or "Enterprise" (alerts/license-alerts.ts `licensePlan`). */
  plan: string;
  expires: Date;
  graceEndsAt: Date;
  now: Date;
  publicUrl: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);
const daysUntil = (to: Date, from: Date) =>
  Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));

/** What stops when the grace period ends, in the words of docs/guide/enterprise.md. */
const WHAT_STOPS =
  'single sign-on stops (people with a password sign in with it), SCIM requests are refused, the audit log stops recording new events, and AI fix suggestions are limited to 25 per organisation per day';

/** E1 spec: the licence expiry alert for instance administrators. */
export function renderLicenseExpiry(input: LicenseExpiryInput): RenderedMail {
  const host = instanceHost(input.publicUrl);
  const expires = formatDay(input.expires);
  const graceEnds = formatDay(input.graceEndsAt);
  const expiring = input.variant === '30d' || input.variant === '7d' || input.variant === '1d';
  const subject = expiring
    ? `Your Qualor licence expires in ${days(daysUntil(input.expires, input.now))}`
    : input.variant === 'grace'
      ? `Your Qualor licence has expired: ${days(daysUntil(input.graceEndsAt, input.now))} of grace left`
      : 'Your Qualor licence has expired';
  const intro = expiring
    ? html`<p style="margin:0">The Qualor licence of ${input.licensee} expires on ${expires}. Renew it to keep the enterprise features. After that date a 14-day grace period starts, and everything keeps working until ${graceEnds}.</p>`
    : input.variant === 'grace'
      ? html`<p style="margin:0">The Qualor licence of ${input.licensee} expired on ${expires}. Everything keeps working during the grace period, until ${graceEnds}. Then Qualor runs as the community edition: ${WHAT_STOPS}. Nothing is deleted.</p>`
      : html`<p style="margin:0">The grace period of the Qualor licence of ${input.licensee} ended on ${graceEnds}. Enterprise features are off: Qualor runs as the community edition until the licence is renewed, so ${WHAT_STOPS}. Nothing was deleted.</p>`;
  return {
    subject,
    ...renderLayout({
      preheader: subject,
      title: expiring
        ? `The licence expires on ${expires}`
        : input.variant === 'grace'
          ? 'The licence has expired'
          : 'Enterprise features are off',
      badge: expiring
        ? { text: 'Expires soon', tone: 'warn' }
        : { text: input.variant === 'grace' ? 'Grace period' : 'Expired', tone: 'bad' },
      intro,
      facts: [
        ['Licensee', input.licensee],
        ['Plan', input.plan],
        ['Expires', expires],
        ['Grace ends', graceEnds],
      ],
      cta: {
        label: 'Open licence settings',
        url: publicLink(input.publicUrl, '/settings/license'),
        fallbackText: 'Open Settings → Licence in Qualor.',
      },
      after: html`<p style="margin:0">Apply a renewed key in Settings → Licence and restart the server.</p>`,
      reason: adminAlertReason(host),
      instanceHost: host,
    }),
  };
}
