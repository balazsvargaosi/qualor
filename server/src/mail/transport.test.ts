import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closedPort,
  FAST_SMTP_TIMEOUTS,
  SMTP_TEST_PASSWORD,
  startFakeSmtp,
  startTarpit,
  TEST_CA_PEM,
  testSmtp,
  type FakeSmtp,
} from '../../test/mail';
import type { MailHeaders } from './payload';
import { ehloName, MailSendError, sendMail, toMailSendError } from './transport';

const message = {
  to: 'ada@example.com',
  subject: 'Hello',
  html: '<p>Hi <b>Ada</b></p>',
  text: 'Hi Ada',
};
const fast = { timeouts: FAST_SMTP_TIMEOUTS };

async function failure(sending: Promise<unknown>): Promise<MailSendError> {
  const outcome = await sending.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(outcome instanceof MailSendError))
    throw new Error(`expected a MailSendError, got ${String(outcome)}`);
  return outcome;
}

describe('sendMail (E1 spec, transport)', () => {
  let plain: FakeSmtp;
  let starttls: FakeSmtp;
  let tls: FakeSmtp;

  beforeAll(async () => {
    plain = await startFakeSmtp({ tls: 'none' });
    starttls = await startFakeSmtp({
      tls: 'starttls',
      auth: { username: 'qualor', password: SMTP_TEST_PASSWORD },
    });
    tls = await startFakeSmtp({ tls: 'tls' });
  });
  afterAll(async () => {
    await Promise.all([plain.close(), starttls.close(), tls.close()]);
  });
  afterEach(() => {
    for (const server of [plain, starttls, tls]) server.received.length = 0;
  });

  it('sends the HTML and text parts with the inline logo, and answers with the server reply', async () => {
    const sent = await sendMail(testSmtp(plain.port, { replyTo: 'help@example.com' }), message, {
      ...fast,
      ehloName: 'qualor.example.com',
    });
    expect(sent.response).toContain('Queued as TEST1');
    expect(sent.ms).toBeGreaterThanOrEqual(0);
    const [mail] = plain.received;
    expect(mail?.from).toBe('qualor@example.com');
    expect(mail?.to).toEqual(['ada@example.com']);
    expect(mail?.ehlo).toBe('qualor.example.com');
    expect(mail?.raw).toMatch(/^From: Qualor <qualor@example\.com>$/m);
    expect(mail?.raw).toMatch(/^Reply-To: help@example\.com$/m);
    expect(mail?.raw).toMatch(/^Subject: Hello$/m);
    expect(mail?.raw).toMatch(/^Content-Type: text\/plain/m);
    expect(mail?.raw).toMatch(/^Content-Type: text\/html/m);
    expect(mail?.raw).toMatch(/^Content-Type: image\/png/m);
    expect(mail?.raw).toMatch(/^Content-ID: <logo@qualor>$/im);
  });

  it('keeps a subject with a line break on one line: no injected header or recipient', async () => {
    await sendMail(
      testSmtp(plain.port),
      { ...message, subject: 'Hi\r\nBcc: evil@example.com' },
      fast,
    );
    const [mail] = plain.received;
    expect(mail?.to).toEqual(['ada@example.com']);
    expect(mail?.raw).not.toMatch(/^Bcc:/im);
    expect(mail?.raw).toMatch(/^Subject: Hi Bcc: evil@example\.com$/m);
  });

  it('keeps a from name with a line break on one From line: no injected header or recipient', async () => {
    await sendMail(
      testSmtp(plain.port, { fromName: 'Qualor\r\nBcc: x@evil.example' }),
      message,
      fast,
    );
    const [mail] = plain.received;
    expect(mail?.to).toEqual(['ada@example.com']);
    expect(mail?.raw).not.toMatch(/^Bcc:/im);
    // The line break is flattened to a space in the display name: one From header.
    const unfolded = mail?.raw.replace(/\n[ \t]+/g, ' ') ?? '';
    expect(unfolded.match(/^From:/gim)).toHaveLength(1);
    expect(unfolded).toMatch(/^From: "Qualor Bcc: x@evil.example" <qualor@example.com>$/m);
  });

  it('refuses a recipient that parses as a list, before connecting', async () => {
    const err = await failure(
      sendMail(testSmtp(plain.port), { ...message, to: 'a@example.com, b@example.com' }, fast),
    );
    expect(err).toMatchObject({ code: 'config', transient: false });
    expect(plain.received).toHaveLength(0);
  });

  it('adds List-Unsubscribe headers and drops any other header a template names', async () => {
    const headers = {
      'List-Unsubscribe': '<https://qualor.example.com/api/v0/notifications/unsubscribe?t=x>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Evil': 'yes',
    } as unknown as MailHeaders;
    await sendMail(testSmtp(plain.port), { ...message, headers }, fast);
    // Long header values are folded onto a continuation line: unfold before matching.
    const raw = (plain.received[0]?.raw ?? '').replace(/\n[ \t]+/g, ' ');
    expect(raw).toMatch(/^List-Unsubscribe: <https:\/\/qualor\.example\.com\//m);
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(raw).not.toMatch(/^X-Evil:/im);
  });

  it('upgrades with STARTTLS, verifies the certificate against the given CA, and authenticates', async () => {
    const server = testSmtp(starttls.port, {
      security: 'starttls',
      username: 'qualor',
      password: SMTP_TEST_PASSWORD,
    });
    await sendMail(server, message, { ...fast, ca: TEST_CA_PEM });
    expect(starttls.received[0]).toMatchObject({ secure: true, user: 'qualor' });
  });

  it('speaks implicit TLS for smtps', async () => {
    await sendMail(testSmtp(tls.port, { security: 'tls' }), message, { ...fast, ca: TEST_CA_PEM });
    expect(tls.received[0]?.secure).toBe(true);
  });

  it('refuses a certificate it cannot verify (no "accept self-signed")', async () => {
    const err = await failure(sendMail(testSmtp(tls.port, { security: 'tls' }), message, fast));
    expect(err).toMatchObject({ code: 'connection', transient: false });
  });

  it('fails STARTTLS against a server that does not offer it, rather than send in clear', async () => {
    const err = await failure(
      sendMail(testSmtp(plain.port, { security: 'starttls' }), message, {
        ...fast,
        ca: TEST_CA_PEM,
      }),
    );
    expect(err).toMatchObject({ code: 'connection', transient: false });
    expect(plain.received).toHaveLength(0);
  });

  it('reports a refused password as auth, permanent, without the password', async () => {
    const wrong = `${SMTP_TEST_PASSWORD}-wrong`;
    const err = await failure(
      sendMail(
        testSmtp(starttls.port, { security: 'starttls', username: 'qualor', password: wrong }),
        message,
        { ...fast, ca: TEST_CA_PEM },
      ),
    );
    expect(err).toMatchObject({ code: 'auth', transient: false, smtpCode: 535 });
    expect(err.message).not.toContain(wrong);
  });

  it('reports a 4xx reply as transient and a 5xx reply as permanent, with the reply line', async () => {
    plain.failNext({ code: 451, message: 'Try again later' });
    const soft = await failure(sendMail(testSmtp(plain.port), message, fast));
    expect(soft).toMatchObject({ code: 'rejected', transient: true, smtpCode: 451 });
    expect(soft.message).toContain('451');
    plain.failNext({ code: 550, message: 'Relay not permitted' });
    const hard = await failure(sendMail(testSmtp(plain.port), message, fast));
    expect(hard).toMatchObject({ code: 'rejected', transient: false, smtpCode: 550 });
    expect(hard.message).toContain('Relay not permitted');
  });

  it('reports a closed port as a transient connection failure', async () => {
    const err = await failure(sendMail(testSmtp(await closedPort()), message, fast));
    expect(err).toMatchObject({ code: 'connection', transient: true, smtpCode: null });
  });

  it('gives up on a server that never greets, as a transient timeout', async () => {
    const tarpit = await startTarpit();
    try {
      const started = Date.now();
      const err = await failure(
        sendMail(testSmtp(tarpit.port), message, {
          timeouts: { connectionMs: 300, greetingMs: 300, socketMs: 600 },
        }),
      );
      expect(err).toMatchObject({ code: 'timeout', transient: true });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await tarpit.close();
    }
  });
});

describe('toMailSendError (E1 spec: transient or permanent)', () => {
  it.each([
    [
      { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Bad credentials' },
      'auth',
      false,
      535,
    ],
    [
      { code: 'EAUTH', responseCode: 454, response: '454 4.7.0 Temporary authentication failure' },
      'auth',
      true,
      454,
    ],
    [{ code: 'ENOAUTH' }, 'auth', false, null],
    [{ code: 'ETIMEDOUT' }, 'timeout', true, null],
    [{ code: 'ECONNECTION', responseCode: 421, response: '421 Too busy' }, 'rejected', true, 421],
    [{ code: 'EENVELOPE', responseCode: 452, response: '452 Mailbox full' }, 'rejected', true, 452],
    [
      { code: 'EENVELOPE', responseCode: 550, response: '550 No such user' },
      'rejected',
      false,
      550,
    ],
    [{ code: 'EENVELOPE' }, 'rejected', false, null],
    [{ code: 'EMESSAGE', responseCode: 552, response: '552 Too big' }, 'rejected', false, 552],
    [{ code: 'ESOCKET' }, 'connection', true, null],
    [{ code: 'EDNS' }, 'connection', true, null],
    [{ code: 'ETLS' }, 'connection', false, null],
    [
      { code: 'ESOCKET', originalCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
      'connection',
      false,
      null,
    ],
    [{ code: 'ESOCKET', originalCode: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'connection', false, null],
    [{ code: 'ESOCKET', originalCode: 'ECONNREFUSED' }, 'connection', true, null],
    [
      { code: 'ETLS', responseCode: 502, response: '502 Command not implemented' },
      'connection',
      false,
      502,
    ],
    [{ code: 'ECONFIG' }, 'config', false, null],
    [new Error('anything else'), 'connection', true, null],
  ] as const)('%j is %s, transient %s', (err, code, transient, smtpCode) => {
    expect(toMailSendError(err)).toMatchObject({ code, transient, smtpCode });
  });

  it('keeps at most 1 KB of a reply, on one line', () => {
    const err = toMailSendError({
      code: 'EENVELOPE',
      responseCode: 550,
      response: `550 ${'é'.repeat(2000)}\r\nmore`,
    });
    expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(1024);
    expect(err.message).not.toMatch(/[\r\n]/);
  });

  it('names the EHLO host from the public URL, else the machine', () => {
    expect(ehloName('https://qualor.example.com/sub')).toBe('qualor.example.com');
    expect(ehloName(null)).not.toBe('');
  });
});
