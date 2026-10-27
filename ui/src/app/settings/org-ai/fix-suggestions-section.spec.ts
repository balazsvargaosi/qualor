import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { orgAi } from '../../../testing/ai-settings';
import {
  FakeAutoFix,
  type FakeAutoFixOptions,
  FakeServer,
  me,
  ORG_ADMIN_PERMISSIONS,
  ORG_ID,
  page,
  problem,
  projectItem,
  provideFakeServer,
  settle,
} from '../../../testing/fake-server';
import type { ItemOf, Me } from '../../api/types';
import { SessionStore } from '../../auth/session';
import { OrgContext } from '../../org/org-context';
import type { StatusLine } from '../../shared/status-list';
import { FixSuggestionsSection } from './fix-suggestions-section';

type Project = ItemOf<'/api/v0/projects'>;

const OTHER_ID = '0190a6c2-0000-7000-8000-000000000002';
const ROUTE = `/api/v0/organizations/${ORG_ID}/ai/auto-fix`;
/** Payments posts the suggestions; Web Shop's admins opted out. */
const PROJECTS: Project[] = [
  projectItem({ id: 'p1', key: 'acme/payments', name: 'Payments' }),
  projectItem({ id: 'p2', key: 'acme/web-shop', name: 'Web Shop', autoFix: { enabled: false } }),
];
/** The assistant's features with Suggest a fix on, which the suggestions need. */
const FIX_ON = { explain: true, triage: true, fix: true };
const STORED_ON = { enabled: true, minSeverity: 'high', maxPerAnalysis: 10 } as const;
const SAVED_AT = /^Saved at \d{1,2}:\d{2} [AP]M UTC\.$/;

type Who = 'orgAdmin' | 'instanceAdmin';

function user(who: Who): Me {
  if (who === 'instanceAdmin') return me({ admin: true });
  const base = me();
  return {
    ...base,
    memberships: [
      { ...base.memberships[0]!, role: 'admin', permissions: [...ORG_ADMIN_PERMISSIONS] },
    ],
  };
}

function setup(
  options: FakeAutoFixOptions = {},
  who: Who = 'orgAdmin',
): { server: FakeServer; fake: FakeAutoFix } {
  const server = new FakeServer();
  server.on('GET', '/api/v0/organizations', {
    body: page([{ id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' }]),
  });
  const fake = FakeAutoFix.install(server, options);
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(user(who));
  TestBed.inject(OrgContext).select(ORG_ID);
  return { server, fake };
}

/** The section for Default, with its projects and its assistant (Suggest a fix on by default). */
async function render(
  given: { assistant?: object | null; projects?: readonly Project[] | null } = {},
) {
  const fixture = TestBed.createComponent(FixSuggestionsSection);
  fixture.componentRef.setInput('organizationId', ORG_ID);
  fixture.componentRef.setInput('organizationName', 'Default');
  fixture.componentRef.setInput(
    'projects',
    given.projects === undefined ? PROJECTS : given.projects,
  );
  fixture.componentRef.setInput(
    'orgAi',
    given.assistant === undefined ? orgAi({ features: FIX_ON }) : given.assistant,
  );
  const lines: (StatusLine | null)[] = [];
  fixture.componentInstance.status.subscribe((line) => lines.push(line));
  await settle(fixture);
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    section: fixture.componentInstance,
    /** The status line the section said last. */
    status: () => lines.at(-1),
  };
}

type Fixture = { whenStable(): Promise<unknown> };

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const field = <T extends HTMLElement = HTMLInputElement>(root: HTMLElement, id: string) =>
  root.querySelector<T>(`#${id}`)!;
const button = (within: Element, name: string) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === name);
const foot = (root: HTMLElement) => text(root.querySelector('.foot-status'));
/** The texts of the ids an attribute names (`aria-labelledby`, `aria-describedby`). */
const named = (root: HTMLElement, el: Element, attribute: string) =>
  (el.getAttribute(attribute) ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => text(root.querySelector(`#${id}`)));

function type(root: HTMLElement, id: string, value: string): void {
  const input = field<HTMLInputElement | HTMLSelectElement>(root, id);
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
}

async function click(fixture: Fixture, target: HTMLElement | undefined) {
  target!.click();
  await settle(fixture);
}

/** Presses Save fix suggestions once what was typed has rendered (it enables Save). */
async function save(fixture: Fixture, root: HTMLElement) {
  await settle(fixture);
  await click(fixture, button(root, 'Save fix suggestions'));
}

describe('FixSuggestionsSection (AI settings redesign, Task 6)', () => {
  it('shows the stored settings under its title, with the switch named by its name and described by its help', async () => {
    setup({
      organizations: { [ORG_ID]: { enabled: true, minSeverity: 'medium', maxPerAnalysis: 4 } },
    });
    const { root, status } = await render();
    const section = root.querySelector<HTMLElement>('section#fix-suggestions')!;
    expect(text(section.querySelector('h3'))).toBe('Automatic fix suggestions');
    expect(section.querySelector('h3')?.getAttribute('tabindex')).toBe('-1');
    expect(text(section.querySelector('.sec-purpose'))).toBe(
      'Qualor suggests fixes for the new findings of each analysed merge request and posts them as suggestion comments, without anyone asking. Nothing is committed.',
    );
    expect(
      [...section.querySelectorAll('.sec-chips .badge')].map((b) => [text(b), b.classList[1]]),
    ).toEqual([
      ['On', 'badge-passed'],
      ['Enterprise', 'badge-tag'],
    ]);
    const toggle = field(root, 'auto-fix-enabled');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.checked).toBe(true);
    expect(named(root, toggle, 'aria-labelledby')).toEqual(['Post fix suggestions automatically']);
    expect(named(root, toggle, 'aria-describedby')).toEqual([
      'For the new findings of each merge request, within the daily fix budget (25).',
    ]);
    expect(field<HTMLSelectElement>(root, 'auto-fix-severity').value).toBe('medium');
    expect(field(root, 'auto-fix-max').value).toBe('4');
    expect(
      [...field<HTMLSelectElement>(root, 'auto-fix-severity').options].map((o) => text(o)),
    ).toEqual(['Blocker', 'High', 'Medium', 'Low', 'Info']);
    expect(foot(root)).toBe('No unsaved changes');
    expect(status()).toEqual({
      key: 'fix',
      label: 'Fix suggestions',
      tone: 'ok',
      state: 'On',
      text: 'For new findings of Medium and above.',
      tags: ['Enterprise'],
    });
  });

  it('needs Suggest a fix: the switch is off and says who turns it on', async () => {
    setup();
    const { root, status } = await render({ assistant: orgAi() });
    const toggle = field(root, 'auto-fix-enabled');
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    const note = field(root, 'auto-fix-needs-fix');
    expect(text(note)).toBe(
      'Needs Suggest a fix for Default, which an instance admin turns on in Settings → AI provider.',
    );
    // The requirement stands above the switch it disables, which points at it.
    expect(note.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.getAttribute('aria-describedby')?.split(' ')).toContain('auto-fix-needs-fix');
    // An organisation admin cannot open the AI provider's settings: the place is named only.
    expect(note.querySelector('a')).toBeNull();
    expect(root.querySelector('.dep')).toBeNull();
    expect(status()).toEqual({
      key: 'fix',
      label: 'Fix suggestions',
      tone: 'off',
      state: 'Off',
      tags: ['Enterprise'],
    });
  });

  it('links the AI provider settings in the requirement for an instance admin', async () => {
    setup({}, 'instanceAdmin');
    const { root } = await render({ assistant: orgAi() });
    expect(field(root, 'auto-fix-needs-fix').querySelector('a')?.getAttribute('href')).toBe(
      '/settings/ai',
    );
  });

  it('says on but not running when Suggest a fix went off, and switches it off', async () => {
    const { server } = setup({ organizations: { [ORG_ID]: { ...STORED_ON } } });
    const { fixture, root, status } = await render({ assistant: orgAi() });
    expect(text(field(root, 'auto-fix-not-running'))).toBe(
      'On, but not running: Suggest a fix is off for Default. An instance admin turns it on in Settings → AI provider.',
    );
    expect(status()).toMatchObject({
      key: 'fix',
      tone: 'attention',
      state: 'Not running',
      tags: ['Enterprise'],
    });
    const chip = root.querySelector('.sec-chips .badge')!;
    expect([text(chip), chip.classList.contains('badge-warn')]).toEqual(['Not running', true]);
    // Stored on, it can still be switched off.
    const toggle = field(root, 'auto-fix-enabled');
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-describedby')?.split(' ')).toContain('auto-fix-not-running');
    expect(root.querySelector('#auto-fix-needs-fix')).toBeNull();
    await click(fixture, toggle);
    await save(fixture, root);
    expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
      { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
    ]);
    expect(status()).toMatchObject({ tone: 'off', state: 'Off' });
    expect(root.querySelector('#auto-fix-not-running')).toBeNull();
  });

  it('shows the severity and the maximum under the switch only while it is on, and saves them', async () => {
    const { server, fake } = setup();
    const { fixture, root, section, status } = await render();
    expect(root.querySelector('.dep')).toBeNull();
    expect(root.querySelector('#auto-fix-severity, #auto-fix-max')).toBeNull();
    expect(root.querySelector('#auto-fix-needs-fix')).toBeNull();
    expect(status()).toMatchObject({ tone: 'off', state: 'Off' });

    await click(fixture, field(root, 'auto-fix-enabled'));
    const dep = root.querySelector<HTMLElement>('.dep')!;
    const severity = dep.querySelector<HTMLSelectElement>('#auto-fix-severity')!;
    expect(severity.value).toBe('high');
    expect(text(severity.selectedOptions[0])).toBe('High');
    expect(text(dep.querySelector('label[for="auto-fix-severity"]'))).toBe('Minimum severity');
    expect(named(root, severity, 'aria-describedby')).toEqual(['New findings at or above it.']);
    const max = dep.querySelector<HTMLInputElement>('#auto-fix-max')!;
    expect(max.value).toBe('10');
    expect(text(dep.querySelector('label[for="auto-fix-max"]'))).toBe('At most per analysis');
    expect(named(root, max, 'aria-describedby')).toEqual(['the most severe first']);
    expect(foot(root)).toBe('1 unsaved change');
    expect(section.dirty()).toBe(true);

    type(root, 'auto-fix-severity', 'medium');
    type(root, 'auto-fix-max', '5');
    await settle(fixture);
    expect(foot(root)).toBe('3 unsaved changes');
    await save(fixture, root);
    expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
      { enabled: true, minSeverity: 'medium', maxPerAnalysis: 5 },
    ]);
    expect(fake.of(ORG_ID)).toEqual({ enabled: true, minSeverity: 'medium', maxPerAnalysis: 5 });
    expect(foot(root)).toMatch(SAVED_AT);
    expect(section.dirty()).toBe(false);
    expect(status()).toMatchObject({
      tone: 'ok',
      state: 'On',
      text: 'For new findings of Medium and above.',
    });

    // Off again, they go with the switch.
    await click(fixture, field(root, 'auto-fix-enabled'));
    expect(root.querySelector('.dep')).toBeNull();
  });

  it('keeps an edit made while a save was on its way, unsaved', async () => {
    const { server, fake } = setup({ organizations: { [ORG_ID]: { ...STORED_ON } } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.on('PUT', ROUTE, async (request) => {
      await held;
      fake.organizations[ORG_ID] = request.body as typeof STORED_ON;
      return { body: { available: true, ...fake.of(ORG_ID) } };
    });
    const { fixture, root, section } = await render();
    type(root, 'auto-fix-max', '5');
    await save(fixture, root);
    // The answer has not come: the field stays usable, and is changed again.
    const max = field(root, 'auto-fix-max');
    expect(max.disabled).toBe(false);
    type(root, 'auto-fix-max', '7');
    max.focus();
    release();
    await settle(fixture);
    expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
      { enabled: true, minSeverity: 'high', maxPerAnalysis: 5 },
    ]);
    expect(max.value).toBe('7');
    expect(document.activeElement).toBe(max);
    expect(foot(root)).toBe('1 unsaved change');
    expect(section.dirty()).toBe(true);
    expect(button(root, 'Save fix suggestions')?.disabled).toBe(false);
  });

  it('names the projects whose admins opted out', async () => {
    setup({ organizations: { [ORG_ID]: { ...STORED_ON } } });
    const { fixture, root } = await render();
    expect(text(root.querySelector('#auto-fix-opted-out'))).toBe(
      'Opted out by their project admins: Web Shop.',
    );
    fixture.componentRef.setInput('projects', [
      ...PROJECTS,
      projectItem({ id: 'p3', key: 'acme/docs', name: 'Docs', autoFix: { enabled: false } }),
    ]);
    await settle(fixture);
    expect(text(root.querySelector('#auto-fix-opted-out'))).toBe(
      'Opted out by their project admins: Web Shop and Docs.',
    );
    fixture.componentRef.setInput('projects', PROJECTS.slice(0, 1));
    await settle(fixture);
    expect(text(root.querySelector('#auto-fix-opted-out'))).toBe('No project opted out.');
    // Until every project is known, it says nothing rather than something untrue.
    fixture.componentRef.setInput('projects', null);
    await settle(fixture);
    expect(root.querySelector('#auto-fix-opted-out')).toBeNull();
  });

  it.each(['0', '26', '2.5', ''])(
    'refuses a maximum outside 1 to 25 on its field (%j), and sends nothing',
    async (value) => {
      const { server } = setup({ organizations: { [ORG_ID]: { ...STORED_ON } } });
      const { fixture, root } = await render();
      type(root, 'auto-fix-max', value);
      await save(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      const max = field(root, 'auto-fix-max');
      expect(max.getAttribute('aria-invalid')).toBe('true');
      expect(text(field(root, 'auto-fix-max-error'))).toBe('Use a whole number from 1 to 25.');
      expect(max.getAttribute('aria-describedby')?.split(' ')).toContain('auto-fix-max-error');
      expect(document.activeElement).toBe(max);
      expect(foot(root)).toBe('1 field needs attention: At most per analysis');
      // A new value takes the refusal away.
      type(root, 'auto-fix-max', '3');
      await settle(fixture);
      expect(root.querySelector('#auto-fix-max-error')).toBeNull();
    },
  );

  it('shows the maximum the server refused on its field (422)', async () => {
    const { server } = setup({ organizations: { [ORG_ID]: { ...STORED_ON } } });
    server.on('PUT', ROUTE, {
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [
        { path: 'body.maxPerAnalysis', message: 'Too big' },
      ]),
    });
    const { fixture, root } = await render();
    type(root, 'auto-fix-max', '7');
    await save(fixture, root);
    expect(text(field(root, 'auto-fix-max-error'))).toBe('Use a whole number from 1 to 25.');
    expect(foot(root)).toBe('1 field needs attention: At most per analysis');
  });

  it('says a licence that lapsed while saving refuses the switch-on (403 FEATURE_NOT_LICENSED)', async () => {
    const { fake } = setup();
    const { fixture, root } = await render();
    fake.available = false;
    await click(fixture, field(root, 'auto-fix-enabled'));
    await save(fixture, root);
    expect(foot(root)).toBe('Automatic fix suggestions need the Enterprise plan.');
    expect(root.querySelector('.foot-status')?.getAttribute('role')).toBe('status');
    // It can be tried again as it is, and the switch keeps the edit.
    expect(button(root, 'Save fix suggestions')?.disabled).toBe(false);
    expect(field(root, 'auto-fix-enabled').checked).toBe(true);
  });

  it('says why switching on was refused when the assistant does not suggest fixes (409 AI_DISABLED)', async () => {
    setup({ fixEnabled: false });
    const { fixture, root } = await render();
    await click(fixture, field(root, 'auto-fix-enabled'));
    await save(fixture, root);
    expect(foot(root)).toBe(
      'Switching them on needs AI set up on this server and allowed for this organization, with Suggest a fix. An instance admin sets that up in Settings → AI provider.',
    );
  });

  it('shows the Enterprise note in place of the switch when the server says they are not available', async () => {
    setup({ available: false, organizations: { [ORG_ID]: { ...STORED_ON } } });
    const { root, status } = await render();
    expect(text(field(root, 'auto-fix-not-licensed'))).toBe(
      'Automatic fix suggestions need the Enterprise plan.',
    );
    expect(root.querySelector('#auto-fix-enabled')).toBeNull();
    expect(button(root, 'Save fix suggestions')).toBeUndefined();
    expect(status()).toBeNull();
  });

  it('says so when the settings cannot be read, and says nothing in the status', async () => {
    const { server } = setup();
    server.on('GET', ROUTE, { status: 500, body: problem(500, 'INTERNAL') });
    const { root, status } = await render();
    expect(text(root.querySelector('.alert-error[role="alert"]'))).toContain(
      'The request failed (HTTP 500',
    );
    expect(root.querySelector('#auto-fix-enabled')).toBeNull();
    expect(status()).toBeNull();
  });

  it('describes the switch without the budget while the assistant is not known, and lets it be used', async () => {
    setup();
    const { root } = await render({ assistant: null });
    const toggle = field(root, 'auto-fix-enabled');
    expect(toggle.disabled).toBe(false);
    expect(toggle.hasAttribute('aria-describedby')).toBe(false);
    expect(root.querySelector('.req')).toBeNull();
  });

  it('drops the answer for an organisation left before it arrived', async () => {
    const { server } = setup({
      organizations: { [OTHER_ID]: { enabled: true, minSeverity: 'info', maxPerAnalysis: 1 } },
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.on('GET', ROUTE, async () => {
      await held;
      return { body: { available: true, enabled: false, minSeverity: 'low', maxPerAnalysis: 9 } };
    });
    const { fixture, root } = await render();
    fixture.componentRef.setInput('organizationId', OTHER_ID);
    fixture.componentRef.setInput('organizationName', 'Other');
    await settle(fixture);
    release();
    await settle(fixture);
    expect(field<HTMLSelectElement>(root, 'auto-fix-severity').value).toBe('info');
    expect(field(root, 'auto-fix-max').value).toBe('1');
  });
});
