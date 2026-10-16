import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountContext, linkToken, mailsTo, untilLockWait } from '../../test/account-mail';
import { login, nextIp, type TestContext } from '../../test/app';
import { adminHeaders, auditRows, oidcConnection } from '../../test/sso';
import {
  INVITATION_TTL_MINUTES,
  issueAccountToken,
  peekAccountToken,
} from '../auth/account-tokens';
import { hashPassword } from '../auth/password';
import { identities, instanceSettings, users } from '../db/schema';

describe('accepting an invitation (mail E2)', () => {
  let ctx: TestContext;
  let headers: Record<string, string>;
  beforeAll(async () => {
    ctx = await accountContext();
    headers = await adminHeaders(ctx);
  });
  afterAll(async () => ctx.close());

  const invite = async (username: string, displayName?: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/users',
      headers,
      payload: {
        username,
        invite: true,
        email: `${username}@example.test`,
        ...(displayName ? { displayName } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    const [mail] = await mailsTo(ctx, `${username}@example.test`, 'account.invitation');
    return { id: res.json().id as string, token: linkToken(mail!.html, '/accept-invite') };
  };
  const post = (url: string, payload: object) =>
    ctx.app.inject({ method: 'POST', url, payload, remoteAddress: nextIp() });
  const inspect = (token: string) => post('/api/v0/auth/invitations/inspect', { token });
  const accept = (token: string, newPassword = 'my own first passphrase') =>
    post('/api/v0/auth/invitations/accept', { token, newPassword });
  /** A response's status and problem code, compared with INVALID in the tests below. */
  const outcome = (res: { statusCode: number; json(): { code?: string } }) => [
    res.statusCode,
    res.json().code,
  ];
  const INVALID = [400, 'TOKEN_INVALID'];

  it('shows who is invited and by whom, without using the link up', async () => {
    const { token } = await invite('ida', 'Ida Lane');
    for (let i = 0; i < 2; i++) {
      const res = await inspect(token);
      expect([res.statusCode, res.json()]).toEqual([
        200,
        { username: 'ida', displayName: 'Ida Lane', invitedBy: 'Administrator' },
      ]);
    }
  });

  it('sets the first password, does not sign in, works once, and sends no password-changed notice', async () => {
    const { id, token } = await invite('jon');
    const res = await accept(token);
    expect([res.statusCode, res.json()]).toEqual([200, { username: 'jon' }]);
    expect(res.cookies).toEqual([]);
    expect((await login(ctx, 'jon', 'my own first passphrase')).cookie).toBeTruthy();
    expect(outcome(await accept(token))).toEqual(INVALID);
    expect(outcome(await inspect(token))).toEqual(INVALID);
    expect(await mailsTo(ctx, 'jon@example.test', 'account.password-changed')).toEqual([]);
    expect(
      (await auditRows(ctx)).find((e) => e.action === 'auth.invitation_accepted'),
    ).toMatchObject({
      actorUserId: id,
      targetId: id,
      details: {},
    });
  });

  it('refuses when the user has a password by now, and uses the link up', async () => {
    const { id, token } = await invite('kai');
    await ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword('set elsewhere meanwhile') })
      .where(eq(users.id, id));
    expect(outcome(await inspect(token))).toEqual(INVALID);
    expect(outcome(await accept(token))).toEqual(INVALID);
    expect(await peekAccountToken(ctx.db, token, 'invitation')).toBeNull();
  });

  it('refuses a reset link here, and leaves it working', async () => {
    const { id } = await invite('lou');
    const { token } = await issueAccountToken(ctx.db, {
      userId: id,
      kind: 'password_reset',
      createdBy: null,
      ttlMinutes: 60,
    });
    expect(outcome(await inspect(token))).toEqual(INVALID);
    expect(outcome(await accept(token))).toEqual(INVALID);
    expect(await peekAccountToken(ctx.db, token, 'password_reset')).not.toBeNull();
  });

  it('checks the policy when the link is looked at and used', async () => {
    const { token } = await invite('max');
    await ctx.db.insert(instanceSettings).values({
      key: 'sign-in',
      value: { passwordSignIn: 'break_glass_only', breakGlassUserIds: [ctx.adminId] },
    });
    try {
      expect(outcome(await inspect(token))).toEqual(INVALID);
      expect(outcome(await accept(token))).toEqual(INVALID);
    } finally {
      await ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, 'sign-in'));
    }
  });

  it('waits behind a resend for the same account (user row, then the link), never deadlocking', async () => {
    const { id, token } = await invite('rue');
    let answer: ReturnType<typeof accept> | undefined;
    let fresh = '';
    // POST /users/:id/invitation's order: the user row, then the new link over the old one.
    await ctx.db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, id)).for('update');
      answer = accept(token);
      await untilLockWait(ctx);
      fresh = (
        await issueAccountToken(tx, {
          userId: id,
          kind: 'invitation',
          createdBy: ctx.adminId,
          ttlMinutes: INVITATION_TTL_MINUTES,
        })
      ).token;
    });
    expect(outcome(await answer!)).toEqual(INVALID);
    expect((await inspect(fresh)).statusCode).toBe(200);
  });

  it('refuses malformed and unknown links', async () => {
    expect(outcome(await inspect('not a token'))).toEqual(INVALID);
    expect(outcome(await inspect('A'.repeat(43)))).toEqual(INVALID);
    expect(outcome(await accept('A'.repeat(43)))).toEqual(INVALID);
  });

  it('refuses a deactivated user, uses the link up, and sets no password', async () => {
    const { id, token } = await invite('nia');
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, id));
    expect(outcome(await inspect(token))).toEqual(INVALID);
    expect(outcome(await accept(token))).toEqual(INVALID);
    expect(await peekAccountToken(ctx.db, token, 'invitation')).toBeNull();
    const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(row!.passwordHash).toBeNull();
  });

  it('refuses the demo user, uses the link up, and sets no password', async () => {
    const { id, token } = await invite('guest');
    expect(ctx.config.demoUser).toBe('guest');
    expect(outcome(await inspect(token))).toEqual(INVALID);
    expect(outcome(await accept(token))).toEqual(INVALID);
    expect(await peekAccountToken(ctx.db, token, 'invitation')).toBeNull();
    const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(row!.passwordHash).toBeNull();
  });

  it('refuses an account linked to single sign-on meanwhile, uses the link up, and sets no password', async () => {
    const { id, token } = await invite('sso-pat');
    const connectionId = await oidcConnection(ctx, { name: 'Accept IdP' });
    await ctx.db
      .insert(identities)
      .values({ connectionId, userId: id, subject: 'sub-sso-pat', linkedBy: 'verified_email' });
    expect(outcome(await inspect(token))).toEqual(INVALID);
    expect(await peekAccountToken(ctx.db, token, 'invitation')).not.toBeNull();
    expect(outcome(await accept(token))).toEqual(INVALID);
    expect(await peekAccountToken(ctx.db, token, 'invitation')).toBeNull();
    const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(row!.passwordHash).toBeNull();
  });

  it('answers a malformed link without hashing, and a short password without using the link', async () => {
    const { token } = await invite('oli');
    const started = Date.now();
    expect(outcome(await accept('x'.repeat(200)))).toEqual(INVALID);
    expect(Date.now() - started).toBeLessThan(500);
    const short = await accept(token, 'short');
    expect(short.statusCode).toBe(422);
    expect(short.json().code).not.toBe('TOKEN_INVALID');
    expect((await inspect(token)).statusCode).toBe(200);
  });
});
