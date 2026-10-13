import type { RenderedMail } from '../payload';
import { clipChars, oneLine } from '../text';
import { html } from './html';
import { renderLayout } from './layout';
import { formatUtc } from './text';

export interface InvitationMailData {
  /** The inviting admin's display name, else their username. */
  inviter: string;
  username: string;
  email: string;
  /** E1's instanceHost(QUALOR_PUBLIC_URL); an invitation is only sent with a public URL. */
  host: string | null;
  /** accountLink(publicUrl, INVITE_PATH, token). */
  url: string;
  expiresAt: Date;
}

/** The inviter's name in the subject: one line, at most this many characters. */
const INVITER_MAX = 200;

export function renderInvitationMail(data: InvitationMailData): RenderedMail {
  const inviter = clipChars(oneLine(data.inviter), INVITER_MAX);
  const where = data.host ?? 'this Qualor server';
  return {
    subject: `${inviter} invited you to Qualor`,
    ...renderLayout({
      preheader: `Set your password to start using Qualor on ${where}.`,
      title: "You're invited to Qualor",
      intro: html`<p style="margin:0">${inviter} created an account for you on ${where}. Your username is <strong>${data.username}</strong>.</p>`,
      facts: [
        ['Username', data.username],
        ['Expires', formatUtc(data.expiresAt)],
      ],
      cta: {
        label: 'Set your password',
        url: data.url,
        fallbackText: 'Ask your administrator to send the invitation again.',
      },
      reason: `You get this because an administrator of ${where} invited ${data.email}.`,
      instanceHost: data.host,
    }),
  };
}
