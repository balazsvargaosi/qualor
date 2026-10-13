import { and, asc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { memberships, notificationPreferences, users } from '../db/schema';
import { queueMail, type MailDeps, type QueueMailResult } from '../mail/outbox';
import type { RenderedMail } from '../mail/payload';
import { mailConfigured } from '../mail/settings';
import { publicLink } from '../mail/templates/text';
import type { Watcher } from './recipients';

/**
 * mail E3 N6: the administrators (role `admin`) of the organisation who get its failing-webhook
 * alert: active, with an address, both switches on (notification email and failing webhooks),
 * and, while E1's instance alert reaches every instance administrator anyway
 * (`excludeInstanceAdmins`), no instance administrator: nobody gets the alert twice.
 */
export async function orgAdminsForWebhookAlert(
  tx: Executor,
  organizationId: string,
  options: { excludeInstanceAdmins: boolean },
): Promise<Watcher[]> {
  const conditions: SQL[] = [
    eq(memberships.organizationId, organizationId),
    eq(memberships.role, 'admin'),
    eq(users.active, true),
    isNotNull(users.email),
    sql`${notificationPreferences.email} IS NOT FALSE`,
    sql`${notificationPreferences.orgWebhookFailures} IS NOT FALSE`,
  ];
  if (options.excludeInstanceAdmins) conditions.push(eq(users.isInstanceAdmin, false));
  const rows = await tx
    .select({
      userId: users.id,
      email: users.email,
      username: users.username,
      displayName: users.displayName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
    .where(and(...conditions))
    .orderBy(asc(users.email), asc(users.id));
  return rows.flatMap((r) => (r.email === null ? [] : [{ ...r, email: r.email }]));
}

/**
 * Queues the alert to each of them in `tx` (the delivery's transaction), with E1's dedupe key
 * (one per address and webhook a day, whichever of the two alerts came first). `render` gets the
 * Notification settings URL for the footer link (null without QUALOR_PUBLIC_URL).
 */
export async function queueOrgWebhookAlerts(
  tx: Executor,
  deps: MailDeps,
  input: {
    organizationId: string;
    dedupe: { key: string; withinHours: number };
    instanceAlertsOn: boolean;
    render: (settingsUrl: string | null) => RenderedMail;
  },
): Promise<QueueMailResult[]> {
  // Email is not configured: nobody gets anything, so do not even look for recipients.
  if (!(await mailConfigured(tx, deps.config))) return [];
  const admins = await orgAdminsForWebhookAlert(tx, input.organizationId, {
    excludeInstanceAdmins: input.instanceAlertsOn,
  });
  const settingsUrl = publicLink(deps.config.publicUrl, '/settings/notifications');
  const results: QueueMailResult[] = [];
  for (const admin of admins) {
    results.push(
      await queueMail(tx, deps, {
        kind: 'webhook.failed',
        to: { address: admin.email, userId: admin.userId },
        render: () => input.render(settingsUrl),
        dedupe: input.dedupe,
      }),
    );
  }
  return results;
}
