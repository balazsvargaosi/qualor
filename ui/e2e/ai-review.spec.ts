import type { Page } from '@playwright/test';
import { setTierModels } from './ai-provider';
import { expect, expectAccessible, test } from './fixtures';
import { OLGA, PAYMENTS, SHOP, STORAGE_STATE, VERA } from './seed-data';

/**
 * AI review (6I-2 Task 9) on the community e2e server: Settings → AI review for an organisation
 * admin, with the data-sharing dialog, and the read-only panel in a project's settings. The seed
 * (`seedAi`) points the instance's provider at the fake LLM on loopback and enables the default
 * organisation, so review can be switched on; nothing here reaches a real model. The tests sign in
 * as people other than the instance admin, who is an organisation admin of everything anyway.
 */

async function signIn(page: Page, user: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** Payments API's or Web Shop's settings, through the project's own tabs. */
async function openProjectSettings(page: Page, name: string): Promise<void> {
  await page.goto('/projects');
  await page.getByRole('link', { name }).click();
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/settings$/);
  await expect(page.getByRole('heading', { name: 'New code', level: 2 })).toBeVisible();
}

test.describe('as people other than the instance admin', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an organisation admin switches AI review on with the dialog and finds it saved after a reload', async ({
    page,
  }) => {
    const puts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/ai/review')) {
        puts.push(request.postData() ?? '');
      }
    });
    await signIn(page, OLGA);

    await test.step('the entry is in the Organization group of Settings', async () => {
      await page.goto('/settings');
      const nav = page.getByRole('navigation', { name: 'Settings' });
      await nav
        .getByRole('group', { name: 'Organization' })
        .getByRole('link', { name: 'AI review' })
        .click();
      await expect(page).toHaveURL(/\/settings\/ai-review$/);
      await expect(page).toHaveTitle('AI review · Qualor');
      await expect(page.getByRole('heading', { name: 'AI review', level: 2 })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'AI review' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      // The seed's provider: the fake LLM on loopback.
      await expect(page.locator('#ai-review-provider')).toHaveText(
        /^\s*Model fake-model at 127\.0\.0\.1:\d+\s*$/,
      );
      await expect(page.locator('#ai-review-unavailable')).toHaveCount(0);
      await expect(
        page.getByRole('checkbox', { name: 'Review merge requests with AI' }),
      ).not.toBeChecked();
      await expectAccessible(page);
    });

    const dialog = page.getByRole('dialog', { name: 'Switch on AI review' });
    const confirm = dialog.getByRole('button', {
      name: /^Switch on and send code to 127\.0\.0\.1:\d+$/,
    });

    await test.step('the dialog holds the notice; Cancel sends nothing and unchecks the box', async () => {
      await page.getByRole('checkbox', { name: 'Review merge requests with AI' }).check();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#ai-review-notice')).toContainText(
        /^AI review sends the merge request's diff and any repository file the model chooses to read to 127\.0\.0\.1:\d+ \(fake-model\)\./,
      );
      await expect(dialog.locator('#ai-review-notice')).toContainText(
        'Qualor keeps it until the merge request is closed (at most 14 days).',
      );
      await expect(dialog.locator('#ai-review-notice')).toContainText(
        'Secrets the analyzers found are masked; credentials files are never sent.',
      );
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expectAccessible(page);
      // On a phone the long host must not push Cancel out of the dialog, where it is unreachable.
      await page.setViewportSize({ width: 390, height: 844 });
      const frame = (await dialog.boundingBox())!;
      for (const name of ['Cancel', /^Switch on and send code to/]) {
        const at = (await dialog.getByRole('button', { name }).boundingBox())!;
        expect(at.x).toBeGreaterThanOrEqual(frame.x);
        expect(at.x + at.width).toBeLessThanOrEqual(frame.x + frame.width);
      }
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole('checkbox', { name: 'Review merge requests with AI' }),
      ).not.toBeChecked();
      expect(puts).toEqual([]);
    });

    await test.step('Confirm acknowledges the host and model the dialog named', async () => {
      await page.getByRole('checkbox', { name: 'Review merge requests with AI' }).check();
      await expect(dialog).toBeVisible();
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('status')).toHaveText('The AI review settings were saved.');
      await expect(
        page.getByRole('checkbox', { name: 'Review merge requests with AI' }),
      ).toBeChecked();
      expect(puts).toHaveLength(1);
      const sent = JSON.parse(puts[0]!) as {
        enabled: boolean;
        acknowledgeDataSharing: { host: string; model: string };
      };
      expect(sent.enabled).toBe(true);
      expect(sent.acknowledgeDataSharing.host).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(sent.acknowledgeDataSharing.model).toBe('fake-model');
      // The consent covers the provider: no warning to confirm again.
      await expect(page.locator('#ai-review-outdated')).toHaveCount(0);
    });

    await test.step('the scope, the projects and the budgets save without asking again', async () => {
      await page.getByRole('radio', { name: 'Selected projects' }).check();
      await page.getByRole('checkbox', { name: /^Payments API/ }).check();
      await expect(page.locator('#ai-review-selected-count')).toHaveText('1 project selected');
      await page.getByLabel('Tokens per day', { exact: true }).fill('500000');
      await page.getByLabel('Cost per day in US dollars').fill('25');
      await page.getByLabel('Tokens per project and day').fill('250000');
      await page.getByLabel('Tokens per review').fill('120000');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status')).toHaveText('The AI review settings were saved.');
      await expect(dialog).toBeHidden();
      expect(puts).toHaveLength(2);
      expect(JSON.parse(puts[1]!)).not.toHaveProperty('acknowledgeDataSharing');
      await expectAccessible(page);
    });

    await test.step('a reload shows what was saved', async () => {
      await page.reload();
      await expect(
        page.getByRole('checkbox', { name: 'Review merge requests with AI' }),
      ).toBeChecked();
      await expect(page.getByRole('radio', { name: 'Selected projects' })).toBeChecked();
      await expect(page.getByRole('checkbox', { name: /^Payments API/ })).toBeChecked();
      await expect(page.getByRole('checkbox', { name: /^Web Shop/ })).not.toBeChecked();
      await expect(page.getByLabel('Tokens per day', { exact: true })).toHaveValue('500000');
      await expect(page.getByLabel('Cost per day in US dollars')).toHaveValue('25');
      await expect(page.getByLabel('Tokens per project and day')).toHaveValue('250000');
      await expect(page.getByLabel('Tokens per review')).toHaveValue('120000');
      await expect(page.locator('#ai-review-outdated')).toHaveCount(0);
      // No review ran on this server: the day's use is nothing, against the budget just saved.
      await expect(page.locator('#ai-review-usage')).toHaveText(
        'Today: 0 of 500,000 tokens · 0 reviews',
      );
      await expectAccessible(page);
    });

    await test.step('the project panels say which projects are reviewed', async () => {
      await openProjectSettings(page, PAYMENTS.name);
      await expect(
        page
          .getByRole('navigation', { name: 'Settings sections' })
          .getByRole('link', { name: 'AI review' }),
      ).toBeVisible();
      const panel = page.locator('#ai-review');
      await expect(panel.getByRole('heading', { name: 'AI review', level: 2 })).toBeVisible();
      await expect(panel).toContainText('AI review is on for this project.');
      await expect(panel.locator('#ai-review-organization-off')).toHaveCount(0);
      await expectAccessible(page);

      await openProjectSettings(page, SHOP.name);
      await expect(page.locator('#ai-review')).toContainText('AI review is off for this project.');
      await expect(page.locator('#ai-review-organization-off')).toHaveCount(0);
    });

    await test.step('switching it off needs no confirmation, and the panel points to the settings', async () => {
      await page.goto('/settings/ai-review');
      await page.getByRole('checkbox', { name: 'Review merge requests with AI' }).uncheck();
      await expect(dialog).toBeHidden();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status')).toHaveText('The AI review settings were saved.');
      expect(puts).toHaveLength(3);
      expect(JSON.parse(puts[2]!)).toMatchObject({ enabled: false });
      await page.reload();
      await expect(
        page.getByRole('checkbox', { name: 'Review merge requests with AI' }),
      ).not.toBeChecked();

      await openProjectSettings(page, PAYMENTS.name);
      const panel = page.locator('#ai-review');
      await expect(panel).toContainText('AI review is off for this project.');
      await expect(panel.locator('#ai-review-organization-off')).toHaveText(
        'Your organisation admin switches it on in Settings → AI review.',
      );
      await panel.getByRole('link', { name: 'Settings → AI review' }).click();
      await expect(page).toHaveURL(/\/settings\/ai-review$/);
      await expect(page.getByRole('heading', { name: 'AI review', level: 2 })).toBeVisible();
    });
  });

  test('switching review on with three models names all three in the warning and sends them', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const puts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/ai/review')) {
        puts.push(request.postData() ?? '');
      }
    });
    // The instance admin gives the strong and the fast tier a model each (the seed has one model).
    const admin = await playwright.request.newContext({ baseURL, storageState: STORAGE_STATE });
    try {
      await setTierModels(admin, { strongModel: 'fake-strong', fastModel: 'fake-fast' });
      await signIn(page, OLGA);
      await page.goto('/settings/ai-review');
      await expect(page.getByRole('heading', { name: 'AI review', level: 2 })).toBeVisible();
      // The three models, sorted, as the notice names them.
      await expect(page.locator('#ai-review-provider')).toHaveText(
        /^\s*Models fake-fast, fake-model, fake-strong at 127\.0\.0\.1:\d+\s*$/,
      );

      const dialog = page.getByRole('dialog', { name: 'Switch on AI review' });
      await page.getByRole('checkbox', { name: 'Review merge requests with AI' }).check();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#ai-review-notice')).toContainText(
        /to 127\.0\.0\.1:\d+ \(fake-fast, fake-model, fake-strong\)\./,
      );
      await expectAccessible(page);
      await dialog
        .getByRole('button', { name: /^Switch on and send code to 127\.0\.0\.1:\d+$/ })
        .click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('status')).toHaveText('The AI review settings were saved.');
      // The acknowledgement names the standard model and the whole set the dialog showed.
      expect(puts).toHaveLength(1);
      const sent = JSON.parse(puts[0]!) as {
        enabled: boolean;
        acknowledgeDataSharing: { host: string; model: string; models: string[] };
      };
      expect(sent.enabled).toBe(true);
      expect(sent.acknowledgeDataSharing.host).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(sent.acknowledgeDataSharing.model).toBe('fake-model');
      expect(sent.acknowledgeDataSharing.models).toEqual([
        'fake-fast',
        'fake-model',
        'fake-strong',
      ]);
      // The consent names all three: nothing to confirm again, also after a reload.
      await page.reload();
      await expect(
        page.getByRole('checkbox', { name: 'Review merge requests with AI' }),
      ).toBeChecked();
      await expect(page.locator('#ai-review-outdated')).toHaveCount(0);

      // Leave review off, as the test before this one did.
      await page.getByRole('checkbox', { name: 'Review merge requests with AI' }).uncheck();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status')).toHaveText('The AI review settings were saved.');
      expect(puts).toHaveLength(2);
    } finally {
      // The shared e2e database as the seed made it, whatever happened: the one model.
      try {
        await setTierModels(admin, { strongModel: null, fastModel: null });
      } finally {
        await admin.dispose();
      }
    }
  });

  test('a member sees no AI review entry, and the address says it is for organisation admins', async ({
    page,
  }) => {
    // An account the admin created must change its initial password first (ruling R7).
    await page.goto('/login');
    await page.getByLabel('Username').fill(VERA.username);
    await page.getByLabel('Password').fill(VERA.initialPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/change-password$/);
    await page.getByLabel('Current password').fill(VERA.initialPassword);
    await page.getByLabel('New password', { exact: true }).fill(VERA.password);
    await page.getByLabel('Repeat the new password').fill(VERA.password);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/\/projects$/);

    await page.goto('/settings');
    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(nav.getByRole('link', { name: 'Access tokens' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'AI review' })).toHaveCount(0);

    await page.goto('/settings/ai-review');
    await expect(
      page.getByText('Only organisation administrators change the AI review settings.'),
    ).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Review merge requests with AI' })).toHaveCount(
      0,
    );
    await expectAccessible(page);
  });
});
