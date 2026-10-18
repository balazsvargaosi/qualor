import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, organizationId, type TestContext } from '../../../test/app';
import { encryptionKey, encryptSecret } from '../../crypto/secrets';
import { first } from '../../db/rows';
import { webhookSubscriptions } from '../../db/schema';
import { configuredSecrets } from '../../support/secrets';
import { WEBHOOK_SECRET_AAD, WEBHOOK_URL_AAD } from '../deliveries';

const SLACK_URL = 'https://hooks.slack.com/services/T0001/B0001/abcdEFGHijklMNOPqrstUVWX';

/** Walks drizzle's wrapped error to the PG constraint name (see rbac-audit-schema.db.test.ts). */
function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const name = (e as { constraint?: string }).constraint;
    if (name) return name;
  }
  return undefined;
}

describe('migration 0014_chat_webhooks', () => {
  let t: TestContext;
  let org: string;
  let key: Buffer;
  beforeAll(async () => {
    t = await createTestContext();
    org = await organizationId(t, 'default');
    key = encryptionKey(t.config.secretKey);
  });
  afterAll(async () => {
    await t.close();
  });

  it('keeps existing rows generic, in UTC, with no digest week', async () => {
    const row = first(
      await t.db
        .insert(webhookSubscriptions)
        .values({
          organizationId: org,
          url: 'https://hooks.example.com/in',
          secretEnc: encryptSecret(key, 'whsec_x', WEBHOOK_SECRET_AAD),
          events: ['analysis.completed'],
        })
        .returning(),
    );
    expect(row).toMatchObject({
      kind: 'generic',
      urlEnc: null,
      timezone: 'UTC',
      digestLastWeek: null,
    });
  });

  it('stores a chat webhook without a secret, its URL encrypted', async () => {
    const row = first(
      await t.db
        .insert(webhookSubscriptions)
        .values({
          organizationId: org,
          kind: 'slack',
          url: 'https://hooks.slack.com/services/T…/…/UVWX',
          urlEnc: encryptSecret(key, SLACK_URL, WEBHOOK_URL_AAD),
          secretEnc: null,
          events: ['gate.failed', 'gate.recovered', 'digest.weekly'],
          timezone: 'Europe/Berlin',
        })
        .returning(),
    );
    expect(row.kind).toBe('slack');
    expect(JSON.stringify(row)).not.toContain('abcdEFGH');
  });

  it.each([
    ['an unknown kind', { kind: 'discord' }, 'webhook_subscriptions_kind_check'],
    [
      'a generic webhook without a secret',
      { secretEnc: null },
      'webhook_subscriptions_secret_by_kind',
    ],
    [
      'a generic webhook with an encrypted URL',
      { urlEnc: { v: 1, iv: 'x', ct: 'x', tag: 'x' } },
      'webhook_subscriptions_url_enc_by_kind',
    ],
    [
      'a chat webhook with a secret',
      { kind: 'teams', urlEnc: { v: 1, iv: 'x', ct: 'x', tag: 'x' } },
      'webhook_subscriptions_secret_by_kind',
    ],
    [
      'a chat webhook without an encrypted URL',
      { kind: 'teams', secretEnc: null },
      'webhook_subscriptions_url_enc_by_kind',
    ],
  ] as const)('refuses %s', async (_label, overrides, constraint) => {
    const values = {
      organizationId: org,
      url: 'https://hooks.example.com/in',
      secretEnc: encryptSecret(key, 'whsec_x', WEBHOOK_SECRET_AAD),
      events: ['analysis.completed'],
      ...overrides,
    } as typeof webhookSubscriptions.$inferInsert;
    const err = await t.db
      .insert(webhookSubscriptions)
      .values(values)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(constraintOf(err)).toBe(constraint);
  });

  it('puts a chat URL into the support bundle secret list (R12)', async () => {
    const secrets = await configuredSecrets(t.db, t.config);
    expect(secrets).toContain(SLACK_URL);
  });

  it('has no new foreign key (no FK index to add)', async () => {
    const fks = await t.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'webhook_subscriptions'::regclass AND contype = 'f'`);
    expect(fks.rows[0]?.n).toBe(2);
    const [kept] = await t.db
      .select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.kind, 'generic'));
    expect(kept).toBeDefined();
  });
});
