import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  FakeAutoFix,
  FakeServer,
  me,
  ORG_ADMIN_PERMISSIONS,
  ORG_ID,
  page,
  provideFakeServer,
  settle,
} from '../../testing/fake-server';
import type { Me } from '../api/types';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';
import { AutoFixPage } from './auto-fix.page';
import { SettingsPage } from './settings.page';

const OTHER_ID = '0190a6c2-0000-7000-8000-000000000002';
const ROUTE = `/api/v0/organizations/${ORG_ID}/ai/auto-fix`;

type Who = 'orgAdmin' | 'member';

function user(who: Who): Me {
  const base = me();
  if (who === 'member') return base;
  return {
    ...base,
    memberships: [
      { ...base.memberships[0]!, role: 'admin', permissions: [...ORG_ADMIN_PERMISSIONS] },
    ],
  };
}

function setup(who: Who = 'orgAdmin'): FakeServer {
  const server = new FakeServer();
  server.on('GET', '/api/v0/organizations', {
    body: page([
      { id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' },
      { id: OTHER_ID, key: 'other', name: 'Other', createdAt: '', updatedAt: '' },
    ]),
  });
  server.on('GET', '/api/v0/system/info', {
    body: { version: '0.8.0', edition: 'enterprise', features: [], extensions: [] },
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(user(who));
  TestBed.inject(OrgContext).select(ORG_ID);
  return server;
}

async function render() {
  const fixture = TestBed.createComponent(AutoFixPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

const field = <T extends HTMLElement>(root: HTMLElement, id: string) =>
  root.querySelector<T>(`#${id}`)!;

function type(root: HTMLElement, id: string, value: string): void {
  const input = field<HTMLInputElement | HTMLSelectElement>(root, id);
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
}

async function save(fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) {
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('AutoFixPage (4E-3a §2, §4)', () => {
  it("shows the organisation's stored settings and says suggestions are posted without a click", async () => {
    const server = setup();
    new FakeAutoFix(server, {
      organizations: { [ORG_ID]: { enabled: true, minSeverity: 'medium', maxPerAnalysis: 4 } },
    });
    const { root } = await render();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Automatic fix suggestions');
    expect(root.textContent).toContain('Suggestions are posted to merge requests without a click.');
    expect(field<HTMLInputElement>(root, 'auto-fix-enabled').checked).toBe(true);
    expect(field<HTMLSelectElement>(root, 'auto-fix-severity').value).toBe('medium');
    expect(field<HTMLInputElement>(root, 'auto-fix-max').value).toBe('4');
    const options = [...field<HTMLSelectElement>(root, 'auto-fix-severity').options];
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      'Blocker',
      'High',
      'Medium',
      'Low',
      'Info',
    ]);
  });

  it('switches them on with a threshold and a maximum, and says so', async () => {
    const server = setup();
    const fake = new FakeAutoFix(server);
    const { fixture, root } = await render();
    field<HTMLInputElement>(root, 'auto-fix-enabled').click();
    type(root, 'auto-fix-severity', 'blocker');
    type(root, 'auto-fix-max', '25');
    await save(fixture, root);
    expect(server.requestsTo('PUT', ROUTE)[0]?.body).toEqual({
      enabled: true,
      minSeverity: 'blocker',
      maxPerAnalysis: 25,
    });
    expect(fake.organizations[ORG_ID]).toEqual({
      enabled: true,
      minSeverity: 'blocker',
      maxPerAnalysis: 25,
    });
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'The automatic fix suggestions were saved.',
    );
  });

  it.each(['0', '26', '2.5', ''])('refuses %j as the maximum and sends nothing', async (value) => {
    const server = setup();
    new FakeAutoFix(server);
    const { fixture, root } = await render();
    type(root, 'auto-fix-max', value);
    await save(fixture, root);
    expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    expect(field(root, 'auto-fix-max').getAttribute('aria-invalid')).toBe('true');
    expect(field(root, 'auto-fix-max-error').textContent).toContain(
      'Use a whole number from 1 to 25.',
    );
    expect(document.activeElement).toBe(field(root, 'auto-fix-max'));
  });

  it('says why switching on was refused when the assistant does not suggest fixes (409 AI_DISABLED)', async () => {
    const server = setup();
    new FakeAutoFix(server, { fixEnabled: false });
    const { fixture, root } = await render();
    field<HTMLInputElement>(root, 'auto-fix-enabled').click();
    await save(fixture, root);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Switching them on needs the AI assistant enabled for this organisation with Suggest a fix.',
    );
  });

  it('shows the Enterprise note in place of the controls without the licence', async () => {
    const server = setup();
    new FakeAutoFix(server, {
      available: false,
      organizations: { [ORG_ID]: { enabled: true, minSeverity: 'low', maxPerAnalysis: 2 } },
    });
    const { root } = await render();
    expect(field(root, 'auto-fix-not-licensed').textContent?.trim()).toBe(
      'Automatic fix suggestions need the Enterprise plan.',
    );
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('#auto-fix-enabled')).toBeNull();
  });

  it('says a licence that lapsed while saving refuses the switch-on (403 FEATURE_NOT_LICENSED)', async () => {
    const server = setup();
    const fake = new FakeAutoFix(server);
    const { fixture, root } = await render();
    fake.available = false;
    field<HTMLInputElement>(root, 'auto-fix-enabled').click();
    await save(fixture, root);
    expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Automatic fix suggestions need the Enterprise plan.',
    );
  });

  it('reads the organisation chosen in the header', async () => {
    const server = setup();
    // An instance admin manages every organisation's.
    TestBed.inject(SessionStore).set(me({ admin: true }));
    new FakeAutoFix(server, {
      organizations: { [OTHER_ID]: { enabled: true, minSeverity: 'info', maxPerAnalysis: 1 } },
    });
    const { fixture, root } = await render();
    expect(field<HTMLInputElement>(root, 'auto-fix-enabled').checked).toBe(false);
    TestBed.inject(OrgContext).select(OTHER_ID);
    await settle(fixture);
    expect(field<HTMLSelectElement>(root, 'auto-fix-severity').value).toBe('info');
    expect(root.querySelector('h3')?.textContent?.trim()).toBe('Other');
  });

  it('drops the answer for an organisation left before it arrived', async () => {
    const server = setup();
    TestBed.inject(SessionStore).set(me({ admin: true }));
    new FakeAutoFix(server, {
      organizations: { [OTHER_ID]: { enabled: true, minSeverity: 'info', maxPerAnalysis: 1 } },
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.on('GET', ROUTE, async () => {
      await held;
      return { body: { available: true, enabled: false, minSeverity: 'low', maxPerAnalysis: 9 } };
    });
    const fixture = TestBed.createComponent(AutoFixPage);
    await settle(fixture);
    TestBed.inject(OrgContext).select(OTHER_ID);
    await settle(fixture);
    release();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(field<HTMLSelectElement>(root, 'auto-fix-severity').value).toBe('info');
    expect(field<HTMLInputElement>(root, 'auto-fix-max').value).toBe('1');
  });

  it("tells an admin of another organisation that this one's are not theirs to change", async () => {
    const server = setup();
    new FakeAutoFix(server);
    const { fixture, root } = await render();
    TestBed.inject(OrgContext).select(OTHER_ID);
    await settle(fixture);
    expect(root.textContent).toContain(
      'Only organisation administrators change the automatic fix suggestions.',
    );
    expect(root.querySelector('form')).toBeNull();
    expect(server.requestsTo('GET', `/api/v0/organizations/${OTHER_ID}/ai/auto-fix`)).toHaveLength(
      0,
    );
  });

  it('tells a member who is not an organisation admin, and asks the server nothing', async () => {
    const server = setup('member');
    new FakeAutoFix(server);
    const { root } = await render();
    expect(root.textContent).toContain(
      'Only organisation administrators change the automatic fix suggestions.',
    );
    expect(server.requests.filter((r) => r.path.endsWith('/ai/auto-fix'))).toHaveLength(0);
  });
});

describe('SettingsPage: Automatic fixes (4E-3a §4)', () => {
  async function labels(who: Who): Promise<(string | undefined)[]> {
    setup(who);
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    return [...root.querySelectorAll('nav a')].map((a) => a.textContent?.trim());
  }

  it('lists Automatic fixes under Organization for org.ai.manage only', async () => {
    expect(await labels('orgAdmin')).toContain('Automatic fixes');
    TestBed.resetTestingModule();
    expect(await labels('member')).not.toContain('Automatic fixes');
  });
});
