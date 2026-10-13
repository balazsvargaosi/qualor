import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeServer, problem, provideFakeServer, settle } from '../../testing/fake-server';
import { ForgotPasswordPage } from './forgot-password.page';

function type(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('ForgotPasswordPage (mail E2)', () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
    TestBed.configureTestingModule({
      imports: [ForgotPasswordPage],
      providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
    });
  });
  const methods = (passwordReset: boolean) =>
    server.on('GET', '/api/v0/auth/methods', {
      body: { password: 'everyone', providers: [], demo: false, passwordReset },
    });
  async function render() {
    const fixture = TestBed.createComponent(ForgotPasswordPage);
    await settle(fixture);
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('sends the typed name and gives the same answer, whatever the server knows', async () => {
    methods(true);
    server.on('POST', '/api/v0/auth/password-reset', { status: 202, body: {} });
    const { fixture, root } = await render();
    expect(root.querySelector('label[for="forgot-login"]')?.textContent).toContain(
      'Username or email',
    );
    type(root, '#forgot-login', '  rita@example.test ');
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(server.requestsTo('POST', '/api/v0/auth/password-reset')[0]?.body).toEqual({
      login: 'rita@example.test',
    });
    expect(root.querySelector('[data-test=reset-sent]')?.textContent).toContain(
      "If an account matches, we've sent an email with a link. It works for 60 minutes.",
    );
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('a[href="/login"]')).not.toBeNull();
  });

  it('tells people to ask an administrator when the server cannot send links', async () => {
    methods(false);
    const { root } = await render();
    expect(root.querySelector('[data-test=reset-unavailable]')?.textContent).toContain(
      'Ask an administrator to reset your password.',
    );
    expect(root.querySelector('form')).toBeNull();
  });

  it('shows a refusal (429) as an error, never as sent', async () => {
    methods(true);
    server.on('POST', '/api/v0/auth/password-reset', {
      status: 429,
      body: problem(429, 'RATE_LIMITED'),
      headers: { 'retry-after': '60' },
    });
    const { fixture, root } = await render();
    type(root, '#forgot-login', 'rita');
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.querySelector('[data-test=reset-sent]')).toBeNull();
  });
});
