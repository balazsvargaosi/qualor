import { eq } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { organizations, projects } from '../../db/schema';
import { queueMailToAdmins, type MailDeps, type QueueMailResult } from '../outbox';
import { readMailSettings } from '../settings';
import { renderWebhookFailed } from '../templates/webhook-failed';

/** E1 spec: at most one alert per administrator and webhook in this many hours. */
export const WEBHOOK_ALERT_DEDUPE_HOURS = 24;

export function webhookAlertDedupeKey(webhookId: string): string {
  return `webhook.failed:${webhookId}`;
}

export interface FailedDelivery {
  webhookId: string;
  organizationId: string;
  projectId: string | null;
  url: string;
  /** The attempts made, the last one included. */
  attempts: number;
  /** The receiver's last HTTP status, or null when it never answered. */
  responseCode: number | null;
}

/** The receiver's host and port, never the path or the query (they may hold a secret). */
function receiverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the receiver';
  }
}

/**
 * E1 spec: a webhook delivery gave up. While `alerts.webhookFailures` is on, every instance
 * administrator with an email address gets one alert, at most once a day per webhook, in the
 * transaction that recorded the failure (webhooks/deliver.ts, under that webhook's delivery lock).
 */
export async function alertWebhookFailed(
  tx: Executor,
  deps: MailDeps,
  delivery: FailedDelivery,
): Promise<QueueMailResult[]> {
  if (!(await readMailSettings(tx)).alerts.webhookFailures) return [];
  const [org] = await tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, delivery.organizationId));
  const [project] =
    delivery.projectId === null
      ? []
      : await tx
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, delivery.projectId));
  const host = receiverHost(delivery.url);
  return queueMailToAdmins(tx, deps, {
    kind: 'webhook.failed',
    dedupe: {
      key: webhookAlertDedupeKey(delivery.webhookId),
      withinHours: WEBHOOK_ALERT_DEDUPE_HOURS,
    },
    render: () =>
      renderWebhookFailed({
        organization: org?.name ?? 'an organization',
        project: project?.name ?? null,
        receiverHost: host,
        lastResponse: delivery.responseCode,
        attempts: delivery.attempts,
        publicUrl: deps.config.publicUrl,
      }),
  });
}
