import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  FakeLicensePolicy,
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
import type { LicensePolicy } from './license-policy';
import { LicensePolicyPage } from './license-policy.page';
import { SettingsPage } from './settings.page';

const OTHER_ID = '0190a6c2-0000-7000-8000-000000000002';
const ROUTE = `/api/v0/organizations/${ORG_ID}/license-policy`;

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

function setup(who: Who = 'orgAdmin', features: string[] = ['license-policy']): FakeServer {
  const server = new FakeServer();
  server.on('GET', '/api/v0/organizations', {
    body: page([
      { id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' },
      { id: OTHER_ID, key: 'other', name: 'Other', createdAt: '', updatedAt: '' },
    ]),
  });
  server.on('GET', '/api/v0/system/info', {
    body: { version: '0.9.0', edition: 'enterprise', features, extensions: [] },
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(user(who));
  TestBed.inject(OrgContext).select(ORG_ID);
  return server;
}

const STORED: LicensePolicy = {
  mode: 'denylist',
  forbiddenGroups: ['network-copyleft'],
  forbidden: ['GPL-3.0-only'],
  allowed: ['LGPL-3.0-only'],
  warnUnknown: true,
};

async function render() {
  const fixture = TestBed.createComponent(LicensePolicyPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const field = <T extends HTMLElement>(root: HTMLElement, id: string) =>
  root.querySelector<T>(`#${id}`)!;
const chips = (root: HTMLElement, list: 'forbidden' | 'allowed') =>
  [...root.querySelectorAll(`#license-policy-${list}-chips li`)].map((li) =>
    li.querySelector('.chip-text')?.textContent?.trim(),
  );

async function add(
  fixture: { whenStable(): Promise<unknown> },
  root: HTMLElement,
  list: 'forbidden' | 'allowed',
  value: string,
): Promise<void> {
  const input = field<HTMLInputElement>(root, `license-policy-${list}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await settle(fixture);
}

async function save(fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) {
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('LicensePolicyPage (6M §8)', () => {
  // OrgContext keeps the chosen organization in localStorage; the next spec must not inherit it.
  afterEach(() => localStorage.clear());

  it("shows the organisation's stored policy", async () => {
    const server = setup();
    FakeLicensePolicy.install(server, { policies: { [ORG_ID]: STORED } });
    const { root } = await render();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Licence policy');
    const modes = [...root.querySelectorAll<HTMLInputElement>('input[name="license-policy-mode"]')];
    expect(modes.map((m) => text(m.closest('label')))).toEqual([
      'Forbid listed licences',
      'Allow only listed licences',
    ]);
    expect(modes.map((m) => m.checked)).toEqual([true, false]);
    const groups = [...root.querySelectorAll<HTMLInputElement>('[data-group] input')];
    expect(groups.map((g) => [text(g.closest('label')), g.checked])).toEqual([
      ['Network copyleft', true],
      ['Strong copyleft', false],
      ['Weak copyleft', false],
      ['Non-commercial or source-available', false],
    ]);
    expect(chips(root, 'forbidden')).toEqual(['GPL-3.0-only']);
    expect(chips(root, 'allowed')).toEqual(['LGPL-3.0-only']);
    expect(text(root.querySelector('label[for="license-policy-forbidden"]'))).toBe(
      'Forbidden licences',
    );
    expect(text(root.querySelector('label[for="license-policy-allowed"]'))).toBe(
      'Allowed licences',
    );
    expect(field<HTMLInputElement>(root, 'license-policy-warn-unknown').checked).toBe(true);
    expect(text(root.querySelector('label[for="license-policy-warn-unknown"]'))).toBe(
      'Warn about dependencies with unknown licences',
    );
    // The SPDX ids of the answer are offered as the fields type.
    expect(
      [...root.querySelectorAll<HTMLOptionElement>('#license-policy-spdx option')].map(
        (o) => o.value,
      ),
    ).toContain('Apache-2.0');
  });

  it("shows each group's members on demand", async () => {
    const server = setup();
    FakeLicensePolicy.install(server);
    const { fixture, root } = await render();
    const group = root.querySelector('[data-group="strong-copyleft"]')!;
    const toggle = group.querySelector<HTMLButtonElement>('button')!;
    expect(toggle.getAttribute('aria-label')).toBe('4 licences in Strong copyleft');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(group.querySelector<HTMLElement>('.group-members')?.hidden).toBe(true);
    toggle.click();
    await settle(fixture);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect([...group.querySelectorAll('.group-members code')].map(text)).toEqual([
      'GPL-2.0-only',
      'GPL-2.0-or-later',
      'GPL-3.0-only',
      'GPL-3.0-or-later',
    ]);
  });

  it('saves a denylist that forbids strong copyleft, and says so', async () => {
    const server = setup();
    const fake = FakeLicensePolicy.install(server);
    const { fixture, root } = await render();
    // No policy yet: nothing to remove.
    expect([...root.querySelectorAll('button')].map(text)).not.toContain('Remove policy');
    root.querySelector<HTMLInputElement>('[data-group="strong-copyleft"] input')!.click();
    await add(fixture, root, 'forbidden', 'agpl-3.0-only');
    await add(fixture, root, 'allowed', 'MIT, ISC');
    field<HTMLInputElement>(root, 'license-policy-warn-unknown').click();
    await save(fixture, root);
    expect(server.requestsTo('PUT', ROUTE)[0]?.body).toEqual({
      policy: {
        mode: 'denylist',
        forbiddenGroups: ['strong-copyleft'],
        // Typed in any case: sent in the spelling of the SPDX list.
        forbidden: ['AGPL-3.0-only'],
        allowed: ['MIT', 'ISC'],
        warnUnknown: true,
      },
    });
    expect(fake.policies[ORG_ID]?.allowed).toEqual(['ISC', 'MIT']);
    expect(text(root.querySelector('[role="status"]'))).toBe(
      "The licence policy was saved. It applies from each project's next analysis.",
    );
    // The answer's sorted lists are shown.
    expect(chips(root, 'allowed')).toEqual(['ISC', 'MIT']);
    expect([...root.querySelectorAll('button')].map(text)).toContain('Remove policy');
  });

  it('removes a chip, and adds an entry only once', async () => {
    const server = setup();
    FakeLicensePolicy.install(server, { policies: { [ORG_ID]: STORED } });
    const { fixture, root } = await render();
    await add(fixture, root, 'forbidden', 'GPL-3.0-only');
    expect(chips(root, 'forbidden')).toEqual(['GPL-3.0-only']);
    const remove = root.querySelector<HTMLButtonElement>('#license-policy-forbidden-chips button')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove GPL-3.0-only');
    remove.click();
    await settle(fixture);
    expect(chips(root, 'forbidden')).toEqual([]);
  });

  it('allows only listed licences: no groups and no forbidden list, and at least one allowed', async () => {
    const server = setup();
    FakeLicensePolicy.install(server, { policies: { [ORG_ID]: STORED } });
    const { fixture, root } = await render();
    root
      .querySelector<HTMLInputElement>('input[name="license-policy-mode"][value="allowlist"]')!
      .click();
    await settle(fixture);
    expect(root.querySelector('[data-group]')).toBeNull();
    expect(root.querySelector('#license-policy-forbidden')).toBeNull();
    root.querySelector<HTMLButtonElement>('#license-policy-allowed-chips button')!.click();
    await settle(fixture);
    await save(fixture, root);
    expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    const allowed = field<HTMLInputElement>(root, 'license-policy-allowed');
    expect(allowed.getAttribute('aria-invalid')).toBe('true');
    expect(text(field(root, 'license-policy-allowed-error'))).toBe(
      'Name at least one allowed licence: this mode forbids every other one.',
    );
    expect(document.activeElement).toBe(allowed);

    await add(fixture, root, 'allowed', 'Apache-2.0');
    await save(fixture, root);
    expect(server.requestsTo('PUT', ROUTE)[0]?.body).toEqual({
      policy: {
        mode: 'allowlist',
        forbiddenGroups: [],
        forbidden: [],
        allowed: ['Apache-2.0'],
        warnUnknown: true,
      },
    });
  });

  it('refuses more than 500 entries in a list', async () => {
    const server = setup();
    const many = Array.from({ length: 500 }, (_, i) => `LicenseRef-${i}`);
    FakeLicensePolicy.install(server, {
      policies: { [ORG_ID]: { ...STORED, forbidden: many } },
    });
    const { fixture, root } = await render();
    await add(fixture, root, 'forbidden', 'MIT');
    expect(chips(root, 'forbidden')).toHaveLength(500);
    expect(text(field(root, 'license-policy-forbidden-error'))).toBe(
      'A list holds at most 500 licences.',
    );
  });

  it('marks the entries the server refuses (400 INVALID_LICENSE_ID) on their field', async () => {
    const server = setup();
    FakeLicensePolicy.install(server);
    const { fixture, root } = await render();
    await add(fixture, root, 'forbidden', 'GPL-3.0-only');
    await add(fixture, root, 'forbidden', 'Not-A-Licence');
    await save(fixture, root);
    const input = field<HTMLInputElement>(root, 'license-policy-forbidden');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(text(field(root, 'license-policy-forbidden-error'))).toBe(
      'Not an SPDX licence identifier: Not-A-Licence. Remove it or correct its spelling.',
    );
    const bad = [...root.querySelectorAll('#license-policy-forbidden-chips li')].find(
      (li) => li.querySelector('.chip-text')?.textContent?.trim() === 'Not-A-Licence',
    );
    expect(bad?.classList).toContain('chip-invalid');
    expect(root.querySelector('#license-policy-allowed-error')).toBeNull();
    expect(document.activeElement).toBe(input);
    // Removing the bad entry clears the message.
    bad!.querySelector('button')!.click();
    await settle(fixture);
    expect(root.querySelector('#license-policy-forbidden-error')).toBeNull();
  });

  it('removes the policy after a designed confirmation, never confirm()', async () => {
    const server = setup();
    const fake = FakeLicensePolicy.install(server, { policies: { [ORG_ID]: STORED } });
    const confirm = vi.spyOn(window, 'confirm');
    const { fixture, root } = await render();
    const remove = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => text(b) === 'Remove policy',
    )!;
    remove.click();
    await settle(fixture);
    const dialog = root.querySelector<HTMLDialogElement>('#license-policy-remove-dialog')!;
    expect(dialog.open).toBe(true);
    expect(text(dialog.querySelector('h2'))).toBe('Remove the licence policy');
    expect(text(dialog.querySelector('#license-policy-remove-text'))).toBe(
      "Remove the licence policy? Each project's next analysis closes its licence findings.",
    );
    // Cancel keeps it.
    [...dialog.querySelectorAll('button')].find((b) => text(b) === 'Cancel')!.click();
    await settle(fixture);
    expect(dialog.open).toBe(false);
    expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);

    remove.click();
    await settle(fixture);
    [...dialog.querySelectorAll('button')].find((b) => text(b) === 'Remove')!.click();
    await settle(fixture);
    expect(server.requestsTo('PUT', ROUTE)[0]?.body).toEqual({ policy: null });
    expect(fake.policies[ORG_ID]).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(text(root.querySelector('[role="status"]'))).toBe('The licence policy was removed.');
    expect(chips(root, 'forbidden')).toEqual([]);
    expect([...root.querySelectorAll('button')].map(text)).not.toContain('Remove policy');
  });

  it('shows the Business note in place of the controls without the licence', async () => {
    const server = setup();
    FakeLicensePolicy.install(server, { available: false, policies: { [ORG_ID]: STORED } });
    const { root } = await render();
    expect(text(field(root, 'license-policy-not-licensed'))).toBe(
      'A licence policy needs the Business plan.',
    );
    expect(root.querySelector('form')).toBeNull();
  });

  it('says a licence that lapsed while saving refuses the change (403 FEATURE_NOT_LICENSED)', async () => {
    const server = setup();
    const fake = FakeLicensePolicy.install(server);
    const { fixture, root } = await render();
    fake.available = false;
    await add(fixture, root, 'forbidden', 'MIT');
    await save(fixture, root);
    expect(text(root.querySelector('[role="alert"]'))).toBe(
      'A licence policy needs the Business plan.',
    );
  });

  it('reads the organisation chosen in the header', async () => {
    const server = setup();
    TestBed.inject(SessionStore).set(me({ admin: true }));
    FakeLicensePolicy.install(server, { policies: { [OTHER_ID]: STORED } });
    const { fixture, root } = await render();
    expect(chips(root, 'forbidden')).toEqual([]);
    TestBed.inject(OrgContext).select(OTHER_ID);
    await settle(fixture);
    expect(chips(root, 'forbidden')).toEqual(['GPL-3.0-only']);
    expect(root.querySelector('h3')?.textContent?.trim()).toBe('Other');
  });

  it('tells a member who is not an organisation admin, and asks the server nothing', async () => {
    const server = setup('member');
    FakeLicensePolicy.install(server);
    const { root } = await render();
    expect(root.textContent).toContain(
      'Only organisation administrators change the licence policy.',
    );
    expect(server.requests.filter((r) => r.path.endsWith('/license-policy'))).toHaveLength(0);
  });
});

describe('SettingsPage: Licence policy (6M §8)', () => {
  // OrgContext keeps the chosen organization in localStorage; the next spec must not inherit it.
  afterEach(() => localStorage.clear());

  async function labels(who: Who, features?: string[]): Promise<(string | undefined)[]> {
    setup(who, features);
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    return [...root.querySelectorAll('nav a')].map((a) => a.textContent?.trim());
  }

  it('lists Licence policy under Organization for org.licenses.manage only', async () => {
    expect(await labels('orgAdmin')).toContain('Licence policy');
    TestBed.resetTestingModule();
    expect(await labels('member')).not.toContain('Licence policy');
  });

  it('hides it without the license-policy feature; the address still shows the Business note', async () => {
    expect(await labels('orgAdmin', [])).not.toContain('Licence policy');
  });
});
