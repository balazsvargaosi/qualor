import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  accountContext,
  countRows,
  linkToken,
  mailsTo,
  untilLockWait,
} from '../../test/account-mail';
import { createUser, DEFAULT_TEST_PASSWORD, login, nextIp, type TestContext } from '../../test/app';
import {
  activeSessions,
  adminHeaders,
  auditRows,
  givePersonalToken,
  giveSession,
  liveTokens,
} from '../../test/sso';
import { accountTokenKey, deleteAccountTokens, issueAccountToken } from '../auth/account-tokens';
import { SESSION_COOKIE } from '../auth/sessions';
import type * as Password from '../auth/password';
import type * as AccountMail from '../mail/account';
import { accountTokens, instanceSettings, users } from '../db/schema';

/** Every argon2 hash, counted; `before` runs as a hash starts (it sees the database then). */
const hashing = vi.hoisted(() => ({
  calls: 0,
  before: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof Password>();
  return {
    ...actual,
    hashPassword: async (password: string) => {
      hashing.calls += 1;
      await hashing.before?.();
      return actual.hashPassword(password);
    },
  };
});

/** accountMailState, counted: an unknown login does the same work as a known one. */
const mailState = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../mail/account', async (importOriginal) => {
  const actual = await importOriginal<typeof AccountMail>();
  return {
    ...actual,
    accountMailState: (...args: Parameters<typeof actual.accountMailState>) => {
      mailState.calls += 1;
      return actual.accountMailState(...args);
    },
  };
});

const forgotOn =
  (ctx: TestContext) =>
  (login: string, remoteAddress = nextIp()) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v0/auth/password-reset',
      payload: { login },
      remoteAddress,
    });

describe('forgot password (mail E2 A3)', () => {
  let ctx: TestContext;
  let forgot: ReturnType<typeof forgotOn>;
  beforeAll(async () => {
    ctx = await accountContext();
    forgot = forgotOn(ctx);
  });
  afterAll(async () => ctx.close());

  it('says passwordReset: true on /auth/methods with mail and a public URL', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v0/auth/methods' });
    expect(res.json()).toMatchObject({ passwordReset: true });
  });

  it('answers 202 {} and writes nothing for every account that does not qualify', async () => {
    await createUser(ctx, { username: 'ina', email: 'ina@example.test', active: false });
    await createUser(ctx, { username: 'noel' });
    await ctx.db
      .insert(users)
      .values({ username: 'sso-sam', email: 'sam@example.test', passwordHash: null });
    await createUser(ctx, { username: 'guest', email: 'guest@example.test' });
    for (const login of [
      'nobody',
      'nobody@example.test',
      'ina',
      'ina@example.test',
      'noel',
      'sso-sam',
      'sam@example.test',
      'guest',
    ]) {
      const res = await forgot(login);
      expect([res.statusCode, res.json()], login).toEqual([202, {}]);
    }
    expect(await countRows(ctx, 'mail_messages')).toBe(0);
    expect(await countRows(ctx, 'account_tokens')).toBe(0);
    expect(
      (await auditRows(ctx)).filter((e) => e.action === 'auth.password_reset_requested'),
    ).toEqual([]);
  });

  it('reads the mail state for an unknown login as for a known one', async () => {
    await createUser(ctx, { username: 'kim-known' }); // no email: nothing queued for later tests
    for (const login of ['kim-unknown', 'kim-known']) {
      mailState.calls = 0;
      expect((await forgot(login)).statusCode).toBe(202);
      expect(mailState.calls, login).toBe(1);
    }
  });

  it('queues a message per request and keeps one token, by name or by address', async () => {
    const rita = await createUser(ctx, { username: 'rita', email: 'rita@example.test' });
    const from = ctx.logs.length;
    expect((await forgot('rita')).statusCode).toBe(202);
    expect(await mailsTo(ctx, 'rita@example.test')).toHaveLength(1);
    expect((await forgot(' RITA@Example.test ')).statusCode).toBe(202);
    const mails = await mailsTo(ctx, 'rita@example.test', 'account.password-reset');
    expect(mails).toHaveLength(2);
    const latest = mails[1]!;
    expect(latest.subject).toBe('Reset your Qualor password');
    const token = linkToken(latest.html, '/reset-password');
    expect(latest.subject).not.toContain(token);
    expect(latest.html).toContain(`https://q.example/reset-password#token=${token}`);
    // The second request replaced the first link: one row per user and kind.
    const rows = await ctx.db.select().from(accountTokens).where(eq(accountTokens.userId, rita.id));
    expect(rows.map((r) => r.key)).toEqual([accountTokenKey(token)]);
    const events = (await auditRows(ctx)).filter(
      (e) => e.action === 'auth.password_reset_requested',
    );
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      actorType: 'anonymous',
      actorUserId: null,
      targetId: rita.id,
      details: {},
    });
    // Neither the secret nor the body (the login typed) reaches a log line.
    const logs = ctx.logs.slice(from).join('\n');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(linkToken(mails[0]!.html, '/reset-password'));
    expect(logs).not.toContain('RITA@Example');
  });

  it('sends nothing while the policy refuses the password (break-glass admins only)', async () => {
    await createUser(ctx, { username: 'bea', email: 'bea@example.test' });
    await ctx.db.insert(instanceSettings).values({
      key: 'sign-in',
      value: { passwordSignIn: 'break_glass_only', breakGlassUserIds: [ctx.adminId] },
    });
    try {
      expect((await forgot('bea')).statusCode).toBe(202);
      expect(await mailsTo(ctx, 'bea@example.test')).toEqual([]);
    } finally {
      await ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, 'sign-in'));
    }
  });

  it('sends at most 3 messages per login in 15 minutes, whatever the case, still answering 202', async () => {
    await createUser(ctx, { username: 'tara', email: 'tara@example.test' });
    for (const login of ['tara', 'TARA', 'Tara', 'tara']) {
      expect((await forgot(login)).statusCode).toBe(202);
    }
    expect(await mailsTo(ctx, 'tara@example.test')).toHaveLength(3);
  });

  it('allows 5 requests a minute per address, then 429', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) expect((await forgot(`ip-${i}`, ip)).statusCode).toBe(202);
    const blocked = await forgot('ip-5', ip);
    expect([blocked.statusCode, blocked.json().code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('never answers an unknown login sooner than 250 ms, and logs no login typed', async () => {
    const from = ctx.logs.length;
    const started = performance.now();
    expect((await forgot('nobody-timed@example.test')).statusCode).toBe(202);
    expect(performance.now() - started).toBeGreaterThanOrEqual(240);
    expect(ctx.logs.slice(from).join('\n')).not.toContain('nobody-timed');
  });
});

describe('forgot password without mail or QUALOR_PUBLIC_URL (mail E2 A4)', () => {
  it.each([
    ['no mail server', { smtp: null }],
    ['no public URL', { publicUrl: null }],
  ] as const)('%s: passwordReset false, 202, nothing written', async (_name, config) => {
    const ctx = await accountContext(config);
    try {
      await createUser(ctx, { username: 'rita', email: 'rita@example.test' });
      const methods = await ctx.app.inject({ method: 'GET', url: '/api/v0/auth/methods' });
      expect(methods.json()).toMatchObject({ passwordReset: false });
      expect((await forgotOn(ctx)('rita')).statusCode).toBe(202);
      expect(await countRows(ctx, 'account_tokens')).toBe(0);
      expect(await countRows(ctx, 'mail_messages')).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});

describe('finishing a reset (mail E2)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await accountContext();
  });
  afterAll(async () => ctx.close());

  const complete = (
    token: string,
    newPassword = 'a brand new passphrase',
    remoteAddress = nextIp(),
  ) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v0/auth/password-reset/complete',
      payload: { token, newPassword },
      remoteAddress,
    });
  const resetLink = async (userId: string) =>
    (
      await issueAccountToken(ctx.db, {
        userId,
        kind: 'password_reset',
        createdBy: null,
        ttlMinutes: 60,
      })
    ).token;
  const hashOf = async (userId: string) =>
    (await ctx.db.select().from(users).where(eq(users.id, userId)))[0]!.passwordHash;
  const expectInvalid = (res: Awaited<ReturnType<typeof complete>>) =>
    expect([res.statusCode, res.json().code, res.json().title]).toEqual([
      400,
      'TOKEN_INVALID',
      'This link has expired or was already used. Ask for a new one.',
    ]);

  it('sets the password, ends every session, keeps personal tokens, clears the forced change, and does not sign in', async () => {
    const pia = await createUser(ctx, {
      username: 'pia',
      email: 'pia@example.test',
      passwordChangeRequired: true,
    });
    const session = await giveSession(ctx, pia.id);
    const personal = await givePersonalToken(ctx, pia.id);
    const from = ctx.logs.length;
    const link = await resetLink(pia.id);
    const res = await complete(link, 'a brand new passphrase', '198.51.100.23');
    expect([res.statusCode, res.json()]).toEqual([200, { username: 'pia' }]);
    // Neither the secret nor the new password reaches a log line.
    expect(ctx.logs.slice(from).join('\n')).not.toContain(link);
    expect(ctx.logs.slice(from).join('\n')).not.toContain('a brand new passphrase');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(await activeSessions(ctx, pia.id)).toBe(0);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v0/auth/me',
          cookies: { [SESSION_COOKIE]: session },
        })
      ).statusCode,
    ).toBe(401);
    expect(await liveTokens(ctx, pia.id)).toBe(1);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v0/auth/me',
          headers: { authorization: `Bearer ${personal}` },
        })
      ).statusCode,
    ).toBe(200);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, pia.id));
    expect(row!.passwordChangeRequired).toBe(false);
    expect((await login(ctx, 'pia', 'a brand new passphrase')).cookie).toBeTruthy();
    expect(
      (await auditRows(ctx)).filter((e) => e.action === 'auth.password_reset').at(-1),
    ).toMatchObject({
      actorUserId: pia.id,
      targetId: pia.id,
      details: {},
    });
    const [notice] = await mailsTo(ctx, 'pia@example.test', 'account.password-changed');
    expect(notice!.subject).toBe('Your Qualor password was changed');
    expect(notice!.text).toContain('198.51.100.23');
    expect(notice!.html).toContain('reset with a link');
  });

  it('uses a link once, even twice at the same moment', async () => {
    const quinn = await createUser(ctx, { username: 'quinn', email: 'quinn@example.test' });
    const token = await resetLink(quinn.id);
    const [a, b] = await Promise.all([complete(token), complete(token)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expectInvalid(await complete(token));
  });

  it('waits behind a change to the same account (user row, then its links), never deadlocking', async () => {
    const rae = await createUser(ctx, { username: 'rae', email: 'rae@example.test' });
    const token = await resetLink(rae.id);
    let answer: ReturnType<typeof complete> | undefined;
    // An admin's change of the account in PATCH /users/:id order: the user row, then its links.
    await ctx.db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, rae.id)).for('update');
      answer = complete(token);
      await untilLockWait(ctx);
      await deleteAccountTokens(tx, rae.id);
    });
    expectInvalid(await answer!);
  });

  it('refuses an expired link, a link of another kind and a malformed one', async () => {
    const ross = await createUser(ctx, { username: 'ross', email: 'ross@example.test' });
    const before = await hashOf(ross.id);
    const expired = await resetLink(ross.id);
    await ctx.db.execute(
      sql`UPDATE account_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${ross.id}`,
    );
    expectInvalid(await complete(expired));
    const { token: invitation } = await issueAccountToken(ctx.db, {
      userId: ross.id,
      kind: 'invitation',
      createdBy: null,
      ttlMinutes: 60,
    });
    expectInvalid(await complete(invitation));
    expect(await countRows(ctx, 'account_tokens')).toBeGreaterThan(0); // the invitation stays
    expectInvalid(await complete('not-a-token!'));
    expectInvalid(await complete('x'.repeat(101)));
    expect(await hashOf(ross.id)).toBe(before);
  });

  it('checks the policy again when the link is used, and uses the link up', async () => {
    const sara = await createUser(ctx, { username: 'sara', email: 'sara@example.test' });
    const before = await hashOf(sara.id);
    const token = await resetLink(sara.id);
    await ctx.db.insert(instanceSettings).values({
      key: 'sign-in',
      value: { passwordSignIn: 'break_glass_only', breakGlassUserIds: [ctx.adminId] },
    });
    try {
      expectInvalid(await complete(token));
    } finally {
      await ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, 'sign-in'));
    }
    expectInvalid(await complete(token));
    expect(await hashOf(sara.id)).toBe(before);
  });

  it('refuses a password shorter than 12 characters (422) without using the link up', async () => {
    const tom = await createUser(ctx, { username: 'tom', email: 'tom@example.test' });
    const token = await resetLink(tom.id);
    expect((await complete(token, 'short')).statusCode).toBe(422);
    expect((await complete(token)).statusCode).toBe(200);
  });

  it('allows 10 attempts a minute per address, then 429', async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++)
      expect((await complete('nope', undefined, ip)).statusCode).toBe(400);
    expect((await complete('nope', undefined, ip)).statusCode).toBe(429);
  });

  it('hashes the new password before it takes the link, and hashes nothing for a malformed one', async () => {
    const wes = await createUser(ctx, { username: 'wes', email: 'wes@example.test' });
    const token = await resetLink(wes.id);
    // While the hash runs, the link's row is still there and nobody holds it (NOWAIT throws).
    let rowsWhileHashing: number | undefined;
    hashing.before = async () => {
      const result = await ctx.db.execute(
        sql`SELECT key FROM account_tokens WHERE user_id = ${wes.id} FOR UPDATE NOWAIT`,
      );
      rowsWhileHashing = result.rows.length;
    };
    try {
      expect((await complete(token)).statusCode).toBe(200);
    } finally {
      hashing.before = undefined;
    }
    expect(rowsWhileHashing).toBe(1);
    hashing.calls = 0;
    expectInvalid(await complete('not-a-token!'));
    expectInvalid(await complete('x'.repeat(101)));
    expect(hashing.calls).toBe(0);
  });

  it('refuses the demo account and a deactivated one when the link is used, and uses the link up', async () => {
    const guest = await createUser(ctx, { username: 'guest', email: 'guest@example.test' });
    const gone = await createUser(ctx, { username: 'gone', email: 'gone@example.test' });
    const tokens = [await resetLink(guest.id), await resetLink(gone.id)];
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, gone.id));
    for (const [user, token] of [
      [guest, tokens[0]!],
      [gone, tokens[1]!],
    ] as const) {
      const before = await hashOf(user.id);
      expectInvalid(await complete(token));
      expect(await hashOf(user.id), user.username).toBe(before);
      expect(
        await ctx.db.select().from(accountTokens).where(eq(accountTokens.userId, user.id)),
        user.username,
      ).toEqual([]);
      expect(await mailsTo(ctx, `${user.username}@example.test`), user.username).toEqual([]);
    }
    expect(
      (await auditRows(ctx)).filter(
        (e) => e.action === 'auth.password_reset' && [guest.id, gone.id].includes(e.targetId ?? ''),
      ),
    ).toEqual([]);
  });
});

describe('the password-changed notice (mail E2 A7)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await accountContext();
  });
  afterAll(async () => ctx.close());

  it('follows a change on the account page, and voids a pending reset link', async () => {
    const uma = await createUser(ctx, { username: 'uma', email: 'uma@example.test' });
    await issueAccountToken(ctx.db, {
      userId: uma.id,
      kind: 'password_reset',
      createdBy: null,
      ttlMinutes: 60,
    });
    const s = await login(ctx, 'uma', DEFAULT_TEST_PASSWORD);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/auth/me/password',
      headers: s.headers,
      payload: { currentPassword: DEFAULT_TEST_PASSWORD, newPassword: 'uma chose a new one' },
      remoteAddress: '198.51.100.40',
    });
    expect(res.statusCode).toBe(204);
    const [notice] = await mailsTo(ctx, 'uma@example.test', 'account.password-changed');
    expect(notice!.html).toContain('changed on the account page');
    expect(notice!.text).toContain('198.51.100.40');
    expect(await countRows(ctx, 'account_tokens')).toBe(0);
  });

  it('is not sent for an account without an email address', async () => {
    await createUser(ctx, { username: 'wynn' });
    const before = await countRows(ctx, 'mail_messages');
    const s = await login(ctx, 'wynn', DEFAULT_TEST_PASSWORD);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v0/auth/me/password',
      headers: s.headers,
      payload: { currentPassword: DEFAULT_TEST_PASSWORD, newPassword: 'wynn chose a new one' },
    });
    expect(res.statusCode).toBe(204);
    expect(await countRows(ctx, 'mail_messages')).toBe(before);
  });

  it('follows an admin reset that replaced a password, saying what ended, and only then', async () => {
    const headers = await adminHeaders(ctx);
    const vic = await createUser(ctx, { username: 'vic', email: 'vic@example.test' });
    const [nopass] = await ctx.db
      .insert(users)
      .values({ username: 'nopass', email: 'nopass@example.test', passwordHash: null })
      .returning();
    const noMail = await createUser(ctx, { username: 'nomail' });
    for (const id of [vic.id, nopass!.id, noMail.id]) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v0/users/${id}`,
        headers,
        payload: { password: 'an admin chose this one' },
      });
      expect(res.statusCode).toBe(200);
    }
    const notices = await mailsTo(ctx, 'vic@example.test', 'account.password-changed');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.html).toContain('An administrator');
    expect(notices[0]!.text).not.toContain('From:');
    expect(await mailsTo(ctx, 'nopass@example.test')).toEqual([]);
  });

  it('sends the admin-reset notice to the old address when the same change replaces the email', async () => {
    const headers = await adminHeaders(ctx);
    const moved = await createUser(ctx, { username: 'moved', email: 'moved-old@example.test' });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v0/users/${moved.id}`,
      headers,
      payload: { email: 'moved-new@example.test', password: 'an admin chose this one' },
    });
    expect(res.statusCode).toBe(200);
    expect(await mailsTo(ctx, 'moved-old@example.test', 'account.password-changed')).toHaveLength(
      1,
    );
    expect(await mailsTo(ctx, 'moved-new@example.test')).toEqual([]);
  });

  it('sends the admin-reset notice to the new address when the account had none', async () => {
    const headers = await adminHeaders(ctx);
    const bare = await createUser(ctx, { username: 'bare' });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v0/users/${bare.id}`,
      headers,
      payload: { email: 'bare-new@example.test', password: 'an admin chose this one' },
    });
    expect(res.statusCode).toBe(200);
    expect(await mailsTo(ctx, 'bare-new@example.test', 'account.password-changed')).toHaveLength(1);
  });
});
