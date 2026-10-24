import { LLM_FEATURES } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import type { LlmRequestRow } from '../db/schema';
import { aiRequestDto } from './dto';

/** A succeeded request of `feature`, as the table holds it. */
function requestOf(feature: LlmRequestRow['feature']): LlmRequestRow {
  return {
    id: '01900000-0000-7000-8000-000000000001',
    organizationId: '01900000-0000-7000-8000-000000000002',
    projectId: '01900000-0000-7000-8000-000000000003',
    issueId: '01900000-0000-7000-8000-000000000004',
    userId: null,
    feature,
    cacheKey: 'a'.repeat(64),
    provider: 'openai',
    providerHost: 'api.example.com',
    model: 'model-1',
    promptVersion: 'prompt.v1',
    status: 'succeeded',
    errorCode: null,
    attempts: 1,
    inputSha256: 'b'.repeat(64),
    inputBytes: 10,
    fields: ['rule'],
    redactions: 0,
    inputTokens: null,
    outputTokens: null,
    costMicroUsd: null,
    durationMs: null,
    result: null,
    prompt: null,
    post: null,
    createdAt: new Date('2026-10-24T08:00:00Z'),
    finishedAt: null,
    updatedAt: new Date('2026-10-24T08:00:00Z'),
  };
}

describe('aiRequestDto', () => {
  it.each(LLM_FEATURES)('describes a %s request', (feature) => {
    expect(aiRequestDto(requestOf(feature))).toMatchObject({ feature, status: 'succeeded' });
  });

  it.each(['review', 'review-reply'] as const)(
    'refuses the record of a %s call: it is no AI request',
    (feature) => {
      expect(() => aiRequestDto(requestOf(feature))).toThrow(
        'The record of a review call is not an AI request',
      );
    },
  );
});
