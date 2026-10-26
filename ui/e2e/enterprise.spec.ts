import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { expect, expectAccessible, test } from './fixtures';
import { OLGA, PAYMENTS, SIEM_URL } from './seed-data';

/**
 * Plan 4C (rbac-audit.md §17): the audit screens on the licensed e2e server
 * (`server/scripts/e2e/serve.ts`, the Enterprise plan's features). Since 5B the Members
 * screen and the Access tab are tested on the community server (`roles.spec.ts`); here the seed's
 * last grant, olga's Viewer grant to victor on Payments API (`seedEnterprise`), is what the audit
 * log shows.
 */

async function signIn(page: Page, user: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** Today in UTC as the date inputs take it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test.describe('on a tablet', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  // The enterprise settings pages fit a tablet too (Task 2 of step 11: 390 and 768px).
  for (const path of [
    '/settings/license',
    '/settings/ee/audit-log',
    '/settings/ee/audit-settings',
    '/settings/ee/sso',
    '/settings/ee/sign-in',
    '/settings/ee/scim',
    '/settings/ee/linked-accounts',
    '/settings/ee/compliance',
    '/settings/ee/support',
  ]) {
    test(`${path} never scrolls sideways at 768px`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('.settings-head h2')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        768,
      );
    });
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // Each enterprise settings page fits the screen once its data is in (redesign step 9 review):
  // a wide table scrolls in its panel, never the page.
  for (const path of [
    '/settings/license',
    '/settings/ee/audit-log',
    '/settings/ee/audit-settings',
    '/settings/ee/sso',
    '/settings/ee/sign-in',
    '/settings/ee/scim',
    '/settings/ee/linked-accounts',
    '/settings/ee/compliance',
    '/settings/ee/support',
  ]) {
    test(`${path} never scrolls sideways`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('.settings-head h2')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    });
  }

  test('audit targets keep their words; the events table scrolls instead', async ({ page }) => {
    await page.goto('/settings/ee/audit-log');
    const target = page.locator('td', { hasText: /^user: admin$/ }).first();
    await expect(target).toBeAttached();
    const { width, need } = await target.evaluate((el) => {
      const style = getComputedStyle(el);
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const words = (el.textContent ?? '').trim().split(/\s+/);
      return {
        width: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        need: Math.max(...words.map((word) => context.measureText(word).width)),
      };
    });
    expect(width).toBeGreaterThanOrEqual(need - 1);
  });

  test('dates in the SCIM and linked-account tables keep to one line; the table scrolls', async ({
    page,
  }) => {
    const lines = (cell: Locator) =>
      cell.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      });
    await page.goto('/settings/ee/scim');
    const token = page.locator('tr', { hasText: 'Entra ID provisioning' });
    expect(await lines(token.locator('td').nth(1))).toBe(1);
    expect(await lines(token.locator('td').nth(3))).toBe(1);
    await page.goto('/settings/ee/linked-accounts');
    const account = page.locator('tr', { hasText: 'Acme SSO' });
    expect(await lines(account.locator('td').nth(0))).toBe(1);
    expect(await lines(account.locator('td').nth(1))).toBe(1);
  });

  test("each licence fact's value has the width under its label", async ({ page }) => {
    await page.goto('/settings/license');
    const facts = page.locator('dl.facts');
    await expect(facts.locator('dt').first()).toBeVisible();
    const pairs = await facts.evaluate((dl) =>
      [...dl.querySelectorAll('dt')].map((dt) => {
        const dd = dt.nextElementSibling!;
        const label = dt.getBoundingClientRect();
        const value = dd.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(dd);
        // A new line starts below the last one's bottom (a code's box sits a pixel off its words).
        let lines = 0;
        let bottom = -Infinity;
        for (const box of [...range.getClientRects()].sort((a, b) => a.top - b.top)) {
          if (box.top >= bottom - 2) lines += 1;
          bottom = Math.max(bottom, box.bottom);
        }
        return {
          label: dt.textContent?.trim(),
          left: value.left - label.left,
          below: value.top >= label.bottom,
          lines,
        };
      }),
    );
    for (const pair of pairs) {
      expect(pair.left, pair.label).toBeLessThanOrEqual(1);
      expect(pair.below, pair.label).toBe(true);
    }
    // A sentence stays one: "The QUALOR_LICENSE variable" on one line, its code among its words.
    expect(pairs.find((p) => p.label === 'Where the key comes from')?.lines).toBe(1);
  });
});

test('the audit Organization select shows its words at every width beside a phone', async ({
  page,
}) => {
  await page.goto('/settings/ee/audit-log');
  const select = page.locator('#audit-organization');
  await expect(select).toBeVisible();
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const { box, need } = await select.evaluate((el: HTMLSelectElement) => {
      const style = getComputedStyle(el);
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        box: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        need: context.measureText(el.options[el.selectedIndex]!.text.trim()).width,
      };
    });
    expect(box, `${width}px`).toBeGreaterThanOrEqual(need);
  }
});

test.describe('as people other than the instance admin', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an organization admin reads the audit log of its own organization', async ({ page }) => {
    await signIn(page, OLGA);
    await page.goto('/settings/members');
    // An org admin reads the audit log of its own organization, not the audit settings.
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Audit settings' })).toHaveCount(0);
    const events = page.waitForRequest((r) =>
      new URL(r.url()).pathname.endsWith('/api/v0/ee/audit/events'),
    );
    await page.getByRole('link', { name: 'Audit log' }).click();
    expect(new URL((await events).url()).searchParams.get('organizationId')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await expect(page.getByRole('row', { name: /project_member\.added/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify chain' })).toHaveCount(0);
    // The organisation filter (instance admins only); the settings navigation has an Organization group.
    await expect(page.getByRole('combobox', { name: 'Organization' })).toHaveCount(0);
    // The user filter suggests people to an organization admin too, from two characters.
    await page.getByRole('combobox', { name: 'User name' }).fill('vi');
    await expect(page.getByRole('option', { name: 'victor — Victor Hale' })).toBeVisible();
    await expectAccessible(page);
  });
});

test('the instance admin filters the audit log by a user picked from the suggestions', async ({
  page,
}) => {
  await page.goto('/settings/ee/audit-log');
  await expect(page.locator('tbody tr[data-key]').first()).toBeVisible();
  const user = page.getByRole('combobox', { name: 'User name' });
  // A word of the display name finds the person too: "Berg" is Olga Berg.
  await user.fill('Berg');
  const olga = page.getByRole('option', { name: 'olga — Olga Berg' });
  await expect(olga).toBeVisible();
  await olga.click();
  await expect(user).toHaveValue(OLGA.username);
  const filtered = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith('/api/v0/ee/audit/events') &&
      new URL(r.url()).searchParams.has('actorUserId'),
  );
  await page.getByRole('button', { name: 'Show events' }).click();
  await filtered;
  // olga's sign-ins and her grant to victor, and no one else's events.
  const actors = page.locator('tbody tr[data-key] td:nth-of-type(2)');
  await expect(actors.first()).toBeVisible();
  await expect
    .poll(async () => (await actors.allTextContents()).every((a) => a.includes(OLGA.username)))
    .toBe(true);
});

test('the instance admin filters the audit log, exports a day and verifies the chain', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page).toHaveURL(/\/settings\/ee\/audit-log$/);
  await expect(page).toHaveTitle('Audit log · Qualor');

  await page.getByLabel('From (UTC)').fill(today());
  await page.getByLabel('To (UTC, included)').fill(today());
  await page.getByLabel('Actions').fill('project_member.*');
  await page.getByRole('button', { name: 'Show events' }).click();
  const rows = page.locator('tbody tr[data-key]');
  await expect(rows.first()).toBeVisible();
  for (const text of await rows.locator('th code').allTextContents()) {
    expect(text).toMatch(/^project_member\./);
  }
  // Olga's grant to victor on Payments API (the seed's last grant) is the newest.
  const newest = rows.first();
  await expect(newest).toContainText('project_member.added');
  await expect(newest).toContainText('olga');
  await newest.getByRole('button', { name: /Details/ }).click();
  await expect(page.locator('.details-row')).toContainText(PAYMENTS.key);
  await expectAccessible(page);

  // The export is a download the browser writes: JSON Lines with the filters and the day.
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export JSON Lines' }).click();
  const file = await (await download).path();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  expect(lines.length).toBeGreaterThanOrEqual(3);
  for (const line of lines) {
    const record = JSON.parse(line) as { action: string; hash: string; prevHash: string };
    expect(record.action).toMatch(/^project_member\./);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
  }

  await expect(page.locator('#audit-head')).toContainText('Newest event:');
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.locator('#audit-verify-result')).toHaveText(
    /^The chain is intact \(\d+ events\)\.$/,
  );
});

test('the instance admin streams the audit log and sees the secret once', async ({ page }) => {
  await page.goto('/settings/ee/audit-settings');
  await expect(page).toHaveTitle('Audit settings · Qualor');
  await expect(page.getByLabel('Keep events for (days)')).toHaveValue('365');

  // Enterprise has audit-log.stream: the stream card is not limited.
  await expect(page.locator('#audit-stream-not-licensed')).toHaveCount(0);
  await page.getByLabel('Stream URL').fill(SIEM_URL);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').first()).toHaveText('Audit settings saved.');
  const secret = page.getByLabel('Stream secret');
  await expect(secret).toHaveValue(/^whsec_[0-9A-Za-z]{32}$/);
  const value = await secret.inputValue();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByLabel('Stream secret')).toHaveCount(0);

  // Never again: not after a reload, and not in the page's text.
  await page.reload();
  await expect(page.getByLabel('Stream URL')).toHaveValue(SIEM_URL);
  await expect(page.getByText('A signing secret is set; it is never shown again.')).toBeVisible();
  await expect(page.getByLabel('Stream secret')).toHaveCount(0);
  expect(await page.content()).not.toContain(value);

  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.locator('#audit-stream-test')).toContainText(
    'The receiver answered HTTP 204: the test passed.',
  );
});

test.describe('automatic fix suggestions (4E-3a §4)', () => {
  /** Payments API → Settings, through the project's own tabs. */
  async function openProjectSettings(page: Page): Promise<void> {
    await page.goto('/projects');
    await page.getByRole('link', { name: PAYMENTS.name }).click();
    await page
      .getByRole('navigation', { name: 'Project' })
      .getByRole('link', { name: 'Settings' })
      .click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/settings$/);
  }

  test('an organisation admin switches automatic fix suggestions on in Settings → AI, and a project opts out', async ({
    page,
  }) => {
    // The instance admin points the assistant at a host under .invalid (RFC 6761): saving contacts
    // nothing, and no test asks the model. The organisation's block is left as it was, so the save
    // sends none (it would undo what an organisation admin changes meanwhile).
    await page.goto('/settings/ai');
    await expect(page.getByRole('heading', { name: 'AI assistant', level: 2 })).toBeVisible();
    await page.getByLabel('Kind', { exact: true }).selectOption('openai');
    await page.getByLabel('Base URL').fill('https://llm.example.invalid/v1');
    await page.getByLabel('Model', { exact: true }).fill('fake-model');
    await page.locator('#ai-key').fill(['e2e', 'llm', 'key', 'never', 'sent'].join('-'));
    const row = page.locator('.setting-row[data-key]').filter({ hasText: 'Default' });
    await row.getByLabel('Enabled', { exact: true }).check();
    await row.getByLabel('Suggest a fix').check();
    const block = row.getByRole('group', { name: 'Automatic fix suggestions' });
    await expect(block.getByLabel('On', { exact: true })).not.toBeChecked();
    await expect(block.getByLabel('Minimum severity')).toHaveValue('high');
    await expect(block.getByLabel('At most per analysis')).toHaveValue('10');
    const put = page.waitForRequest(
      (r) => r.method() === 'PUT' && new URL(r.url()).pathname === '/api/v0/system/llm',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    const sent = (await put).postDataJSON() as { organizations: Record<string, object> };
    for (const organization of Object.values(sent.organizations)) {
      expect(organization).not.toHaveProperty('autoFix');
      expect(organization).not.toHaveProperty('autoFixDisabledProjectIds');
    }
    await expect(page.getByRole('status')).toHaveText('The AI assistant settings were saved.');
    await expectAccessible(page);

    // Settings → AI, the organisation's page: its section, where the old address leads.
    await page.goto('/settings');
    await expect(page.getByRole('link', { name: 'Automatic fixes' })).toHaveCount(0);
    await page.goto('/settings/auto-fix');
    await expect(page).toHaveURL(/\/settings\/ai-review#fix-suggestions$/);
    await expect(page).toHaveTitle('AI · Qualor');
    const section = page.locator('#fix-suggestions');
    await expect(
      section.getByRole('heading', { name: 'Automatic fix suggestions', level: 3 }),
    ).toBeFocused();
    await expect(
      page
        .getByRole('navigation', { name: 'On this page' })
        .getByRole('link', { name: 'Automatic fix suggestions' }),
    ).toHaveAttribute('href', '/settings/ai-review#fix-suggestions');
    const fixSwitch = section.getByRole('switch', { name: 'Post fix suggestions automatically' });
    await expect(fixSwitch).not.toBeChecked();
    await expect(fixSwitch).toBeEnabled();
    await expect(section.getByLabel('Minimum severity')).toHaveCount(0);
    await expect(page.locator('li[data-key="fix"]')).toContainText('Off');
    await expectAccessible(page);

    // On, the severity and the maximum hang from the switch.
    await fixSwitch.check();
    await section.getByLabel('Minimum severity').selectOption('medium');
    await section.getByLabel('At most per analysis').fill('5');
    const foot = section.locator('.foot-status');
    await expect(foot).toHaveText('3 unsaved changes');
    // Save turns primary; its colours fade in (0.15s), which axe must not measure halfway.
    const save = section.getByRole('button', { name: 'Save fix suggestions' });
    await expect(save).toHaveCSS('background-color', 'rgb(31, 95, 191)');
    await expectAccessible(page);
    await save.click();
    await expect(foot).toHaveText(/^Saved at \d{1,2}:\d{2} [AP]M UTC\.$/);
    await expect(page.locator('li[data-key="fix"]')).toContainText(
      'For new findings of Medium and above.',
    );
    await page.reload();
    await expect(fixSwitch).toBeChecked();
    await expect(section.getByLabel('Minimum severity')).toHaveValue('medium');
    await expect(section.getByLabel('At most per analysis')).toHaveValue('5');
    await expect(section.locator('#auto-fix-opted-out')).toHaveText('No project opted out.');

    // The project opts out with its AI panel's switch, which saves at once, and stays out after a
    // reload.
    await openProjectSettings(page);
    const toggle = page.locator('section#ai').getByRole('switch', {
      name: "Post fix suggestions to this project's merge requests automatically",
    });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.locator('section#ai [data-line="fixes"]').getByRole('status')).toHaveText(
      'Saved.',
    );
    await expectAccessible(page);
    await page.reload();
    await expect(toggle).not.toBeChecked();

    // The organisation's section names it.
    await page.goto('/settings/ai-review#fix-suggestions');
    await expect(page.locator('#auto-fix-opted-out')).toHaveText(
      `Opted out by their project admins: ${PAYMENTS.name}.`,
    );

    // The instance admin's screen shows what the organisation admin chose.
    await page.goto('/settings/ai');
    const saved = page
      .locator('.setting-row[data-key]')
      .filter({ hasText: 'Default' })
      .getByRole('group', { name: 'Automatic fix suggestions' });
    await expect(saved.getByLabel('On', { exact: true })).toBeChecked();
    await expect(saved.getByLabel('Minimum severity')).toHaveValue('medium');
    await expect(saved.getByLabel('At most per analysis')).toHaveValue('5');
  });
});

// 4E-3b §5: the support bundle (feature `support-bundle`) for the instance admin. The download is
// a plain link; the archive is a zip whose manifest names the UI as its source.
test('an instance admin downloads the support bundle from Settings → Support', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Support' }).click();
  await expect(page).toHaveURL(/\/settings\/ee\/support$/);
  await expect(page).toHaveTitle('Support · Qualor');
  await expect(page.getByText('It never contains secrets')).toBeVisible();
  await expect(page.locator('#support-command-running')).toHaveValue(
    'docker compose exec -T server /usr/local/bin/node dist/main.js support-bundle > qualor-support.zip',
  );
  await expect(page.locator('#support-command-stopped')).toHaveValue(
    'docker compose run --rm -T server support-bundle > qualor-support.zip',
  );
  await expect(page.getByRole('link', { name: 'support@qualor.dev' })).toBeVisible();
  await expectAccessible(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download support bundle' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^qualor-support-\d{8}-\d{6}\.zip$/);
  const archive = readFileSync((await download.path())!);
  expect(archive.subarray(0, 2).toString()).toBe('PK');
  const text = archive.toString('latin1');
  for (const name of ['manifest.json', 'license.json', 'logs.jsonl']) expect(text).toContain(name);
});
