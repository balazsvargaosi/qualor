import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeServer, me, provideFakeServer, settle } from '../../testing/fake-server';
import { SessionStore } from '../auth/session';
import { UpdateBanner } from './update-banner';
import { DISMISS_KEY } from './update-notice';

function setup(body: { version: string; latest?: string }, admin = true): FakeServer {
  const server = new FakeServer();
  server.on('GET', '/api/v0/system/version', { body });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin }));
  return server;
}

async function render() {
  const fixture = TestBed.createComponent(UpdateBanner);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

/** The banner's text as it reads: template line breaks collapse to one space, as on screen. */
function text(root: HTMLElement): string {
  return (root.querySelector('[role="status"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('UpdateBanner (telemetry.md "Update check")', () => {
  beforeEach(() => {
    localStorage.removeItem(DISMISS_KEY);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(DISMISS_KEY);
  });

  it('asks nothing and shows nothing to a user who is not an instance admin', async () => {
    const server = setup({ version: '0.7.1', latest: '0.8.0' }, false);
    const { root } = await render();
    expect(root.textContent?.trim()).toBe('');
    expect(server.requestsTo('GET', '/api/v0/system/version')).toHaveLength(0);
  });

  it('shows nothing, and no status region, while the server is up to date', async () => {
    setup({ version: '0.7.1' });
    const { root } = await render();
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it('tells an admin about the new release, with release notes and upgrade links', async () => {
    setup({ version: '0.7.1', latest: '0.8.0' });
    const { root } = await render();
    expect(text(root)).toContain('Qualor 0.8.0 is available. This server runs 0.7.1.');
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/qualor-dev/qualor/releases/tag/v0.8.0',
      '/docs/install-server#upgrades',
    ]);
  });

  it('hides after Dismiss and remembers that release', async () => {
    setup({ version: '0.7.1', latest: '0.8.0' });
    const { fixture, root } = await render();
    root.querySelector<HTMLButtonElement>('button')!.click();
    await settle(fixture);
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe('0.8.0');
  });

  it('stays hidden for a dismissed release', async () => {
    localStorage.setItem(DISMISS_KEY, '0.8.0');
    setup({ version: '0.7.1', latest: '0.8.0' });
    const { root } = await render();
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it('shows again for a newer release than the dismissed one', async () => {
    localStorage.setItem(DISMISS_KEY, '0.8.0');
    setup({ version: '0.7.1', latest: '0.9.0' });
    const { root } = await render();
    expect(text(root)).toContain('Qualor 0.9.0 is available');
  });

  it('still shows, and still dismisses, when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setup({ version: '0.7.1', latest: '0.8.0' });
    const { fixture, root } = await render();
    expect(text(root)).toContain('Qualor 0.8.0 is available');
    root.querySelector<HTMLButtonElement>('button')!.click();
    await settle(fixture);
    expect(root.querySelector('[role="status"]')).toBeNull();
  });
});
