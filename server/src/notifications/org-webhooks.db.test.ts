import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createTestContext,
  createUser,
  organizationId,
  type TestContext,
} from '../../test/app';
import { MAIL_ON, payloadOf, queued } from '../../test/notify';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { first } from '../db/rows';
import {
  instanceSettings,
  notificationPreferences,
  webhookDeliveries,
  webhookSubscriptions,
} from '../db/schema';
import { webhookAlertDedupeKey } from '../mail/alerts/webhook-alerts';
import { mailDeps } from '../mail/outbox';
import { writeMailSettings } from '../mail/settings';
import { deliverWebhook, MAX_DELIVERY_ATTEMPTS } from '../webhooks/deliver';
import { createDelivery, WEBHOOK_SECRET_AAD } from '../webhooks/deliveries';
import { orgAdminsForWebhookAlert } from './org-webhooks';

describe('failing-webhook email for organisation administrators (mail E3 N6)', () => {
  let ctx: TestContext;
  let org: string;
  let receiver: Server;
  let url: string;
  const ids: Record<string, string> = {};

  const admin = async (
    username: string,
    options: {
      email?: string | null;
      active?: boolean;
      instance?: boolean;
      role?: 'admin' | 'member';
    } = {},
  ) => {
    const user = await createUser(ctx, {
      username,
      email: options.email === undefined ? `${username}@example.com` : options.email,
      active: options.active ?? true,
      isInstanceAdmin: options.instance ?? false,
    });
    await addMember(ctx, org, user.id, options.role ?? 'admin');
    ids[username] = user.id;
  };
  const names = (rows: { username: string }[]) => rows.map((r) => r.username).sort();
  /** An active webhook whose receiver answers 503 (E1 alerts only for an active webhook). */
  const webhook = async (): Promise<string> =>
    first(
      await ctx.db
        .insert(webhookSubscriptions)
        .values({
          organizationId: org,
          url,
          secretEnc: encryptSecret(
            encryptionKey(ctx.config.secretKey),
            'whsec_e3test',
            WEBHOOK_SECRET_AAD,
          ),
          events: ['analysis.completed'],
          active: true,
        })
        .returning({ id: webhookSubscriptions.id }),
    ).id;
  /** A delivery on its last attempt, answered 503: it gives up, and E1's hook alerts. */
  const fail = async (webhookId: string) => {
    const id = await ctx.db.transaction((tx) =>
      createDelivery(tx, { subscriptionId: webhookId, event: 'analysis.completed', payload: {} }),
    );
    await ctx.db
      .update(webhookDeliveries)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })
      .where(eq(webhookDeliveries.id, id));
    const result = await deliverWebhook(
      { db: ctx.db, secretKey: ctx.config.secretKey, timeoutMs: 1_000, mail: mailDeps(ctx.config) },
      id,
      MAX_DELIVERY_ATTEMPTS - 1,
    );
    expect(result).toBe('failed');
  };
  const alertsFor = async (webhookId: string) =>
    (await queued(ctx.db, 'webhook.failed'))
      .filter((m) => m.dedupeKey === webhookAlertDedupeKey(webhookId))
      .sort((a, b) => a.toAddress.localeCompare(b.toAddress));
  const instanceAlert = (webhookFailures: boolean) =>
    ctx.db.transaction((tx) =>
      writeMailSettings(tx, { alerts: { webhookFailures } }, ctx.config.secretKey),
    );

  beforeAll(async () => {
    ctx = await createTestContext({ config: MAIL_ON });
    org = await organizationId(ctx, 'default');
    // As E1's webhook-alert test: the receiver is on 127.0.0.1 over plain HTTP.
    await ctx.db
      .insert(instanceSettings)
      .values({ key: 'webhooks', value: { allowHttp: true, allowInternalHosts: true } });
    receiver = createServer((_req, res) => {
      res.writeHead(503).end('down');
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    // The bootstrap `admin` (instance and organisation administrator) has no address: never mailed.
    await admin('oa-on');
    await admin('oa-off');
    await ctx.db
      .insert(notificationPreferences)
      .values({ userId: ids['oa-off']!, orgWebhookFailures: false });
    await admin('oa-mute');
    await ctx.db.insert(notificationPreferences).values({ userId: ids['oa-mute']!, email: false });
    await admin('oa-inactive', { active: false });
    await admin('oa-noemail', { email: null });
    await admin('member', { role: 'member' });
    await admin('both', { instance: true });
  });
  beforeEach(async () => {
    await instanceAlert(true);
  });
  afterAll(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await ctx.close();
  });

  it('lists the active org admins with an address whose switches are on', async () => {
    expect(
      names(await orgAdminsForWebhookAlert(ctx.db, org, { excludeInstanceAdmins: true })),
    ).toEqual(['oa-on']);
    expect(
      names(await orgAdminsForWebhookAlert(ctx.db, org, { excludeInstanceAdmins: false })),
    ).toEqual(['both', 'oa-on']);
  });

  it('mails each org admin once per webhook and day, and an instance admin who is one only once', async () => {
    const hook = await webhook();
    await fail(hook);
    const rows = await alertsFor(hook);
    expect(rows.map((m) => m.toAddress)).toEqual(['both@example.com', 'oa-on@example.com']);
    const orgMail = payloadOf(
      rows.find((m) => m.toAddress === 'oa-on@example.com')!,
      ctx.config.secretKey,
    );
    const orgText = orgMail.text.replace(/\s+/g, ' ');
    expect(orgText).toContain('You get this because you are an administrator of Default.');
    expect(orgText).toContain(
      'Notification settings: https://qualor.example.com/settings/notifications',
    );
    expect(orgMail.html).toContain('href="https://qualor.example.com/settings/notifications"');
    // The instance administrator got E1's instance alert, not the organisation one.
    const instanceMail = payloadOf(rows[0]!, ctx.config.secretKey);
    expect(instanceMail.text).toContain('instance administrator');
    expect(instanceMail.text).not.toContain(
      'You get this because you are an administrator of Default.',
    );
    await fail(hook);
    expect(await alertsFor(hook)).toHaveLength(2);
  });

  it('mails an instance administrator as org admin while the instance alert is off', async () => {
    await instanceAlert(false);
    const hook = await webhook();
    await fail(hook);
    const rows = await alertsFor(hook);
    expect(rows.map((m) => m.toAddress)).toEqual(['both@example.com', 'oa-on@example.com']);
    expect(payloadOf(rows[0]!, ctx.config.secretKey).text.replace(/\s+/g, ' ')).toContain(
      'You get this because you are an administrator of Default.',
    );
  });
});
