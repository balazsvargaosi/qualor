import { hostname } from 'node:os';
import { createTransport } from 'nodemailer';
import type { SmtpConfig } from '../config';
import { isEmailAddress } from './address';
import { LOGO_CID, logoPng } from './assets/logo';
import { MAIL_HEADER_NAMES, type MailHeaders } from './payload';
import { clipUtf8, oneLine } from './text';

/** The server a message goes through: Config.smtp, or the settings row with its password decrypted. */
export type MailServer = SmtpConfig;

export const MAIL_ERROR_CODES = ['connection', 'auth', 'rejected', 'timeout', 'config'] as const;
export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

/** `last_error` and `smtp_response` keep at most this many bytes. */
export const MAX_SMTP_TEXT_BYTES = 1024;

/**
 * A send that did not end with the server accepting the message. `message` is the SMTP reply line
 * (at most 1 KB) or a fixed text: never the password, never the body. `transient`: worth a retry.
 */
export class MailSendError extends Error {
  readonly code: MailErrorCode;
  readonly smtpCode: number | null;
  readonly transient: boolean;

  constructor(
    code: MailErrorCode,
    message: string,
    options: { smtpCode?: number | null; transient: boolean },
  ) {
    super(message);
    this.name = 'MailSendError';
    this.code = code;
    this.smtpCode = options.smtpCode ?? null;
    this.transient = options.transient;
  }
}

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: MailHeaders;
}

export interface SmtpTimeouts {
  connectionMs: number;
  greetingMs: number;
  socketMs: number;
}

/** E1 spec: 10 s to connect, 10 s for the greeting, 30 s of silence on the socket. */
export const SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 30_000,
};

export interface SendOptions {
  /** The EHLO name ({@link ehloName}). */
  ehloName?: string;
  /** Tests only: a CA the server's certificate chains to (production: NODE_EXTRA_CA_CERTS). */
  ca?: string;
  /** Tests only: shorter timeouts. */
  timeouts?: SmtpTimeouts;
}

/** The EHLO name: QUALOR_PUBLIC_URL's host, else the machine's name. */
export function ehloName(publicUrl: string | null): string {
  if (publicUrl !== null) return new URL(publicUrl).hostname;
  return hostname() || 'localhost';
}

/** Only the headers of MAIL_HEADER_NAMES, and only values of one line. */
function allowedHeaders(headers: MailHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of MAIL_HEADER_NAMES) {
    const value = headers?.[name];
    if (typeof value === 'string' && !/[\r\n]/.test(value)) out[name] = value;
  }
  return out;
}

/**
 * Sends one message through `server` with a fresh connection (low volume: no pool). TLS is always
 * verified; `starttls` refuses a server that does not offer STARTTLS; `none` never tries it.
 */
export async function sendMail(
  server: MailServer,
  message: OutgoingMail,
  options: SendOptions = {},
): Promise<{ response: string; ms: number }> {
  // nodemailer parses an address string as a list: refuse anything but one plain address.
  if (!isEmailAddress(message.to)) {
    throw new MailSendError('config', 'The recipient is not a single email address', {
      transient: false,
    });
  }
  const timeouts = options.timeouts ?? SMTP_TIMEOUTS;
  const transport = createTransport({
    host: server.host,
    port: server.port,
    secure: server.security === 'tls',
    requireTLS: server.security === 'starttls',
    ignoreTLS: server.security === 'none',
    name: options.ehloName ?? ehloName(null),
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    tls: {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    },
    ...(server.username === null
      ? {}
      : { auth: { user: server.username, pass: server.password ?? '' } }),
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  const started = performance.now();
  try {
    const info = await transport.sendMail({
      from: { name: oneLine(server.fromName), address: server.fromAddress },
      to: message.to,
      // Exactly one recipient, whatever `to` parses as.
      envelope: { from: server.fromAddress, to: [message.to] },
      ...(server.replyTo === null ? {} : { replyTo: server.replyTo }),
      subject: oneLine(message.subject),
      text: message.text,
      html: message.html,
      headers: allowedHeaders(message.headers),
      attachments: [
        {
          filename: 'qualor.png',
          content: logoPng(),
          contentType: 'image/png',
          cid: LOGO_CID,
          contentDisposition: 'inline',
        },
      ],
    });
    return {
      response: clipUtf8(oneLine(String(info.response)), MAX_SMTP_TEXT_BYTES),
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    throw toMailSendError(err);
  } finally {
    transport.close();
  }
}

interface SmtpFailure {
  code?: unknown;
  /** nodemailer keeps a system error's own code here (a TLS verification code, ECONNREFUSED). */
  originalCode?: unknown;
  responseCode?: unknown;
  response?: unknown;
}

/** A certificate that does not verify, or a TLS handshake that fails: retrying does not help. */
const TLS_FAILURE = /CERT|SIGNATURE|^ERR_TLS_|^ERR_SSL_|^EPROTO$/;

/**
 * E1 spec: network errors, timeouts and 4xx replies (421 too) are transient; other 5xx replies,
 * auth failures, a refused or unverifiable TLS connection and bad settings are permanent.
 */
export function toMailSendError(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err;
  const e: SmtpFailure = typeof err === 'object' && err !== null ? (err as SmtpFailure) : {};
  const code = typeof e.code === 'string' ? e.code : '';
  const original = typeof e.originalCode === 'string' ? e.originalCode : '';
  const smtpCode =
    typeof e.responseCode === 'number' && Number.isInteger(e.responseCode) ? e.responseCode : null;
  const reply =
    typeof e.response === 'string' && e.response.trim() !== ''
      ? clipUtf8(oneLine(e.response), MAX_SMTP_TEXT_BYTES)
      : null;
  if (code === 'EAUTH' || code === 'ENOAUTH') {
    // A 4xx reply (454 temporary authentication failure) is worth a retry; 5xx or no code is not.
    return new MailSendError('auth', reply ?? 'The SMTP server refused the user name or password', {
      smtpCode,
      transient: smtpCode !== null && smtpCode >= 400 && smtpCode < 500,
    });
  }
  if (code === 'ETIMEDOUT') {
    return new MailSendError('timeout', 'The SMTP server did not answer in time', {
      transient: true,
    });
  }
  if (code === 'ETLS' || TLS_FAILURE.test(original)) {
    return new MailSendError(
      'connection',
      reply === null
        ? 'The TLS connection to the SMTP server failed: check the host name, the security setting and the server certificate'
        : clipUtf8(`The SMTP server refused STARTTLS: ${reply}`, MAX_SMTP_TEXT_BYTES),
      { smtpCode, transient: false },
    );
  }
  if (code === 'ECONFIG') {
    return new MailSendError('config', 'The SMTP settings cannot be used', { transient: false });
  }
  if (smtpCode !== null && smtpCode >= 400 && smtpCode < 600) {
    return new MailSendError('rejected', reply ?? `The SMTP server answered ${smtpCode}`, {
      smtpCode,
      transient: smtpCode < 500,
    });
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return new MailSendError(
      'rejected',
      'The SMTP server refused the sender, the recipient or the message',
      {
        transient: false,
      },
    );
  }
  return new MailSendError('connection', 'The SMTP server could not be reached', {
    transient: true,
  });
}
