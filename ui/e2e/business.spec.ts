import { expect, expectAccessible, test } from './fixtures';
import { PAYMENTS, SIEM_URL } from './seed-data';

/**
 * Plan 5D (rbac-audit.md §14.4, §17; sso-scim.md §4.4, §18): the enterprise server's database
 * served under a Business key (`sso`, `audit-log`, `llm.fix-quota`; `server/scripts/e2e/serve.ts`),
 * after the enterprise tests. The stream enterprise.spec.ts configured is kept and paused: its
 * fields and buttons are disabled with the reason, Save sends retention alone, and Remove under
 * Stream status deletes it (the guide's steps, docs/guide/roles-and-audit.md).
 */

test('a Business admin sees the kept stream paused and saves retention without it', async ({
  page,
}) => {
  const info = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v0/system/info');
  await page.goto('/settings/ee/audit-settings');
  await expect(page).toHaveTitle('Audit settings · Qualor');
  const features = ((await (await info).json()) as { features: string[] }).features;
  expect([...features].sort()).toEqual(['audit-log', 'llm.fix-quota', 'sso']);

  await expect(page.locator('#audit-stream-not-licensed')).toHaveText(
    'Streaming the audit log to a SIEM needs the Enterprise plan.',
  );
  await expect(page.getByLabel('Stream URL')).toHaveValue(SIEM_URL);
  await expect(page.getByLabel('Stream URL')).toBeDisabled();
  await expect(page.locator('#audit-stream-active')).toBeDisabled();
  await expect(page.locator('#audit-stream-paused')).toContainText(
    'The stream is paused: streaming the audit log to a SIEM needs the Enterprise plan.',
  );
  await expect(page.getByRole('button', { name: 'Send test' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Regenerate the secret' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
  await expectAccessible(page);

  const put = page.waitForRequest(
    (r) => r.method() === 'PUT' && new URL(r.url()).pathname === '/api/v0/ee/audit/settings',
  );
  await page.getByLabel('Keep events for (days)').fill('400');
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await put).postDataJSON()).toEqual({ retentionDays: 400 });
  await expect(page.getByRole('status').first()).toHaveText('Audit settings saved.');
  // The stream is still kept.
  await expect(page.locator('#audit-stream-status')).toBeVisible();
});

test('a Business admin removes the kept stream under Stream status', async ({ page }) => {
  await page.goto('/settings/ee/audit-settings');
  await expect(page.locator('#audit-stream-status')).toBeVisible();
  // The page's own dialog asks (a browser confirm() would fail the guard of fixtures.ts).
  await page.getByRole('button', { name: 'Remove' }).click();
  const ask = page.getByRole('dialog', { name: 'Remove the SIEM stream' });
  await expect(ask).toContainText(
    'Remove the SIEM stream? Events are no longer sent; they stay in the audit log.',
  );
  await ask.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#audit-stream-status')).toHaveCount(0);
  await expect(page.getByLabel('Stream URL')).toHaveValue('');
  await page.reload();
  await expect(page.locator('#audit-stream-status')).toHaveCount(0);
});

test('the Single sign-on screen says the Business plan signs in through one connection', async ({
  page,
}) => {
  await page.goto('/settings/ee/sso');
  await expect(page).toHaveTitle('Single sign-on · Qualor');
  await expect(page.locator('#sso-multi-not-licensed')).toHaveText(
    'Your plan signs people in through one single sign-on connection at a time. Connecting several identity providers needs the Enterprise plan.',
  );
  await expect(page.locator('#sso-count')).toHaveCount(0);
  await expectAccessible(page);
});

// 4E-1 §4: compliance reports are Enterprise only (`compliance-export`), so the reports the
// enterprise tests made stay in the database but out of sight.
test('the Business plan shows no compliance reports', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('link', { name: PAYMENTS.name }).click();
  const tabs = page.getByRole('navigation', { name: 'Project' });
  await expect(tabs.getByRole('link', { name: 'Overview' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Compliance' })).toHaveCount(0);

  await page.goto('/settings/ee/compliance');
  await expect(page).toHaveTitle('Compliance reports · Qualor');
  await expect(page.locator('.settings-head')).toContainText(
    'Compliance reports need an enterprise licence with the compliance-export feature.',
  );
  await expect(page.getByRole('link', { name: 'Compliance reports' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create report' })).toHaveCount(0);
  await expectAccessible(page);
});

// 4E-2 §4: the portfolio is Enterprise only (`portfolio`): no main-menu entry, and its address
// says so without asking the enterprise API anything.
test('the Business plan has no portfolio', async ({ page }) => {
  const portfolioCalls: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/v0/ee/portfolio')) portfolioCalls.push(path);
  });
  const info = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v0/system/info');
  await page.goto('/projects');
  const body = (await (await info).json()) as {
    features: string[];
    extensions: { id: string; point: string }[];
  };
  expect(body.features).not.toContain('portfolio');
  expect(body.extensions.filter((e) => e.point === 'main.nav')).toEqual([]);
  // The plugin's entries come with the system info, as does the version under the user menu:
  // once that is there, the main menu is complete.
  await expect(page.locator('.menu-version')).toBeAttached();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Quality gates' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Portfolio' })).toHaveCount(0);

  await page.goto('/portfolio');
  await expect(page).toHaveTitle('Portfolio · Qualor');
  await expect(page.locator('.page-body')).toHaveText(
    'Portfolio reports need an enterprise licence with the portfolio feature.',
  );
  await expect(page.getByRole('button', { name: 'All organisations' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'CSV' })).toHaveCount(0);
  await expectAccessible(page);
  expect(portfolioCalls).toEqual([]);
});

// 4E-3a §2, §4: automatic fix suggestions are Enterprise only (`llm.auto-fix`). The organisation's
// switch-on and the project's opt-out that enterprise.spec.ts saved are kept but not offered: each
// screen shows the Enterprise note in place of its controls.
test('the Business plan shows the Enterprise note for automatic fix suggestions', async ({
  page,
}) => {
  await page.goto('/settings/auto-fix');
  await expect(page).toHaveTitle('Automatic fix suggestions · Qualor');
  await expect(page.locator('#auto-fix-not-licensed')).toHaveText(
    'Automatic fix suggestions need the Enterprise plan.',
  );
  await expect(page.getByLabel('Post fix suggestions automatically')).toHaveCount(0);
  await expectAccessible(page);

  await page.goto('/settings/ai');
  const block = page
    .locator('.setting-row[data-key]')
    .filter({ hasText: 'Default' })
    .getByRole('group', { name: 'Automatic fix suggestions' });
  await expect(block).toContainText('Automatic fix suggestions need the Enterprise plan.');
  await expect(block.getByRole('checkbox')).toHaveCount(0);

  await page.goto('/projects');
  await page.getByRole('link', { name: PAYMENTS.name }).click();
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Settings' })
    .click();
  const panel = page.locator('#auto-fix');
  await expect(panel).toContainText('Automatic fix suggestions need the Enterprise plan.');
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
});
