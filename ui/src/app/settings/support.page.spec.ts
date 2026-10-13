import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeServer, me, page, provideFakeServer, settle } from '../../testing/fake-server';
import { SessionStore } from '../auth/session';
import { SettingsPage } from './settings.page';
import { SupportPage } from './support.page';

const NAV = {
  point: 'settings.nav',
  id: 'support',
  label: 'Support',
  path: '/settings/ee/support',
};

function setup(options: { admin: boolean; features?: string[] }): FakeServer {
  const features = options.features ?? ['support-bundle'];
  const server = new FakeServer();
  server.on('GET', '/api/v0/organizations', { body: page([]) });
  server.on('GET', '/api/v0/system/info', {
    body: {
      version: '0.8.0',
      edition: 'business',
      features,
      extensions: features.includes('support-bundle') ? [NAV] : [],
    },
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin: options.admin }));
  return server;
}

async function render(): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(SupportPage);
  await settle(fixture);
  return fixture.nativeElement as HTMLElement;
}

describe('SupportPage (4E-3b §5)', () => {
  it('tells an instance admin what the bundle holds and never holds, and links the download', async () => {
    setup({ admin: true });
    const root = await render();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Support');
    const text = root.textContent ?? '';
    expect(text).toContain('configuration and settings without any secret');
    expect(text).toContain('It never contains secrets');
    expect(text).toContain('or your source code');
    const link = root.querySelector<HTMLAnchorElement>('#support-download')!;
    expect(link.textContent?.trim()).toBe('Download support bundle');
    expect(link.getAttribute('href')).toBe('/api/v0/ee/support/bundle');
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('shows both commands for when the web UI is unreachable, and the support address', async () => {
    setup({ admin: true });
    const root = await render();
    expect(root.querySelector<HTMLInputElement>('#support-command-running')!.value).toBe(
      'docker compose exec -T server /usr/local/bin/node dist/main.js support-bundle > qualor-support.zip',
    );
    expect(root.querySelector<HTMLInputElement>('#support-command-stopped')!.value).toBe(
      'docker compose run --rm -T server support-bundle > qualor-support.zip',
    );
    const mail = [...root.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.getAttribute('href')?.startsWith('mailto:'),
    )!;
    expect(mail.getAttribute('href')).toBe('mailto:support@qualor.dev');
    expect(mail.textContent?.trim()).toBe('support@qualor.dev');
  });

  it('offers nothing to a user who is not an instance administrator', async () => {
    setup({ admin: false });
    const root = await render();
    expect(root.textContent).toContain('Only instance administrators download the support bundle.');
    expect(root.querySelector('#support-download')).toBeNull();
    expect(root.querySelector('q-copy-value')).toBeNull();
  });

  it('says the feature is needed, and offers nothing, without the licence feature', async () => {
    setup({ admin: true, features: [] });
    const root = await render();
    expect(root.textContent).toContain(
      'The support bundle needs a Business or Enterprise licence with the support-bundle feature.',
    );
    expect(root.querySelector('#support-download')).toBeNull();
  });
});

describe('SettingsPage and the Support entry (4E-3b §5)', () => {
  async function labels(admin: boolean, features?: string[]): Promise<(string | undefined)[]> {
    setup({ admin, ...(features ? { features } : {}) });
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    return [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('nav a'),
    ].map((a) => a.textContent?.trim());
  }

  it('lists Support once for an instance admin while the feature is active', async () => {
    const list = await labels(true);
    expect(list.filter((l) => l === 'Support')).toHaveLength(1);
  });

  it('hides Support from other users and while the feature is inactive', async () => {
    expect(await labels(false)).not.toContain('Support');
    TestBed.resetTestingModule();
    expect(await labels(true, [])).not.toContain('Support');
  });
});
