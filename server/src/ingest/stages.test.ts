import { describe, expect, it } from 'vitest';
import { licensePolicyStage } from '../licenses/stage';
import { notificationStage } from '../notifications/stage';
import { rulesStage } from '../rules/stage';
import { trackingStage } from '../tracking/stage';
import { webhookStage } from '../webhooks/stage';
import { DEFAULT_STAGES } from './stages';

describe('DEFAULT_STAGES', () => {
  it('ends with the webhook stage, then only the notification stage, which writes no analysis', () => {
    expect(DEFAULT_STAGES.at(-2)).toBe(webhookStage);
    expect(DEFAULT_STAGES.at(-1)).toBe(notificationStage);
    expect(DEFAULT_STAGES.filter((s) => s === webhookStage)).toHaveLength(1);
    expect(DEFAULT_STAGES.filter((s) => s === notificationStage)).toHaveLength(1);
  });

  it('judges licences after the rules stage and before tracking (6M §6)', () => {
    const at = DEFAULT_STAGES.indexOf(licensePolicyStage);
    expect(licensePolicyStage.name).toBe('license-policy');
    expect(DEFAULT_STAGES[at - 1]).toBe(rulesStage);
    expect(DEFAULT_STAGES[at + 1]).toBe(trackingStage);
  });
});
