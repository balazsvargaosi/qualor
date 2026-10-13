import { readFile } from 'node:fs/promises';
import { expect, expectAccessible, test } from './fixtures';
import { LEGACY, PAYMENTS, SHOP } from './seed-data';

/**
 * 4E-2 §4: the portfolio on the licensed e2e server (`server/scripts/e2e/serve.ts`, the
 * Enterprise plan's features, with `portfolio`). `seedDemo` gives the default organisation three
 * projects: Payments API and Web Shop with succeeded main-branch analyses uploaded during the
 * seeding, and Legacy Billing never analysed (so abandoned). The CSV and PDF are plain download
 * links; the server runs one export per person at a time.
 */

test('an admin opens the portfolio of all organisations by month and downloads it', async ({
  page,
}) => {
  await page.goto('/projects');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Portfolio' })
    .click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page).toHaveTitle('Portfolio · Qualor');
  const thisOrganisation = page.getByRole('button', { name: 'This organisation' });
  await expect(thisOrganisation).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-card="projects"] .kpi-value')).toHaveText('3');

  /** The next overview the page loads, of every organisation by `granularity`. */
  const overviewOf = (granularity: string) =>
    page.waitForResponse((r) => {
      const url = new URL(r.url());
      return (
        url.pathname === '/api/v0/ee/portfolio' &&
        url.searchParams.get('scope') === 'all' &&
        url.searchParams.get('granularity') === granularity
      );
    });

  let overview = overviewOf('week');
  await page.getByRole('button', { name: 'All organisations' }).click();
  expect((await overview).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'All organisations' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(thisOrganisation).toHaveAttribute('aria-pressed', 'false');

  overview = overviewOf('month');
  await page.getByRole('button', { name: 'Months' }).click();
  expect((await overview).status()).toBe(200);
  await expect(page).toHaveURL(/\/portfolio\?scope=all&granularity=month$/);
  await expect(page.getByRole('button', { name: 'Months' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Trend over 12 months' })).toBeVisible();

  // The seed's totals: three projects, two analysed, Legacy Billing never.
  const card = (name: string) => page.locator(`[data-card="${name}"]`);
  await expect(card('projects').locator('.kpi-value')).toHaveText('3');
  await expect(card('projects').locator('.kpi-note')).toHaveText('2 analysed · 1 abandoned');
  await expect(card('ncloc').locator('.kpi-value')).toHaveText(/^[1-9]/);
  await expect(card('issues').locator('.kpi-value')).toHaveText(/^[1-9]/);
  await expect(card('gate')).toContainText('of 2 analysed projects passed');

  // The all scope lists the organisations: the default one, with the three projects.
  const organisations = page.getByRole('region', { name: 'Organisations', exact: true });
  const defaultRow = organisations.getByRole('row', { name: /Default/ });
  await expect(defaultRow.getByRole('cell').first()).toHaveText('3');
  const projects = page.getByRole('region', { name: 'Projects', exact: true });
  for (const p of [PAYMENTS, SHOP, LEGACY]) {
    await expect(projects.getByRole('link', { name: p.name, exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole('region', { name: 'Not analysed in 30 days' }).getByRole('listitem'),
  ).toHaveText([new RegExp(`^${LEGACY.name}\\s*Never analysed$`)]);
  await expectAccessible(page);

  const downloads = page.getByRole('group', { name: 'Download' });
  for (const [label, type, ext] of [
    ['CSV', 'text/csv', 'csv'],
    ['PDF', 'application/pdf', 'pdf'],
  ] as const) {
    const link = downloads.getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute(
      'href',
      new RegExp(`scope=all&granularity=month&format=${ext}$`),
    );
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^qualor-portfolio-all-\\d{8}\\.${ext}$`),
    );
    // The server runs one export per person at a time: let the browser's finish first.
    const file = await readFile(await download.path());
    if (ext === 'csv') {
      // RFC 4180 in UTF-8 with a byte order mark (which trim() would drop).
      expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const lines = file.subarray(3).toString('utf8').trim().split(/\r?\n/);
      expect(lines[0]).toMatch(/^organization_key,organization,project_key,project,/);
      expect(
        lines
          .slice(1)
          .map((l) => l.split(',')[2])
          .sort(),
      ).toEqual([LEGACY.key, PAYMENTS.key, SHOP.key].sort());
    } else {
      expect(file.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
    const res = await page.request.get(download.url());
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain(type);
  }
});
