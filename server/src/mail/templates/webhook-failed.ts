import type { RenderedMail } from '../payload';
import { html } from './html';
import { renderLayout, type FooterLink } from './layout';
import { adminAlertReason, instanceHost, publicLink } from './text';

export interface WebhookFailedInput {
  organization: string;
  project: string | null;
  /** The receiver's host and port, never the full URL: a path or a query may hold a secret. */
  receiverHost: string;
  /** The receiver's last HTTP status, or null when it never answered. */
  lastResponse: number | null;
  attempts: number;
  publicUrl: string | null;
  /** E3: the reason line for organisation administrators; default: the instance administrators'. */
  reason?: string;
  /** E3: the organisation administrators' "Notification settings" link after the reason line. */
  footerLinks?: readonly FooterLink[];
}

/** E1 spec: a webhook delivery gave up (webhooks have no name: the receiver's host names it). */
export function renderWebhookFailed(input: WebhookFailedInput): RenderedMail {
  const host = instanceHost(input.publicUrl);
  const facts: [string, string][] = [['Organization', input.organization]];
  if (input.project !== null) facts.push(['Project', input.project]);
  facts.push(
    ['Receiver', input.receiverHost],
    ['Last response', input.lastResponse === null ? 'no answer' : `HTTP ${input.lastResponse}`],
    ['Attempts', String(input.attempts)],
  );
  return {
    subject: `Webhook to ${input.receiverHost} is failing`,
    ...renderLayout({
      preheader: `${input.attempts} attempts to deliver an event to ${input.receiverHost} failed.`,
      title: 'A webhook delivery gave up',
      badge: { text: 'Failing', tone: 'bad' },
      intro: html`<p style="margin:0">A webhook of ${input.organization} could not deliver an event to ${input.receiverHost} in ${input.attempts} attempts, so Qualor gave that delivery up. New events are still sent to it. Check that the receiver is up and answers with a 2xx status, then press Send again on the delivery.</p>`,
      facts,
      cta: {
        label: 'Open webhooks',
        url: publicLink(input.publicUrl, '/settings/webhooks'),
        fallbackText: `Open Settings → Webhooks in Qualor, with ${input.organization} chosen at the top.`,
      },
      after: html`<p style="margin:0">You get at most one of these a day for each webhook.</p>`,
      reason: input.reason ?? adminAlertReason(host),
      ...(input.footerLinks ? { footerLinks: input.footerLinks } : {}),
      instanceHost: host,
    }),
  };
}
