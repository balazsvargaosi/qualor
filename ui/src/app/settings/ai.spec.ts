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
import type { ResponseBody } from '../api/types';
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
    api: 'chat_completions',
    baseUrl: 'http://ollama:11434/v1',
    model: 'qwen2.5-coder',
    strongModel: null,
    fastModel: null,
    auth: 'bearer',
    jsonMode: 'json_object',
    maxTokensField: 'max_tokens',
    temperature: null,
    workspaceId: null,
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

type TestAnswer = ResponseBody<'/api/v0/system/llm/test', 'post'>;

/**
 * The answer of a Test of one model: the answer's own fields are the standard model's, and
 * `models` holds the one line that repeats them. It has no hint unless one is given.
 */
function testAnswer(
  own: Omit<TestAnswer, 'models' | 'hint'> & { hint?: TestAnswer['hint'] },
): TestAnswer {
  const hint = own.hint ?? null;
  return {
    ...own,
    hint,
    models: [
      {
        tier: 'standard',
        model: 'qwen2.5-coder',
        ok: own.ok,
        reportedModel: own.model,
        latencyMs: own.latencyMs,
        toolCalling: own.toolCalling,
        problem: own.problem,
        hint,
      },
    ],
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

  it('tests the provider and shows the problem in its own words', async () => {
    const server = setup(CONFIGURED);
    server.on('POST', '/api/v0/system/llm/test', {
      body: testAnswer({
        ok: false,
        model: null,
        latencyMs: 12,
        toolCalling: 'not_checked',
        problem: { code: 'PROVIDER_REJECTED_REQUEST', message: 'server text', providerStatus: 404 },
      }),
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
      body: testAnswer({
        ok: false,
        model: null,
        latencyMs: 12,
        toolCalling: 'not_checked',
        problem: { code: 'PROVIDER_REFUSED_KEY', message: 'server text', providerStatus: status },
      }),
    });
    const { fixture, root } = await render();
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
    await settle(fixture);
    expect(root.querySelector('.alert-error[role="alert"]')?.textContent).toContain(text);
  });

  describe('tool calling, which AI review needs', () => {
    const pressTest = async (
      fixture: { whenStable(): Promise<unknown> },
      root: HTMLElement,
    ): Promise<void> => {
      [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
      await settle(fixture);
    };

    it.each([
      ['supported', 'Tool calling (needed by AI review): supported', 'alert-success'],
      ['not_supported', 'Tool calling (needed by AI review): not supported', 'alert-warn'],
    ] as const)('names it after a Test that passed (%s)', async (toolCalling, text, tone) => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling,
          problem: null,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      const status = root.querySelector('[role="status"]')!;
      // Beside the connection, in the same live region.
      expect(status.querySelector('.alert-success')?.textContent).toContain(
        'Connected to qwen2.5-coder in 12 ms.',
      );
      const line = status.querySelector('#ai-test-tools')!;
      expect(line.textContent?.trim()).toBe(text);
      expect(line.classList).toContain(tone);
      expect(root.querySelector('.alert-error')).toBeNull();
    });

    it('says nothing of it when the check could not tell', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'not_checked',
          problem: null,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('[role="status"] .alert-success')?.textContent).toContain(
        'Connected to qwen2.5-coder in 12 ms.',
      );
      expect(root.querySelector('#ai-test-tools')).toBeNull();
      expect(root.textContent).not.toContain('Tool calling');
    });

    it('says nothing of it when the Test failed', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: false,
          model: null,
          latencyMs: 12,
          toolCalling: 'not_checked',
          problem: { code: 'PROVIDER_REFUSED_KEY', message: 'server text', providerStatus: 401 },
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('.alert-error[role="alert"]')).not.toBeNull();
      expect(root.querySelector('#ai-test-tools')).toBeNull();
    });

    it('forgets the line when the page does anything else', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'supported',
          problem: null,
        }),
      });
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('#ai-test-tools')).not.toBeNull();
      submit(root);
      await settle(fixture);
      expect(root.querySelector('#ai-test-tools')).toBeNull();
    });
  });

  it('shows a successful Test in the status region', async () => {
    const server = setup(CONFIGURED);
    server.on('POST', '/api/v0/system/llm/test', {
      body: testAnswer({
        ok: true,
        model: 'qwen2.5-coder',
        latencyMs: 12,
        toolCalling: 'not_checked',
        problem: null,
      }),
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

describe('AiSettingsPage: the models of the tiers (6I-4)', () => {
  const PRICES = { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 };
  const STRONG_PRICES = { inputUsdPerMTok: 2, outputUsdPerMTok: 8 };
  const FAST_PRICES = { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 };
  /** A provider with a model of each tier, and the prices of the three. */
  const THREE_MODELS = {
    ...CONFIGURED,
    provider: { ...CONFIGURED.provider, strongModel: 'qwen3-max', fastModel: 'qwen2.5-small' },
    pricing: { ...PRICES, strong: STRONG_PRICES, fast: FAST_PRICES },
  };
  const field = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
  const labelOf = (root: HTMLElement, id: string) =>
    root.querySelector(`label[for="${id}"]`)?.textContent?.trim();
  /** The ids of the price fields, in the page's order. */
  const priceIds = (root: HTMLElement) =>
    [...root.querySelectorAll('input[id^="ai-price-"]')].map((input) => input.id);
  type PutBody = { provider: Record<string, unknown>; pricing: Record<string, unknown> | null };
  /** The body of the first save the page sent. */
  const sent = (server: FakeServer) =>
    server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as PutBody | undefined;

  describe('the fields', () => {
    it('has an optional Strong model and an optional Fast model, right after Model, with their hints', async () => {
      setup(CONFIGURED);
      const { root } = await render();
      expect(labelOf(root, 'ai-strong-model')).toBe('Strong model');
      expect(labelOf(root, 'ai-fast-model')).toBe('Fast model');
      expect(root.querySelector('#ai-strong-model-hint')?.textContent?.trim()).toBe(
        'Used for the judge and the security checks. Empty: the model above.',
      );
      expect(root.querySelector('#ai-fast-model-hint')?.textContent?.trim()).toBe(
        'Used for small reviews. Empty: the model above.',
      );
      for (const id of ['ai-strong-model', 'ai-fast-model']) {
        const input = field(root, id);
        // As Model: a text of at most 200 characters; optional, so empty is fine.
        expect([input.type, input.maxLength, input.value, input.required]).toEqual([
          'text',
          200,
          '',
          false,
        ]);
        expect(input.getAttribute('aria-describedby')).toBe(`${id}-hint`);
        expect(input.getAttribute('aria-invalid')).toBeNull();
      }
      // The rows follow Model's, in that order.
      const row = (id: string) => field(root, id).closest('.setting-row');
      expect(row('ai-model')?.nextElementSibling).toBe(row('ai-strong-model'));
      expect(row('ai-strong-model')?.nextElementSibling).toBe(row('ai-fast-model'));
      expect(row('ai-fast-model')?.nextElementSibling).toBe(row('ai-key'));
    });

    it('shows the stored tier models', async () => {
      setup(THREE_MODELS);
      const { root } = await render();
      expect(field(root, 'ai-model').value).toBe('qwen2.5-coder');
      expect(field(root, 'ai-strong-model').value).toBe('qwen3-max');
      expect(field(root, 'ai-fast-model').value).toBe('qwen2.5-small');
    });

    it('sends an empty tier model as null, and a typed one trimmed', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ strongModel: null, fastModel: null });

      type(root, '#ai-strong-model', '  qwen3-max ');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body).toMatchObject({
        provider: { model: 'qwen2.5-coder', strongModel: 'qwen3-max', fastModel: null },
      });
    });

    it('takes a tier model back to null when its field is emptied', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      type(root, '#ai-fast-model', '');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ strongModel: 'qwen3-max', fastModel: null });
    });

    it.each([['strong'], ['fast']] as const)(
      'refuses a %s model that is not a model name on its own field, and sends nothing',
      async (tier) => {
        const server = setup(CONFIGURED);
        const { fixture, root } = await render();
        const id = `ai-${tier}-model`;
        type(root, `#${id}`, 'two words');
        submit(root);
        await settle(fixture);
        expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
        expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
        expect(root.querySelector(`#${id}-error`)?.textContent).toContain(
          "Use the model's name as the provider spells it",
        );
        expect(field(root, id).getAttribute('aria-describedby')).toBe(`${id}-error ${id}-hint`);
        expect(document.activeElement).toBe(field(root, id));
        // Typing again takes the refusal back.
        type(root, `#${id}`, 'qwen3-max');
        await settle(fixture);
        expect(root.querySelector(`#${id}-error`)).toBeNull();
        expect(field(root, id).getAttribute('aria-invalid')).toBeNull();
      },
    );

    it.each([
      ['body.provider.strongModel', 'ai-strong-model'],
      ['body.provider.fastModel', 'ai-fast-model'],
    ])('maps the server’s refusal at %s to its field, in the page’s words', async (path, id) => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [{ path, message: 'server text' }]),
      });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector(`#${id}-error`)?.textContent).toContain(
        "Use the model's name as the provider spells it",
      );
      expect(root.textContent).not.toContain('server text');
      expect(root.querySelector('.alert-error')).toBeNull();
    });
  });

  describe('the prices', () => {
    it('shows the price fields of a tier only while it has a model of its own', async () => {
      setup(CONFIGURED);
      const { fixture, root } = await render();
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);

      type(root, '#ai-strong-model', 'qwen3-max');
      await settle(fixture);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
      ]);
      type(root, '#ai-fast-model', 'qwen2.5-small');
      await settle(fixture);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
        'ai-price-fast-input',
        'ai-price-fast-output',
      ]);
      // The same model as Model is no model of its own: the standard prices are its prices.
      type(root, '#ai-fast-model', ' qwen2.5-coder ');
      await settle(fixture);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
      ]);
      // Emptied, and a tier that now has the model above, have none either.
      type(root, '#ai-strong-model', '');
      type(root, '#ai-model', 'qwen2.5-small');
      type(root, '#ai-fast-model', 'qwen2.5-small');
      await settle(fixture);
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);
    });

    it('names each price after its model, and puts them after the two prices', async () => {
      setup(THREE_MODELS);
      const { root } = await render();
      const unit = '(US dollars per million tokens)';
      expect(labelOf(root, 'ai-price-input')).toBe(`Input price ${unit}`);
      expect(labelOf(root, 'ai-price-strong-input')).toBe(`Strong model: input price ${unit}`);
      expect(labelOf(root, 'ai-price-strong-output')).toBe(`Strong model: output price ${unit}`);
      expect(labelOf(root, 'ai-price-fast-input')).toBe(`Fast model: input price ${unit}`);
      expect(labelOf(root, 'ai-price-fast-output')).toBe(`Fast model: output price ${unit}`);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
        'ai-price-fast-input',
        'ai-price-fast-output',
      ]);
      // As the standard prices: numbers from 0 to 10 000.
      for (const id of priceIds(root)) {
        const input = field(root, id);
        expect([input.type, input.min, input.max, input.step]).toEqual([
          'number',
          '0',
          '10000',
          '0.01',
        ]);
      }
    });

    it('shows the stored prices of the tiers', async () => {
      setup(THREE_MODELS);
      const { root } = await render();
      expect(priceIds(root).map((id) => [id, field(root, id).value])).toEqual([
        ['ai-price-input', '0.3'],
        ['ai-price-output', '1.2'],
        ['ai-price-strong-input', '2'],
        ['ai-price-strong-output', '8'],
        ['ai-price-fast-input', '0.1'],
        ['ai-price-fast-output', '0.4'],
      ]);
    });

    it('sends the prices of the tiers with the standard ones, and none for a tier without a model of its own', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-price-input', '0.3');
      type(root, '#ai-price-output', '1.2');
      submit(root);
      await settle(fixture);
      // A tier that has no model of its own sends null: the server prices it at the standard prices.
      expect(sent(server)?.pricing).toEqual({ ...PRICES, strong: null, fast: null });

      type(root, '#ai-price-input', '0.3');
      type(root, '#ai-price-output', '1.2');
      type(root, '#ai-strong-model', 'qwen3-max');
      await settle(fixture);
      type(root, '#ai-price-strong-input', '2');
      type(root, '#ai-price-strong-output', '8');
      submit(root);
      await settle(fixture);
      expect((server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body as PutBody).pricing).toEqual({
        ...PRICES,
        strong: STRONG_PRICES,
        fast: null,
      });
    });

    it('sends every pair of three models, and no price of a tier whose model was taken away', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.pricing).toEqual({
        ...PRICES,
        strong: STRONG_PRICES,
        fast: FAST_PRICES,
      });
      // The prices typed for a tier stay in their fields, but go only while it has a model.
      type(root, '#ai-fast-model', '');
      submit(root);
      await settle(fixture);
      expect((server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body as PutBody).pricing).toEqual({
        ...PRICES,
        strong: STRONG_PRICES,
        fast: null,
      });
    });

    it('sends no prices at all when none is given, whatever the models', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      for (const id of priceIds(root)) type(root, `#${id}`, '');
      submit(root);
      await settle(fixture);
      expect(sent(server)).toMatchObject({ pricing: null });
    });

    it('shows no price of a tier and sends none while the kind is None: the assistant switches off', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: { ...THREE_MODELS, provider: null } });
      const { fixture, root } = await render();
      expect(priceIds(root)).toHaveLength(6);
      type(root, '#ai-kind', '');
      await settle(fixture);
      // Without a provider no tier has a model, so none has prices of its own.
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toBeNull();
      expect(sent(server)?.pricing).toEqual({ ...PRICES, strong: null, fast: null });
      // Saved: no field refused, no alert.
      expect(root.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(root.querySelector('.field-error')).toBeNull();
      expect(root.querySelector('[role="alert"]')).toBeNull();
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'The AI assistant settings were saved.',
      );
    });

    it('shows no price of a tier before a kind is chosen, whatever models are typed', async () => {
      setup(EMPTY);
      const { fixture, root } = await render();
      type(root, '#ai-model', 'qwen2.5-coder');
      type(root, '#ai-strong-model', 'qwen3-max');
      type(root, '#ai-fast-model', 'qwen2.5-small');
      await settle(fixture);
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);
      type(root, '#ai-kind', 'openai');
      await settle(fixture);
      expect(priceIds(root)).toHaveLength(6);
    });

    it('brings the prices of a tier back, as they were typed, when a kind is chosen again', async () => {
      setup(THREE_MODELS);
      const { fixture, root } = await render();
      type(root, '#ai-kind', '');
      await settle(fixture);
      expect(priceIds(root)).toHaveLength(2);
      type(root, '#ai-kind', 'anthropic');
      await settle(fixture);
      expect(priceIds(root).map((id) => [id, field(root, id).value])).toEqual([
        ['ai-price-input', '0.3'],
        ['ai-price-output', '1.2'],
        ['ai-price-strong-input', '2'],
        ['ai-price-strong-output', '8'],
        ['ai-price-fast-input', '0.1'],
        ['ai-price-fast-output', '0.4'],
      ]);
    });

    it.each([
      ['strong', "Give the strong model's prices too"],
      ['fast', "Give the fast model's prices too"],
    ] as const)(
      'refuses prices given without those of the %s model, on its fields, and sends nothing',
      async (tier, text) => {
        const server = setup(THREE_MODELS);
        const { fixture, root } = await render();
        type(root, `#ai-price-${tier}-input`, '');
        type(root, `#ai-price-${tier}-output`, '');
        submit(root);
        await settle(fixture);
        expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
        for (const side of ['input', 'output']) {
          const id = `ai-price-${tier}-${side}`;
          expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
          expect(root.querySelector(`#${id}-error`)?.textContent).toContain(text);
          expect(field(root, id).getAttribute('aria-describedby')).toBe(`${id}-error`);
        }
        // The other tier's fields are fine, and so are the standard ones.
        const other = tier === 'strong' ? 'fast' : 'strong';
        expect(field(root, `ai-price-${other}-input`).getAttribute('aria-invalid')).toBeNull();
        expect(field(root, 'ai-price-input').getAttribute('aria-invalid')).toBeNull();
        expect(document.activeElement).toBe(field(root, `ai-price-${tier}-input`));
        // Typing a price takes that field's refusal back.
        type(root, `#ai-price-${tier}-input`, '1');
        await settle(fixture);
        expect(root.querySelector(`#ai-price-${tier}-input-error`)).toBeNull();
      },
    );

    it('refuses a price of a tier outside 0 to 10 000, in the same words', async () => {
      const server = setup(THREE_MODELS);
      const { fixture, root } = await render();
      type(root, '#ai-price-strong-output', '10001');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
      expect(root.querySelector('#ai-price-strong-output-error')?.textContent).toContain(
        'in US dollars per million tokens (0 to 10000)',
      );
    });

    it('asks for the standard prices when only a tier’s are typed', async () => {
      const server = setup({ ...THREE_MODELS, pricing: null });
      const { fixture, root } = await render();
      type(root, '#ai-price-strong-input', '2');
      type(root, '#ai-price-strong-output', '8');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
      // The prices of the model above are the pair the others need.
      expect(field(root, 'ai-price-input').getAttribute('aria-invalid')).toBe('true');
      expect(field(root, 'ai-price-output').getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector('#ai-price-input-error')?.textContent).toContain(
        'Give both prices',
      );
      expect(document.activeElement).toBe(field(root, 'ai-price-input'));
    });

    it.each([
      ['body.pricing.strong', 'ai-price-strong-input'],
      ['body.pricing.strong.inputUsdPerMTok', 'ai-price-strong-input'],
      ['body.pricing.strong.outputUsdPerMTok', 'ai-price-strong-output'],
      ['body.pricing.fast', 'ai-price-fast-input'],
      ['body.pricing.fast.inputUsdPerMTok', 'ai-price-fast-input'],
      ['body.pricing.fast.outputUsdPerMTok', 'ai-price-fast-output'],
      ['body.pricing.outputUsdPerMTok', 'ai-price-output'],
      ['body.pricing', 'ai-price-input'],
    ])('maps the server’s refusal at %s to %s', async (path, id) => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [{ path, message: 'server text' }]),
      });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
      // Only that field is marked.
      expect(
        priceIds(root).filter((other) => field(root, other).getAttribute('aria-invalid')),
      ).toEqual([id]);
      expect(root.textContent).not.toContain('server text');
    });
  });

  describe('the Test of several models', () => {
    const lines = (root: HTMLElement) =>
      [...root.querySelectorAll('#ai-test-models li')].map((li) => ({
        text: li.textContent?.trim(),
        tone: ['alert-success', 'alert-warn', 'alert-error'].find((c) => li.classList.contains(c)),
      }));
    const line = (
      tier: 'standard' | 'strong' | 'fast',
      model: string,
      over: Partial<TestAnswer['models'][number]> = {},
    ): TestAnswer['models'][number] => ({
      tier,
      model,
      ok: true,
      reportedModel: `reported-${model}`,
      latencyMs: 12,
      toolCalling: 'supported',
      problem: null,
      hint: null,
      ...over,
    });
    /** A Test answer of several models: its own fields are those of the first, the standard model. */
    const answer = (
      standard: TestAnswer['models'][number],
      ...others: TestAnswer['models']
    ): TestAnswer => ({
      ok: standard.ok,
      model: standard.reportedModel,
      latencyMs: standard.latencyMs,
      toolCalling: standard.toolCalling,
      problem: standard.problem,
      hint: standard.hint,
      models: [standard, ...others],
    });
    const pressTest = async (fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) => {
      [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
      await settle(fixture);
    };

    it('shows a line for each model, in the answer’s order, with the tool calling of each', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          line('standard', 'qwen2.5-coder', { latencyMs: 120 }),
          line('strong', 'qwen3-max', { latencyMs: 640, toolCalling: 'not_supported' }),
          line('fast', 'qwen2.5-small', { latencyMs: 35, toolCalling: 'not_checked' }),
        ),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root)).toEqual([
        {
          text: 'qwen2.5-coder: connected in 120 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: 'qwen3-max: connected in 640 ms · tool calling not supported',
          tone: 'alert-warn',
        },
        { text: 'qwen2.5-small: connected in 35 ms', tone: 'alert-success' },
      ]);
      // In the live region, a list of its own: not the single-model lines.
      expect(root.querySelector('[role="status"] ul#ai-test-models')).not.toBeNull();
      expect(root.querySelector('#ai-test-tools')).toBeNull();
      expect(root.querySelector('[role="status"] > .alert')).toBeNull();
      expect(root.textContent).not.toContain('Connected to');
      expect(root.querySelector('.alert-error')).toBeNull();
      // A tool check that did not pass, or could not tell, is not a failed Test: nothing is alerted.
      expect(root.querySelector('[role="alert"]')).toBeNull();
    });

    it('shows a model that failed as its problem in the page’s words, beside the lines of the others', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          line('standard', 'qwen2.5-coder'),
          line('strong', 'qwen3-max'),
          line('fast', 'qwen2.5-small', {
            ok: false,
            reportedModel: null,
            toolCalling: 'not_checked',
            problem: {
              code: 'PROVIDER_REJECTED_REQUEST',
              message: 'server text',
              providerStatus: 404,
            },
          }),
        ),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root)).toEqual([
        {
          text: 'qwen2.5-coder: connected in 12 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: 'qwen3-max: connected in 12 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: 'qwen2.5-small: The provider refused the request; check the base URL and the model.',
          tone: 'alert-error',
        },
      ]);
      expect(root.textContent).not.toContain('server text');
      // One alert outside the list says how many failed; the lines stay in the live region.
      const alerts = root.querySelectorAll('[role="alert"]');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.textContent?.trim()).toBe('The test failed for 1 of 3 models.');
      expect(alerts[0]?.classList).toContain('alert-error');
      expect(alerts[0]?.closest('[role="status"]')).toBeNull();
      expect(root.querySelector('[role="status"] #ai-test-models')).not.toBeNull();
    });

    it('tells a refused key apart by the provider status on the line of the model', async () => {
      const server = setup(THREE_MODELS);
      const refused = (status: number) =>
        line('strong', 'qwen3-max', {
          ok: false,
          reportedModel: null,
          toolCalling: 'not_checked',
          problem: { code: 'PROVIDER_REFUSED_KEY', message: 'server text', providerStatus: status },
        });
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(line('standard', 'qwen2.5-coder'), refused(403)),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root)[1]?.text).toBe(
        'qwen3-max: The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit.',
      );
    });

    it('shows every line as a problem when the key cannot be read', async () => {
      const server = setup(THREE_MODELS);
      const problemLine = (tier: 'standard' | 'strong' | 'fast', model: string) =>
        line(tier, model, {
          ok: false,
          reportedModel: null,
          latencyMs: 0,
          toolCalling: 'not_checked',
          problem: { code: 'KEY_UNDECRYPTABLE', message: 'server text', providerStatus: null },
        });
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          problemLine('standard', 'qwen2.5-coder'),
          problemLine('strong', 'qwen3-max'),
          problemLine('fast', 'qwen2.5-small'),
        ),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root).map((l) => l.tone)).toEqual(['alert-error', 'alert-error', 'alert-error']);
      expect(lines(root)[0]?.text).toBe(
        'qwen2.5-coder: The stored API key can no longer be read; set it again.',
      );
      expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'The test failed for 3 of 3 models.',
      );
    });

    it('forgets the summary of a failed Test with the lines when the page does anything else', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          line('standard', 'qwen2.5-coder'),
          line('strong', 'qwen3-max', {
            ok: false,
            reportedModel: null,
            toolCalling: 'not_checked',
            problem: { code: 'PROVIDER_TIMEOUT', message: 'server text', providerStatus: null },
          }),
        ),
      });
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'The test failed for 1 of 2 models.',
      );
      submit(root);
      await settle(fixture);
      expect(root.querySelector('[role="alert"]')).toBeNull();
      expect(root.querySelector('#ai-test-models')).toBeNull();
    });

    it('shows a Test of one model as it did before the tiers: no list', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(line('standard', 'qwen2.5-coder', { reportedModel: 'qwen2.5-coder' })),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('#ai-test-models')).toBeNull();
      expect(root.querySelector('[role="status"] .alert-success')?.textContent).toContain(
        'Connected to qwen2.5-coder in 12 ms.',
      );
      expect(root.querySelector('#ai-test-tools')?.textContent?.trim()).toBe(
        'Tool calling (needed by AI review): supported',
      );
    });

    it('forgets the lines when the page does anything else', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(line('standard', 'qwen2.5-coder'), line('strong', 'qwen3-max')),
      });
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelectorAll('#ai-test-models li')).toHaveLength(2);
      submit(root);
      await settle(fixture);
      expect(root.querySelector('#ai-test-models')).toBeNull();
      // A new Test replaces the lines of the last one.
      await pressTest(fixture, root);
      await pressTest(fixture, root);
      expect(root.querySelectorAll('#ai-test-models li')).toHaveLength(2);
    });
  });
});

describe('AiSettingsPage: the current Anthropic models (6I-4)', () => {
  /** A provider of kind Anthropic, as the server shows it: its temperature is always null. */
  const ANTHROPIC = {
    ...CONFIGURED,
    provider: {
      ...CONFIGURED.provider,
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5-5',
    },
  };
  const WORKSPACE = 'wrkspc_01AbCdEf';
  const field = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
  const rowOf = (root: HTMLElement, id: string) => field(root, id).closest('.setting-row');
  type PutBody = { provider: Record<string, unknown> };
  /** The body of the first save the page sent. */
  const sent = (server: FakeServer) =>
    server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as PutBody | undefined;
  /** Chooses a kind on the page, as the admin does. */
  const choose = async (
    fixture: { whenStable(): Promise<unknown> },
    root: HTMLElement,
    kind: string,
  ) => {
    type(root, '#ai-kind', kind);
    await settle(fixture);
  };

  describe('the workspace ID', () => {
    it('is a field of an Anthropic provider only, right after the API key, with its hint', async () => {
      setup();
      const { fixture, root } = await render();
      expect(root.querySelector('#ai-workspace-id')).toBeNull();
      await choose(fixture, root, 'openai');
      expect(root.querySelector('#ai-workspace-id')).toBeNull();
      await choose(fixture, root, 'anthropic');
      const input = field(root, 'ai-workspace-id');
      expect(root.querySelector('label[for="ai-workspace-id"]')?.textContent?.trim()).toBe(
        'Workspace ID',
      );
      expect(root.querySelector('#ai-workspace-id-hint')?.textContent?.trim()).toBe(
        'For an organisation-wide key that is not scoped to a workspace (wrkspc_…).',
      );
      // Not a secret: a plain text field of at most the 71 characters of an ID, and optional.
      expect([input.type, input.maxLength, input.value, input.required]).toEqual([
        'text',
        71,
        '',
        false,
      ]);
      expect(input.getAttribute('aria-describedby')).toBe('ai-workspace-id-hint');
      expect(input.getAttribute('aria-invalid')).toBeNull();
      expect(rowOf(root, 'ai-key')?.nextElementSibling).toBe(rowOf(root, 'ai-workspace-id'));
      // And gone again with another kind.
      await choose(fixture, root, 'openai');
      expect(root.querySelector('#ai-workspace-id')).toBeNull();
    });

    it('shows the stored workspace ID as it was entered', async () => {
      setup({ ...ANTHROPIC, provider: { ...ANTHROPIC.provider, workspaceId: WORKSPACE } });
      const { root } = await render();
      expect(field(root, 'ai-workspace-id').value).toBe(WORKSPACE);
    });

    it('sends it trimmed, and null when the field is empty', async () => {
      const server = setup(ANTHROPIC);
      server.on('PUT', '/api/v0/system/llm', { body: ANTHROPIC });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'anthropic', workspaceId: null });

      type(root, '#ai-workspace-id', `  ${WORKSPACE} `);
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body).toMatchObject({
        provider: { kind: 'anthropic', workspaceId: WORKSPACE },
      });
    });

    it('sends none for another kind, whatever was typed under Anthropic', async () => {
      const server = setup(ANTHROPIC);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-workspace-id', WORKSPACE);
      await choose(fixture, root, 'openai');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'openai' });
      expect(sent(server)?.provider).not.toHaveProperty('workspaceId');
    });

    it.each([
      ['without the prefix', '01AbCdEf'],
      ['the prefix alone', 'wrkspc_'],
      ['another prefix', 'workspace_01AbCd'],
      ['with a space in it', 'wrkspc_01 AbCd'],
      ['with a dash in it', 'wrkspc_01-AbCd'],
      ['over 64 characters after the prefix', `wrkspc_${'a'.repeat(65)}`],
    ])(
      'refuses one %s on its own field, in the page’s words, and sends nothing',
      async (_what, value) => {
        const server = setup(ANTHROPIC);
        const { fixture, root } = await render();
        type(root, '#ai-workspace-id', value);
        submit(root);
        await settle(fixture);
        expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
        const input = field(root, 'ai-workspace-id');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(root.querySelector('#ai-workspace-id-error')?.textContent).toContain(
          'Use the workspace ID as the console shows it: wrkspc_ and then letters and digits',
        );
        expect(input.getAttribute('aria-describedby')).toBe(
          'ai-workspace-id-error ai-workspace-id-hint',
        );
        expect(document.activeElement).toBe(input);
        // Typing again takes the refusal back.
        type(root, '#ai-workspace-id', WORKSPACE);
        await settle(fixture);
        expect(root.querySelector('#ai-workspace-id-error')).toBeNull();
        expect(input.getAttribute('aria-invalid')).toBeNull();
      },
    );

    it('maps the server’s refusal at body.provider.workspaceId to its field, in the page’s words', async () => {
      const server = setup(ANTHROPIC);
      server.on('PUT', '/api/v0/system/llm', {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [
          { path: 'body.provider.workspaceId', message: 'server text' },
        ]),
      });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(field(root, 'ai-workspace-id').getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector('#ai-workspace-id-error')?.textContent).toContain(
        'Use the workspace ID as the console shows it',
      );
      expect(root.textContent).not.toContain('server text');
      expect(root.querySelector('.alert-error')).toBeNull();
    });
  });

  describe('the Test of a key that is not scoped to a workspace', () => {
    const WORDS = 'This key is not scoped to a workspace: give its workspace ID below.';
    const refused = {
      code: 'PROVIDER_WORKSPACE_REQUIRED',
      message: 'server text',
      providerStatus: 400,
    } as const;
    const pressTest = async (fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) => {
      [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
      await settle(fixture);
    };

    it('is named in the page’s own words, and nothing of the server’s is shown', async () => {
      const server = setup(ANTHROPIC);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: false,
          model: null,
          latencyMs: 12,
          toolCalling: 'not_checked',
          problem: refused,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('.alert-error[role="alert"]')?.textContent).toContain(WORDS);
      expect(root.textContent).not.toContain('server text');
      // The field it points to is on the page, below this message.
      const alert = root.querySelector('.alert-error[role="alert"]')!;
      const field = root.querySelector('#ai-workspace-id')!;
      expect(alert.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('is the line of each model the key was refused for, in the page’s words', async () => {
      const server = setup({
        ...ANTHROPIC,
        provider: { ...ANTHROPIC.provider, strongModel: 'claude-opus-5-5' },
      });
      const line = (tier: 'standard' | 'strong', model: string) => ({
        tier,
        model,
        ok: false,
        reportedModel: null,
        latencyMs: 12,
        toolCalling: 'not_checked' as const,
        problem: refused,
        hint: null,
      });
      server.on('POST', '/api/v0/system/llm/test', {
        body: {
          ok: false,
          model: null,
          latencyMs: 12,
          toolCalling: 'not_checked',
          problem: refused,
          hint: null,
          models: [line('standard', 'claude-sonnet-5-5'), line('strong', 'claude-opus-5-5')],
        } satisfies TestAnswer,
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(
        [...root.querySelectorAll('#ai-test-models li')].map((li) => li.textContent?.trim()),
      ).toEqual([`claude-sonnet-5-5: ${WORDS}`, `claude-opus-5-5: ${WORDS}`]);
      expect(root.textContent).not.toContain('server text');
    });
  });

  describe('the temperature', () => {
    const HINT = "Anthropic's current models take no temperature: leave it empty.";

    it('is shown empty for an Anthropic provider, with the hint, and cannot be typed', async () => {
      setup(ANTHROPIC);
      const { root } = await render();
      const input = field(root, 'ai-temperature');
      expect(input.value).toBe('');
      expect(input.disabled).toBe(true);
      expect(root.querySelector('#ai-temperature-hint')?.textContent?.trim()).toBe(HINT);
      expect(input.getAttribute('aria-describedby')).toBe('ai-temperature-hint');
    });

    it('is a field of OpenAI-compatible providers up to 2, without the hint', async () => {
      setup({ ...CONFIGURED, provider: { ...CONFIGURED.provider, temperature: 0.7 } });
      const { root } = await render();
      const input = field(root, 'ai-temperature');
      expect([input.value, input.disabled, input.min, input.max]).toEqual(['0.7', false, '0', '2']);
      expect(root.querySelector('#ai-temperature-hint')).toBeNull();
    });

    it('shows the hint and empties the field when the kind changes to Anthropic, and brings the value back with OpenAI', async () => {
      setup({ ...CONFIGURED, provider: { ...CONFIGURED.provider, temperature: 0.7 } });
      const { fixture, root } = await render();
      await choose(fixture, root, 'anthropic');
      expect(field(root, 'ai-temperature').value).toBe('');
      expect(field(root, 'ai-temperature').disabled).toBe(true);
      expect(root.querySelector('#ai-temperature-hint')?.textContent?.trim()).toBe(HINT);
      await choose(fixture, root, 'openai');
      expect(field(root, 'ai-temperature').value).toBe('0.7');
      expect(root.querySelector('#ai-temperature-hint')).toBeNull();
    });

    it('sends none for an Anthropic provider, whatever was typed under another kind', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: ANTHROPIC });
      const { fixture, root } = await render();
      type(root, '#ai-temperature', '0.5');
      await choose(fixture, root, 'anthropic');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'anthropic', temperature: null });
    });

    it('sends the temperature of an OpenAI-compatible provider, and refuses one over 2 in the page’s words', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-temperature', '1.5');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'openai', temperature: 1.5 });

      type(root, '#ai-temperature', '2.5');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(1);
      expect(root.querySelector('#ai-temperature-error')?.textContent?.trim()).toBe(
        'Use a number from 0 to 2, or leave it empty.',
      );
    });
  });
});

describe('AiSettingsPage: the OpenAI Responses API (6I-4)', () => {
  const HINT_TEXT =
    'This model takes tools only through the Responses API: choose Responses below.';
  const field = (root: HTMLElement, id: string) => root.querySelector<HTMLSelectElement>(`#${id}`)!;
  type PutBody = { provider: Record<string, unknown> };
  /** The body of the first save the page sent. */
  const sent = (server: FakeServer) =>
    server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as PutBody | undefined;
  const responses = { ...CONFIGURED, provider: { ...CONFIGURED.provider, api: 'responses' } };
  const pressTest = async (fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) => {
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
    await settle(fixture);
  };

  describe('the API', () => {
    it('is a select of an OpenAI-compatible provider, with its two APIs and its hint', async () => {
      setup(CONFIGURED);
      const { root } = await render();
      const select = field(root, 'ai-api');
      expect(root.querySelector('label[for="ai-api"]')?.textContent?.trim()).toBe('API');
      expect(root.querySelector('#ai-api-hint')?.textContent?.trim()).toBe(
        'The newest OpenAI models take tools only through the Responses API.',
      );
      expect(select.getAttribute('aria-describedby')).toBe('ai-api-hint');
      expect([...select.options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
        ['chat_completions', 'Chat Completions'],
        ['responses', 'Responses'],
      ]);
      // Today's wire, unless it was chosen.
      expect(select.value).toBe('chat_completions');
    });

    it('is not a setting of an Anthropic provider, which has one API', async () => {
      setup({ ...CONFIGURED, provider: { ...CONFIGURED.provider, kind: 'anthropic' } });
      const { fixture, root } = await render();
      expect(root.querySelector('#ai-api')).toBeNull();
      type(root, '#ai-kind', 'openai');
      await settle(fixture);
      expect(root.querySelector('#ai-api')).not.toBeNull();
      type(root, '#ai-kind', 'anthropic');
      await settle(fixture);
      expect(root.querySelector('#ai-api')).toBeNull();
      expect(root.textContent).not.toContain('Chat Completions');
    });

    it('shows the stored API', async () => {
      setup(responses);
      const { root } = await render();
      expect(field(root, 'ai-api').value).toBe('responses');
    });

    it('reads a provider saved before it as Chat Completions', async () => {
      const old = Object.fromEntries(
        Object.entries(CONFIGURED.provider).filter(([name]) => name !== 'api'),
      );
      expect(old).not.toHaveProperty('api');
      setup({ ...CONFIGURED, provider: old });
      const { root } = await render();
      expect(field(root, 'ai-api').value).toBe('chat_completions');
    });

    it('sends the API that is chosen, for an OpenAI-compatible provider', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: responses });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'openai', api: 'chat_completions' });
      type(root, '#ai-api', 'responses');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body).toMatchObject({
        provider: { kind: 'openai', api: 'responses' },
      });
      // And back.
      type(root, '#ai-api', 'chat_completions');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[2]?.body).toMatchObject({
        provider: { api: 'chat_completions' },
      });
    });

    it('sends none for Anthropic, whatever was chosen under OpenAI', async () => {
      const server = setup(responses);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-kind', 'anthropic');
      await settle(fixture);
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'anthropic' });
      expect(sent(server)?.provider).not.toHaveProperty('api');
    });

    it('takes the output limit field away while the Responses API is chosen: its limit is always max_output_tokens', async () => {
      setup(CONFIGURED);
      const { fixture, root } = await render();
      expect(root.querySelector('#ai-max-tokens-field')).not.toBeNull();
      type(root, '#ai-api', 'responses');
      await settle(fixture);
      expect(root.querySelector('#ai-max-tokens-field')).toBeNull();
      expect(root.querySelector('#ai-max-tokens-field-hint')).toBeNull();
      // The key header and the JSON mode are still the settings of this API.
      expect(root.querySelector('#ai-auth')).not.toBeNull();
      expect(root.querySelector('#ai-json')).not.toBeNull();
      type(root, '#ai-api', 'chat_completions');
      await settle(fixture);
      expect(field(root, 'ai-max-tokens-field').value).toBe('max_tokens');
    });

    it('keeps the output limit field the admin set, and sends it, while another API is chosen', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-max-tokens-field', 'max_completion_tokens');
      type(root, '#ai-api', 'responses');
      await settle(fixture);
      // The field comes back as it was left.
      type(root, '#ai-api', 'chat_completions');
      await settle(fixture);
      expect(field(root, 'ai-max-tokens-field').value).toBe('max_completion_tokens');
      type(root, '#ai-api', 'responses');
      await settle(fixture);
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({
        api: 'responses',
        maxTokensField: 'max_completion_tokens',
      });
    });
  });

  describe('the Test suggests the Responses API', () => {
    const needsResponses = {
      code: 'USE_RESPONSES_API',
      message: 'server text',
    } as const;

    it('says so beside the tool calling of a model that refused tools through Chat Completions, in the page’s words', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'not_supported',
          problem: null,
          hint: needsResponses,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      const status = root.querySelector('[role="status"]')!;
      expect(status.querySelector('#ai-test-tools')?.textContent?.trim()).toBe(
        'Tool calling (needed by AI review): not supported',
      );
      const hint = status.querySelector('#ai-test-use-responses')!;
      expect(hint.textContent?.trim()).toBe(HINT_TEXT);
      expect(hint.classList).toContain('alert-warn');
      // The choice it names is on the page, below the message.
      expect(
        hint.compareDocumentPosition(field(root, 'ai-api')) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(root.textContent).not.toContain('server text');
      expect(root.querySelector('.alert-error')).toBeNull();
    });

    it('says nothing of it for a model that passed, or that was refused for another reason', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'not_supported',
          problem: null,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('#ai-test-tools')).not.toBeNull();
      expect(root.querySelector('#ai-test-use-responses')).toBeNull();
      expect(root.textContent).not.toContain(HINT_TEXT);
    });

    it('forgets the hint when the page does anything else', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'not_supported',
          problem: null,
          hint: needsResponses,
        }),
      });
      server.on('PUT', '/api/v0/system/llm', { body: responses });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('#ai-test-use-responses')).not.toBeNull();
      type(root, '#ai-api', 'responses');
      submit(root);
      await settle(fixture);
      expect(root.querySelector('#ai-test-use-responses')).toBeNull();
      expect(root.querySelector('#ai-test-tools')).toBeNull();
    });

    it('is said on the line of the model that needs it, in a Test of several models', async () => {
      const server = setup({
        ...CONFIGURED,
        provider: { ...CONFIGURED.provider, strongModel: 'qwen3-max' },
      });
      const line = (
        tier: 'standard' | 'strong',
        model: string,
        over: Partial<TestAnswer['models'][number]> = {},
      ): TestAnswer['models'][number] => ({
        tier,
        model,
        ok: true,
        reportedModel: `reported-${model}`,
        latencyMs: 12,
        toolCalling: 'supported',
        problem: null,
        hint: null,
        ...over,
      });
      const standard = line('standard', 'qwen2.5-coder');
      server.on('POST', '/api/v0/system/llm/test', {
        body: {
          ok: true,
          model: standard.reportedModel,
          latencyMs: 12,
          toolCalling: 'supported',
          problem: null,
          hint: null,
          models: [
            standard,
            line('strong', 'qwen3-max', { toolCalling: 'not_supported', hint: needsResponses }),
          ],
        } satisfies TestAnswer,
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      const lines = [...root.querySelectorAll('#ai-test-models li')].map((li) => ({
        text: li.textContent?.trim(),
        tone: ['alert-success', 'alert-warn', 'alert-error'].find((c) => li.classList.contains(c)),
      }));
      expect(lines).toEqual([
        {
          text: 'qwen2.5-coder: connected in 12 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: `qwen3-max: connected in 12 ms · tool calling not supported · ${HINT_TEXT}`,
          tone: 'alert-warn',
        },
      ]);
      expect(root.querySelector('#ai-test-use-responses')).toBeNull();
      expect(root.textContent).not.toContain('server text');
    });
  });
});
