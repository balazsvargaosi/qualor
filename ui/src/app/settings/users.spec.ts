import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  FakeServer,
  me,
  page,
  problem,
  provideFakeServer,
  settle,
} from '../../testing/fake-server';
import { SessionStore } from '../auth/session';
import { type User, UsersPage } from './users.page';

function user(id: string, username: string, overrides: Partial<User> = {}): User {
  return {
    id,
    username,
    displayName: null,
    email: null,
    isInstanceAdmin: false,
    active: true,
    passwordChangeRequired: false,
    hasPassword: true,
    sso: { identities: 0, scim: false },
    invitation: null,
    lastLoginAt: null,
    createdAt: '',
    ...overrides,
  };
}

function setup(): FakeServer {
  const server = new FakeServer();
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin: true }));
  return server;
}

const row = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`tr[data-key="${id}"]`)!;

describe('UsersPage: sign-in badges and the "No password" filter (sso-scim.md §18)', () => {
  it('marks users without a password, with SSO identities and provisioned by SCIM', async () => {
    const server = setup();
    server.on('GET', '/api/v0/users', {
      body: page([
        user('u1', 'plain'),
        user('u2', 'sso-only', { hasPassword: false, sso: { identities: 1, scim: false } }),
        user('u3', 'scim', { hasPassword: false, sso: { identities: 1, scim: true } }),
      ]),
    });
    const fixture = TestBed.createComponent(UsersPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const plain = row(root, 'u1').textContent ?? '';
    expect(plain).not.toContain('No password');
    expect(plain).not.toContain('SSO');
    expect(plain).not.toContain('SCIM');
    const ssoOnly = row(root, 'u2').textContent ?? '';
    expect(ssoOnly).toContain('No password');
    expect(ssoOnly).toContain('SSO');
    expect(ssoOnly).not.toContain('SCIM');
    expect(ssoOnly).not.toContain('may overwrite');
    const scim = row(root, 'u3').textContent ?? '';
    expect(scim).toContain('SCIM');
    expect(scim).toContain('The identity provider may overwrite changes to this account.');
  });

  it('lists only the users without a password while the filter is on', async () => {
    const server = setup();
    server.on('GET', '/api/v0/users', (request) => ({
      body: page(
        request.query.get('signIn') === 'no-password'
          ? [user('u2', 'sso-only', { hasPassword: false, sso: { identities: 1, scim: false } })]
          : [user('u1', 'plain'), user('u2', 'sso-only', { hasPassword: false })],
      ),
    }));
    const fixture = TestBed.createComponent(UsersPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
    const toggle = root.querySelector<HTMLButtonElement>('[data-test=filter-no-password]')!;
    expect(toggle.textContent).toContain('No password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    await settle(fixture);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(server.requests.at(-1)?.query.get('signIn')).toBe('no-password');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(row(root, 'u2')).not.toBeNull();
    toggle.click();
    await settle(fixture);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(server.requests.at(-1)?.query.has('signIn')).toBe(false);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('asks for the next page with the same filter', async () => {
    const server = setup();
    server.on('GET', '/api/v0/users', (request) => ({
      body: request.query.has('cursor')
        ? page([user('u3', 'third', { hasPassword: false })])
        : page([user('u2', 'second', { hasPassword: false })], 'next'),
    }));
    const fixture = TestBed.createComponent(UsersPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[data-test=filter-no-password]')!.click();
    await settle(fixture);
    [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Load more'))!.click();
    await settle(fixture);
    const last = server.requests.at(-1)!;
    expect(last.query.get('cursor')).toBe('next');
    expect(last.query.get('signIn')).toBe('no-password');
  });
});

describe('UsersPage: the "No password" filter with nobody to show (step 11)', () => {
  it('says every user can sign in with a password, instead of an empty table', async () => {
    const server = setup();
    server.on('GET', '/api/v0/users', (request) => ({
      body: page(request.query.get('signIn') === 'no-password' ? [] : [user('u1', 'plain')]),
    }));
    const fixture = TestBed.createComponent(UsersPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[data-test=filter-no-password]')!.click();
    await settle(fixture);
    expect(root.querySelector('tbody')?.textContent?.trim()).toBe(
      'Every user can sign in with a password.',
    );
  });
});

describe('UsersPage: invitations (mail E2 A8)', () => {
  const AVAILABLE = { password: 'everyone', providers: [], demo: false, passwordReset: true };
  const LIVE = '2099-01-01T00:00:00.000Z';
  const type = (root: HTMLElement, selector: string, value: string) => {
    const input = root.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const radio = (root: HTMLElement, value: string) =>
    root.querySelector<HTMLInputElement>(`input[name="create-mode"][value="${value}"]`)!;
  async function open(server: FakeServer, methods: object, users: User[] = []) {
    server.on('GET', '/api/v0/auth/methods', { body: methods });
    server.on('GET', '/api/v0/users', { body: page(users) });
    const fixture = TestBed.createComponent(UsersPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('New user'))!.click();
    await settle(fixture);
    return { fixture, root };
  }
  const submit = async (root: HTMLElement, fixture: { whenStable(): Promise<unknown> }) => {
    root.querySelector('#create-dialog form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
  };

  it('invites by default when email works: no password field, the email required', async () => {
    const server = setup();
    server.on('POST', '/api/v0/users', {
      status: 201,
      body: user('u9', 'ivy', {
        email: 'ivy@example.test',
        hasPassword: false,
        invitation: { expiresAt: LIVE },
      }),
    });
    const { fixture, root } = await open(server, AVAILABLE);
    expect(radio(root, 'invite').checked).toBe(true);
    expect(root.querySelector('#user-password')).toBeNull();
    type(root, '#user-username', 'ivy');
    await submit(root, fixture);
    expect(root.querySelector('#user-email-error')?.textContent).toContain(
      'Enter the email address the invitation goes to.',
    );
    expect(server.requestsTo('POST', '/api/v0/users')).toEqual([]);
    type(root, '#user-email', 'ivy@example.test');
    await submit(root, fixture);
    expect(server.requestsTo('POST', '/api/v0/users')[0]?.body).toEqual({
      username: 'ivy',
      invite: true,
      email: 'ivy@example.test',
      isInstanceAdmin: false,
    });
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'ivy gets an email with a link to set a password.',
    );
  });

  it('offers only an initial password, saying why, without email or QUALOR_PUBLIC_URL', async () => {
    const server = setup();
    const { root } = await open(server, { ...AVAILABLE, passwordReset: false });
    expect(radio(root, 'invite').disabled).toBe(true);
    expect(radio(root, 'password').checked).toBe(true);
    expect(root.querySelector('#user-password')).not.toBeNull();
    expect(root.querySelector('#create-mode-hint')?.textContent).toContain(
      'Invitations need an email server and QUALOR_PUBLIC_URL.',
    );
  });

  it('offers only an initial password while password sign-in is limited to break-glass admins', async () => {
    const server = setup();
    const { root } = await open(server, { ...AVAILABLE, password: 'break_glass_only' });
    expect(radio(root, 'invite').disabled).toBe(true);
    expect(root.querySelector('#create-mode-hint')?.textContent).toContain(
      'break-glass administrators',
    );
  });

  it('shows a refused invitation in the dialog', async () => {
    const server = setup();
    server.on('POST', '/api/v0/users', { status: 409, body: problem(409, 'MAIL_NOT_CONFIGURED') });
    const { fixture, root } = await open(server, AVAILABLE);
    type(root, '#user-username', 'ivy');
    type(root, '#user-email', 'ivy@example.test');
    await submit(root, fixture);
    expect(root.querySelector('#create-dialog [role="alert"]')?.textContent).toContain(
      'Invitations need an email server and QUALOR_PUBLIC_URL.',
    );
  });

  it('marks invited users, and resends or revokes their invitation', async () => {
    const server = setup();
    const ivy = user('u1', 'ivy', {
      email: 'ivy@example.test',
      hasPassword: false,
      invitation: { expiresAt: LIVE },
    });
    const old = user('u2', 'old', {
      email: 'old@example.test',
      hasPassword: false,
      invitation: { expiresAt: '2000-01-01T00:00:00.000Z' },
    });
    server.on('POST', '/api/v0/users/u1/invitation', { body: ivy });
    server.on('DELETE', '/api/v0/users/u1/invitation', { status: 204 });
    server.on('GET', '/api/v0/auth/methods', { body: AVAILABLE });
    server.on('GET', '/api/v0/users', { body: page([ivy, old]) });
    const fixture = TestBed.createComponent(UsersPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(row(root, 'u1').querySelector('[data-test=invited]')?.textContent).toContain(
      'Invited · expires',
    );
    expect(row(root, 'u1').textContent).not.toContain('No password');
    expect(row(root, 'u2').querySelector('[data-test=invitation-expired]')?.textContent).toContain(
      'Invitation expired',
    );
    expect(row(root, 'u2').querySelector('[data-test=revoke-invitation]')).toBeNull();
    row(root, 'u1').querySelector<HTMLButtonElement>('[data-test=resend-invitation]')!.click();
    await settle(fixture);
    expect(server.requestsTo('POST', '/api/v0/users/u1/invitation')).toHaveLength(1);
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'ivy gets a new invitation email. The earlier link no longer works.',
    );
    row(root, 'u1').querySelector<HTMLButtonElement>('[data-test=revoke-invitation]')!.click();
    await settle(fixture);
    expect(server.requestsTo('DELETE', '/api/v0/users/u1/invitation')).toHaveLength(1);
    expect(row(root, 'u1').querySelector('[data-test=invited]')).toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'The invitation of ivy no longer works.',
    );
  });
});
