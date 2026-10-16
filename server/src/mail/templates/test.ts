import type { SmtpSecurity } from '../../config';
import type { RenderedMail } from '../payload';
import { html } from './html';
import { renderLayout } from './layout';
import { formatUtc, instanceHost } from './text';

const SECURITY: Readonly<Record<SmtpSecurity, string>> = {
  starttls: 'STARTTLS',
  tls: 'TLS',
  none: 'no TLS',
};

export interface TestMailInput {
  server: { host: string; port: number; security: SmtpSecurity };
  /** Who pressed Send test: the display name, else the user name. */
  sentBy: string;
  at: Date;
  publicUrl: string | null;
}

/** E1 spec: Settings → Email → Send test. */
export function renderTestMail(input: TestMailInput): RenderedMail {
  const host = instanceHost(input.publicUrl);
  const server = `${input.server.host}:${input.server.port}`;
  const onHost = host === null ? '' : ` on ${host}`;
  return {
    subject: 'Qualor test message',
    ...renderLayout({
      preheader: `Qualor sent this through ${server}.`,
      title: 'Email works',
      badge: { text: 'Test', tone: 'ok' },
      intro: html`<p style="margin:0">Qualor sent this test message through ${server} on ${formatUtc(input.at)}. Alerts from Qualor reach this address the same way.</p>`,
      facts: [
        ['Server', `${server}, ${SECURITY[input.server.security]}`],
        ['Sent by', input.sentBy],
      ],
      reason: `You get this because ${input.sentBy} sent a test message from Settings → Email${onHost}.`,
      instanceHost: host,
    }),
  };
}
