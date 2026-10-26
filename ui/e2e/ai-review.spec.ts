import type { APIRequest, APIRequestContext, Page } from '@playwright/test';
import { setTierModels } from './ai-provider';
import { expect, expectAccessible, test } from './fixtures';
import { OLGA, PAYMENTS, SHOP, STORAGE_STATE, VERA } from './seed-data';

/**
 * The organisation's AI page (Settings → AI, `/settings/ai-review`) on the community e2e server,
 * for an organisation admin: AI review switched on with the status's button and its data-sharing
 * dialog, its projects and budgets, and the read-only panel in a project's settings. The seed
 * (`seedAi`) points the instance's provider at the fake LLM on loopback, enables the default
 * organisation and links Payments API to the fake GitLab, so review can be switched on; nothing
 * here reaches a real model. The tests sign in as people other than the instance admin, who is an
 * organisation admin of everything anyway.
 */

async function signIn(page: Page, user: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** Runs `act` with a request context signed in as the instance admin, disposed after it. */
async function asAdmin(
  request: APIRequest,
  baseURL: string | undefined,
  act: (admin: APIRequestContext) => Promise<void>,
): Promise<void> {
  const admin = await request.newContext({ baseURL, storageState: STORAGE_STATE });
  try {
    await act(admin);
  } finally {
    await admin.dispose();
  }
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

/** The AI review line of a project's AI panel: its chip, then its sentence. */
const projectReview = (page: Page) => page.locator('section#ai [data-line="review"] .state-line');

/** The AI review line of the Status card, its chip, and the section's foot. */
const reviewLine = (page: Page) => page.locator('li[data-key="review"]');
const reviewState = (page: Page) => reviewLine(page).locator('.badge');
const foot = (page: Page) => page.locator('#review .foot-status');
const SAVED = /^Saved at \d{1,2}:\d{2} [AP]M UTC\.$/;

/** Switches AI review off with the status's button and its confirmation. */
async function switchOff(page: Page): Promise<void> {
  await reviewLine(page).getByRole('button', { name: 'Switch off AI review' }).click();
  const confirm = page.getByRole('dialog', { name: 'Switch off AI review?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Switch off', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(reviewState(page)).toHaveText('Off');
}

test.describe('as people other than the instance admin', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an organisation admin switches AI review on with the button and finds it saved after a reload', async ({
    page,
  }) => {
    const puts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/ai/review')) {
        puts.push(request.postData() ?? '');
      }
    });
    await signIn(page, OLGA);

    await test.step('the entry is AI, in the Organization group of Settings', async () => {
      await page.goto('/settings');
      const nav = page.getByRole('navigation', { name: 'Settings' });
      await nav
        .getByRole('group', { name: 'Organization' })
        .getByRole('link', { name: 'AI', exact: true })
        .click();
      await expect(page).toHaveURL(/\/settings\/ai-review$/);
      await expect(page).toHaveTitle('AI · Qualor');
      await expect(page.getByRole('heading', { name: 'AI', level: 2, exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'AI', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      // The seed's provider: the fake LLM on loopback.
      await expect(page.locator('.settings-head p')).toHaveText(
        /^\s*AI features for Default, on this server's AI provider \(127\.0\.0\.1:\d+\)\./,
      );
      await expect(reviewState(page)).toHaveText('Off');
      await expect(
        reviewLine(page).getByRole('button', { name: 'Switch on AI review…' }),
      ).toBeVisible();
      await expect(page.locator('#review .sec-purpose')).toContainText(
        /with 127\.0\.0\.1:\d+ \(fake-model\)/,
      );
      // The assistant, read-only: the seed enables every feature for Default.
      await expect(page.locator('li[data-key="assistant"]')).toContainText(
        'Explain, Suggest triage, and Suggest a fix on.',
      );
      await expectAccessible(page);
    });

    const dialog = page.getByRole('dialog', { name: 'Switch on AI review' });
    const confirm = dialog.getByRole('button', {
      name: /^Switch on and send code to 127\.0\.0\.1:\d+$/,
    });
    const switchOn = reviewLine(page).getByRole('button', { name: 'Switch on AI review…' });

    await test.step('the dialog holds the notice; Cancel sends nothing', async () => {
      await switchOn.click();
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
      await expect(dialog.locator('#ai-review-scope-line')).toHaveText(
        'No project is selected yet: choose projects below first.',
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
      // The focus is back on the button that opened it.
      await expect(switchOn).toBeFocused();
      await expect(reviewState(page)).toHaveText('Off');
      expect(puts).toEqual([]);
    });

    await test.step('Confirm acknowledges the host and model the dialog named', async () => {
      await switchOn.click();
      await expect(dialog).toBeVisible();
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(reviewState(page)).toHaveText('On');
      await expect(foot(page)).toHaveText(SAVED);
      expect(puts).toHaveLength(1);
      const sent = JSON.parse(puts[0]!) as {
        enabled: boolean;
        acknowledgeDataSharing: { host: string; model: string };
      };
      expect(sent.enabled).toBe(true);
      expect(sent.acknowledgeDataSharing.host).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(sent.acknowledgeDataSharing.model).toBe('fake-model');
      await expect(reviewLine(page).locator('.st-sub')).toHaveText(
        /^Confirmed on \w{3} \d{1,2}, \d{4} \(by you\) for 127\.0\.0\.1:\d+ \(fake-model\)\.$/,
      );
    });

    await test.step('the projects and the budgets save without asking again', async () => {
      await expect(page.getByRole('radio', { name: 'Selected projects' })).toBeChecked();
      await page.getByRole('button', { name: 'Add projects' }).click();
      await page.getByRole('checkbox', { name: /^Payments API/ }).check();
      await page.getByRole('button', { name: 'Add 1 project' }).click();
      const row = page.locator('table.chosen tbody tr', { hasText: PAYMENTS.name });
      await expect(row).toContainText('Yes');
      await expect(foot(page)).toHaveText('1 unsaved change');

      await page.locator('#review details.fold > summary').click();
      await page.getByLabel('Tokens per day', { exact: true }).fill('500000');
      await page.getByLabel('Tokens per review').fill('120000');
      // A switch is named by its name alone; its help only describes it.
      await page.getByRole('switch', { name: 'Limit tokens per project', exact: true }).check();
      await page.getByLabel('Tokens per project per day').fill('250000');
      // No prices on this server: a cost limit would count nothing.
      await expect(
        page.getByRole('switch', { name: 'Limit the cost', exact: true }),
      ).toBeDisabled();
      await expect(page.locator('#ai-review-no-prices')).toContainText(
        'No prices are set on this server, so a cost limit would count nothing.',
      );
      await expect(foot(page)).toHaveText('4 unsaved changes');
      await page.getByRole('button', { name: 'Save AI review' }).click();
      await expect(foot(page)).toHaveText(SAVED);
      await expect(dialog).toBeHidden();
      expect(puts).toHaveLength(2);
      expect(JSON.parse(puts[1]!)).not.toHaveProperty('acknowledgeDataSharing');
      expect(JSON.parse(puts[1]!)).toMatchObject({
        enabled: true,
        scope: 'selected',
        budgets: {
          tokensPerDay: 500_000,
          maxTokensPerReview: 120_000,
          perProjectTokensPerDay: 250_000,
          costPerDayUsd: null,
        },
      });
      await expect(reviewLine(page).locator('.st-line')).toHaveText(/On\s*Reviewing 1 project/);
      // On, with the budgets open.
      await expectAccessible(page);
    });

    await test.step('a reload shows what was saved', async () => {
      await page.reload();
      await expect(reviewState(page)).toHaveText('On');
      await expect(page.getByRole('radio', { name: 'Selected projects' })).toBeChecked();
      await expect(page.locator('table.chosen tbody tr', { hasText: PAYMENTS.name })).toContainText(
        'Yes',
      );
      await expect(page.locator('#review details.fold > summary')).toHaveText(
        /500,000 tokens a day\s*120,000 per review\s*250,000 per project a day\s*No cost limit/,
      );
      await expect(page.getByLabel('Tokens per day', { exact: true })).toHaveValue('500,000');
      await expect(page.getByLabel('Tokens per review')).toHaveValue('120,000');
      await expect(page.getByLabel('Tokens per project per day')).toHaveValue('250,000');
      // No review ran on this server: the day's use is nothing, against the budget just saved.
      await expect(
        page
          .locator('li[data-key="today"] q-meter', { hasText: 'AI review' })
          .locator('.meter-value'),
      ).toHaveText('0 of 500,000');
      await expect(foot(page)).toHaveText('No unsaved changes');
    });

    await test.step('the project panels say which projects are reviewed', async () => {
      await openProjectSettings(page, PAYMENTS.name);
      await expect(
        page
          .getByRole('navigation', { name: 'Settings sections' })
          .getByRole('link', { name: 'AI', exact: true }),
      ).toBeVisible();
      const panel = page.locator('section#ai');
      await expect(panel.getByRole('heading', { name: 'AI', level: 2 })).toBeVisible();
      await expect(projectReview(page).locator('.badge')).toHaveText('Reviewed');
      await expect(projectReview(page).locator('> span:not(.badge)')).toHaveText(
        /^Reviews this project's merge requests, with 127\.0\.0\.1:\d+\.\s*$/,
      );
      await expectAccessible(page);

      await openProjectSettings(page, SHOP.name);
      await expect(projectReview(page).locator('.badge')).toHaveText('Off');
      await expect(projectReview(page).locator('> span:not(.badge)')).toHaveText(
        'Default reviews selected projects only, and this is not one of them. An organization admin adds it in Settings → AI.',
      );
    });

    await test.step('switching it off asks first, and the panel points to the settings', async () => {
      await page.goto('/settings/ai-review');
      await switchOff(page);
      expect(puts).toHaveLength(3);
      expect(JSON.parse(puts[2]!)).toMatchObject({ enabled: false });
      expect(JSON.parse(puts[2]!)).not.toHaveProperty('acknowledgeDataSharing');
      await page.reload();
      await expect(reviewState(page)).toHaveText('Off');

      await openProjectSettings(page, PAYMENTS.name);
      await expect(projectReview(page).locator('.badge')).toHaveText('Off');
      await expect(projectReview(page).locator('> span:not(.badge)')).toHaveText(
        'Default has not switched on AI review. An organization admin switches it on in Settings → AI.',
      );
      await projectReview(page).getByRole('link', { name: 'Settings → AI' }).click();
      await expect(page).toHaveURL(/\/settings\/ai-review$/);
      await expect(page.getByRole('heading', { name: 'AI', level: 2, exact: true })).toBeVisible();
    });
  });

  test.describe('with a model for each tier', () => {
    // A failure midway, a timeout too, must never leave the models in the shared e2e database:
    // the seed's one model is put back through the API whatever the test did. In a hook, a
    // failure of that is reported beside the test's own, never in its place.
    test.afterEach(async ({ playwright, baseURL }) => {
      await asAdmin(playwright.request, baseURL, (admin) =>
        setTierModels(admin, { strongModel: null, fastModel: null }),
      );
    });

    test('switching review on with three models names all three in the notice and sends them', async ({
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
      await asAdmin(playwright.request, baseURL, (admin) =>
        setTierModels(admin, { strongModel: 'fake-strong', fastModel: 'fake-fast' }),
      );
      await signIn(page, OLGA);
      await page.goto('/settings/ai-review');
      await expect(page.getByRole('heading', { name: 'AI', level: 2, exact: true })).toBeVisible();
      // The three models, sorted, as the notice names them.
      await expect(page.locator('#review .sec-purpose')).toContainText(
        /with 127\.0\.0\.1:\d+ \(fake-fast, fake-model, fake-strong\)/,
      );

      const dialog = page.getByRole('dialog', { name: 'Switch on AI review' });
      await reviewLine(page).getByRole('button', { name: 'Switch on AI review…' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#ai-review-notice')).toContainText(
        /to 127\.0\.0\.1:\d+ \(fake-fast, fake-model, fake-strong\)\./,
      );
      await expectAccessible(page);
      await dialog
        .getByRole('button', { name: /^Switch on and send code to 127\.0\.0\.1:\d+$/ })
        .click();
      await expect(dialog).toBeHidden();
      await expect(reviewState(page)).toHaveText('On');
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
      await expect(reviewState(page)).toHaveText('On');

      // Leave review off, as the test before this one did.
      await switchOff(page);
      expect(puts).toHaveLength(2);
    });
  });

  test('a member sees no AI entry, and the address says it is for organisation admins', async ({
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
    await expect(nav.getByRole('link', { name: 'AI', exact: true })).toHaveCount(0);

    await page.goto('/settings/ai-review');
    await expect(
      page.getByText('Only organisation administrators change the AI review settings.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch on AI review…' })).toHaveCount(0);
    await expectAccessible(page);
  });
});
