import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  type FakeLlm,
  type LlmReply,
} from '../../test/fake-llm';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { auditEvents, instanceSettings, llmRequests } from '../db/schema';
import { DEFAULT_LLM_SETTINGS, writeLlmSettings } from '../llm/settings';
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
    fake = await createFakeLlm();
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

  it('accepts an Anthropic temperature of 0 to 1 and OpenAI up to 2', async () => {
    const anthropic = await put(
      body({
        provider: {
          kind: 'anthropic',
          baseUrl: fake.anthropicBaseUrl,
          model: 'm',
          apiKey: fake.apiKey,
          temperature: 1,
        },
      }),
    );
    expect(anthropic.statusCode, anthropic.body).toBe(200);
    expect((await put(body({ provider: provider({ temperature: 2 }) }))).statusCode).toBe(200);
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
        { role: 'user', content: 'ping' },
      ],
      max_tokens: 20,
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
        // The plain test's output limit, and the tools in place of its JSON mode.
        max_tokens: 20,
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
          max_tokens: 20,
          system: expect.stringContaining('echo'),
          messages: [{ role: 'user', content: [{ type: 'text', text: expect.any(String) }] }],
          tools: [{ name: 'echo', description: expect.any(String), input_schema: ECHO_PARAMETERS }],
        });
        expect(fake.requests[1]!.headers['x-api-key']).toBe(fake.apiKey);
      } finally {
        await useProvider('openai');
      }
    });

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
        auth: 'bearer',
        jsonMode: 'json_object',
        maxTokensField: 'max_tokens',
        temperature: null,
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
