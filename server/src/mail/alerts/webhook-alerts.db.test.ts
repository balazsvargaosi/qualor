import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, createUser, organizationId, type TestContext } from '../../../test/app';
import { testSmtp } from '../../../test/mail';
import { encryptionKey, encryptSecret } from '../../crypto/secrets';
import { first } from '../../db/rows';
import {
  instanceSettings,
  mailMessages,
  users,
  webhookDeliveries,
  webhookSubscriptions,
} from '../../db/schema';
import { deliverWebhook, MAX_DELIVERY_ATTEMPTS, type DeliveryDeps } from '../../webhooks/deliver';
import { createDelivery, WEBHOOK_SECRET_AAD } from '../../webhooks/deliveries';
import { mailDeps } from '../outbox';
import { writeMailSettings } from '../settings';
import { webhookAlertDedupeKey } from './webhook-alerts';

describe('failing-webhook alerts (E1 spec, Alerts)', () => {
  let t: TestContext;
  let receiver: Server;
  let url: string;
  let org: string;
  let webhookId: string;
  let deps: DeliveryDeps;
  const subscription = async (active = true) =>
    first(
      await t.db
        .insert(webhookSubscriptions)
        .values({
          organizationId: org,
          url,
          secretEnc: encryptSecret(
            encryptionKey(t.config.secretKey),
            'whsec_alert-test',
            WEBHOOK_SECRET_AAD,
          ),
          events: ['analysis.completed'],
          active,
        })
        .returning({ id: webhookSubscriptions.id }),
    ).id;
  /** A delivery on its last attempt, answered 503: it gives up. */
  const giveUp = async (subscriptionId = webhookId, d: DeliveryDeps = deps) => {
    const id = await t.db.transaction((tx) =>
      createDelivery(tx, { subscriptionId, event: 'analysis.completed', payload: { id: 'a1' } }),
    );
    await t.db
      .update(webhookDeliveries)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })
      .where(eq(webhookDeliveries.id, id));
    return deliverWebhook(d, id, MAX_DELIVERY_ATTEMPTS - 1);
  };
  const alerts = () =>
    t.db
      .select({
        to: mailMessages.toAddress,
        subject: mailMessages.subject,
        dedupe: mailMessages.dedupeKey,
      })
      .from(mailMessages)
      .where(eq(mailMessages.kind, 'webhook.failed'))
      .orderBy(mailMessages.toAddress);

  beforeAll(async () => {
    t = await createTestContext({
      config: { smtp: testSmtp(2525), publicUrl: 'https://qualor.example.com' },
    });
    await t.db
      .insert(instanceSettings)
      .values({ key: 'webhooks', value: { allowHttp: true, allowInternalHosts: true } });
    receiver = createServer((_req, res) => {
      res.writeHead(503).end('down');
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook?token=SECRET-IN-QUERY`;
    org = await organizationId(t, 'default');
    webhookId = await subscription();
    await t.db.update(users).set({ email: 'admin@example.com' }).where(eq(users.id, t.adminId));
    await createUser(t, { username: 'alert-ops', email: 'ops@example.com', isInstanceAdmin: true });
    await createUser(t, { username: 'alert-noemail', isInstanceAdmin: true });
    await createUser(t, {
      username: 'alert-gone',
      email: 'gone@example.com',
      isInstanceAdmin: true,
      active: false,
    });
    deps = { db: t.db, secretKey: t.config.secretKey, timeoutMs: 1_000, mail: mailDeps(t.config) };
  });
  beforeEach(async () => {
    await t.db.delete(mailMessages);
    await t.db.delete(webhookDeliveries);
    await t.db.transaction((tx) =>
      writeMailSettings(tx, { alerts: { webhookFailures: true } }, t.config.secretKey),
    );
  });
  afterAll(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await t.close();
  });

  it('alerts every active instance administrator with an email when a delivery gives up', async () => {
    expect(await giveUp()).toBe('failed');
    const host = new URL(url).host;
    const subject = `Webhook to ${host} is failing`;
    const dedupe = webhookAlertDedupeKey(webhookId);
    expect(await alerts()).toEqual([
      { to: 'admin@example.com', subject, dedupe },
      { to: 'ops@example.com', subject, dedupe },
    ]);
    expect(JSON.stringify(await t.db.select().from(mailMessages))).not.toContain('SECRET-IN-QUERY');
  });

  it('sends one alert per administrator and webhook in 24 hours', async () => {
    await giveUp();
    await giveUp();
    expect(await alerts()).toHaveLength(2);
    await t.db.execute(sql`UPDATE mail_messages SET created_at = now() - interval '25 hours'`);
    await giveUp();
    expect(await alerts()).toHaveLength(4);
  });

  it('sends no instance alert with the alert switched off; an organisation administrator still gets theirs (mail E3)', async () => {
    await t.db.transaction((tx) =>
      writeMailSettings(tx, { alerts: { webhookFailures: false } }, t.config.secretKey),
    );
    expect(await giveUp()).toBe('failed');
    // alert-ops is an instance administrator only; admin also administers `default`.
    expect((await alerts()).map((a) => a.to)).toEqual(['admin@example.com']);
  });

  it('sends nothing for a delivery that will be retried, nor for an inactive webhook', async () => {
    const id = await t.db.transaction((tx) =>
      createDelivery(tx, { subscriptionId: webhookId, event: 'analysis.completed', payload: {} }),
    );
    expect(await deliverWebhook(deps, id, 0)).toBe('retrying');
    expect(await giveUp(await subscription(false))).toBe('failed');
    expect(await alerts()).toEqual([]);
  });

  it('sends nothing while email is not configured, or without mail deps (tests, tools)', async () => {
    expect(await giveUp(webhookId, { ...deps, mail: mailDeps({ ...t.config, smtp: null }) })).toBe(
      'failed',
    );
    expect(await giveUp(webhookId, { ...deps, mail: undefined })).toBe('failed');
    expect(await alerts()).toEqual([]);
  });

  it('records the failure when the database refuses the alert, rolls back the partial alert and logs no address', async () => {
    // A DB-level failure for the second administrator only: the first one's row is already
    // inserted inside the savepoint when the second insert fails (drizzle's DrizzleQueryError,
    // whose message carries the SQL parameters).
    await t.db.execute(sql`
      CREATE FUNCTION refuse_ops_mail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.to_address = 'ops@example.com' THEN RAISE EXCEPTION 'refused by test'; END IF;
        RETURN NEW;
      END $$`);
    await t.db.execute(sql`
      CREATE TRIGGER refuse_ops_mail BEFORE INSERT ON mail_messages
      FOR EACH ROW EXECUTE FUNCTION refuse_ops_mail()`);
    const lines: string[] = [];
    const capture = {
      info: (...args: unknown[]) => void lines.push(JSON.stringify(args)),
      warn: (...args: unknown[]) => void lines.push(JSON.stringify(args)),
    };
    try {
      expect(await giveUp(webhookId, { ...deps, logger: capture })).toBe('failed');
    } finally {
      await t.db.execute(sql`DROP TRIGGER refuse_ops_mail ON mail_messages`);
      await t.db.execute(sql`DROP FUNCTION refuse_ops_mail()`);
    }
    expect(await alerts()).toEqual([]);
    const rows = await t.db.select({ status: webhookDeliveries.status }).from(webhookDeliveries);
    expect(rows).toEqual([{ status: 'failed' }]);
    const logged = lines.join('\n');
    expect(logged).toContain('webhook failure alert not queued');
    expect(logged).toContain(webhookId);
    for (const leak of ['admin@example.com', 'ops@example.com', 'params', 'Failed query']) {
      expect(logged).not.toContain(leak);
    }
  });
});
