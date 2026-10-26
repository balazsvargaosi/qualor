import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeServer, me, ORG_ID, page, provideFakeServer, settle } from './fake-server';
import type { ResponseBody } from '../app/api/types';
import { SessionStore } from '../app/auth/session';
import { AiSettingsPage } from '../app/settings/ai.page';

export const KEY = ['fake', 'ui', 'key', '0123456789'].join('-');
export const EMPTY = {
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
export const CONFIGURED = {
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

export const PROJECTS = [
  { id: 'p1', organizationId: ORG_ID, key: 'acme/payments', name: 'Payments' },
  { id: 'p2', organizationId: ORG_ID, key: 'acme/web', name: 'Web' },
  { id: 'p3', organizationId: 'other-org', key: 'other/api', name: 'Other API' },
];

/** The organisation's view of the assistant (`GET /organizations/{id}/ai`): today's use and budgets. */
export function orgAi(overrides: { enabled?: boolean; usage?: object; budgets?: object } = {}) {
  return {
    enabled: overrides.enabled ?? true,
    features: { explain: true, triage: true, fix: false },
    provider: { kind: 'openai', host: 'ollama:11434', model: 'qwen2.5-coder' },
    dataSent: ['rule', 'message', 'path', 'language', 'snippet'],
    usage: { explain: 0, triage: 0, fix: 0, tokens: 0, costUsd: null, ...overrides.usage },
    budgets: { ...EMPTY.budgets, ...overrides.budgets },
  };
}

export type TestAnswer = ResponseBody<'/api/v0/system/llm/test', 'post'>;

/**
 * The answer of a Test of one model: the answer's own fields are the standard model's, and
 * `models` holds the one line that repeats them. It has no hint unless one is given.
 */
export function testAnswer(
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

export function setup(settings: object = EMPTY, features: string[] = ['llm.auto-fix']): FakeServer {
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
export async function render() {
  const fixture = TestBed.createComponent(AiSettingsPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}
export function type(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
}
export function submit(root: HTMLElement): void {
  root.querySelector<HTMLFormElement>('form#ai-settings')!.dispatchEvent(new Event('submit'));
}
