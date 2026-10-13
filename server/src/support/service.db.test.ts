import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createProject,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { MIGRATIONS_DIR } from '../../test/paths';
import { rbacContext } from '../../test/rbac';
import { readZip, type ZipEntry } from '../../test/zip';
import { AUDIT_STREAM_SECRET_AAD, writeSetting } from '../audit/settings';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import {
  analyses,
  auditEvents,
  jobs,
  scmConnections,
  ssoConnections,
  webhookSubscriptions,
} from '../db/schema';
import { LogBuffer } from '../http/log-buffer';
import { createLogger } from '../http/logger';
import { LICENSE_SETTING_KEY } from '../license/source';
import { DEFAULT_LLM_SETTINGS, LLM_API_KEY_AAD, writeLlmSettings } from '../llm/settings';
import type { QualorPlugin } from '../plugins/contract';
import { SCM_TOKEN_AAD } from '../scm/connections';
import { encryptPrivateKey, encryptWebhookSecret } from '../scm/github/credentials';
import { createScmRuntime } from '../scm/runtime';
import { SECRET_AAD } from '../sso/connection-config';
import { WEBHOOK_SECRET_AAD } from '../webhooks/deliveries';

const LICENSED = new Date('2027-01-01T00:00:00Z');

/** Distinctive values for every kind of secret the server holds (Review Focus 3). */
const SECRET_KEY = 'QsK-7f3a9c1e5b2d4f6a8c0e2b4d6f8a1c3e5';
const DB_PASSWORD = 'DbPw-9a8b7c6d5e4f';
const BOOTSTRAP_PASSWORD = 'Boot-pw-31415926535';
const LLM_KEY = 'sk-llm-27182818284590';
const WEBHOOK_SECRET = 'whsec-16180339887498';
const SSO_SECRET = 'oidc-cs-14142135623730';
const SCM_TOKEN = 'glpat-17320508075688';
const GITHUB_WEBHOOK_SECRET = 'ghwh-22360679774997aa';
const AUDIT_STREAM_SECRET = 'siem-26457513110645';
const LICENSE_TEXT =
  'QLK1.test-a.eyJMaWNlbnNlUGF5bG9hZFNlY3JldCI6MX0.U2lnbmF0dXJlU2VjcmV0VmFsdWVYWVo';
const STORED_LICENSE = 'QLK1.test-a.U3RvcmVkUGF5bG9hZFNlY3JldDEyMw.U3RvcmVkU2lnbmF0dXJlNDU2';
const GITHUB_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const GITHUB_KEY_LINES = GITHUB_KEY.split('\n').filter((l) => l !== '' && !l.startsWith('-----'));

const PLANTED = [
  SECRET_KEY,
  DB_PASSWORD,
  BOOTSTRAP_PASSWORD,
  LLM_KEY,
  WEBHOOK_SECRET,
  SSO_SECRET,
  SCM_TOKEN,
  GITHUB_WEBHOOK_SECRET,
  AUDIT_STREAM_SECRET,
  LICENSE_TEXT,
  STORED_LICENSE,
  ...LICENSE_TEXT.split('.').slice(2),
  ...STORED_LICENSE.split('.').slice(2),
  GITHUB_KEY,
  GITHUB_KEY_LINES.join(''),
  ...GITHUB_KEY_LINES.filter((l) => l.length >= 16),
];

/** Every spelling a planted value must not have in the archive. */
function forms(secret: string): string[] {
  const b64 = Buffer.from(secret).toString('base64');
  return [
    secret,
    b64,
    b64.replace(/=+$/, ''),
    Buffer.from(secret).toString('base64url'),
    encodeURIComponent(secret),
  ];
}

const FIXTURE: QualorPlugin = {
  name: 'support-fixture',
  apiVersion: 1,
  features: ['audit-log', 'support-bundle'],
  register(ctx) {
    // Under audit-log, so the service's own feature check answers when support-bundle is off.
    ctx.routes('audit-log', async (app) => {
      app.get('/t/support', async (request, reply) => {
        const { fileName, stream } = await ctx.support.bundle(request);
        return reply
          .type('application/zip')
          .header('content-disposition', `attachment; filename=${fileName}`)
          .send(stream);
      });
    });
  },
};

const download = (ctx: TestContext, session: Session) =>
  ctx.app.inject({ method: 'GET', url: '/api/v0/ee/t/support', headers: session.headers });

const fileOf = (entries: ZipEntry[], name: string): string => {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no ${name}`);
  return entry.data.toString('utf8');
};

describe('ctx.support (4E-3b §2, §4)', () => {
  let ctx: TestContext;
  let admin: Session;
  let member: Session;
  const buffer = new LogBuffer();
  const runtime = createScmRuntime();

  beforeAll(async () => {
    ctx = await rbacContext({
      now: () => LICENSED,
      features: ['audit-log', 'support-bundle'],
      plugin: FIXTURE,
      support: { migrationsDir: MIGRATIONS_DIR, logBuffer: buffer, scmRuntime: runtime },
      config: {
        secretKey: SECRET_KEY,
        databaseUrl: `postgres://qualor:${DB_PASSWORD}@db.internal:5432/qualor?sslmode=require`,
        bootstrapAdmin: { username: 'admin', password: BOOTSTRAP_PASSWORD },
        license: { text: LICENSE_TEXT, file: null },
      },
    });
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const plain = await createUser(ctx, { username: 'support-member' });
    member = await login(ctx, plain.username, plain.password);

    const key = encryptionKey(SECRET_KEY);
    const org = await organizationId(ctx, 'default');
    await writeLlmSettings(ctx.db, {
      ...DEFAULT_LLM_SETTINGS,
      provider: {
        kind: 'openai',
        baseUrl: 'https://llm.example/v1',
        model: 'gpt-test',
        auth: 'bearer',
        jsonMode: 'json_object',
        maxTokensField: 'max_tokens',
        temperature: null,
        timeoutSeconds: 60,
        apiKeyEnc: encryptSecret(key, LLM_KEY, LLM_API_KEY_AAD),
      },
    });
    await writeSetting(ctx.db, 'audit', {
      retentionDays: 365,
      stream: {
        url: 'https://siem.example/in',
        active: true,
        secretEnc: encryptSecret(key, AUDIT_STREAM_SECRET, AUDIT_STREAM_SECRET_AAD),
      },
    });
    await writeSetting(ctx.db, LICENSE_SETTING_KEY, {
      key: STORED_LICENSE,
      savedAt: '2026-10-01T00:00:00Z',
      savedBy: 'admin',
    });
    await ctx.db.insert(webhookSubscriptions).values({
      organizationId: org,
      url: 'https://hooks.example/in',
      secretEnc: encryptSecret(key, WEBHOOK_SECRET, WEBHOOK_SECRET_AAD),
      events: ['analysis.completed'],
    });
    await ctx.db.insert(ssoConnections).values({
      name: 'Acme IdP',
      protocol: 'oidc',
      config: { issuer: 'https://idp.example/realms/acme', clientId: 'qualor' },
      secretEnc: encryptSecret(key, SSO_SECRET, SECRET_AAD),
    });
    const [gitlab] = await ctx.db
      .insert(scmConnections)
      .values({
        organizationId: org,
        provider: 'gitlab',
        baseUrl: 'https://gitlab.example',
        tokenEnc: encryptSecret(key, SCM_TOKEN, SCM_TOKEN_AAD),
      })
      .returning({ id: scmConnections.id });
    await ctx.db.insert(scmConnections).values({
      organizationId: org,
      provider: 'github',
      baseUrl: 'https://api.github.com',
      appId: '12345',
      tokenEnc: encryptPrivateKey(key, GITHUB_KEY),
      webhookSecretEnc: encryptWebhookSecret(key, GITHUB_WEBHOOK_SECRET),
    });

    // Secrets where only the bundle's own redaction catches them: a log field the logger does not
    // redact, an analysis error, a job error and an SCM error.
    const logger = createLogger('info', { write: () => {} }, buffer);
    logger.info(
      { detail: `git clone failed for ${SCM_TOKEN}` },
      `calling the model with ${LLM_KEY}`,
    );
    logger.warn({ url: `postgres://qualor:${DB_PASSWORD}@db.internal/qualor` }, 'reconnecting');
    const project = await createProject(ctx, admin, { organizationId: org, key: 'secret-app' });
    await ctx.db.insert(analyses).values({
      projectId: project.id,
      status: 'failed',
      error: { code: 'SCM_FAILED', message: `webhook signed with ${WEBHOOK_SECRET} was refused` },
    });
    await ctx.db.insert(jobs).values({
      queue: 'scm',
      payload: { token: SCM_TOKEN },
      status: 'dead',
      lastError: `IdP refused client secret ${SSO_SECRET}; Authorization: Bearer ${SECRET_KEY}`,
    });
    runtime.health.record(gitlab!.id, `GitHub refused ${GITHUB_WEBHOOK_SECRET}`);
  });
  afterAll(async () => ctx.close());

  it('gives an instance admin a zip with no planted secret in any spelling, and records it', async () => {
    const res = await download(ctx, admin);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename=qualor-support-\d{8}-\d{6}\.zip$/,
    );
    const archive = res.rawPayload;
    const entries = readZip(archive);
    expect(entries.map((e) => e.name)).toContain('logs.jsonl');
    for (const secret of PLANTED) {
      for (const form of forms(secret)) {
        expect(archive.includes(form), `the archive holds ${form.slice(0, 24)}…`).toBe(false);
        for (const entry of entries) {
          expect(entry.data.includes(form), `${entry.name} holds ${form.slice(0, 24)}…`).toBe(
            false,
          );
        }
      }
    }

    // The texts are still there, with the values replaced.
    const logs = fileOf(entries, 'logs.jsonl').trimEnd().split('\n');
    const planted = logs.slice(-2).map((line) => JSON.parse(line) as Record<string, string>);
    expect(planted[0]).toMatchObject({
      msg: 'calling the model with [redacted]',
      detail: 'git clone failed for [redacted]',
    });
    expect(planted[1]).toMatchObject({
      url: 'postgres://[redacted]@db.internal/qualor',
    });
    const analysesFile = JSON.parse(fileOf(entries, 'analyses.json')) as {
      failed: { error: { message: string } }[];
    };
    expect(analysesFile.failed[0]?.error.message).toBe(
      'webhook signed with [redacted] was refused',
    );
    const jobsFile = JSON.parse(fileOf(entries, 'jobs.json')) as {
      failed: { lastError: string }[];
    };
    expect(jobsFile.failed[0]?.lastError).toBe(
      'IdP refused client secret [redacted]; Authorization: Bearer [redacted]',
    );
    const scm = JSON.parse(fileOf(entries, 'scm.json')) as {
      connections: { provider: string; lastError: string | null }[];
    };
    expect(scm.connections.find((c) => c.provider === 'gitlab')?.lastError).toBe(
      'GitHub refused [redacted]',
    );

    // The allowlists: hosts and kinds only.
    const settings = JSON.parse(fileOf(entries, 'settings.json')) as {
      instanceSettings: Record<string, Record<string, unknown>>;
      ssoConnections: unknown[];
    };
    expect(settings.instanceSettings.llm?.provider).toMatchObject({
      kind: 'openai',
      baseUrl: 'https://llm.example',
      model: 'gpt-test',
      apiKeyEnc: '[set]',
    });
    expect(settings.instanceSettings.license).toEqual({
      key: '[set]',
      savedAt: '2026-10-01T00:00:00Z',
      savedBy: 'admin',
    });
    expect(settings.ssoConnections).toEqual([
      { protocol: 'oidc', enabled: false, issuerHost: 'https://idp.example' },
    ]);
    const config = JSON.parse(fileOf(entries, 'config.json')) as {
      database: string;
      values: Record<string, unknown>;
    };
    expect(config.database).toBe('external');
    expect(config.values).toMatchObject({
      databaseUrl: 'postgres://db.internal:5432',
      secretKey: '[set]',
      license: { text: '[set]', file: null },
    });
    const license = JSON.parse(fileOf(entries, 'license.json')) as Record<string, unknown>;
    expect(license).toMatchObject({
      state: 'active',
      activeFeatures: ['audit-log', 'support-bundle'],
      license: { customer: 'Acme Corporation', features: ['audit-log', 'support-bundle'] },
    });

    const events = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'support.bundle_downloaded'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUsername: 'admin',
      targetType: null,
      targetId: null,
      details: { source: 'ui', bytes: archive.length },
    });
  });

  it('refuses a user who is not an instance admin with 403, recording nothing', async () => {
    const before = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'support.bundle_downloaded'));
    const res = await download(ctx, member);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN', title: 'Instance administrators only' });
    const after = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'support.bundle_downloaded'));
    expect(after).toHaveLength(before.length);
  });
});

describe('ctx.support without the support-bundle feature', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await rbacContext({
      now: () => LICENSED,
      features: ['audit-log'],
      plugin: FIXTURE,
      support: { migrationsDir: MIGRATIONS_DIR },
    });
  });
  afterAll(async () => ctx.close());

  it('answers 403 FEATURE_NOT_LICENSED, even to an instance admin, recording nothing', async () => {
    const res = await download(ctx, await login(ctx, 'admin', ADMIN_PASSWORD));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
    const events = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'support.bundle_downloaded'));
    expect(events).toEqual([]);
  });
});
