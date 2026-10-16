import type { RenderedMail } from '../payload';
import { html, type SafeHtml } from './html';
import { renderLayout } from './layout';
import { formatUtc } from './text';

/** A7: a change on the account page, a reset through a link, or a reset by an administrator. */
export type PasswordChangedVariant = 'self' | 'reset' | 'admin';

export interface PasswordChangedMailData {
  variant: PasswordChangedVariant;
  username: string;
  /** E1's instanceHost(QUALOR_PUBLIC_URL), or null ("this Qualor server"). */
  host: string | null;
  at: Date;
  /** The request's address as Fastify sees it; shown for `self` and `reset` only. */
  ip: string | null;
  /** `<publicUrl>/forgot-password` while self-service is on, else null (no link). */
  forgotUrl: string | null;
}

/** The first paragraph: what changed, and how. */
function introOf(data: PasswordChangedMailData, where: string): SafeHtml {
  if (data.variant === 'self') {
    return html`<p style="margin:0">The password of <strong>${data.username}</strong> on ${where} was changed on the account page.</p>`;
  }
  if (data.variant === 'reset') {
    return html`<p style="margin:0">The password of <strong>${data.username}</strong> on ${where} was reset with a link sent to this address. Every session of the account was signed out.</p>`;
  }
  return html`<p style="margin:0">An administrator of ${where} reset the password of <strong>${data.username}</strong>. Every session of the account was signed out and its personal tokens were revoked.</p>`;
}

/** The closing paragraph: what to do if the change was not expected. */
function afterOf(data: PasswordChangedMailData): SafeHtml {
  if (data.variant === 'admin') {
    return html`<p style="margin:0">If you didn't expect this, ask an administrator.</p>`;
  }
  if (data.forgotUrl !== null) {
    return html`<p style="margin:0">If this wasn't you, <a href="${data.forgotUrl}" style="color:#1f5fbf">reset your password now</a> and tell your administrator.</p>`;
  }
  return html`<p style="margin:0">If this wasn't you, reset your password now and tell your administrator.</p>`;
}

export function renderPasswordChangedMail(data: PasswordChangedMailData): RenderedMail {
  const where = data.host ?? 'this Qualor server';
  const facts: [string, string][] = [
    ['Account', data.username],
    ['When', formatUtc(data.at)],
  ];
  if (data.variant !== 'admin' && data.ip !== null) facts.push(['From', data.ip]);
  const intro = introOf(data, where);
  const after = afterOf(data);
  return {
    subject: 'Your Qualor password was changed',
    ...renderLayout({
      preheader: `The password of ${data.username} on ${where} was changed.`,
      title: 'Your password was changed',
      badge: { text: 'Password changed', tone: 'info' },
      intro,
      facts,
      after,
      reason: 'You get this because the password of your Qualor account changed.',
      instanceHost: data.host,
    }),
  };
}
