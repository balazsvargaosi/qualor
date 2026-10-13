import { createHmac, hkdfSync } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, expectAccessible, test } from './fixtures';
import { PAYMENTS } from './seed-data';

/** The community e2e server's QUALOR_SECRET_KEY (server/scripts/e2e/serve.ts). */
const E2E_SECRET_KEY = 'e2e-secret-key-that-is-at-least-32-characters-long';

/**
 * An email's stop-link token, made as server/src/notifications/unsubscribe.ts makes it (the UI's
 * tests never import server code): base64url("<userId>:<projectId>") "." base64url(HMAC-SHA256
 * under HKDF-SHA256(secret, salt "qualor", info "unsubscribe v1")). The server's unit tests pin
 * the algorithm; if the two drift, the last step of this test fails.
 */
function unsubscribeToken(userId: string, projectId: string): string {
  const key = Buffer.from(hkdfSync('sha256', E2E_SECRET_KEY, 'qualor', 'unsubscribe v1', 32));
  const payload = Buffer.from(`${userId}:${projectId}`, 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

async function ids(page: Page): Promise<{ userId: string; projectId: string; csrf: string }> {
  const me = (await (await page.request.get('/api/v0/auth/me')).json()) as {
    user: { id: string };
    csrfToken: string;
  };
  const project = (await (
    await page.request.get(`/api/v0/projects/by-key?key=${encodeURIComponent(PAYMENTS.key)}`)
  ).json()) as { id: string };
  return { userId: me.user.id, projectId: project.id, csrf: me.csrfToken };
}

test('watch a project, find it in Settings → Notifications, and stop with the email link', async ({
  page,
}) => {
  const { userId, projectId, csrf } = await ids(page);
  const token = unsubscribeToken(userId, projectId);
  // An earlier, interrupted run may have left the watch.
  await page.request.delete(`/api/v0/projects/${projectId}/watch`, {
    headers: { 'x-qualor-csrf': csrf },
  });

  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Watching', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  const menu = page.getByRole('group', { name: 'Email notifications for this project' });
  await expect(menu.getByRole('radio', { name: 'Main branch' })).toBeChecked();
  await menu.getByRole('radio', { name: 'All branches and merge requests' }).check();
  await expect(menu.getByRole('radio', { name: 'All branches and merge requests' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await page.goto('/settings/notifications');
  await expect(page).toHaveTitle('Notifications · Qualor');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: PAYMENTS.name })).toBeVisible();
  await expect(main.getByRole('combobox', { name: `Branches of ${PAYMENTS.name}` })).toHaveValue(
    'all',
  );
  await expectAccessible(page);

  // The page itself: it asks, and the token is not left in the address bar.
  await page.goto(`/unsubscribe#t=${token}`);
  await expect(
    page.getByRole('heading', { name: 'Stop emails about this project?' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/unsubscribe$/);
  expect(page.url()).not.toContain(token);
  await expectAccessible(page);

  // The header URL of the email (a mail app without one-click opens it): the server redirects the
  // GET to the same page and changes nothing.
  await page.goto(`/api/v0/notifications/unsubscribe?t=${token}`);
  await expect(
    page.getByRole('heading', { name: 'Stop emails about this project?' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/unsubscribe$/);
  expect(page.url()).not.toContain(token);
  const watch = await page.request.get(`/api/v0/projects/${projectId}/watch`);
  expect(((await watch.json()) as { watching: boolean }).watching).toBe(true);

  await page.getByRole('button', { name: 'Stop emails' }).click();
  await expect(page.getByText(`You no longer watch ${PAYMENTS.name}.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Done' })).toBeFocused();
  await page.getByRole('link', { name: 'Notification settings' }).click();
  await expect(
    page.getByText("You don't watch any project yet. Use Watch on a project page."),
  ).toBeVisible();
});
