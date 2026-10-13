import { createServer, type AddressInfo, type Socket } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { TEST_CA_PEM, TEST_SERVER_CERT_PEM, TEST_SERVER_KEY_PEM } from '../../cli/test/tls';
import type { SmtpConfig } from '../src/config';

/** The test CA that signed TEST_SERVER_CERT_PEM (127.0.0.1 and localhost; cli/test/tls.ts). */
export { TEST_CA_PEM };

/** A test password, built from parts so no scanner mistakes it for a real credential. */
export const SMTP_TEST_PASSWORD = ['smtp', 'test', 'pass', 'word', '4K'].join('-');

/** Short timeouts, so a failing test ends in seconds. */
export const FAST_SMTP_TIMEOUTS = { connectionMs: 1_000, greetingMs: 1_000, socketMs: 2_000 };

/** An SMTP server on 127.0.0.1 as Config.smtp names it; no TLS unless `over` says so. */
export function testSmtp(port: number, over: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: '127.0.0.1',
    port,
    security: 'none',
    username: null,
    password: null,
    fromName: 'Qualor',
    fromAddress: 'qualor@example.com',
    replyTo: null,
    ...over,
  };
}

export interface ReceivedMail {
  from: string;
  to: string[];
  raw: string;
  /** The message came over TLS (implicit or STARTTLS). */
  secure: boolean;
  /** The user it authenticated as, or null. */
  user: string | null;
  /** The EHLO name the client gave. */
  ehlo: string;
}

export interface FakeSmtp {
  port: number;
  received: ReceivedMail[];
  /** Refuses the next DATA commands with these replies, in order. */
  failNext(...replies: { code: number; message: string }[]): void;
  close(): Promise<void>;
}

/**
 * An SMTP server for tests (smtp-server): `starttls` offers STARTTLS with the test certificate,
 * `tls` is implicit TLS, `none` offers no TLS at all. With `auth`, those credentials are the only
 * ones accepted; without, AUTH is off. Accepted messages answer `250 Queued as TEST1`.
 */
export async function startFakeSmtp(options: {
  tls: 'starttls' | 'tls' | 'none';
  auth?: { username: string; password: string };
}): Promise<FakeSmtp> {
  const received: ReceivedMail[] = [];
  const failures: { code: number; message: string }[] = [];
  const disabled = [
    ...(options.tls === 'none' ? ['STARTTLS'] : []),
    ...(options.auth ? [] : ['AUTH']),
  ];
  const server = new SMTPServer({
    secure: options.tls === 'tls',
    key: TEST_SERVER_KEY_PEM,
    cert: TEST_SERVER_CERT_PEM,
    disabledCommands: disabled,
    authOptional: options.auth === undefined,
    allowInsecureAuth: options.tls === 'none',
    closeTimeout: 1_000,
    logger: false,
    onAuth(auth, _session, callback) {
      const ok =
        options.auth !== undefined &&
        auth.username === options.auth.username &&
        auth.password === options.auth.password;
      if (ok) callback(null, { user: auth.username });
      else
        callback(
          Object.assign(new Error('Authentication credentials invalid'), { responseCode: 535 }),
        );
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const failure = failures.shift();
        if (failure) {
          callback(Object.assign(new Error(failure.message), { responseCode: failure.code }));
          return;
        }
        const from = session.envelope.mailFrom;
        received.push({
          from: from === false ? '' : from.address,
          to: session.envelope.rcptTo.map((r) => r.address),
          // SMTP lines end in CRLF; LF only, so tests can match header lines with /^…$/m.
          raw: Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n'),
          secure: session.secure,
          user: typeof session.user === 'string' ? session.user : null,
          ehlo: session.hostNameAppearsAs,
        });
        callback(null, 'Queued as TEST1');
      });
    },
  });
  // A client that drops the TLS handshake (it refuses the certificate) is not a test failure.
  server.on('error', () => undefined);
  const listener = server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  const { port } = listener.address() as AddressInfo;
  return {
    port,
    received,
    failNext: (...replies) => {
      failures.push(...replies);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A TCP server that accepts connections and never says a word (a tarpit). */
export async function startTarpit(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port on 127.0.0.1 that nothing listens on (taken, then released). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
