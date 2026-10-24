import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFakeLlm,
  openAiToolCalls,
  type FakeLlm,
  type LlmResponder,
} from '../../server/test/fake-llm';
import { reviewResponder } from '../../server/test/review';
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
      apiKey: null,
      runs: 1,
      cases: null,
      prices: null,
    });
  });

  it('reads every variable', () => {
    expect(
      readLiveEnv({
        ...base,
        QUALOR_LIVE_REVIEW_KIND: 'anthropic',
        QUALOR_LIVE_REVIEW_API_KEY: KEY,
        QUALOR_LIVE_REVIEW_RUNS: '5',
        QUALOR_LIVE_REVIEW_CASES: ' ts-off-by-one, go-map-race ,,',
        QUALOR_LIVE_REVIEW_PRICE_IN: '3',
        QUALOR_LIVE_REVIEW_PRICE_OUT: '15.5',
      }),
    ).toEqual({
      url: 'https://llm.invalid',
      model: 'm',
      kind: 'anthropic',
      apiKey: KEY,
      runs: 5,
      cases: ['ts-off-by-one', 'go-map-race'],
      prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15.5 },
    });
  });

  it('reports a cost only with both prices', () => {
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_PRICE_IN: '3' }).prices).toBeNull();
    expect(readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_PRICE_OUT: '15' }).prices).toBeNull();
    expect(
      readLiveEnv({ ...base, QUALOR_LIVE_REVIEW_PRICE_IN: '0', QUALOR_LIVE_REVIEW_PRICE_OUT: '0' })
        .prices,
    ).toEqual({ inputUsdPerMTok: 0, outputUsdPerMTok: 0 });
  });

  it.each([
    ['QUALOR_LIVE_REVIEW_KIND', 'gemini'],
    ['QUALOR_LIVE_REVIEW_RUNS', '0'],
    ['QUALOR_LIVE_REVIEW_RUNS', '6'],
    ['QUALOR_LIVE_REVIEW_RUNS', '1.5'],
    ['QUALOR_LIVE_REVIEW_RUNS', 'many'],
    ['QUALOR_LIVE_REVIEW_PRICE_IN', '-1'],
    ['QUALOR_LIVE_REVIEW_PRICE_IN', 'free'],
    ['QUALOR_LIVE_REVIEW_PRICE_OUT', '10001'],
    ['QUALOR_LIVE_REVIEW_API_KEY', 'a key with spaces'],
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
  const of = (url: string, kind: LiveOptions['kind'] = 'openai') =>
    providerOf({ url, model: 'm', kind });

  it('settles a call as the AI settings would store it', () => {
    expect(of('http://localhost:11434/v1/').config).toEqual({
      kind: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      auth: 'bearer',
      jsonMode: 'none',
      maxTokensField: 'max_tokens',
      temperature: null,
      timeoutSeconds: 60,
    });
    expect(of('https://api.anthropic.com', 'anthropic').config).toMatchObject({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
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
    apiKey: fake.apiKey,
    runs: 1,
    cases: ['ts-off-by-one'],
    prices: null,
    ...over,
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
    expect(text).toContain('1 cases (0 clean), 1 run each, 1 reviews');
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
      options({ runs: 2, prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } }),
    );

    expect(report.reviews).toBe(2);
    expect(report.total.problems).toBe(2);
    expect(report.costUsd).toBeCloseTo(
      (report.tokens.input * 3 + report.tokens.output * 15) / 1_000_000,
      9,
    );
    expect(text).toMatch(/cost: \$\d/);
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
