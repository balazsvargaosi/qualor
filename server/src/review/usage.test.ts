import { describe, expect, it } from 'vitest';
import type { StoredLlmSettings, StoredProvider } from '../llm/settings';
import { REVIEW_CALL_MIN_TIMEOUT_SECONDS, reviewCallSettings } from './usage';

const provider = (timeoutSeconds: number): StoredProvider => ({
  kind: 'openai',
  baseUrl: 'https://llm.example.test/v1',
  model: 'some-model',
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_completion_tokens',
  temperature: null,
  timeoutSeconds,
  apiKeyEnc: null,
});

const settings = (p: StoredProvider | null): StoredLlmSettings =>
  ({ provider: p, organizations: {}, excludePaths: [] }) as unknown as StoredLlmSettings;

describe('reviewCallSettings', () => {
  it('lets a review call wait at least five minutes, whatever the assistant waits', () => {
    expect(REVIEW_CALL_MIN_TIMEOUT_SECONDS).toBe(300);
    expect(reviewCallSettings(settings(provider(60))).provider?.timeoutSeconds).toBe(300);
    expect(reviewCallSettings(settings(provider(5))).provider?.timeoutSeconds).toBe(300);
  });

  it('keeps a longer timeout the admin set, and the settings themselves', () => {
    const long = settings(provider(600));
    expect(reviewCallSettings(long)).toBe(long);
    expect(reviewCallSettings(settings(provider(300))).provider?.timeoutSeconds).toBe(300);
  });

  it('changes nothing else, and leaves the stored settings as they are', () => {
    const short = settings(provider(60));
    const raised = reviewCallSettings(short);
    expect(raised.provider).toEqual({ ...provider(60), timeoutSeconds: 300 });
    expect(raised.organizations).toBe(short.organizations);
    expect(short.provider?.timeoutSeconds).toBe(60);
  });

  it('leaves settings without a provider alone', () => {
    const none = settings(null);
    expect(reviewCallSettings(none)).toBe(none);
  });
});
