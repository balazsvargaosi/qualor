import { TestBed } from '@angular/core/testing';
import { CONFIGURED, orgAi, render, setup, submit, type } from '../../testing/ai-settings';
import type { FakeServer } from '../../testing/fake-server';
import { me, ORG_ID, page, problem, settle } from '../../testing/fake-server';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';

describe('AiSettingsPage (llm.md §3, §18)', () => {
  it('says the assistant is off and names what would be sent', async () => {
    setup();
    const { root } = await render();
    expect(root.textContent).toContain('Off: no provider is configured');
    const sent = root.querySelector('#ai-data-sent')!.textContent!;
    for (const field of ['rule', 'message', 'file path', 'language', 'code around the issue'])
      expect(sent).toContain(field);
  });

  it('shows no "at most 25 per day" text: the fix budget has the bounds of the other budgets (D10)', async () => {
    setup(CONFIGURED);
    const { root } = await render();
    const field = root.querySelector<HTMLInputElement>('#ai-budget-fix')!;
    expect(field.max).toBe('100000');
    expect(field.value).toBe('25');
    // No edition ceiling in any wording, and no note beside the field.
    expect(root.textContent).not.toMatch(/at most 25/i);
    expect(root.textContent).not.toContain('in this edition');
    expect(root.textContent).not.toContain('community');
    expect(root.querySelector('#ai-budget-fix-hint')).toBeNull();
    expect(field.getAttribute('aria-describedby')).toBeNull();
  });

  it('takes a fix budget up to 100 000 and refuses more on its field, sending nothing (D10)', async () => {
    const server = setup(CONFIGURED);
    server.on('PUT', '/api/v0/system/llm', (request) => ({
      body: { ...CONFIGURED, budgets: (request.body as typeof CONFIGURED).budgets },
    }));
    const { fixture, root } = await render();
    type(root, '#ai-budget-fix', '100000');
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(1);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).toMatchObject({
      budgets: { fixPerDay: 100_000 },
    });

    type(root, '#ai-budget-fix', '100001');
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(1);
    expect(root.querySelector('#ai-budget-fix')?.getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('#ai-budget-fix-error')?.textContent).toContain(
      'Use a whole number, 0 or more.',
    );
  });

  describe('the AI review ceiling (6I-2 Task 9)', () => {
    const WITH_CEILING = {
      ...CONFIGURED,
      budgets: { ...CONFIGURED.budgets, reviewTokensPerOrganizationPerDay: 750_000 },
    };
    const echo = (request: { body: unknown }) => ({
      body: { ...CONFIGURED, budgets: (request.body as typeof CONFIGURED).budgets },
    });

    it('has a field for the most tokens per organisation and day of AI review, with its limits', async () => {
      setup(WITH_CEILING);
      const { root } = await render();
      expect(root.querySelector('label[for="ai-budget-review"]')?.textContent?.trim()).toBe(
        'AI review: most tokens per organisation per day',
      );
      const field = root.querySelector<HTMLInputElement>('#ai-budget-review')!;
      expect(field.value).toBe('750000');
      expect([field.type, field.min, field.max]).toEqual(['number', '0', '1000000000']);
      expect(field.getAttribute('aria-describedby')).toBe('ai-budget-review-hint');
      expect(root.querySelector('#ai-budget-review-hint')?.textContent).toContain(
        'Leave it empty for no limit.',
      );
    });

    it('is empty while there is no ceiling', async () => {
      setup(CONFIGURED);
      const { root } = await render();
      expect(root.querySelector<HTMLInputElement>('#ai-budget-review')!.value).toBe('');
    });

    it('sends the stored ceiling back with every save', async () => {
      const server = setup(WITH_CEILING);
      server.on('PUT', '/api/v0/system/llm', echo);
      const { fixture, root } = await render();
      // An unrelated change: the ceiling travels with it, unchanged.
      type(root, '#ai-budget-fix', '30');
      submit(root);
      await settle(fixture);
      const puts = server.requestsTo('PUT', '/api/v0/system/llm');
      expect(puts).toHaveLength(1);
      expect(puts[0]?.body).toMatchObject({
        budgets: { fixPerDay: 30, reviewTokensPerOrganizationPerDay: 750_000 },
      });
    });

    it('sends null, not nothing, while there is no ceiling', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', echo);
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      const body = server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as {
        budgets: Record<string, unknown>;
      };
      expect(body.budgets).toHaveProperty('reviewTokensPerOrganizationPerDay', null);
    });

    it('sets a ceiling, and removes it by emptying the field', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', echo);
      const { fixture, root } = await render();
      type(root, '#ai-budget-review', '1000000');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).toMatchObject({
        budgets: { reviewTokensPerOrganizationPerDay: 1_000_000 },
      });
      // The saved answer fills the field again.
      expect(root.querySelector<HTMLInputElement>('#ai-budget-review')!.value).toBe('1000000');
      type(root, '#ai-budget-review', '');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body).toMatchObject({
        budgets: { reviewTokensPerOrganizationPerDay: null },
      });
    });

    it('takes 0 (no organisation may review) and refuses what is not a whole number up to 1 000 000 000', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', echo);
      const { fixture, root } = await render();
      type(root, '#ai-budget-review', '0');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).toMatchObject({
        budgets: { reviewTokensPerOrganizationPerDay: 0 },
      });
      for (const value of ['-1', '1.5', '1000000001']) {
        type(root, '#ai-budget-review', value);
        submit(root);
        await settle(fixture);
        expect(root.querySelector('#ai-budget-review')?.getAttribute('aria-invalid')).toBe('true');
        expect(root.querySelector('#ai-budget-review-error')?.textContent).toContain(
          'Use a whole number, 0 or more, or leave it empty for no limit.',
        );
      }
      expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(1);
    });

    it('maps the server’s refusal of the ceiling to its field', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [
          { path: 'body.budgets.reviewTokensPerOrganizationPerDay', message: 'server text' },
        ]),
      });
      const { fixture, root } = await render();
      type(root, '#ai-budget-review', '5');
      submit(root);
      await settle(fixture);
      expect(root.querySelector('#ai-budget-review')?.getAttribute('aria-invalid')).toBe('true');
      expect(root.textContent).not.toContain('server text');
    });
  });

  it("shows the current organisation's use of today against its budgets, as meters with words", async () => {
    const server = setup(CONFIGURED);
    server.on('GET', `/api/v0/organizations/${ORG_ID}/ai`, {
      body: orgAi({
        usage: { explain: 200, triage: 3, tokens: 1234, costUsd: 0.5 },
        budgets: { costPerDayUsd: 2 },
      }),
    });
    const { root } = await render();
    const today = root.querySelector('#ai-today')!;
    expect(today.querySelector('h3')?.textContent?.trim()).toBe('Today in Default (UTC)');
    const meters = [...today.querySelectorAll('q-meter')].map((m) =>
      m.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(meters).toEqual([
      'Explanations 200 of 200 Budget reached for today',
      'Triage suggestions 3 of 100',
      'Fix suggestions 0 of 25',
      'Tokens 1,234 of 1,000,000',
      'Cost $0.50 of $2.00',
    ]);
  });

  it("reads today's use again after a save, so the meters show the saved budgets", async () => {
    const server = setup(CONFIGURED);
    let explainPerDay = 200;
    server.on('GET', `/api/v0/organizations/${ORG_ID}/ai`, () => ({
      body: orgAi({ usage: { explain: 3 }, budgets: { explainPerDay } }),
    }));
    server.on('PUT', '/api/v0/system/llm', () => {
      explainPerDay = 999;
      return { body: { ...CONFIGURED, budgets: { ...CONFIGURED.budgets, explainPerDay } } };
    });
    const { fixture, root } = await render();
    const explain = () =>
      root.querySelector('#ai-today q-meter')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(explain()).toBe('Explanations 3 of 200');
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('GET', `/api/v0/organizations/${ORG_ID}/ai`)).toHaveLength(2);
    expect(explain()).toBe('Explanations 3 of 999');
  });

  it("says when the assistant is off for the organisation, and when today's use cannot be read", async () => {
    const off = setup(CONFIGURED);
    const first = await render();
    expect(first.root.querySelector('#ai-today')?.textContent).toContain(
      'The assistant is off for Default: nothing is sent.',
    );
    expect(first.root.querySelector('#ai-today q-meter')).toBeNull();
    expect(off.requestsTo('GET', `/api/v0/organizations/${ORG_ID}/ai`)).toHaveLength(1);
    TestBed.resetTestingModule();
    const failing = setup(CONFIGURED);
    failing.on('GET', `/api/v0/organizations/${ORG_ID}/ai`, {
      status: 500,
      body: problem(500, 'INTERNAL'),
    });
    const second = await render();
    expect(second.root.querySelector('#ai-today .alert-error')?.textContent).toContain(
      "Today's use could not be read.",
    );
    // The rest of the page renders.
    expect(second.root.querySelector('form#ai-settings')).not.toBeNull();
  });

  it('asks nothing of the server for a user who is not an instance admin', async () => {
    const server = setup(CONFIGURED);
    TestBed.inject(SessionStore).set(me());
    const { root } = await render();
    expect(root.textContent).toContain('Only instance administrators configure the AI assistant.');
    expect(server.requestsTo('GET', '/api/v0/system/llm')).toHaveLength(0);
  });
});

describe('AiSettingsPage: step 11', () => {
  it('says that a reached token or cost budget holds back every feature', async () => {
    const server = setup(CONFIGURED);
    server.on('GET', `/api/v0/organizations/${ORG_ID}/ai`, {
      body: orgAi({ usage: { tokens: 1_000_000 }, budgets: { tokensPerDay: 1_000_000 } }),
    });
    const { root } = await render();
    expect(root.querySelector('#ai-today')?.textContent).toContain(
      'Every feature waits until midnight UTC: the token or cost budget for today is reached.',
    );
  });

  it('says so when there is no organization to show, instead of loading forever', async () => {
    const server = setup(CONFIGURED);
    server.on('GET', '/api/v0/organizations', { body: page([]) });
    const { root } = await render();
    const today = root.querySelector('#ai-today')!;
    expect(today.querySelector('h3')?.textContent?.trim()).toBe('Today (UTC)');
    expect(today.textContent).toContain('There is no organization yet.');
    expect(today.textContent).not.toContain('Loading');
  });

  it('says what is sent once, under its heading', async () => {
    setup(CONFIGURED);
    const { root } = await render();
    const sent = root.querySelector('#ai-data-sent .panel-body p')?.textContent?.trim() ?? '';
    expect(sent.startsWith('The rule, the finding')).toBe(true);
  });
});

describe('AiSettingsPage: final review', () => {
  it('says the organizations could not be loaded, never that there are none', async () => {
    const server = setup(CONFIGURED);
    const { fixture, root } = await render();
    // The header's list fails when read again; the page's own list stays loaded.
    server.on('GET', '/api/v0/organizations', { status: 500, body: problem(500, 'INTERNAL') });
    TestBed.inject(OrgContext).organizations.reload();
    await settle(fixture);
    const today = root.querySelector('#ai-today')!;
    expect(today.textContent).not.toContain('There is no organization yet');
    expect(today.textContent).toContain('The organizations could not be loaded.');
  });

  it('says nothing waits for midnight when a budget of 0 allows none', async () => {
    const server = setup(CONFIGURED);
    server.on('GET', `/api/v0/organizations/${ORG_ID}/ai`, {
      body: orgAi({ usage: { tokens: 0 }, budgets: { tokensPerDay: 0 } }),
    });
    const { root } = await render();
    expect(root.querySelector('#ai-today')?.textContent).not.toContain('midnight');
  });
});

describe('AiSettingsPage: automatic fix suggestions (4E-3a §4)', () => {
  const OTHER_ID = '0190a6c2-0000-7000-8000-000000000002';
  const STORED = { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 };
  const TWO_ORGS = {
    ...CONFIGURED,
    organizations: {
      [ORG_ID]: { ...CONFIGURED.organizations[ORG_ID], autoFix: STORED },
      [OTHER_ID]: {
        enabled: true,
        features: { explain: false, triage: false, fix: true },
        excludedProjectIds: [],
        autoFix: { enabled: true, minSeverity: 'low', maxPerAnalysis: 3 },
        autoFixDisabledProjectIds: ['p3'],
      },
    },
  };
  function withTwoOrgs(server: FakeServer): void {
    server.on('GET', '/api/v0/organizations', {
      body: page([
        { id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' },
        { id: OTHER_ID, key: 'other', name: 'Other', createdAt: '', updatedAt: '' },
      ]),
    });
  }
  const put = (server: FakeServer) =>
    server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as
      { organizations: Record<string, Record<string, unknown>> } | undefined;

  it("shows each organisation's stored block", async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    const { root } = await render();
    const other = (field: string) =>
      root.querySelector<HTMLInputElement & HTMLSelectElement>(`#ai-org-${OTHER_ID}-${field}`)!;
    expect(other('auto-fix').checked).toBe(true);
    expect(other('auto-fix-severity').value).toBe('low');
    expect(other('auto-fix-max').value).toBe('3');
    const own = root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-auto-fix`)!;
    expect(own.checked).toBe(false);
    expect(root.querySelector(`[data-key="${ORG_ID}"]`)?.textContent).toContain(
      "Fix suggestions are posted to the organisation's merge requests without a click",
    );
  });

  it("sends the block of the organisation edited here, and leaves an unedited one's out", async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    server.on('PUT', '/api/v0/system/llm', { body: TWO_ORGS });
    const { fixture, root } = await render();
    root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-auto-fix`)!.click();
    type(root, `#ai-org-${ORG_ID}-auto-fix-severity`, 'medium');
    type(root, `#ai-org-${ORG_ID}-auto-fix-max`, '5');
    submit(root);
    await settle(fixture);
    const body = put(server)!;
    expect(body.organizations[ORG_ID]).toEqual({
      enabled: true,
      features: { explain: true, triage: true, fix: false },
      excludedProjectIds: [],
      autoFix: { enabled: true, minSeverity: 'medium', maxPerAnalysis: 5 },
    });
    // The other organisation was not edited: its stored block and opt-outs stay the server's.
    expect(body.organizations[OTHER_ID]).toEqual({
      enabled: true,
      features: { explain: false, triage: false, fix: true },
      excludedProjectIds: [],
    });
  });

  it('forgets what was edited once saved: the next save sends no block', async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    server.on('PUT', '/api/v0/system/llm', { body: TWO_ORGS });
    const { fixture, root } = await render();
    type(root, `#ai-org-${ORG_ID}-auto-fix-max`, '7');
    submit(root);
    await settle(fixture);
    submit(root);
    await settle(fixture);
    const [first, second] = server
      .requestsTo('PUT', '/api/v0/system/llm')
      .map((r) => r.body as { organizations: Record<string, object> });
    expect(first?.organizations[ORG_ID]).toHaveProperty('autoFix');
    expect(second?.organizations[ORG_ID]).not.toHaveProperty('autoFix');
  });

  it('sends no block for an edit taken back before the save', async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    server.on('PUT', '/api/v0/system/llm', { body: TWO_ORGS });
    const { fixture, root } = await render();
    type(root, `#ai-org-${OTHER_ID}-auto-fix-severity`, 'high');
    type(root, `#ai-org-${OTHER_ID}-auto-fix-severity`, 'low');
    root.querySelector<HTMLInputElement>(`#ai-org-${OTHER_ID}-auto-fix`)!.click();
    root.querySelector<HTMLInputElement>(`#ai-org-${OTHER_ID}-auto-fix`)!.click();
    submit(root);
    await settle(fixture);
    expect(put(server)?.organizations[OTHER_ID]).not.toHaveProperty('autoFix');
  });

  it('counts the maximum as a number: 010 for a stored 10 is no edit', async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    server.on('PUT', '/api/v0/system/llm', { body: TWO_ORGS });
    const { fixture, root } = await render();
    type(root, `#ai-org-${ORG_ID}-auto-fix-max`, '010');
    submit(root);
    await settle(fixture);
    expect(put(server)?.organizations[ORG_ID]).not.toHaveProperty('autoFix');
  });

  it("leaves a refused opt-out list alone: it is not the organisation's block", async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    server.on('PUT', '/api/v0/system/llm', {
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [
        {
          path: `body.organizations.${ORG_ID}.autoFixDisabledProjectIds.0`,
          message: 'Not a project of this organisation',
        },
      ]),
    });
    const { fixture, root } = await render();
    submit(root);
    await settle(fixture);
    expect(root.querySelector(`#ai-org-${ORG_ID}-auto-fix-error`)).toBeNull();
    expect(root.querySelector('.alert-error')).not.toBeNull();
  });

  it('sends an organisation absent from the settings once its block is edited', async () => {
    const server = setup({ ...CONFIGURED, organizations: {} });
    server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
    const { fixture, root } = await render();
    root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-auto-fix`)!.click();
    submit(root);
    await settle(fixture);
    expect(put(server)?.organizations[ORG_ID]).toEqual({
      enabled: false,
      features: { explain: false, triage: false, fix: false },
      excludedProjectIds: [],
      autoFix: { enabled: true, minSeverity: 'high', maxPerAnalysis: 10 },
    });
  });

  it('refuses a maximum outside 1 to 25 on its field and sends nothing', async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    const { fixture, root } = await render();
    type(root, `#ai-org-${OTHER_ID}-auto-fix-max`, '26');
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
    const field = root.querySelector(`#ai-org-${OTHER_ID}-auto-fix-max`)!;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector(`#ai-org-${OTHER_ID}-auto-fix-error`)?.textContent).toContain(
      'Use a whole number from 1 to 25.',
    );
    expect(document.activeElement).toBe(field);
    // Typing again clears it.
    type(root, `#ai-org-${OTHER_ID}-auto-fix-max`, '25');
    await settle(fixture);
    expect(root.querySelector(`#ai-org-${OTHER_ID}-auto-fix-error`)).toBeNull();
  });

  it("maps a refused switch-on (422 …autoFix.enabled) to the organisation's block", async () => {
    const server = setup(TWO_ORGS);
    withTwoOrgs(server);
    server.on('PUT', '/api/v0/system/llm', {
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [
        { path: `body.organizations.${ORG_ID}.autoFix.enabled`, message: 'Needs the feature' },
      ]),
    });
    const { fixture, root } = await render();
    root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-auto-fix`)!.click();
    submit(root);
    await settle(fixture);
    expect(root.querySelector(`#ai-org-${ORG_ID}-auto-fix-error`)?.textContent).toContain(
      'Automatic fix suggestions need the Enterprise plan.',
    );
    expect(root.querySelector('.alert-error')).toBeNull();
  });

  it('shows the Enterprise note in place of the controls without llm.auto-fix, and sends no block', async () => {
    const server = setup(TWO_ORGS, []);
    withTwoOrgs(server);
    server.on('PUT', '/api/v0/system/llm', { body: TWO_ORGS });
    const { fixture, root } = await render();
    expect(root.querySelector(`#ai-org-${ORG_ID}-auto-fix`)).toBeNull();
    expect(root.querySelector(`[data-key="${ORG_ID}"]`)?.textContent).toContain(
      'Automatic fix suggestions need the Enterprise plan.',
    );
    submit(root);
    await settle(fixture);
    const body = put(server)!;
    for (const id of [ORG_ID, OTHER_ID]) {
      expect(body.organizations[id]).not.toHaveProperty('autoFix');
      expect(body.organizations[id]).not.toHaveProperty('autoFixDisabledProjectIds');
    }
  });
});
