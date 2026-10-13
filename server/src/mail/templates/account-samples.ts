import type { RenderedMail } from '../payload';
import { renderInvitationMail } from './account-invitation';
import { renderPasswordChangedMail } from './account-password-changed';
import { renderPasswordResetMail } from './account-password-reset';
import { instanceHost, publicLink } from './text';

/** A link secret of the right shape; samples never hold a real one. */
const TOKEN = 'SampleSampleSampleSampleSampleSampleSample1';
const AT = new Date('2026-10-13T09:30:00Z');

/**
 * Mail E2's samples for E1's sampleMails() (`mail:preview` and templates.test.ts), named after
 * their kind. Without a public URL there is no reset or invitation email: Qualor never sends one.
 */
export function accountSamples(publicUrl: string | null): { name: string; mail: RenderedMail }[] {
  const host = instanceHost(publicUrl);
  const reset = publicLink(publicUrl, `/reset-password#token=${TOKEN}`);
  const invite = publicLink(publicUrl, `/accept-invite#token=${TOKEN}`);
  const linked =
    reset === null || invite === null
      ? []
      : [
          {
            name: 'account.password-reset',
            mail: renderPasswordResetMail({ username: 'rita', host, url: reset }),
          },
          {
            name: 'account.invitation',
            mail: renderInvitationMail({
              inviter: 'Ada Admin',
              username: 'ivy',
              email: 'ivy@example.com',
              host,
              url: invite,
              expiresAt: new Date('2026-10-20T09:30:00Z'),
            }),
          },
        ];
  return [
    ...linked,
    ...(['self', 'reset', 'admin'] as const).map((variant) => ({
      name: `account.password-changed-${variant}`,
      mail: renderPasswordChangedMail({
        variant,
        username: 'rita',
        host,
        at: AT,
        ip: '203.0.113.7',
        forgotUrl: publicLink(publicUrl, '/forgot-password'),
      }),
    })),
  ];
}
