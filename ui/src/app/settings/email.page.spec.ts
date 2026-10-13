import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  expectNoPasswordManager,
  FakeServer,
  me,
  page,
  problem,
  provideFakeServer,
  settle,
} from '../../testing/fake-server';
import { SessionStore } from '../auth/session';
import { EmailSettingsPage } from './email.page';

const PASSWORD = ['fake', 'ui', 'smtp', 'pass', '42'].join('-');
const OFF = {
  source: 'settings',
  server: null,
  alerts: { licenseExpiry: true, webhookFailures: true },
  publicUrlSet: true,
  administrators: { total: 2, withoutEmail: 1 },
  lastMessage: null,
};
const SERVER = {
  host: 'smtp.example.com',
  port: 587,
  security: 'starttls',
  username: 'qualor',
  passwordSet: true,
  passwordReadable: true,
  fromName: 'Qualor',
  fromAddress: 'qualor@example.com',
  replyTo: null,
};
const ON = {
  ...OFF,
  server: SERVER,
  lastMessage: { status: 'sent', at: '2026-10-13T09:00:00.000Z' },
};
const message = (over: Record<string, unknown> = {}) => ({
  id: '0192f5a4-7c1e-7d3a-9b2e-5f1a2c3d4e01',
  kind: 'test',
  toAddress: 'ada@example.com',
  subject: 'Qualor test message',
  status: 'sent',
  attempts: 1,
  lastError: null,
  smtpResponse: '250 Queued as ABC',
  createdAt: '2026-10-13T09:00:00.000Z',
  sentAt: '2026-10-13T09:00:01.000Z',
  nextAttemptAt: null,
  ...over,
});

function setup(
  settings: object = OFF,
  options: { admin?: boolean; messages?: object[]; next?: string | null } = {},
): FakeServer {
  const server = new FakeServer();
  server.on('GET', '/api/v0/system/mail', { body: settings });
  server.on('GET', '/api/v0/system/mail/messages', {
    body: page(options.messages ?? [], options.next ?? null),
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin: options.admin ?? true }));
  return server;
}
async function render() {
  const fixture = TestBed.createComponent(EmailSettingsPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}
function type(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
function submit(root: HTMLElement, id: string): void {
  root.querySelector<HTMLFormElement>(`form#${id}`)!.dispatchEvent(new Event('submit'));
}
const text = (root: HTMLElement) => (root.textContent ?? '').replace(/\s+/g, ' ');

describe('EmailSettingsPage (E1 spec, UI)', () => {
  it('tells a user who is not an instance admin, and asks the server nothing', async () => {
    const server = setup(OFF, { admin: false });
    const { root } = await render();
    expect(text(root)).toContain('Only instance administrators configure email.');
    expect(server.requests).toEqual([]);
  });

  it('says email is off, and warns when QUALOR_PUBLIC_URL is not set', async () => {
    setup({ ...OFF, publicUrlSet: false });
    const { root } = await render();
    expect(text(root)).toContain('Off: no SMTP server');
    expect(text(root)).toContain("QUALOR_PUBLIC_URL is not set, so messages can't link to Qualor.");
  });

  it('says email is on, with when the last message was delivered', async () => {
    setup(ON);
    const { root } = await render();
    expect(text(root)).toContain('On · last message delivered Oct 13, 2026');
  });

  it('says so when the last message failed', async () => {
    setup({ ...ON, lastMessage: { status: 'failed', at: '2026-10-13T09:00:00.000Z' } });
    const { root } = await render();
    expect(text(root)).toContain('On · the last message failed');
  });

  it('shows the environment’s server read-only, names QUALOR_SMTP_URL, and offers no Save', async () => {
    setup({ ...ON, source: 'environment' });
    const { root } = await render();
    expect(text(root)).toContain('Set by the environment');
    expect(text(root)).toContain('QUALOR_SMTP_URL');
    expect(root.querySelector<HTMLInputElement>('#email-host')!.readOnly).toBe(true);
    expect(root.querySelector('form#email-server button[type="submit"]')).toBeNull();
    expect(root.querySelector('#email-password')).toBeNull();
  });

  it('sends the password once from a password field, never shows it, and keeps it when not retyped', async () => {
    const server = setup(OFF);
    server.on('PUT', '/api/v0/system/mail', { body: { ...OFF, server: SERVER } });
    const { fixture, root } = await render();
    const field = root.querySelector<HTMLInputElement>('#email-password')!;
    expect(field.type).toBe('password');
    expectNoPasswordManager(field);
    type(root, '#email-host', 'smtp.example.com');
    type(root, '#email-username', 'qualor');
    type(root, '#email-password', PASSWORD);
    type(root, '#email-from-address', 'qualor@example.com');
    submit(root, 'email-server');
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/mail')[0]?.body).toEqual({
      server: {
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls',
        username: 'qualor',
        fromName: 'Qualor',
        fromAddress: 'qualor@example.com',
        replyTo: null,
        password: PASSWORD,
      },
    });
    expect(text(root)).not.toContain(PASSWORD);
    expect(root.querySelector('#email-password')).toBeNull();
    expect(text(root)).toContain('Saved.');
    submit(root, 'email-server');
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/mail')[1]?.body).not.toHaveProperty(
      'server.password',
    );
  });

  it('removes the password with Remove, and switches the port with the security', async () => {
    const server = setup(ON);
    server.on('PUT', '/api/v0/system/mail', { body: ON });
    const { fixture, root } = await render();
    root.querySelector<HTMLButtonElement>('#email-password-remove')!.click();
    [...root.querySelectorAll<HTMLButtonElement>('.segmented button')]
      .find((b) => b.textContent?.trim() === 'TLS')!
      .click();
    await settle(fixture);
    expect(root.querySelector<HTMLInputElement>('#email-port')!.value).toBe('465');
    submit(root, 'email-server');
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/mail')[0]?.body).toMatchObject({
      server: { security: 'tls', port: 465, password: null },
    });
  });

  it('maps refused fields to the fields, in the page’s own words', async () => {
    const server = setup(ON);
    server.on('PUT', '/api/v0/system/mail', {
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [
        { path: 'body.server.fromName', message: 'Must be one line' },
      ]),
    });
    const { fixture, root } = await render();
    submit(root, 'email-server');
    await settle(fixture);
    expect(root.querySelector('#email-from-name')!.getAttribute('aria-invalid')).toBe('true');
    expect(text(root)).toContain("Enter the sender's name on one line, at most 100 characters.");
    expect(text(root)).not.toContain('Must be one line');
  });

  it('sends a test and shows the server’s reply, or the refusal in its own words with the reply', async () => {
    const server = setup(ON);
    server.on('POST', '/api/v0/system/mail/test', {
      body: { response: '250 2.0.0 OK queued', ms: 412 },
    });
    const { fixture, root } = await render();
    expect(root.querySelector<HTMLInputElement>('#email-test-to')!.value).toBe('');
    type(root, '#email-test-to', 'ada@example.com');
    submit(root, 'email-test');
    await settle(fixture);
    expect(server.requestsTo('POST', '/api/v0/system/mail/test')[0]?.body).toEqual({
      to: 'ada@example.com',
    });
    expect(text(root)).toContain('Sent in 412 ms. The server answered: 250 2.0.0 OK queued');
    server.on('POST', '/api/v0/system/mail/test', {
      status: 502,
      body: {
        ...problem(502, 'MAIL_SEND_FAILED'),
        detail: '535 5.7.8 Authentication failed',
        reason: 'auth',
      },
    });
    submit(root, 'email-test');
    await settle(fixture);
    expect(text(root)).toContain('The SMTP server refused the user name or password.');
    expect(text(root)).toContain('535 5.7.8 Authentication failed');
  });

  it('saves an alert switch at once', async () => {
    const server = setup(ON);
    server.on('PUT', '/api/v0/system/mail', {
      body: { ...ON, alerts: { licenseExpiry: false, webhookFailures: true } },
    });
    const { fixture, root } = await render();
    const box = root.querySelector<HTMLInputElement>('#email-alert-license')!;
    box.click();
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/mail')[0]?.body).toEqual({
      alerts: { licenseExpiry: false },
    });
    expect(text(root)).toContain('Recipients: 2 administrators');
    expect(text(root)).toContain('1 has no email address');
  });

  it('lists recent messages with their status and error, and loads more', async () => {
    const server = setup(ON, {
      messages: [
        message(),
        message({
          id: '0192f5a4-7c1e-7d3a-9b2e-5f1a2c3d4e02',
          kind: 'webhook.failed',
          status: 'pending',
          attempts: 2,
          lastError: '451 4.7.1 Try again later',
          smtpResponse: null,
          sentAt: null,
        }),
      ],
      next: 'cursor-2',
    });
    const { fixture, root } = await render();
    const rows = [...root.querySelectorAll('#email-log tbody tr')].map((r) =>
      (r.textContent ?? '').replace(/\s+/g, ' '),
    );
    expect(rows[0]).toContain('Test message');
    expect(rows[0]).toContain('Delivered');
    expect(rows[1]).toContain('Failing webhook');
    expect(rows[1]).toContain('Retrying 2/7');
    expect(rows[1]).toContain('451 4.7.1 Try again later');
    expect(text(root)).toContain('Kept 30 days');
    root.querySelector<HTMLButtonElement>('#email-log-more')!.click();
    await settle(fixture);
    expect(
      server.requestsTo('GET', '/api/v0/system/mail/messages').at(-1)?.query.get('cursor'),
    ).toBe('cursor-2');
  });
});
