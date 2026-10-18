import { createHash, randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, expectAccessible, test } from './fixtures';
import { ADMIN } from './seed-data';

/**
 * 6N spec §6: an MCP client's sign-in through Qualor's own OAuth server, in the browser. The test
 * registers a client (DCR), opens `/oauth/authorize` with a PKCE challenge as the signed-in admin,
 * answers the consent screen and sees the browser sent to the client's loopback callback. Nothing
 * listens there: the test answers that address itself and waits for the request. The served
 * server has QUALOR_PUBLIC_URL set to its own address (server/scripts/e2e/serve.ts).
 */
const CALLBACK = 'http://127.0.0.1:47391/callback';

async function register(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/oauth/register', {
    data: {
      client_name: name,
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Opens the authorization endpoint for `clientId` and lands on the consent screen. */
async function authorize(page: Page, clientId: string, state: string): Promise<void> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: 'mcp:read mcp:write',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  // The client's callback: nothing listens on that port, so the test answers it.
  await page.route(`${CALLBACK}*`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback' }),
  );
  await page.goto(`/oauth/authorize?${query.toString()}`);
  await expect(page).toHaveURL(/\/oauth\/consent\?request=[0-9a-f-]{36}$/);
  await expect(page).toHaveTitle('Connect an app · Qualor');
}

test.describe('MCP sign-in (6N spec §6)', () => {
  test('Allow sends a code to the client, and the app can be disconnected', async ({ page }) => {
    const name = `E2E agent ${Date.now()}`;
    const clientId = await register(page.request, name);
    await authorize(page, clientId, 'state-allow');

    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByText(`wants to access Qualor as ${ADMIN.username}.`)).toBeVisible();
    await expect(page.getByText('Not verified: this app registered itself.')).toBeVisible();
    await expect(page.getByText(CALLBACK, { exact: true })).toBeVisible();
    const write = page.getByLabel(
      'Change issue statuses (false positive, won’t fix) with a comment',
    );
    await expect(write).toBeChecked();
    await expectAccessible(page);

    const callback = page.waitForRequest((r) => r.url().startsWith(CALLBACK));
    await page.getByRole('button', { name: 'Allow' }).click();
    const back = new URL((await callback).url());
    expect(back.searchParams.get('code')).toMatch(/^qlr_oac_[0-9A-Za-z]{32}$/);
    expect(back.searchParams.get('state')).toBe('state-allow');
    expect(back.searchParams.get('error')).toBeNull();

    await page.goto('/settings/connected-apps');
    await expect(page.getByRole('heading', { name: 'Connected apps', level: 2 })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText('Read and change issue statuses');
    await expect(row).toContainText('Not used yet');
    await expectAccessible(page);
    await row.getByRole('button', { name: `Disconnect ${name}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect the app' });
    await expect(dialog).toContainText(`Disconnect ${name}?`);
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('status')).toHaveText(`${name} disconnected.`);
    await expect(page.getByText('No apps are connected.')).toBeVisible();
  });

  test('Deny sends access_denied to the client', async ({ page }) => {
    const clientId = await register(page.request, `E2E denied agent ${Date.now()}`);
    await authorize(page, clientId, 'state-deny');
    const callback = page.waitForRequest((r) => r.url().startsWith(CALLBACK));
    await page.getByRole('button', { name: 'Deny' }).click();
    const back = new URL((await callback).url());
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('state-deny');
    expect(back.searchParams.get('code')).toBeNull();
  });

  test('Settings → MCP shows the endpoint and the client policy', async ({ page, baseURL }) => {
    await page.goto('/settings/mcp');
    await expect(page.getByRole('heading', { name: 'MCP', level: 2 })).toBeVisible();
    await expect(page.getByLabel('MCP URL')).toHaveValue(`${baseURL}/mcp`);
    await expect(
      page.getByLabel('Let apps register themselves (dynamic registration)'),
    ).toBeChecked();
    await expectAccessible(page);
  });
});
