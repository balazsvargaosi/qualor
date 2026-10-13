import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, createUser, type TestContext } from '../../../test/app';
import { testPayload } from '../../../test/license';
import { testSmtp } from '../../../test/mail';
import { instanceSettings, jobs, mailMessages, users } from '../../db/schema';
import { DAY_MS, licenseState } from '../../license/state';
import type { Verification } from '../../license/verify';
import { runUntilIdle } from '../../queue/worker';
import { writeMailSettings } from '../settings';
import {
  checkLicenseAlerts,
  ensureLicenseAlertScheduled,
  LICENSE_ALERT_QUEUE,
  LICENSE_ALERT_STATE_KEY,
  licenseAlertHandlers,
  scheduleLicenseAlertAtBoot,
  type LicenseAlertDeps,
} from './license-alerts';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('licence expiry alerts (E1 spec, Alerts)', () => {
  let t: TestContext;
  let now: Date;
  let verification: Verification | null;
  const edition = { state: () => licenseState(verification, now), now: () => now };
  const deps = (over: Partial<LicenseAlertDeps> = {}): LicenseAlertDeps => ({
    db: t.db,
    edition,
    config: t.config,
    logger: silent,
    ...over,
  });
  /** A valid licence that expires `days` after `now`; returns its `expires`. */
  const expiresIn = (days: number, kid = 'test-a'): string => {
    const expires = new Date(now.getTime() + days * DAY_MS).toISOString();
    verification = { ok: true, kid, license: testPayload({ expires }) };
    return expires;
  };
  const subjects = async () =>
    (
      await t.db
        .select({ subject: mailMessages.subject })
        .from(mailMessages)
        .where(eq(mailMessages.kind, 'license.expiry'))
        .orderBy(mailMessages.id)
    ).map((r) => r.subject);
  const setAlert = (licenseExpiry: boolean) =>
    t.db.transaction((tx) =>
      writeMailSettings(tx, { alerts: { licenseExpiry } }, t.config.secretKey),
    );

  beforeAll(async () => {
    t = await createTestContext({ config: { smtp: testSmtp(2525) } });
    await t.db.update(users).set({ email: 'admin@example.com' }).where(eq(users.id, t.adminId));
    await createUser(t, {
      username: 'licence-ops',
      email: 'ops@example.com',
      isInstanceAdmin: true,
    });
  });
  beforeEach(async () => {
    await t.db.delete(mailMessages);
    await t.db.delete(instanceSettings).where(eq(instanceSettings.key, LICENSE_ALERT_STATE_KEY));
    await setAlert(true);
    now = new Date('2026-10-13T09:00:00Z');
    verification = null;
  });
  afterAll(async () => {
    await t.close();
  });

  it('sends the current bucket once to every administrator with an email', async () => {
    const expires = expiresIn(20);
    expect(await checkLicenseAlerts(deps())).toBe('30d');
    const subject = 'Your Qualor licence expires in 20 days';
    expect(await subjects()).toEqual([subject, subject]);
    expect(await checkLicenseAlerts(deps())).toBeNull();
    expect(await subjects()).toHaveLength(2);
    const [state] = await t.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, LICENSE_ALERT_STATE_KEY));
    expect(state?.value).toEqual({ licenseKey: `test-a:${expires}`, sent: ['30d'] });
  });

  it('sends each later bucket as the days pass, and never a missed one late', async () => {
    expiresIn(5);
    expect(await checkLicenseAlerts(deps())).toBe('7d');
    now = new Date(now.getTime() + 4.5 * DAY_MS);
    expect(await checkLicenseAlerts(deps())).toBe('1d');
    now = new Date(now.getTime() + DAY_MS);
    expect(await checkLicenseAlerts(deps())).toBe('grace');
    now = new Date(now.getTime() + 14 * DAY_MS);
    expect(await checkLicenseAlerts(deps())).toBe('expired');
    const twice = (s: string) => [s, s];
    expect(await subjects()).toEqual([
      ...twice('Your Qualor licence expires in 5 days'),
      ...twice('Your Qualor licence expires in 1 day'),
      ...twice('Your Qualor licence has expired: 14 days of grace left'),
      ...twice('Your Qualor licence has expired'),
    ]);
  });

  it('starts again for a new licence key', async () => {
    expiresIn(20);
    await checkLicenseAlerts(deps());
    expiresIn(25, 'test-b');
    expect(await checkLicenseAlerts(deps())).toBe('30d');
    expect(await subjects()).toHaveLength(4);
  });

  it('sends nothing, and remembers nothing, with the alert off or email not configured', async () => {
    expiresIn(20);
    await setAlert(false);
    expect(await checkLicenseAlerts(deps())).toBeNull();
    await setAlert(true);
    expect(await checkLicenseAlerts(deps({ config: { ...t.config, smtp: null } }))).toBeNull();
    expect(await subjects()).toEqual([]);
    expect(await checkLicenseAlerts(deps())).toBe('30d');
  });

  it('sends nothing without a licence, for an invalid one, or far from expiry', async () => {
    expect(await checkLicenseAlerts(deps())).toBeNull();
    verification = { ok: false, reason: 'bad-signature' };
    expect(await checkLicenseAlerts(deps())).toBeNull();
    expiresIn(90);
    expect(await checkLicenseAlerts(deps())).toBeNull();
    expect(await subjects()).toEqual([]);
  });

  it('records a bucket only once an alert was queued: not while mail is off or no administrator has an address', async () => {
    const stateRow = () =>
      t.db.select().from(instanceSettings).where(eq(instanceSettings.key, LICENSE_ALERT_STATE_KEY));
    expiresIn(20);
    // Email not configured: nothing is queued, nothing recorded.
    expect(await checkLicenseAlerts(deps({ config: { ...t.config, smtp: null } }))).toBeNull();
    expect(await stateRow()).toEqual([]);
    // Configured: the alert is queued and the bucket recorded.
    expect(await checkLicenseAlerts(deps())).toBe('30d');
    expect(await subjects()).toHaveLength(2);
    expect(await stateRow()).toHaveLength(1);
    // No administrator with an address: nothing queued, nothing recorded; an address later sends it.
    await t.db.delete(mailMessages);
    await t.db.delete(instanceSettings).where(eq(instanceSettings.key, LICENSE_ALERT_STATE_KEY));
    const admins = await t.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isInstanceAdmin, true));
    await t.db.update(users).set({ email: null }).where(eq(users.isInstanceAdmin, true));
    try {
      expect(await checkLicenseAlerts(deps())).toBeNull();
      expect(await stateRow()).toEqual([]);
    } finally {
      for (const a of admins) {
        await t.db.update(users).set({ email: a.email }).where(eq(users.id, a.id));
      }
    }
    expect(await checkLicenseAlerts(deps())).toBe('30d');
    expect(await subjects()).toHaveLength(2);
  });

  it('schedules one check two minutes after boot, and the next a day after each run', async () => {
    await t.db.delete(jobs).where(eq(jobs.queue, LICENSE_ALERT_QUEUE));
    const due = async () =>
      (
        await t.db.execute<{ secs: number }>(sql`
          SELECT extract(epoch FROM run_at - now())::int AS secs FROM jobs
           WHERE queue = ${LICENSE_ALERT_QUEUE} AND status = 'queued'`)
      ).rows.map((r) => r.secs);
    await scheduleLicenseAlertAtBoot(t.db);
    await scheduleLicenseAlertAtBoot(t.db); // a second replica booting
    expect(await due()).toHaveLength(1);
    expect((await due())[0]).toBeGreaterThan(100);
    expect(await ensureLicenseAlertScheduled(t.db)).toBe(false);
    await t.db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(eq(jobs.queue, LICENSE_ALERT_QUEUE));
    expiresIn(20);
    await runUntilIdle(t.db, licenseAlertHandlers(deps()), silent);
    expect(await subjects()).toHaveLength(2);
    const next = await due();
    expect(next).toHaveLength(1);
    expect(next[0]).toBeGreaterThan(86_000);
    expect(
      await t.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.queue, LICENSE_ALERT_QUEUE), eq(jobs.status, 'succeeded'))),
    ).toHaveLength(1);
  });
});
