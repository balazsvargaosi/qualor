import { expect, expectAccessible, test } from './fixtures';
import { MAIL_URL, STORAGE_STATE } from './seed-data';

/**
 * Only this spec uses `rita`. Her account and her queued messages stay in the database for the
 * rest of the run, which is fine: `pnpm ui:e2e` and `pnpm ui:screenshots` each start their own
 * server on a fresh database (`reuseExistingServer: false`), so the screenshots never show her.
 */
const RITA = {
  username: 'rita',
  email: 'rita@example.test',
  initial: 'rita initial passphrase',
  chosen: 'rita chosen passphrase',
};
/** E1's seedMail: Settings → Email sends through 127.0.0.1:9, where nothing listens. */
const SEEDED_SMTP = { host: '127.0.0.1', port: 9 };

test.describe('a forgotten password (mail E2)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('is reset through the emailed link, which works once, then the new password signs in', async ({
    page,
    playwright,
    baseURL,
    guard,
  }) => {
    const admin = await playwright.request.newContext({ baseURL, storageState: STORAGE_STATE });
    const me = (await (await admin.get('/api/v0/auth/me')).json()) as { csrfToken: string };
    const headers = { 'x-qualor-csrf': me.csrfToken };
    // E1's seed points the server's SMTP at a closed port: every message stays pending (retried a
    // minute later), so the reader can still decrypt its body. Nothing to change or put back.
    const mailSettings = (await (await admin.get('/api/v0/system/mail')).json()) as {
      server: { host: string; port: number } | null;
    };
    expect(mailSettings.server).toMatchObject(SEEDED_SMTP);
    try {
      expect(
        (
          await admin.post('/api/v0/users', {
            headers,
            data: { username: RITA.username, password: RITA.initial, email: RITA.email },
          })
        ).status(),
      ).toBe(201);

      await page.goto('/login');
      await page.getByRole('link', { name: 'Forgot password?' }).click();
      await expect(page).toHaveURL(/\/forgot-password$/);
      await expectAccessible(page);
      await page.getByLabel('Username or email').fill(RITA.username);
      await page.getByRole('button', { name: 'Send the link' }).click();
      await expect(page.getByRole('status')).toContainText('If an account matches');

      const reader = `${MAIL_URL}/latest?to=${encodeURIComponent(RITA.email)}&kind=account.password-reset`;
      await expect.poll(async () => (await admin.get(reader)).status()).toBe(200);
      const mail = (await (await admin.get(reader)).json()) as { subject: string; html: string };
      expect(mail.subject).toBe('Reset your Qualor password');
      const link = /https?:\/\/[^"]+\/reset-password#token=[0-9A-Za-z]{43}/.exec(mail.html)?.[0];
      expect(link).toBeTruthy();

      await page.goto(link!);
      // The token left the address bar and the page's own location, and the form still works.
      await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/reset-password$/);
      expect(page.url()).not.toContain('#token');
      expect(await page.evaluate(() => window.location.hash)).toBe('');
      await expectAccessible(page);
      await page.getByLabel('New password', { exact: true }).fill(RITA.chosen);
      await page.getByLabel('Repeat the new password').fill(RITA.chosen);
      await page.getByRole('button', { name: 'Set the new password' }).click();
      await expect(page).toHaveURL(/\/login\?reset=done&username=rita$/);
      await expect(page.getByRole('status')).toContainText('Your password is changed.');
      await expect(page.getByLabel('Username')).toHaveValue(RITA.username);
      await page.getByLabel('Password', { exact: true }).fill(RITA.chosen);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/projects$/);

      // The same link again: used up.
      guard.allowFailedLoad('/api/v0/auth/password-reset/complete', 400);
      await page.goto(link!);
      await page.getByLabel('New password', { exact: true }).fill('yet another passphrase');
      await page.getByLabel('Repeat the new password').fill('yet another passphrase');
      await page.getByRole('button', { name: 'Set the new password' }).click();
      await expect(page.getByRole('alert')).toContainText(
        'This link has expired or was already used.',
      );
    } finally {
      await admin.dispose();
    }
  });
});
