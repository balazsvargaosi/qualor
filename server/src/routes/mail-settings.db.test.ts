import { createServer, type AddressInfo, type Socket } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  ADMIN_PASSWORD,
  createTestContext,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { SMTP_TEST_PASSWORD, startFakeSmtp, testSmtp, type FakeSmtp } from '../../test/mail';
import { uuidv7 } from '../db/ids';
import { instanceSettings, mailMessages } from '../db/schema';
import {
  UNREADABLE_PASSWORD_TEXT,
  writeMailSettings,
  type MailServerInput,
} from '../mail/settings';

describe('/system/mail (E1 spec, API)', () => {
  let ctx: TestContext;
  let fake: FakeSmtp;
  let admin: Session;
  let orgAdmin: Session;
  const server = (over: Record<string, unknown> = {}) => ({
    host: '127.0.0.1',
    port: fake.port,
    security: 'none',
    username: 'qualor',
    password: SMTP_TEST_PASSWORD,
    fromName: 'Qualor',
    fromAddress: 'qualor@example.com',
    replyTo: null,
    ...over,
  });
  const put = (payload: object, session = admin, c = ctx) =>
    c.app.inject({ method: 'PUT', url: '/api/v0/system/mail', headers: session.headers, payload });
  const get = (session = admin, c = ctx) =>
    c.app.inject({ method: 'GET', url: '/api/v0/system/mail', headers: session.headers });
  const sendTest = (to = 'ada@example.com', session = admin, c = ctx) =>
    c.app.inject({
      method: 'POST',
      url: '/api/v0/system/mail/test',
      headers: session.headers,
      payload: { to },
    });
  const messages = (query = '', session = admin) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v0/system/mail/messages${query}`,
      headers: session.headers,
    });
  /** The field names of the last 'mail settings changed' log line (the audit event's list). */
  const lastChanged = (): unknown => {
    const line = ctx.logs.filter((l) => l.includes('"mail settings changed"')).at(-1);
    return line === undefined ? undefined : (JSON.parse(line) as { fields: unknown }).fields;
  };

  beforeAll(async () => {
    fake = await startFakeSmtp({ tls: 'none' });
    ctx = await createTestContext();
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const u = await createUser(ctx, { username: 'mail-org-admin' });
    await addMember(ctx, await organizationId(ctx, 'default'), u.id, 'admin');
    orgAdmin = await login(ctx, u.username, u.password);
  });
  beforeEach(async () => {
    await ctx.db.delete(mailMessages);
    await ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, 'mail'));
    fake.received.length = 0;
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });

  it('is for instance admins only (an org admin gets 403, nobody 401)', async () => {
    expect((await get(orgAdmin)).statusCode).toBe(403);
    expect((await put({ alerts: { licenseExpiry: false } }, orgAdmin)).statusCode).toBe(403);
    expect((await sendTest('ada@example.com', orgAdmin)).statusCode).toBe(403);
    expect((await messages('', orgAdmin)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v0/system/mail' })).statusCode).toBe(
      401,
    );
  });

  it('says email is off by default', async () => {
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      source: 'settings',
      server: null,
      alerts: { licenseExpiry: true, webhookFailures: true },
      publicUrlSet: false,
      administrators: { total: 1, withoutEmail: 1 },
      lastMessage: null,
    });
  });

  it('stores the password write-only and encrypted, and never returns or logs it', async () => {
    const res = await put({ server: server() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().server).toEqual({
      host: '127.0.0.1',
      port: fake.port,
      security: 'none',
      username: 'qualor',
      passwordSet: true,
      passwordReadable: true,
      fromName: 'Qualor',
      fromAddress: 'qualor@example.com',
      replyTo: null,
    });
    expect(res.body).not.toContain(SMTP_TEST_PASSWORD);
    expect((await get()).body).not.toContain(SMTP_TEST_PASSWORD);
    const [row] = await ctx.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, 'mail'));
    expect(JSON.stringify(row?.value)).not.toContain(SMTP_TEST_PASSWORD);
    expect(ctx.logs.join('\n')).not.toContain(SMTP_TEST_PASSWORD);
    expect(ctx.logs.some((l) => l.includes('mail settings changed') && l.includes('server'))).toBe(
      true,
    );
    expect(lastChanged()).toEqual(['server']);
  });

  it('keeps the password when absent, removes it with null, and removes the server with null', async () => {
    await put({ server: server() });
    const withoutPassword: Record<string, unknown> = server({ port: 2526 });
    delete withoutPassword.password;
    expect((await put({ server: withoutPassword })).json().server).toMatchObject({
      port: 2526,
      passwordSet: true,
    });
    expect(lastChanged()).toEqual(['server.port']);
    expect((await put({ server: server({ password: null }) })).json().server.passwordSet).toBe(
      false,
    );
    expect(lastChanged()).toEqual(['server.port', 'server.password']);
    // Removing a password that is not there changes nothing.
    expect((await put({ server: server({ password: null }) })).statusCode).toBe(200);
    expect(lastChanged()).toEqual([]);
    expect((await put({ server: server() })).json().server.passwordSet).toBe(true);
    expect(lastChanged()).toEqual(['server.password']);
    expect((await put({ server: null })).json().server).toBeNull();
    expect(lastChanged()).toEqual(['server']);
  });

  it.each([
    [{ fromName: 'Qualor\r\nBcc: x@example.com' }, 'body.server.fromName'],
    [{ host: 'bad host' }, 'body.server.host'],
    [{ host: 'smtp.example.com\n' }, 'body.server.host'],
    [{ username: 'a\nb' }, 'body.server.username'],
    [{ password: 'p\r\nq' }, 'body.server.password'],
    [{ fromAddress: 'nobody' }, 'body.server.fromAddress'],
    [{ replyTo: 'x@example.com\r\n' }, 'body.server.replyTo'],
    [{ port: 0 }, 'body.server.port'],
    [{ security: 'ssl' }, 'body.server.security'],
    // The row is jsonb: a lone surrogate or NUL would fail the write (a 500), not the field.
    [{ fromName: 'Qualor \uD800' }, 'body.server.fromName'],
    [{ username: 'a\u0000b' }, 'body.server.username'],
  ])('refuses %j with 422 on %s', async (over, path) => {
    const res = await put({ server: server(over) });
    expect(res.statusCode, res.body).toBe(422);
    expect((res.json() as { errors: { path: string }[] }).errors.map((e) => e.path)).toContain(
      path,
    );
  });

  it('changes an alert switch alone', async () => {
    await put({ server: server() });
    const res = await put({ alerts: { webhookFailures: false } });
    expect(res.json()).toMatchObject({
      alerts: { licenseExpiry: true, webhookFailures: false },
      server: { host: '127.0.0.1', passwordSet: true },
    });
    expect(lastChanged()).toEqual(['alerts.webhookFailures']);
  });

  it('shows a stored server that does not parse as off, and an alert switch leaves it stored', async () => {
    await put({ server: server() });
    const [row] = await ctx.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, 'mail'));
    const value = row!.value as { server: Record<string, unknown>; alerts: unknown };
    const broken = { ...value.server, host: 'not a host' };
    await ctx.db
      .update(instanceSettings)
      .set({ value: { ...value, server: broken } })
      .where(eq(instanceSettings.key, 'mail'));
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().server).toBeNull();
    expect((await put({ alerts: { licenseExpiry: false } })).statusCode).toBe(200);
    expect(lastChanged()).toEqual(['alerts.licenseExpiry']);
    const [after] = await ctx.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, 'mail'));
    expect((after!.value as { server: unknown }).server).toEqual(broken);
  });

  it('answers 409 MAIL_NOT_CONFIGURED for a test without a server', async () => {
    const res = await sendTest();
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('MAIL_NOT_CONFIGURED');
  });

  it.each(['ada@example.com, bob@example.com', 'Ada <ada@example.com>', 'ada@example.com\r\n'])(
    'refuses to send a test to %j: one plain address only (422)',
    async (to) => {
      await put({ server: server({ username: null, password: null }) });
      const res = await sendTest(to);
      expect(res.statusCode, res.body).toBe(422);
      expect((res.json() as { errors: { path: string }[] }).errors.map((e) => e.path)).toContain(
        'body.to',
      );
      expect(fake.received).toHaveLength(0);
    },
  );

  it('sends a test message through the saved server and logs it as sent, without a body', async () => {
    await put({ server: server({ username: null, password: null }) });
    const res = await sendTest();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().response).toContain('Queued as TEST1');
    expect(typeof res.json().ms).toBe('number');
    expect(fake.received[0]?.to).toEqual(['ada@example.com']);
    expect(fake.received[0]?.raw).toMatch(/^Subject: Qualor test message$/m);
    const listed = (await messages()).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      kind: 'test',
      toAddress: 'ada@example.com',
      subject: 'Qualor test message',
      status: 'sent',
      attempts: 1,
      lastError: null,
    });
    expect(listed.items[0].smtpResponse).toContain('Queued as TEST1');
    const [row] = await ctx.db.select().from(mailMessages);
    expect(row?.payloadEnc).toBeNull();
    expect((await get()).json().lastMessage).toMatchObject({ status: 'sent' });
  });

  it('answers 502 MAIL_SEND_FAILED with the server’s reply when the test is refused', async () => {
    await put({ server: server({ username: null, password: null }) });
    fake.failNext({ code: 550, message: 'Sender not allowed' });
    const res = await sendTest();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'MAIL_SEND_FAILED', reason: 'rejected' });
    expect(res.json().detail).toContain('550 Sender not allowed');
    const [row] = await ctx.db.select().from(mailMessages);
    expect(row).toMatchObject({ kind: 'test', status: 'failed', payloadEnc: null });
    expect(row?.lastError).toContain('550');
    expect((await get()).json().lastMessage).toMatchObject({ status: 'failed' });
  });

  it('reports a password that no longer decrypts, and fails its test with the reason (502 config)', async () => {
    // Stored under another QUALOR_SECRET_KEY, as after a key rotation.
    await ctx.db.transaction((tx) =>
      writeMailSettings(
        tx,
        { server: server({ password: SMTP_TEST_PASSWORD }) as MailServerInput },
        'another-secret-key-that-is-at-least-32-characters',
      ),
    );
    expect((await get()).json().server).toMatchObject({
      passwordSet: true,
      passwordReadable: false,
    });
    const res = await sendTest();
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json()).toMatchObject({
      code: 'MAIL_SEND_FAILED',
      reason: 'config',
      detail: UNREADABLE_PASSWORD_TEXT,
    });
    expect(fake.received).toHaveLength(0);
    const [row] = await ctx.db.select().from(mailMessages);
    expect(row).toMatchObject({ status: 'failed', lastError: UNREADABLE_PASSWORD_TEXT });
  });

  it('allows one test in flight per admin: a second one meanwhile is refused (429)', async () => {
    // A server that accepts the connection and never greets: the first test waits on it.
    const sockets = new Set<Socket>();
    let connected!: () => void;
    const reached = new Promise<void>((resolve) => (connected = resolve));
    const tarpit = createServer((socket) => {
      sockets.add(socket);
      connected();
    });
    await new Promise<void>((resolve) => tarpit.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = tarpit.address() as AddressInfo;
      await put({ server: server({ port, username: null, password: null }) });
      const first = sendTest();
      await reached;
      const second = await sendTest();
      expect(second.statusCode, second.body).toBe(429);
      expect(second.json().code).toBe('RATE_LIMITED');
      expect(second.headers['retry-after']).toBeDefined();
      for (const socket of sockets) socket.destroy();
      const firstRes = await first;
      expect(firstRes.statusCode, firstRes.body).toBe(502);
      expect(firstRes.json().reason).toBe('connection');
      // Only the first was logged: the refused one never reached the server.
      expect(await ctx.db.select().from(mailMessages)).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => tarpit.close(() => resolve()));
    }
  });

  it('allows ten tests a minute per admin', async () => {
    const u = await createUser(ctx, { username: 'mail-limit-admin', isInstanceAdmin: true });
    const other = await login(ctx, u.username, u.password);
    await put({ server: server({ username: null, password: null }) });
    for (let i = 0; i < 10; i++) {
      expect((await sendTest('ada@example.com', other)).statusCode).toBe(200);
    }
    const res = await sendTest('ada@example.com', other);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('pages the log newest first, at most 100 a page', async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) {
      await ctx.db.insert(mailMessages).values({
        id,
        kind: 'test',
        toAddress: 'ops@example.com',
        subject: id,
        status: 'sent',
        attempts: 1,
      });
    }
    const first = (await messages('?limit=2')).json();
    expect(first.items.map((m: { id: string }) => m.id)).toEqual([ids[2], ids[1]]);
    const second = (await messages(`?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((m: { id: string }) => m.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect((await messages('?limit=101')).statusCode).toBe(422);
    expect((await messages('?cursor=bogus')).statusCode).toBe(422);
  });

  it('pages by creation time, then id: rows of one transaction share created_at', async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    // An older row with a later id: created_at decides, not the id.
    const older = uuidv7();
    await ctx.db.transaction(async (tx) => {
      for (const id of ids) {
        await tx.insert(mailMessages).values({
          id,
          kind: 'test',
          toAddress: 'ops@example.com',
          subject: id,
          status: 'sent',
          attempts: 1,
        });
      }
    });
    await ctx.db.insert(mailMessages).values({
      id: older,
      kind: 'test',
      toAddress: 'ops@example.com',
      subject: older,
      status: 'sent',
      attempts: 1,
      createdAt: new Date(Date.now() - 60_000),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=1' : `?limit=1&cursor=${cursor}`;
      const page = (await messages(query)).json() as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
    } while (cursor !== null && seen.length < 10);
    expect(seen).toEqual([ids[2], ids[1], ids[0], older]);
  });

  describe('with QUALOR_SMTP_URL', () => {
    let env: TestContext;
    let envAdmin: Session;

    beforeAll(async () => {
      env = await createTestContext({
        config: { smtp: testSmtp(fake.port), publicUrl: 'https://qualor.example.com' },
      });
      envAdmin = await login(env, 'admin', ADMIN_PASSWORD);
    });
    afterAll(async () => {
      await env.close();
    });

    it('shows the environment’s server read-only, refuses to change it, and keeps the alerts editable', async () => {
      expect((await get(envAdmin, env)).json()).toMatchObject({
        source: 'environment',
        server: {
          host: '127.0.0.1',
          port: fake.port,
          security: 'none',
          username: null,
          passwordSet: false,
        },
        publicUrlSet: true,
      });
      for (const body of [{ server: server() }, { server: null }]) {
        const res = await put(body, envAdmin, env);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('MAIL_SET_BY_ENVIRONMENT');
      }
      const res = await put({ alerts: { licenseExpiry: false } }, envAdmin, env);
      expect(res.statusCode).toBe(200);
      expect(res.json().alerts.licenseExpiry).toBe(false);
      expect((await sendTest('ada@example.com', envAdmin, env)).statusCode).toBe(200);
    });
  });
});
