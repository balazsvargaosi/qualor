import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freshTest, providerTestOf, testFingerprint, type StoredTest } from './last-test';
import { DEFAULT_LLM_SETTINGS, type StoredLlmSettings, type StoredProvider } from './settings';

/** A key's envelope as stored. Only its IV is part of the fingerprint. */
const KEY = {
  v: 1 as const,
  iv: 'Zml4dHVyZS1pdi0x',
  ct: 'Y2lwaGVydGV4dC1vZi10aGUta2V5',
  tag: 'dGFnLTE2LWJ5dGVzLS0t',
};
/** A provider with a model of its own for each tier, and a key. */
const TIERED: StoredProvider = {
  kind: 'openai',
  api: 'chat_completions',
  baseUrl: 'https://llm.example/v1',
  model: 'gpt-5.6-terra',
  strongModel: 'gpt-6.1-sol',
  fastModel: 'gpt-6-luna',
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_tokens',
  temperature: null,
  workspaceId: null,
  timeoutSeconds: 60,
  contextWindowTokens: null,
  apiKeyEnc: KEY,
};

const settingsWith = (provider: StoredProvider | null): StoredLlmSettings => ({
  ...DEFAULT_LLM_SETTINGS,
  provider,
});

type Line = StoredTest['models'][number];
const line = (tier: Line['tier'], model: string, toolCalling: Line['toolCalling']): Line => ({
  tier,
  model,
  ok: true,
  toolCalling,
  problemCode: null,
});
/** The record of a Test of `provider`: an instance admin pressed Test on 2026-10-26. */
const testOf = (provider: StoredProvider, models: StoredTest['models']): StoredTest => ({
  v: 1,
  at: '2026-10-26T14:02:00.000Z',
  userId: '0190a6c2-0000-7000-8000-00000000000a',
  fingerprint: testFingerprint(provider),
  models,
});

const TESTED = testOf(TIERED, [
  line('standard', 'gpt-5.6-terra', 'supported'),
  line('strong', 'gpt-6.1-sol', 'supported'),
  line('fast', 'gpt-6-luna', 'not_supported'),
]);

describe('testFingerprint', () => {
  it('is the SHA-256 of the provider as calls see it and the IV of its key, with its keys sorted', () => {
    // A stored record is compared with this after an upgrade: the scheme must not drift.
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          api: 'chat_completions',
          auth: 'bearer',
          baseUrl: 'https://llm.example/v1',
          fastModel: 'gpt-6-luna',
          jsonMode: 'json_object',
          keyIv: KEY.iv,
          kind: 'openai',
          maxTokensField: 'max_tokens',
          model: 'gpt-5.6-terra',
          strongModel: 'gpt-6.1-sol',
          temperature: null,
          timeoutSeconds: 60,
          workspaceId: null,
        }),
      )
      .digest('hex');
    expect(testFingerprint(TIERED)).toBe(expected);
  });

  it('takes nothing of the key but the IV of its envelope: not its ciphertext, not its tag', () => {
    const other = { ...KEY, ct: 'another-ciphertext', tag: 'another-tag' };
    expect(testFingerprint({ ...TIERED, apiKeyEnc: other })).toBe(testFingerprint(TIERED));
    expect(testFingerprint(TIERED)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves out the model's context window: a change of it keeps the Test (R46)", () => {
    for (const contextWindowTokens of [8_000, 32_000, 10_000_000]) {
      const windowed = { ...TIERED, contextWindowTokens };
      expect(testFingerprint(windowed)).toBe(testFingerprint(TIERED));
      expect(freshTest(settingsWith(windowed), TESTED)).toEqual(TESTED);
    }
  });
});

describe('freshTest', () => {
  it('is the record, for the provider it tested', () => {
    expect(freshTest(settingsWith(TIERED), TESTED)).toEqual(TESTED);
  });

  it.each<[string, Partial<StoredProvider>]>([
    ['the standard model', { model: 'other' }],
    ['the strong model', { strongModel: 'other' }],
    ['the fast model, removed', { fastModel: null }],
    ['the address', { baseUrl: 'https://llm.example/v2' }],
    ['the kind', { kind: 'anthropic' }],
    ['the API', { api: 'responses' }],
    ['the header of the key', { auth: 'api-key' }],
    ['the JSON mode', { jsonMode: 'none' }],
    ['the field of the output limit', { maxTokensField: 'max_completion_tokens' }],
    ['the temperature', { temperature: 0.2 }],
    ['the workspace', { workspaceId: 'wrkspc_abc123' }],
    ['the timeout', { timeoutSeconds: 61 }],
    ['the key, set again', { apiKeyEnc: { ...KEY, iv: 'AAAA' } }],
    ['the key, removed', { apiKeyEnc: null }],
  ])('is stale after a change of %s', (_what, change) => {
    expect(freshTest(settingsWith({ ...TIERED, ...change }), TESTED)).toBeNull();
  });

  it('is none without a provider, and without a record', () => {
    expect(freshTest(settingsWith(null), TESTED)).toBeNull();
    expect(freshTest(settingsWith(TIERED), null)).toBeNull();
  });

  it('is not stale after a change the calls never see: the temperature of an Anthropic provider', () => {
    const anthropic: StoredProvider = {
      ...TIERED,
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.example',
      strongModel: null,
      fastModel: null,
      workspaceId: 'wrkspc_abc123',
    };
    const tested = testOf(anthropic, [line('standard', 'gpt-5.6-terra', 'supported')]);
    expect(freshTest(settingsWith({ ...anthropic, temperature: 0.7 }), tested)).toEqual(tested);
  });
});

describe('providerTestOf', () => {
  it('names the models that cannot call tools', () => {
    expect(providerTestOf(settingsWith(TIERED), TESTED)).toEqual({
      at: TESTED.at,
      toolCalling: 'not_supported',
      modelsWithoutTools: ['gpt-6-luna'],
    });
  });

  it('lists them once each and sorted, as the models of a provider are listed', () => {
    const tested = testOf(TIERED, [
      line('standard', 'gpt-5.6-terra', 'supported'),
      line('strong', 'gpt-6.1-sol', 'not_supported'),
      line('fast', 'gpt-6-luna', 'not_supported'),
    ]);
    // The tiers list the strong model first; the names sort the other way round.
    expect(providerTestOf(settingsWith(TIERED), tested).modelsWithoutTools).toEqual([
      'gpt-6-luna',
      'gpt-6.1-sol',
    ]);
  });

  it('says supported only when every model of the provider called the tool', () => {
    const allSupported = testOf(TIERED, [
      line('standard', 'gpt-5.6-terra', 'supported'),
      line('strong', 'gpt-6.1-sol', 'supported'),
      line('fast', 'gpt-6-luna', 'supported'),
    ]);
    const oneNotChecked = testOf(TIERED, [
      line('standard', 'gpt-5.6-terra', 'supported'),
      line('strong', 'gpt-6.1-sol', 'supported'),
      line('fast', 'gpt-6-luna', 'not_checked'),
    ]);
    expect(providerTestOf(settingsWith(TIERED), allSupported)).toEqual({
      at: allSupported.at,
      toolCalling: 'supported',
      modelsWithoutTools: [],
    });
    // A Test that could not tell for one model says nothing of the provider, but when it ran.
    expect(providerTestOf(settingsWith(TIERED), oneNotChecked)).toEqual({
      at: oneNotChecked.at,
      toolCalling: 'unknown',
      modelsWithoutTools: [],
    });
    expect(providerTestOf(settingsWith(TIERED), null)).toEqual({
      at: null,
      toolCalling: 'unknown',
      modelsWithoutTools: [],
    });
  });

  it('counts a model that two tiers name once', () => {
    const shared: StoredProvider = { ...TIERED, strongModel: TIERED.model, fastModel: null };
    const tested = testOf(shared, [line('standard', 'gpt-5.6-terra', 'supported')]);
    expect(providerTestOf(settingsWith(shared), tested).toolCalling).toBe('supported');
  });

  it('knows nothing of a Test that the provider has outlived', () => {
    // The strong model was swapped after the Test: its warning no longer concerns the provider.
    expect(providerTestOf(settingsWith({ ...TIERED, strongModel: 'other' }), TESTED)).toEqual({
      at: null,
      toolCalling: 'unknown',
      modelsWithoutTools: [],
    });
    expect(providerTestOf(settingsWith(null), TESTED).toolCalling).toBe('unknown');
  });
});
