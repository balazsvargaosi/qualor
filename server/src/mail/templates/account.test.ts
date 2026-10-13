import { describe, expect, it } from 'vitest';
import { accountLink } from '../account';
import { renderInvitationMail } from './account-invitation';
import { renderPasswordChangedMail } from './account-password-changed';
import { renderPasswordResetMail } from './account-password-reset';
import { accountSamples } from './account-samples';
import { formatUtc } from './text';

const TOKEN = 'T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0kenT0k';
const HOST = 'qualor.example.com';
const BASE = `https://${HOST}`;

describe('account email templates (mail E2)', () => {
  it('reset: the link in the HTML and the text, never in the subject', () => {
    const url = accountLink(BASE, '/reset-password', TOKEN);
    expect(url).toBe(`${BASE}/reset-password#token=${TOKEN}`);
    const mail = renderPasswordResetMail({ username: 'rita', host: HOST, url });
    expect(mail.subject).toBe('Reset your Qualor password');
    expect(mail.subject).not.toContain(TOKEN);
    expect(mail.html).toContain(url);
    expect(mail.text).toContain(url);
    expect(mail.html).toContain('rita');
    expect(mail.text.replace(/\n/g, ' ')).toContain('The link works once, for 60 minutes.');
    expect(mail.html).toContain('ignore this email: your password stays the same.');
    expect(mail.headers).toBeUndefined();
  });

  it('invitation: a hostile inviter name is text in the HTML and one line in the subject', () => {
    const mail = renderInvitationMail({
      inviter: 'Eve <script>alert(1)</script>\r\nBcc: all@example.test',
      username: 'ivy',
      email: 'ivy@example.test',
      host: HOST,
      url: accountLink(BASE, '/accept-invite', TOKEN),
      expiresAt: new Date('2026-10-20T14:05:09Z'),
    });
    expect(mail.subject).toBe(
      'Eve <script>alert(1)</script> Bcc: all@example.test invited you to Qualor',
    );
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text).toContain(`Expires: ${formatUtc(new Date('2026-10-20T14:05:09Z'))}`);
    expect(mail.html).toContain(`${BASE}/accept-invite#token=${TOKEN}`);
    expect(mail.html).toContain('ivy@example.test');
  });

  it.each(['self', 'reset'] as const)(
    'password changed (%s): names the account, the time and where from, with the reset link in both parts',
    (variant) => {
      const mail = renderPasswordChangedMail({
        variant,
        username: 'rita',
        host: HOST,
        at: new Date('2026-10-13T09:30:59Z'),
        ip: '203.0.113.7',
        forgotUrl: `${BASE}/forgot-password`,
      });
      expect(mail.subject).toBe('Your Qualor password was changed');
      expect(mail.text).toContain(`When: ${formatUtc(new Date('2026-10-13T09:30:59Z'))}`);
      expect(mail.text).toContain('From: 203.0.113.7');
      expect(mail.html).toContain(`${BASE}/forgot-password`);
      // E1's htmlToText keeps a link's URL in the text part.
      expect(mail.text).toContain(`(${BASE}/forgot-password)`);
      expect(mail.html).toContain('tell your administrator');
    },
  );

  it('password changed by an administrator: no From, says what ended', () => {
    const mail = renderPasswordChangedMail({
      variant: 'admin',
      username: 'rita',
      host: HOST,
      at: new Date('2026-10-13T09:30:00Z'),
      ip: '203.0.113.7',
      forgotUrl: `${BASE}/forgot-password`,
    });
    expect(mail.text).not.toContain('203.0.113.7');
    expect(mail.text).not.toContain('From:');
    expect(mail.html).toContain('An administrator');
    expect(mail.html).toContain('personal tokens were revoked');
    expect(mail.html).toContain('ask an administrator');
  });

  it('password changed without self-service or a public URL: no reset link, "this Qualor server"', () => {
    const mail = renderPasswordChangedMail({
      variant: 'self',
      username: 'rita',
      host: null,
      at: new Date(),
      ip: null,
      forgotUrl: null,
    });
    expect(mail.html).not.toContain('/forgot-password');
    expect(mail.text).toContain('on this Qualor server');
  });

  it('has samples of every account email, and none of a link email without a public URL', () => {
    expect(accountSamples(BASE).map((s) => s.name)).toEqual([
      'account.password-reset',
      'account.invitation',
      'account.password-changed-self',
      'account.password-changed-reset',
      'account.password-changed-admin',
    ]);
    expect(accountSamples(null).map((s) => s.name)).toEqual([
      'account.password-changed-self',
      'account.password-changed-reset',
      'account.password-changed-admin',
    ]);
  });
});
