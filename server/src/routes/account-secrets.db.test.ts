import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountContext, linkToken, mailsTo } from '../../test/account-mail';
import { createUser, nextIp, type TestContext } from '../../test/app';
import { startFakeSmtp, testSmtp, type FakeSmtp } from '../../test/mail';
import { adminHeaders } from '../../test/sso';
import { createLogger } from '../http/logger';
import { mailHandlers } from '../mail/deliver';
import { runUntilIdle } from '../queue/worker';

const TABLES = ['mail_messages', 'audit_events', 'jobs', 'account_tokens', 'users'] as const;

describe('account link secrets never leak (mail E2 A2)', () => {
  let ctx: TestContext;
  let sink: FakeSmtp;
  const workerLines: string[] = [];

  beforeAll(async () => {
    // E1's test SMTP server, without TLS or AUTH, answering 250 to every message.
    sink = await startFakeSmtp({ tls: 'none' });
    ctx = await accountContext({ smtp: testSmtp(sink.port) });
  });
  afterAll(async () => {
    await ctx.close();
    await sink.close();
  });

  const post = (url: string, payload: object, headers?: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url,
      payload,
      remoteAddress: nextIp(),
      ...(headers ? { headers } : {}),
    });

  it('keeps reset and invitation secrets out of every log line, every table and every subject', async () => {
    await createUser(ctx, { username: 'lena', email: 'lena@example.test' });
    expect((await post('/api/v0/auth/password-reset', { login: 'lena' })).statusCode).toBe(202);
    const [reset] = await mailsTo(ctx, 'lena@example.test', 'account.password-reset');
    const resetToken = linkToken(reset!.html, '/reset-password');
    expect(
      (
        await post('/api/v0/auth/password-reset/complete', {
          token: resetToken,
          newPassword: 'lena chose this passphrase',
        })
      ).statusCode,
    ).toBe(200);

    const headers = await adminHeaders(ctx);
    expect(
      (
        await post(
          '/api/v0/users',
          { username: 'otto', email: 'otto@example.test', invite: true },
          headers,
        )
      ).statusCode,
    ).toBe(201);
    const [invite] = await mailsTo(ctx, 'otto@example.test', 'account.invitation');
    const inviteToken = linkToken(invite!.html, '/accept-invite');
    expect(
      (await post('/api/v0/auth/invitations/inspect', { token: inviteToken })).statusCode,
    ).toBe(200);
    expect(
      (
        await post('/api/v0/auth/invitations/accept', {
          token: inviteToken,
          newPassword: 'otto chose this passphrase',
        })
      ).statusCode,
    ).toBe(200);
    // A used link again: the refusal must not echo it either.
    expect(
      (
        await post('/api/v0/auth/invitations/accept', {
          token: inviteToken,
          newPassword: 'otto chose this passphrase',
        })
      ).statusCode,
    ).toBe(400);

    const logger = createLogger('trace', {
      write: (line: string) => {
        workerLines.push(line);
      },
    });
    await runUntilIdle(ctx.db, mailHandlers({ db: ctx.db, config: ctx.config, logger }), logger);
    // reset, its password-changed notice, the invitation (accepting sends none)
    expect(sink.received).toHaveLength(3);

    for (const secret of [resetToken, inviteToken]) {
      expect(ctx.logs.filter((line) => line.includes(secret))).toEqual([]);
      expect(workerLines.filter((line) => line.includes(secret))).toEqual([]);
      for (const table of TABLES) {
        const found = await ctx.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} x WHERE to_jsonb(x)::text LIKE ${`%${secret}%`}`,
        );
        expect(found.rows[0]?.n, `${table} holds a link secret`).toBe(0);
      }
    }
    const bodies = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM mail_messages WHERE payload_enc IS NOT NULL`,
    );
    expect(bodies.rows[0]?.n).toBe(0);
    const subjects = await ctx.db.execute<{ subject: string }>(
      sql`SELECT subject FROM mail_messages`,
    );
    for (const { subject } of subjects.rows) {
      expect(subject).not.toContain(resetToken);
      expect(subject).not.toContain(inviteToken);
    }
  });
});
