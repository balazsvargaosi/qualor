// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createProject,
  createTestContext,
  login,
  organizationId as organizationIdOf,
  type Session,
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
import { LICENSE_EXPIRES } from '../../server/test/rbac';
import { createAuditRecorder } from '../../server/src/audit/recorder';
import { createEdition, type Edition } from '../../server/src/license/edition';
import { licenseState } from '../../server/src/license/state';
import { verifyLicenseKey } from '../../server/src/license/verify';
import { communityLimits } from '../../server/src/limits';
import {
  DEFAULT_AUTO_FIX,
  DEFAULT_LLM_SETTINGS,
  writeLlmSettings,
  type StoredProvider,
} from '../../server/src/llm/settings';
import { loadPlugins } from '../../server/src/plugins/loader';
import { dropPluginsThatFailToMount } from '../../server/src/plugins/mount';
import { createPluginServices } from '../../server/src/plugins/services';
import { defaultReview } from '../../server/src/review/settings';
import { buildEnterprise } from '../scripts/bundle';

// Under enterprise/, so the bundle resolves its external packages from enterprise/node_modules.
const OUT = fileURLToPath(new URL('../.tmp/auto-fix-test/plugin.js', import.meta.url));
const LICENSED = new Date('2027-01-01T00:00:00Z');

const PROVIDER: StoredProvider = {
  kind: 'openai',
  baseUrl: 'https://llm.example/v1',
  model: 'fake-model',
  strongModel: null,
  fastModel: null,
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_tokens',
  temperature: null,
  api: 'chat_completions',
  workspaceId: null,
  timeoutSeconds: 5,
  apiKeyEnc: null,
};

function quietLogger(): never {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l as never;
}

/** The built plugin through the real loader, under a signed key listing `features`. */
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

describe('Qualor Enterprise: the llm.auto-fix feature through the built plugin (4E-3a §2)', () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  /** Boots under `features`; returns the admin session, the organisation and a project. */
  async function boot(features: readonly string[]) {
    ctx = await bootEnterpriseTest(features);
    const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const org = await organizationIdOf(ctx, 'default');
    const project = await createProject(ctx, admin, { organizationId: org, key: 'af/one' });
    // The AI assistant configured and the organisation's fix suggestions on, as the routes need.
    await writeLlmSettings(ctx.db, {
      ...DEFAULT_LLM_SETTINGS,
      provider: PROVIDER,
      organizations: {
        [org]: {
          enabled: true,
          features: { explain: true, triage: false, fix: true },
          excludedProjectIds: [],
          autoFix: { ...DEFAULT_AUTO_FIX },
          autoFixDisabledProjectIds: [],
          review: defaultReview(),
        },
      },
    });
    return { admin, org, project };
  }
  const put = (admin: Session, url: string, payload: object) =>
    ctx!.app.inject({ method: 'PUT', url: `/api/v0${url}`, headers: admin.headers, payload });
  const getOrg = (admin: Session, org: string) =>
    ctx!.app.inject({
      method: 'GET',
      url: `/api/v0/organizations/${org}/ai/auto-fix`,
      headers: admin.headers,
    });
  const on = { enabled: true, minSeverity: 'medium', maxPerAnalysis: 5 };

  it('an Enterprise key turns the seam on and enables the routes', async () => {
    const { admin, org, project } = await boot(ENTERPRISE_FEATURES);
    expect(ctx!.edition!.activeFeatures()).toContain('llm.auto-fix');
    expect(ctx!.edition!.limits().llm).toEqual({ automaticFixSuggestions: true });
    expect((await getOrg(admin, org)).json()).toMatchObject({ available: true, enabled: false });
    const saved = await put(admin, `/organizations/${org}/ai/auto-fix`, on);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ available: true, ...on });
    const optOut = await put(admin, `/projects/${project.id}/ai/auto-fix`, { enabled: false });
    expect(optOut.statusCode, optOut.body).toBe(200);
    expect(optOut.json()).toEqual({ available: true, enabled: false });
  });

  it('a Business key keeps the seam off and the routes answer 403', async () => {
    const { admin, org, project } = await boot(BUSINESS_FEATURES);
    expect(ctx!.edition!.activeFeatures()).not.toContain('llm.auto-fix');
    expect(ctx!.edition!.limits().llm.automaticFixSuggestions).toBe(false);
    expect((await getOrg(admin, org)).json()).toMatchObject({ available: false, enabled: false });
    for (const [url, payload] of [
      [`/organizations/${org}/ai/auto-fix`, on],
      [`/projects/${project.id}/ai/auto-fix`, { enabled: false }],
    ] as const) {
      const res = await put(admin, url, payload);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
    }
  });

  it('a licence listing llm.fix-quota still applies and changes nothing (D10); llm.auto-fix lifts only its own limit', async () => {
    // The name stays licensed and implemented, so the key is active; no limit follows from it.
    await boot(['llm.fix-quota']);
    expect(ctx!.edition!.activeFeatures()).toEqual(['llm.fix-quota']);
    expect(ctx!.edition!.limits()).toEqual(communityLimits());
    await ctx!.close();
    await boot(['llm.auto-fix']);
    expect(ctx!.edition!.limits().llm).toEqual({ automaticFixSuggestions: true });
  });
});
