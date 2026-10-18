import { describe, expect, it } from 'vitest';
import { sendWebhook } from '../send';
import { chatLinks, formatChat } from './format';
import type { ChatGateMessage } from './messages';

/**
 * 6G spec §7: real messages to a real Slack and Teams channel. Never part of `pnpm test` or CI
 * (the unit project excludes `*.live.test.ts`); `pnpm chat:live` with QUALOR_SLACK_WEBHOOK_URL
 * and/or QUALOR_TEAMS_WEBHOOK_URL set. Look at the channel afterwards: the test only sees 2xx.
 */
const MESSAGE: ChatGateMessage = {
  type: 'gate',
  event: 'gate.failed',
  cause: 'analysis',
  project: {
    id: '0190a6c2-0000-7000-8000-0000000000a1',
    key: 'acme/payments',
    name: 'Payments <!here> *test*',
  },
  branch: { id: '0190a6c2-0000-7000-8000-0000000000b1', name: 'main' },
  analysisId: '0190a6c2-0000-7000-8000-0000000000c1',
  revision: '3f9c2e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
  at: new Date().toISOString(),
  gate: { name: 'Qualor way', status: 'failed' },
  failed: [
    { metric: 'new_issues', operator: 'gt', threshold: 0, value: 2 },
    { metric: 'new_coverage', operator: 'lt', threshold: 80, value: 61.5 },
  ],
  failedCount: 2,
  newIssues: { security: 2, reliability: 0, maintainability: 1 },
};

async function deliverLive(kind: 'slack' | 'teams', url: string) {
  return sendWebhook(
    {
      url,
      body: JSON.stringify(formatChat(kind, MESSAGE, chatLinks('https://qualor.example.com'))),
      headers: { 'content-type': 'application/json', 'user-agent': 'Qualor-Webhook/live-test' },
    },
    { allowInternalHosts: false, timeoutMs: 15_000 },
  );
}

describe('live webhooks', () => {
  const slack = process.env.QUALOR_SLACK_WEBHOOK_URL;
  const teams = process.env.QUALOR_TEAMS_WEBHOOK_URL;
  it('slack accepts a gate message', async (ctx) => {
    if (!slack) return ctx.skip();
    const outcome = await deliverLive('slack', slack);
    expect(outcome.ok, `${outcome.status} ${outcome.excerpt}`).toBe(true);
  });
  it('teams accepts a gate message', async (ctx) => {
    if (!teams) return ctx.skip();
    const outcome = await deliverLive('teams', teams);
    expect(outcome.ok, `${outcome.status} ${outcome.excerpt}`).toBe(true);
  });
});
