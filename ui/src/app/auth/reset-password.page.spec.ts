import { BrowserPlatformLocation, PlatformLocation } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { FakeServer, problem, provideFakeServer, settle } from '../../testing/fake-server';
import { ResetPasswordPage } from './reset-password.page';

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
  type(root, '#reset-new', next);
  type(root, '#reset-confirm', confirm);
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('ResetPasswordPage (mail E2)', () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
    TestBed.configureTestingModule({
      imports: [ResetPasswordPage],
      providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
    });
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  async function render(url: string) {
    window.history.replaceState(null, '', url);
    const fixture = TestBed.createComponent(ResetPasswordPage);
    await settle(fixture);
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('takes the token from the fragment, clears it, posts it in the body and goes to sign-in', async () => {
    server.on('POST', '/api/v0/auth/password-reset/complete', { body: { username: 'rita' } });
    const { fixture, root } = await render('/reset-password#token=AbC123');
    expect(window.location.hash).toBe('');
    await fill(root, fixture, 'a long new passphrase', 'a long new passphrase');
    const [request] = server.requestsTo('POST', '/api/v0/auth/password-reset/complete');
    expect(request?.body).toEqual({ token: 'AbC123', newPassword: 'a long new passphrase' });
    expect(request?.query.toString()).toBe('');
    expect(TestBed.inject(Router).url).toBe('/login?reset=done&username=rita');
  });

  it('clears the fragment again when it is written back before the page first shows', async () => {
    server.on('POST', '/api/v0/auth/password-reset/complete', { body: { username: 'rita' } });
    window.history.replaceState(null, '', '/reset-password#token=AbC123');
    const fixture = TestBed.createComponent(ResetPasswordPage);
    expect(window.location.hash).toBe('');
    // A router finishing its navigation late writes the address it started from back.
    window.history.replaceState(window.history.state, '', '/reset-password#token=AbC123');
    await settle(fixture);
    expect(window.location.hash).toBe('');
    const root = fixture.nativeElement as HTMLElement;
    await fill(root, fixture, 'a long new passphrase', 'a long new passphrase');
    expect(server.requestsTo('POST', '/api/v0/auth/password-reset/complete')[0]?.body).toEqual({
      token: 'AbC123',
      newPassword: 'a long new passphrase',
    });
  });

  it('checks length and confirmation before asking the server', async () => {
    const { fixture, root } = await render('/reset-password#token=AbC123');
    await fill(root, fixture, 'short', 'short');
    expect(root.textContent).toContain('Use at least 12 characters.');
    await fill(root, fixture, 'a long new passphrase', 'a different one here');
    expect(root.textContent).toContain('The two new passwords differ.');
    expect(server.requests).toEqual([]);
  });

  it('says the link expired, with a way to ask for a new one, on 400 TOKEN_INVALID', async () => {
    server.on('POST', '/api/v0/auth/password-reset/complete', {
      status: 400,
      body: problem(400, 'TOKEN_INVALID'),
    });
    const { fixture, root } = await render('/reset-password#token=AbC123');
    await fill(root, fixture, 'a long new passphrase', 'a long new passphrase');
    expect(root.querySelector('[data-test=token-invalid]')?.textContent).toContain(
      'This link has expired or was already used. Ask for a new one.',
    );
    expect(root.querySelector('a[href="/forgot-password"]')).not.toBeNull();
    expect(root.querySelector('form')).toBeNull();
  });

  it('says so at once when the address has no token, and asks nothing', async () => {
    const { root } = await render('/reset-password');
    expect(root.querySelector('[data-test=token-invalid]')).not.toBeNull();
    expect(server.requests).toEqual([]);
  });
});

describe('ResetPasswordPage opened by the router (mail E2, preflight M15)', () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'reset-password', component: ResetPasswordPage },
          { path: 'login', children: [] },
        ]),
        provideFakeServer(server),
        // The real address bar, not TestBed's stand-in: the router writes to window.history.
        { provide: PlatformLocation, useClass: BrowserPlatformLocation },
      ],
    });
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('keeps the fragment out of the address bar when the router writes the URL of its first navigation', async () => {
    server.on('POST', '/api/v0/auth/password-reset/complete', { body: { username: 'rita' } });
    window.history.replaceState(null, '', '/reset-password#token=AbC123');
    const harness = await RouterTestingHarness.create();
    // As at start-up: the router navigates to the address the browser opened, fragment included,
    // and writes that address (with the fragment) to the address bar as it activates the page.
    TestBed.inject(Router).initialNavigation();
    await settle(harness.fixture);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('AbC123');
    await fill(
      harness.routeNativeElement!,
      harness.fixture,
      'a long new passphrase',
      'a long new passphrase',
    );
    expect(server.requestsTo('POST', '/api/v0/auth/password-reset/complete')[0]?.body).toEqual({
      token: 'AbC123',
      newPassword: 'a long new passphrase',
    });
    expect(window.location.pathname).toBe('/login');
    expect(window.location.href).not.toContain('AbC123');
  });
});
