// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { fileURLToPath } from 'node:url';
import type { DependencyEntry, LicensePolicy } from '@qualor/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createIngestHarness,
  type IngestHarness,
  type IngestProject,
} from '../../server/test/ingest';
import {
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  signTest,
  testPayload,
  testSigner,
  verifyWith,
} from '../../server/test/license';
import { engine, file, reportWith } from '../../server/test/reports';
import { AFTER_GRACE, LICENSE_EXPIRES } from '../../server/test/rbac';
import { createAuditRecorder } from '../../server/src/audit/recorder';
import { issues, rules } from '../../server/src/db/schema';
import { createEdition, type Edition } from '../../server/src/license/edition';
import { licenseState } from '../../server/src/license/state';
import { verifyLicenseKey } from '../../server/src/license/verify';
import { loadPlugins } from '../../server/src/plugins/loader';
import { dropPluginsThatFailToMount } from '../../server/src/plugins/mount';
import { createPluginServices } from '../../server/src/plugins/services';
import { buildEnterprise } from '../scripts/bundle';

// Under enterprise/, so the bundle resolves its external packages from enterprise/node_modules.
const OUT = fileURLToPath(new URL('../.tmp/license-policy-test/plugin.js', import.meta.url));
const LICENSED = new Date('2027-01-01T00:00:00Z');
const LOCK = 'web/package-lock.json';
const POLICY: LicensePolicy = {
  mode: 'denylist',
  forbiddenGroups: ['strong-copyleft'],
  forbidden: [],
  allowed: [],
  warnUnknown: false,
};

function quietLogger(): never {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l as never;
}

/**
 * The built plugin through the real loader under a signed key listing `features`, with the edition
 * bound to `clock` so a test can move past the grace period.
 */
function bootBundle(features: readonly string[], clock: () => Date): Promise<IngestHarness> {
  const signer = testSigner();
  const verifyOptions = (at: Date) => verifyWith(signer, at);
  const verification = verifyLicenseKey(
    signTest(signer, testPayload({ features: [...features], expires: LICENSE_EXPIRES })),
    verifyOptions(LICENSED),
  );
  const boot = { source: 'uploaded' as const, keyHash: 'h', verification };
  return createIngestHarness({
    pluginsFor: async (db, config, logger) => {
      let edition: Edition | undefined;
      const isFeatureActive = (f: string): boolean => edition?.isFeatureActive(f) ?? false;
      const audit = createAuditRecorder({
        isActive: () => isFeatureActive('audit-log'),
        now: clock,
        log: logger,
      });
      const services = createPluginServices({
        db,
        isFeatureActive,
        secretKey: config.secretKey,
        version: '0.0.0',
        recorder: audit,
        now: clock,
        config,
        edition: () => {
          if (!edition) throw new Error('the edition does not exist yet');
          return edition;
        },
        logger,
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
          edition = createEdition({ boot, plugins: frozen, now: clock, verifyOptions });
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

describe('Qualor Enterprise: the licence policy through the built plugin (6M §5)', () => {
  let h: IngestHarness | undefined;
  let now = LICENSED;
  let minute = 0;
  afterEach(async () => {
    await h?.close();
    h = undefined;
    now = LICENSED;
  });

  const policyUrl = () => `/api/v0/organizations/${h!.organizationId}/license-policy`;
  const put = (policy: LicensePolicy | null) =>
    h!.ctx.app.inject({
      method: 'PUT',
      url: policyUrl(),
      headers: h!.orgAdmin.headers,
      payload: { policy },
    });
  const get = () =>
    h!.ctx.app.inject({ method: 'GET', url: policyUrl(), headers: h!.orgAdmin.headers });
  const gpl: DependencyEntry = {
    ecosystem: 'npm',
    path: LOCK,
    name: 'gpl-pkg',
    version: '1.0.0',
    licenses: ['GPL-3.0-only'],
    line: 15,
  };
  const ingest = (p: IngestProject, dependencies: DependencyEntry[]) =>
    p.ingestOk(
      reportWith({
        projectKey: p.key,
        analysisDate: new Date(Date.UTC(2027, 0, 1, 10, minute++)).toISOString(),
        files: [file(LOCK, { language: 'other', lines: 400, newLines: [] })],
        findings: [],
        engines: [engine('trivy-licenses')],
        dependencies,
      }),
    );
  const licenceIssues = async (p: IngestProject) =>
    (
      await h!.ctx.db
        .select({ status: issues.status, rule: rules.key })
        .from(issues)
        .innerJoin(rules, eq(rules.id, issues.ruleId))
        .where(and(eq(issues.projectId, p.id), eq(rules.engineId, 'license')))
    ).map((r) => [r.rule, r.status]);

  for (const [plan, features] of [
    ['Enterprise', ENTERPRISE_FEATURES],
    ['Business', BUSINESS_FEATURES],
  ] as const) {
    it(`turns the policy on under a ${plan} key: the seam, the PUT and the findings`, async () => {
      h = await bootBundle(features, () => now);
      const edition = h.ctx.edition!;
      expect(edition.activeFeatures()).toContain('license-policy');
      expect(edition.limits().licenses.policy).toBe(true);
      expect((await get()).json()).toMatchObject({ available: true, policy: null });

      const res = await put(POLICY);
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.json()).toMatchObject({ available: true, policy: POLICY });

      const p = await h.project(`lp/${plan.toLowerCase()}`);
      await ingest(p, [gpl]);
      expect(await licenceIssues(p)).toEqual([['license:forbidden', 'open']]);
    });
  }

  it('answers 403 FEATURE_NOT_LICENSED, and creates no findings, on a community instance', async () => {
    h = await bootBundle(['audit-log'], () => now);
    expect(h.ctx.edition!.activeFeatures()).not.toContain('license-policy');
    expect(h.ctx.edition!.limits().licenses.policy).toBe(false);
    expect((await get()).json()).toMatchObject({ available: false });
    const res = await put(POLICY);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
    const p = await h.project('lp/community');
    await ingest(p, [gpl]);
    expect(await licenceIssues(p)).toEqual([]);
  });

  it('turns it off again past the grace period: 403, no new findings, the existing ones kept', async () => {
    h = await bootBundle(BUSINESS_FEATURES, () => now);
    expect((await put(POLICY)).statusCode).toBe(200);
    const p = await h.project('lp/lapsed');
    await ingest(p, [gpl]);
    expect(await licenceIssues(p)).toEqual([['license:forbidden', 'open']]);

    now = AFTER_GRACE;
    expect(h.ctx.edition!.limits().licenses.policy).toBe(false);
    const res = await put(POLICY);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
    // The stored policy is kept and returned, but not applied.
    expect((await get()).json()).toMatchObject({ available: false, policy: POLICY });

    // The feature is off: the inventory without the package does not close the issue, and a
    // second forbidden package makes no new one.
    await ingest(p, []);
    await ingest(p, [gpl, { ...gpl, name: 'other-gpl', line: 16 }]);
    expect(await licenceIssues(p)).toEqual([['license:forbidden', 'open']]);
  });
});
