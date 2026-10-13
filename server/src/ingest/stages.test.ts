import { describe, expect, it } from 'vitest';
import { notificationStage } from '../notifications/stage';
import { webhookStage } from '../webhooks/stage';
import { DEFAULT_STAGES } from './stages';

describe('DEFAULT_STAGES', () => {
  it('ends with the webhook stage, then only the notification stage, which writes no analysis', () => {
    expect(DEFAULT_STAGES.at(-2)).toBe(webhookStage);
    expect(DEFAULT_STAGES.at(-1)).toBe(notificationStage);
    expect(DEFAULT_STAGES.filter((s) => s === webhookStage)).toHaveLength(1);
    expect(DEFAULT_STAGES.filter((s) => s === notificationStage)).toHaveLength(1);
  });
});
