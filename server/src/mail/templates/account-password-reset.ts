import type { RenderedMail } from '../payload';
import { html } from './html';
import { renderLayout } from './layout';

export interface PasswordResetMailData {
  username: string;
  /** E1's instanceHost(QUALOR_PUBLIC_URL); a reset link is only sent with a public URL. */
  host: string | null;
  /** accountLink(publicUrl, RESET_PATH, token). */
  url: string;
}

export function renderPasswordResetMail(data: PasswordResetMailData): RenderedMail {
  const where = data.host ?? 'this Qualor server';
  return {
    subject: 'Reset your Qualor password',
    ...renderLayout({
      preheader: 'Choose a new password. The link works once, for 60 minutes.',
      title: 'Reset your password',
      intro: html`<p style="margin:0">Someone asked to reset the password of <strong>${data.username}</strong> on ${where}. The link works once, for 60 minutes.</p>`,
      cta: {
        label: 'Choose a new password',
        url: data.url,
        fallbackText: 'Use Forgot password? on the Qualor sign-in page again.',
      },
      after: html`<p style="margin:0">If you didn't ask, ignore this email: your password stays the same.</p>`,
      reason: 'You get this because a password reset was requested for your Qualor account.',
      instanceHost: data.host,
    }),
  };
}
