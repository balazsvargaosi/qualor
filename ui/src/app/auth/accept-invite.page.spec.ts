import { BrowserPlatformLocation, PlatformLocation } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { FakeServer, problem, provideFakeServer, settle } from '../../testing/fake-server';
import { AcceptInvitePage } from './accept-invite.page';

const INSPECT = '/api/v0/auth/invitations/inspect';
const ACCEPT = '/api/v0/auth/invitations/accept';

function type(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function fill(
  root: HTMLElement,
  fixture: { whenStable(): Promise<unknown> },
  next: string,
  confirm: string,
) {
  type(root, '#invite-new', next);
  type(root, '#invite-confirm', confirm);
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('AcceptInvitePage (mail E2)', () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
    TestBed.configureTestingModule({
      imports: [AcceptInvitePage],
      providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
    });
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  async function render(url: string) {
    window.history.replaceState(null, '', url);
    const fixture = TestBed.createComponent(AcceptInvitePage);
    await settle(fixture);
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('welcomes the person by name, sets the password and goes to sign-in', async () => {
    server.on('POST', INSPECT, {
      body: { username: 'ivy', displayName: 'Ivy Lane', invitedBy: 'Ada Admin' },
    });
    server.on('POST', ACCEPT, { body: { username: 'ivy' } });
    const { fixture, root } = await render('/accept-invite#token=AbC123');
    expect(window.location.hash).toBe('');
    expect(server.requestsTo('POST', INSPECT)[0]?.body).toEqual({ token: 'AbC123' });
    expect(root.querySelector('[data-test=welcome]')?.textContent).toContain(
      'Welcome, Ivy Lane. Choose a password for ivy.',
    );
    expect(root.textContent).toContain('Ada Admin invited you.');
    expect(root.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.value).toBe(
      'ivy',
    );
    await fill(root, fixture, 'my own first passphrase', 'my own first passphrase');
    expect(server.requestsTo('POST', ACCEPT)[0]?.body).toEqual({
      token: 'AbC123',
      newPassword: 'my own first passphrase',
    });
    expect(TestBed.inject(Router).url).toBe('/login?invite=done&username=ivy');
  });

  it('falls back to the username when there is no display name', async () => {
    server.on('POST', INSPECT, { body: { username: 'ivy', displayName: null, invitedBy: null } });
    const { root } = await render('/accept-invite#token=AbC123');
    expect(root.querySelector('[data-test=welcome]')?.textContent).toContain('Welcome, ivy.');
  });

  it('checks length and confirmation before asking the server', async () => {
    server.on('POST', INSPECT, { body: { username: 'ivy', displayName: null, invitedBy: null } });
    const { fixture, root } = await render('/accept-invite#token=AbC123');
    await fill(root, fixture, 'short', 'short');
    expect(root.textContent).toContain('Use at least 12 characters.');
    await fill(root, fixture, 'a long new passphrase', 'a different one here');
    expect(root.textContent).toContain('The two new passwords differ.');
    expect(server.requestsTo('POST', ACCEPT)).toEqual([]);
  });

  it('says the invitation is no longer valid on 400 TOKEN_INVALID, shows no form and focuses the note', async () => {
    server.on('POST', INSPECT, { status: 400, body: problem(400, 'TOKEN_INVALID') });
    const { root } = await render('/accept-invite#token=AbC123');
    const note = root.querySelector<HTMLElement>('[data-test=token-invalid]');
    expect(note?.textContent).toContain(
      'This invitation has expired or was already used. Ask your administrator for a new one.',
    );
    expect(root.querySelector('form')).toBeNull();
    expect(document.activeElement).toBe(note);
  });

  it('replaces the form with the note, and focuses it, when accepting says TOKEN_INVALID', async () => {
    server.on('POST', INSPECT, { body: { username: 'ivy', displayName: null, invitedBy: null } });
    server.on('POST', ACCEPT, { status: 400, body: problem(400, 'TOKEN_INVALID') });
    const { fixture, root } = await render('/accept-invite#token=AbC123');
    await fill(root, fixture, 'my own first passphrase', 'my own first passphrase');
    const note = root.querySelector<HTMLElement>('[data-test=token-invalid]');
    expect(note).not.toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(document.activeElement).toBe(note);
  });

  it('shows the problem, not the invalid-link note, when the server cannot answer', async () => {
    server.on('POST', INSPECT, { status: 500, body: problem(500, 'INTERNAL') });
    const { root } = await render('/accept-invite#token=AbC123');
    expect(root.querySelector('[data-test=token-invalid]')).toBeNull();
    expect(root.querySelector('[role=alert]')).not.toBeNull();
  });

  it('asks nothing when the address has no token', async () => {
    const { root } = await render('/accept-invite');
    expect(root.querySelector('[data-test=token-invalid]')).not.toBeNull();
    expect(server.requests).toEqual([]);
  });
});

describe('AcceptInvitePage opened by the router (mail E2)', () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'accept-invite', component: AcceptInvitePage },
          { path: 'login', children: [] },
        ]),
        provideFakeServer(server),
        // The real address bar, not TestBed's stand-in: the router writes to window.history.
        { provide: PlatformLocation, useClass: BrowserPlatformLocation },
      ],
    });
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('keeps the fragment out of the address bar and the router url, and still posts the token', async () => {
    server.on('POST', INSPECT, { body: { username: 'ivy', displayName: 'Ivy', invitedBy: null } });
    server.on('POST', ACCEPT, { body: { username: 'ivy' } });
    window.history.replaceState(null, '', '/accept-invite#token=AbC123');
    const harness = await RouterTestingHarness.create();
    const router = TestBed.inject(Router);
    router.initialNavigation();
    await settle(harness.fixture);
    const page = harness.routeNativeElement!;
    expect(page.querySelector('#invite-new')?.getAttribute('maxlength')).toBe('256');
    expect(page.querySelector('#invite-confirm')?.getAttribute('maxlength')).toBe('256');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('AbC123');
    expect(router.url).toBe('/accept-invite');
    await router.navigateByUrl('/nowhere').catch(() => undefined);
    await settle(harness.fixture);
    expect(window.location.href).not.toContain('AbC123');
    expect(harness.routeNativeElement).toBe(page);
    await fill(page, harness.fixture, 'my own first passphrase', 'my own first passphrase');
    expect(server.requestsTo('POST', INSPECT)[0]?.body).toEqual({ token: 'AbC123' });
    expect(server.requestsTo('POST', ACCEPT)[0]?.body).toEqual({
      token: 'AbC123',
      newPassword: 'my own first passphrase',
    });
    expect(window.location.pathname).toBe('/login');
    expect(window.location.href).not.toContain('AbC123');
  });
});
