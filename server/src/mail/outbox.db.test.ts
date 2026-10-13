import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, createUser, type TestContext } from '../../test/app';
import { testSmtp } from '../../test/mail';
import { decryptSecret, encryptionKey } from '../crypto/secrets';
import { jobs, mailMessages } from '../db/schema';
import {
  MAIL_QUEUE,
  mailPayloadAad,
  queueMail,
  queueMailToAdmins,
  type MailDeps,
  type MailRecipient,
  type QueueMailInput,
} from './outbox';

describe('the outbox (E1 spec, Outbox)', () => {
  let t: TestContext;
  let deps: MailDeps;
  const input = (over: Partial<QueueMailInput> = {}): QueueMailInput => ({
    kind: 'test',
    to: { address: 'ada@example.com' },
    render: () => ({ subject: 'Hello', html: '<p>Secret body HTML</p>', text: 'Secret body text' }),
    ...over,
  });
  const queue = (i: QueueMailInput, d: MailDeps = deps) =>
    t.db.transaction((tx) => queueMail(tx, d, i));
  const rows = () => t.db.select().from(mailMessages).orderBy(mailMessages.id);
  const mailJobs = () => t.db.select().from(jobs).where(eq(jobs.queue, MAIL_QUEUE));

  beforeAll(async () => {
    t = await createTestContext();
    deps = { config: { ...t.config, smtp: testSmtp(2525) } };
  });
  beforeEach(async () => {
    await t.db.delete(mailMessages);
    await t.db.delete(jobs).where(eq(jobs.queue, MAIL_QUEUE));
  });
  afterAll(async () => {
    await t.close();
  });

  it('queues nothing while email is not configured', async () => {
    expect(await queue(input(), { config: t.config })).toEqual({ status: 'skipped' });
    expect(await rows()).toEqual([]);
    expect(await mailJobs()).toEqual([]);
  });

  it('stores one encrypted pending row and its job, in the caller’s transaction', async () => {
    const result = await queue(input({ to: { address: 'Ada@Example.com', userId: t.adminId } }));
    expect(result.status).toBe('queued');
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: 'test',
      userId: t.adminId,
      toAddress: 'Ada@Example.com',
      subject: 'Hello',
      status: 'pending',
      attempts: 0,
    });
    expect(result).toEqual({ status: 'queued', id: row!.id });
    expect(JSON.stringify(row)).not.toContain('Secret body');
    const plain = decryptSecret(
      encryptionKey(t.config.secretKey),
      row!.payloadEnc!,
      mailPayloadAad(row!.id),
    );
    expect(JSON.parse(plain!)).toEqual({
      html: '<p>Secret body HTML</p>',
      text: 'Secret body text',
    });
    const [job] = await mailJobs();
    expect(job?.payload).toEqual({ messageId: row!.id, attempts: 0 });
  });

  it('keeps the subject on one line and at most 300 characters', async () => {
    await queue(
      input({
        render: () => ({
          subject: `Hi\r\nBcc: evil@example.com ${'x'.repeat(400)}`,
          html: '<p>x</p>',
          text: 'x',
        }),
      }),
    );
    const [row] = await rows();
    expect(row?.subject).toMatch(/^Hi Bcc: evil@example\.com x+$/);
    expect(row?.subject.length).toBe(300);
  });

  it('writes nothing when the caller’s transaction rolls back', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await queueMail(tx, deps, input());
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await rows()).toEqual([]);
    expect(await mailJobs()).toEqual([]);
  });

  it('skips a duplicate for the same address within the window, not for another one or later', async () => {
    const dedupe = { key: 'webhook.failed:w1', withinHours: 24 };
    expect((await queue(input({ dedupe }))).status).toBe('queued');
    expect(await queue(input({ dedupe, to: { address: 'ADA@example.com' } }))).toEqual({
      status: 'duplicate',
    });
    expect((await queue(input({ dedupe, to: { address: 'bob@example.com' } }))).status).toBe(
      'queued',
    );
    await t.db.execute(sql`UPDATE mail_messages SET created_at = now() - interval '25 hours'`);
    expect((await queue(input({ dedupe }))).status).toBe('queued');
    expect(await rows()).toHaveLength(3);
  });

  it.each([
    ['not an address', 'not an address'],
    ['a list', 'a@example.com, b@example.com'],
    ['a name form', 'Ada <ada@example.com>'],
    ['a line break', 'ada@example.com\r\nBcc: evil@example.com'],
    ['a trailing line break', 'ada@example.com\n'],
  ])('skips and stores nothing for %s', async (_name, address) => {
    expect(await queue(input({ to: { address } }))).toEqual({ status: 'skipped' });
    expect(await rows()).toEqual([]);
    expect(await mailJobs()).toEqual([]);
  });

  it('queues one message per active instance administrator with an email, ordered by email', async () => {
    const zed = await createUser(t, {
      username: 'outbox-zed',
      email: 'zed@example.com',
      isInstanceAdmin: true,
    });
    const amy = await createUser(t, {
      username: 'outbox-amy',
      email: 'amy@example.com',
      isInstanceAdmin: true,
    });
    await createUser(t, { username: 'outbox-noemail', isInstanceAdmin: true });
    await createUser(t, {
      username: 'outbox-gone',
      email: 'gone@example.com',
      isInstanceAdmin: true,
      active: false,
    });
    await createUser(t, { username: 'outbox-member', email: 'member@example.com' });
    const seen: MailRecipient[] = [];
    const results = await t.db.transaction((tx) =>
      queueMailToAdmins(tx, deps, {
        kind: 'license.expiry',
        dedupe: { key: 'license.expiry:k', withinHours: 24 },
        render: (to) => {
          seen.push(to);
          return { subject: `For ${to.username}`, html: '<p>x</p>', text: 'x' };
        },
      }),
    );
    expect(results.map((r) => r.status)).toEqual(['queued', 'queued']);
    expect(seen).toEqual([
      { userId: amy.id, address: 'amy@example.com', username: 'outbox-amy', displayName: null },
      { userId: zed.id, address: 'zed@example.com', username: 'outbox-zed', displayName: null },
    ]);
    const stored = await t.db
      .select({
        to: mailMessages.toAddress,
        subject: mailMessages.subject,
        dedupe: mailMessages.dedupeKey,
      })
      .from(mailMessages)
      .where(eq(mailMessages.kind, 'license.expiry'))
      .orderBy(mailMessages.toAddress);
    expect(stored).toEqual([
      { to: 'amy@example.com', subject: 'For outbox-amy', dedupe: 'license.expiry:k' },
      { to: 'zed@example.com', subject: 'For outbox-zed', dedupe: 'license.expiry:k' },
    ]);
  });
});
