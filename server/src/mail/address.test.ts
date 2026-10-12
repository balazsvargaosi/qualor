import { describe, expect, it } from 'vitest';
import { isEmailAddress, isHostName, isOneLine, parseMailbox } from './address';

describe('mail address helpers (E1 spec)', () => {
  it.each([
    'smtp.example.com',
    'relay',
    'a-b.c-d.example',
    '127.0.0.1',
    'fd00::5',
    'SMTP.Example.COM',
  ])('takes the host %s', (host) => expect(isHostName(host)).toBe(true));

  it.each([
    '',
    'bad_host',
    'host!',
    '-lead.example',
    'trail-.example',
    'a..b',
    'a'.repeat(64) + '.com',
    'x'.repeat(254),
  ])('refuses the host %j', (host) => expect(isHostName(host)).toBe(false));

  it('reads Name <address>, a quoted name, and a bare address with the default name', () => {
    expect(parseMailbox('Qualor <qualor@example.com>')).toEqual({
      name: 'Qualor',
      address: 'qualor@example.com',
    });
    expect(parseMailbox('"Acme, Inc." <ops@acme.example>')).toEqual({
      name: 'Acme, Inc.',
      address: 'ops@acme.example',
    });
    expect(parseMailbox('  qualor@example.com ')).toEqual({
      name: 'Qualor',
      address: 'qualor@example.com',
    });
  });

  it.each([
    'Bad\r\nBcc: x@example.com <a@example.com>',
    'not an address',
    'Name <not an address>',
    `${'n'.repeat(101)} <a@example.com>`,
  ])('refuses the mailbox %j', (value) => expect(parseMailbox(value)).toBeNull());

  it('tells one-line text and addresses', () => {
    expect(isOneLine('Qualor alerts')).toBe(true);
    expect(isOneLine('a\rb')).toBe(false);
    expect(isOneLine('a\nb')).toBe(false);
    expect(isOneLine('a\u0000b')).toBe(false);
    expect(isEmailAddress('ops@example.com')).toBe(true);
    expect(isEmailAddress('ops@example.com\r\n')).toBe(false);
  });
});
