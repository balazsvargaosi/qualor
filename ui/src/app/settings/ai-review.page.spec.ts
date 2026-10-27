import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { orgAi } from '../../testing/ai-settings';
import {
  FakeAiReview,
  type FakeAiReviewOptions,
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
} from '../../testing/fake-server';
import type { Me } from '../api/types';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';
import { AiReviewPage } from './ai-review.page';
import { SettingsPage } from './settings.page';
import { settingsRoutes } from './settings.routes';

const OTHER_ID = '0190a6c2-0000-7000-8000-000000000002';
const ROUTE = `/api/v0/organizations/${ORG_ID}/ai/review`;
const PAYMENTS = '0190a6c2-0000-7000-8000-0000000000f1';
const SHOP = '0190a6c2-0000-7000-8000-0000000000f2';
const OTHER_PROJECT = '0190a6c2-0000-7000-8000-0000000000f3';
const LEGACY = '0190a6c2-0000-7000-8000-0000000000f4';
/** A project created after the page listed the organisation's. */
const CREATED = '0190a6c2-0000-7000-8000-0000000000f5';
/** Payments is linked to a repository, Web Shop is not, and an instance admin excluded Legacy. */
const PROJECTS = [
  projectItem({ id: PAYMENTS, key: 'acme/payments', name: 'Payments', scmConnectionId: 'c1' }),
  projectItem({ id: SHOP, key: 'acme/web-shop', name: 'Web Shop' }),
  projectItem({
    id: LEGACY,
    key: 'acme/legacy',
    name: 'Legacy',
    autoFix: { excludedFromAi: true },
  }),
  projectItem({
    id: OTHER_PROJECT,
    organizationId: OTHER_ID,
    key: 'other/api',
    name: 'Other API',
    scmConnectionId: 'c2',
  }),
];
const ALL_THREE = [PAYMENTS, SHOP, LEGACY];
/** Someone other than the signed-in user (`me()`), who confirmed the notice instead. */
const ANOTHER_USER = '0190a6c2-0000-7000-8000-00000000000b';

/** The provider the fake names by default, and the second one an instance admin switches to. */
const A = { host: 'llm.example.com', model: 'gpt-review', models: ['gpt-review'] };
const B = { host: 'llm2.example.com:8443', model: 'gpt-next', models: ['gpt-next'] };
/** A provider with a model for each tier: the three models sorted, the standard one among them. */
const THREE = {
  host: 'llm.example.com',
  model: 'gpt-review',
  models: ['gpt-fast', 'gpt-review', 'gpt-strong'],
};
/** The notice for A, word for word (spec §5, D4) with the 14 days of the default retention. */
const NOTICE_A =
  "AI review sends the merge request's diff and any repository file the model chooses to read to llm.example.com (gpt-review). The scanner uploads a copy of the repository to this Qualor server for each merge request; Qualor keeps it until the merge request is closed (at most 14 days). Secrets the analyzers found are masked; credentials files are never sent.";
const NOTICE_THREE =
  "AI review sends the merge request's diff and any repository file the model chooses to read to llm.example.com (gpt-fast, gpt-review, gpt-strong). The scanner uploads a copy of the repository to this Qualor server for each merge request; Qualor keeps it until the merge request is closed (at most 14 days). Secrets the analyzers found are masked; credentials files are never sent.";
const CONFIRM_A = 'Switch on and send code to llm.example.com';
const CONFIRM_B = 'Switch on and send code to llm2.example.com:8443';
const DEFAULT_BUDGETS = {
  tokensPerDay: 2_000_000,
  costPerDayUsd: null,
  perProjectTokensPerDay: null,
  maxTokensPerReview: 300_000,
};
/** A day on a server that sets prices: the cost is counted, so a cost limit can be. */
const PRICED = { tokensToday: 0, costTodayUsd: 0, reviewsToday: 0 };
const SAVED_AT = /^Saved at \d{1,2}:\d{2} [AP]M UTC\.$/;

type Who = 'orgAdmin' | 'member' | 'instanceAdmin' | 'aiOnly';

function user(who: Who): Me {
  if (who === 'instanceAdmin') return me({ admin: true });
  const base = me();
  if (who === 'member') return base;
  // An admin by role, or a custom role that manages AI and nothing of the repositories.
  const permissions: Me['memberships'][number]['permissions'] =
    who === 'orgAdmin' ? [...ORG_ADMIN_PERMISSIONS] : ['org.read', 'org.ai.manage'];
  return {
    ...base,
    memberships: [{ ...base.memberships[0]!, role: 'admin', permissions }],
  };
}

function setup(
  who: Who = 'orgAdmin',
  review: FakeAiReviewOptions = {},
  assistant: object = orgAi(),
  routes: Routes = [{ path: '**', children: [] }],
): { server: FakeServer; fake: FakeAiReview } {
  const server = new FakeServer();
  server.on('GET', '/api/v0/organizations', {
    body: page([
      { id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' },
      { id: OTHER_ID, key: 'other', name: 'Other', createdAt: '', updatedAt: '' },
    ]),
  });
  server.on('GET', '/api/v0/system/info', {
    body: { version: '0.11.0', edition: 'community', features: [], extensions: [] },
  });
  server.on('GET', '/api/v0/projects', (request) => ({
    body: page(PROJECTS.filter((p) => p.organizationId === request.query.get('organizationId'))),
  }));
  server.on('GET', /^\/api\/v0\/organizations\/[^/]+\/ai$/, { body: assistant });
  const fake = FakeAiReview.install(server, review);
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(user(who));
  TestBed.inject(OrgContext).select(ORG_ID);
  return { server, fake };
}

/**
 * The server as the Enterprise plan has it (`llm.auto-fix` active), with the automatic fix
 * suggestion routes over in-memory settings.
 */
function enterprise(server: FakeServer, options: FakeAutoFixOptions = {}): FakeAutoFix {
  server.on('GET', '/api/v0/system/info', {
    body: { version: '0.11.0', edition: 'enterprise', features: ['llm.auto-fix'], extensions: [] },
  });
  return FakeAutoFix.install(server, options);
}

/** Lets `scrollIntoView` be called, which the test DOM lacks, for the rest of the test. */
function catchScrolls() {
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  onTestFinished(() => {
    Element.prototype.scrollIntoView = original;
  });
  return scroll;
}

type Fixture = { whenStable(): Promise<unknown> };

async function render() {
  const fixture = TestBed.createComponent(AiReviewPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement, page: fixture.componentInstance };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const field = <T extends HTMLElement = HTMLInputElement>(root: HTMLElement, id: string) =>
  root.querySelector<T>(`#${id}`)!;
const line = (root: HTMLElement, key: string) =>
  root.querySelector<HTMLElement>(`li[data-key="${key}"]`)!;
const section = (root: HTMLElement) => root.querySelector<HTMLElement>('section#review')!;
const consentDialog = (root: HTMLElement) =>
  root.querySelector<HTMLDialogElement>('dialog#ai-review-dialog')!;
const offDialog = (root: HTMLElement) =>
  root.querySelector<HTMLDialogElement>('dialog#ai-review-off-dialog')!;
const button = (within: Element, name: string) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === name);
const buttons = (within: Element) => [...within.querySelectorAll('button')].map((b) => text(b));
const foot = (root: HTMLElement) => text(section(root).querySelector('.foot-status'));
const fold = (root: HTMLElement) =>
  section(root).querySelector<HTMLDetailsElement>('details.fold')!;
const chips = (root: HTMLElement) =>
  [...fold(root).querySelectorAll('summary .chip')].map((c) => ({
    text: text(c),
    set: c.classList.contains('set'),
  }));
const rows = (root: HTMLElement) => [
  ...section(root).querySelectorAll<HTMLElement>('table.chosen tbody tr'),
];
const row = (root: HTMLElement, name: string) =>
  rows(root).find((r) => text(r.querySelector('th'))?.startsWith(`${name} `))!;
/** The switch named `name`: its label's `.sw-name`. */
const switchNamed = (root: HTMLElement, name: string) => {
  const label = [...root.querySelectorAll('.switch-row > label')].find(
    (l) => text(l.querySelector('.sw-name')) === name,
  )!;
  return field(root, label.getAttribute('for')!);
};
const meters = (root: HTMLElement) =>
  [...line(root, 'today').querySelectorAll('q-meter')].map((m) => ({
    label: text(m.querySelector('.meter-label')),
    value: text(m.querySelector('.meter-value')),
    note: text(m.querySelector('.meter-note')),
  }));
/** The in-page index's links: their names and the sections they lead to (their fragments). */
const indexLinks = (root: HTMLElement) =>
  [...root.querySelectorAll('nav.page-index a')].map((a) => [
    text(a),
    `#${a.getAttribute('href')?.split('#')[1]}`,
  ]);
const facts = (within: Element) =>
  [...within.querySelectorAll('dl.facts dt')].map((dt) => [text(dt), text(dt.nextElementSibling)]);

/** Types into a field as a person does: the number field takes each input event. */
function type(root: HTMLElement, id: string, value: string): void {
  const input = field(root, id);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function click(fixture: Fixture, target: HTMLElement | undefined) {
  target!.click();
  await settle(fixture);
}

/** Presses the action of a status line. */
async function act(fixture: Fixture, root: HTMLElement, name: string) {
  await click(fixture, button(root.querySelector('q-status-list')!, name));
}

/**
 * Renders while a navigation waits for its guard: `whenStable` would wait for that navigation, which
 * waits for the person's answer in the page.
 */
async function renderWhileNavigating(): Promise<void> {
  const app = TestBed.inject(ApplicationRef);
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    app.tick();
  }
}

/** Presses Save AI review once what was typed has rendered (it enables Save). */
async function saveReview(fixture: Fixture, root: HTMLElement) {
  await settle(fixture);
  await click(fixture, button(section(root), 'Save AI review'));
}

/** Opens or closes the budgets' fold, as its summary does. */
async function setFold(fixture: Fixture, root: HTMLElement, open: boolean) {
  fold(root).open = open;
  fold(root).dispatchEvent(new Event('toggle'));
  await settle(fixture);
}

describe('AiReviewPage (AI settings redesign, Task 5)', () => {
  it('opens with the status: off, what the selection would review, and the button to switch on', async () => {
    setup('orgAdmin', { organizations: { [ORG_ID]: { projectIds: ALL_THREE } } });
    const { root } = await render();
    expect(text(root.querySelector('h2'))).toBe('AI');
    const review = line(root, 'review');
    expect(text(review.querySelector('.st-label'))).toBe('AI review');
    expect(text(review.querySelector('.badge'))).toBe('Off');
    expect(review.querySelector('.badge')?.classList).toContain('badge-none');
    expect(text(review.querySelector('.st-sub'))).toBe(
      '1 of 3 selected projects can be reviewed: 1 not linked to a repository, 1 excluded from AI.',
    );
    expect(button(review, 'Switch on AI review…')?.classList).toContain('btn-primary');
    // The status, then the AI review and Assistant sections, in that order; without the
    // Enterprise plan, the status ends with the line that says what it adds.
    expect(
      [...root.querySelectorAll('li[data-key]')].map((l) => l.getAttribute('data-key')),
    ).toEqual(['review', 'today', 'assistant', 'community']);
    expect([...root.querySelectorAll('section.card h3')].map((h) => text(h))).toEqual([
      'Status',
      'AI review',
      'Assistant',
    ]);
    // The section's head repeats the state as a chip.
    expect(text(section(root).querySelector('.sec-chips .badge'))).toBe('Off');
    // No bare checkbox: the budgets' switches are switches, and the picker's ticks its own list.
    const bare = [...root.querySelectorAll('input[type="checkbox"]')].filter(
      (input) => !input.closest('q-project-picker') && input.getAttribute('role') !== 'switch',
    );
    expect(bare).toEqual([]);
    expect(consentDialog(root).open).toBe(false);
  });

  it('names the provider in the intro and in the purpose of AI review, every model of it', async () => {
    setup('orgAdmin', { provider: THREE });
    const { root } = await render();
    expect(text(root.querySelector('.settings-head p'))).toBe(
      "AI features for Default, on this server's AI provider (llm.example.com). AI review sends repository code to the provider, so switching it on asks you to confirm.",
    );
    expect(text(section(root).querySelector('.sec-purpose'))).toBe(
      'Reviews each merge request of the projects you choose with llm.example.com (gpt-fast, gpt-review, gpt-strong), and posts what it finds to the merge request.',
    );
    // The section links where replies are answered at once, and what the CI needs.
    expect([...section(root).querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/settings/gitlab',
      '/settings/github',
      '/docs/ai-review#what-your-ci-needs',
    ]);
  });

  it("asks for the organisation's projects, every page of them", async () => {
    const { server } = setup('orgAdmin', {
      organizations: { [ORG_ID]: { projectIds: [PAYMENTS, SHOP] } },
    });
    server.on('GET', '/api/v0/projects', (request) =>
      request.query.get('cursor') === null
        ? { body: page([PROJECTS[0]], 'next') }
        : { body: page([PROJECTS[1]]) },
    );
    const { root } = await render();
    const asked = server.requests.filter((r) => r.path === '/api/v0/projects');
    expect(asked.map((r) => r.query.get('organizationId'))).toEqual([ORG_ID, ORG_ID]);
    expect(rows(root).map((r) => text(r.querySelector('th')))).toEqual([
      'Payments acme/payments',
      'Web Shop acme/web-shop',
    ]);
  });

  describe('the chosen projects', () => {
    it('lists the chosen projects with whether each is reviewed, and removes one', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { projectIds: ALL_THREE } },
      });
      const { fixture, root } = await render();
      expect(field(root, 'ai-review-scope-selected').checked).toBe(true);
      expect(text(field(root, 'ai-review-scope-all').closest('label'))).toBe(
        'All projects of Default (3)',
      );
      const table = section(root).querySelector('table.chosen')!;
      expect([...table.querySelectorAll('thead th')].map((th) => text(th))).toEqual([
        'Project',
        'Reviewed?',
        'Actions',
      ]);
      expect(rows(root).map((r) => text(r.querySelector('th')))).toEqual([
        'Payments acme/payments',
        'Web Shop acme/web-shop',
        'Legacy acme/legacy',
      ]);
      expect(text(row(root, 'Payments').querySelector('td'))).toBe('Yes');
      expect(text(row(root, 'Web Shop').querySelector('td'))).toBe(
        'Not linked Not linked to a GitLab or GitHub repository, so it is not reviewed. Link it in Settings → Repositories.',
      );
      // An organisation admin links repositories, so the place is a link.
      expect(row(root, 'Web Shop').querySelector('td a')?.getAttribute('href')).toBe(
        '/settings/repositories',
      );
      expect(text(row(root, 'Legacy').querySelector('td'))).toBe(
        'Excluded Excluded from AI by an instance admin: never reviewed.',
      );
      // A stacked row names its cells on a phone.
      expect(
        [...row(root, 'Payments').querySelectorAll('[data-label]')].map((c) =>
          c.getAttribute('data-label'),
        ),
      ).toEqual(['Project', 'Reviewed?']);
      expect(foot(root)).toBe('No unsaved changes');
      expect(button(section(root), 'Save AI review')?.getAttribute('aria-disabled')).toBe('true');

      const remove = button(row(root, 'Web Shop'), 'Remove')!;
      expect(remove.getAttribute('aria-label')).toBe('Remove Web Shop');
      await click(fixture, remove);
      expect(rows(root).map((r) => text(r.querySelector('th .cell-stack > span')))).toEqual([
        'Payments',
        'Legacy',
      ]);
      expect(foot(root)).toBe('1 unsaved change');
      // The focus goes to the row that took the removed one's place.
      expect(document.activeElement).toBe(button(row(root, 'Legacy'), 'Remove'));
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        {
          enabled: false,
          scope: 'selected',
          projectIds: [PAYMENTS, LEGACY],
          budgets: DEFAULT_BUDGETS,
        },
      ]);
      expect(foot(root)).toMatch(SAVED_AT);
    });

    it('names the place to link a repository without a link for someone who cannot open it', async () => {
      setup('aiOnly', { organizations: { [ORG_ID]: { projectIds: [SHOP] } } });
      const { root } = await render();
      expect(text(row(root, 'Web Shop').querySelector('td'))).toContain(
        'Link it in Settings → Repositories.',
      );
      expect(row(root, 'Web Shop').querySelector('td a')).toBeNull();
    });

    it('says in the switch-on dialog that nothing is reviewed until projects are selected', async () => {
      setup();
      const { fixture, root } = await render();
      expect(rows(root)).toEqual([]);
      await act(fixture, root, 'Switch on AI review…');
      expect(consentDialog(root).open).toBe(true);
      // The picker is not in the dialog: the line says what no project means.
      expect(text(field(root, 'ai-review-scope-line'))).toBe(
        'No project is selected yet, so nothing is reviewed until you select some.',
      );
      expect(text(section(root).querySelector('.dep > .hint'))).toBe(
        'No project is selected yet: choose projects below first.',
      );
    });

    it('adds projects with the picker, which offers an excluded project disabled with the reason', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      expect(rows(root)).toEqual([]);
      expect(text(section(root).querySelector('.dep > .hint'))).toBe(
        'No project is selected yet: choose projects below first.',
      );
      await click(fixture, button(section(root), 'Add projects'));
      const options = [...section(root).querySelectorAll<HTMLElement>('q-project-picker li')];
      expect(options.map((o) => text(o))).toEqual([
        'Payments acme/payments',
        'Web Shop acme/web-shop',
        'Legacy acme/legacy Excluded from AI by an instance admin',
      ]);
      expect(options[2]!.querySelector('input')?.disabled).toBe(true);
      options[0]!.querySelector('input')!.click();
      await click(fixture, options[1]!.querySelector('input')!);
      await click(fixture, button(section(root), 'Add 2 projects'));
      expect(rows(root).map((r) => text(r.querySelector('th .cell-stack > span')))).toEqual([
        'Payments',
        'Web Shop',
      ]);
      expect(text(row(root, 'Web Shop').querySelector('.badge'))).toBe('Not linked');
      expect(foot(root)).toBe('2 unsaved changes');
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        projectIds: [PAYMENTS, SHOP],
      });
    });

    it('says what review does with a project created after the page listed them, and counts it', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      // The picker asks the server afresh, so it finds the new project the page's list lacks.
      const created = projectItem({
        id: CREATED,
        key: 'acme/mobile',
        name: 'Mobile',
        scmConnectionId: 'c3',
      });
      server.on('GET', '/api/v0/projects', (request) => ({
        body: page(
          [...PROJECTS, created].filter(
            (p) => p.organizationId === request.query.get('organizationId'),
          ),
        ),
      }));
      await click(fixture, button(section(root), 'Add projects'));
      const option = [...section(root).querySelectorAll<HTMLElement>('q-project-picker li')].find(
        (o) => text(o)?.startsWith('Mobile '),
      )!;
      await click(fixture, option.querySelector('input')!);
      await click(fixture, button(section(root), 'Add 1 project'));
      expect(text(row(root, 'Mobile').querySelector('td'))).toBe('Yes');
      expect(text(field(root, 'ai-review-scope-all').closest('label'))).toBe(
        'All projects of Default (4)',
      );
      await act(fixture, root, 'Switch on AI review…');
      expect(text(field(root, 'ai-review-scope-line'))).toBe(
        '1 selected project will be reviewed.',
      );
      await click(fixture, button(consentDialog(root), CONFIRM_A));
      expect(text(line(root, 'review').querySelector('.st-line'))).toBe('On Reviewing 1 project');
    });

    it('says in one line what All reviews, and keeps the selection for later', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { projectIds: [PAYMENTS] } },
      });
      const { fixture, root } = await render();
      expect(rows(root)).toHaveLength(1);
      await click(fixture, field(root, 'ai-review-scope-all'));
      expect(section(root).querySelector('table.chosen')).toBeNull();
      expect(text(field(root, 'ai-review-all-line'))).toBe(
        '1 of the 3 projects of Default can be reviewed: 1 not linked to a repository, 1 excluded from AI.',
      );
      expect(foot(root)).toBe('1 unsaved change');
      await saveReview(fixture, root);
      // The list of the scope `selected` is kept while the scope is `all`.
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        scope: 'all',
        projectIds: [PAYMENTS],
      });
    });

    it("counts the projects in the scope's label only once every page of them is in", async () => {
      const { server } = setup();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      server.on('GET', '/api/v0/projects', async (request) => {
        if (request.query.get('cursor') !== null) await held;
        return request.query.get('cursor') === null
          ? { body: page([PROJECTS[0]], 'next') }
          : { body: page(PROJECTS.slice(1, 3)) };
      });
      const { fixture, root } = await render();
      const label = () => text(field(root, 'ai-review-scope-all').closest('label'));
      expect(label()).toBe('All projects of Default');
      release();
      await settle(fixture);
      expect(label()).toBe('All projects of Default (3)');
    });

    it('says so when the projects cannot be listed, and keeps the stored selection', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { projectIds: [PAYMENTS] } },
      });
      server.on('GET', '/api/v0/projects', { status: 500, body: problem(500, 'INTERNAL') });
      const { fixture, root } = await render();
      expect(section(root).querySelector('[role="alert"].alert-error')?.textContent).toContain(
        'The request failed (HTTP 500',
      );
      expect(section(root).querySelector('table.chosen')).toBeNull();
      // What cannot be counted is not summed up either, nor counted in the scope's label.
      expect(line(root, 'review').querySelector('.st-sub')).toBeNull();
      expect(text(field(root, 'ai-review-scope-all').closest('label'))).toBe(
        'All projects of Default',
      );
      // Nor can the assistant say which projects are never sent.
      expect(facts(root.querySelector('section#assistant')!)[3]).toEqual(['Never sent', '—']);
      await click(fixture, field(root, 'ai-review-scope-all'));
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({ projectIds: [PAYMENTS] });
    });
  });

  describe('switching on', () => {
    it('switches on through the dialog, which names what it will review and the unsaved changes', async () => {
      const { server, fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { projectIds: ALL_THREE } },
      });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      const dialog = consentDialog(root);
      expect(dialog.open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toBe(NOTICE_A);
      expect(dialog.getAttribute('aria-describedby')).toBe('ai-review-notice');
      expect(text(field(root, 'ai-review-scope-line'))).toBe(
        '1 of 3 selected projects can be reviewed: 1 not linked to a repository, 1 excluded from AI.',
      );
      expect(dialog.textContent).not.toContain('unsaved changes');
      expect(buttons(dialog)).toEqual(['Cancel', CONFIRM_A]);
      expect(button(dialog, 'Cancel')?.hasAttribute('autofocus')).toBe(true);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);

      // An edit, then the dialog again: it says the edit is saved with the switch.
      await click(fixture, button(dialog, 'Cancel'));
      await click(fixture, button(row(root, 'Web Shop'), 'Remove'));
      await act(fixture, root, 'Switch on AI review…');
      expect(text(field(root, 'ai-review-unsaved'))).toBe(
        'Switching on also saves your unsaved changes to projects and budgets.',
      );
      // The button that saves them is announced with it.
      expect(button(dialog, CONFIRM_A)?.getAttribute('aria-describedby')).toBe('ai-review-unsaved');
      expect(text(field(root, 'ai-review-scope-line'))).toBe(
        '1 of 2 selected projects can be reviewed: 1 excluded from AI.',
      );
      await click(fixture, button(dialog, CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        {
          enabled: true,
          scope: 'selected',
          projectIds: [PAYMENTS, LEGACY],
          budgets: DEFAULT_BUDGETS,
          acknowledgeDataSharing: {
            host: 'llm.example.com',
            model: 'gpt-review',
            models: ['gpt-review'],
          },
        },
      ]);
      expect(dialog.open).toBe(false);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
      expect(text(section(root).querySelector('.sec-chips .badge'))).toBe('On');
      expect(fake.of(ORG_ID).enabled).toBe(true);
      expect(foot(root)).toMatch(SAVED_AT);
    });

    it('names the retention days the server put in the notice', async () => {
      setup('orgAdmin', { retentionDays: 30 });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      expect(field(root, 'ai-review-notice').textContent).toContain('(at most 30 days)');
    });

    it('warns in the dialog when the last Test found a model that cannot call tools (A2)', async () => {
      const { server } = setup('orgAdmin', {
        providerTest: {
          at: '2026-10-25T10:00:00.000Z',
          toolCalling: 'not_supported',
          modelsWithoutTools: ['gpt-review'],
        },
      });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      expect(text(field(root, 'ai-review-no-tools'))).toBe(
        'The last Test found that gpt-review cannot call tools, so reviews would fail. An instance admin can check Settings → AI provider.',
      );
      // A warning, not a refusal: Confirm still switches review on.
      const confirm = button(consentDialog(root), CONFIRM_A)!;
      expect(confirm.disabled).toBe(false);
      expect(confirm.getAttribute('aria-disabled')).toBeNull();
      // Confirm is announced with the warning.
      expect(confirm.getAttribute('aria-describedby')).toBe('ai-review-no-tools');
      await click(fixture, confirm);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        enabled: true,
        acknowledgeDataSharing: A,
      });
    });

    it.each([
      ['the last Test found tools', { at: '2026-10-25T10:00:00.000Z', toolCalling: 'supported' }],
      ['there is no Test of the provider as it is now', { at: null, toolCalling: 'unknown' }],
    ] as const)('says nothing of tools when %s', async (_name, test) => {
      setup('orgAdmin', { providerTest: { ...test, modelsWithoutTools: [] } });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      expect(consentDialog(root).open).toBe(true);
      expect(root.querySelector('#ai-review-no-tools')).toBeNull();
      expect(button(consentDialog(root), CONFIRM_A)?.hasAttribute('aria-describedby')).toBe(false);
    });

    it('sends nothing on Cancel, nor when the dialog closes otherwise (Escape)', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      await click(fixture, button(consentDialog(root), 'Cancel'));
      expect(consentDialog(root).open).toBe(false);
      await act(fixture, root, 'Switch on AI review…');
      expect(consentDialog(root).open).toBe(true);
      consentDialog(root).dispatchEvent(new Event('close'));
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Off');
    });

    it('opens no dialog for budgets that cannot be sent, and shows the refused field', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      await setFold(fixture, root, true);
      type(root, 'ai-review-tokens', 'many');
      await setFold(fixture, root, false);
      await act(fixture, root, 'Switch on AI review…');
      expect(consentDialog(root).open).toBe(false);
      expect(fold(root).open).toBe(true);
      expect(field(root, 'ai-review-tokens').getAttribute('aria-invalid')).toBe('true');
      expect(foot(root)).toBe('1 field needs attention: Tokens per day');
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    });

    it('reads the settings again and asks with the new provider when it changed (409 AI_REVIEW_PROVIDER_CHANGED)', async () => {
      const { server, fake } = setup();
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      expect(field(root, 'ai-review-notice').textContent).toContain('llm.example.com (gpt-review)');
      // The instance administrator switches the provider while the dialog is open.
      fake.changeProvider(B);
      await click(fixture, button(consentDialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        acknowledgeDataSharing: A,
      });
      // Nothing was stored; the settings were read again and the dialog shows the new provider.
      expect(fake.of(ORG_ID).enabled).toBe(false);
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(consentDialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toContain(
        'llm2.example.com:8443 (gpt-next)',
      );
      expect(field(root, 'ai-review-notice').textContent).not.toContain('llm.example.com (');
      expect(consentDialog(root).textContent).toContain('The AI provider changed');
      expect(button(consentDialog(root), CONFIRM_A)).toBeUndefined();
      expect(text(section(root).querySelector('.sec-purpose'))).toContain(
        'with llm2.example.com:8443 (gpt-next)',
      );
      // Confirming the new notice acknowledges the new provider.
      await click(fixture, button(consentDialog(root), CONFIRM_B));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toMatchObject([
        { acknowledgeDataSharing: A },
        { enabled: true, acknowledgeDataSharing: B },
      ]);
      expect(consentDialog(root).open).toBe(false);
      expect(fake.of(ORG_ID).consent?.providerHost).toBe('llm2.example.com:8443');
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
    });

    it('reopens the dialog when the server asks for the acknowledgement, the edits kept (409 AI_REVIEW_CONSENT_REQUIRED)', async () => {
      // Review is on with a consent that covers A, as far as this page knows.
      const { server, fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      const { fixture, root } = await render();
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
      // The provider changed since: a save without the acknowledgement is refused.
      fake.changeProvider(B);
      await setFold(fixture, root, true);
      type(root, 'ai-review-tokens', '123000');
      await saveReview(fixture, root);
      const puts = server.requestsTo('PUT', ROUTE);
      expect(puts).toHaveLength(1);
      expect(puts[0]?.body).not.toHaveProperty('acknowledgeDataSharing');
      // The settings were read again; the dialog shows the new notice and keeps what was typed.
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(consentDialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toContain(
        'llm2.example.com:8443 (gpt-next)',
      );
      expect(field(root, 'ai-review-tokens').value).toBe('123000');
      await click(fixture, button(consentDialog(root), CONFIRM_B));
      expect(server.requestsTo('PUT', ROUTE)[1]?.body).toMatchObject({
        enabled: true,
        budgets: { tokensPerDay: 123_000 },
        acknowledgeDataSharing: B,
      });
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
    });

    it('says why, and reads the settings again, when AI went meanwhile (409 AI_DISABLED)', async () => {
      const { server, fake } = setup();
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      fake.organizationEnabled = false;
      await click(fixture, button(consentDialog(root), CONFIRM_A));
      expect(consentDialog(root).open).toBe(false);
      expect(text(root.querySelector('[role="alert"].alert-error'))).toBe(
        'AI review needs AI set up on this server and allowed for this organization. An instance admin sets that up in Settings → AI provider.',
      );
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(text(root.querySelector('.ai-unavailable h3'))).toBe('Default may not use AI yet.');
      expect(document.activeElement).toBe(root.querySelector('h2'));
    });

    it('says why the dialog closed when the provider changed and AI went before the page read again', async () => {
      const { server, fake } = setup();
      // The provider changed under the dialog; by the time the page reads again, the
      // organisation may no longer use AI.
      server.on('PUT', ROUTE, () => {
        fake.organizationEnabled = false;
        return { status: 409, body: problem(409, 'AI_REVIEW_PROVIDER_CHANGED') };
      });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      await click(fixture, button(consentDialog(root), CONFIRM_A));
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(consentDialog(root).open).toBe(false);
      expect(text(root.querySelector(':scope > p.alert-error[role="alert"]'))).toBe(
        'AI review needs AI set up on this server and allowed for this organization. An instance admin sets that up in Settings → AI provider.',
      );
      expect(text(root.querySelector('.ai-unavailable h3'))).toBe('Default may not use AI yet.');
      expect(document.activeElement).toBe(root.querySelector('h2'));
    });

    it('says why the dialog closed when the settings cannot be read again after a 409', async () => {
      const { server, fake } = setup();
      let reads = 0;
      server.on('GET', ROUTE, () =>
        ++reads === 1
          ? { body: fake.answer(ORG_ID) }
          : { status: 500, body: problem(500, 'INTERNAL') },
      );
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      fake.changeProvider(B);
      await click(fixture, button(consentDialog(root), CONFIRM_A));
      expect(consentDialog(root).open).toBe(false);
      expect(text(root.querySelector(':scope > p.alert-error[role="alert"]'))).toContain(
        'The request failed (HTTP 500',
      );
      expect(document.activeElement).toBe(root.querySelector('h2'));
    });

    describe('a provider with a model for each tier', () => {
      it('shows the notice that names all three, and acknowledges all three on Confirm', async () => {
        const { server, fake } = setup('orgAdmin', { provider: THREE });
        const { fixture, root } = await render();
        await act(fixture, root, 'Switch on AI review…');
        expect(field(root, 'ai-review-notice').textContent).toBe(NOTICE_THREE);
        await click(fixture, button(consentDialog(root), CONFIRM_A));
        expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
          {
            enabled: true,
            scope: 'selected',
            projectIds: [],
            budgets: DEFAULT_BUDGETS,
            acknowledgeDataSharing: THREE,
          },
        ]);
        expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
        expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
      });

      it('reads the settings again and asks with the new set when a tier changed under the dialog', async () => {
        const { server, fake } = setup('orgAdmin', { provider: THREE });
        const { fixture, root } = await render();
        await act(fixture, root, 'Switch on AI review…');
        // The instance administrator takes the fast model away while the dialog is open.
        const two = { ...THREE, models: ['gpt-review', 'gpt-strong'] };
        fake.changeProvider(two);
        await click(fixture, button(consentDialog(root), CONFIRM_A));
        expect(fake.of(ORG_ID).enabled).toBe(false);
        expect(consentDialog(root).open).toBe(true);
        expect(field(root, 'ai-review-notice').textContent).toContain('(gpt-review, gpt-strong)');
        expect(consentDialog(root).textContent).toContain('The AI provider changed');
        await click(fixture, button(consentDialog(root), CONFIRM_A));
        expect(server.requestsTo('PUT', ROUTE)[1]?.body).toMatchObject({
          enabled: true,
          acknowledgeDataSharing: two,
        });
        expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
      });
    });
  });

  describe('on', () => {
    it('says on, what it reviews and who confirmed, and switches off after a confirmation', async () => {
      const { server, fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS, SHOP], consentFor: A } },
      });
      const { fixture, root } = await render();
      const review = line(root, 'review');
      expect(review.querySelector('.badge')?.classList).toContain('badge-passed');
      expect(text(review.querySelector('.st-line'))).toBe('On Reviewing 1 project');
      expect(text(review.querySelector('.st-sub'))).toBe(
        'Confirmed on Oct 20, 2026 (by you) for llm.example.com (gpt-review).',
      );
      const off = button(review, 'Switch off AI review')!;
      expect(off.classList).not.toContain('btn-primary');

      // An edit waits; switching off sends what is stored, and leaves the edit unsaved.
      await click(fixture, button(row(root, 'Web Shop'), 'Remove'));
      await act(fixture, root, 'Switch off AI review');
      const dialog = offDialog(root);
      expect(dialog.open).toBe(true);
      expect(text(dialog.querySelector('h2'))).toBe('Switch off AI review?');
      expect(text(dialog.querySelector('.dialog-body'))).toBe(
        'Switching it on again asks you to confirm the data notice again.',
      );
      expect(buttons(dialog)).toEqual(['Cancel', 'Switch off']);
      expect(button(dialog, 'Cancel')?.hasAttribute('autofocus')).toBe(true);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      await click(fixture, button(dialog, 'Switch off'));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        {
          enabled: false,
          scope: 'selected',
          projectIds: [PAYMENTS, SHOP],
          budgets: DEFAULT_BUDGETS,
        },
      ]);
      expect(dialog.open).toBe(false);
      expect(fake.of(ORG_ID).enabled).toBe(false);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Off');
      expect(rows(root).map((r) => text(r.querySelector('th .cell-stack > span')))).toEqual([
        'Payments',
      ]);
      expect(foot(root)).toBe('1 unsaved change');
    });

    it('says who confirmed without "by you" when someone else did', async () => {
      const { fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS], consentFor: A } },
      });
      fake.organizations[ORG_ID]!.consent!.userId = ANOTHER_USER;
      const { root } = await render();
      expect(text(line(root, 'review').querySelector('.st-sub'))).toBe(
        'Confirmed on Oct 20, 2026 for llm.example.com (gpt-review).',
      );
    });

    it('keeps it on when the switch-off is cancelled', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch off AI review');
      await click(fixture, button(offDialog(root), 'Cancel'));
      expect(offDialog(root).open).toBe(false);
      await act(fixture, root, 'Switch off AI review');
      offDialog(root).dispatchEvent(new Event('close'));
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
    });

    it('saves the chosen projects without a dialog while the consent is current', async () => {
      const { server, fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS, SHOP], consentFor: A } },
      });
      const { fixture, root } = await render();
      await click(fixture, button(row(root, 'Payments'), 'Remove'));
      await saveReview(fixture, root);
      expect(consentDialog(root).open).toBe(false);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        { enabled: true, scope: 'selected', projectIds: [SHOP], budgets: DEFAULT_BUDGETS },
      ]);
      expect(fake.of(ORG_ID).projectIds).toEqual([SHOP]);
      expect(foot(root)).toMatch(SAVED_AT);
      expect(text(line(root, 'review').querySelector('.st-line'))).toBe('On Reviewing 0 projects');
    });
  });

  describe('paused', () => {
    // Acknowledged for A, and the instance administrator has since configured B.
    const paused: FakeAiReviewOptions = {
      provider: B,
      organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
    };

    it('says paused when the provider changed, what was confirmed and what it uses now', async () => {
      const { server, fake } = setup('orgAdmin', paused);
      const { fixture, root } = await render();
      const review = line(root, 'review');
      expect(review.querySelector('.badge')?.classList).toContain('badge-warn');
      expect(text(review.querySelector('.st-line'))).toBe('Paused The AI provider changed');
      expect(text(review.querySelector('.st-sub'))).toBe(
        'You confirmed llm.example.com (gpt-review) on Oct 20, 2026. It now uses llm2.example.com:8443 (gpt-next). No merge request is reviewed until you confirm.',
      );
      expect(text(section(root).querySelector('.sec-chips .badge'))).toBe('Paused');
      expect(button(review, 'Review and confirm…')?.classList).toContain('btn-primary');
      await act(fixture, root, 'Review and confirm…');
      expect(consentDialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toContain(
        'llm2.example.com:8443 (gpt-next)',
      );
      await click(fixture, button(consentDialog(root), CONFIRM_B));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        enabled: true,
        acknowledgeDataSharing: B,
      });
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
    });

    it('switches a paused review off from its dialog, without confirming the new provider', async () => {
      const { server, fake } = setup('orgAdmin', paused);
      const { fixture, root } = await render();
      await act(fixture, root, 'Review and confirm…');
      const dialog = consentDialog(root);
      expect(buttons(dialog)).toEqual(['Cancel', 'Switch off AI review', CONFIRM_B]);
      await click(fixture, button(dialog, 'Switch off AI review'));
      expect(dialog.open).toBe(false);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        { enabled: false, scope: 'selected', projectIds: [], budgets: DEFAULT_BUDGETS },
      ]);
      expect(fake.of(ORG_ID).enabled).toBe(false);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Off');
      expect(foot(root)).toMatch(SAVED_AT);
    });

    it('says that switching on saves the unsaved changes, and not switching off', async () => {
      setup('orgAdmin', paused);
      const { fixture, root } = await render();
      await click(fixture, field(root, 'ai-review-scope-all'));
      await act(fixture, root, 'Review and confirm…');
      const dialog = consentDialog(root);
      expect(text(field(root, 'ai-review-unsaved'))).toBe(
        'Switching on also saves your unsaved changes to projects and budgets.',
      );
      expect(button(dialog, CONFIRM_B)?.getAttribute('aria-describedby')).toBe('ai-review-unsaved');
      expect(button(dialog, 'Switch off AI review')?.hasAttribute('aria-describedby')).toBe(false);
    });

    it('opens its dialog to switch off while a budget cannot be sent, and sends the stored values', async () => {
      const { server, fake } = setup('orgAdmin', paused);
      const { fixture, root } = await render();
      await setFold(fixture, root, true);
      type(root, 'ai-review-tokens', '');
      await act(fixture, root, 'Review and confirm…');
      const dialog = consentDialog(root);
      expect(dialog.open).toBe(true);
      await click(fixture, button(dialog, 'Switch off AI review'));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        { enabled: false, scope: 'selected', projectIds: [], budgets: DEFAULT_BUDGETS },
      ]);
      expect(fake.of(ORG_ID).enabled).toBe(false);
      // The emptied budget is still the edit it was, to be saved or changed.
      expect(field(root, 'ai-review-tokens').value).toBe('');
      expect(foot(root)).toBe('1 unsaved change');
    });

    it('refuses a budget that cannot be sent on Confirm, and sends nothing', async () => {
      const { server } = setup('orgAdmin', paused);
      const { fixture, root } = await render();
      await setFold(fixture, root, true);
      type(root, 'ai-review-tokens', '');
      await act(fixture, root, 'Review and confirm…');
      await click(fixture, button(consentDialog(root), CONFIRM_B));
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(field(root, 'ai-review-tokens').getAttribute('aria-invalid')).toBe('true');
      expect(foot(root)).toBe('1 field needs attention: Tokens per day');
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Paused');
    });

    it('refuses a budget that cannot be sent on Save AI review before it asks', async () => {
      const { server } = setup('orgAdmin', paused);
      const { fixture, root } = await render();
      await setFold(fixture, root, true);
      type(root, 'ai-review-tokens', 'many');
      await saveReview(fixture, root);
      expect(consentDialog(root).open).toBe(false);
      expect(foot(root)).toBe('1 field needs attention: Tokens per day');
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    });

    it('offers the switch-off once a save finds the provider changed (A, then B)', async () => {
      const { server, fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS], consentFor: A } },
      });
      const { fixture, root } = await render();
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
      fake.changeProvider(B);
      await click(fixture, field(root, 'ai-review-scope-all'));
      await saveReview(fixture, root);
      // The save was refused and the settings read again: paused, with the dialog asking.
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Paused');
      expect(consentDialog(root).open).toBe(true);
      await click(fixture, button(consentDialog(root), 'Switch off AI review'));
      const puts = server.requestsTo('PUT', ROUTE);
      expect(puts).toHaveLength(2);
      expect(puts[1]?.body).toEqual({
        enabled: false,
        scope: 'selected',
        projectIds: [PAYMENTS],
        budgets: DEFAULT_BUDGETS,
      });
      expect(fake.of(ORG_ID).enabled).toBe(false);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Off');
      // The scope's edit is still to be saved.
      expect(foot(root)).toBe('1 unsaved change');
    });

    it('stays paused when the dialog is cancelled', async () => {
      const { server } = setup('orgAdmin', paused);
      const { fixture, root } = await render();
      await act(fixture, root, 'Review and confirm…');
      await click(fixture, button(consentDialog(root), 'Cancel'));
      expect(consentDialog(root).open).toBe(false);
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Paused');
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    });

    it('opens the dialog instead of sending a save that the server would refuse', async () => {
      const { server } = setup('orgAdmin', paused);
      const { fixture, root } = await render();
      await click(fixture, field(root, 'ai-review-scope-all'));
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(consentDialog(root).open).toBe(true);
    });

    it('is not paused while review is off, even with a consent for another provider', async () => {
      setup('orgAdmin', {
        provider: B,
        organizations: { [ORG_ID]: { enabled: false, consentFor: A } },
      });
      const { root } = await render();
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Off');
    });

    it('is not paused while the consent names the same three models', async () => {
      setup('orgAdmin', {
        provider: THREE,
        organizations: { [ORG_ID]: { enabled: true, consentFor: THREE } },
      });
      const { root } = await render();
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
    });

    it('is paused when a tier changed since the consent, and confirms the whole set again', async () => {
      const { server, fake } = setup('orgAdmin', {
        provider: THREE,
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      const { fixture, root } = await render();
      expect(text(line(root, 'review').querySelector('.st-sub'))).toContain(
        'It now uses llm.example.com (gpt-fast, gpt-review, gpt-strong).',
      );
      await act(fixture, root, 'Review and confirm…');
      expect(field(root, 'ai-review-notice').textContent).toBe(NOTICE_THREE);
      await click(fixture, button(consentDialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        enabled: true,
        acknowledgeDataSharing: THREE,
      });
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
    });
  });

  describe('today', () => {
    it('shows today as meters, AI review against the capped budget', async () => {
      setup(
        'orgAdmin',
        {
          ceiling: 1_000_000,
          usage: { tokensToday: 120_000, costTodayUsd: 1.23, reviewsToday: 3 },
        },
        orgAi({ usage: { explain: 12, triage: 4, fix: 1, tokens: 40_000 } }),
      );
      const { root } = await render();
      const today = line(root, 'today');
      expect(text(today.querySelector('.st-label'))).toBe('Today');
      expect(today.querySelector('.badge')).toBeNull();
      expect(meters(root)).toEqual([
        { label: 'AI review', value: '120,000 of 1,000,000', note: '3 reviews · $1.23' },
        {
          label: 'Assistant',
          value: '40,000 of 1,000,000',
          note: 'Explanations 12 · Triage 4 · Fixes 1',
        },
      ]);
    });

    it('says the budget is reached for today, then how many reviews it took', async () => {
      setup('orgAdmin', {
        ceiling: 1_000_000,
        usage: { tokensToday: 1_000_000, costTodayUsd: 1.23, reviewsToday: 3 },
      });
      const { root } = await render();
      const meter = line(root, 'today').querySelector('q-meter')!;
      expect([...meter.querySelectorAll('.meter-note')].map((n) => text(n))).toEqual([
        'Budget reached for today',
        '3 reviews · $1.23',
      ]);
    });

    it("counts against the organisation's own budget when it is the smaller, in the right number", async () => {
      setup('orgAdmin', {
        ceiling: 900_000,
        usage: { tokensToday: 1_000, costTodayUsd: null, reviewsToday: 1 },
        organizations: { [ORG_ID]: { budgets: { ...DEFAULT_BUDGETS, tokensPerDay: 500_000 } } },
      });
      const { root } = await render();
      // No prices on the server: no cost to say.
      expect(meters(root)[0]).toEqual({
        label: 'AI review',
        value: '1,000 of 500,000',
        note: '1 review',
      });
    });

    it('does not follow a budget that was typed and not saved, and reads the saved answer', async () => {
      const { fake } = setup('orgAdmin', {
        usage: { tokensToday: 100, costTodayUsd: null, reviewsToday: 1 },
        organizations: {
          [ORG_ID]: {
            enabled: true,
            budgets: { ...DEFAULT_BUDGETS, tokensPerDay: 500_000 },
            consentFor: A,
          },
        },
      });
      const { fixture, root } = await render();
      type(root, 'ai-review-tokens', '250000');
      await settle(fixture);
      expect(meters(root)[0]?.value).toBe('100 of 500,000');
      // Saving answers with the day as it is then, and with the budget just saved.
      fake.usage = { tokensToday: 4_000, costTodayUsd: null, reviewsToday: 2 };
      await saveReview(fixture, root);
      expect(meters(root)[0]).toEqual({
        label: 'AI review',
        value: '4,000 of 250,000',
        note: '2 reviews',
      });
    });
  });

  describe('budgets', () => {
    it('keeps an edit made while a save was on its way, unsaved, and writes back the rest', async () => {
      const { server, fake } = setup();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      server.on('PUT', ROUTE, async (request) => {
        await held;
        const body = request.body as { scope: 'all' | 'selected'; budgets: typeof DEFAULT_BUDGETS };
        fake.organizations[ORG_ID] = {
          ...fake.of(ORG_ID),
          scope: body.scope,
          budgets: body.budgets,
        };
        return { body: fake.answer(ORG_ID) };
      });
      const { fixture, root, page } = await render();
      await setFold(fixture, root, true);
      await click(fixture, field(root, 'ai-review-scope-all'));
      type(root, 'ai-review-tokens', '3000000');
      await saveReview(fixture, root);
      // The answer has not come: the field stays usable, and is changed again.
      const tokens = field(root, 'ai-review-tokens');
      expect(tokens.disabled).toBe(false);
      type(root, 'ai-review-tokens', '4000000');
      tokens.focus();
      release();
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        scope: 'all',
        budgets: { ...DEFAULT_BUDGETS, tokensPerDay: 3_000_000 },
      });
      expect(tokens.value).toBe('4000000');
      expect(document.activeElement).toBe(tokens);
      // The scope, unchanged since, is the saved one; the budget is still to be saved.
      expect(field(root, 'ai-review-scope-all').checked).toBe(true);
      expect(foot(root)).toBe('1 unsaved change');
      expect(button(section(root), 'Save AI review')?.disabled).toBe(false);
      expect(page.canLeave()).not.toBe(true);
    });

    it('folds the budgets, lists them while closed, and opens on a refusal', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      expect(fold(root).open).toBe(false);
      expect(text(fold(root).querySelector('summary'))).toBe(
        'Budgets 2,000,000 tokens a day 300,000 per review No limit per project No cost limit',
      );
      expect(chips(root)).toEqual([
        { text: '2,000,000 tokens a day', set: false },
        { text: '300,000 per review', set: false },
        { text: 'No limit per project', set: false },
        { text: 'No cost limit', set: false },
      ]);
      await setFold(fixture, root, true);
      expect(field(root, 'ai-review-tokens').value).toBe('2,000,000');
      type(root, 'ai-review-tokens', '1.5');
      await setFold(fixture, root, false);
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(fold(root).open).toBe(true);
      const tokens = field(root, 'ai-review-tokens');
      expect(tokens.getAttribute('aria-invalid')).toBe('true');
      expect(text(field(root, 'ai-review-tokens-error'))).toBe(
        'Use a whole number from 0 to 1,000,000,000.',
      );
      // No alert of its own: the foot's summary speaks for the fields.
      expect(field(root, 'ai-review-tokens-error').getAttribute('role')).toBeNull();
      expect(tokens.getAttribute('aria-describedby')).toContain('ai-review-tokens-error');
      const status = section(root).querySelector('.foot-status')!;
      expect(text(status)).toBe('1 field needs attention: Tokens per day');
      expect(status.querySelector('a')?.getAttribute('href')).toBe('#ai-review-tokens');
      expect(document.activeElement).toBe(tokens);
    });

    it('marks the budgets other than the defaults, and shows the stored values grouped', async () => {
      setup('orgAdmin', {
        usage: PRICED,
        organizations: {
          [ORG_ID]: {
            budgets: {
              tokensPerDay: 500_000,
              costPerDayUsd: 12.5,
              perProjectTokensPerDay: 100_000,
              maxTokensPerReview: 200_000,
            },
          },
        },
      });
      const { root } = await render();
      expect(chips(root)).toEqual([
        { text: '500,000 tokens a day', set: true },
        { text: '200,000 per review', set: true },
        { text: '100,000 per project a day', set: true },
        { text: '$12.50 a day', set: true },
      ]);
      expect(field(root, 'ai-review-tokens').value).toBe('500,000');
      expect(field(root, 'ai-review-max-per-review').value).toBe('200,000');
      expect(switchNamed(root, 'Limit tokens per project').checked).toBe(true);
      expect(field(root, 'ai-review-per-project').value).toBe('100,000');
      expect(switchNamed(root, 'Limit the cost').checked).toBe(true);
      expect(field(root, 'ai-review-cost').value).toBe('12.50');
      expect(text(field(root, 'ai-review-cost-prefix'))).toBe('US$');
      // The currency before the digits is read with the field.
      expect(field(root, 'ai-review-cost').getAttribute('aria-describedby')).toBe(
        'ai-review-cost-prefix',
      );
      expect(text(field(root, 'ai-review-tokens-unit'))).toBe('tokens');
    });

    it.each([
      ['ai-review-tokens', '-1'],
      ['ai-review-tokens', '1.5'],
      ['ai-review-tokens', ''],
      ['ai-review-tokens', '1000000001'],
      ['ai-review-cost', '-0.5'],
      ['ai-review-cost', '1.234'],
      ['ai-review-cost', '1000001'],
      ['ai-review-cost', ''],
      ['ai-review-per-project', '2.5'],
      ['ai-review-per-project', '1000000001'],
      ['ai-review-per-project', ''],
      ['ai-review-max-per-review', '0'],
      ['ai-review-max-per-review', '10000001'],
      ['ai-review-max-per-review', ''],
    ])('refuses %s = %j on its field and sends nothing', async (id, value) => {
      const { server } = setup('orgAdmin', {
        usage: PRICED,
        organizations: {
          [ORG_ID]: {
            enabled: true,
            consentFor: A,
            budgets: {
              tokensPerDay: 10,
              costPerDayUsd: 7,
              perProjectTokensPerDay: 4,
              maxTokensPerReview: 3,
            },
          },
        },
      });
      const { fixture, root } = await render();
      type(root, id, value);
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(fold(root).open).toBe(true);
      expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
      expect(field(root, `${id}-error`).textContent).toMatch(/^\s*Use /);
      expect(field(root, id).getAttribute('aria-describedby')).toContain(`${id}-error`);
      expect(document.activeElement).toBe(field(root, id));
      // Typing again clears the refusal.
      type(root, id, '5');
      await settle(fixture);
      expect(root.querySelector(`#${id}-error`)).toBeNull();
      expect(foot(root)).toBe('1 unsaved change');
    });

    it('keeps a refusal when the field only regroups the digits it was left with', async () => {
      setup();
      const { fixture, root } = await render();
      type(root, 'ai-review-tokens', '1000000001');
      await saveReview(fixture, root);
      expect(field(root, 'ai-review-tokens').getAttribute('aria-invalid')).toBe('true');
      field(root, 'ai-review-tokens').dispatchEvent(new Event('blur'));
      await settle(fixture);
      expect(field(root, 'ai-review-tokens').value).toBe('1,000,000,001');
      expect(field(root, 'ai-review-tokens').getAttribute('aria-invalid')).toBe('true');
    });

    it("shows the field the server refused in the page's own words (422), and opens the fold", async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      server.on('PUT', ROUTE, {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [
          { path: 'body.budgets.maxTokensPerReview', message: 'server text' },
        ]),
      });
      const { fixture, root } = await render();
      await click(fixture, field(root, 'ai-review-scope-all'));
      await saveReview(fixture, root);
      expect(fold(root).open).toBe(true);
      expect(field(root, 'ai-review-max-per-review').getAttribute('aria-invalid')).toBe('true');
      expect(text(field(root, 'ai-review-max-per-review-error'))).toBe(
        'Use a whole number from 1 to 10,000,000.',
      );
      expect(foot(root)).toBe('1 field needs attention: Tokens per review');
      expect(root.textContent).not.toContain('server text');
    });

    it('says in its chip that a budget left empty is not set', async () => {
      setup('orgAdmin', { usage: PRICED });
      const { fixture, root } = await render();
      // Switched on with nothing typed yet.
      await click(fixture, switchNamed(root, 'Limit tokens per project'));
      await click(fixture, switchNamed(root, 'Limit the cost'));
      expect(chips(root).slice(2)).toEqual([
        { text: 'Tokens per project per day: not set', set: true },
        { text: 'Cost per day: not set', set: true },
      ]);
      type(root, 'ai-review-tokens', '');
      await settle(fixture);
      expect(chips(root)[0]).toEqual({ text: 'Tokens per day: not set', set: true });
    });

    it('limits the cost only with prices', async () => {
      setup();
      const { root } = await render();
      const limit = switchNamed(root, 'Limit the cost');
      expect(limit.getAttribute('role')).toBe('switch');
      expect(limit.disabled).toBe(true);
      expect(limit.checked).toBe(false);
      // Described by its help, then by why it is disabled.
      const [help, why] = limit.getAttribute('aria-describedby')!.split(' ');
      expect(text(field(root, help!))).toBe("Counted with the models' prices this server sets.");
      const note = field(root, why!);
      expect(text(note)).toBe(
        'No prices are set on this server, so a cost limit would count nothing. An instance admin enters model prices in Settings → AI provider.',
      );
      expect(root.querySelector('#ai-review-cost')).toBeNull();
    });

    it('sends a stored cost back as stored, its decimals all, unless its field is edited', async () => {
      // An API client may store more decimals than the field takes.
      const { server } = setup('orgAdmin', {
        usage: PRICED,
        organizations: { [ORG_ID]: { budgets: { ...DEFAULT_BUDGETS, costPerDayUsd: 1.255 } } },
      });
      const { fixture, root } = await render();
      expect(field(root, 'ai-review-cost').value).toBe('1.255');
      expect(chips(root)[3]).toEqual({ text: '$1.255 a day', set: true });
      expect(foot(root)).toBe('No unsaved changes');
      // Left, the field keeps it as it is.
      field(root, 'ai-review-cost').dispatchEvent(new Event('blur'));
      await settle(fixture);
      expect(field(root, 'ai-review-cost').value).toBe('1.255');

      type(root, 'ai-review-tokens', '3000000');
      await settle(fixture);
      expect(foot(root)).toBe('1 unsaved change');
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        budgets: { ...DEFAULT_BUDGETS, tokensPerDay: 3_000_000, costPerDayUsd: 1.255 },
      });
      expect(field(root, 'ai-review-cost').value).toBe('1.255');
      expect(foot(root)).toMatch(SAVED_AT);

      // Edited, it is the amount typed.
      type(root, 'ai-review-cost', '1.26');
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[1]?.body).toMatchObject({
        budgets: { costPerDayUsd: 1.26 },
      });
      expect(field(root, 'ai-review-cost').value).toBe('1.26');
    });

    it('lets a cost limit stored before the prices went be switched off', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { budgets: { ...DEFAULT_BUDGETS, costPerDayUsd: 5 } } },
      });
      const { fixture, root } = await render();
      const limit = switchNamed(root, 'Limit the cost');
      expect(limit.checked).toBe(true);
      expect(limit.disabled).toBe(false);
      expect(root.querySelector('#ai-review-no-prices')).not.toBeNull();
      await click(fixture, limit);
      expect(switchNamed(root, 'Limit the cost').disabled).toBe(true);
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        budgets: { costPerDayUsd: null },
      });
    });

    it('with prices, limits the cost under its switch, and none once it is off', async () => {
      const { server } = setup('orgAdmin', { usage: PRICED });
      const { fixture, root } = await render();
      expect(root.querySelector('#ai-review-no-prices')).toBeNull();
      expect(text(switchNamed(root, 'Limit the cost').closest('.switch-row'))).toBe(
        "Limit the cost Counted with the models' prices this server sets.",
      );
      await click(fixture, switchNamed(root, 'Limit the cost'));
      expect(field(root, 'ai-review-cost').closest('.dep')).not.toBeNull();
      type(root, 'ai-review-cost', '20');
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        budgets: { costPerDayUsd: 20 },
      });
      expect(chips(root)[3]).toEqual({ text: '$20.00 a day', set: true });
      await click(fixture, switchNamed(root, 'Limit the cost'));
      expect(root.querySelector('#ai-review-cost')).toBeNull();
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[1]?.body).toMatchObject({
        budgets: { costPerDayUsd: null },
      });
    });

    it('names each switch by its name alone, and describes it by its help', async () => {
      setup('orgAdmin', { usage: PRICED });
      const { fixture, root } = await render();
      const perProject = switchNamed(root, 'Limit tokens per project');
      expect(text(field(root, perProject.getAttribute('aria-labelledby')!))).toBe(
        'Limit tokens per project',
      );
      expect(text(field(root, perProject.getAttribute('aria-describedby')!))).toBe(
        'Off: no limit per project.',
      );
      // Switched on, it has no help to point at.
      await click(fixture, perProject);
      expect(perProject.hasAttribute('aria-describedby')).toBe(false);
      const cost = switchNamed(root, 'Limit the cost');
      expect(text(field(root, cost.getAttribute('aria-labelledby')!))).toBe('Limit the cost');
      expect(text(field(root, cost.getAttribute('aria-describedby')!))).toBe(
        "Counted with the models' prices this server sets.",
      );
    });

    it('limits the tokens per project under its switch, and none once it is off', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      const limit = switchNamed(root, 'Limit tokens per project');
      expect(text(limit.closest('.switch-row'))).toBe(
        'Limit tokens per project Off: no limit per project.',
      );
      expect(root.querySelector('#ai-review-per-project')).toBeNull();
      await click(fixture, limit);
      // Switched on with nothing typed: a limit needs its number.
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(text(field(root, 'ai-review-per-project-error'))).toBe(
        'Use a whole number from 0 to 1,000,000,000.',
      );
      type(root, 'ai-review-per-project', '250000');
      await saveReview(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        budgets: { perProjectTokensPerDay: 250_000 },
      });
      expect(chips(root)[2]).toEqual({ text: '250,000 per project a day', set: true });
      // Off, the limit is gone; its number comes back when it is switched on again.
      await click(fixture, switchNamed(root, 'Limit tokens per project'));
      expect(root.querySelector('#ai-review-per-project')).toBeNull();
      expect(foot(root)).toBe('1 unsaved change');
      await click(fixture, switchNamed(root, 'Limit tokens per project'));
      expect(field(root, 'ai-review-per-project').value).toBe('250,000');
      expect(foot(root)).toMatch(SAVED_AT);
    });

    it('shows the cap and what the organisation gets', async () => {
      setup('orgAdmin', { ceiling: 1_000_000 });
      const { root } = await render();
      expect(text(field(root, 'ai-review-ceiling'))).toBe(
        'This server caps AI review at 1,000,000 tokens a day per organization, so Default gets 1,000,000.',
      );
      expect(field(root, 'ai-review-tokens').getAttribute('aria-describedby')).toContain(
        'ai-review-ceiling',
      );
      // The capped budget makes room for three full-size reviews a day.
      expect(text(field(root, 'ai-review-max-per-review-echo'))).toBe(
        'about 3 full-size reviews a day',
      );
    });

    it.each([[3_000_000], [null]])(
      'shows no cap while it is not below the organisation budget (%s)',
      async (ceiling) => {
        setup('orgAdmin', { ceiling });
        const { root } = await render();
        expect(root.querySelector('#ai-review-ceiling')).toBeNull();
        expect(field(root, 'ai-review-tokens').getAttribute('aria-describedby')).toBe(
          'ai-review-tokens-unit',
        );
      },
    );

    it('counts the full-size reviews a day the budgets allow', async () => {
      setup();
      const { fixture, root } = await render();
      const echo = () => text(field(root, 'ai-review-max-per-review-echo'));
      expect(echo()).toBe('about 6 full-size reviews a day');
      expect(field(root, 'ai-review-max-per-review').getAttribute('aria-describedby')).toBe(
        'ai-review-max-per-review-echo ai-review-max-per-review-hint ai-review-max-per-review-unit',
      );
      expect(text(field(root, 'ai-review-max-per-review-hint'))).toBe(
        'The most one review may use; it ends with what it found. At the default 300,000, merge requests of about 100 changed files or more are not reviewed: raise it for big merge requests.',
      );
      type(root, 'ai-review-max-per-review', '2000000');
      await settle(fixture);
      expect(echo()).toBe('about 1 full-size review a day');
      type(root, 'ai-review-tokens', '0');
      await settle(fixture);
      expect(echo()).toBe('not enough for one full-size review a day');
    });
  });

  describe('when AI cannot be used', () => {
    it('says who sets up AI, and switches a stored review off', async () => {
      const { server } = setup('orgAdmin', {
        provider: null,
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      const { fixture, root } = await render();
      expect(text(root.querySelector('.settings-head p'))).toBe(
        "AI features for Default, on this server's AI provider.",
      );
      const card = root.querySelector<HTMLElement>('.ai-unavailable')!;
      expect(text(card.querySelector('.badge'))).toBe('Not set up');
      expect(text(card.querySelector('h3'))).toBe("AI isn't set up on this server yet.");
      expect(text(card.querySelector('.empty > p'))).toBe(
        'An instance admin connects an AI provider in Settings → AI provider and allows Default to use it. Then you can switch on AI review here.',
      );
      // An organisation admin cannot open the provider's settings: no link, and no button to.
      // The place is plain text, not drawn as a link.
      expect(card.querySelector('a')).toBeNull();
      expect(text(card)).not.toContain('Set up the provider');
      expect(root.querySelector('q-status-list')).toBeNull();
      // Nor an index: there is one card only.
      expect(root.querySelector('nav.page-index')).toBeNull();
      expect(root.querySelector('section#review')).toBeNull();
      expect(text(card.querySelector('.setting-actions .foot-status'))).toBe(
        'AI review was switched on before, and is stopped.',
      );
      await click(fixture, button(card, 'Switch off AI review'));
      await click(fixture, button(offDialog(root), 'Switch off'));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        { enabled: false, scope: 'selected', projectIds: [], budgets: DEFAULT_BUDGETS },
      ]);
      expect(root.querySelector('.ai-unavailable .setting-actions')).toBeNull();
      expect(document.activeElement).toBe(root.querySelector('h2'));
    });

    it('links the AI provider settings for an instance admin, and offers to set up the provider', async () => {
      setup('instanceAdmin', { provider: null });
      const { root } = await render();
      const card = root.querySelector<HTMLElement>('.ai-unavailable')!;
      expect(card.querySelector('.empty > p a')?.getAttribute('href')).toBe('/settings/ai');
      const setUp = [...card.querySelectorAll('a')].find((a) => text(a) === 'Set up the provider');
      expect(setUp?.getAttribute('href')).toBe('/settings/ai');
      expect(setUp?.classList).toContain('btn-primary');
    });

    it('says an instance admin allows the organisation', async () => {
      setup('orgAdmin', { organizationEnabled: false });
      const { root } = await render();
      // The provider is there: the intro names it.
      expect(text(root.querySelector('.settings-head p'))).toContain(
        "on this server's AI provider (llm.example.com).",
      );
      const card = root.querySelector<HTMLElement>('.ai-unavailable')!;
      expect(text(card.querySelector('.badge'))).toBe('Not allowed');
      expect(text(card.querySelector('h3'))).toBe('Default may not use AI yet.');
      expect(text(card.querySelector('.empty > p'))).toBe(
        'An instance admin allows it in Settings → AI provider → Organizations.',
      );
      // The place is plain text for an organisation admin, not drawn as a link.
      expect(card.querySelector('a')).toBeNull();
      // Nothing was ever switched on: nothing to stop.
      expect(card.querySelector('.setting-actions')).toBeNull();
      expect(button(card, 'Switch off AI review')).toBeUndefined();
    });

    it("links the AI provider's organizations for an instance admin", async () => {
      setup('instanceAdmin', { organizationEnabled: false });
      const { root } = await render();
      expect(text(root.querySelector('.ai-unavailable .badge'))).toBe('Not allowed');
      expect(root.querySelector('.ai-unavailable a')?.getAttribute('href')).toBe(
        '/settings/ai#organizations',
      );
      // The provider is set up: only the organisation is to allow.
      expect(text(root.querySelector('.ai-unavailable'))).not.toContain('Set up the provider');
    });
  });

  describe('the assistant', () => {
    it('shows the assistant read-only: the features, what is never sent and the limits', async () => {
      setup();
      const { root } = await render();
      const assistant = root.querySelector<HTMLElement>('section#assistant')!;
      expect(text(assistant.querySelector('h3'))).toBe('Assistant');
      expect(text(assistant.querySelector('.sec-chips'))).toBe('Read-only');
      expect(text(assistant.querySelector('.sec-purpose'))).toBe(
        "Explain, Suggest triage and Suggest a fix on Default's issues, chosen by an instance admin in Settings → AI provider.",
      );
      expect(facts(assistant)).toEqual([
        ['Explain', 'On'],
        ['Suggest triage', 'On'],
        ['Suggest a fix', 'Off'],
        ['Never sent', 'Legacy'],
        [
          'Limits a day',
          '200 explanations · 100 triage · 25 fixes · 1,000,000 tokens · 30 asks per person an hour',
        ],
      ]);
      expect(assistant.querySelector('input, select, textarea, button')).toBeNull();
      const status = line(root, 'assistant');
      expect(text(status.querySelector('.st-label'))).toBe('Assistant');
      expect(status.querySelector('.badge')?.classList).toContain('badge-passed');
      expect(text(status.querySelector('.st-line'))).toBe(
        'On Explain and Suggest triage on, Suggest a fix off.',
      );
      expect(text(status.querySelector('.st-sub'))).toBe('An instance admin chooses them.');
    });

    it('says the assistant is off without a feature, and on with all of them', async () => {
      setup('orgAdmin', {}, orgAi({ features: { explain: false, triage: false, fix: false } }));
      const { root } = await render();
      expect(text(line(root, 'assistant').querySelector('.st-line'))).toBe(
        'Off Explain, Suggest triage, and Suggest a fix off.',
      );
      expect(line(root, 'assistant').querySelector('.badge')?.classList).toContain('badge-none');
      TestBed.resetTestingModule();
      setup('orgAdmin', {}, orgAi({ features: { explain: true, triage: true, fix: true } }));
      const all = await render();
      expect(text(line(all.root, 'assistant').querySelector('.st-line'))).toBe(
        'On Explain, Suggest triage, and Suggest a fix on.',
      );
    });

    it('says None when no project is excluded', async () => {
      const { server } = setup();
      server.on('GET', '/api/v0/projects', { body: page(PROJECTS.slice(0, 2)) });
      const { root } = await render();
      expect(facts(root.querySelector('section#assistant')!)[3]).toEqual(['Never sent', 'None']);
    });

    it('says so when the assistant cannot be read, and leaves it out of the status', async () => {
      const { server } = setup();
      server.on('GET', /^\/api\/v0\/organizations\/[^/]+\/ai$/, {
        status: 500,
        body: problem(500, 'INTERNAL'),
      });
      const { root } = await render();
      expect(text(root.querySelector('section#assistant .alert-error[role="alert"]'))).toContain(
        'The request failed (HTTP 500',
      );
      expect(root.querySelector('li[data-key="assistant"]')).toBeNull();
      expect(meters(root).map((m) => m.label)).toEqual(['AI review']);
    });
  });

  describe('automatic fix suggestions (Task 6)', () => {
    const FIX_ON = orgAi({ features: { explain: true, triage: true, fix: true } });
    const STORED_ON = { enabled: true, minSeverity: 'high', maxPerAnalysis: 10 } as const;
    const fixSection = (root: HTMLElement) =>
      root.querySelector<HTMLElement>('section#fix-suggestions')!;

    it('in community the section is absent, and the status ends with one muted line', async () => {
      const { server } = setup();
      const { root } = await render();
      expect(root.querySelector('q-fix-suggestions-section, section#fix-suggestions')).toBeNull();
      const last = [...root.querySelectorAll<HTMLElement>('li[data-key]')].at(-1)!;
      expect(last.getAttribute('data-key')).toBe('community');
      expect(text(last)).toBe('Automatic fix suggestions are part of Qualor Enterprise.');
      // No state and no label: one muted sentence.
      expect(last.querySelector('.badge')).toBeNull();
      expect(text(last.querySelector('.st-sub'))).toBe(
        'Automatic fix suggestions are part of Qualor Enterprise.',
      );
      expect(server.requests.filter((r) => r.path.endsWith('/ai/auto-fix'))).toHaveLength(0);
      // The index leads to the two sections the page has.
      expect(indexLinks(root)).toEqual([
        ['AI review', '#review'],
        ['Assistant', '#assistant'],
      ]);
    });

    it('shows them after the assistant, in the status and as a section, with the Enterprise plan', async () => {
      const { server } = setup('orgAdmin', {}, FIX_ON);
      enterprise(server, { organizations: { [ORG_ID]: { ...STORED_ON } } });
      // Web Shop's admins opted their project out.
      server.on('GET', '/api/v0/projects', {
        body: page([
          PROJECTS[0],
          { ...PROJECTS[1]!, autoFix: { ...PROJECTS[1]!.autoFix, enabled: false } },
        ]),
      });
      const { root } = await render();
      expect(
        [...root.querySelectorAll('li[data-key]')].map((l) => l.getAttribute('data-key')),
      ).toEqual(['review', 'today', 'assistant', 'fix']);
      const fix = line(root, 'fix');
      expect(text(fix.querySelector('.st-label'))).toBe('Fix suggestions');
      expect(text(fix.querySelector('.st-line'))).toBe(
        'On Enterprise For new findings of High and above.',
      );
      expect([...root.querySelectorAll('section.card h3')].map((h) => text(h))).toEqual([
        'Status',
        'AI review',
        'Assistant',
        'Automatic fix suggestions',
      ]);
      // The section reads the page's organisation, its projects and its assistant.
      const section = fixSection(root);
      expect(text(section.querySelector('#auto-fix-opted-out'))).toBe(
        'Opted out by their project admins: Web Shop.',
      );
      expect(text(section.querySelector('#auto-fix-enabled-help'))).toBe(
        'For the new findings of each merge request, within the daily fix budget (25).',
      );
      expect(server.requestsTo('GET', `/api/v0/organizations/${ORG_ID}/ai/auto-fix`)).toHaveLength(
        1,
      );
      expect(indexLinks(root)).toEqual([
        ['AI review', '#review'],
        ['Assistant', '#assistant'],
        ['Automatic fix suggestions', '#fix-suggestions'],
      ]);
      const index = root.querySelector('nav.page-index')!;
      expect(text(root.querySelector(`#${index.getAttribute('aria-labelledby')}`))).toBe(
        'On this page',
      );
    });

    it('says who turns Suggest a fix on for the organisation', async () => {
      const { server } = setup();
      enterprise(server);
      const { root } = await render();
      expect(text(fixSection(root).querySelector('#auto-fix-needs-fix'))).toBe(
        'Needs Suggest a fix for Default, which an instance admin turns on in Settings → AI provider.',
      );
      expect(text(line(root, 'fix').querySelector('.st-line'))).toBe('Off Enterprise');
    });

    it('goes to a section from the index, and keeps it in the address', async () => {
      const { server } = setup('orgAdmin', {}, FIX_ON);
      enterprise(server);
      const scroll = catchScrolls();
      const { fixture, root } = await render();
      const link = root.querySelector<HTMLAnchorElement>(
        'nav.page-index a[href$="#fix-suggestions"]',
      )!;
      // Whether the page took the click over, as the browser would see it after every handler.
      let taken: boolean | null = null;
      const seen = (event: Event) => {
        taken = event.defaultPrevented;
        // The test DOM would try to follow the link otherwise.
        event.preventDefault();
      };
      document.addEventListener('click', seen);
      onTestFinished(() => document.removeEventListener('click', seen));

      // Ctrl-click (or ⌘, or the middle button) opens it elsewhere: the page stays as it is.
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      );
      await settle(fixture);
      expect(taken).toBe(false);
      expect(scroll).not.toHaveBeenCalled();

      await click(fixture, link);
      expect(taken).toBe(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(fixSection(root));
      expect(document.activeElement).toBe(fixSection(root).querySelector('h3'));
      expect(TestBed.inject(Router).url).toBe('/#fix-suggestions');
    });

    it('/settings/auto-fix leads to the section on the AI page (/settings/ai-review#fix-suggestions)', async () => {
      const { server } = setup('orgAdmin', {}, FIX_ON, [
        { path: 'settings', children: settingsRoutes },
      ]);
      enterprise(server);
      const scroll = catchScrolls();
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/settings/auto-fix', AiReviewPage);
      await settle(harness.fixture);
      expect(TestBed.inject(Router).url).toBe('/settings/ai-review#fix-suggestions');
      const root = harness.routeNativeElement!;
      // Once it has rendered, the section is scrolled to and its heading takes the focus.
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(fixSection(root));
      expect(document.activeElement).toBe(fixSection(root).querySelector('h3'));
      // The index links are addresses of this page, to open or copy elsewhere.
      expect(
        [...root.querySelectorAll('nav.page-index a')].map((a) => a.getAttribute('href')),
      ).toEqual([
        '/settings/ai-review#review',
        '/settings/ai-review#assistant',
        '/settings/ai-review#fix-suggestions',
      ]);
      // Once only: a later render, even of new settings, leaves the page where the person is.
      type(root, 'ai-review-tokens', '3000000');
      await saveReview(harness.fixture, root);
      expect(foot(root)).toMatch(SAVED_AT);
      expect(scroll).toHaveBeenCalledTimes(1);
    });

    it('reveals the section the address names when the system info answers after the settings', async () => {
      const { server } = setup('orgAdmin', {}, FIX_ON, [
        { path: 'settings', children: settingsRoutes },
      ]);
      enterprise(server);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      server.on('GET', '/api/v0/system/info', async () => {
        await held;
        return {
          body: {
            version: '0.11.0',
            edition: 'enterprise',
            features: ['llm.auto-fix'],
            extensions: [],
          },
        };
      });
      const scroll = catchScrolls();
      const harness = await RouterTestingHarness.create();
      // The harness would wait for the system info too: the page renders by hand meanwhile.
      const navigating = harness.navigateByUrl('/settings/auto-fix', AiReviewPage);
      await renderWhileNavigating();
      const root = harness.routeNativeElement!;
      // The settings are in; the section waits for the system info.
      expect(section(root)).not.toBeNull();
      expect(root.querySelector('section#fix-suggestions')).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
      release();
      await navigating;
      await settle(harness.fixture);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(fixSection(root));
      expect(document.activeElement).toBe(fixSection(root).querySelector('h3'));
    });

    describe('while AI cannot be used', () => {
      /** The assistant as the server answers it then: not enabled, every feature off. */
      const AI_OFF = orgAi({
        enabled: false,
        features: { explain: false, triage: false, fix: false },
      });

      it('shows them under the not-set-up card, and switches a stored-on setting off', async () => {
        const { server } = setup('orgAdmin', { provider: null }, AI_OFF);
        enterprise(server, { organizations: { [ORG_ID]: { ...STORED_ON } } });
        const { fixture, root } = await render();
        expect(root.querySelector('.ai-unavailable')).not.toBeNull();
        expect(root.querySelector('q-status-list, nav.page-index')).toBeNull();
        const section = fixSection(root);
        expect(text(section.querySelector('#auto-fix-not-running'))).toBe(
          'On, but not running: Suggest a fix is off for Default. An instance admin turns it on in Settings → AI provider.',
        );
        const toggle = field(root, 'auto-fix-enabled');
        expect(toggle.checked).toBe(true);
        expect(toggle.disabled).toBe(false);
        await click(fixture, toggle);
        await click(fixture, button(section, 'Save fix suggestions'));
        expect(
          server
            .requestsTo('PUT', `/api/v0/organizations/${ORG_ID}/ai/auto-fix`)
            .map((r) => r.body),
        ).toEqual([{ enabled: false, minSeverity: 'high', maxPerAnalysis: 10 }]);
        expect(section.querySelector('#auto-fix-not-running')).toBeNull();
      });

      it('shows them under the not-allowed card, the switch off under what it needs', async () => {
        const { server } = setup('orgAdmin', { organizationEnabled: false }, AI_OFF);
        enterprise(server);
        const { root } = await render();
        expect(text(root.querySelector('.ai-unavailable h3'))).toBe('Default may not use AI yet.');
        const toggle = field(root, 'auto-fix-enabled');
        expect(toggle.disabled).toBe(true);
        expect(toggle.getAttribute('aria-describedby')?.split(' ')).toContain('auto-fix-needs-fix');
        expect(text(fixSection(root).querySelector('#auto-fix-needs-fix'))).toBe(
          'Needs Suggest a fix for Default, which an instance admin turns on in Settings → AI provider.',
        );
      });

      it('shows no fix suggestions under the card without the Enterprise plan', async () => {
        setup('orgAdmin', { provider: null }, AI_OFF);
        const { root } = await render();
        expect(root.querySelector('.ai-unavailable')).not.toBeNull();
        expect(root.querySelector('q-fix-suggestions-section')).toBeNull();
      });

      it('/settings/auto-fix reveals the section under the not-set-up card', async () => {
        const { server } = setup('orgAdmin', { provider: null }, AI_OFF, [
          { path: 'settings', children: settingsRoutes },
        ]);
        enterprise(server, { organizations: { [ORG_ID]: { ...STORED_ON } } });
        const scroll = catchScrolls();
        const harness = await RouterTestingHarness.create();
        await harness.navigateByUrl('/settings/auto-fix', AiReviewPage);
        await settle(harness.fixture);
        const root = harness.routeNativeElement!;
        expect(root.querySelector('.ai-unavailable')).not.toBeNull();
        expect(scroll.mock.contexts.at(-1)).toBe(fixSection(root));
        expect(document.activeElement).toBe(fixSection(root).querySelector('h3'));
      });
    });

    it('asks before leaving with unsaved fix suggestions, naming them, and not once they are saved', async () => {
      const { server } = setup('orgAdmin', {}, FIX_ON);
      enterprise(server, { organizations: { [ORG_ID]: { ...STORED_ON } } });
      const { fixture, root, page } = await render();
      expect(page.canLeave()).toBe(true);
      type(root, 'auto-fix-max', '7');
      await settle(fixture);
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);

      const leave = root.querySelector<HTMLDialogElement>('q-leave-confirm dialog')!;
      let answer = page.canLeave() as Promise<boolean>;
      await settle(fixture);
      expect(leave.open).toBe(true);
      expect(text(leave.querySelector('#leave-text'))).toBe(
        'Your changes to Automatic fix suggestions are not saved yet.',
      );
      await click(fixture, button(leave, 'Stay'));
      await expect(answer).resolves.toBe(false);

      // Both sections changed: both are named.
      await click(fixture, field(root, 'ai-review-scope-all'));
      answer = page.canLeave() as Promise<boolean>;
      await settle(fixture);
      expect(text(leave.querySelector('#leave-text'))).toBe(
        'Your changes to AI review and Automatic fix suggestions are not saved yet.',
      );
      await click(fixture, button(leave, 'Stay'));
      await expect(answer).resolves.toBe(false);

      await saveReview(fixture, root);
      await click(fixture, button(fixSection(root), 'Save fix suggestions'));
      expect(server.requestsTo('PUT', `/api/v0/organizations/${ORG_ID}/ai/auto-fix`)).toHaveLength(
        1,
      );
      expect(page.canLeave()).toBe(true);
    });

    it('asks before the organisation is switched with unsaved fix suggestions', async () => {
      const { server } = setup('orgAdmin', {}, FIX_ON);
      TestBed.inject(SessionStore).set(me({ admin: true }));
      enterprise(server, { organizations: { [ORG_ID]: { ...STORED_ON } } });
      const { fixture, root } = await render();
      type(root, 'auto-fix-max', '7');
      await settle(fixture);
      const org = TestBed.inject(OrgContext);
      const leave = root.querySelector<HTMLDialogElement>('q-leave-confirm dialog')!;
      const switching = org.switchTo(OTHER_ID);
      await settle(fixture);
      expect(leave.open).toBe(true);
      await click(fixture, button(leave, 'Stay'));
      expect(await switching).toBe(false);
      expect(org.currentId()).toBe(ORG_ID);
      expect(field(root, 'auto-fix-max').value).toBe('7');
    });
  });

  describe('leaving', () => {
    it('asks before leaving with unsaved changes', async () => {
      setup('orgAdmin', { organizations: { [ORG_ID]: { projectIds: [PAYMENTS] } } });
      const { fixture, root, page } = await render();
      expect(page.canLeave()).toBe(true);
      await click(fixture, button(row(root, 'Payments'), 'Remove'));
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);

      const leave = root.querySelector<HTMLDialogElement>('q-leave-confirm dialog')!;
      let answer = page.canLeave() as Promise<boolean>;
      await settle(fixture);
      expect(leave.open).toBe(true);
      expect(text(leave.querySelector('#leave-text'))).toBe(
        'Your changes to AI review are not saved yet.',
      );
      await click(fixture, button(leave, 'Stay'));
      await expect(answer).resolves.toBe(false);
      answer = page.canLeave() as Promise<boolean>;
      await settle(fixture);
      await click(fixture, button(leave, 'Leave without saving'));
      await expect(answer).resolves.toBe(true);
    });

    it('asks before the router leaves it with unsaved changes, through the route guard', async () => {
      setup('orgAdmin', { organizations: { [ORG_ID]: { projectIds: [PAYMENTS] } } }, orgAi(), [
        ...settingsRoutes,
        { path: 'elsewhere', children: [] },
      ]);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/ai-review', AiReviewPage);
      await settle(harness.fixture);
      const root = harness.routeNativeElement!;
      await click(harness.fixture, button(row(root, 'Payments'), 'Remove'));
      const router = TestBed.inject(Router);
      const leave = root.querySelector<HTMLDialogElement>('q-leave-confirm dialog')!;

      let leaving = router.navigateByUrl('/elsewhere');
      await renderWhileNavigating();
      expect(leave.open).toBe(true);
      await click(harness.fixture, button(leave, 'Stay'));
      expect(await leaving).toBe(false);
      expect(router.url).toBe('/ai-review');
      expect(foot(root)).toBe('1 unsaved change');

      leaving = router.navigateByUrl('/elsewhere');
      await renderWhileNavigating();
      await click(harness.fixture, button(leave, 'Leave without saving'));
      expect(await leaving).toBe(true);
      expect(router.url).toBe('/elsewhere');
    });

    it('asks before the organisation is switched with unsaved changes, and keeps them on Stay', async () => {
      const { fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { projectIds: [PAYMENTS, SHOP] } },
      });
      // An instance admin manages both organisations' AI review.
      TestBed.inject(SessionStore).set(me({ admin: true }));
      fake.organizations[OTHER_ID] = { ...fake.of(OTHER_ID), scope: 'all' };
      const { fixture, root } = await render();
      await click(fixture, button(row(root, 'Web Shop'), 'Remove'));
      const org = TestBed.inject(OrgContext);
      const leave = root.querySelector<HTMLDialogElement>('q-leave-confirm dialog')!;

      // As the header's select does.
      let switching = org.switchTo(OTHER_ID);
      await settle(fixture);
      expect(leave.open).toBe(true);
      expect(text(leave.querySelector('#leave-text'))).toBe(
        'Your changes to AI review are not saved yet.',
      );
      await click(fixture, button(leave, 'Stay'));
      expect(await switching).toBe(false);
      expect(org.currentId()).toBe(ORG_ID);
      expect(rows(root).map((r) => text(r.querySelector('th .cell-stack > span')))).toEqual([
        'Payments',
      ]);
      expect(foot(root)).toBe('1 unsaved change');

      switching = org.switchTo(OTHER_ID);
      await settle(fixture);
      await click(fixture, button(leave, 'Leave without saving'));
      expect(await switching).toBe(true);
      await settle(fixture);
      expect(org.currentId()).toBe(OTHER_ID);
      expect(field(root, 'ai-review-scope-all').checked).toBe(true);
      expect(foot(root)).toBe('No unsaved changes');
    });
  });

  describe('data it must never show', () => {
    it('never shows the provider as a URL: the answers name its host and model only', async () => {
      setup('orgAdmin', { organizations: { [ORG_ID]: { enabled: true, consentFor: A } } });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch off AI review');
      // The whole markup, attributes included (ui/tools/templates.test.ts bars reading it as HTML).
      expect(new XMLSerializer().serializeToString(root)).not.toContain('https://');
      expect(root.textContent).not.toContain('https://');
    });
  });

  describe('organisations and roles', () => {
    it('reads the organisation chosen in the header', async () => {
      const { fake } = setup();
      // An instance admin manages every organisation's.
      TestBed.inject(SessionStore).set(me({ admin: true }));
      fake.organizations[OTHER_ID] = {
        ...fake.of(OTHER_ID),
        scope: 'all',
        budgets: { ...DEFAULT_BUDGETS, tokensPerDay: 42 },
      };
      const { fixture, root } = await render();
      expect(field(root, 'ai-review-scope-selected').checked).toBe(true);
      TestBed.inject(OrgContext).select(OTHER_ID);
      await settle(fixture);
      expect(field(root, 'ai-review-scope-all').checked).toBe(true);
      expect(field(root, 'ai-review-tokens').value).toBe('42');
      expect(text(root.querySelector('.settings-head p'))).toContain('AI features for Other,');
      // Other's own projects are counted, not Default's.
      expect(text(field(root, 'ai-review-all-line'))).toBe(
        'The 1 project of Other will be reviewed.',
      );
    });

    it('drops the answer for an organisation left before it arrived', async () => {
      const { server, fake } = setup();
      TestBed.inject(SessionStore).set(me({ admin: true }));
      fake.organizations[OTHER_ID] = {
        ...fake.of(OTHER_ID),
        budgets: { ...DEFAULT_BUDGETS, tokensPerDay: 2 },
      };
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      // Default's answer (2 000 000 tokens) arrives after the page moved on to Other (2).
      server.on('GET', ROUTE, async () => {
        await held;
        return { body: fake.answer(ORG_ID) };
      });
      const fixture = TestBed.createComponent(AiReviewPage);
      await settle(fixture);
      TestBed.inject(OrgContext).select(OTHER_ID);
      await settle(fixture);
      release();
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;
      expect(field(root, 'ai-review-tokens').value).toBe('2');
    });

    it('closes an open dialog with nothing sent when the organisation changes', async () => {
      const { server } = setup();
      TestBed.inject(SessionStore).set(me({ admin: true }));
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      expect(consentDialog(root).open).toBe(true);
      TestBed.inject(OrgContext).select(OTHER_ID);
      await settle(fixture);
      expect(consentDialog(root).open).toBe(false);
      expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    });

    it('tells a member who is not an organisation admin, and asks the server nothing', async () => {
      const { server } = setup('member');
      const { root } = await render();
      expect(root.textContent).toContain('Only organization admins change the AI settings.');
      expect(root.querySelector('section#review')).toBeNull();
      expect(server.requests.filter((r) => r.path.includes('/ai'))).toHaveLength(0);
      expect(server.requests.filter((r) => r.path === '/api/v0/projects')).toHaveLength(0);
    });

    it('tells an admin of another organisation that this one is not theirs to change', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      TestBed.inject(OrgContext).select(OTHER_ID);
      await settle(fixture);
      expect(root.textContent).toContain('Only organization admins change the AI settings.');
      expect(root.querySelector('section#review')).toBeNull();
      expect(server.requestsTo('GET', `/api/v0/organizations/${OTHER_ID}/ai/review`)).toHaveLength(
        0,
      );
    });

    it('says so when there is no organisation to show, instead of loading forever', async () => {
      const { server } = setup();
      server.on('GET', '/api/v0/organizations', { body: page([]) });
      const { root } = await render();
      expect(root.textContent).toContain('There is no organization to show');
      expect(root.querySelector('section#review')).toBeNull();
      expect(server.requests.filter((r) => r.path.endsWith('/ai/review'))).toHaveLength(0);
    });

    it('says so when the settings cannot be read', async () => {
      const { server } = setup();
      server.on('GET', ROUTE, { status: 500, body: problem(500, 'INTERNAL') });
      const { root } = await render();
      expect(root.querySelector('[role="alert"].alert-error')).not.toBeNull();
      expect(root.querySelector('section#review')).toBeNull();
    });

    it("says why a switch-on failed under the page's head, not beside Save", async () => {
      const { server } = setup();
      server.on('PUT', ROUTE, { status: 500, body: problem(500, 'INTERNAL') });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch on AI review…');
      await click(fixture, button(consentDialog(root), CONFIRM_A));
      expect(text(root.querySelector(':scope > p.alert-error[role="alert"]'))).toContain(
        'The request failed (HTTP 500',
      );
      expect(document.activeElement).toBe(root.querySelector('h2'));
      // Save AI review would send the section, not try the switch again.
      expect(foot(root)).toBe('No unsaved changes');
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('Off');
    });

    it("says why a switch-off failed under the page's head, not beside Save", async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      server.on('PUT', ROUTE, { status: 500, body: problem(500, 'INTERNAL') });
      const { fixture, root } = await render();
      await act(fixture, root, 'Switch off AI review');
      await click(fixture, button(offDialog(root), 'Switch off'));
      expect(text(root.querySelector(':scope > p.alert-error[role="alert"]'))).toContain(
        'The request failed (HTTP 500',
      );
      expect(document.activeElement).toBe(root.querySelector('h2'));
      expect(foot(root)).toBe('No unsaved changes');
      expect(text(line(root, 'review').querySelector('.badge'))).toBe('On');
    });

    it('says why a save was refused beside its Save, and keeps the edits', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      server.on('PUT', ROUTE, { status: 403, body: problem(403, 'FORBIDDEN') });
      const { fixture, root } = await render();
      type(root, 'ai-review-tokens', '77');
      await saveReview(fixture, root);
      expect(foot(root)).toBe('You are not allowed to do this.');
      expect(section(root).querySelector('.foot-status')?.getAttribute('role')).toBe('status');
      expect(field(root, 'ai-review-tokens').value).toBe('77');
      // It can be tried again as it is.
      expect(button(section(root), 'Save AI review')?.disabled).toBe(false);
    });

    it('says so when a selected project belongs to another organisation (422 PROJECT_NOT_IN_ORGANIZATION)', async () => {
      const { fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS], consentFor: A } },
      });
      fake.foreignProjects.add(PAYMENTS);
      const { fixture, root } = await render();
      await click(fixture, field(root, 'ai-review-scope-all'));
      await saveReview(fixture, root);
      expect(foot(root)).toBe(
        'A selected project belongs to another organization. Reload the page and select the projects again.',
      );
    });
  });
});

describe('SettingsPage: AI (AI settings redesign, Task 5)', () => {
  async function nav(who: Who): Promise<(string | undefined)[]> {
    setup(who);
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    return [...root.querySelectorAll('nav a')].map((a) => text(a));
  }

  it('lists AI under Organization for org.ai.manage only', async () => {
    expect(await nav('orgAdmin')).toContain('AI');
    TestBed.resetTestingModule();
    expect(await nav('member')).not.toContain('AI');
  });

  it('lists no entry of its own for the automatic fix suggestions, which are a section of AI', async () => {
    const { server } = setup('orgAdmin');
    enterprise(server);
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const labels = [...(fixture.nativeElement as HTMLElement).querySelectorAll('nav a')].map((a) =>
      text(a),
    );
    expect(labels).toContain('AI');
    expect(labels).not.toContain('Automatic fixes');
    expect(labels).not.toContain('Automatic fix suggestions');
  });

  it('points the entry at /settings/ai-review', async () => {
    setup('orgAdmin');
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const link = [...(fixture.nativeElement as HTMLElement).querySelectorAll('nav a')].find(
      (a) => text(a) === 'AI',
    );
    expect(link?.getAttribute('href')).toBe('/ai-review');
  });
});
