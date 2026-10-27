import type { Page } from '@playwright/test';
import { expect, expectAccessible, test } from './fixtures';
import { PAYMENTS } from './seed-data';

/**
 * The three AI settings pages (AI settings redesign) on the community e2e server, as the instance
 * admin, who is an organisation admin of Default too: Settings → AI provider (`/settings/ai`),
 * Settings → AI (`/settings/ai-review`) and the project's AI panel. On a phone (390px) and a tablet
 * (768px) nothing scrolls sideways and no control leaves its card, in the states that open the
 * most; the dark scheme keeps its contrast; and the keyboard paths reach and leave each dialog and
 * editor. The seed (`seedAi`) points the provider at the fake LLM on loopback and allows Default.
 * Nothing stays changed: one limit is saved and put back, and Default's AI review stays off, as
 * `ai.spec.ts` expects.
 */

// Colours fade in (0.15s): axe must never measure one halfway (styles.css shortens every
// transition for reduced motion).
test.use({ reducedMotion: 'reduce' });

/** A section's foot after its save: "Saved at 2:05 PM UTC." */
const SAVED = /^Saved at \d{1,2}:\d{2} [AP]M UTC\.$/;

/** Payments API's id, for its settings' address. */
async function paymentsId(page: Page): Promise<string> {
  const answer = await page.request.get('/api/v0/projects?limit=100');
  const { items } = (await answer.json()) as { items: { id: string; key: string }[] };
  return items.find((p) => p.key === PAYMENTS.key)!.id;
}

/**
 * Nothing scrolls sideways, and every control ends inside its card (one in an open dialog, inside
 * the dialog): their boxes, compared as narrow.spec.ts's `inPanel` does. Half a pixel is rounding.
 * `cards` names the cards to check; the project's settings page holds other panels than its AI.
 */
async function fits(page: Page, width: number, cards = '.card'): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  const outside = await page.evaluate((cards) => {
    const found: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], summary',
    );
    for (const control of controls) {
      if (control.getClientRects().length === 0) continue;
      const frame = control.closest<HTMLElement>(`dialog[open], ${cards}`);
      if (!frame) continue;
      const box = control.getBoundingClientRect();
      const outer = frame.getBoundingClientRect();
      if (box.left < outer.left - 0.5 || box.right > outer.right + 0.5) {
        const name = control.id || control.textContent?.trim().slice(0, 40) || control.tagName;
        found.push(
          `${frame.id || frame.className}: ${name} at ${box.left}–${box.right}, ` +
            `the frame ${outer.left}–${outer.right}`,
        );
      }
    }
    return found;
  }, cards);
  expect(outside).toEqual([]);
}

/** The AI provider page with Default's editor open (Edit), and its project picker open. */
async function openDefaultEditor(page: Page): Promise<void> {
  await page.goto('/settings/ai');
  await expect(page.getByRole('heading', { name: 'AI provider', level: 2 })).toBeVisible();
  await page.locator('#organizations').getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit Default' });
  await expect(editor.getByRole('switch', { name: 'Allow AI in Default' })).toBeFocused();
  await editor.getByRole('button', { name: 'Add a project' }).click();
  await expect(
    editor.getByRole('checkbox', { name: new RegExp(`^${PAYMENTS.name}`) }),
  ).toBeVisible();
}

/** The organisation's AI page, its review off. */
async function openOrganizationPage(page: Page): Promise<void> {
  await page.goto('/settings/ai-review');
  await expect(page.getByRole('heading', { name: 'AI', level: 2, exact: true })).toBeVisible();
  await expect(page.locator('li[data-key="review"] .badge')).toHaveText('Off');
}

for (const width of [390, 768]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the AI provider page fits with Default's editor and its picker open", async ({
      page,
    }) => {
      await openDefaultEditor(page);
      await fits(page, width);
      await expectAccessible(page);
    });

    test('the AI page fits with its picker open, and with the consent dialog open', async ({
      page,
    }) => {
      await openOrganizationPage(page);
      const review = page.locator('section#review');
      await review.getByRole('button', { name: 'Add projects' }).click();
      await expect(
        review.getByRole('checkbox', { name: new RegExp(`^${PAYMENTS.name}`) }),
      ).toBeVisible();
      await fits(page, width);
      await expectAccessible(page);
      await review.locator('.picker').getByRole('button', { name: 'Cancel' }).click();

      await page
        .locator('li[data-key="review"]')
        .getByRole('button', { name: 'Switch on AI review…' })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Switch on AI review' });
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await fits(page, width);
      await expectAccessible(page);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('li[data-key="review"] .badge')).toHaveText('Off');
    });

    test("the project's AI panel fits", async ({ page }) => {
      await page.goto(`/projects/${await paymentsId(page)}/settings#ai`);
      const panel = page.locator('section#ai');
      await expect(panel.getByRole('heading', { name: 'AI', level: 2 })).toBeVisible();
      await expect(panel.locator('[data-line="review"] .badge')).toHaveText('Off');
      await fits(page, width, 'section#ai');
      await expectAccessible(page);
    });
  });
}

test('the AI provider page keeps its contrast in the dark scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDefaultEditor(page);
  // The switches, on and off, and the note of what a cost limit needs.
  await expect(page.getByRole('switch', { name: 'Allow AI in Default' })).toBeChecked();
  await expect(
    page.locator('#limits').getByRole('switch', { name: 'Limit the cost' }),
  ).not.toBeChecked();
  await expect(page.locator('#ai-budget-no-prices')).toBeVisible();
  await expectAccessible(page);
});

test.describe('by keyboard', () => {
  test('the AI page: Tab to the switch-on, Enter opens the dialog on Cancel, Escape closes it', async ({
    page,
  }) => {
    await openOrganizationPage(page);
    const switchOn = page
      .locator('li[data-key="review"]')
      .getByRole('button', { name: 'Switch on AI review…' });
    await page.getByRole('heading', { name: 'AI', level: 2, exact: true }).focus();
    for (
      let i = 0;
      i < 20 && !(await switchOn.evaluate((b) => b === document.activeElement));
      i++
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(switchOn).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Switch on AI review' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(switchOn).toBeFocused();
    await expect(page.locator('li[data-key="review"] .badge')).toHaveText('Off');
  });

  test('the AI provider page: Edit moves the focus to the editor, Close back to Edit', async ({
    page,
  }) => {
    await page.goto('/settings/ai');
    const section = page.locator('#organizations');
    const edit = section.getByRole('button', { name: 'Edit', exact: true });
    await edit.focus();
    await page.keyboard.press('Enter');
    const allow = page.getByRole('switch', { name: 'Allow AI in Default' });
    await expect(allow).toBeFocused();
    // Back up to the row's Close (the Edit button, renamed while its editor is open).
    const close = section.getByRole('button', { name: 'Close', exact: true });
    for (let i = 0; i < 4 && !(await close.evaluate((b) => b === document.activeElement)); i++) {
      await page.keyboard.press('Shift+Tab');
    }
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Edit Default' })).toHaveCount(0);
    await expect(edit).toBeFocused();
  });

  test('a section keeps the focus on its Save through the save', async ({ page }) => {
    const budgets = async () =>
      ((await (await page.request.get('/api/v0/system/llm')).json()) as { budgets: object })
        .budgets;
    const before = await budgets();
    await page.goto('/settings/ai');
    const limits = page.locator('#limits');
    const explain = limits.locator('#ai-budget-explain');
    const save = limits.getByRole('button', { name: 'Save limits' });
    const stored = await explain.inputValue();
    const saveByKeyboard = async () => {
      const saved = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().endsWith('/api/v0/system/llm'),
      );
      await save.focus();
      await page.keyboard.press('Enter');
      expect((await saved).status()).toBe(200);
      await expect(limits.locator('.foot-status')).toHaveText(SAVED);
      // Nothing is left to save, and the focus stays on Save, never on the page's body.
      await expect(save).toHaveAttribute('aria-disabled', 'true');
      await expect(save).toBeFocused();
    };

    await explain.fill(String(Number(stored.replaceAll(',', '')) + 1));
    await saveByKeyboard();
    // Put back as it was.
    await explain.fill(stored);
    await saveByKeyboard();
    expect(await budgets()).toEqual(before);
  });
});

test.describe('a budget reached for today', () => {
  /**
   * Today's use as a busy day would leave it, in this browser only: AI review and the assistant
   * each at their budget, with the notes after it.
   */
  async function reached(page: Page): Promise<void> {
    await page.route(/\/api\/v0\/organizations\/[^/]+\/ai\/review$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as {
        budgets: { tokensPerDay: number };
        usage: object;
      };
      return route.fulfill({
        response,
        json: {
          ...body,
          usage: { ...body.usage, tokensToday: body.budgets.tokensPerDay, reviewsToday: 1_234 },
        },
      });
    });
    await page.route(/\/api\/v0\/organizations\/[^/]+\/ai$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        budgets: { tokensPerDay: number | null };
        usage: object;
      };
      const max = body.budgets.tokensPerDay ?? 1_000_000;
      return route.fulfill({
        response,
        json: {
          ...body,
          budgets: { ...body.budgets, tokensPerDay: max },
          usage: { ...body.usage, explain: 1_234, triage: 5_678, fix: 9_012, tokens: max + 1 },
        },
      });
    });
  }

  for (const width of [390, 1280]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`says so, then its note, at ${width}px in the ${colorScheme} scheme`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await reached(page);
        await openOrganizationPage(page);
        const meters = page.locator('li[data-key="today"] q-meter');
        await expect(meters).toHaveCount(2);
        for (const meter of await meters.all()) {
          await expect(meter.locator('.meter-note').first()).toHaveText('Budget reached for today');
          await expect(meter.locator('.meter-added')).toBeVisible();
        }
        await expect(meters.first().locator('.meter-added')).toHaveText('1,234 reviews');
        await expect(meters.last().locator('.meter-added')).toHaveText(
          'Explanations 1,234 · Triage 5,678 · Fixes 9,012',
        );
        await fits(page, width);
        // Each meter's words end inside the Status card.
        const card = (await page.locator('q-status-list .card').boundingBox())!;
        for (const part of await meters.locator('.meter-head, .meter-note').all()) {
          const box = (await part.boundingBox())!;
          expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
        }
        await expectAccessible(page);
      });
    }
  }
});
