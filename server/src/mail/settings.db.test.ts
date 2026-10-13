import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { SMTP_TEST_PASSWORD, testSmtp } from '../../test/mail';
import { instanceSettings } from '../db/schema';
import {
  DEFAULT_MAIL_SETTINGS,
  effectiveMail,
  MAIL_SETTINGS_KEY,
  mailConfigured,
  readMailSettings,
  storedMailServerSchema,
  writeMailSettings,
  type MailServerInput,
  type MailSettingsPatch,
} from './settings';

const SECRET = 'mail-settings-test-secret-key-0123456789';
const NO_ENV = { smtp: null };
const SERVER: MailServerInput = {
  host: 'SMTP.Example.com',
  port: 587,
  security: 'starttls',
  username: 'qualor',
  password: SMTP_TEST_PASSWORD,
  fromName: 'Qualor',
  fromAddress: 'qualor@example.com',
  replyTo: null,
};

describe('the mail settings row (E1 spec, Settings)', () => {
  let t: TestDatabase;
  const write = (patch: MailSettingsPatch, secret = SECRET) =>
    t.db.transaction((tx) => writeMailSettings(tx, patch, secret));
  const stored = async () =>
    (
      await t.db.select().from(instanceSettings).where(eq(instanceSettings.key, MAIL_SETTINGS_KEY))
    )[0]?.value;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  beforeEach(async () => {
    await t.db.delete(instanceSettings).where(eq(instanceSettings.key, MAIL_SETTINGS_KEY));
  });
  afterAll(async () => {
    await t.close();
  });

  it('reads the defaults without a row, and for a row that does not parse', async () => {
    expect(await readMailSettings(t.db)).toEqual(DEFAULT_MAIL_SETTINGS);
    expect(DEFAULT_MAIL_SETTINGS).toEqual({
      server: null,
      alerts: { licenseExpiry: true, webhookFailures: true },
    });
    await t.db.insert(instanceSettings).values({ key: MAIL_SETTINGS_KEY, value: { server: 'x' } });
    expect(await readMailSettings(t.db)).toEqual(DEFAULT_MAIL_SETTINGS);
    expect(await mailConfigured(t.db, NO_ENV)).toBe(false);
  });

  it('stores the password encrypted, never in clear, and decrypts it for sending', async () => {
    await write({ server: SERVER });
    expect(JSON.stringify(await stored())).not.toContain(SMTP_TEST_PASSWORD);
    expect(await effectiveMail(t.db, NO_ENV, SECRET)).toEqual({
      source: 'settings',
      passwordReadable: true,
      alerts: { licenseExpiry: true, webhookFailures: true },
      server: { ...SERVER, host: 'smtp.example.com', password: SMTP_TEST_PASSWORD },
    });
    expect(await mailConfigured(t.db, NO_ENV)).toBe(true);
  });

  it('keeps the password when absent, removes it with null, and removes the server with null', async () => {
    await write({ server: SERVER });
    const withoutPassword: MailServerInput = { ...SERVER, port: 2525 };
    delete withoutPassword.password;
    await write({ server: withoutPassword });
    expect((await effectiveMail(t.db, NO_ENV, SECRET)).server).toMatchObject({
      port: 2525,
      password: SMTP_TEST_PASSWORD,
    });
    await write({ server: { ...SERVER, password: null } });
    expect((await effectiveMail(t.db, NO_ENV, SECRET)).server?.password).toBeNull();
    const { before, after } = await write({ server: null });
    expect(before.server).not.toBeNull();
    expect(after.server).toBeNull();
    expect(await mailConfigured(t.db, NO_ENV)).toBe(false);
  });

  it('merges alert switches and leaves the server as it is', async () => {
    await write({ server: SERVER });
    await write({ alerts: { webhookFailures: false } });
    const settings = await readMailSettings(t.db);
    expect(settings.alerts).toEqual({ licenseExpiry: true, webhookFailures: false });
    expect(settings.server?.host).toBe('smtp.example.com');
  });

  it('lets QUALOR_SMTP_URL win for the server, with the alerts still from the row', async () => {
    await write({ server: SERVER, alerts: { licenseExpiry: false } });
    const env = testSmtp(2525, { host: 'relay.env.example' });
    expect(await effectiveMail(t.db, { smtp: env }, SECRET)).toEqual({
      source: 'environment',
      server: env,
      passwordReadable: true,
      alerts: { licenseExpiry: false, webhookFailures: true },
    });
    await write({ server: null });
    expect(await mailConfigured(t.db, { smtp: env })).toBe(true);
  });

  it('counts a password that no longer decrypts (QUALOR_SECRET_KEY changed) as configured but unreadable', async () => {
    await write({ server: SERVER }, 'an-earlier-secret-key-of-at-least-32-chars');
    const mail = await effectiveMail(t.db, NO_ENV, SECRET);
    expect(mail.server).toMatchObject({ host: 'smtp.example.com', password: null });
    expect(mail.passwordReadable).toBe(false);
    expect(await mailConfigured(t.db, NO_ENV)).toBe(true);
  });

  it('rejects a line break in the name, user name or addresses (no header injection)', async () => {
    const stored = { ...SERVER, passwordEnc: null } as Record<string, unknown>;
    delete stored.password;
    expect(storedMailServerSchema.safeParse(stored).success).toBe(true);
    for (const bad of [
      { fromName: 'Qualor\r\nBcc: x@example.com' },
      { username: 'qualor\nx' },
      { fromAddress: 'a@example.com\r\nBcc: x@example.com' },
      { replyTo: 'a@example.com\nBcc: x@example.com' },
    ]) {
      expect(storedMailServerSchema.safeParse({ ...stored, ...bad }).success).toBe(false);
    }
  });
});
