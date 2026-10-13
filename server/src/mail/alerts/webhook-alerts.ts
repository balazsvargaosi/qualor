import { eq } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { organizations, projects } from '../../db/schema';
import { queueOrgWebhookAlerts } from '../../notifications/org-webhooks';
import { queueMailToAdmins, type MailDeps, type QueueMailResult } from '../outbox';
import { readMailSettings } from '../settings';
import { orgAdminFooterLinks, orgAdminReason } from '../templates/notify-common';
import { renderWebhookFailed, type WebhookFailedInput } from '../templates/webhook-failed';

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
 * administrator with an email address gets one alert, and, by their own switches, the
 * organisation's administrators (mail E3), at most once a day per webhook and address, in the
 * transaction that recorded the failure (webhooks/deliver.ts, under that webhook's delivery lock).
 */
export async function alertWebhookFailed(
  tx: Executor,
  deps: MailDeps,
  delivery: FailedDelivery,
): Promise<QueueMailResult[]> {
  const instanceAlertsOn = (await readMailSettings(tx)).alerts.webhookFailures;
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
  const data: WebhookFailedInput = {
    organization: org?.name ?? 'an organization',
    project: project?.name ?? null,
    receiverHost: receiverHost(delivery.url),
    lastResponse: delivery.responseCode,
    attempts: delivery.attempts,
    publicUrl: deps.config.publicUrl,
  };
  const dedupe = {
    key: webhookAlertDedupeKey(delivery.webhookId),
    withinHours: WEBHOOK_ALERT_DEDUPE_HOURS,
  };
  const forInstance = instanceAlertsOn
    ? await queueMailToAdmins(tx, deps, {
        kind: 'webhook.failed',
        dedupe,
        render: () => renderWebhookFailed(data),
      })
    : [];
  // mail E3 N6: the organisation's administrators, by their own switches; no instance
  // administrator twice while the instance alert reaches them anyway.
  const forOrganization = await queueOrgWebhookAlerts(tx, deps, {
    organizationId: delivery.organizationId,
    dedupe,
    instanceAlertsOn,
    render: (settingsUrl) =>
      renderWebhookFailed({
        ...data,
        reason: orgAdminReason(data.organization),
        footerLinks: orgAdminFooterLinks(settingsUrl),
      }),
  });
  return [...forInstance, ...forOrganization];
}
