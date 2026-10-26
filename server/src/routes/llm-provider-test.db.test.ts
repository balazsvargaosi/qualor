import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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
  type LlmResponder,
  type RecordedLlmRequest,
} from '../../test/fake-llm';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { auditEvents, instanceSettings, llmRequests } from '../db/schema';
import { testFingerprint } from '../llm/last-test';
import { DEFAULT_LLM_SETTINGS, readLlmSettings, writeLlmSettings } from '../llm/settings';
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
    });
    ctx = await createTestContext({
      config: { llmInternalHosts: parseInternalHosts(fake.host) },
    });
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    org = await organizationId(ctx, 'default');
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });
  beforeEach(() => {
    fake.requests.length = 0;
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

    it.each(['openai', 'anthropic'] as const)(
      'asks for no stream, in the plain call or in the tool check (%s)',
      async (kind) => {
        await useProvider(kind);
        try {
          fake.enqueue(plainOk(kind), toolAnswer(kind));
          const res = await check();
          expect(res.json()).toMatchObject({ ok: true, problem: null, toolCalling: 'supported' });
          expect(fake.requests).toHaveLength(2);
          for (const request of fake.requests) {
            expect(request.json).not.toHaveProperty('stream');
            expect(request.json).not.toHaveProperty('stream_options');
            expect(request.headers.accept).toBe('application/json');
          }
        } finally {
          await useProvider('openai');
        }
      },
    );

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
      // A refusal of a call that asked for the room to think is asked again once without it.
      ['a refusal that names no tools', 400, 'Invalid request', 2],
      ['a refused key', 401, 'bad key', 1],
      ['a rate limit', 429, 'slow down', 1],
      ['an unavailable provider', 500, 'oops', 1],
    ] as const)(
      'is not_checked after %s, which says nothing of tools',
      async (_name, status, message, asks) => {
        fake.enqueue(
          plainOk('openai'),
          ...Array.from({ length: asks }, () => refusal('openai', status, message)),
        );
        const res = await check();
        // The plain test's result stands: the check's failure changes nothing but its own field.
        expect(res.json()).toMatchObject({
          ok: true,
          model: 'fake-openai-model',
          problem: null,
          toolCalling: 'not_checked',
        });
        expect(fake.requests).toHaveLength(1 + asks);
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

  describe('the last Test of the provider (A2)', () => {
    /** The `instance_settings` row that keeps it. */
    const rowOf = async () =>
      (await ctx.db.select().from(instanceSettings).where(eq(instanceSettings.key, 'llm-test')))[0];
    const forgetIt = () =>
      ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, 'llm-test'));
    const modelOf = (request: RecordedLlmRequest) => (request.json as { model: string }).model;
    const asksForTool = (request: RecordedLlmRequest) =>
      (request.json as { tools?: unknown }).tools !== undefined;
    /** The plain call passes, and the model calls the echo tool. */
    const passing: LlmReply[] = [
      { status: 200, body: openAiAnswer('{"ok": true}') },
      { status: 200, body: openAiToolCalls([ECHO_CALL]) },
    ];
    /** The provider as the body of a save that leaves its key alone. */
    const keyless = (over: Record<string, unknown> = {}) =>
      provider({ apiKey: undefined, ...over });
    // The Test button is limited to ten presses a minute per admin: each case has an admin of its own.
    let testers = 0;
    let tester: { id: string; session: Session };
    beforeEach(async () => {
      // The file shares one database: no case starts from another's record or provider.
      await forgetIt();
      expect((await put(body())).statusCode).toBe(200);
      testers += 1;
      const u = await createUser(ctx, {
        username: `llm-last-test-${testers}`,
        isInstanceAdmin: true,
      });
      tester = { id: u.id, session: await login(ctx, u.username, u.password) };
    });
    afterAll(async () => {
      await put(body());
    });
    const check = () => test(tester.session);

    it('keeps the last Test until the provider changes, with codes and never the provider’s words (A2)', async () => {
      fake.enqueue(...passing);
      const pressed = Date.now();
      const tested = await check();
      expect(tested.statusCode, tested.body).toBe(200);
      const read = (await get()).json();
      expect(read.lastTest).toEqual({
        at: expect.any(String),
        userId: tester.id,
        models: [
          {
            tier: 'standard',
            model: 'fake-model',
            ok: true,
            toolCalling: 'supported',
            problemCode: null,
          },
        ],
      });
      // When it ran, not when it was read.
      expect(Date.parse(read.lastTest.at)).toBeGreaterThanOrEqual(pressed);
      expect(Date.parse(read.lastTest.at)).toBeLessThanOrEqual(Date.now());
      // The row holds codes and names: no key, no word of the provider's, nothing it answered.
      const row = await rowOf();
      expect(JSON.stringify(row!.value)).not.toContain(fake.apiKey);
      expect(Object.keys(row!.value as object).sort()).toEqual([
        'at',
        'fingerprint',
        'models',
        'userId',
        'v',
      ]);
      expect(Object.keys((row!.value as { models: object[] }).models[0]!).sort()).toEqual([
        'model',
        'ok',
        'problemCode',
        'tier',
        'toolCalling',
      ]);
      // A save that leaves the provider and its key alone keeps it, in its own answer too.
      const kept = await put(body({ provider: keyless() }));
      expect(kept.statusCode, kept.body).toBe(200);
      expect(kept.json().lastTest).toEqual(read.lastTest);
      expect((await get()).json().lastTest).toEqual(read.lastTest);
      // A change of the provider ends it.
      const changed = await put(body({ provider: provider({ model: 'other-model' }) }));
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().lastTest).toBeNull();
      expect((await get()).json().lastTest).toBeNull();
    });

    it('keeps a failed model’s problem code, in place of the Test before it', async () => {
      fake.enqueue(...passing);
      expect((await check()).statusCode).toBe(200);
      expect((await get()).json().lastTest.models[0]).toMatchObject({ ok: true });
      fake.enqueue({
        status: 401,
        body: { error: { message: `FAKE-PROVIDER-WORDS ${fake.apiKey}` } },
      });
      const res = await check();
      expect(res.statusCode, res.body).toBe(200);
      expect((await get()).json().lastTest.models).toEqual([
        {
          tier: 'standard',
          model: 'fake-model',
          ok: false,
          toolCalling: 'not_checked',
          problemCode: 'PROVIDER_REFUSED_KEY',
        },
      ]);
      const stored = JSON.stringify((await rowOf())!.value);
      expect(stored).not.toContain('FAKE-PROVIDER-WORDS');
      expect(stored).not.toContain(fake.apiKey);
      expect(ctx.logs.join('\n')).not.toContain(fake.apiKey);
    });

    it('keeps a line for each model of the provider', async () => {
      await put(
        body({ provider: provider({ strongModel: 'fake-strong', fastModel: 'fake-fast' }) }),
      );
      const provides: LlmResponder = (request) => {
        const model = modelOf(request);
        if (model === 'fake-fast') return { status: 404, body: { error: { message: 'no model' } } };
        // The strong model answers its tool check in text.
        if (model === 'fake-strong' && asksForTool(request)) {
          return { status: 200, body: openAiAnswer('ok') };
        }
        return {
          status: 200,
          body: asksForTool(request) ? openAiToolCalls([ECHO_CALL]) : openAiAnswer('{"ok": true}'),
        };
      };
      // The plain call of each of the three models, and a tool check of the two that answered.
      fake.enqueue(...Array.from({ length: 5 }, () => provides));
      const res = await check();
      expect(res.statusCode, res.body).toBe(200);
      expect((await get()).json().lastTest.models).toEqual([
        {
          tier: 'standard',
          model: 'fake-model',
          ok: true,
          toolCalling: 'supported',
          problemCode: null,
        },
        {
          tier: 'strong',
          model: 'fake-strong',
          ok: true,
          toolCalling: 'not_supported',
          problemCode: null,
        },
        {
          tier: 'fast',
          model: 'fake-fast',
          ok: false,
          toolCalling: 'not_checked',
          problemCode: 'PROVIDER_REJECTED_REQUEST',
        },
      ]);
    });

    it('keeps nothing for a Test it refuses', async () => {
      // No provider: 409. It takes the first of the ten presses a minute.
      expect((await put(body({ provider: null }))).statusCode).toBe(200);
      const without = await check();
      expect([without.statusCode, without.json().code]).toEqual([409, 'AI_DISABLED']);
      expect(await rowOf()).toBeUndefined();
      expect((await get()).json().lastTest).toBeNull();
      // Too many presses: 429, after the nine that are left, which do keep a Test.
      expect((await put(body())).statusCode).toBe(200);
      for (let i = 1; i < 10; i += 1) expect((await check()).statusCode).toBe(200);
      expect(await rowOf()).toBeDefined();
      await forgetIt();
      const limited = await check();
      expect([limited.statusCode, limited.json().code]).toEqual([429, 'RATE_LIMITED']);
      expect(await rowOf()).toBeUndefined();
    });

    it('takes lastTest back in a body and ignores it (R1)', async () => {
      fake.enqueue(...passing);
      await check();
      const stored = (await rowOf())!.value;
      const read = (await get()).json();
      expect(read.lastTest).not.toBeNull();
      // The answer put back, its Test saying something else: it is accepted, and changes nothing.
      const claimed = {
        ...read.lastTest,
        models: [{ ...read.lastTest.models[0], ok: false, problemCode: 'PROVIDER_REFUSED_KEY' }],
      };
      const res = await put({ ...read, provider: keyless(), lastTest: claimed });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().lastTest).toEqual(read.lastTest);
      expect((await rowOf())!.value).toEqual(stored);
      const [llm] = await ctx.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, 'llm'));
      expect(JSON.stringify(llm!.value)).not.toContain('lastTest');
      // Whatever it holds, it is not checked.
      const odd = await put({ ...read, provider: keyless(), lastTest: { at: 'yesterday' } });
      expect(odd.statusCode, odd.body).toBe(200);
      expect((await rowOf())!.value).toEqual(stored);
    });

    it('is not shown once the key is set again: its envelope is another one', async () => {
      fake.enqueue(...passing);
      await check();
      expect((await get()).json().lastTest).not.toBeNull();
      const again = await put(body());
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().lastTest).toBeNull();
      expect((await get()).json().lastTest).toBeNull();
    });

    it('keeps the Test through a save that leaves the provider alone, whatever else it changes', async () => {
      fake.enqueue(...passing);
      expect((await check()).statusCode).toBe(200);
      const read = (await get()).json();
      expect(read.lastTest).not.toBeNull();
      const stored = (await rowOf())!.value;
      /** What the organisation's admins are told of the provider's models. */
      const toldToOrganizations = async () => {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v0/organizations/${org}/ai/review`,
          headers: admin.headers,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json().providerTest;
      };
      const told = await toldToOrganizations();
      expect(told).toEqual({
        at: read.lastTest.at,
        toolCalling: 'supported',
        modelsWithoutTools: [],
      });
      /** Saves `over` besides the provider, left as it is with its key, and expects the Test to stand. */
      const saveKeepingProvider = async (over: Record<string, unknown>) => {
        const saved = await put(body({ provider: keyless(), ...over }));
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json().lastTest).toEqual(read.lastTest);
        expect((await get()).json().lastTest).toEqual(read.lastTest);
        expect(await toldToOrganizations()).toEqual(told);
        return saved.json();
      };
      // Limits: the budgets and the prices.
      const limits = await saveKeepingProvider({
        budgets: {
          explainPerDay: 150,
          triagePerDay: 80,
          fixPerDay: 20,
          tokensPerDay: 750_000,
          costPerDayUsd: 12.5,
          perUserPerHour: 20,
        },
        pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, strong: null, fast: null },
      });
      // The save did change them.
      expect(limits.budgets).toMatchObject({ explainPerDay: 150, tokensPerDay: 750_000 });
      expect(limits.pricing).toMatchObject({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
      // Data: the excluded paths, whether prompts are kept, and for how long.
      const data = await saveKeepingProvider({
        excludePaths: ['vendor/**', 'dist/**'],
        storePrompts: true,
        promptRetentionDays: 30,
      });
      expect(data).toMatchObject({
        excludePaths: ['vendor/**', 'dist/**'],
        storePrompts: true,
        promptRetentionDays: 30,
      });
      // Nothing of the record was touched.
      expect((await rowOf())!.value).toEqual(stored);
    });

    it('reads a row that does not parse as no Test, though its fingerprint is the provider’s', async () => {
      const { provider: saved } = await readLlmSettings(ctx.db);
      await ctx.db.insert(instanceSettings).values({
        key: 'llm-test',
        value: {
          v: 1,
          at: 'yesterday',
          userId: tester.id,
          fingerprint: testFingerprint(saved!),
          models: [],
        },
      });
      const read = await get();
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().lastTest).toBeNull();
      // The next Test replaces it.
      fake.enqueue(...passing);
      expect((await check()).statusCode).toBe(200);
      expect((await get()).json().lastTest).toMatchObject({ userId: tester.id });
    });

    it('belongs to the provider it ran against, whatever is saved while it runs', async () => {
      let saved = 0;
      // The provider is replaced while the plain call is in flight.
      fake.enqueue(async () => {
        saved = (await put(body({ provider: provider({ model: 'other-model' }) }))).statusCode;
        return passing[0]!;
      }, passing[1]!);
      const res = await check();
      expect(res.statusCode, res.body).toBe(200);
      expect(saved).toBe(200);
      const read = (await get()).json();
      expect(read.provider.model).toBe('other-model');
      // The record is of the provider that was tested, which is no longer the provider.
      expect(read.lastTest).toBeNull();
      expect(await rowOf()).toBeDefined();
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
