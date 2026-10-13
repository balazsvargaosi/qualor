import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/app';
import {
  FAST_SMTP_TIMEOUTS,
  SMTP_TEST_PASSWORD,
  startFakeSmtp,
  TEST_CA_PEM,
  testSmtp,
  type FakeSmtp,
} from '../../test/mail';
import type { SmtpConfig } from '../config';
import { jobs, mailMessages } from '../db/schema';
import { runUntilIdle } from '../queue/worker';
import {
  deliverMail,
  MAIL_MAX_ATTEMPTS,
  mailHandlers,
  NOT_CONFIGURED_TEXT,
  UNDECRYPTABLE_TEXT,
  type MailDeliveryDeps,
} from './deliver';
import { MAIL_QUEUE, queueMail } from './outbox';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('mail delivery (E1 spec, Delivery)', () => {
  let t: TestContext;
  let plain: FakeSmtp;
  let starttls: FakeSmtp;
  const lines: string[] = [];
  // Methods that take anything, so the object fits FastifyBaseLogger's overloaded log functions.
  const logger = {
    info: (...args: unknown[]) => void lines.push(JSON.stringify(args)),
    warn: (...args: unknown[]) => void lines.push(JSON.stringify(args)),
  };
  const depsFor = (
    smtp: SmtpConfig | null = testSmtp(plain.port),
    secretKey = t.config.secretKey,
  ): MailDeliveryDeps => ({
    db: t.db,
    config: { ...t.config, smtp, secretKey },
    send: { timeouts: FAST_SMTP_TIMEOUTS, ca: TEST_CA_PEM },
    logger,
  });
  const queue = (deps: MailDeliveryDeps) =>
    t.db.transaction(async (tx) => {
      const queued = await queueMail(tx, deps, {
        kind: 'test',
        to: { address: 'ada@example.com' },
        render: () => ({
          subject: 'Delivery test',
          html: '<p>Body HTML 7Z</p>',
          text: 'Body text 7Z',
        }),
      });
      if (queued.status !== 'queued') throw new Error(`not queued: ${queued.status}`);
      return queued.id;
    });
  const row = async (id: string) =>
    (await t.db.select().from(mailMessages).where(eq(mailMessages.id, id)))[0]!;
  const queuedJobs = () =>
    t.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.queue, MAIL_QUEUE), eq(jobs.status, 'queued')));
  /** Makes every queued mail job due now, then runs the queue until idle. */
  const runDue = async (deps: MailDeliveryDeps) => {
    await t.db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(eq(jobs.queue, MAIL_QUEUE));
    return runUntilIdle(t.db, mailHandlers(deps), silent);
  };

  beforeAll(async () => {
    t = await createTestContext();
    plain = await startFakeSmtp({ tls: 'none' });
    starttls = await startFakeSmtp({
      tls: 'starttls',
      auth: { username: 'qualor', password: SMTP_TEST_PASSWORD },
    });
  });
  beforeEach(async () => {
    await t.db.delete(mailMessages);
    await t.db.delete(jobs).where(eq(jobs.queue, MAIL_QUEUE));
    plain.received.length = 0;
    starttls.received.length = 0;
    lines.length = 0;
  });
  afterAll(async () => {
    await Promise.all([plain.close(), starttls.close()]);
    await t.close();
  });

  it('sends a queued message, keeps the server reply and drops the body', async () => {
    const deps = depsFor();
    const id = await queue(deps);
    await runDue(deps);
    const sent = await row(id);
    expect(sent).toMatchObject({
      status: 'sent',
      attempts: 1,
      payloadEnc: null,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(sent.smtpResponse).toContain('Queued as TEST1');
    expect(sent.sentAt).not.toBeNull();
    expect(plain.received[0]?.raw).toContain('Body text 7Z');
  });

  it('retries a 4xx reply a minute later with a new job, then sends', async () => {
    const deps = depsFor();
    const id = await queue(deps);
    plain.failNext({ code: 451, message: 'Greylisted, try again' });
    await runUntilIdle(t.db, mailHandlers(deps), silent);
    const waiting = await row(id);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
    expect(waiting.lastError).toContain('451');
    expect(waiting.payloadEnc).not.toBeNull();
    const delay = await t.db.execute<{ secs: number }>(
      sql`SELECT extract(epoch FROM next_attempt_at - now())::int AS secs FROM mail_messages WHERE id = ${id}`,
    );
    expect(delay.rows[0]?.secs).toBeGreaterThan(50);
    expect(delay.rows[0]?.secs).toBeLessThanOrEqual(60);
    expect((await queuedJobs()).map((j) => j.payload)).toEqual([{ messageId: id, attempts: 1 }]);
    await runDue(deps);
    expect(await row(id)).toMatchObject({
      status: 'sent',
      attempts: 2,
      lastError: null,
      payloadEnc: null,
    });
  });

  it('fails a 5xx reply at once and drops the body', async () => {
    const deps = depsFor();
    const id = await queue(deps);
    plain.failNext({ code: 550, message: 'Relay not permitted' });
    await runDue(deps);
    const failed = await row(id);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      payloadEnc: null,
      smtpResponse: null,
    });
    expect(failed.lastError).toContain('550 Relay not permitted');
    expect(await queuedJobs()).toEqual([]);
  });

  it('gives up after the seventh transient failure', async () => {
    const deps = depsFor();
    const id = await queue(deps);
    await t.db
      .update(mailMessages)
      .set({ attempts: MAIL_MAX_ATTEMPTS - 1 })
      .where(eq(mailMessages.id, id));
    plain.failNext({ code: 451, message: 'Still busy' });
    expect(await deliverMail(deps, id, MAIL_MAX_ATTEMPTS - 1)).toBe('failed');
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 7, payloadEnc: null });
  });

  it('fails a refused password at once, without the password in the log', async () => {
    const wrong = `${SMTP_TEST_PASSWORD}-wrong`;
    const deps = depsFor(
      testSmtp(starttls.port, { security: 'starttls', username: 'qualor', password: wrong }),
    );
    const id = await queue(deps);
    await runDue(deps);
    const failed = await row(id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, payloadEnc: null });
    expect(failed.lastError).not.toContain(wrong);
    // F7: the attempt is logged, and nothing secret or personal is in the lines.
    const log = lines.join('\n');
    expect(log).toContain(id);
    expect(log).toContain('"status":"failed"');
    expect(log).toContain('"smtpCode":535');
    expect(log).not.toContain(SMTP_TEST_PASSWORD);
    expect(log).not.toContain('ada@example.com');
    expect(log).not.toContain('Delivery test');
    expect(log).not.toContain('7Z');
  });

  it('sends over STARTTLS with a verified certificate and authentication', async () => {
    const deps = depsFor(
      testSmtp(starttls.port, {
        security: 'starttls',
        username: 'qualor',
        password: SMTP_TEST_PASSWORD,
      }),
    );
    const id = await queue(deps);
    await runDue(deps);
    expect((await row(id)).status).toBe('sent');
    expect(starttls.received[0]).toMatchObject({ secure: true, user: 'qualor' });
  });

  it('fails without sending when STARTTLS is required and the server does not offer it', async () => {
    const deps = depsFor(testSmtp(plain.port, { security: 'starttls' }));
    const id = await queue(deps);
    await runDue(deps);
    expect(await row(id)).toMatchObject({ status: 'failed', payloadEnc: null });
    expect(plain.received).toHaveLength(0);
  });

  it('fails a message whose server was removed before it was sent', async () => {
    const id = await queue(depsFor());
    expect(await deliverMail(depsFor(null), id, 0)).toBe('failed');
    expect(await row(id)).toMatchObject({
      status: 'failed',
      lastError: NOT_CONFIGURED_TEXT,
      payloadEnc: null,
    });
  });

  it('fails a message whose body was encrypted under an earlier QUALOR_SECRET_KEY', async () => {
    const id = await queue(depsFor());
    const rotated = depsFor(testSmtp(plain.port), 'a-later-secret-key-of-at-least-32-characters');
    expect(await deliverMail(rotated, id, 0)).toBe('failed');
    expect(await row(id)).toMatchObject({
      status: 'failed',
      lastError: UNDECRYPTABLE_TEXT,
      payloadEnc: null,
    });
    expect(plain.received).toHaveLength(0);
  });

  it('does nothing for a job whose attempt is already recorded, or whose row is gone', async () => {
    const deps = depsFor();
    const id = await queue(deps);
    await runDue(deps);
    expect(await deliverMail(deps, id, 0)).toBe('settled');
    expect(plain.received).toHaveLength(1);
    expect(await deliverMail(deps, '0192f5a4-7c1e-7d3a-9b2e-5f1a2c3d4e5f', 0)).toBe('gone');
  });

  it('logs each attempt without the address, the subject or the body', async () => {
    const deps = depsFor();
    const id = await queue(deps);
    await runDue(deps);
    const log = lines.join('\n');
    expect(log).toContain(id);
    expect(log).toContain('"status":"sent"');
    expect(log).not.toContain('ada@example.com');
    expect(log).not.toContain('Delivery test');
    expect(log).not.toContain('7Z');
  });
});
