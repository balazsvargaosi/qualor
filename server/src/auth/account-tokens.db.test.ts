import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { first } from '../db/rows';
import { accountTokens, type AccountTokenKind, users } from '../db/schema';
import {
  ACCOUNT_TOKEN_LENGTH,
  accountTokenKey,
  deleteAccountTokens,
  EXPIRED_INVITATION_KEPT_DAYS,
  invitationsOf,
  issueAccountToken,
  peekAccountToken,
  pruneAccountTokens,
  takeAccountToken,
} from './account-tokens';

describe('account tokens (mail E2 A1)', () => {
  let t: TestDatabase;
  let userId: string;
  let adminId: string;
  const newUser = async (username: string) =>
    first(await t.db.insert(users).values({ username }).returning()).id;
  const issue = (user: string, kind: AccountTokenKind, createdBy: string | null = null) =>
    issueAccountToken(t.db, { userId: user, kind, createdBy, ttlMinutes: 60 });
  const expire = (token: string, interval: string) =>
    t.db.execute(
      sql`UPDATE account_tokens SET expires_at = now() - ${interval}::interval WHERE key = ${accountTokenKey(token)}`,
    );

  beforeAll(async () => {
    t = await createTestDatabase();
    userId = await newUser('tok-user');
    adminId = await newUser('tok-admin');
  });
  beforeEach(async () => {
    await t.db.delete(accountTokens);
  });
  afterAll(async () => t.close());

  it('issues a 43-character base62 secret and stores only its SHA-256', async () => {
    const issued = await issue(userId, 'password_reset');
    expect(issued.token).toMatch(new RegExp(`^[0-9A-Za-z]{${ACCOUNT_TOKEN_LENGTH}}$`));
    const rows = await t.db.select().from(accountTokens).where(eq(accountTokens.userId, userId));
    expect(rows.map((r) => r.key)).toEqual([accountTokenKey(issued.token)]);
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    const minutes = (issued.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThan(62);
  });

  it('peeks without using the token up, and takes it exactly once', async () => {
    const { token } = await issue(userId, 'invitation', adminId);
    expect(await peekAccountToken(t.db, token, 'invitation')).toMatchObject({
      userId,
      createdBy: adminId,
    });
    expect(await peekAccountToken(t.db, token, 'invitation')).not.toBeNull();
    expect(await takeAccountToken(t.db, token, 'invitation')).toMatchObject({ userId });
    expect(await takeAccountToken(t.db, token, 'invitation')).toBeNull();
    expect(await peekAccountToken(t.db, token, 'invitation')).toBeNull();
  });

  it('gives a token to its own kind only, and leaves it in place otherwise', async () => {
    const { token } = await issue(userId, 'password_reset');
    expect(await takeAccountToken(t.db, token, 'invitation')).toBeNull();
    expect(await peekAccountToken(t.db, token, 'password_reset')).not.toBeNull();
  });

  it('refuses an expired token', async () => {
    const { token } = await issue(userId, 'password_reset');
    await expire(token, '1 second');
    expect(await peekAccountToken(t.db, token, 'password_reset')).toBeNull();
    expect(await takeAccountToken(t.db, token, 'password_reset')).toBeNull();
  });

  it('keeps one token per user and kind: a new one replaces the old', async () => {
    const old = await issue(userId, 'invitation', adminId);
    const fresh = await issue(userId, 'invitation');
    expect(await peekAccountToken(t.db, old.token, 'invitation')).toBeNull();
    expect(await peekAccountToken(t.db, fresh.token, 'invitation')).toMatchObject({
      createdBy: null,
    });
    const rows = await t.db
      .select()
      .from(accountTokens)
      .where(and(eq(accountTokens.userId, userId), eq(accountTokens.kind, 'invitation')));
    expect(rows).toHaveLength(1);
  });

  it('hands a token to one of two concurrent takers', async () => {
    const { token } = await issue(userId, 'password_reset');
    const results = await Promise.all(
      [0, 1].map(() => t.db.transaction((tx) => takeAccountToken(tx, token, 'password_reset'))),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('deletes one kind, or every token of a user', async () => {
    await issue(userId, 'password_reset');
    await issue(userId, 'invitation');
    expect(await deleteAccountTokens(t.db, userId, 'invitation')).toBe(1);
    expect(await deleteAccountTokens(t.db, userId)).toBe(1);
    expect(await deleteAccountTokens(t.db, userId)).toBe(0);
  });

  it('reports invitations, live or expired, and nothing for other kinds', async () => {
    const live = await issue(userId, 'invitation');
    await issue(adminId, 'password_reset');
    const of = await invitationsOf(t.db, [userId, adminId]);
    expect(of(userId)?.expiresAt.getTime()).toBe(live.expiresAt.getTime());
    expect(of(adminId)).toBeNull();
    await expire(live.token, '1 day');
    expect((await invitationsOf(t.db, [userId]))(userId)).not.toBeNull();
    expect((await invitationsOf(t.db, []))(userId)).toBeNull();
  });

  it('prunes expired resets at once and expired invitations after 30 days', async () => {
    const other = await newUser('tok-other');
    const resetGone = await issue(userId, 'password_reset');
    const inviteKept = await issue(userId, 'invitation');
    const inviteGone = await issue(other, 'invitation');
    const resetLive = await issue(adminId, 'password_reset');
    await expire(resetGone.token, '1 second');
    await expire(inviteKept.token, '1 day');
    await expire(inviteGone.token, `${EXPIRED_INVITATION_KEPT_DAYS + 1} days`);
    expect(await pruneAccountTokens(t.db)).toBe(2);
    const left = (await t.db.select({ key: accountTokens.key }).from(accountTokens)).map(
      (r) => r.key,
    );
    expect(left.sort()).toEqual(
      [accountTokenKey(inviteKept.token), accountTokenKey(resetLive.token)].sort(),
    );
    expect(await pruneAccountTokens(t.db)).toBe(0);
  });
});
