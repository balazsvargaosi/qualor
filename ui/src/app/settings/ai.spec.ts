import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  expectNoPasswordManager,
  FakeServer,
  me,
  ORG_ID,
  page,
  problem,
  provideFakeServer,
  settle,
} from '../../testing/fake-server';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';
import { AiSettingsPage } from './ai.page';

const KEY = ['fake', 'ui', 'key', '0123456789'].join('-');
const EMPTY = {
  provider: null,
  organizations: {},
  excludePaths: [],
  budgets: {
    explainPerDay: 200,
    triagePerDay: 100,
    fixPerDay: 25,
    tokensPerDay: 1_000_000,
    costPerDayUsd: null,
    perUserPerHour: 30,
    reviewTokensPerOrganizationPerDay: null,
  },
  pricing: null,
  storePrompts: false,
  promptRetentionDays: 7,
};
const CONFIGURED = {
  ...EMPTY,
  provider: {
    kind: 'openai',
    baseUrl: 'http://ollama:11434/v1',
    model: 'qwen2.5-coder',
    auth: 'bearer',
    jsonMode: 'json_object',
    maxTokensField: 'max_tokens',
    temperature: null,
    timeoutSeconds: 60,
    apiKeySet: true,
    apiKeyReadable: true,
  },
  organizations: {
    [ORG_ID]: {
      enabled: true,
      features: { explain: true, triage: true, fix: false },
      excludedProjectIds: [],
      autoFix: { enabled: false, minSeverity: 'high', maxPerAnalysis: 10 },
      autoFixDisabledProjectIds: [],
    },
  },
};

const PROJECTS = [
  { id: 'p1', organizationId: ORG_ID, key: 'acme/payments', name: 'Payments' },
  { id: 'p2', organizationId: ORG_ID, key: 'acme/web', name: 'Web' },
  { id: 'p3', organizationId: 'other-org', key: 'other/api', name: 'Other API' },
];

/** The organisation's view of the assistant (`GET /organizations/{id}/ai`): today's use and budgets. */
function orgAi(overrides: { enabled?: boolean; usage?: object; budgets?: object } = {}) {
  return {
    enabled: overrides.enabled ?? true,
    features: { explain: true, triage: true, fix: false },
    provider: { kind: 'openai', host: 'ollama:11434', model: 'qwen2.5-coder' },
    dataSent: ['rule', 'message', 'path', 'language', 'snippet'],
    usage: { explain: 0, triage: 0, fix: 0, tokens: 0, costUsd: null, ...overrides.usage },
    budgets: { ...EMPTY.budgets, ...overrides.budgets },
  };
}

function setup(settings: object = EMPTY, features: string[] = ['llm.auto-fix']): FakeServer {
  const server = new FakeServer();
  server.on('GET', '/api/v0/system/info', {
    body: { version: '0.8.0', edition: 'enterprise', features, extensions: [] },
  });
  server.on('GET', '/api/v0/system/llm', { body: settings });
  server.on('GET', `/api/v0/organizations/${ORG_ID}/ai`, { body: orgAi({ enabled: false }) });
  server.on('GET', '/api/v0/projects', { body: page(PROJECTS) });
  server.on('GET', '/api/v0/organizations', {
    body: page([{ id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' }]),
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin: true }));
  return server;
}
async function render() {
  const fixture = TestBed.createComponent(AiSettingsPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}
function type(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
}
function submit(root: HTMLElement): void {
  root.querySelector<HTMLFormElement>('form#ai-settings')!.dispatchEvent(new Event('submit'));
}

describe('AiSettingsPage (llm.md §3, §18)', () => {
  it('says the assistant is off and names what would be sent', async () => {
    setup();
    const { root } = await render();
    expect(root.textContent).toContain('Off: no provider is configured');
    const sent = root.querySelector('#ai-data-sent')!.textContent!;
    for (const field of ['rule', 'message', 'file path', 'language', 'code around the issue'])
      expect(sent).toContain(field);
  });

  it('sends the key once in a password field and never shows it', async () => {
    const server = setup();
    server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
    const { fixture, root } = await render();
    expect(root.querySelector<HTMLInputElement>('#ai-key')!.type).toBe('password');
    type(root, '#ai-kind', 'openai');
    type(root, '#ai-url', 'http://ollama:11434/v1');
    type(root, '#ai-model', 'qwen2.5-coder');
    type(root, '#ai-key', KEY);
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).toMatchObject({
      provider: {
        kind: 'openai',
        baseUrl: 'http://ollama:11434/v1',
        model: 'qwen2.5-coder',
        apiKey: KEY,
      },
    });
    expect(root.querySelector<HTMLInputElement>('#ai-key')!.value).toBe('');
    expect(root.textContent).not.toContain(KEY);
    expect(root.textContent).toContain('An API key is set');
  });

  // OpenAI's current models refuse max_tokens; other OpenAI-compatible servers want it.
  it.each([
    ['https://api.openai.com/v1', 'max_completion_tokens'],
    ['https://acme.openai.azure.com/openai/v1', 'max_completion_tokens'],
    ['http://ollama:11434/v1', 'max_tokens'],
  ])('picks the output limit field for %s', async (url, field) => {
    const server = setup();
    server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
    const { fixture, root } = await render();
    type(root, '#ai-kind', 'openai');
    await settle(fixture);
    type(root, '#ai-url', url);
    await settle(fixture);
    expect(root.querySelector<HTMLSelectElement>('#ai-max-tokens-field')!.value).toBe(field);
    type(root, '#ai-model', 'm');
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).toMatchObject({
      provider: { maxTokensField: field },
    });
  });

  it('keeps an output limit field the admin chose, and a saved one while the host stays', async () => {
    setup({
      ...CONFIGURED,
      provider: { ...CONFIGURED.provider, baseUrl: 'https://api.openai.com/v1' },
    });
    const { fixture, root } = await render();
    const field = () => root.querySelector<HTMLSelectElement>('#ai-max-tokens-field')!.value;
    // Saved as max_tokens for an OpenAI URL (an older model): editing the path keeps it.
    type(root, '#ai-url', 'https://api.openai.com/v1/');
    await settle(fixture);
    expect(field()).toBe('max_tokens');
    // Another kind of server, then OpenAI again: the default follows the host.
    type(root, '#ai-url', 'http://vllm:8000/v1');
    await settle(fixture);
    expect(field()).toBe('max_tokens');
    type(root, '#ai-url', 'https://api.openai.com/v1');
    await settle(fixture);
    expect(field()).toBe('max_completion_tokens');
    // Chosen by hand: the host no longer changes it.
    type(root, '#ai-max-tokens-field', 'max_tokens');
    type(root, '#ai-url', 'http://vllm:8000/v1');
    type(root, '#ai-url', 'https://api.openai.com/v1');
    await settle(fixture);
    expect(field()).toBe('max_tokens');
  });

  it('says which models need max_completion_tokens', async () => {
    setup();
    const { fixture, root } = await render();
    type(root, '#ai-kind', 'openai');
    await settle(fixture);
    expect(root.querySelector('#ai-max-tokens-field-hint')!.textContent).toContain(
      "OpenAI's current models need max_completion_tokens",
    );
    expect(root.querySelector('#ai-max-tokens-field')!.getAttribute('aria-describedby')).toBe(
      'ai-max-tokens-field-hint',
    );
  });

  it('keeps the stored key when the field is empty, and maps a refused address to the key field', async () => {
    const server = setup(CONFIGURED);
    server.on('PUT', '/api/v0/system/llm', {
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [
        { path: 'body.provider.apiKey', message: 'server text' },
      ]),
    });
    const { fixture, root } = await render();
    type(root, '#ai-url', 'http://vllm:8000/v1');
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).not.toHaveProperty(
      'provider.apiKey',
    );
    expect(root.querySelector('#ai-key')?.getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('#ai-key-error')?.textContent).toContain(
      'Enter the API key again for a new address',
    );
    expect(root.textContent).not.toContain('server text');
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

  describe('the AI review ceiling (6I-2 Task 9; Task 4 D8)', () => {
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

    it('sends the stored ceiling back with every save: an omitted ceiling would clear it', async () => {
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

  it('tests the provider and shows the problem in its own words', async () => {
    const server = setup(CONFIGURED);
    server.on('POST', '/api/v0/system/llm/test', {
      body: {
        ok: false,
        model: null,
        latencyMs: 12,
        problem: { code: 'PROVIDER_REJECTED_REQUEST', message: 'server text', providerStatus: 404 },
      },
    });
    const { fixture, root } = await render();
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
    await settle(fixture);
    // A failed Test is an error, not a success message.
    const alert = root.querySelector('.alert-error[role="alert"]');
    expect(alert?.textContent).toContain(
      'The provider refused the request; check the base URL and the model.',
    );
    expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
    expect(root.textContent).not.toContain('server text');
  });

  it.each([
    [401, 'The provider refused the API key (HTTP 401).'],
    [
      403,
      'The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit.',
    ],
  ])('tells a refused key (HTTP %i) apart by the provider status', async (status, text) => {
    const server = setup(CONFIGURED);
    server.on('POST', '/api/v0/system/llm/test', {
      body: {
        ok: false,
        model: null,
        latencyMs: 12,
        problem: { code: 'PROVIDER_REFUSED_KEY', message: 'server text', providerStatus: status },
      },
    });
    const { fixture, root } = await render();
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
    await settle(fixture);
    expect(root.querySelector('.alert-error[role="alert"]')?.textContent).toContain(text);
  });

  it('shows a successful Test in the status region', async () => {
    const server = setup(CONFIGURED);
    server.on('POST', '/api/v0/system/llm/test', {
      body: { ok: true, model: 'qwen2.5-coder', latencyMs: 12, problem: null },
    });
    const { fixture, root } = await render();
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
    await settle(fixture);
    expect(root.querySelector('[role="status"] .alert-success')?.textContent).toContain(
      'Connected to qwen2.5-coder in 12 ms.',
    );
    expect(root.querySelector('.alert-error')).toBeNull();
  });

  it('counts organisations and excluded projects in the singular and the plural', async () => {
    setup({
      ...CONFIGURED,
      organizations: {
        [ORG_ID]: { ...CONFIGURED.organizations[ORG_ID], excludedProjectIds: ['p1'] },
      },
    });
    const { root } = await render();
    expect(root.textContent).toContain('On for 1 organisation');
    expect(root.textContent).not.toContain('1 organisations');
    expect(root.textContent).toContain('1 project excluded');
  });

  it('edits the excluded projects of an organisation, keeping one it does not list', async () => {
    const server = setup({
      ...CONFIGURED,
      organizations: {
        [ORG_ID]: { ...CONFIGURED.organizations[ORG_ID], excludedProjectIds: ['p1', 'p9'] },
      },
    });
    server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
    const { fixture, root } = await render();
    const payments = root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-exclude-p1`)!;
    const web = root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-exclude-p2`)!;
    expect(payments.checked).toBe(true);
    expect(web.checked).toBe(false);
    expect(root.querySelector(`label[for="ai-org-${ORG_ID}-exclude-p2"]`)?.textContent).toContain(
      'Web',
    );
    // Another organisation's project is not offered here.
    expect(root.querySelector(`#ai-org-${ORG_ID}-exclude-p3`)).toBeNull();
    payments.click();
    web.click();
    submit(root);
    await settle(fixture);
    const body = server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as {
      organizations: Record<string, { excludedProjectIds: string[] }>;
    };
    expect(body.organizations[ORG_ID]?.excludedProjectIds.sort()).toEqual(['p2', 'p9']);
  });

  it('never sends the automatic fix suggestion fields, so a save keeps what other admins set', async () => {
    const server = setup({
      ...CONFIGURED,
      organizations: {
        [ORG_ID]: {
          ...CONFIGURED.organizations[ORG_ID],
          autoFix: { enabled: true, minSeverity: 'medium', maxPerAnalysis: 5 },
          autoFixDisabledProjectIds: ['p1'],
        },
      },
    });
    server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
    const { fixture, root } = await render();
    root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-fix`)!.click();
    submit(root);
    await settle(fixture);
    const body = server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as {
      organizations: Record<string, object>;
    };
    expect(body.organizations[ORG_ID]).toEqual({
      enabled: true,
      features: { explain: true, triage: true, fix: true },
      excludedProjectIds: [],
    });
  });

  it('enables an organisation absent from the settings without the automatic fix fields', async () => {
    const server = setup({ ...CONFIGURED, organizations: {} });
    server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
    const { fixture, root } = await render();
    root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-enabled`)!.click();
    submit(root);
    await settle(fixture);
    const body = server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as {
      organizations: Record<string, object>;
    };
    expect(body.organizations[ORG_ID]).not.toHaveProperty('autoFix');
    expect(body.organizations[ORG_ID]).not.toHaveProperty('autoFixDisabledProjectIds');
    expect(body.organizations[ORG_ID]).toMatchObject({ enabled: true });
  });

  it('refuses a key typed while the kind is None, and says so', async () => {
    const server = setup();
    const { fixture, root } = await render();
    type(root, '#ai-key', KEY);
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
    expect(root.querySelector('#ai-key')?.getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('#ai-key-error')?.textContent).toContain(
      'Choose a provider kind before typing an API key',
    );
    expect(root.querySelector<HTMLInputElement>('#ai-key')!.value).toBe('');
  });

  it('refuses a malformed key with a text about its format', async () => {
    const server = setup(CONFIGURED);
    const { fixture, root } = await render();
    type(root, '#ai-key', 'two words');
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
    const message = root.querySelector('#ai-key-error')?.textContent ?? '';
    expect(message).toContain('1 to 4096 printable characters without spaces');
    expect(message).not.toContain('new address');
  });

  it('separates the sentences of the key hint', async () => {
    setup(CONFIGURED);
    const { root } = await render();
    expect(root.querySelector('#ai-key-hint')?.textContent?.replace(/\s+/g, ' ')).toContain(
      'keep it. Stored encrypted',
    );
  });

  it('enables an organisation and its features', async () => {
    const server = setup(CONFIGURED);
    server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
    const { fixture, root } = await render();
    root.querySelector<HTMLInputElement>(`#ai-org-${ORG_ID}-fix`)!.click();
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).toMatchObject({
      organizations: {
        [ORG_ID]: { enabled: true, features: { explain: true, triage: true, fix: true } },
      },
    });
  });

  it('empties the key field after a refused save too', async () => {
    const server = setup(CONFIGURED);
    server.on('PUT', '/api/v0/system/llm', { status: 500, body: problem(500, 'INTERNAL') });
    const { fixture, root } = await render();
    type(root, '#ai-key', KEY);
    submit(root);
    await settle(fixture);
    expect(server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body).toMatchObject({
      provider: { apiKey: KEY },
    });
    expect(root.querySelector<HTMLInputElement>('#ai-key')!.value).toBe('');
    expect(root.querySelector<HTMLInputElement>('#ai-key')!.getAttribute('autocomplete')).toBe(
      'new-password',
    );
    expectNoPasswordManager(root.querySelector('#ai-key')!);
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.textContent).not.toContain(KEY);
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
