import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  ADMIN_PASSWORD,
  bearer,
  createProject,
  createProjectToken,
  createTestContext,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import {
  anthropicAnswer,
  anthropicToolUse,
  createFakeLlm,
  openAiAnswer,
  openAiToolCalls,
  responsesAnswer,
  responsesReasoning,
  responsesToolCalls,
  type FakeLlm,
  type LlmReply,
  type LlmResponder,
  type RecordedLlmRequest,
} from '../../test/fake-llm';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { auditEvents, instanceSettings, llmRequests } from '../db/schema';
import {
  DEFAULT_LLM_SETTINGS,
  LLM_API_KEY_AAD,
  readLlmSettings,
  writeLlmSettings,
} from '../llm/settings';
import { parseInternalHosts } from '../scm/url';

/** The call the model makes to the echo tool of the tool-calling check. */
const ECHO_CALL = { id: 'call_1', name: 'echo', arguments: { text: 'ok' } };
const ECHO_PARAMETERS = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

describe('/system/llm (llm.md §3, §16)', () => {
  let ctx: TestContext;
  let fake: FakeLlm;
  let admin: Session;
  let orgAdmin: Session;
  let org: string;
  const provider = (over: Record<string, unknown> = {}) => ({
    kind: 'openai',
    baseUrl: fake.openAiBaseUrl,
    model: 'fake-model',
    apiKey: fake.apiKey,
    ...over,
  });
  const body = (over: Record<string, unknown> = {}) => ({
    provider: provider(),
    organizations: {
      [org]: {
        enabled: true,
        features: { explain: true, triage: true, fix: true },
        excludedProjectIds: [],
      },
    },
    excludePaths: [],
    budgets: {
      explainPerDay: 200,
      triagePerDay: 100,
      fixPerDay: 25,
      tokensPerDay: 1_000_000,
      costPerDayUsd: null,
      perUserPerHour: 30,
    },
    pricing: null,
    storePrompts: false,
    promptRetentionDays: 7,
    ...over,
  });
  const put = (payload: unknown, session = admin) =>
    ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/system/llm',
      headers: session.headers,
      payload: payload as object,
    });
  const get = (session = admin) =>
    ctx.app.inject({ method: 'GET', url: '/api/v0/system/llm', headers: session.headers });
  const test = (session = admin) =>
    ctx.app.inject({ method: 'POST', url: '/api/v0/system/llm/test', headers: session.headers });

  beforeAll(async () => {
    // A model of its own that takes at most 4 096 output tokens, as a Claude 3-era model does, and
    // one that takes function tools only through the Responses API, as the newest OpenAI models do.
    fake = await createFakeLlm({
      outputCaps: { 'capped-model': 4_096 },
      toolsOnlyThroughResponses: ['sol-model'],
      jsonNeedsWordInInput: true,
    });
    ctx = await createTestContext({
      config: { llmInternalHosts: parseInternalHosts(fake.host) },
    });
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    org = await organizationId(ctx, 'default');
    const u = await createUser(ctx, { username: 'llm-org-admin' });
    await addMember(ctx, org, u.id, 'admin');
    orgAdmin = await login(ctx, u.username, u.password);
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });
  beforeEach(() => {
    fake.requests.length = 0;
  });

  it('is off by default and for instance admins only (an org admin gets 403)', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: null });
    // D10: no edition ceiling on fix suggestions, so nothing tells the page one.
    expect(res.json()).not.toHaveProperty('maxFixPerDay');
    expect((await get(orgAdmin)).statusCode).toBe(403);
    expect((await put(body(), orgAdmin)).statusCode).toBe(403);
    expect((await test(orgAdmin)).statusCode).toBe(403);
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v0/system/llm' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('stores the key write-only and encrypted, and never logs or returns it', async () => {
    const res = await put(body());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().provider).toMatchObject({
      kind: 'openai',
      baseUrl: fake.openAiBaseUrl,
      apiKeySet: true,
      apiKeyReadable: true,
    });
    expect(res.json().provider).not.toHaveProperty('apiKey');
    expect(res.json().provider).not.toHaveProperty('apiKeyEnc');
    expect(res.body).not.toContain(fake.apiKey);
    expect((await get()).body).not.toContain(fake.apiKey);
    const [row] = await ctx.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, 'llm'));
    expect(JSON.stringify(row?.value)).not.toContain(fake.apiKey);
    expect(ctx.logs.join('\n')).not.toContain(fake.apiKey);
    const changed = ctx.logs.filter((l) => l.includes('LLM settings changed'));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.at(-1)).toContain('provider.apiKey');
  });

  it('keeps the key when apiKey is absent, and needs it again for a new address', async () => {
    const withoutKey: Record<string, unknown> = provider();
    delete withoutKey.apiKey;
    expect((await put(body({ provider: withoutKey }))).json().provider.apiKeySet).toBe(true);
    // The same address spelt with a trailing slash is not a new address.
    const slash = await put(
      body({ provider: { ...withoutKey, baseUrl: `${fake.openAiBaseUrl}/` } }),
    );
    expect(slash.statusCode, slash.body).toBe(200);
    const moved = await put(body({ provider: { ...withoutKey, baseUrl: `${fake.url}/other/v1` } }));
    expect(moved.statusCode).toBe(422);
    expect(moved.json().errors[0].path).toBe('body.provider.apiKey');
    expect((await get()).json().provider.baseUrl).toBe(fake.openAiBaseUrl);
    const movedWithKey = await put(
      body({ provider: provider({ baseUrl: `${fake.url}/other/v1` }) }),
    );
    expect(movedWithKey.json().provider).toMatchObject({
      baseUrl: `${fake.url}/other/v1`,
      apiKeySet: true,
    });
    expect(
      (await put(body({ provider: provider({ apiKey: null }) }))).json().provider.apiKeySet,
    ).toBe(false);
    const removed = await put(body({ provider: null }));
    expect(removed.json().provider).toBeNull();
    // A first provider needs the key (or null) too.
    expect((await put(body({ provider: withoutKey }))).statusCode).toBe(422);
    expect((await put(body())).statusCode).toBe(200);
  });

  it('stores the base URL without a trailing slash', async () => {
    const res = await put(body({ provider: provider({ baseUrl: `${fake.openAiBaseUrl}/` }) }));
    expect(res.json().provider.baseUrl).toBe(fake.openAiBaseUrl);
  });

  it('refuses a key that is not printable ASCII without spaces, never echoing it', async () => {
    for (const apiKey of ['has space-0123456789', 'ключ-0123456789', 'tab\tkey-0123456789', '']) {
      const res = await put(body({ provider: provider({ apiKey }) }));
      expect(res.statusCode).toBe(422);
      expect(res.json().errors.map((e: { path: string }) => e.path)).toContain(
        'body.provider.apiKey',
      );
      if (apiKey !== '') expect(res.body).not.toContain(apiKey);
    }
  });

  it.each([
    [
      { provider: { kind: 'openai', baseUrl: 'http://10.1.2.3/v1', model: 'm', apiKey: 'k' } },
      'body.provider.baseUrl',
    ],
    [
      {
        provider: {
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          model: 'bad model',
          apiKey: 'k',
        },
      },
      'body.provider.model',
    ],
    [
      {
        provider: {
          kind: 'anthropic',
          baseUrl: 'https://api.example.com',
          model: 'm',
          apiKey: 'k',
          temperature: 1.5,
        },
      },
      'body.provider.temperature',
    ],
    [
      {
        budgets: {
          explainPerDay: 1,
          triagePerDay: 1,
          fixPerDay: 100_001,
          tokensPerDay: 1,
          costPerDayUsd: null,
          perUserPerHour: 1,
        },
      },
      'body.budgets.fixPerDay',
    ],
    [
      {
        organizations: {
          '00000000-0000-7000-8000-000000000000': {
            enabled: true,
            features: { explain: true, triage: false, fix: false },
            excludedProjectIds: [],
          },
        },
      },
      'body.organizations.00000000-0000-7000-8000-000000000000',
    ],
    [{ excludePaths: ['/abs/**'] }, 'body.excludePaths.0'],
  ])('refuses %j at %s', async (over, path) => {
    const res = await put(body(over));
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.map((e: { path: string }) => e.path)).toContain(path);
  });

  it('community: fixPerDay up to 100 000 is accepted, and nothing above it (D10)', async () => {
    // This app runs the community edition: the admin's own budget is the only limit.
    const fix = (fixPerDay: number) => put(body({ budgets: { ...body().budgets, fixPerDay } }));
    for (const fixPerDay of [26, 500, 100_000]) {
      const res = await fix(fixPerDay);
      expect(res.statusCode, `${fixPerDay}: ${res.body}`).toBe(200);
      expect(res.json().budgets.fixPerDay).toBe(fixPerDay);
      expect((await get()).json().budgets.fixPerDay).toBe(fixPerDay);
    }
    const over = await fix(100_001);
    expect(over.statusCode).toBe(422);
    expect(over.json().errors.map((e: { path: string }) => e.path)).toContain(
      'body.budgets.fixPerDay',
    );
    // A refused save changes nothing.
    expect((await get()).json().budgets.fixPerDay).toBe(100_000);
    expect((await fix(25)).statusCode).toBe(200);
  });

  it('PUT /system/llm without the ceiling keeps it and with null clears it', async () => {
    const stored = async () =>
      (await get()).json().budgets.reviewTokensPerOrganizationPerDay as number | null;
    const withCeiling = (ceiling: number | null) =>
      body({ budgets: { ...body().budgets, reviewTokensPerOrganizationPerDay: ceiling } });
    expect(await stored()).toBeNull();

    const set = await put(withCeiling(750_000));
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().budgets.reviewTokensPerOrganizationPerDay).toBe(750_000);

    // A body that leaves it out (a form that does not know it) keeps the stored one, and applies
    // what else it says.
    const kept = await put(body({ budgets: { ...body().budgets, fixPerDay: 40 } }));
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().budgets).toMatchObject({
      fixPerDay: 40,
      reviewTokensPerOrganizationPerDay: 750_000,
    });
    expect(await stored()).toBe(750_000);
    // A save that changes no budget does not say the ceiling it kept changed.
    const lastChange = () => ctx.logs.filter((l) => l.includes('LLM settings changed')).at(-1);
    expect(lastChange()).toContain('"budgets"');
    const unchanged = await put(body({ budgets: { ...body().budgets, fixPerDay: 40 } }));
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(lastChange()).not.toContain('"budgets"');

    // A value changes it, and null clears it; left out again, it stays cleared.
    expect((await put(withCeiling(1_000))).json().budgets.reviewTokensPerOrganizationPerDay).toBe(
      1_000,
    );
    const cleared = await put(withCeiling(null));
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().budgets.reviewTokensPerOrganizationPerDay).toBeNull();
    expect(await stored()).toBeNull();
    expect((await put(body())).statusCode).toBe(200);
    expect(await stored()).toBeNull();

    // The bounds hold, and a refused save changes nothing.
    const unknown = await put(body({ budgets: { ...body().budgets, ceiling: 1 } }));
    expect(unknown.statusCode).toBe(422);
    await put(withCeiling(5));
    for (const bad of [-1, 1.5, 1_000_000_001, '5']) {
      const refused = await put(withCeiling(bad as number));
      expect(refused.statusCode, String(bad)).toBe(422);
      expect(refused.json().errors.map((e: { path: string }) => e.path)).toContain(
        'body.budgets.reviewTokensPerOrganizationPerDay',
      );
    }
    expect(await stored()).toBe(5);
    expect((await put(withCeiling(null))).statusCode).toBe(200);
  });

  describe('the temperature', () => {
    const anthropic = (over: Record<string, unknown> = {}) =>
      provider({
        kind: 'anthropic',
        baseUrl: fake.anthropicBaseUrl,
        model: 'claude-x',
        ...over,
      });
    const errorsOf = (res: { json: () => unknown }) =>
      (res.json() as { errors: { path: string; message: string }[] }).errors;

    it('takes an Anthropic provider without one, absent or null, and OpenAI up to 2', async () => {
      for (const over of [{}, { temperature: null }]) {
        const res = await put(body({ provider: anthropic(over) }));
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().provider).toMatchObject({ kind: 'anthropic', temperature: null });
      }
      for (const temperature of [0, 1.5, 2]) {
        const res = await put(body({ provider: provider({ temperature }) }));
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().provider.temperature).toBe(temperature);
      }
      const over = await put(body({ provider: provider({ temperature: 2.1 }) }));
      expect(over.statusCode).toBe(422);
      expect(errorsOf(over).map((e) => e.path)).toContain('body.provider.temperature');
      await put(body());
    });

    describe('an Anthropic provider refuses a temperature at save, and a stored one is not sent', () => {
      it('refuses one at its field, in the words of the rule, whatever it is', async () => {
        for (const temperature of [0, 0.5, 1, 1.5, 2]) {
          const res = await put(body({ provider: anthropic({ temperature }) }));
          expect(res.statusCode, String(temperature)).toBe(422);
          expect(errorsOf(res), String(temperature)).toEqual([
            {
              path: 'body.provider.temperature',
              message: "Anthropic's current models take no temperature: leave it empty",
            },
          ]);
        }
        // A refused save changes nothing.
        expect((await get()).json().provider.temperature).toBeNull();
      });

      it('shows one that older settings hold as empty, never sends it, and drops it at the next save', async () => {
        const keyEnc = encryptSecret(
          encryptionKey(ctx.config.secretKey),
          fake.apiKey,
          LLM_API_KEY_AAD,
        );
        const stored = await readLlmSettings(ctx.db);
        await writeLlmSettings(ctx.db, {
          ...stored,
          provider: {
            kind: 'anthropic',
            baseUrl: fake.anthropicBaseUrl,
            model: 'claude-x',
            strongModel: null,
            fastModel: null,
            auth: 'bearer',
            jsonMode: 'json_object',
            maxTokensField: 'max_tokens',
            temperature: 0.7,
            api: 'chat_completions',
            workspaceId: null,
            timeoutSeconds: 60,
            apiKeyEnc: keyEnc,
          },
        });
        try {
          // The page shows the field empty: the provider has none.
          const shown = await get();
          expect(shown.json().provider).toMatchObject({ kind: 'anthropic', temperature: null });
          // And no call carries it: the test is a call and a conversation.
          const tester = await createUser(ctx, {
            username: 'llm-old-temp',
            isInstanceAdmin: true,
          });
          const res = await test(await login(ctx, tester.username, tester.password));
          expect(res.json()).toMatchObject({ ok: true, problem: null });
          expect(fake.requests.length).toBeGreaterThan(0);
          for (const request of fake.requests) expect(request.body).not.toContain('temperature');
          // The next save, with the field as the page shows it, takes it out of the settings.
          const saved = await put(body({ provider: anthropic() }));
          expect(saved.statusCode, saved.body).toBe(200);
          expect((await readLlmSettings(ctx.db)).provider?.temperature).toBeNull();
        } finally {
          await put(body());
        }
      });
    });
  });

  describe('the workspace of an Anthropic provider', () => {
    const WORKSPACE = 'wrkspc_01AbCdEf';
    const anthropic = (over: Record<string, unknown> = {}) =>
      provider({ kind: 'anthropic', baseUrl: fake.anthropicBaseUrl, model: 'claude-x', ...over });
    const errorsOf = (res: { json: () => unknown }) =>
      (res.json() as { errors: { path: string; message: string }[] }).errors;
    afterEach(async () => {
      await put(body());
    });

    it('is stored as entered and shown as entered: it is not a secret', async () => {
      const res = await put(body({ provider: anthropic({ workspaceId: WORKSPACE }) }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().provider.workspaceId).toBe(WORKSPACE);
      expect((await get()).json().provider.workspaceId).toBe(WORKSPACE);
      expect((await readLlmSettings(ctx.db)).provider?.workspaceId).toBe(WORKSPACE);
      // Left out, null, or the field emptied by a form: no workspace.
      for (const over of [{}, { workspaceId: null }]) {
        const none = await put(body({ provider: anthropic(over) }));
        expect(none.statusCode, none.body).toBe(200);
        expect(none.json().provider.workspaceId).toBeNull();
      }
    });

    it('is no part of an OpenAI provider: whatever the form sent, it is stored as null', async () => {
      const res = await put(body({ provider: provider({ workspaceId: WORKSPACE }) }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().provider).toMatchObject({ kind: 'openai', workspaceId: null });
      expect((await readLlmSettings(ctx.db)).provider?.workspaceId).toBeNull();
    });

    it.each([
      ['empty', ''],
      ['the prefix alone', 'wrkspc_'],
      ['another prefix', 'workspace_01AbCd'],
      ['a space in it', 'wrkspc_01 AbCd'],
      ['over 64 characters after the prefix', `wrkspc_${'a'.repeat(65)}`],
      ['not text', 7],
    ])('refuses one that is %s, at its field', async (_what, workspaceId) => {
      const res = await put(body({ provider: anthropic({ workspaceId }) }));
      expect(res.statusCode, res.body).toBe(422);
      expect(errorsOf(res).map((e) => e.path)).toEqual(['body.provider.workspaceId']);
      expect(res.body).not.toContain(fake.apiKey);
      expect((await get()).json().provider.workspaceId).toBeNull();
    });

    it('names a change of it in the log line, never its value', async () => {
      await put(body({ provider: anthropic() }));
      expect(
        (await put(body({ provider: anthropic({ workspaceId: WORKSPACE }) }))).statusCode,
      ).toBe(200);
      const line = ctx.logs.filter((l) => l.includes('LLM settings changed')).at(-1)!;
      expect(line).toContain('"provider.workspaceId"');
      expect(line).not.toContain(WORKSPACE);
    });

    it('the Test names a key that is not scoped to a workspace, and sends the workspace in every request once it is given', async () => {
      // The provider answers 400 in its own words (an organisation-wide key without a workspace).
      await put(body({ provider: anthropic() }));
      const tester = await createUser(ctx, { username: 'llm-workspace-1', isInstanceAdmin: true });
      const session = await login(ctx, tester.username, tester.password);
      fake.enqueue({
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'Fake error text: this API key is not scoped to a workspace; name one with the anthropic-workspace-id header.',
          },
        },
      });
      const refused = await test(session);
      expect(refused.statusCode, refused.body).toBe(200);
      const hint =
        'This key is not scoped to a workspace: give its workspace ID in the AI assistant settings.';
      expect(refused.json()).toMatchObject({
        ok: false,
        problem: { code: 'PROVIDER_WORKSPACE_REQUIRED', message: hint, providerStatus: 400 },
        toolCalling: 'not_checked',
        models: [{ tier: 'standard', ok: false, problem: { message: hint } }],
      });
      // Never the provider's words, its header or the key.
      expect(refused.body).not.toContain('Fake error text');
      expect(refused.body).not.toContain(fake.apiKey);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.headers).not.toHaveProperty('anthropic-workspace-id');

      // With the workspace given, the plain call and the tool-calling check both name it.
      fake.requests.length = 0;
      await put(body({ provider: anthropic({ workspaceId: WORKSPACE }) }));
      const other = await createUser(ctx, { username: 'llm-workspace-2', isInstanceAdmin: true });
      const named = await test(await login(ctx, other.username, other.password));
      expect(named.json()).toMatchObject({ ok: true, problem: null });
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests.map((r) => r.headers['anthropic-workspace-id'])).toEqual([
        WORKSPACE,
        WORKSPACE,
      ]);
      expect(named.body).not.toContain(fake.apiKey);
    });
  });

  describe('the API of an OpenAI provider', () => {
    const errorsOf = (res: { json: () => unknown }) =>
      (res.json() as { errors: { path: string; message: string }[] }).errors;
    const anthropic = (over: Record<string, unknown> = {}) =>
      provider({ kind: 'anthropic', baseUrl: fake.anthropicBaseUrl, model: 'claude-x', ...over });
    afterEach(async () => {
      await put(body());
    });

    it('is stored as sent and shown as stored, and is Chat Completions when it is left out', async () => {
      const res = await put(body({ provider: provider({ api: 'responses' }) }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().provider).toMatchObject({ kind: 'openai', api: 'responses' });
      expect((await get()).json().provider.api).toBe('responses');
      expect((await readLlmSettings(ctx.db)).provider?.api).toBe('responses');
      // Left out (a client that does not know it), and the choice made explicitly: today's wire.
      for (const over of [{}, { api: 'chat_completions' }]) {
        const back = await put(body({ provider: provider(over) }));
        expect(back.statusCode, back.body).toBe(200);
        expect(back.json().provider.api).toBe('chat_completions');
      }
      expect((await readLlmSettings(ctx.db)).provider?.api).toBe('chat_completions');
    });

    it('is no part of an Anthropic provider: whatever the form sent, it is stored as chat_completions', async () => {
      const res = await put(body({ provider: anthropic({ api: 'responses' }) }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().provider).toMatchObject({ kind: 'anthropic', api: 'chat_completions' });
      expect((await readLlmSettings(ctx.db)).provider?.api).toBe('chat_completions');
    });

    it.each([
      ['an API that does not exist', 'completions'],
      ['the endpoint', '/v1/responses'],
      ['another case', 'Responses'],
      ['empty', ''],
      ['null', null],
      ['not text', 7],
    ])('refuses %s, at its field', async (_what, api) => {
      const res = await put(body({ provider: provider({ api }) }));
      expect(res.statusCode, res.body).toBe(422);
      expect(errorsOf(res).map((e) => e.path)).toEqual(['body.provider.api']);
      expect((await get()).json().provider.api).toBe('chat_completions');
    });

    it('names a change of it in the log line', async () => {
      await put(body());
      expect((await put(body({ provider: provider({ api: 'responses' }) }))).statusCode).toBe(200);
      const line = ctx.logs.filter((l) => l.includes('LLM settings changed')).at(-1)!;
      expect(line).toContain('"provider.api"');
      expect(line).not.toContain('"provider.model"');
    });

    describe('the Test', () => {
      // The Test button is limited to ten presses a minute per admin: each case has an admin of its own.
      let testers = 0;
      let checker: Session;
      beforeEach(async () => {
        testers += 1;
        const u = await createUser(ctx, {
          username: `llm-api-check-${testers}`,
          isInstanceAdmin: true,
        });
        checker = await login(ctx, u.username, u.password);
      });
      const check = () => test(checker);
      const HINT = {
        code: 'USE_RESPONSES_API',
        message:
          'This model takes tools only through the Responses API: choose Responses in the AI assistant settings.',
      };
      const line = (tier: string, model: string, over: Record<string, unknown> = {}) => ({
        tier,
        model,
        ok: true,
        latencyMs: expect.any(Number),
        toolCalling: 'supported',
        problem: null,
        hint: null,
        ...over,
      });

      it('asks through the API that is chosen: the plain call and the tool check both go to /responses', async () => {
        await put(body({ provider: provider({ api: 'responses' }) }));
        fake.enqueue(
          { status: 200, body: responsesAnswer('{"ok": true}') },
          {
            status: 200,
            body: responsesToolCalls([ECHO_CALL], { reasoning: [responsesReasoning('enc-test')] }),
          },
        );
        const res = await check();
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({
          ok: true,
          model: 'fake-openai-model',
          problem: null,
          toolCalling: 'supported',
          hint: null,
        });
        expect(fake.requests.map((r) => r.path)).toEqual(['/v1/responses', '/v1/responses']);
        const [plain, tools] = fake.requests.map((r) => r.json);
        // 256 tokens for the answer and the 4 000 of room, in the field of this API, and nothing
        // kept at the provider.
        expect(plain).toEqual({
          model: 'fake-model',
          instructions: 'Answer with the JSON object {"ok": true} and nothing else.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply in JSON.' }] }],
          max_output_tokens: 4_256,
          store: false,
          include: ['reasoning.encrypted_content'],
          text: { format: { type: 'json_object' } },
        });
        expect(tools).toEqual({
          model: 'fake-model',
          instructions: expect.stringContaining('echo'),
          input: [{ role: 'user', content: [{ type: 'input_text', text: expect.any(String) }] }],
          max_output_tokens: 4_256,
          store: false,
          include: ['reasoning.encrypted_content'],
          tools: [
            {
              type: 'function',
              name: 'echo',
              description: expect.any(String),
              parameters: ECHO_PARAMETERS,
              strict: false,
            },
          ],
          tool_choice: 'auto',
        });
        expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
        expect(res.body).not.toContain(fake.apiKey);
      });

      it('the Test suggests the Responses API when Chat Completions refuses tools for the model', async () => {
        await put(body({ provider: provider({ model: 'sol-model' }) }));
        const res = await check();
        expect(res.statusCode, res.body).toBe(200);
        // The model answered the plain test, and refused the tools in words that name the Responses
        // API: the Test says what to choose, in its own fixed words and not the provider's.
        const needs = { toolCalling: 'not_supported', hint: HINT };
        expect(res.json()).toMatchObject({
          ok: true,
          problem: null,
          ...needs,
          models: [line('standard', 'sol-model', needs)],
        });
        expect(fake.requests.map((r) => r.path)).toEqual([
          '/v1/chat/completions',
          '/v1/chat/completions',
        ]);
        expect(res.body).not.toMatch(/reasoning_effort|chat\/completions/);
        expect(res.body).not.toContain(fake.apiKey);

        // Once Responses is chosen, the same model passes: nothing to suggest.
        await put(body({ provider: provider({ model: 'sol-model', api: 'responses' }) }));
        fake.requests.length = 0;
        fake.enqueue(
          { status: 200, body: responsesAnswer('{"ok": true}') },
          { status: 200, body: responsesToolCalls([ECHO_CALL]) },
        );
        const other = await createUser(ctx, { username: 'llm-api-sol', isInstanceAdmin: true });
        const chosen = await test(await login(ctx, other.username, other.password));
        expect(chosen.json()).toMatchObject({ ok: true, toolCalling: 'supported', hint: null });
        expect(fake.requests.map((r) => r.path)).toEqual(['/v1/responses', '/v1/responses']);
      });

      it('says it on the line of the model that needs it, and the answer’s own fields are the standard model’s', async () => {
        // The standard model answers both calls; the strong one is refused the tools, so that its
        // tool check takes no reply: three of the four calls are served.
        const provides: LlmResponder = (request) => ({
          status: 200,
          body:
            (request.json as { tools?: unknown }).tools === undefined
              ? openAiAnswer('{"ok": true}')
              : openAiToolCalls([ECHO_CALL]),
        });
        fake.enqueue(provides, provides, provides);
        await put(body({ provider: provider({ strongModel: 'sol-model' }) }));
        const withStrong = (await check()).json();
        expect(withStrong).toMatchObject({ ok: true, toolCalling: 'supported', hint: null });
        expect(withStrong.models).toEqual([
          expect.objectContaining(line('standard', 'fake-model')),
          expect.objectContaining(
            line('strong', 'sol-model', { toolCalling: 'not_supported', hint: HINT }),
          ),
        ]);
        // As the standard model, it is the answer's own hint too.
        const other = await createUser(ctx, { username: 'llm-api-sol-2', isInstanceAdmin: true });
        fake.enqueue(provides, provides, provides);
        await put(body({ provider: provider({ model: 'sol-model', fastModel: 'fake-model' }) }));
        const standard = (await test(await login(ctx, other.username, other.password))).json();
        expect(standard).toMatchObject({ toolCalling: 'not_supported', hint: HINT });
        expect(standard.models.map((m: { hint: unknown }) => m.hint)).toEqual([HINT, null]);
      });

      it('has nothing to suggest for another refusal of tools, or when the model could not be reached', async () => {
        const reply = (message: string) => ({
          status: 400,
          body: { error: { message, type: 'invalid_request_error', param: null, code: null } },
        });
        fake.enqueue(
          { status: 200, body: openAiAnswer('{"ok": true}') },
          reply('This model does not support tools'),
        );
        expect((await check()).json()).toMatchObject({
          ok: true,
          toolCalling: 'not_supported',
          hint: null,
        });
        const other = await createUser(ctx, { username: 'llm-api-down', isInstanceAdmin: true });
        fake.enqueue({ status: 401, body: { error: { message: 'bad key' } } });
        expect((await test(await login(ctx, other.username, other.password))).json()).toMatchObject(
          {
            ok: false,
            toolCalling: 'not_checked',
            hint: null,
          },
        );
      });
    });
  });

  describe('the models of the tiers', () => {
    const STANDARD = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
    const STRONG = { inputUsdPerMTok: 15, outputUsdPerMTok: 75 };
    const FAST = { inputUsdPerMTok: 1, outputUsdPerMTok: 5 };
    const tiers = { strongModel: 'fake-strong', fastModel: 'fake-fast' };
    const errorsOf = (res: { json: () => unknown }) =>
      (res.json() as { errors: { path: string; message: string }[] }).errors;
    /** The log line of the latest save: the names of the fields it changed. */
    const loggedChange = () =>
      ctx.logs.filter((l) => l.includes('LLM settings changed')).at(-1) ?? '';

    afterEach(async () => {
      await put(body());
    });

    it('PUT /system/llm stores the strong and fast models and answers them', async () => {
      const res = await put(body({ provider: provider(tiers) }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().provider).toMatchObject({ model: 'fake-model', ...tiers });
      expect((await get()).json().provider).toMatchObject({ model: 'fake-model', ...tiers });
      expect((await readLlmSettings(ctx.db)).provider).toMatchObject({
        model: 'fake-model',
        ...tiers,
      });
      // Each is optional. A save replaces the provider whole: one left out is none, and so is null.
      const strongOnly = await put(body({ provider: provider({ strongModel: 'fake-strong' }) }));
      expect(strongOnly.json().provider).toMatchObject({
        strongModel: 'fake-strong',
        fastModel: null,
      });
      const fastOnly = await put(
        body({ provider: provider({ strongModel: null, fastModel: 'fake-fast' }) }),
      );
      expect(fastOnly.json().provider).toMatchObject({ strongModel: null, fastModel: 'fake-fast' });
      const none = await put(body());
      expect(none.json().provider).toMatchObject({ strongModel: null, fastModel: null });
      expect((await readLlmSettings(ctx.db)).provider).toMatchObject({
        strongModel: null,
        fastModel: null,
      });
    });

    it('stores a tier model that is the standard model as it was given', async () => {
      const res = await put(body({ provider: provider({ strongModel: 'fake-model' }) }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().provider).toMatchObject({
        model: 'fake-model',
        strongModel: 'fake-model',
        fastModel: null,
      });
    });

    it.each([
      ['strongModel', 'empty', ''],
      ['strongModel', 'not a model name', 'bad model'],
      ['strongModel', 'over 200 characters', 'm'.repeat(201)],
      ['fastModel', 'empty', ''],
      ['fastModel', 'not a model name', 'bad model'],
      ['fastModel', 'over 200 characters', 'm'.repeat(201)],
      ['fastModel', 'not text', 7],
    ])('refuses a %s that is %s', async (field, _what, value) => {
      const res = await put(body({ provider: provider({ [field]: value }) }));
      expect(res.statusCode, res.body).toBe(422);
      expect(errorsOf(res).map((e) => e.path)).toContain(`body.provider.${field}`);
      expect(res.body).not.toContain(fake.apiKey);
    });

    it('names a change of a tier model in the log line', async () => {
      await put(body());
      const fast = await put(body({ provider: provider({ fastModel: 'fake-fast' }) }));
      expect(fast.statusCode, fast.body).toBe(200);
      expect(loggedChange()).toContain('"provider.fastModel"');
      expect(loggedChange()).not.toContain('"provider.strongModel"');
      expect(loggedChange()).not.toContain('"provider.model"');
      const strong = await put(body({ provider: provider(tiers) }));
      expect(strong.statusCode, strong.body).toBe(200);
      expect(loggedChange()).toContain('"provider.strongModel"');
      expect(loggedChange()).not.toContain('"provider.fastModel"');
      // The same save again changes nothing (but for the key it sends again), and clearing a model
      // changes the provider.
      expect((await put(body({ provider: provider(tiers) }))).statusCode).toBe(200);
      expect(loggedChange()).toContain('"fields":["provider.apiKey"]');
      const cleared = await put(body({ provider: provider({ strongModel: 'fake-strong' }) }));
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(loggedChange()).toContain('"provider.fastModel"');
    });

    it('a tier model with pricing but without its prices is a 422 at pricing.strong', async () => {
      const strong = await put(
        body({ provider: provider({ strongModel: 'fake-strong' }), pricing: STANDARD }),
      );
      expect(strong.statusCode, strong.body).toBe(422);
      expect(errorsOf(strong)).toEqual([
        { path: 'body.pricing.strong', message: "Give the strong model's prices too" },
      ]);
      const fast = await put(
        body({ provider: provider({ fastModel: 'fake-fast' }), pricing: STANDARD }),
      );
      expect(fast.statusCode, fast.body).toBe(422);
      expect(errorsOf(fast)).toEqual([
        { path: 'body.pricing.fast', message: "Give the fast model's prices too" },
      ]);
      const both = await put(body({ provider: provider(tiers), pricing: STANDARD }));
      expect(both.statusCode, both.body).toBe(422);
      expect(errorsOf(both)).toEqual([
        { path: 'body.pricing.strong', message: "Give the strong model's prices too" },
        { path: 'body.pricing.fast', message: "Give the fast model's prices too" },
      ]);
      // A refused save changes nothing.
      expect((await get()).json()).toMatchObject({
        provider: { strongModel: null, fastModel: null },
        pricing: null,
      });
      // With its prices, a tier model is saved: each tier needs its own pair.
      const strongPriced = await put(
        body({
          provider: provider(tiers),
          pricing: { ...STANDARD, strong: STRONG },
        }),
      );
      expect(strongPriced.statusCode).toBe(422);
      expect(errorsOf(strongPriced).map((e) => e.path)).toEqual(['body.pricing.fast']);
      const saved = await put(
        body({ provider: provider(tiers), pricing: { ...STANDARD, strong: STRONG, fast: FAST } }),
      );
      expect(saved.statusCode, saved.body).toBe(200);
    });

    it('needs no prices of a tier model while the instance sets no prices', async () => {
      const res = await put(body({ provider: provider(tiers), pricing: null }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ provider: tiers, pricing: null });
    });

    it('a tier model that is the standard model has no prices of its own to give', async () => {
      const res = await put(
        body({ provider: provider({ strongModel: 'fake-model' }), pricing: STANDARD }),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().pricing).toEqual({ ...STANDARD, strong: null, fast: null });
    });

    it('a price pair for a tier without a model of its own is a 422', async () => {
      const strong = await put(body({ pricing: { ...STANDARD, strong: STRONG } }));
      expect(strong.statusCode, strong.body).toBe(422);
      expect(errorsOf(strong)).toEqual([
        { path: 'body.pricing.strong', message: 'Set the strong model first' },
      ]);
      const fast = await put(body({ pricing: { ...STANDARD, fast: FAST } }));
      expect(errorsOf(fast)).toEqual([
        { path: 'body.pricing.fast', message: 'Set the fast model first' },
      ]);
      // A tier model that is the standard model is no model of its own.
      const same = await put(
        body({
          provider: provider({ strongModel: 'fake-model' }),
          pricing: { ...STANDARD, strong: STRONG },
        }),
      );
      expect(same.statusCode, same.body).toBe(422);
      expect(errorsOf(same)).toEqual([
        { path: 'body.pricing.strong', message: 'Set the strong model first' },
      ]);
      // Without a provider no tier has a model.
      const removed = await put(
        body({ provider: null, pricing: { ...STANDARD, strong: STRONG, fast: FAST } }),
      );
      expect(errorsOf(removed).map((e) => e.message)).toEqual([
        'Set the strong model first',
        'Set the fast model first',
      ]);
      // Only the tier without a model is refused.
      const mixed = await put(
        body({
          provider: provider({ strongModel: 'fake-strong' }),
          pricing: { ...STANDARD, strong: STRONG, fast: FAST },
        }),
      );
      expect(errorsOf(mixed)).toEqual([
        { path: 'body.pricing.fast', message: 'Set the fast model first' },
      ]);
    });

    it.each([
      ['a negative price', { inputUsdPerMTok: -1, outputUsdPerMTok: 5 }, 'inputUsdPerMTok'],
      ['a price over 10 000', { inputUsdPerMTok: 1, outputUsdPerMTok: 10_001 }, 'outputUsdPerMTok'],
      ['no output price', { inputUsdPerMTok: 1 }, 'outputUsdPerMTok'],
      ['a field of its own', { inputUsdPerMTok: 1, outputUsdPerMTok: 5, extra: 1 }, ''],
    ])('refuses a tier price with %s', async (_name, pair, field) => {
      const path = field === '' ? 'body.pricing.strong' : `body.pricing.strong.${field}`;
      const res = await put(
        body({ provider: provider(tiers), pricing: { ...STANDARD, strong: pair, fast: FAST } }),
      );
      expect(res.statusCode, res.body).toBe(422);
      expect(errorsOf(res).map((e) => e.path)).toContain(path);
    });

    it('stores the tier prices and answers them; a pair left out is none', async () => {
      const pricing = { ...STANDARD, strong: STRONG, fast: FAST };
      const set = await put(body({ provider: provider(tiers), pricing }));
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().pricing).toEqual(pricing);
      expect((await get()).json().pricing).toEqual(pricing);
      expect((await readLlmSettings(ctx.db)).pricing).toEqual(pricing);
      // A save replaces the prices whole: a pair left out is none.
      const left = await put(
        body({
          provider: provider({ strongModel: 'fake-strong' }),
          pricing: { ...STANDARD, strong: STRONG },
        }),
      );
      expect(left.json().pricing).toEqual({ ...STANDARD, strong: STRONG, fast: null });
      const plain = await put(body({ pricing: STANDARD }));
      expect(plain.json().pricing).toEqual({ ...STANDARD, strong: null, fast: null });
      // A null pair is the same as none.
      const nulls = await put(body({ pricing: { ...STANDARD, strong: null, fast: null } }));
      expect(nulls.json().pricing).toEqual({ ...STANDARD, strong: null, fast: null });
    });

    it('names a change of a tier price as a change of the pricing', async () => {
      const pricing = { ...STANDARD, strong: STRONG, fast: FAST };
      await put(body({ provider: provider(tiers), pricing }));
      const dearer = { ...pricing, strong: { ...STRONG, outputUsdPerMTok: 80 } };
      expect((await put(body({ provider: provider(tiers), pricing: dearer }))).statusCode).toBe(
        200,
      );
      expect(loggedChange()).toContain('"pricing"');
      expect((await put(body({ provider: provider(tiers), pricing: dearer }))).statusCode).toBe(
        200,
      );
      expect(loggedChange()).toContain('"fields":["provider.apiKey"]');
    });

    it('an instance whose settings were stored before the tiers keeps its provider and prices', async () => {
      await put(body({ pricing: STANDARD }));
      // The row as it was written before the tiers: no tier model, and no tier prices.
      const [row] = await ctx.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, 'llm'));
      const old = JSON.parse(JSON.stringify(row!.value)) as {
        provider: Record<string, unknown>;
        pricing: Record<string, unknown>;
      };
      delete old.provider.strongModel;
      delete old.provider.fastModel;
      delete old.pricing.strong;
      delete old.pricing.fast;
      expect(Object.keys(old.provider)).not.toContain('fastModel');
      await ctx.db
        .update(instanceSettings)
        .set({ value: old })
        .where(eq(instanceSettings.key, 'llm'));

      const read = await get();
      expect(read.statusCode, read.body).toBe(200);
      // The provider is still configured: the row parsed.
      expect(read.json().provider).toMatchObject({
        model: 'fake-model',
        strongModel: null,
        fastModel: null,
        apiKeySet: true,
      });
      expect(read.json().pricing).toEqual({ ...STANDARD, strong: null, fast: null });
      // And it still saves, with the tiers set.
      const saved = await put(
        body({
          provider: provider(tiers),
          pricing: { ...STANDARD, strong: STRONG, fast: FAST },
        }),
      );
      expect(saved.statusCode, saved.body).toBe(200);
    });
  });

  it('refuses excluded projects of another organisation, and keeps its own', async () => {
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/organizations',
      headers: admin.headers,
      payload: { key: 'llm-other', name: 'Other' },
    });
    expect(other.statusCode, other.body).toBe(201);
    const otherId = other.json().id as string;
    const foreign = await createProject(ctx, admin, {
      organizationId: otherId,
      key: 'llm-foreign',
    });
    const own = await createProject(ctx, admin, { organizationId: org, key: 'llm-own' });
    const res = await put(
      body({
        organizations: {
          [org]: {
            enabled: true,
            features: { explain: true, triage: false, fix: false },
            excludedProjectIds: [own.id, foreign.id],
          },
        },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.map((e: { path: string }) => e.path)).toEqual([
      `body.organizations.${org}.excludedProjectIds.1`,
    ]);
    const ok = await put(
      body({
        organizations: {
          [org]: {
            enabled: true,
            features: { explain: true, triage: false, fix: false },
            excludedProjectIds: [own.id],
          },
          [otherId]: {
            enabled: false,
            features: { explain: false, triage: false, fix: false },
            excludedProjectIds: [foreign.id],
          },
        },
      }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().organizations[org].excludedProjectIds).toEqual([own.id]);
    expect(ok.json().organizations[otherId].enabled).toBe(false);
  });

  it('drops an excluded project that was deleted: GET leaves it out and a save is 200', async () => {
    const gone = await createProject(ctx, admin, { organizationId: org, key: 'llm-gone' });
    const kept = await createProject(ctx, admin, { organizationId: org, key: 'llm-kept' });
    const settings = body({
      organizations: {
        [org]: {
          enabled: true,
          features: { explain: true, triage: false, fix: false },
          excludedProjectIds: [gone.id, kept.id],
        },
      },
    });
    const saved = await put(settings);
    expect(saved.statusCode, saved.body).toBe(200);
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v0/projects/${gone.id}?confirm=llm-gone`,
      headers: admin.headers,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect((await get()).json().organizations[org].excludedProjectIds).toEqual([kept.id]);
    // The settings page saves back what it last read, the deleted id included.
    const again = await put(settings);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().organizations[org].excludedProjectIds).toEqual([kept.id]);
    const [row] = await ctx.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, 'llm'));
    expect(JSON.stringify(row?.value)).not.toContain(gone.id);
  });

  it('tests the saved provider with a fixed prompt that holds no repository data', async () => {
    await put(body());
    fake.enqueue(
      { status: 200, body: openAiAnswer('{"ok": true}') },
      { status: 200, body: openAiToolCalls([ECHO_CALL]) },
    );
    const res = await test();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      model: 'fake-openai-model',
      problem: null,
      toolCalling: 'supported',
    });
    // The plain test, then the tool-calling check.
    expect(fake.requests).toHaveLength(2);
    const sent = fake.requests[0]!;
    expect(sent.body).not.toMatch(/QUALOR-DATA/);
    expect(sent.json).toEqual({
      model: 'fake-model',
      messages: [
        {
          role: 'system',
          content: 'Answer with the JSON object {"ok": true} and nothing else.',
        },
        { role: 'user', content: 'Reply in JSON.' },
      ],
      // 256 tokens for the answer and the 4 000 of room for a model that thinks before it.
      max_tokens: 4_256,
      response_format: { type: 'json_object' },
    });
    expect(sent.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
    expect(res.body).not.toContain(fake.apiKey);
  });

  it('tests an Anthropic provider through its adapter', async () => {
    await put(
      body({
        provider: {
          kind: 'anthropic',
          baseUrl: fake.anthropicBaseUrl,
          model: 'claude-x',
          apiKey: fake.apiKey,
        },
      }),
    );
    expect((await test()).json()).toMatchObject({ ok: true, problem: null });
    expect(fake.requests[0]!.path).toBe('/v1/messages');
    expect(fake.requests[0]!.headers['x-api-key']).toBe(fake.apiKey);
    await put(body());
  });

  describe('the provider test reports tool calling', () => {
    type Kind = 'openai' | 'anthropic';
    /** Saves the provider of that kind, which points at the fake. */
    const useProvider = (kind: Kind) =>
      put(
        body(
          kind === 'openai'
            ? {}
            : {
                provider: {
                  kind: 'anthropic',
                  baseUrl: fake.anthropicBaseUrl,
                  model: 'claude-x',
                  apiKey: fake.apiKey,
                },
              },
        ),
      );
    const plainOk = (kind: Kind): LlmReply => ({
      status: 200,
      body: kind === 'openai' ? openAiAnswer('{"ok": true}') : anthropicAnswer('{"ok": true}'),
    });
    const textAnswer = (kind: Kind): LlmReply => ({
      status: 200,
      body: kind === 'openai' ? openAiAnswer('ok') : anthropicAnswer('ok'),
    });
    const toolAnswer = (kind: Kind): LlmReply => ({
      status: 200,
      body:
        kind === 'openai'
          ? openAiToolCalls([ECHO_CALL])
          : anthropicToolUse([{ id: 'toolu_1', name: 'echo', input: ECHO_CALL.arguments }]),
    });
    const refusal = (kind: Kind, status: number, message: string): LlmReply => ({
      status,
      body:
        kind === 'openai'
          ? { error: { message, type: 'invalid_request_error', param: null, code: null } }
          : { type: 'error', error: { type: 'invalid_request_error', message } },
    });
    afterAll(async () => {
      await put(body());
    });
    // The Test button is limited to ten presses a minute per admin: each case has an admin of its own.
    let checkers = 0;
    let checker: Session;
    beforeEach(async () => {
      checkers += 1;
      const u = await createUser(ctx, {
        username: `llm-tool-check-${checkers}`,
        isInstanceAdmin: true,
      });
      checker = await login(ctx, u.username, u.password);
    });
    const check = () => test(checker);

    it('sends one fixed prompt with the echo tool and reads a call as supported', async () => {
      await useProvider('openai');
      fake.enqueue(plainOk('openai'), toolAnswer('openai'));
      const res = await check();
      expect(res.json()).toMatchObject({ ok: true, problem: null, toolCalling: 'supported' });
      expect(fake.requests).toHaveLength(2);
      const sent = fake.requests[1]!;
      expect(sent.path).toBe('/v1/chat/completions');
      expect(sent.body).not.toMatch(/QUALOR-DATA/);
      expect(sent.json).toEqual({
        model: 'fake-model',
        messages: [
          { role: 'system', content: expect.stringContaining('echo') },
          { role: 'user', content: expect.stringContaining('echo') },
        ],
        // Room for a sentence before the call and for thinking, and the tools in place of the JSON mode.
        max_tokens: 4_256,
        tools: [
          {
            type: 'function',
            function: {
              name: 'echo',
              description: expect.any(String),
              parameters: ECHO_PARAMETERS,
            },
          },
        ],
        tool_choice: 'auto',
      });
      expect(sent.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
      expect(res.body).not.toContain(fake.apiKey);
    });

    it('sends the same check to an Anthropic provider, in its own wire format', async () => {
      await useProvider('anthropic');
      try {
        fake.enqueue(plainOk('anthropic'), toolAnswer('anthropic'));
        const res = await check();
        expect(res.json()).toMatchObject({ ok: true, problem: null, toolCalling: 'supported' });
        expect(fake.requests.map((r) => r.path)).toEqual(['/v1/messages', '/v1/messages']);
        expect(fake.requests[1]!.json).toEqual({
          model: 'claude-x',
          max_tokens: 4_256,
          system: expect.stringContaining('echo'),
          messages: [{ role: 'user', content: [{ type: 'text', text: expect.any(String) }] }],
          tools: [{ name: 'echo', description: expect.any(String), input_schema: ECHO_PARAMETERS }],
          // Only auto: the current models refuse a forced choice.
          tool_choice: { type: 'auto' },
        });
        expect(fake.requests[1]!.headers['x-api-key']).toBe(fake.apiKey);
      } finally {
        await useProvider('openai');
      }
    });

    it.each(['openai', 'anthropic'] as const)(
      'passes a model that takes at most 4 096 output tokens: the Test asks again without the room, and the tool check goes without it (%s)',
      async (kind) => {
        try {
          await put(
            body({
              provider:
                kind === 'openai'
                  ? provider({ model: 'capped-model' })
                  : provider({
                      kind: 'anthropic',
                      baseUrl: fake.anthropicBaseUrl,
                      model: 'capped-model',
                    }),
            }),
          );
          fake.enqueue(plainOk(kind), toolAnswer(kind));
          const res = await check();
          expect(res.json()).toMatchObject({ ok: true, problem: null, toolCalling: 'supported' });
          // The plain call asked for 256 and the room, was refused and asked again; the check
          // then knew the model.
          expect(fake.requests.map((r) => (r.json as { max_tokens: number }).max_tokens)).toEqual([
            256 + 4_000,
            256,
            256,
          ]);
          expect(res.body).not.toMatch(/maximum allowed number|supports at most/);
        } finally {
          await useProvider('openai');
        }
      },
    );

    it.each(['openai', 'anthropic'] as const)(
      'asks for room to think in both calls of the Test: 256 tokens and the 4 000 of the allowance (%s)',
      async (kind) => {
        await useProvider(kind);
        try {
          fake.enqueue(plainOk(kind), toolAnswer(kind));
          const res = await check();
          expect(res.json()).toMatchObject({ ok: true, problem: null, toolCalling: 'supported' });
          expect(fake.requests).toHaveLength(2);
          for (const request of fake.requests) {
            expect((request.json as { max_tokens: number }).max_tokens).toBe(256 + 4_000);
          }
        } finally {
          await useProvider('openai');
        }
      },
    );

    it.each(['openai', 'anthropic'] as const)(
      'is not_supported when the model answers in text instead of calling the tool (%s)',
      async (kind) => {
        await useProvider(kind);
        try {
          fake.enqueue(plainOk(kind), textAnswer(kind));
          const res = await check();
          expect(res.json()).toMatchObject({
            ok: true,
            problem: null,
            toolCalling: 'not_supported',
          });
          expect(fake.requests).toHaveLength(2);
        } finally {
          await useProvider('openai');
        }
      },
    );

    it.each(['openai', 'anthropic'] as const)(
      'is not_checked when the output limit cut the model off before any call (%s)',
      async (kind) => {
        await useProvider(kind);
        try {
          // A model that says what it will do first may use up the limit before it does it.
          fake.enqueue(plainOk(kind), {
            status: 200,
            body:
              kind === 'openai'
                ? openAiAnswer('Sure! I will call the echo tool', { finishReason: 'length' })
                : anthropicAnswer('Sure! I will call the echo tool', { stopReason: 'max_tokens' }),
          });
          const res = await check();
          expect(res.json()).toMatchObject({ ok: true, problem: null, toolCalling: 'not_checked' });
        } finally {
          await useProvider('openai');
        }
      },
    );

    it('is supported when the limit cut the call itself short: the model did call the tool', async () => {
      const cut = toolAnswer('openai').body as { choices: { finish_reason: string }[] };
      cut.choices[0]!.finish_reason = 'length';
      fake.enqueue(plainOk('openai'), { status: 200, body: cut });
      expect((await check()).json()).toMatchObject({ ok: true, toolCalling: 'supported' });
    });

    it.each(['openai', 'anthropic'] as const)(
      'is not_supported when the provider refuses the request in words that name tools (%s)',
      async (kind) => {
        await useProvider(kind);
        try {
          fake.enqueue(plainOk(kind), refusal(kind, 400, 'This model does not support tools'));
          const res = await check();
          // The plain test passed: the refusal of the tools answers the check, it does not fail the test.
          expect(res.json()).toMatchObject({
            ok: true,
            problem: null,
            toolCalling: 'not_supported',
          });
          fake.enqueue(
            plainOk(kind),
            refusal(kind, 404, 'No endpoints found that support tool use'),
          );
          expect((await check()).json()).toMatchObject({ toolCalling: 'not_supported' });
        } finally {
          await useProvider('openai');
        }
      },
    );

    it.each([
      ['a refusal that names no tools', 400, 'Invalid request'],
      ['a refused key', 401, 'bad key'],
      ['a rate limit', 429, 'slow down'],
      ['an unavailable provider', 500, 'oops'],
    ] as const)(
      'is not_checked after %s, which says nothing of tools',
      async (_name, status, message) => {
        fake.enqueue(plainOk('openai'), refusal('openai', status, message));
        const res = await check();
        // The plain test's result stands: the check's failure changes nothing but its own field.
        expect(res.json()).toMatchObject({
          ok: true,
          model: 'fake-openai-model',
          problem: null,
          toolCalling: 'not_checked',
        });
        expect(fake.requests).toHaveLength(2);
      },
    );

    it('is not_checked when the check is answered with something that is not an answer', async () => {
      fake.enqueue(plainOk('openai'), { status: 200, body: 'not json at all' });
      expect((await check()).json()).toMatchObject({ ok: true, toolCalling: 'not_checked' });
    });

    it('asks nothing more when the plain test failed: not_checked', async () => {
      fake.enqueue({ status: 401, body: { error: { message: 'bad key' } } });
      const refused = await check();
      expect(refused.json()).toMatchObject({
        ok: false,
        problem: { code: 'PROVIDER_REFUSED_KEY' },
        toolCalling: 'not_checked',
      });
      expect(fake.requests).toHaveLength(1);
      fake.requests.length = 0;
      fake.say('Sure! Here it is: {"ok": true}');
      expect((await check()).json()).toMatchObject({
        ok: false,
        problem: { code: 'MALFORMED_OUTPUT' },
        toolCalling: 'not_checked',
      });
      expect(fake.requests).toHaveLength(1);
    });

    it('keeps the latency of the plain test, and writes no usage row and no audit row', async () => {
      const rows = async () => [
        (await ctx.db.select({ n: count() }).from(llmRequests))[0]!.n,
        (await ctx.db.select({ n: count() }).from(auditEvents))[0]!.n,
      ];
      const before = await rows();
      fake.enqueue(plainOk('openai'), async () => {
        await new Promise((r) => setTimeout(r, 800));
        return toolAnswer('openai');
      });
      const res = (await check()).json();
      expect(res.toolCalling).toBe('supported');
      // The slow check is not part of the latency of the test.
      expect(res.latencyMs).toBeLessThan(700);
      expect(await rows()).toEqual(before);
    });
  });

  describe('the provider test, with a model for each tier', () => {
    const tiers = { strongModel: 'fake-strong', fastModel: 'fake-fast' };
    const modelOf = (request: RecordedLlmRequest) => (request.json as { model: string }).model;
    const asksForTool = (request: RecordedLlmRequest) =>
      (request.json as { tools?: unknown }).tools !== undefined;
    /**
     * A provider that serves every model: the plain call answers the JSON object and the tool
     * check calls the echo tool, each naming the model it ran as `reported-<model>`. A model of
     * `refused` is refused with a 404, as a provider does for a model it does not have.
     */
    const serving =
      (refused: readonly string[] = []): LlmResponder =>
      (request) => {
        const model = modelOf(request);
        if (refused.includes(model)) {
          return { status: 404, body: { error: { message: `no model ${model}` } } };
        }
        const reported = { model: `reported-${model}` };
        return {
          status: 200,
          body: asksForTool(request)
            ? openAiToolCalls([ECHO_CALL], reported)
            : openAiAnswer('{"ok": true}', reported),
        };
      };
    const enqueue = (calls: number, responder: LlmResponder) =>
      fake.enqueue(...Array.from({ length: calls }, () => responder));
    /** The line a model that answered both calls gets; `over` changes what differs. */
    const line = (tier: string, model: string, over: Record<string, unknown> = {}) => ({
      tier,
      model,
      ok: true,
      reportedModel: `reported-${model}`,
      latencyMs: expect.any(Number),
      toolCalling: 'supported',
      problem: null,
      hint: null,
      ...over,
    });
    afterEach(async () => {
      await put(body());
    });
    // The Test button is limited to ten presses a minute per admin: each case has an admin of its own.
    let testers = 0;
    let checker: Session;
    beforeEach(async () => {
      testers += 1;
      const u = await createUser(ctx, {
        username: `llm-model-check-${testers}`,
        isInstanceAdmin: true,
      });
      checker = await login(ctx, u.username, u.password);
    });
    const check = () => test(checker);

    it('the Test checks each distinct model at once and charges one test', async () => {
      await put(body({ provider: provider(tiers) }));
      let inFlight = 0;
      let peak = 0;
      let allIn: () => void = () => undefined;
      const everyoneIn = new Promise<void>((resolve) => {
        allIn = resolve;
      });
      // Holds each plain call until all three are in. Checks that ran one after the other would
      // each sit here alone, until the timeout lets the test fail on `peak`.
      const giveUp = setTimeout(() => allIn(), 3_000);
      const provides = serving();
      const together: LlmResponder = async (request) => {
        if (!asksForTool(request)) {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          if (inFlight === 3) allIn();
          await everyoneIn;
          inFlight -= 1;
        }
        return provides(request);
      };
      // Three plain calls, then a tool check of each model.
      enqueue(6, together);
      const rows = async () => [
        (await ctx.db.select({ n: count() }).from(llmRequests))[0]!.n,
        (await ctx.db.select({ n: count() }).from(auditEvents))[0]!.n,
      ];
      const before = await rows();

      const res = await check();
      clearTimeout(giveUp);
      expect(res.statusCode, res.body).toBe(200);
      expect(peak).toBe(3);
      const json = res.json();
      // The answer's own fields are the standard model's, as before the tiers.
      expect(json).toMatchObject({
        ok: true,
        model: 'reported-fake-model',
        problem: null,
        toolCalling: 'supported',
      });
      expect(json.models).toEqual([
        line('standard', 'fake-model'),
        line('strong', 'fake-strong'),
        line('fast', 'fake-fast'),
      ]);
      // Each call names its model: two for each, the plain one and the tool check.
      expect(fake.requests.map(modelOf).sort()).toEqual([
        'fake-fast',
        'fake-fast',
        'fake-model',
        'fake-model',
        'fake-strong',
        'fake-strong',
      ]);
      expect(fake.requests.filter(asksForTool)).toHaveLength(3);
      expect(res.body).not.toContain(fake.apiKey);
      // No usage row and no audit row, no matter how many models.
      expect(await rows()).toEqual(before);

      // The press took one of the ten tests a minute, not one per model.
      for (let i = 1; i < 10; i += 1) expect((await check()).statusCode).toBe(200);
      const limited = await check();
      expect([limited.statusCode, limited.json().code]).toEqual([429, 'RATE_LIMITED']);
    });

    it('a failing fast model fails only its own line', async () => {
      await put(body({ provider: provider(tiers) }));
      // Three plain calls, and a tool check for the two models that answered.
      enqueue(5, serving(['fake-fast']));
      const res = await check();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        model: 'reported-fake-model',
        problem: null,
        toolCalling: 'supported',
      });
      expect(res.json().models).toEqual([
        line('standard', 'fake-model'),
        line('strong', 'fake-strong'),
        line('fast', 'fake-fast', {
          ok: false,
          reportedModel: null,
          toolCalling: 'not_checked',
          problem: {
            code: 'PROVIDER_REJECTED_REQUEST',
            message: 'The provider refused the request (HTTP 404); check the base URL and model',
            providerStatus: 404,
          },
        }),
      ]);
      expect(fake.requests).toHaveLength(5);
    });

    it('a failing standard model is the failure of the answer itself, and the other lines stay', async () => {
      await put(body({ provider: provider(tiers) }));
      enqueue(5, serving(['fake-model']));
      const json = (await check()).json();
      expect(json).toMatchObject({
        ok: false,
        model: null,
        toolCalling: 'not_checked',
        problem: { code: 'PROVIDER_REJECTED_REQUEST', providerStatus: 404 },
      });
      expect(json.models).toEqual([
        expect.objectContaining({ tier: 'standard', ok: false, toolCalling: 'not_checked' }),
        line('strong', 'fake-strong'),
        line('fast', 'fake-fast'),
      ]);
    });

    it('says what a tool check found for each model on its own', async () => {
      await put(body({ provider: provider(tiers) }));
      const provides = serving();
      // The strong model answers its tool check in text, and the fast model's check is cut short.
      enqueue(6, (request) => {
        if (asksForTool(request) && modelOf(request) === 'fake-strong') {
          return { status: 200, body: openAiAnswer('ok', { model: 'reported-fake-strong' }) };
        }
        if (asksForTool(request) && modelOf(request) === 'fake-fast') {
          return {
            status: 200,
            body: openAiAnswer('Sure! I will call', {
              model: 'reported-fake-fast',
              finishReason: 'length',
            }),
          };
        }
        return provides(request);
      });
      const json = (await check()).json();
      expect(json.models).toEqual([
        line('standard', 'fake-model'),
        line('strong', 'fake-strong', { toolCalling: 'not_supported' }),
        line('fast', 'fake-fast', { toolCalling: 'not_checked' }),
      ]);
      expect(json).toMatchObject({ ok: true, toolCalling: 'supported' });
    });

    it('lists the models in the order of the tiers, whichever answers first', async () => {
      await put(body({ provider: provider(tiers) }));
      let toolChecks = 0;
      let released: () => void = () => undefined;
      const othersAnswered = new Promise<void>((resolve) => {
        released = resolve;
      });
      // The standard model's plain call is answered only once the other two models have reached
      // their tool checks, so it finishes last. If they never do, the timeout lets the assertions
      // below report it.
      const giveUp = setTimeout(() => released(), 3_000);
      const provides = serving();
      const standardLast: LlmResponder = async (request) => {
        if (asksForTool(request)) {
          toolChecks += 1;
          if (toolChecks === 2) released();
        } else if (modelOf(request) === 'fake-model') {
          await othersAnswered;
        }
        return provides(request);
      };
      enqueue(6, standardLast);
      const res = await check();
      clearTimeout(giveUp);
      expect(res.statusCode, res.body).toBe(200);
      // The standard model did finish last: its tool check is the last request.
      expect(fake.requests.filter(asksForTool).map(modelOf).at(-1)).toBe('fake-model');
      // Yet its line is first, as the tiers list it, and its fields are the answer's own.
      expect(res.json()).toMatchObject({ ok: true, model: 'reported-fake-model' });
      expect(res.json().models).toEqual([
        line('standard', 'fake-model'),
        line('strong', 'fake-strong'),
        line('fast', 'fake-fast'),
      ]);
    });

    it('never reports a model name that holds the key, for the line of that model only', async () => {
      await put(body({ provider: provider(tiers) }));
      const provides = serving();
      enqueue(6, (request) =>
        modelOf(request) === 'fake-strong'
          ? {
              status: 200,
              body: asksForTool(request)
                ? openAiToolCalls([ECHO_CALL], { model: `x-${fake.apiKey}` })
                : openAiAnswer('{"ok": true}', { model: `x-${fake.apiKey}` }),
            }
          : provides(request),
      );
      const res = await check();
      expect(res.body).not.toContain(fake.apiKey);
      expect(res.json().models).toEqual([
        line('standard', 'fake-model'),
        line('strong', 'fake-strong', { reportedModel: null }),
        line('fast', 'fake-fast'),
      ]);
    });

    it('checks a model that several tiers name once, and a tier on the standard model not at all', async () => {
      await put(
        body({ provider: provider({ strongModel: 'fake-strong', fastModel: 'fake-strong' }) }),
      );
      enqueue(4, serving());
      const shared = (await check()).json();
      // The first tier to use the model names it.
      expect(shared.models).toEqual([
        line('standard', 'fake-model'),
        line('strong', 'fake-strong'),
      ]);
      expect(fake.requests).toHaveLength(4);

      await put(
        body({ provider: provider({ strongModel: 'fake-model', fastModel: 'fake-model' }) }),
      );
      fake.requests.length = 0;
      enqueue(2, serving());
      const alone = (await check()).json();
      expect(alone.models).toEqual([line('standard', 'fake-model')]);
      expect(fake.requests).toHaveLength(2);
    });

    it('answers one line, the answer’s own, for a provider without tier models', async () => {
      await put(body());
      enqueue(2, serving());
      const json = (await check()).json();
      expect(json.models).toEqual([line('standard', 'fake-model')]);
      expect(json).toMatchObject({
        ok: true,
        model: 'reported-fake-model',
        toolCalling: 'supported',
      });
    });

    it('reports a key that no longer decrypts on every line, asking nothing of the provider', async () => {
      const secret = encryptionKey(ctx.config.secretKey);
      await writeLlmSettings(ctx.db, {
        ...DEFAULT_LLM_SETTINGS,
        provider: {
          kind: 'openai',
          baseUrl: fake.openAiBaseUrl,
          model: 'fake-model',
          ...tiers,
          auth: 'bearer',
          jsonMode: 'json_object',
          maxTokensField: 'max_tokens',
          temperature: null,
          api: 'chat_completions',
          workspaceId: null,
          timeoutSeconds: 60,
          apiKeyEnc: encryptSecret(secret, fake.apiKey, 'scm_connections.token_enc'),
        },
      });
      const json = (await check()).json();
      const problem = {
        code: 'KEY_UNDECRYPTABLE',
        message: 'Set the API key again',
        providerStatus: null,
      };
      expect(json).toMatchObject({ ok: false, model: null, toolCalling: 'not_checked', problem });
      expect(json.models).toEqual([
        line('standard', 'fake-model', {
          ok: false,
          reportedModel: null,
          latencyMs: 0,
          toolCalling: 'not_checked',
          problem,
        }),
        line('strong', 'fake-strong', {
          ok: false,
          reportedModel: null,
          latencyMs: 0,
          toolCalling: 'not_checked',
          problem,
        }),
        line('fast', 'fake-fast', {
          ok: false,
          reportedModel: null,
          latencyMs: 0,
          toolCalling: 'not_checked',
          problem,
        }),
      ]);
      expect(fake.requests).toHaveLength(0);
    });
  });

  it('names the base URL and model in the test result on a 404', async () => {
    fake.enqueue({ status: 404, body: { error: { message: 'x' } } });
    expect((await test()).json()).toMatchObject({
      ok: false,
      problem: {
        code: 'PROVIDER_REJECTED_REQUEST',
        message: 'The provider refused the request (HTTP 404); check the base URL and model',
        providerStatus: 404,
      },
    });
  });

  it('reports a refused key and an unusable answer, never logging the key', async () => {
    fake.enqueue({ status: 401, body: { error: { message: `bad key ${fake.apiKey}` } } });
    const refused = await test();
    expect(refused.json()).toMatchObject({
      ok: false,
      problem: {
        code: 'PROVIDER_REFUSED_KEY',
        message: 'The provider refused the API key (HTTP 401)',
        providerStatus: 401,
      },
    });
    expect(refused.body).not.toContain(fake.apiKey);
    // A 403 keeps the code, and says the key may not do this rather than that it is wrong.
    fake.enqueue({ status: 403, body: { error: { message: `no credit ${fake.apiKey}` } } });
    const forbidden = await test();
    expect(forbidden.json()).toMatchObject({
      ok: false,
      problem: {
        code: 'PROVIDER_REFUSED_KEY',
        message:
          'The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit',
        providerStatus: 403,
      },
    });
    expect(forbidden.body).not.toContain(fake.apiKey);
    fake.say('Sure! Here it is: {"ok": true}');
    expect((await test()).json()).toMatchObject({
      ok: false,
      problem: { code: 'MALFORMED_OUTPUT' },
    });
    expect(ctx.logs.join('\n')).not.toContain(fake.apiKey);
  });

  it('reports KEY_UNDECRYPTABLE for a key that no longer decrypts, and says so in GET', async () => {
    const key = encryptionKey(ctx.config.secretKey);
    await writeLlmSettings(ctx.db, {
      ...DEFAULT_LLM_SETTINGS,
      provider: {
        kind: 'openai',
        baseUrl: fake.openAiBaseUrl,
        model: 'fake-model',
        strongModel: null,
        fastModel: null,
        auth: 'bearer',
        jsonMode: 'json_object',
        maxTokensField: 'max_tokens',
        temperature: null,
        api: 'chat_completions',
        workspaceId: null,
        timeoutSeconds: 60,
        apiKeyEnc: encryptSecret(key, fake.apiKey, 'scm_connections.token_enc'),
      },
    });
    expect((await get()).json().provider).toMatchObject({ apiKeySet: true, apiKeyReadable: false });
    expect((await test()).json()).toMatchObject({
      ok: false,
      problem: { code: 'KEY_UNDECRYPTABLE', message: 'Set the API key again' },
    });
    expect(fake.requests).toHaveLength(0);
    await put(body());
  });

  it('allows at most 10 tests a minute per admin (429 RATE_LIMITED)', async () => {
    const u = await createUser(ctx, { username: 'llm-second-admin', isInstanceAdmin: true });
    const second = await login(ctx, u.username, u.password);
    for (let i = 0; i < 10; i += 1) expect((await test(second)).statusCode).toBe(200);
    const limited = await test(second);
    expect([limited.statusCode, limited.json().code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('lets an admin-scoped token of an instance admin in; a write token and a project token get 403', async () => {
    const tokenOf = async (scopes: string[]) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v0/tokens',
        headers: admin.headers,
        payload: { name: `llm-${scopes.join('-')}`, scopes },
      });
      expect(res.statusCode, res.body).toBe(201);
      return bearer((res.json() as { token: string }).token);
    };
    const project = await createProject(ctx, admin, { organizationId: org, key: 'llm-token' });
    const projectToken = bearer(await createProjectToken(ctx, admin, project.id));
    for (const headers of [await tokenOf(['read', 'write']), projectToken]) {
      for (const method of ['GET', 'PUT'] as const) {
        const res = await ctx.app.inject({
          method,
          url: '/api/v0/system/llm',
          headers,
          ...(method === 'PUT' ? { payload: body() } : {}),
        });
        expect(res.statusCode, res.body).toBe(403);
      }
      const tested = await ctx.app.inject({
        method: 'POST',
        url: '/api/v0/system/llm/test',
        headers,
      });
      expect(tested.statusCode).toBe(403);
    }
    const adminToken = await tokenOf(['admin']);
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/v0/system/llm',
      headers: adminToken,
    });
    expect(read.statusCode, read.body).toBe(200);
    const saved = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/system/llm',
      headers: adminToken,
      payload: body(),
    });
    expect(saved.statusCode, saved.body).toBe(200);
  });

  it('stores the openai-only fields at their defaults for an Anthropic provider', async () => {
    const res = await put(
      body({
        provider: {
          kind: 'anthropic',
          baseUrl: fake.anthropicBaseUrl,
          model: 'claude-x',
          apiKey: fake.apiKey,
          auth: 'api-key',
          jsonMode: 'none',
          maxTokensField: 'max_completion_tokens',
        },
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().provider).toMatchObject({
      kind: 'anthropic',
      auth: 'bearer',
      jsonMode: 'json_object',
      maxTokensField: 'max_tokens',
    });
    await put(body());
  });

  it('names a missing /v1 on a 404 from an OpenAI-compatible base URL without a version path', async () => {
    const root = new URL(fake.openAiBaseUrl).origin;
    expect((await put(body({ provider: provider({ baseUrl: root }) }))).statusCode).toBe(200);
    try {
      // The fake has nothing at /chat/completions of its root: a 404, as a real server gives.
      const res = (await test()).json();
      expect(fake.requests[0]!.path).toBe('/chat/completions');
      expect(res.problem.code).toBe('PROVIDER_REJECTED_REQUEST');
      expect(res.problem.message).toContain('/v1');
    } finally {
      await put(body());
    }
  });

  it('runs one test at a time per admin, and cuts a long model name at a whole character', async () => {
    const u = await createUser(ctx, { username: 'llm-one-test', isInstanceAdmin: true });
    const s = await login(ctx, u.username, u.password);
    await put(body());
    fake.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return {
        status: 200,
        body: { ...(openAiAnswer('{"ok": true}') as object), model: `${'m'.repeat(199)}😀x` },
      };
    });
    const [a, b] = await Promise.all([test(s), test(s)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 429]);
    const ok = a.statusCode === 200 ? a : b;
    expect(ok.json().model).toBe('m'.repeat(199));
    // The plain test and the tool-calling check of the one that ran.
    expect(fake.requests).toHaveLength(2);
    // Done: the next one runs.
    expect((await test(s)).statusCode).toBe(200);
  });

  it('is 409 AI_DISABLED to test without a provider', async () => {
    await put(body({ provider: null }));
    const res = await test();
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AI_DISABLED');
  });
});

describe('/system/llm and QUALOR_SCM_INTERNAL_HOSTS (llm.md §4)', () => {
  let ctx: TestContext;
  let fake: FakeLlm;

  beforeAll(async () => {
    fake = await createFakeLlm();
    ctx = await createTestContext({
      config: { scmInternalHosts: parseInternalHosts(fake.host) },
    });
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  it('does not let the SCM list open a base URL to the model', async () => {
    const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/system/llm',
      headers: admin.headers,
      payload: {
        provider: { kind: 'openai', baseUrl: fake.openAiBaseUrl, model: 'm', apiKey: null },
        organizations: {},
        excludePaths: [],
        budgets: DEFAULT_LLM_SETTINGS.budgets,
        pricing: null,
        storePrompts: false,
        promptRetentionDays: 7,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0]).toMatchObject({
      path: 'body.provider.baseUrl',
      message: expect.stringMatching(/QUALOR_LLM_INTERNAL_HOSTS/),
    });
    expect(fake.requests).toHaveLength(0);
  });
});
