import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, expectPgError, type TestDatabase } from '../../test/db';
import { PG_CHECK_VIOLATION } from './errors';
import { uuidv7 } from './ids';
import { mailMessages, users } from './schema';

const ENVELOPE = { v: 1 as const, iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' };

describe('mail_messages (E1 spec, migration 0009_mail)', () => {
  let t: TestDatabase;
  const row = (over: Partial<typeof mailMessages.$inferInsert> = {}) => ({
    id: uuidv7(),
    kind: 'test',
    toAddress: 'ops@example.com',
    subject: 'Qualor test message',
    status: 'pending' as const,
    payloadEnc: ENVELOPE,
    ...over,
  });

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  it('stores a pending message with its payload and defaults', async () => {
    const [stored] = await t.db.insert(mailMessages).values(row()).returning();
    expect(stored).toMatchObject({ status: 'pending', attempts: 0, lastError: null, sentAt: null });
  });

  it.each([
    ['a kind outside ^[a-z0-9.-]{1,64}$', { kind: 'Bad Kind' }],
    ['an unknown status', { status: 'bounced' as never, payloadEnc: null }],
    ['a payload on a sent message', { status: 'sent' as const }],
    ['a subject over 300 characters', { subject: 's'.repeat(301) }],
    ['a last error over 1 KB', { lastError: 'é'.repeat(513) }],
    ['an SMTP reply over 1 KB', { smtpResponse: 'x'.repeat(1025) }],
    ['a dedupe key over 200 characters', { dedupeKey: 'k'.repeat(201) }],
  ])('refuses %s', async (_what, over) => {
    await expectPgError(t.db.insert(mailMessages).values(row(over)), PG_CHECK_VIOLATION);
  });

  it('compares addresses ignoring case, and keeps the row when its user is deleted', async () => {
    const [user] = await t.db.insert(users).values({ username: 'mail-target' }).returning();
    const id = uuidv7();
    await t.db
      .insert(mailMessages)
      .values(row({ id, userId: user!.id, toAddress: 'Ada@Example.com' }));
    const found = await t.db
      .select()
      .from(mailMessages)
      .where(sql`${mailMessages.toAddress} = 'ada@example.com'`);
    expect(found.map((r) => r.id)).toContain(id);
    await t.db.delete(users).where(eq(users.id, user!.id));
    const [kept] = await t.db.select().from(mailMessages).where(eq(mailMessages.id, id));
    expect(kept?.userId).toBeNull();
  });
});
