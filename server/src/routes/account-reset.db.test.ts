import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountContext, countRows, linkToken, mailsTo } from '../../test/account-mail';
import { createUser, nextIp, type TestContext } from '../../test/app';
import { auditRows } from '../../test/sso';
import { accountTokenKey } from '../auth/account-tokens';
import { accountTokens, instanceSettings, users } from '../db/schema';

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
