import type { GateResult } from '@qualor/shared';
import type { GateStatus, WebhookKind } from '../../db/schema';
import { gateEvent } from '../../notifications/gate';
import type { NewDelivery } from '../deliveries';
import { isChatKind } from './kinds';
import { MAX_FAILED_CONDITIONS, type ChatGateMessage } from './messages';

export interface ChatGateInput {
  project: { id: string; key: string; name: string };
  branch: { id: string; name: string; isMain: boolean };
  analysisId: string;
  revision: string | null;
  /** When the verdict was reached: the analysis' finish, or the re-evaluation's time. */
  at: Date;
  previous: GateStatus | null;
  next: GateResult;
  measures: Readonly<Record<string, number | null | undefined>>;
  cause: 'analysis' | 'reevaluation';
}

const count = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/**
 * 6G spec D2: a main branch's gate became failed, or passes again after failing — the email
 * notifications' rule (`gateEvent`). Null for any other branch or transition.
 */
export function chatGateMessage(input: ChatGateInput): ChatGateMessage | null {
  if (!input.branch.isMain) return null;
  const event = gateEvent(input.previous, input.next.status);
  if (event === null) return null;
  const failed = input.next.conditions.filter((c) => c.status === 'failed');
  return {
    type: 'gate',
    event,
    cause: input.cause,
    project: { id: input.project.id, key: input.project.key, name: input.project.name },
    branch: { id: input.branch.id, name: input.branch.name },
    analysisId: input.analysisId,
    revision: input.revision,
    at: input.at.toISOString(),
    gate: { name: input.next.gate?.name ?? null, status: input.next.status },
    failed: failed.slice(0, MAX_FAILED_CONDITIONS).map((c) => ({
      metric: c.metric,
      operator: c.operator,
      threshold: c.threshold,
      value: c.value,
    })),
    failedCount: failed.length,
    newIssues: {
      security: count(input.measures.new_security_issues),
      reliability: count(input.measures.new_reliability_issues),
      maintainability: count(input.measures.new_maintainability_issues),
    },
  };
}

/** One delivery per chat webhook that subscribes to the event; none for generic webhooks. */
export function chatGateDeliveries(
  subscriptions: readonly { id: string; kind: WebhookKind; events: readonly string[] }[],
  input: ChatGateInput,
): NewDelivery[] {
  const message = chatGateMessage(input);
  if (message === null) return [];
  return subscriptions
    .filter((s) => isChatKind(s.kind) && s.events.includes(message.event))
    .map((s) => ({ subscriptionId: s.id, event: message.event, payload: message }));
}
