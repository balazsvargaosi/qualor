import { describe, expect, it } from 'vitest';
import { cleanErrorText, cleanLogLine, createRedactor, redactSecrets, redactTree } from './secrets';

describe('redactSecrets (4E-3b §2)', () => {
  const secret = 'Sup3r/Secret+Value=';

  it('replaces every spelling of a configured value: raw, JSON, URL-encoded and base64', () => {
    const b64 = Buffer.from(secret).toString('base64');
    const text = [
      secret,
      JSON.stringify({ v: 'Sup3r/Secret+Value=' }),
      encodeURIComponent(secret),
      b64,
      b64.replace(/=+$/, ''),
      Buffer.from(secret).toString('base64url'),
    ].join(' | ');
    const out = redactSecrets(text, [secret]);
    expect(out).not.toContain('Secret');
    expect(out).not.toContain(b64.replace(/=+$/, ''));
    expect(out).not.toContain(encodeURIComponent(secret));
    expect(out.match(/\[redacted\]/g)).toHaveLength(6);
  });

  it('replaces the longest value first, and leaves short values alone', () => {
    const redact = createRedactor(['abcd', 'abcdefgh', 'xyz']);
    expect(redact('abcdefgh abcd xyz')).toBe('[redacted] [redacted] xyz');
  });

  it('escapes JSON in a log line, so a value with a quote or newline is still found', () => {
    const pem = '-----BEGIN KEY-----\nAAAA"BBBB\n-----END KEY-----';
    const line = JSON.stringify({ msg: 'oops', key: pem });
    expect(cleanLogLine(line, createRedactor([pem]))).toBe(
      JSON.stringify({ msg: 'oops', key: '[redacted]' }),
    );
  });

  it('cleans a JSON log line inside its strings and keys only, so it stays valid JSON', () => {
    const redact = createRedactor(['2026']);
    const line = JSON.stringify({
      level: 30,
      time: 1760020260000,
      msg: 'pin 2026 used',
      '2026': 1,
    });
    const out = cleanLogLine(line, redact);
    expect(JSON.parse(out)).toEqual({
      level: 30,
      time: 1760020260000,
      msg: 'pin [redacted] used',
      '[redacted]': 1,
    });
    expect(cleanLogLine('2026', redact)).toBe('[redacted]');
    expect(cleanLogLine('not json 2026 {', redact)).toBe('not json [redacted] {');
  });
});

describe('redactTree', () => {
  it('redacts strings and keys, never numbers or literals', () => {
    const redact = createRedactor(['2026']);
    expect(
      redactTree(
        { bytes: 120260000, list: ['x2026', true, null], nested: { '2026x': 2026 } },
        redact,
      ),
    ).toEqual({
      bytes: 120260000,
      list: ['x[redacted]', true, null],
      nested: { '[redacted]x': 2026 },
    });
  });
});

describe('cleanErrorText', () => {
  const redact = createRedactor(['tok-1234567890']);

  it('redacts, drops URL and HTTP credentials and control characters, then cuts to 500', () => {
    expect(
      cleanErrorText(
        'failed with tok-1234567890 at https://bot:pw@gitlab.example/x\u0007 (Bearer abcdefghijklmnopqrstuv)',
        redact,
      ),
    ).toBe('failed with [redacted] at https://[redacted]@gitlab.example/x (Bearer [redacted])');
    expect(
      cleanErrorText(
        'GitHub said 401 to Authorization: token ghp_abcdefghijklmnopqrstuvwxyz',
        redact,
      ),
    ).toBe('GitHub said 401 to Authorization: token [redacted]');
    expect(cleanErrorText('token expired yesterday', redact)).toBe('token expired yesterday');
    expect(cleanErrorText('basic authentication failed', redact)).toBe(
      'basic authentication failed',
    );
    const long = cleanErrorText(`${'é'.repeat(600)}tok-1234567890`, redact);
    expect([...long]).toHaveLength(500);
    expect(long).not.toContain('tok-');
  });
});
