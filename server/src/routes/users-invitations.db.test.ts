import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountContext, countRows, linkToken, mailsTo } from '../../test/account-mail';
import { createUser, type TestContext } from '../../test/app';
import { adminHeaders, auditRows, oidcConnection } from '../../test/sso';
import { issueAccountToken, peekAccountToken } from '../auth/account-tokens';
import { accountTokens, identities, instanceSettings, users } from '../db/schema';

describe('invitations (mail E2 A8)', () => {
  let ctx: TestContext;
  let headers: Record<string, string>;
  beforeAll(async () => {
    ctx = await accountContext();
    headers = await adminHeaders(ctx);
  });
  afterAll(async () => ctx.close());

  const create = (payload: Record<string, unknown>, extra: Record<string, string> = headers) =>
    ctx.app.inject({ method: 'POST', url: '/api/v0/users', headers: extra, payload });
  const resend = (id: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/v0/users/${id}/invitation`, headers });
  const revoke = (id: string) =>
    ctx.app.inject({ method: 'DELETE', url: `/api/v0/users/${id}/invitation`, headers });
  const paths = (res: { json(): unknown }) =>
    ((res.json() as { errors?: { path: string }[] }).errors ?? []).map((e) => e.path);

  it('checks the body: an invitation takes an email and no password; otherwise a password', async () => {
    expect(
      paths(
        await create({
          username: 'x1',
          invite: true,
          email: 'x1@example.test',
          password: 'a long password!',
        }),
      ),
    ).toEqual(['body.password']);
    expect(paths(await create({ username: 'x2', invite: true }))).toEqual(['body.email']);
    expect(paths(await create({ username: 'x3' }))).toEqual(['body.password']);
    expect(await countRows(ctx, 'mail_messages')).toBe(0);
  });

  it('creates an invited user without a password, mails the link and records both events', async () => {
    const res = await create({
      username: 'ivy',
      invite: true,
      email: 'ivy@example.test',
      displayName: 'Ivy',
    });
    expect(res.statusCode).toBe(201);
    const ivy = res.json();
    expect(ivy).toMatchObject({
      username: 'ivy',
      hasPassword: false,
      passwordChangeRequired: false,
    });
    const days = (Date.parse(ivy.invitation.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    const [mail] = await mailsTo(ctx, 'ivy@example.test', 'account.invitation');
    expect(mail!.subject).toBe('Administrator invited you to Qualor');
    const token = linkToken(mail!.html, '/accept-invite');
    expect(await peekAccountToken(ctx.db, token, 'invitation')).toMatchObject({
      userId: ivy.id,
      createdBy: ctx.adminId,
    });
    const events = (await auditRows(ctx)).filter((e) => e.targetId === ivy.id);
    expect(events.map((e) => [e.action, e.details])).toEqual([
      ['user.created', { instanceAdmin: false, passwordChangeRequired: false, invited: true }],
      ['user.invited', { resend: false }],
    ]);
    const listed = await ctx.app.inject({ method: 'GET', url: '/api/v0/users?limit=100', headers });
    const row = (listed.json().items as { id: string; invitation: unknown }[]).find(
      (u) => u.id === ivy.id,
    );
    expect(row?.invitation).toEqual({ expiresAt: ivy.invitation.expiresAt });
  });

  it('says invited: false for a user made with a password, whose invitation is null', async () => {
    const res = await create({ username: 'pat', password: 'a long password!' });
    expect(res.json().invitation).toBeNull();
    const [event] = (await auditRows(ctx)).filter((e) => e.targetId === res.json().id);
    expect(event?.details).toEqual({
      instanceAdmin: false,
      passwordChangeRequired: true,
      invited: false,
    });
  });

  it('resends: a new link, the old one stops working', async () => {
    const { id } = (
      await create({ username: 'rex', invite: true, email: 'rex@example.test' })
    ).json();
    const first = linkToken((await mailsTo(ctx, 'rex@example.test'))[0]!.html, '/accept-invite');
    const res = await resend(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().invitation).not.toBeNull();
    const mails = await mailsTo(ctx, 'rex@example.test', 'account.invitation');
    expect(mails).toHaveLength(2);
    const second = linkToken(mails[1]!.html, '/accept-invite');
    expect(await peekAccountToken(ctx.db, first, 'invitation')).toBeNull();
    expect(await peekAccountToken(ctx.db, second, 'invitation')).not.toBeNull();
    expect((await auditRows(ctx)).at(-1)).toMatchObject({
      action: 'user.invited',
      targetId: id,
      details: { resend: true },
    });
  });

  it('revokes: the link stops working, then 404', async () => {
    const { id } = (
      await create({ username: 'sol', invite: true, email: 'sol@example.test' })
    ).json();
    const token = linkToken((await mailsTo(ctx, 'sol@example.test'))[0]!.html, '/accept-invite');
    expect((await revoke(id)).statusCode).toBe(204);
    expect(await peekAccountToken(ctx.db, token, 'invitation')).toBeNull();
    expect((await auditRows(ctx)).at(-1)).toMatchObject({
      action: 'user.invitation_revoked',
      targetId: id,
      details: {},
    });
    expect((await revoke(id)).statusCode).toBe(404);
  });

  it('refuses to invite someone who has a password, no email, or a single sign-on identity', async () => {
    const withPassword = await createUser(ctx, {
      username: 'has-pw',
      email: 'has-pw@example.test',
    });
    const [noEmail] = await ctx.db
      .insert(users)
      .values({ username: 'no-email', passwordHash: null })
      .returning();
    const [sso] = await ctx.db
      .insert(users)
      .values({ username: 'sso-only', email: 'sso@example.test', passwordHash: null })
      .returning();
    const connectionId = await oidcConnection(ctx, { name: 'Invite IdP' });
    await ctx.db
      .insert(identities)
      .values({ connectionId, userId: sso!.id, subject: 'sub-sso', linkedBy: 'jit' });
    for (const id of [withPassword.id, noEmail!.id, sso!.id]) {
      const res = await resend(id);
      expect([res.statusCode, res.json().code]).toEqual([409, 'INVITATION_NOT_APPLICABLE']);
    }
  });

  it('refuses invitations while password sign-in is limited to break-glass admins', async () => {
    await ctx.db.insert(instanceSettings).values({
      key: 'sign-in',
      value: { passwordSignIn: 'break_glass_only', breakGlassUserIds: [ctx.adminId] },
    });
    try {
      const res = await create({ username: 'bg', invite: true, email: 'bg@example.test' });
      expect([res.statusCode, res.json().code]).toEqual([409, 'PASSWORD_SIGN_IN_DISABLED']);
    } finally {
      await ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, 'sign-in'));
    }
  });

  it('ends every pending link (both kinds) when an admin sets a password or deactivates the user', async () => {
    const a = (
      await create({ username: 'set-pw', invite: true, email: 'set-pw@example.test' })
    ).json();
    const b = (await create({ username: 'gone', invite: true, email: 'gone@example.test' })).json();
    for (const userId of [a.id, b.id]) {
      await issueAccountToken(ctx.db, {
        userId,
        kind: 'password_reset',
        createdBy: null,
        ttlMinutes: 60,
      });
    }
    const before = await ctx.db
      .select()
      .from(accountTokens)
      .where(sql`user_id IN (${a.id}, ${b.id})`);
    expect(before).toHaveLength(4);
    const patch = (id: string, payload: object) =>
      ctx.app.inject({ method: 'PATCH', url: `/api/v0/users/${id}`, headers, payload });
    expect((await patch(a.id, { password: 'the admin set this' })).json().invitation).toBeNull();
    expect((await patch(b.id, { active: false })).statusCode).toBe(200);
    const left = await ctx.db
      .select()
      .from(accountTokens)
      .where(sql`user_id IN (${a.id}, ${b.id})`);
    expect(left).toEqual([]);
  });
});

describe('invitation resends are rate-limited (mail E2)', () => {
  it('allows 10 a minute per admin, then 429', async () => {
    // Its own server: the route's counter starts at zero whatever other tests did.
    const ctx = await accountContext();
    try {
      const headers = await adminHeaders(ctx);
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v0/users',
        headers,
        payload: { username: 'busy', invite: true, email: 'busy@example.test' },
      });
      const id = created.json().id as string;
      const resend = () =>
        ctx.app.inject({ method: 'POST', url: `/api/v0/users/${id}/invitation`, headers });
      for (let i = 0; i < 10; i++) expect((await resend()).statusCode).toBe(200);
      const blocked = await resend();
      expect([blocked.statusCode, blocked.json().code]).toEqual([429, 'RATE_LIMITED']);
    } finally {
      await ctx.close();
    }
  });
});

describe('invitations without mail or QUALOR_PUBLIC_URL (mail E2 A4)', () => {
  it.each([
    ['no mail server', { smtp: null }, 'MAIL_NOT_CONFIGURED'],
    ['no public URL', { publicUrl: null }, 'PUBLIC_URL_REQUIRED'],
  ] as const)('%s: 409 %s, nothing created', async (_name, config, code) => {
    const ctx = await accountContext(config);
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v0/users',
        headers: await adminHeaders(ctx),
        payload: { username: 'nope', invite: true, email: 'nope@example.test' },
      });
      expect([res.statusCode, res.json().code]).toEqual([409, code]);
      expect(await ctx.db.select().from(users).where(eq(users.username, 'nope'))).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
