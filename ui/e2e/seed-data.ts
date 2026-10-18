import { fileURLToPath } from 'node:url';

/**
 * What `server/scripts/e2e/seed.ts` creates, as the end-to-end tests see it. The passwords are
 * passed to the seeding server by playwright.config.ts, so they are defined only here. They are
 * test-only: a real deployment has no default admin password (QUALOR_BOOTSTRAP_ADMIN_PASSWORD is
 * required) and never uses these.
 */
export const ADMIN = { username: 'admin', password: 'e2e admin passphrase' };
export const ALICE = {
  username: 'alice',
  initialPassword: 'alice initial passphrase',
  newPassword: 'alice chose this passphrase',
};

export const PAYMENTS = { key: 'acme/payments-api', name: 'Payments API' };
export const SHOP = { key: 'acme/web-shop', name: 'Web Shop' };
export const LEGACY = { key: 'acme/legacy-billing', name: 'Legacy Billing' };
export const MERGE_REQUEST = { id: '42', source: 'feature/refund-limits' };

/** An issue message and a rule description that carry HTML; both must stay text. */
export const XSS_MESSAGE = 'Avoid <img src=x onerror="alert(1)"> in refund notes';
export const XSS_RULE_TEXT = '<script>alert("rule")</script>';
/**
 * The open issue of Payments API with three related locations (seed.ts): src/refunds/limits.ts:10,
 * src/payments/gateway.ts:88–92 and src/payments/gateway.ts:140.
 */
export const RELATED_ISSUE_MESSAGE = 'Detected eval() with a non-literal argument.';
/** Payments API's own webhook and second analysis token (seed.ts). */
export const PROJECT_WEBHOOK_URL = 'https://hooks.example.com/payments';

export const STORAGE_STATE = '../.tmp/playwright/admin.json';

/**
 * enterprise.md §14.2: the e2e server is a test bundle that also accepts keys signed by its
 * throwaway `test-e2e` key; `server/scripts/e2e/serve.ts` writes one such key here before it is
 * ready (playwright.config.ts passes the path) and removes it when it stops.
 */
export const LICENSE_KEY_FILE = fileURLToPath(
  new URL('../../.tmp/playwright/e2e-license-key', import.meta.url),
);

/**
 * 6M: the last report of Payments API's main branch, with its dependency inventory, which
 * `server/scripts/e2e/serve.ts` writes here (playwright.config.ts passes the path) so the Business
 * test can ingest it again after setting a licence policy. Removed when the server stops.
 */
export const PAYMENTS_REPORT_FILE = fileURLToPath(
  new URL('../../.tmp/playwright/e2e-payments-report.json', import.meta.url),
);
/**
 * 6M: Payments API's dependency inventory (seed.ts PAYMENTS_DEPENDENCIES): seven entries, six with
 * a known licence; `ledger-gpl` is strong copyleft.
 */
export const DEPENDENCIES = {
  known: 6,
  total: 7,
  strongCopyleft: { name: 'ledger-gpl', version: '2.1.0', license: 'GPL-3.0-only' },
  unknown: { name: 'left-pad-internal', path: 'web/pnpm-lock.yaml' },
};

/**
 * Plan 4C (rbac-audit.md §17): the licensed e2e server `server/scripts/e2e/serve.ts` starts next
 * to the community one, with the Enterprise plan's features (`ENTERPRISE_FEATURES`, plan 5D:
 * `audit-log.stream` and `sso.multi` among them), its own database and its own admin session
 * (`enterprise.setup.ts`), and the local receiver its audit stream may post to.
 *
 * Plan 5D: a third server on BUSINESS_PORT serves the enterprise server's database under a
 * Business key (`sso`, `audit-log`, `llm.fix-quota`), as a replica would after a move to the
 * Business plan. It shares that database's sessions, so the enterprise admin's session works
 * there too (cookies do not depend on the port). `business.spec.ts` runs after the enterprise
 * tests, so it sees the stream they configured, kept and paused.
 */
const E2E_PORT = Number(process.env.QUALOR_E2E_PORT ?? '4280');
export const ENTERPRISE_PORT = E2E_PORT + 1;
export const ENTERPRISE_URL = `http://127.0.0.1:${ENTERPRISE_PORT}`;
export const SIEM_PORT = E2E_PORT + 2;
export const SIEM_URL = `http://127.0.0.1:${SIEM_PORT}/qualor-audit`;
export const ENTERPRISE_STORAGE_STATE = '../.tmp/playwright/enterprise-admin.json';
export const BUSINESS_PORT = E2E_PORT + 3;
export const BUSINESS_URL = `http://127.0.0.1:${BUSINESS_PORT}`;
/** Mail E2: serve.ts's reader of pending account emails (community server). */
export const MAIL_PORT = E2E_PORT + 4;
export const MAIL_URL = `http://127.0.0.1:${MAIL_PORT}`;
/** 6G: the fake Slack receiver (server/scripts/e2e/serve.ts `chatReceiver`). */
export const CHAT_PORT = E2E_PORT + 5;
export const CHAT_URL = `http://127.0.0.1:${CHAT_PORT}`;
/** An organisation admin of Default who is not an instance admin, on both servers (seedRoles). */
export const OLGA = { username: 'olga', password: 'olga e2e passphrase' };
/** A user in no organisation, with a Viewer grant on Web Shop only (seed.ts seedRoles). */
export const VICTOR = { username: 'victor', password: 'victor e2e passphrase' };
