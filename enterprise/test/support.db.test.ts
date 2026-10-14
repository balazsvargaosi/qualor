// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createTestContext,
  createUser,
  login,
  type TestContext,
} from '../../server/test/app';
import {
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  signTest,
  testPayload,
  testSigner,
  verifyWith,
} from '../../server/test/license';
import { MIGRATIONS_DIR } from '../../server/test/paths';
import { LICENSE_EXPIRES } from '../../server/test/rbac';
import { readZip } from '../../server/test/zip';
import { createAuditRecorder } from '../../server/src/audit/recorder';
import { auditEvents } from '../../server/src/db/schema';
import { createEdition, type Edition } from '../../server/src/license/edition';
import { licenseState } from '../../server/src/license/state';
import { verifyLicenseKey } from '../../server/src/license/verify';
import { loadPlugins } from '../../server/src/plugins/loader';
import { dropPluginsThatFailToMount } from '../../server/src/plugins/mount';
import { createPluginServices } from '../../server/src/plugins/services';
import { buildEnterprise } from '../scripts/bundle';

// Under enterprise/, so the bundle resolves its external packages from enterprise/node_modules.
const OUT = fileURLToPath(new URL('../.tmp/support-test/plugin.js', import.meta.url));
const LICENSED = new Date('2027-01-01T00:00:00Z');
const BUNDLE = '/api/v0/ee/support/bundle';
const NAV = {
  point: 'settings.nav',
  id: 'support',
  label: 'Support',
  path: '/settings/ee/support',
};

function quietLogger(): never {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l as never;
}

/**
 * The built plugin through the real loader under a signed key listing `features`, with the
 * services bound to the edition as bootEnterprise binds them, the support service included.
 */
async function bootEnterpriseTest(features: readonly string[]): Promise<TestContext> {
  const signer = testSigner();
  const verifyOptions = (at: Date) => verifyWith(signer, at);
  const verification = verifyLicenseKey(
    signTest(signer, testPayload({ features: [...features], expires: LICENSE_EXPIRES })),
    verifyOptions(LICENSED),
  );
  const boot = { source: 'uploaded' as const, keyHash: 'h', verification };
  return createTestContext({
    pluginsFor: async (db, config, logger) => {
      let edition: Edition | undefined;
      const isFeatureActive = (f: string): boolean => edition?.isFeatureActive(f) ?? false;
      const audit = createAuditRecorder({
        isActive: () => isFeatureActive('audit-log'),
        now: () => LICENSED,
        log: logger,
      });
      const services = createPluginServices({
        db,
        isFeatureActive,
        secretKey: config.secretKey,
        version: '0.0.0',
        recorder: audit,
        now: () => LICENSED,
        config,
        edition: () => {
          if (!edition) throw new Error('the edition does not exist yet');
          return edition;
        },
        logger,
        support: { migrationsDir: MIGRATIONS_DIR },
      });
      const plugins = await loadPlugins({
        paths: [OUT],
        state: licenseState(verification, LICENSED),
        base: { serverVersion: '0.0.0', db, logger: quietLogger(), services },
      });
      await dropPluginsThatFailToMount(plugins, quietLogger());
      return {
        plugins,
        edition: (frozen) => {
          edition = createEdition({ boot, plugins: frozen, now: () => LICENSED, verifyOptions });
          return edition;
        },
        audit,
      };
    },
  });
}

beforeAll(async () => {
  await buildEnterprise({ outfile: OUT });
}, 60_000);

describe('Qualor Enterprise: the support bundle through the built plugin (4E-3b §4)', () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  const events = (c: TestContext) =>
    c.db.select().from(auditEvents).where(eq(auditEvents.action, 'support.bundle_downloaded'));

  /** Boots under `features`; returns the admin's headers. */
  async function boot(features: readonly string[]) {
    ctx = await bootEnterpriseTest(features);
    return (await login(ctx, 'admin', ADMIN_PASSWORD)).headers;
  }

  for (const [plan, features] of [
    ['Enterprise', ENTERPRISE_FEATURES],
    ['Business', BUSINESS_FEATURES],
  ] as const) {
    it(`lets an instance admin download the archive under a ${plan} key, shows the Support entry and audits it`, async () => {
      const headers = await boot(features);
      expect(ctx!.edition!.activeFeatures()).toContain('support-bundle');
      const info = (
        await ctx!.app.inject({ method: 'GET', url: '/api/v0/system/info', headers })
      ).json() as { features: string[]; extensions: unknown[] };
      expect(info.features).toContain('support-bundle');
      expect(info.extensions).toContainEqual(NAV);

      const res = await ctx!.app.inject({ method: 'GET', url: BUNDLE, headers });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="qualor-support-\d{8}-\d{6}\.zip"$/,
      );
      const entries = readZip(res.rawPayload);
      const names = entries.map((e) => e.name);
      expect(names).toEqual(
        expect.arrayContaining(['manifest.json', 'license.json', 'logs.jsonl']),
      );
      const license = JSON.parse(entries.find((e) => e.name === 'license.json')!.data.toString());
      expect(license.activeFeatures).toContain('support-bundle');

      const recorded = await events(ctx!);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        actorUsername: 'admin',
        details: { source: 'ui', bytes: res.rawPayload.length },
      });

      // The slot was freed with the response: a second download works.
      expect((await ctx!.app.inject({ method: 'GET', url: BUNDLE, headers })).statusCode).toBe(200);
    });
  }

  it('refuses a user who is not an instance administrator with 403, recording nothing', async () => {
    await boot(BUSINESS_FEATURES);
    const member = await createUser(ctx!, { username: 'member' });
    const session = await login(ctx!, member.username, member.password);
    const res = await ctx!.app.inject({ method: 'GET', url: BUNDLE, headers: session.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(await events(ctx!)).toHaveLength(0);
  });

  it('answers 403 FEATURE_NOT_LICENSED, and lists no Support entry, without the feature (community)', async () => {
    const headers = await boot(['audit-log']);
    expect(ctx!.edition!.activeFeatures()).not.toContain('support-bundle');
    const res = await ctx!.app.inject({ method: 'GET', url: BUNDLE, headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
    const info = (
      await ctx!.app.inject({ method: 'GET', url: '/api/v0/system/info', headers })
    ).json() as { extensions: unknown[] };
    expect(info.extensions).not.toContainEqual(NAV);
    expect(await events(ctx!)).toHaveLength(0);
  });
});
