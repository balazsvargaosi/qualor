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
import { ConnectedAppsPage } from './connected-apps.page';
import type { OAuthGrant } from './oauth-grants';
import { SettingsPage } from './settings.page';

const G1 = '0190a6c2-0000-7000-8000-0000000000f1';
const G2 = '0190a6c2-0000-7000-8000-0000000000f2';
const GRANTS = '/api/v0/me/oauth-grants';

function grant(id: string, overrides: Partial<OAuthGrant> = {}): OAuthGrant {
  return {
    id,
    client: {
      clientId: 'https://agent.example/client.json',
      name: 'Agent Studio',
      source: 'cimd',
      logoUri: null,
      clientUri: null,
    },
    scopes: ['mcp:read', 'mcp:write'],
    createdAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

function setup(grants: OAuthGrant[], options: { demo?: boolean } = {}): FakeServer {
  const server = new FakeServer();
  server.on('GET', GRANTS, { body: { items: grants } });
  server.on('GET', '/api/v0/organizations', { body: page([]) });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ demo: options.demo ?? false }));
  return server;
}

async function render() {
  const fixture = TestBed.createComponent(ConnectedAppsPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

function button(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

function row(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`tr[data-key="${id}"]`);
}

/** Answers the page's confirmation dialog with `choice` and returns its question. */
async function answer(
  fixture: { whenStable(): Promise<unknown> },
  root: HTMLElement,
  choice: string,
): Promise<string> {
  const ask = root.querySelector<HTMLDialogElement>('dialog[data-test=disconnect-dialog]')!;
  expect(ask.open).toBe(true);
  const question = ask.querySelector('#disconnect-text')?.textContent?.trim() ?? '';
  button(ask, choice)!.click();
  await settle(fixture);
  expect(ask.open).toBe(false);
  return question;
}

describe('ConnectedAppsPage (spec §8)', () => {
  it('lists your apps with their access, connection day and last use', async () => {
    setup([
      grant(G1, { lastUsedAt: '2026-10-17T08:30:00.000Z' }),
      grant(G2, {
        client: {
          clientId: 'qlr_cli_abc',
          name: 'Self-made agent',
          source: 'dcr',
          logoUri: null,
          clientUri: null,
        },
        scopes: ['mcp:read'],
      }),
    ]);
    const { root } = await render();
    const first = row(root, G1)!.textContent ?? '';
    expect(first).toContain('Agent Studio');
    expect(first).toContain('Read and change issue statuses');
    expect(first).toContain('Oct 1, 2026');
    expect(first).toContain('Oct 17, 2026, 8:30 AM UTC');
    expect(first).not.toContain('Not verified');
    const second = row(root, G2)!.textContent ?? '';
    expect(second).toContain('Self-made agent');
    expect(second).toContain('Not verified');
    expect(second).toContain('Read');
    expect(second).toContain('Not used yet');
    expect(row(root, G1)!.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Disconnect Agent Studio',
    );
  });

  it('disconnects after a confirmation, and sends nothing without one', async () => {
    const server = setup([grant(G1)]);
    server.on('DELETE', `${GRANTS}/${G1}`, { status: 204 });
    const confirm = vi.spyOn(window, 'confirm');
    const { fixture, root } = await render();
    button(row(root, G1)!, 'Disconnect')!.click();
    await settle(fixture);
    expect(await answer(fixture, root, 'Cancel')).toBe(
      'Disconnect Agent Studio? It can no longer use Qualor until you connect it again.',
    );
    expect(server.requestsTo('DELETE', `${GRANTS}/${G1}`)).toHaveLength(0);
    server.on('GET', GRANTS, { body: { items: [] } });
    button(row(root, G1)!, 'Disconnect')!.click();
    await settle(fixture);
    await answer(fixture, root, 'Disconnect');
    expect(confirm).not.toHaveBeenCalled();
    expect(server.requestsTo('DELETE', `${GRANTS}/${G1}`)).toHaveLength(1);
    expect(row(root, G1)).toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'Agent Studio disconnected.',
    );
    confirm.mockRestore();
  });

  it('keeps the app and says why when the disconnect fails', async () => {
    const server = setup([grant(G1)]);
    server.on('DELETE', `${GRANTS}/${G1}`, { status: 404, body: problem(404, 'NOT_FOUND') });
    const { fixture, root } = await render();
    button(row(root, G1)!, 'Disconnect')!.click();
    await settle(fixture);
    await answer(fixture, root, 'Disconnect');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'This item does not exist, or you cannot see it.',
    );
    expect(row(root, G1)).not.toBeNull();
  });

  it('says how to connect an app when none is', async () => {
    setup([]);
    const { root } = await render();
    const empty = root.querySelector('[data-test=grants-empty]');
    expect(empty?.textContent).toContain('No apps are connected.');
    expect(empty?.querySelector('a')?.getAttribute('href')).toBe('/docs/mcp');
  });

  it('offers no Disconnect in the read-only demo', async () => {
    setup([grant(G1)], { demo: true });
    const { root } = await render();
    expect(row(root, G1)).not.toBeNull();
    expect(button(root, 'Disconnect')).toBeUndefined();
  });

  it('is listed under Your account, after Access tokens', async () => {
    setup([]);
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const account = (fixture.nativeElement as HTMLElement).querySelector('nav [role="group"]');
    expect([...(account?.querySelectorAll('a') ?? [])].map((a) => a.textContent?.trim())).toEqual([
      'Access tokens',
      'Connected apps',
      'Notifications',
    ]);
  });
});
