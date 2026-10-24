import { expect, expectAccessible, test } from './fixtures';
import { AI_FINDING, MERGE_REQUEST, PAYMENTS } from './seed-data';

/**
 * The findings of the AI review, on the community e2e server. A review needs a worker, a
 * repository snapshot and a model, so the seed (`seedAiFinding`) leaves what a finished review
 * leaves: an issue of the `ai` engine on merge request !42 of Payments API, with its text, its
 * suggestion and the commit it read.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('link', { name: PAYMENTS.name }).click();
  await page.getByRole('link', { name: 'All open issues' }).click();
  await expect(page).toHaveTitle('Issues · Qualor');
  await page
    .getByLabel('Branch')
    .selectOption({ label: `!${MERGE_REQUEST.id} ${MERGE_REQUEST.source} → main` });
  await expect(page).toHaveURL(/branch=/);
});

test('an AI finding shows its badge in the list and its suggestion in the detail', async ({
  page,
}) => {
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: AI_FINDING.message }) });
  await test.step('the list marks the finding AI, and only the finding', async () => {
    await expect(row.locator('.badge', { hasText: /^AI$/ })).toBeVisible();
    await expect(page.locator('tbody .badge', { hasText: /^AI$/ })).toHaveCount(1);
    // More than the finding is listed: the analyzers' issues of the merge request are not marked.
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(1);
    await expectAccessible(page);
  });

  await test.step('the review is an analyzer to filter by', async () => {
    await page.getByRole('group', { name: 'Analyzer' }).getByLabel('AI review').check();
    await expect(page).toHaveURL(/engine=ai/);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(row).toBeVisible();
    await page.getByRole('group', { name: 'Analyzer' }).getByLabel('AI review').uncheck();
    await expect(page).not.toHaveURL(/engine=ai/);
  });

  await test.step('the detail shows the review in a card of its own, as text', async () => {
    await page.getByRole('link', { name: AI_FINDING.message }).click();
    await expect(page).toHaveTitle('Issue · Qualor');
    const card = page.getByRole('region', { name: 'AI review', exact: true });
    await expect(card).toBeVisible();
    // The review's words may carry markup: it is text, and no dialog opens (fixtures.ts).
    await expect(card).toContainText(AI_FINDING.bodyMarkup);
    await expect(card.locator('img')).toHaveCount(0);
    await expect(card).toContainText(`Assumes: ${AI_FINDING.assumption}`);
    await expect(card.getByRole('heading', { name: 'Suggested change (line 12)' })).toBeVisible();
    const suggestion = card.locator('pre.snippet');
    await expect(suggestion.locator('.ln')).toHaveText('12');
    await expect(suggestion).toContainText(AI_FINDING.suggestedLine);
    await expect(card).toContainText(`Reviewed commit ${AI_FINDING.reviewedCommit}`);
    await expect(card).toContainText(
      'Found by AI review. It may be wrong, and it never counts in the quality gate.',
    );
    await expectAccessible(page);
  });
});

test('a finding of the AI review shows on its file page with the AI badge', async ({ page }) => {
  await page.getByRole('link', { name: AI_FINDING.message }).click();
  await expect(page).toHaveTitle('Issue · Qualor');
  await page.getByRole('link', { name: 'src/refunds/limits.ts:12' }).click();
  await expect(page.getByRole('heading', { name: 'Issues', level: 2 })).toBeVisible();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: AI_FINDING.message }) });
  await expect(row.locator('.badge', { hasText: /^AI$/ })).toBeVisible();
  await expectAccessible(page);
});
