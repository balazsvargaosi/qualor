import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  FakeAiReview,
  type FakeAiReviewOptions,
  FakeServer,
  me,
  ORG_ADMIN_PERMISSIONS,
  ORG_ID,
  page,
  problem,
  provideFakeServer,
  settle,
} from '../../testing/fake-server';
import type { Me } from '../api/types';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';
import { AiReviewPage } from './ai-review.page';
import { SettingsPage } from './settings.page';

const OTHER_ID = '0190a6c2-0000-7000-8000-000000000002';
const ROUTE = `/api/v0/organizations/${ORG_ID}/ai/review`;
const PAYMENTS = '0190a6c2-0000-7000-8000-0000000000f1';
const SHOP = '0190a6c2-0000-7000-8000-0000000000f2';
const OTHER_PROJECT = '0190a6c2-0000-7000-8000-0000000000f3';
const PROJECTS = [
  { id: PAYMENTS, organizationId: ORG_ID, key: 'acme/payments', name: 'Payments' },
  { id: SHOP, organizationId: ORG_ID, key: 'acme/web-shop', name: 'Web Shop' },
  { id: OTHER_PROJECT, organizationId: OTHER_ID, key: 'other/api', name: 'Other API' },
];

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
const CONFIRM_A = 'Switch on and send code to llm.example.com';
const CONFIRM_B = 'Switch on and send code to llm2.example.com:8443';
const DEFAULT_BUDGETS = {
  tokensPerDay: 2_000_000,
  costPerDayUsd: null,
  perProjectTokensPerDay: null,
  maxTokensPerReview: 300_000,
};

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

function setup(
  who: Who = 'orgAdmin',
  review: FakeAiReviewOptions = {},
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
  const fake = FakeAiReview.install(server, review);
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(user(who));
  TestBed.inject(OrgContext).select(ORG_ID);
  return { server, fake };
}

type Fixture = { whenStable(): Promise<unknown> };

async function render() {
  const fixture = TestBed.createComponent(AiReviewPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

const field = <T extends HTMLElement = HTMLInputElement>(root: HTMLElement, id: string) =>
  root.querySelector<T>(`#${id}`)!;
const dialog = (root: HTMLElement) =>
  root.querySelector<HTMLDialogElement>('dialog#ai-review-dialog')!;
const button = (within: HTMLElement, text: string) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

function type(root: HTMLElement, id: string, value: string): void {
  const input = field(root, id);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function click(fixture: Fixture, target: HTMLElement | undefined) {
  target!.click();
  await settle(fixture);
}

async function save(fixture: Fixture, root: HTMLElement) {
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

/** Checks the switch, which opens the data-sharing dialog. */
async function switchOn(fixture: Fixture, root: HTMLElement) {
  await click(fixture, field(root, 'ai-review-enabled'));
}

describe('AiReviewPage (6I-2 Task 9)', () => {
  it("shows the organisation's stored review: provider, switch, scope, projects and budgets", async () => {
    setup('orgAdmin', {
      ceiling: 750_000,
      organizations: {
        [ORG_ID]: {
          enabled: true,
          scope: 'selected',
          projectIds: [PAYMENTS],
          budgets: {
            tokensPerDay: 500_000,
            costPerDayUsd: 12.5,
            perProjectTokensPerDay: 100_000,
            maxTokensPerReview: 200_000,
          },
          consentFor: A,
        },
      },
    });
    const { root } = await render();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('AI review');
    expect(field(root, 'ai-review-provider').textContent?.trim()).toBe(
      'Model gpt-review at llm.example.com',
    );
    expect(root.querySelector('label[for="ai-review-enabled"]')?.textContent?.trim()).toBe(
      'Review merge requests with AI',
    );
    expect(field(root, 'ai-review-enabled').checked).toBe(true);
    expect(field(root, 'ai-review-scope-selected').checked).toBe(true);
    expect(field(root, 'ai-review-scope-all').checked).toBe(false);
    expect(field(root, `ai-review-project-${PAYMENTS}`).checked).toBe(true);
    expect(field(root, `ai-review-project-${SHOP}`).checked).toBe(false);
    // Only the organisation's own projects are offered.
    expect(root.querySelector(`#ai-review-project-${OTHER_PROJECT}`)).toBeNull();
    expect(field(root, 'ai-review-tokens').value).toBe('500000');
    expect(field(root, 'ai-review-cost').value).toBe('12.5');
    expect(field(root, 'ai-review-per-project').value).toBe('100000');
    expect(field(root, 'ai-review-max-per-review').value).toBe('200000');
    // Nothing to confirm: no warning, no dialog, no unavailable note.
    expect(root.querySelector('.alert-warn')).toBeNull();
    expect(root.querySelector('#ai-review-unavailable')).toBeNull();
    expect(dialog(root).open).toBe(false);
  });

  it("asks for the organisation's projects, every page of them", async () => {
    const { server } = setup();
    server.on('GET', '/api/v0/projects', (request) =>
      request.query.get('cursor') === null
        ? { body: page([PROJECTS[0]], 'next') }
        : { body: page([PROJECTS[1]]) },
    );
    const { root } = await render();
    const asked = server.requests.filter((r) => r.path === '/api/v0/projects');
    expect(asked.map((r) => r.query.get('organizationId'))).toEqual([ORG_ID, ORG_ID]);
    expect(field(root, `ai-review-project-${PAYMENTS}`)).not.toBeNull();
    expect(field(root, `ai-review-project-${SHOP}`)).not.toBeNull();
  });

  describe('switching on', () => {
    it('opens the dialog with the notice word for word, and sends nothing yet', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      expect(dialog(root).open).toBe(false);
      await switchOn(fixture, root);
      expect(dialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toBe(NOTICE_A);
      expect(dialog(root).getAttribute('aria-describedby')).toBe('ai-review-notice');
      expect(
        [...dialog(root).querySelectorAll('button')].map((b) => b.textContent?.trim()),
      ).toEqual(['Cancel', CONFIRM_A]);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    });

    it('names the retention days the server put in the notice', async () => {
      setup('orgAdmin', { retentionDays: 30 });
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      expect(field(root, 'ai-review-notice').textContent).toContain('(at most 30 days)');
    });

    it('sends the acknowledgement of the host and model it showed, with the form, on Confirm', async () => {
      const { server, fake } = setup();
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        {
          enabled: true,
          scope: 'selected',
          projectIds: [],
          budgets: DEFAULT_BUDGETS,
          acknowledgeDataSharing: A,
        },
      ]);
      expect(dialog(root).open).toBe(false);
      expect(field(root, 'ai-review-enabled').checked).toBe(true);
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'The AI review settings were saved.',
      );
      expect(fake.of(ORG_ID).enabled).toBe(true);
      expect(root.querySelector('.alert-warn')).toBeNull();
    });

    it('sends what was typed in the form along with the acknowledgement', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      await click(fixture, field(root, 'ai-review-scope-all'));
      type(root, 'ai-review-tokens', '750000');
      type(root, 'ai-review-cost', '20');
      await switchOn(fixture, root);
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toEqual({
        enabled: true,
        scope: 'all',
        projectIds: [],
        budgets: { ...DEFAULT_BUDGETS, tokensPerDay: 750_000, costPerDayUsd: 20 },
        acknowledgeDataSharing: A,
      });
    });

    it('reads the settings again and asks with the new provider when it changed (409 AI_REVIEW_PROVIDER_CHANGED)', async () => {
      const { server, fake } = setup();
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      expect(field(root, 'ai-review-notice').textContent).toContain('llm.example.com (gpt-review)');
      // The instance administrator switches the provider while the dialog is open.
      fake.changeProvider(B);
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        acknowledgeDataSharing: A,
      });
      // Nothing was stored; the settings were read again and the dialog shows the new provider.
      expect(fake.of(ORG_ID).enabled).toBe(false);
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(dialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toContain(
        'llm2.example.com:8443 (gpt-next)',
      );
      expect(field(root, 'ai-review-notice').textContent).not.toContain('llm.example.com (');
      expect(dialog(root).textContent).toContain('The AI provider changed');
      expect(button(dialog(root), CONFIRM_A)).toBeUndefined();
      expect(field(root, 'ai-review-provider').textContent?.trim()).toBe(
        'Model gpt-next at llm2.example.com:8443',
      );
      expect(field(root, 'ai-review-enabled').checked).toBe(true);
      // Confirming the new notice acknowledges the new provider.
      await click(fixture, button(dialog(root), CONFIRM_B));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toMatchObject([
        { acknowledgeDataSharing: A },
        { enabled: true, acknowledgeDataSharing: B },
      ]);
      expect(dialog(root).open).toBe(false);
      expect(fake.of(ORG_ID).consent?.providerHost).toBe('llm2.example.com:8443');
      expect(root.querySelector('[role="status"]')?.textContent).toContain('were saved');
    });

    it('reopens the dialog when the server asks for the acknowledgement (409 AI_REVIEW_CONSENT_REQUIRED)', async () => {
      // Review is on with a consent that covers A, as far as this page knows.
      const { server, fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      const { fixture, root } = await render();
      expect(root.querySelector('.alert-warn')).toBeNull();
      // The provider changed since: a save without the acknowledgement is refused.
      fake.changeProvider(B);
      type(root, 'ai-review-tokens', '123000');
      await save(fixture, root);
      const puts = server.requestsTo('PUT', ROUTE);
      expect(puts).toHaveLength(1);
      expect(puts[0]?.body).not.toHaveProperty('acknowledgeDataSharing');
      // The settings were read again; the dialog shows the new notice and keeps what was typed.
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(dialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toContain(
        'llm2.example.com:8443 (gpt-next)',
      );
      expect(field(root, 'ai-review-tokens').value).toBe('123000');
      await click(fixture, button(dialog(root), CONFIRM_B));
      expect(server.requestsTo('PUT', ROUTE)[1]?.body).toMatchObject({
        enabled: true,
        budgets: { tokensPerDay: 123_000 },
        acknowledgeDataSharing: B,
      });
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
    });

    it('says why, reads the settings again and leaves the box off when the assistant went (409 AI_DISABLED)', async () => {
      const { server, fake } = setup();
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      fake.organizationEnabled = false;
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(dialog(root).open).toBe(false);
      expect(root.querySelector('[role="alert"].alert-error')?.textContent).toContain(
        'AI review needs the AI assistant configured and enabled for this organisation.',
      );
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(field(root, 'ai-review-enabled').checked).toBe(false);
      expect(field(root, 'ai-review-unavailable').textContent).toContain(
        'AI assistant is not enabled for this organisation.',
      );
    });

    it('sends nothing and unchecks the box on Cancel', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      expect(field(root, 'ai-review-enabled').checked).toBe(true);
      await click(fixture, button(dialog(root), 'Cancel'));
      expect(dialog(root).open).toBe(false);
      expect(field(root, 'ai-review-enabled').checked).toBe(false);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      // Checking it again asks again.
      await switchOn(fixture, root);
      expect(dialog(root).open).toBe(true);
    });

    it('treats the dialog closing any other way (Escape) as Cancel', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      dialog(root).dispatchEvent(new Event('close'));
      await settle(fixture);
      expect(field(root, 'ai-review-enabled').checked).toBe(false);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    });

    it('does not open the dialog for a form that cannot be sent, and unchecks the box', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      type(root, 'ai-review-tokens', 'many');
      await switchOn(fixture, root);
      expect(dialog(root).open).toBe(false);
      expect(field(root, 'ai-review-enabled').checked).toBe(false);
      expect(field(root, 'ai-review-tokens').getAttribute('aria-invalid')).toBe('true');
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    });
  });

  describe('a provider with a model for each tier', () => {
    const NOTICE_THREE =
      "AI review sends the merge request's diff and any repository file the model chooses to read to llm.example.com (gpt-fast, gpt-review, gpt-strong). The scanner uploads a copy of the repository to this Qualor server for each merge request; Qualor keeps it until the merge request is closed (at most 14 days). Secrets the analyzers found are masked; credentials files are never sent.";

    it('lists every model on the provider line', async () => {
      setup('orgAdmin', { provider: THREE });
      const { root } = await render();
      expect(field(root, 'ai-review-provider').textContent?.trim()).toBe(
        'Models gpt-fast, gpt-review, gpt-strong at llm.example.com',
      );
    });

    it('shows the notice that names all three, and acknowledges all three on Confirm', async () => {
      const { server, fake } = setup('orgAdmin', { provider: THREE });
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      expect(field(root, 'ai-review-notice').textContent).toBe(NOTICE_THREE);
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        {
          enabled: true,
          scope: 'selected',
          projectIds: [],
          budgets: DEFAULT_BUDGETS,
          acknowledgeDataSharing: THREE,
        },
      ]);
      expect(dialog(root).open).toBe(false);
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'The AI review settings were saved.',
      );
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
      expect(root.querySelector('.alert-warn')).toBeNull();
    });

    it('reads the settings again and asks with the new set when a tier changed under the dialog (409 AI_REVIEW_PROVIDER_CHANGED)', async () => {
      const { server, fake } = setup('orgAdmin', { provider: THREE });
      const { fixture, root } = await render();
      await switchOn(fixture, root);
      // The instance administrator takes the fast model away while the dialog is open.
      const two = { ...THREE, models: ['gpt-review', 'gpt-strong'] };
      fake.changeProvider(two);
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        acknowledgeDataSharing: THREE,
      });
      // Nothing was stored; the dialog shows the notice and the provider line of the two models.
      expect(fake.of(ORG_ID).enabled).toBe(false);
      expect(server.requestsTo('GET', ROUTE)).toHaveLength(2);
      expect(dialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toContain('(gpt-review, gpt-strong)');
      expect(dialog(root).textContent).toContain('The AI provider changed');
      expect(field(root, 'ai-review-provider').textContent?.trim()).toBe(
        'Models gpt-review, gpt-strong at llm.example.com',
      );
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE)[1]?.body).toMatchObject({
        enabled: true,
        acknowledgeDataSharing: two,
      });
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
    });

    it('warns that the consent is outdated when a tier changed since, and confirms the whole set again', async () => {
      // Acknowledged for one model, and the instance administrator has since added two.
      const { server, fake } = setup('orgAdmin', {
        provider: THREE,
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      const { fixture, root } = await render();
      const warning = root.querySelector<HTMLElement>('.alert-warn')!;
      expect(warning.textContent).toContain(
        'The AI provider changed; confirm again to keep reviewing.',
      );
      await click(fixture, button(warning, 'Confirm again'));
      expect(field(root, 'ai-review-notice').textContent).toBe(NOTICE_THREE);
      await click(fixture, button(dialog(root), CONFIRM_A));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        enabled: true,
        acknowledgeDataSharing: THREE,
      });
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
      expect(root.querySelector('.alert-warn')).toBeNull();
    });

    it('shows no warning while the consent names the same three models', async () => {
      setup('orgAdmin', {
        provider: THREE,
        organizations: { [ORG_ID]: { enabled: true, consentFor: THREE } },
      });
      const { root } = await render();
      expect(root.querySelector('.alert-warn')).toBeNull();
    });
  });

  describe('a consent that no longer covers the provider', () => {
    // Acknowledged for A, and the instance administrator has since configured B.
    const outdated: FakeAiReviewOptions = {
      provider: B,
      organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
    };

    it('warns, with a button that opens the same dialog for the new provider', async () => {
      const { server, fake } = setup('orgAdmin', outdated);
      const { fixture, root } = await render();
      const warning = root.querySelector<HTMLElement>('.alert-warn')!;
      expect(warning.textContent).toContain(
        'The AI provider changed; confirm again to keep reviewing.',
      );
      expect(field(root, 'ai-review-enabled').checked).toBe(true);
      expect(dialog(root).open).toBe(false);
      await click(fixture, button(warning, 'Confirm again'));
      expect(dialog(root).open).toBe(true);
      expect(field(root, 'ai-review-notice').textContent).toContain(
        'llm2.example.com:8443 (gpt-next)',
      );
      await click(fixture, button(dialog(root), CONFIRM_B));
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        enabled: true,
        acknowledgeDataSharing: B,
      });
      expect(fake.consentCurrent(fake.of(ORG_ID))).toBe(true);
      // The warning is gone, and the box stays checked.
      expect(root.querySelector('.alert-warn')).toBeNull();
      expect(field(root, 'ai-review-enabled').checked).toBe(true);
    });

    it('keeps the warning and the box when the dialog is cancelled', async () => {
      const { server } = setup('orgAdmin', outdated);
      const { fixture, root } = await render();
      await click(
        fixture,
        button(root.querySelector<HTMLElement>('.alert-warn')!, 'Confirm again'),
      );
      await click(fixture, button(dialog(root), 'Cancel'));
      expect(dialog(root).open).toBe(false);
      expect(root.querySelector('.alert-warn')).not.toBeNull();
      expect(field(root, 'ai-review-enabled').checked).toBe(true);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
    });

    it('opens the dialog instead of sending a save that the server would refuse', async () => {
      const { server } = setup('orgAdmin', outdated);
      const { fixture, root } = await render();
      await save(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(dialog(root).open).toBe(true);
    });

    it('shows no warning while review is off, even with a consent for another provider', async () => {
      setup('orgAdmin', {
        provider: B,
        organizations: { [ORG_ID]: { enabled: false, consentFor: A } },
      });
      const { root } = await render();
      expect(root.querySelector('.alert-warn')).toBeNull();
      expect(field(root, 'ai-review-enabled').checked).toBe(false);
    });

    it('shows no warning while the consent covers the provider', async () => {
      setup('orgAdmin', { organizations: { [ORG_ID]: { enabled: true, consentFor: A } } });
      const { root } = await render();
      expect(root.querySelector('.alert-warn')).toBeNull();
    });
  });

  describe('when it cannot be switched on', () => {
    it.each([
      [
        'no provider is configured',
        { provider: null },
        'The instance administrator has not configured an AI provider.',
      ],
      [
        'the organisation is not enabled for the assistant',
        { organizationEnabled: false },
        'AI assistant is not enabled for this organisation.',
      ],
    ] as [string, FakeAiReviewOptions, string][])(
      'names the reason and disables the form: %s',
      async (_name, options, reason) => {
        const { server } = setup('orgAdmin', {
          ...options,
          // A stored switch is no reason to ask for anything: the form is locked.
          organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
        });
        const { fixture, root } = await render();
        const note = field(root, 'ai-review-unavailable');
        expect(note.classList.contains('alert-info')).toBe(true);
        expect(note.textContent?.trim()).toBe(reason);
        const controls = [
          ...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('form input, form button'),
        ];
        expect(controls.length).toBeGreaterThan(5);
        expect(controls.filter((c) => !c.disabled)).toEqual([]);
        // No warning to confirm again: there is nothing to confirm against.
        expect(root.querySelector('.alert-warn')).toBeNull();
        field(root, 'ai-review-enabled').click();
        await save(fixture, root);
        expect(dialog(root).open).toBe(false);
        expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      },
    );

    it('still names the provider when only the organisation is not enabled', async () => {
      setup('orgAdmin', { organizationEnabled: false });
      const { root } = await render();
      expect(field(root, 'ai-review-provider').textContent?.trim()).toBe(
        'Model gpt-review at llm.example.com',
      );
    });

    it('shows no provider line without a provider', async () => {
      setup('orgAdmin', { provider: null });
      const { root } = await render();
      expect(root.querySelector('#ai-review-provider')).toBeNull();
    });
  });

  describe('scope and projects', () => {
    it('lists the projects only for selected projects, and keeps the ticks when hidden', async () => {
      const { server } = setup('orgAdmin', {
        organizations: {
          [ORG_ID]: { enabled: true, projectIds: [PAYMENTS], consentFor: A },
        },
      });
      const { fixture, root } = await render();
      expect(root.querySelector('fieldset.facet')).not.toBeNull();
      await click(fixture, field(root, 'ai-review-scope-all'));
      expect(root.querySelector('fieldset.facet')).toBeNull();
      await save(fixture, root);
      // The list of the scope `selected` is kept while the scope is `all`.
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        scope: 'all',
        projectIds: [PAYMENTS],
      });
    });

    it('saves the chosen projects without a dialog while review is on with a current consent', async () => {
      const { server, fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS], consentFor: A } },
      });
      const { fixture, root } = await render();
      await click(fixture, field(root, `ai-review-project-${SHOP}`));
      await click(fixture, field(root, `ai-review-project-${PAYMENTS}`));
      await save(fixture, root);
      expect(dialog(root).open).toBe(false);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        {
          enabled: true,
          scope: 'selected',
          projectIds: [SHOP],
          budgets: DEFAULT_BUDGETS,
        },
      ]);
      expect(fake.of(ORG_ID).projectIds).toEqual([SHOP]);
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'The AI review settings were saved.',
      );
      expect(field(root, `ai-review-project-${SHOP}`).checked).toBe(true);
    });

    it('counts the selected projects', async () => {
      setup('orgAdmin', { organizations: { [ORG_ID]: { projectIds: [] } } });
      const { fixture, root } = await render();
      const count = () => field(root, 'ai-review-selected-count').textContent?.trim();
      expect(count()).toBe('No project selected');
      await click(fixture, field(root, `ai-review-project-${PAYMENTS}`));
      expect(count()).toBe('1 project selected');
      await click(fixture, field(root, `ai-review-project-${SHOP}`));
      expect(count()).toBe('2 projects selected');
    });

    it('says so when the projects cannot be listed, and keeps the stored selection', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS], consentFor: A } },
      });
      server.on('GET', '/api/v0/projects', { status: 500, body: problem(500, 'INTERNAL') });
      const { fixture, root } = await render();
      expect(root.querySelector('[role="alert"].alert-error')?.textContent).toContain(
        'The request failed (HTTP 500',
      );
      expect(root.querySelector('fieldset.facet label')).toBeNull();
      await save(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({ projectIds: [PAYMENTS] });
    });

    it('says so when a selected project belongs to another organisation (422 PROJECT_NOT_IN_ORGANIZATION)', async () => {
      const { fake } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, projectIds: [PAYMENTS], consentFor: A } },
      });
      fake.foreignProjects.add(PAYMENTS);
      const { fixture, root } = await render();
      await save(fixture, root);
      expect(root.querySelector('[role="alert"].alert-error')?.textContent).toContain(
        'A selected project belongs to another organisation.',
      );
    });
  });

  describe('budgets', () => {
    it('sends empty optional budgets as null', async () => {
      const { server } = setup('orgAdmin', {
        organizations: {
          [ORG_ID]: {
            enabled: true,
            consentFor: A,
            budgets: {
              tokensPerDay: 10,
              costPerDayUsd: 5,
              perProjectTokensPerDay: 4,
              maxTokensPerReview: 3,
            },
          },
        },
      });
      const { fixture, root } = await render();
      type(root, 'ai-review-cost', '');
      type(root, 'ai-review-per-project', '');
      await save(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)[0]?.body).toMatchObject({
        budgets: {
          tokensPerDay: 10,
          costPerDayUsd: null,
          perProjectTokensPerDay: null,
          maxTokensPerReview: 3,
        },
      });
    });

    it('shows the limits of the fields', async () => {
      setup();
      const { root } = await render();
      const limits = (id: string) => {
        const input = field(root, id);
        return [input.min, input.max, input.type];
      };
      expect(limits('ai-review-tokens')).toEqual(['0', '1000000000', 'number']);
      expect(limits('ai-review-cost')).toEqual(['0', '1000000', 'number']);
      expect(limits('ai-review-per-project')).toEqual(['0', '1000000000', 'number']);
      expect(limits('ai-review-max-per-review')).toEqual(['1', '10000000', 'number']);
    });

    it.each([
      ['ai-review-tokens', '-1'],
      ['ai-review-tokens', '1.5'],
      ['ai-review-tokens', ''],
      ['ai-review-tokens', '1000000001'],
      ['ai-review-cost', '-0.5'],
      ['ai-review-cost', '1000001'],
      ['ai-review-per-project', '2.5'],
      ['ai-review-per-project', '1000000001'],
      ['ai-review-max-per-review', '0'],
      ['ai-review-max-per-review', '10000001'],
      ['ai-review-max-per-review', ''],
    ])('refuses %s = %j on its field and sends nothing', async (id, value) => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      const { fixture, root } = await render();
      type(root, id, value);
      await save(fixture, root);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(0);
      expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
      expect(field(root, `${id}-error`).textContent).toMatch(/^Use /);
      expect(field(root, id).getAttribute('aria-describedby')).toContain(`${id}-error`);
      expect(document.activeElement).toBe(field(root, id));
      // Typing again clears the refusal.
      type(root, id, '5');
      await settle(fixture);
      expect(root.querySelector(`#${id}-error`)).toBeNull();
    });

    it('shows the field the server refused in the page’s own words (422)', async () => {
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
      await save(fixture, root);
      expect(field(root, 'ai-review-max-per-review').getAttribute('aria-invalid')).toBe('true');
      expect(field(root, 'ai-review-max-per-review-error').textContent).toContain(
        'Use a whole number from 1 to 10 000 000.',
      );
      expect(root.textContent).not.toContain('server text');
    });

    it('shows the instance ceiling beside the tokens budget when one is set', async () => {
      setup('orgAdmin', { ceiling: 750_000 });
      const { root } = await render();
      const note = field(root, 'ai-review-ceiling');
      expect(note.textContent).toContain('750,000 tokens per organisation and day');
      expect(field(root, 'ai-review-tokens').getAttribute('aria-describedby')).toContain(
        'ai-review-ceiling',
      );
    });

    it('shows no ceiling note without a ceiling', async () => {
      setup();
      const { root } = await render();
      expect(root.querySelector('#ai-review-ceiling')).toBeNull();
    });
  });

  describe('today’s use', () => {
    const usageText = (root: HTMLElement) =>
      root.querySelector('#ai-review-usage')?.textContent?.replace(/\s+/g, ' ').trim();
    /** An organisation with review on, its own tokens per day given. */
    const reviewing = (tokensPerDay = 500_000) => ({
      [ORG_ID]: {
        enabled: true,
        budgets: { ...DEFAULT_BUDGETS, tokensPerDay },
        consentFor: A,
      },
    });

    it('shows the tokens and the reviews of the day against the budget', async () => {
      setup('orgAdmin', {
        usage: { tokensToday: 123_456, costTodayUsd: null, reviewsToday: 7 },
        organizations: reviewing(),
      });
      const { root } = await render();
      expect(usageText(root)).toBe('Today: 123,456 of 500,000 tokens · 7 reviews');
    });

    it.each([
      [300_000, 'Today: 1,000 of 300,000 tokens · 2 reviews'],
      [900_000, 'Today: 1,000 of 500,000 tokens · 2 reviews'],
      [null, 'Today: 1,000 of 500,000 tokens · 2 reviews'],
    ])(
      'counts against the smaller of the budget and the instance ceiling (%s)',
      async (ceiling, text) => {
        setup('orgAdmin', {
          usage: { tokensToday: 1_000, costTodayUsd: null, reviewsToday: 2 },
          ceiling,
          organizations: reviewing(),
        });
        expect(usageText((await render()).root)).toBe(text);
      },
    );

    it('adds the cost in dollars when the instance sets prices', async () => {
      setup('orgAdmin', {
        usage: { tokensToday: 20_000, costTodayUsd: 1.5, reviewsToday: 3 },
        organizations: reviewing(),
      });
      const { root } = await render();
      expect(usageText(root)).toBe('Today: 20,000 of 500,000 tokens · 3 reviews · $1.50');
    });

    it.each([
      [1, 'Today: 900 of 500,000 tokens · 1 review'],
      [0, 'Today: 900 of 500,000 tokens · 0 reviews'],
    ])('counts %s review(s) in the right number', async (reviewsToday, text) => {
      setup('orgAdmin', {
        usage: { tokensToday: 900, costTodayUsd: null, reviewsToday },
        organizations: reviewing(),
      });
      expect(usageText((await render()).root)).toBe(text);
    });

    it('does not follow a budget that was typed and not saved, and reads the saved answer', async () => {
      const { fake } = setup('orgAdmin', {
        usage: { tokensToday: 100, costTodayUsd: null, reviewsToday: 1 },
        organizations: reviewing(),
      });
      const { fixture, root } = await render();
      type(root, 'ai-review-tokens', '250000');
      await settle(fixture);
      expect(usageText(root)).toBe('Today: 100 of 500,000 tokens · 1 review');
      // Saving answers with the day as it is then, and with the budget just saved.
      fake.usage = { tokensToday: 4_000, costTodayUsd: null, reviewsToday: 2 };
      await save(fixture, root);
      expect(usageText(root)).toBe('Today: 4,000 of 250,000 tokens · 2 reviews');
    });
  });

  describe('data it must never show', () => {
    it('never shows the provider as a URL: the answers name its host and model only', async () => {
      setup('orgAdmin', { organizations: { [ORG_ID]: { enabled: true, consentFor: A } } });
      const { fixture, root } = await render();
      await click(fixture, button(root, 'Save'));
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
      expect(root.querySelector('h3')?.textContent?.trim()).toBe('Other');
      // The other organisation's projects are listed, not Default's.
      expect(root.querySelector(`#ai-review-project-${PAYMENTS}`)).toBeNull();
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

    it('tells a member who is not an organisation admin, and asks the server nothing', async () => {
      const { server } = setup('member');
      const { root } = await render();
      expect(root.textContent).toContain(
        'Only organisation administrators change the AI review settings.',
      );
      expect(root.querySelector('form')).toBeNull();
      expect(server.requests.filter((r) => r.path.endsWith('/ai/review'))).toHaveLength(0);
      expect(server.requests.filter((r) => r.path === '/api/v0/projects')).toHaveLength(0);
    });

    it('tells an admin of another organisation that this one is not theirs to change', async () => {
      const { server } = setup();
      const { fixture, root } = await render();
      TestBed.inject(OrgContext).select(OTHER_ID);
      await settle(fixture);
      expect(root.textContent).toContain(
        'Only organisation administrators change the AI review settings.',
      );
      expect(root.querySelector('form')).toBeNull();
      expect(server.requestsTo('GET', `/api/v0/organizations/${OTHER_ID}/ai/review`)).toHaveLength(
        0,
      );
    });

    it('says so when there is no organisation to show, instead of loading forever', async () => {
      const { server } = setup();
      server.on('GET', '/api/v0/organizations', { body: page([]) });
      const { root } = await render();
      expect(root.textContent).toContain('There is no organization to show');
      expect(root.querySelector('form')).toBeNull();
      expect(server.requests.filter((r) => r.path.endsWith('/ai/review'))).toHaveLength(0);
    });

    it('says so when the settings cannot be read', async () => {
      const { server } = setup();
      server.on('GET', ROUTE, { status: 500, body: problem(500, 'INTERNAL') });
      const { root } = await render();
      expect(root.querySelector('[role="alert"].alert-error')).not.toBeNull();
      expect(root.querySelector('form')).toBeNull();
    });

    it('shows a refusal of the save in its own words, with the form kept', async () => {
      const { server } = setup('orgAdmin', {
        organizations: { [ORG_ID]: { enabled: true, consentFor: A } },
      });
      server.on('PUT', ROUTE, { status: 403, body: problem(403, 'FORBIDDEN') });
      const { fixture, root } = await render();
      type(root, 'ai-review-tokens', '77');
      await save(fixture, root);
      expect(root.querySelector('[role="alert"].alert-error')?.textContent).toContain(
        'You are not allowed to do this.',
      );
      expect(field(root, 'ai-review-tokens').value).toBe('77');
    });
  });
});

describe('SettingsPage: AI review (6I-2 Task 9)', () => {
  async function nav(who: Who): Promise<(string | undefined)[]> {
    setup(who);
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    return [...root.querySelectorAll('nav a')].map((a) => a.textContent?.trim());
  }

  it('lists AI review under Organization for org.ai.manage only', async () => {
    expect(await nav('orgAdmin')).toContain('AI review');
    TestBed.resetTestingModule();
    expect(await nav('member')).not.toContain('AI review');
  });

  it('points the entry at /settings/ai-review', async () => {
    setup('orgAdmin');
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    const link = [...(fixture.nativeElement as HTMLElement).querySelectorAll('nav a')].find(
      (a) => a.textContent?.trim() === 'AI review',
    );
    expect(link?.getAttribute('href')).toBe('/ai-review');
  });
});
