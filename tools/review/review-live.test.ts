import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeLlm,
  openAiToolCalls,
  type FakeLlm,
  type LlmResponder,
} from '../../server/test/fake-llm';
import { reviewResponder, reviewRoleOf } from '../../server/test/review';
import { REVIEW_CALL_MIN_TIMEOUT_SECONDS, reviewStreamLimits } from '../../server/src/review/usage';
import { liveEnabled, providerOf, readLiveEnv, runLive, type LiveOptions } from './review-live';

/**
 * Plan 6I-3 Task 14: the opt-in live evaluation (`review.live.test.ts`), exercised here against the
 * fake LLM only. Nothing in this file contacts a model.
 */

/** Fake keys, built at run time so that no scanner takes them for real ones. */
const KEY = ['live', 'review', 'test', 'key', '0123456789'].join('-');
const WRONG_KEY = ['wrong', 'key', '0123456789'].join('-');

describe('liveEnabled and readLiveEnv', () => {
  const base = { QUALOR_LIVE_REVIEW_URL: 'https://llm.invalid', QUALOR_LIVE_REVIEW_MODEL: 'm' };

  it('is enabled only with both the URL and the model', () => {
    expect(liveEnabled({})).toBe(false);
    expect(liveEnabled({ QUALOR_LIVE_REVIEW_URL: 'https://llm.invalid' })).toBe(false);
    expect(liveEnabled({ QUALOR_LIVE_REVIEW_MODEL: 'm' })).toBe(false);
    expect(liveEnabled(base)).toBe(true);
  });

  it('reads the defaults', () => {
    expect(readLiveEnv(base)).toEqual({
      url: 'https://llm.invalid',
      model: 'm',
      kind: 'openai',
      api: 'chat_completions',
      apiKey: null,
      auth: 'bearer',
      workspaceId: null,
      runs: 1,
      cases: null,
      strongModel: null,
      fastModel: null,
      prices: null,
      strongPrices: null,
      fastPrices: null,
      contextWindowTokens: null,
      maxCostUsd: null,
    });
  });

  it('reads every variable', () => {
    expect(
      readLiveEnv({
        ...base,
        QUALOR_LIVE_REVIEW_KIND: 'anthropic',
        QUALOR_LIVE_REVIEW_API: 'responses',
        QUALOR_LIVE_REVIEW_API_KEY: KEY,
        QUALOR_LIVE_REVIEW_WORKSPACE_ID: 'wrkspc_01AbCdEf',
        QUALOR_LIVE_REVIEW_RUNS: '5',
        QUALOR_LIVE_REVIEW_CASES: ' ts-off-by-one, go-map-race ,,',
        QUALOR_LIVE_REVIEW_STRONG_MODEL: 'big',
        QUALOR_LIVE_REVIEW_FAST_MODEL: 'small',
        QUALOR_LIVE_REVIEW_PRICE_IN: '3',
        QUALOR_LIVE_REVIEW_PRICE_OUT: '15.5',
        QUALOR_LIVE_REVIEW_STRONG_PRICE_IN: '15',
        QUALOR_LIVE_REVIEW_STRONG_PRICE_OUT: '75',
        QUALOR_LIVE_REVIEW_FAST_PRICE_IN: '0.25',
        QUALOR_LIVE_REVIEW_FAST_PRICE_OUT: '1.25',
        QUALOR_LIVE_REVIEW_CONTEXT_WINDOW: '32000',
        QUALOR_LIVE_REVIEW_PRICE_CACHED_IN: '0.4',
        QUALOR_LIVE_REVIEW_STRONG_PRICE_CACHED_IN: '1.5',
        QUALOR_LIVE_REVIEW_FAST_PRICE_CACHED_IN: '',
        QUALOR_LIVE_REVIEW_AUTH: 'api-key',
        QUALOR_LIVE_REVIEW_MAX_USD: '12.5',
      }),
    ).toEqual({
      url: 'https://llm.invalid',
      model: 'm',
      kind: 'anthropic',
      // Anthropic has one API: the variable is for an OpenAI-compatible provider.
      api: 'chat_completions',
      apiKey: KEY,
      // Anthropic has its own key header: the variable is for an OpenAI-compatible provider.
      auth: 'bearer',
      workspaceId: 'wrkspc_01AbCdEf',
      runs: 5,
      cases: ['ts-off-by-one', 'go-map-race'],
      strongModel: 'big',
      fastModel: 'small',
      // Fictional prices; an empty cached price is none: the input price.
      prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15.5, cachedInputUsdPerMTok: 0.4 },
      strongPrices: { inputUsdPerMTok: 15, outputUsdPerMTok: 75, cachedInputUsdPerMTok: 1.5 },
      fastPrices: { inputUsdPerMTok: 0.25, outputUsdPerMTok: 1.25, cachedInputUsdPerMTok: null },
      contextWindowTokens: 32_000,
      maxCostUsd: 12.5,
    });
  });

  it('reads the model’s context window, a whole number of tokens from 8 000 to 10 000 000, and none from an empty or missing variable', () => {
    const windowOf = (value?: string) =>
      readLiveEnv(
        value === undefined ? base : { ...base, QUALOR_LIVE_REVIEW_CONTEXT_WINDOW: value },
      ).contextWindowTokens;
    expect(windowOf()).toBeNull();
    expect(windowOf('')).toBeNull();
    expect(windowOf('8000')).toBe(8_000);
    expect(windowOf('200000')).toBe(200_000);
    expect(windowOf('10000000')).toBe(10_000_000);
    for (const value of ['7999', '10000001', '0', '-32000', '32000.5', '32k', 'large']) {
      expect(() => windowOf(value), value).toThrow(
        'QUALOR_LIVE_REVIEW_CONTEXT_WINDOW must be a whole number of tokens from 8000 to 10000000',
      );
    }
  });

  it('reads no tier model from an empty or missing variable: the tier uses the model', () => {
    for (const empty of [{}, { QUALOR_LIVE_REVIEW_STRONG_MODEL: '' }]) {
      expect(readLiveEnv({ ...base, ...empty })).toMatchObject({ strongModel: null });
    }
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_FAST_MODEL: '' })).toMatchObject({
      fastModel: null,
    });
  });

  it('reads the workspace of an organisation-wide Anthropic key, and none for another kind or an empty variable', () => {
    const named = { ...base, QUALOR_LIVE_REVIEW_WORKSPACE_ID: 'wrkspc_01AbCdEf' };
    expect(readLiveEnv({ ...named, QUALOR_LIVE_REVIEW_KIND: 'anthropic' }).workspaceId).toBe(
      'wrkspc_01AbCdEf',
    );
    // An OpenAI-compatible server has no workspace, as in the AI settings.
    expect(readLiveEnv(named).workspaceId).toBeNull();
    expect(
      readLiveEnv({
        ...base,
        QUALOR_LIVE_REVIEW_KIND: 'anthropic',
        QUALOR_LIVE_REVIEW_WORKSPACE_ID: '',
      }).workspaceId,
    ).toBeNull();
  });

  it('reads the API an OpenAI-compatible provider is asked through: Chat Completions unless the Responses API is named', () => {
    expect(readLiveEnv(base).api).toBe('chat_completions');
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_API: '' }).api).toBe('chat_completions');
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_API: 'chat_completions' }).api).toBe(
      'chat_completions',
    );
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_API: 'responses' }).api).toBe('responses');
  });

  it('reports a cost only with both prices', () => {
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_PRICE_IN: '3' }).prices).toBeNull();
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_PRICE_OUT: '15' }).prices).toBeNull();
    expect(
      readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_PRICE_IN: '0', QUALOR_LIVE_REVIEW_PRICE_OUT: '0' })
        .prices,
    ).toEqual({ inputUsdPerMTok: 0, outputUsdPerMTok: 0, cachedInputUsdPerMTok: null });
  });

  it('reads the cached input price of each model, and none from an empty or missing variable', () => {
    const priced = { QUALOR_LIVE_REVIEW_PRICE_IN: '3', QUALOR_LIVE_REVIEW_PRICE_OUT: '15' };
    expect(readLiveEnv({ ...base, ...priced }).prices?.cachedInputUsdPerMTok).toBeNull();
    expect(
      readLiveEnv({ ...base, ...priced, QUALOR_LIVE_REVIEW_PRICE_CACHED_IN: '' }).prices
        ?.cachedInputUsdPerMTok,
    ).toBeNull();
    expect(
      readLiveEnv({ ...base, ...priced, QUALOR_LIVE_REVIEW_PRICE_CACHED_IN: '0' }).prices
        ?.cachedInputUsdPerMTok,
    ).toBe(0);
    for (const tier of ['STRONG', 'FAST']) {
      const env = {
        ...base,
        [`QUALOR_LIVE_REVIEW_${tier}_PRICE_IN`]: '5',
        [`QUALOR_LIVE_REVIEW_${tier}_PRICE_OUT`]: '9',
        [`QUALOR_LIVE_REVIEW_${tier}_PRICE_CACHED_IN`]: '0.5',
      };
      const key = tier === 'STRONG' ? 'strongPrices' : 'fastPrices';
      expect(readLiveEnv(env)[key]?.cachedInputUsdPerMTok, tier).toBe(0.5);
    }
  });

  it('reads the key header of an OpenAI-compatible provider, bearer unless api-key is named', () => {
    expect(readLiveEnv(base).auth).toBe('bearer');
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_AUTH: '' }).auth).toBe('bearer');
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_AUTH: 'bearer' }).auth).toBe('bearer');
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_AUTH: 'api-key' }).auth).toBe('api-key');
    expect(() => readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_AUTH: 'basic' })).toThrow(
      'QUALOR_LIVE_REVIEW_AUTH must be bearer or api-key',
    );
  });

  it('refuses QUALOR_LIVE_REVIEW_MAX_USD without prices, or out of range', () => {
    const priced = { QUALOR_LIVE_REVIEW_PRICE_IN: '3', QUALOR_LIVE_REVIEW_PRICE_OUT: '15' };
    const capOf = (cap: string, more: Record<string, string> = priced) =>
      readLiveEnv({ ...base, ...more, QUALOR_LIVE_REVIEW_MAX_USD: cap }).maxCostUsd;
    expect(capOf('0.01')).toBe(0.01);
    expect(capOf('1000')).toBe(1000);
    expect(capOf('', {})).toBeNull();
    for (const cap of ['0', '-1', '1000.01', '1e4', 'much', 'NaN', 'Infinity']) {
      expect(() => capOf(cap), cap).toThrow('QUALOR_LIVE_REVIEW_MAX_USD');
    }
    // No prices at all, or no pair, for the model the calls go to.
    expect(() => capOf('5', {})).toThrow('QUALOR_LIVE_REVIEW_PRICE_IN');
    expect(() => capOf('5', { QUALOR_LIVE_REVIEW_PRICE_IN: '3' })).toThrow(
      'QUALOR_LIVE_REVIEW_PRICE_IN',
    );
    // A tier with a model of its own needs its prices too; one on the model does not.
    const tiered = { ...priced, QUALOR_LIVE_REVIEW_STRONG_MODEL: 'big' };
    expect(() => capOf('5', tiered)).toThrow('QUALOR_LIVE_REVIEW_STRONG_PRICE_IN');
    expect(
      capOf('5', {
        ...tiered,
        QUALOR_LIVE_REVIEW_STRONG_PRICE_IN: '9',
        QUALOR_LIVE_REVIEW_STRONG_PRICE_OUT: '9',
      }),
    ).toBe(5);
    expect(() => capOf('5', { ...priced, QUALOR_LIVE_REVIEW_FAST_MODEL: 'small' })).toThrow(
      'QUALOR_LIVE_REVIEW_FAST_PRICE_IN',
    );
    expect(capOf('5', { ...priced, QUALOR_LIVE_REVIEW_FAST_MODEL: 'm' })).toBe(5);
  });

  it('reads the prices of a tier only with both of them', () => {
    for (const tier of ['STRONG', 'FAST']) {
      const only = (side: 'IN' | 'OUT') => ({ [`QUALOR_LIVE_REVIEW_${tier}_PRICE_${side}`]: '5' });
      const key = tier === 'STRONG' ? 'strongPrices' : 'fastPrices';
      expect(readLiveEnv({ ...base, ...only('IN') })[key], tier).toBeNull();
      expect(readLiveEnv({ ...base, ...only('OUT') })[key], tier).toBeNull();
      expect(readLiveEnv({ ...base, ...only('IN'), ...only('OUT') })[key], tier).toEqual({
        inputUsdPerMTok: 5,
        outputUsdPerMTok: 5,
        cachedInputUsdPerMTok: null,
      });
    }
  });

  it.each([
    ['QUALOR_LIVE_REVIEW_KIND', 'gemini'],
    ['QUALOR_LIVE_REVIEW_API', 'completions'],
    ['QUALOR_LIVE_REVIEW_API', 'Responses'],
    ['QUALOR_LIVE_REVIEW_RUNS', '0'],
    ['QUALOR_LIVE_REVIEW_RUNS', '6'],
    ['QUALOR_LIVE_REVIEW_RUNS', '1.5'],
    ['QUALOR_LIVE_REVIEW_RUNS', 'many'],
    ['QUALOR_LIVE_REVIEW_PRICE_IN', '-1'],
    ['QUALOR_LIVE_REVIEW_PRICE_IN', 'free'],
    ['QUALOR_LIVE_REVIEW_PRICE_OUT', '10001'],
    ['QUALOR_LIVE_REVIEW_STRONG_PRICE_IN', '-1'],
    ['QUALOR_LIVE_REVIEW_STRONG_PRICE_OUT', 'dear'],
    ['QUALOR_LIVE_REVIEW_FAST_PRICE_IN', '10001'],
    ['QUALOR_LIVE_REVIEW_FAST_PRICE_OUT', '-0.5'],
    ['QUALOR_LIVE_REVIEW_PRICE_CACHED_IN', '-1'],
    ['QUALOR_LIVE_REVIEW_STRONG_PRICE_CACHED_IN', 'cheap'],
    ['QUALOR_LIVE_REVIEW_FAST_PRICE_CACHED_IN', '10001'],
    ['QUALOR_LIVE_REVIEW_API_KEY', 'a key with spaces'],
    ['QUALOR_LIVE_REVIEW_WORKSPACE_ID', 'workspace_01AbCd'],
    ['QUALOR_LIVE_REVIEW_WORKSPACE_ID', 'wrkspc_'],
    ['QUALOR_LIVE_REVIEW_WORKSPACE_ID', 'wrkspc_01 AbCd'],
  ])('refuses %s=%s, naming the variable', (name, value) => {
    expect(() => readLiveEnv({ ...base, [name]: value })).toThrow(name);
  });

  it('never repeats the key in the error it raises about it', () => {
    const key = 'has a space-SECRET-0123456789';
    let message = '';
    try {
      readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_API_KEY: key });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('QUALOR_LIVE_REVIEW_API_KEY');
    expect(message).not.toContain('SECRET');
  });

  it('asks for the URL and the model', () => {
    expect(() => readLiveEnv({ QUALOR_LIVE_REVIEW_MODEL: 'm' })).toThrow('QUALOR_LIVE_REVIEW_URL');
    expect(() => readLiveEnv({ QUALOR_LIVE_REVIEW_URL: 'https://x.invalid' })).toThrow(
      'QUALOR_LIVE_REVIEW_MODEL',
    );
  });
});

describe('providerOf', () => {
  const of = (
    url: string,
    kind: LiveOptions['kind'] = 'openai',
    workspaceId: string | null = null,
    api: LiveOptions['api'] = 'chat_completions',
    auth: LiveOptions['auth'] = 'bearer',
  ) => providerOf({ url, model: 'm', kind, api, auth, workspaceId });

  it('settles a call as the AI settings would store it', () => {
    expect(of('http://localhost:11434/v1/').config).toEqual({
      kind: 'openai',
      api: 'chat_completions',
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      auth: 'bearer',
      jsonMode: 'none',
      maxTokensField: 'max_tokens',
      temperature: null,
      workspaceId: null,
      // What a review call waits at least on the server (review/usage.ts).
      timeoutSeconds: 300,
    });
    expect(of('https://api.anthropic.com', 'anthropic').config).toMatchObject({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  it('names the API of an OpenAI-compatible provider in the settings of a call', () => {
    expect(of('https://api.openai.com/v1', 'openai', null, 'responses').config).toMatchObject({
      kind: 'openai',
      api: 'responses',
    });
  });

  it('names the key header in the settings of a call, and streams the calls as the server does', () => {
    expect(
      of('https://x.invalid/v1', 'openai', null, 'chat_completions', 'api-key').config,
    ).toMatchObject({ auth: 'api-key' });
    expect(of('https://x.invalid/v1').http.stream).toEqual(
      reviewStreamLimits(REVIEW_CALL_MIN_TIMEOUT_SECONDS),
    );
  });

  it('names the workspace of an Anthropic key in the settings of a call', () => {
    expect(of('https://api.anthropic.com', 'anthropic', 'wrkspc_01AbCdEf').config).toMatchObject({
      kind: 'anthropic',
      workspaceId: 'wrkspc_01AbCdEf',
    });
  });

  it.each([
    ['https://api.openai.com/v1', 'max_completion_tokens'],
    ['https://API.OpenAI.com/v1', 'max_completion_tokens'],
    ['https://acme.openai.azure.com/openai/v1', 'max_completion_tokens'],
    ['http://localhost:11434/v1', 'max_tokens'],
    ['https://api.openai.com.evil.invalid/v1', 'max_tokens'],
    ['https://openai.azure.com.invalid/v1', 'max_tokens'],
  ])('limits the answer of %s with %s, as the AI settings page chooses', (url, field) => {
    expect(of(url).config.maxTokensField).toBe(field);
  });

  it('allows the host that was typed, and no other, whatever its address', () => {
    expect([...of('http://localhost:11434/v1').http.internalHosts]).toEqual(['localhost:11434']);
    expect([...of('http://10.0.0.5:8080/v1').http.internalHosts]).toEqual(['10.0.0.5:8080']);
    expect([...of('https://api.openai.com/v1').http.internalHosts]).toEqual(['api.openai.com']);
  });

  it.each([
    ['http://user:pw@127.0.0.1:9/v1', /credentials/],
    ['http://127.0.0.1:9/v1?x=1', /query/],
    ['http://169.254.169.254/v1', /link-local|metadata/],
    ['ftp://127.0.0.1/v1', /https/],
    ['not a url', /valid URL/],
  ])('refuses the URL %s', (url, problem) => {
    expect(() => of(url)).toThrow(problem);
    expect(() => of(url)).toThrow('QUALOR_LIVE_REVIEW_URL');
  });

  it.each([
    'http://api.openai.com/v1',
    'http://API.OpenAI.com:8080/v1',
    'http://8.8.8.8/v1',
    // A name could be anywhere: only localhost, or an address written out, is known to be near.
    'http://ollama:11434/v1',
  ])('refuses %s: over http the key would cross the network in clear', (url) => {
    expect(() => of(url)).toThrow(/use https/);
    expect(() => of(url)).toThrow('QUALOR_LIVE_REVIEW_URL');
  });

  it.each([
    'http://localhost:11434/v1',
    'http://models.localhost:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
    'http://10.0.0.5:8080/v1',
    'http://192.168.1.20/v1',
    'http://[fd00::5]:8000/v1',
    'https://api.openai.com/v1',
    'https://gateway.corp.example/v1',
  ])('allows %s', (url) => {
    expect(() => of(url)).not.toThrow();
  });
});

describe('runLive against the fake LLM', () => {
  // A fake of its own for each test: what a test enqueued and the review did not ask for must
  // not answer the next test's calls.
  let fake: FakeLlm;
  beforeEach(async () => {
    fake = await createFakeLlm();
  });
  afterEach(async () => {
    await fake.close();
  });

  /** The problem the case ts-off-by-one seeds, as a reviewer reports it. */
  const FINDING = {
    category: 'logic',
    severity: 'major',
    confidence: 'high',
    path: 'src/cart.ts',
    line: 13,
    endLine: 14,
    title: 'MODEL-TITLE the loop reads one past the end',
    body: 'MODEL-BODY items[items.length] is undefined.',
  };
  const ANSWERS = reviewResponder({
    quality: JSON.stringify({ findings: [FINDING] }),
    judge: JSON.stringify({
      findings: [{ ...FINDING, sources: ['s1'] }],
      dropped: [],
      prior: [],
      summary: { verdict: 'MODEL-VERDICT one problem.', walkthrough: ['MODEL-WALKTHROUGH'] },
    }),
  });
  /** One answer for each call the review may make. */
  const enqueueAnswers = () => {
    fake.enqueue(...Array.from({ length: 12 }, () => ANSWERS));
  };

  const options = (over: Partial<LiveOptions> = {}): LiveOptions => ({
    url: fake.openAiBaseUrl,
    model: 'fake-model',
    kind: 'openai',
    api: 'chat_completions',
    apiKey: fake.apiKey,
    auth: 'bearer',
    workspaceId: null,
    runs: 1,
    cases: ['ts-off-by-one'],
    strongModel: null,
    fastModel: null,
    prices: null,
    strongPrices: null,
    fastPrices: null,
    contextWindowTokens: null,
    maxCostUsd: null,
    ...over,
  });

  it('gives every conversation the context window it is given', async () => {
    // The quality reviewer of this case writes at length beside the call it makes first: about
    // 15 000 tokens, which a window of 40 000 has no room to send again with another turn.
    const wordy: LlmResponder = (request) => {
      const { messages } = request.json as { messages: { role: string }[] };
      return reviewRoleOf(request) === 'quality' && !messages.some((m) => m.role === 'tool')
        ? {
            status: 200,
            body: openAiToolCalls([{ id: 'call-1', name: 'list_files', arguments: {} }], {
              text: 'z'.repeat(45_000),
            }),
          }
        : ANSWERS(request);
    };
    const play = async (contextWindowTokens: number | null) => {
      // A fake of its own for each review: nothing one left in the queue answers the other.
      await fake.close();
      fake = await createFakeLlm();
      fake.enqueue(...Array.from({ length: 12 }, () => wordy));
      const { report } = await runLive(options({ contextWindowTokens }));
      const second = fake.requests[1]?.json as { messages: { role: string; content: string }[] };
      return {
        report,
        roles: fake.requests.map(reviewRoleOf),
        wrappedUp: second.messages.at(-1)?.content.startsWith('Token budget reached') ?? false,
      };
    };
    // Without a window of its own (1 000 000 tokens), the reviewer goes on after its turn.
    const ample = await play(null);
    expect(ample.roles).toEqual(['quality', 'quality', 'tests', 'judge']);
    expect(ample.wrappedUp).toBe(false);
    expect(ample.report.failed).toEqual({});
    // In 40 000, the call after it is the wrap-up.
    const small = await play(40_000);
    expect(small.roles).toEqual(['quality', 'quality', 'tests', 'judge']);
    expect(small.wrappedUp).toBe(true);
    expect(small.report.failed).toEqual({});
  });

  it('does not review a case its window cannot hold, as the server skips it, and calls nothing', async () => {
    await fake.close();
    fake = await createFakeLlm();
    enqueueAnswers();
    // The judge's 16 384 tokens of answer leave 8 000 no room at all.
    const { report, text } = await runLive(options({ contextWindowTokens: 8_000 }));
    expect(report.failed).toEqual({ window_too_small: 1 });
    expect(fake.requests).toHaveLength(0);
    expect(text).toContain('window_too_small');
  });

  it('reviews the chosen case through the provider, with the review tools, and scores it', async () => {
    enqueueAnswers();
    const progress: [number, number][] = [];

    const { report, text } = await runLive(options(), (done, total) =>
      progress.push([done, total]),
    );

    expect(report.cases).toBe(1);
    expect(report.failed).toEqual({});
    expect(report.total).toMatchObject({
      problems: 1,
      found: 1,
      rightCategory: 1,
      anchored: 1,
      flagged: 0,
    });
    expect(progress).toEqual([[1, 1]]);
    // Every call went to the chat completions of the provider, with the key as a bearer token,
    // the review's system prompt and the three read-only tools.
    expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    for (const request of fake.requests) {
      expect(request.path).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
      const body = request.json as {
        model: string;
        messages: { role: string; content: string }[];
        tools: { function: { name: string } }[];
      };
      expect(body.model).toBe('fake-model');
      // The server is no OpenAI: its limit on the answer is max_tokens.
      expect(body).toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body.messages[0]?.content).toMatch(/^Qualor review: /);
      expect(body.tools.map((tool) => tool.function.name)).toEqual([
        'read_file',
        'grep',
        'list_files',
      ]);
    }
    // What the calls spent is counted, and aggregates are all that is printed.
    expect(report.tokens.input).toBe(1_000 * fake.requests.length);
    expect(text).toContain('model: fake-model (openai)');
    expect(text).toContain('1 case (0 clean), 1 run each, 1 review');
    expect(text).not.toContain(fake.apiKey);
    for (const forbidden of ['MODEL-', 'cartTotal', 'items.length', 'src/cart.ts']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('does not send the key back to the provider when the model repeats it', async () => {
    const echo: LlmResponder = (request) => {
      // The first call of the review: a turn of tools, with a sentence that holds the key.
      const first = fake.requests.indexOf(request) === 0;
      return first
        ? {
            status: 200,
            body: openAiToolCalls([{ id: 'call-1', name: 'list_files', arguments: {} }], {
              text: `my key is ${fake.apiKey}`,
            }),
          }
        : ANSWERS(request);
    };
    fake.enqueue(echo, ...Array.from({ length: 12 }, () => ANSWERS));

    const { report } = await runLive(options());

    expect(report.total).toMatchObject({ problems: 1, found: 1 });
    expect(fake.requests.length).toBeGreaterThan(1);
    // The conversation the second call carried holds the model's sentence, without the key.
    const second = fake.requests[1];
    expect(second?.body).toContain('my key is');
    for (const request of fake.requests) expect(request.body).not.toContain(fake.apiKey);
  });

  it('streams its calls as the server does, and measures each one', async () => {
    enqueueAnswers();

    const { report, text } = await runLive(options());

    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect((request.json as { stream?: unknown }).stream, request.path).toBe(true);
    }
    // Each call is told to the evaluation, with its latency and its input.
    expect(report.calls).toBe(fake.requests.length);
    expect(report.callLatencyMs).not.toBeNull();
    expect(report.maxCallInputTokens).toBeGreaterThan(0);
    expect(text).toContain(`model calls: ${fake.requests.length}; per call: median`);
  });

  it('sends the key in an api-key header with QUALOR_LIVE_REVIEW_AUTH=api-key', async () => {
    enqueueAnswers();

    const { report } = await runLive(options({ auth: 'api-key' }));

    expect(report.total).toMatchObject({ problems: 1, found: 1 });
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.headers['api-key']).toBe(fake.apiKey);
      expect(request.headers.authorization).toBeUndefined();
    }
  });

  it('stops before the next review at the cost cap, and says so', async () => {
    enqueueAnswers();
    enqueueAnswers();

    const { report, text } = await runLive(
      options({
        runs: 2,
        prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: null },
        // Far below the cost of one review: reached after the first.
        maxCostUsd: 0.000001,
      }),
    );

    expect(report).toMatchObject({ reviews: 1, stoppedAtCostCap: true });
    expect(text).toContain('stopped at the cost cap after 1 of 2 reviews');
  });

  it('reviews through the Messages API of an Anthropic provider, with its key header', async () => {
    enqueueAnswers();

    const { report } = await runLive(options({ kind: 'anthropic', url: fake.anthropicBaseUrl }));

    expect(report.total).toMatchObject({ problems: 1, found: 1 });
    for (const request of fake.requests) {
      expect(request.path).toBe('/v1/messages');
      expect(request.headers['x-api-key']).toBe(fake.apiKey);
    }
  });

  it('prices the tokens when it is given prices, and runs each case as often as asked', async () => {
    enqueueAnswers();
    enqueueAnswers();

    const { report, text } = await runLive(
      options({
        runs: 2,
        prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: null },
      }),
    );

    expect(report.reviews).toBe(2);
    expect(report.total.problems).toBe(2);
    expect(report.costUsd).toBeCloseTo(
      (report.tokens.input * 3 + report.tokens.output * 15) / 1_000_000,
      9,
    );
    expect(text).toMatch(/cost: \$\d/);
  });

  describe('with models for the tiers', () => {
    /** The role and the model of each call the provider received. */
    const sent = () =>
      fake.requests.map((request) => [
        reviewRoleOf(request),
        (request.json as { model: string }).model,
      ]);
    const TIERS = { strongModel: 'strong-model', fastModel: 'fast-model' };
    /** One answer for each call the review may make: no findings. */
    const enqueueEmpty = () => {
      fake.enqueue(...Array.from({ length: 12 }, () => reviewResponder()));
    };

    it('sends the judge to the strong model and the specialists of a lite review to the standard one', async () => {
      enqueueEmpty();

      await runLive(options({ ...TIERS, cases: ['ts-off-by-one'] }));

      expect(sent()).toEqual([
        ['quality', 'fake-model'],
        ['tests', 'fake-model'],
        ['judge', 'strong-model'],
      ]);
    });

    it('sends the quality reviewer of a trivial review to the fast model', async () => {
      enqueueEmpty();

      await runLive(options({ ...TIERS, cases: ['java-optional-get'] }));

      expect(sent()).toEqual([
        ['quality', 'fast-model'],
        ['judge', 'strong-model'],
      ]);
    });

    it('sends every call to the model when no tier has a model of its own', async () => {
      enqueueEmpty();

      await runLive(options({ cases: ['ts-off-by-one', 'java-optional-get'] }));

      expect(sent().map(([, model]) => model)).toEqual(Array(5).fill('fake-model'));
    });

    it('sends a call to the model of its tier through an Anthropic provider too', async () => {
      enqueueEmpty();

      await runLive(
        options({
          ...TIERS,
          kind: 'anthropic',
          url: fake.anthropicBaseUrl,
          cases: ['java-optional-get'],
        }),
      );

      expect(fake.requests.map((request) => request.path)).toEqual([
        '/v1/messages',
        '/v1/messages',
      ]);
      expect(sent()).toEqual([
        ['quality', 'fast-model'],
        ['judge', 'strong-model'],
      ]);
    });

    it('prices each call at the prices of its model', async () => {
      const prices = {
        prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: null },
        strongPrices: { inputUsdPerMTok: 15, outputUsdPerMTok: 75, cachedInputUsdPerMTok: null },
        fastPrices: { inputUsdPerMTok: 1, outputUsdPerMTok: 5, cachedInputUsdPerMTok: null },
      };
      // Every call spends 1 000 tokens in and 100 out. A trivial review: a fast call and a strong one.
      enqueueEmpty();
      const trivial = await runLive(options({ ...TIERS, ...prices, cases: ['java-optional-get'] }));
      expect(trivial.report.costUsd).toBeCloseTo(
        (1_000 * 1 + 100 * 5 + 1_000 * 15 + 100 * 75) / 1e6,
        9,
      );
      // A lite review: two standard calls and a strong one.
      enqueueEmpty();
      const lite = await runLive(options({ ...TIERS, ...prices, cases: ['ts-off-by-one'] }));
      expect(lite.report.costUsd).toBeCloseTo(
        (2 * (1_000 * 3 + 100 * 15) + (1_000 * 15 + 100 * 75)) / 1e6,
        9,
      );
      expect(lite.text).toMatch(/cost: \$0\.0315/);
    });

    it('prices a tier that has no model of its own at the standard prices, and its pair is not read', async () => {
      enqueueEmpty();

      const { report } = await runLive(
        options({
          strongModel: 'strong-model',
          prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: null },
          strongPrices: { inputUsdPerMTok: 15, outputUsdPerMTok: 75, cachedInputUsdPerMTok: null },
          // The fast tier uses the model: this pair is another model's, and no call is costed at it.
          fastPrices: { inputUsdPerMTok: 900, outputUsdPerMTok: 900, cachedInputUsdPerMTok: null },
          cases: ['java-optional-get'],
        }),
      );

      expect(report.costUsd).toBeCloseTo((1_000 * 3 + 100 * 15 + (1_000 * 15 + 100 * 75)) / 1e6, 9);
    });

    it('has no cost when a model of its own has no prices, rather than the standard prices for it', async () => {
      enqueueEmpty();

      const { report, text } = await runLive(
        options({
          ...TIERS,
          prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: null },
          cases: ['java-optional-get'],
        }),
      );

      expect(report.costUsd).toBeNull();
      expect(text).not.toContain('cost:');
    });

    it('names each tier’s model on the model line, and only the model when no tier has one', async () => {
      enqueueEmpty();
      const tiered = await runLive(options({ ...TIERS, cases: ['java-optional-get'] }));
      expect(tiered.text).toContain(
        'model: fake-model (openai), strong strong-model, fast fast-model',
      );

      // A tier without a model of its own is named with the model it runs on.
      enqueueEmpty();
      const some = await runLive(
        options({ fastModel: 'fast-model', cases: ['java-optional-get'] }),
      );
      expect(some.text).toContain('model: fake-model (openai), strong fake-model, fast fast-model');

      enqueueEmpty();
      const plain = await runLive(options({ cases: ['java-optional-get'] }));
      expect(plain.text).toContain('model: fake-model (openai)\n');
      expect(plain.text).not.toContain('strong');
    });

    it('refuses to return a text that holds the key in a tier model', async () => {
      enqueueEmpty();
      await expect(
        runLive(options({ strongModel: fake.apiKey, cases: ['java-optional-get'] })),
      ).rejects.toThrow(/would hold the API key/);
    });
  });

  it('counts a review the provider refuses as failed, and says how the calls failed', async () => {
    const { report, text } = await runLive(options({ apiKey: WRONG_KEY }));

    expect(report.failed).toEqual({ provider_error: 1 });
    expect(report.total).toMatchObject({ problems: 1, found: 0 });
    expect(text).toContain('failed reviews: 1 (provider_error 1)');
    expect(text).toContain('provider failures: refused_key 1');
    expect(text).not.toContain(WRONG_KEY);
  });

  it('works without a key, for a local model', async () => {
    const local = await createFakeLlm({ apiKey: null });
    try {
      local.enqueue(...Array.from({ length: 12 }, () => ANSWERS));
      const { report } = await runLive(options({ url: local.openAiBaseUrl, apiKey: null }));
      expect(report.total).toMatchObject({ problems: 1, found: 1 });
      for (const request of local.requests) {
        for (const header of ['authorization', 'api-key', 'x-api-key']) {
          expect(request.headers).not.toHaveProperty(header);
        }
      }
    } finally {
      await local.close();
    }
  });

  it('refuses a URL the server would refuse before any call', async () => {
    const url = `http://user:pw@${fake.host}/v1`;
    await expect(runLive(options({ url }))).rejects.toThrow(/credentials/);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a case that does not exist before any call', async () => {
    await expect(runLive(options({ cases: ['ts-off-by-one', 'no-such-case'] }))).rejects.toThrow(
      /no such case: no-such-case/,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses to return a text that holds the key', async () => {
    enqueueAnswers();
    // A model named like the key puts it in the report's header.
    await expect(runLive(options({ model: fake.apiKey, apiKey: fake.apiKey }))).rejects.toThrow(
      /would hold the API key/,
    );
  });
});
