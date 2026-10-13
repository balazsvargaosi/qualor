import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  createProject,
  login,
  organizationId,
  type TestContext,
  createTestContext,
} from '../../test/app';
import { MIGRATIONS_DIR } from '../../test/paths';
import { readZip, type ZipEntry } from '../../test/zip';
import { VERSION } from '../index';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { analyses, jobs, scmConnections } from '../db/schema';
import { fixedEdition } from '../license/edition';
import { createScmRuntime } from '../scm/runtime';
import { SCM_TOKEN_AAD } from '../scm/connections';
import {
  collectSupportBundle,
  COMMAND_LOGS_NOTE,
  MAX_FAILED_ROWS,
  SUPPORT_BUNDLE_MAX_BYTES,
  UI_LOGS_NOTE,
  type SupportCollectDeps,
} from './collect';

const NOW = new Date('2026-10-14T08:09:10.000Z');

/** The top-level keys of every file of 4E-3b §1. */
const KEYS: Record<string, string[]> = {
  'manifest.json': ['format', 'generatedAt', 'notes', 'replica', 'sections', 'source'],
  'versions.json': [
    'arch',
    'container',
    'cpus',
    'database',
    'memory',
    'node',
    'platform',
    'plugins',
    'postgres',
    'server',
    'uptimeSeconds',
  ],
  'license.json': ['activeFeatures', 'edition', 'license', 'reason', 'source', 'state'],
  'plugins.json': ['plugins'],
  'migrations.json': ['applied', 'pending'],
  'config.json': ['database', 'values'],
  'settings.json': ['instanceSettings', 'ssoConnections'],
  'health.json': ['databaseBytes', 'largestTables', 'pool', 'readiness'],
  'jobs.json': ['counts', 'failed'],
  'analyses.json': ['failed'],
  'scm.json': ['connections'],
};

const json = (entries: ZipEntry[], name: string): Record<string, unknown> => {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no ${name} in the archive`);
  return JSON.parse(entry.data.toString('utf8')) as Record<string, unknown>;
};

function depsOf(ctx: TestContext, extra: Partial<SupportCollectDeps> = {}): SupportCollectDeps {
  return {
    db: ctx.db,
    config: ctx.config,
    edition: fixedEdition(),
    version: VERSION,
    migrationsDir: MIGRATIONS_DIR,
    ...extra,
  };
}

describe('collectSupportBundle: the files (4E-3b §1)', () => {
  let ctx: TestContext;
  let connectionId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    const [row] = await ctx.db
      .insert(scmConnections)
      .values({
        organizationId: await organizationId(ctx, 'default'),
        provider: 'gitlab',
        baseUrl: 'https://gitlab.example:8443/sub',
        tokenEnc: encryptSecret(
          encryptionKey(ctx.config.secretKey),
          'glpat-collect-token',
          SCM_TOKEN_AAD,
        ),
      })
      .returning({ id: scmConnections.id });
    connectionId = row!.id;
  });
  afterAll(async () => ctx.close());

  it('writes every file with its keys, the log lines and the replica note (UI)', async () => {
    const runtime = createScmRuntime();
    for (let i = 0; i < 5; i++) runtime.circuit.failure(connectionId);
    runtime.health.record(connectionId, 'GitLab answered 502 for glpat-collect-token');
    const bundle = await collectSupportBundle(depsOf(ctx, { scmRuntime: runtime }), {
      source: 'ui',
      logs: ['{"level":30,"msg":"first"}', '{"level":40,"msg":"second"}'],
      now: NOW,
    });
    expect(bundle.fileName).toBe('qualor-support-20261014-080910.zip');
    expect(bundle.data.length).toBeLessThanOrEqual(SUPPORT_BUNDLE_MAX_BYTES);
    const entries = readZip(bundle.data);
    expect(entries.map((e) => e.name)).toEqual([...Object.keys(KEYS), 'logs.jsonl']);
    for (const [name, keys] of Object.entries(KEYS)) {
      expect(Object.keys(json(entries, name)).sort(), name).toEqual(keys);
      expect(json(entries, name), name).not.toHaveProperty('error');
    }
    expect(json(entries, 'manifest.json')).toMatchObject({
      format: 1,
      generatedAt: NOW.toISOString(),
      source: 'ui',
      sections: [...Object.keys(KEYS).slice(1), 'logs.jsonl'],
      notes: [UI_LOGS_NOTE],
    });
    expect(bundle.notes).toEqual([UI_LOGS_NOTE]);
    expect(entries.at(-1)?.data.toString('utf8')).toBe(
      '{"level":30,"msg":"first"}\n{"level":40,"msg":"second"}\n',
    );
    expect(json(entries, 'versions.json')).toMatchObject({
      server: VERSION,
      node: process.version,
      database: 'external',
      postgres: expect.stringMatching(/^\d+/),
    });
    expect(json(entries, 'license.json')).toMatchObject({
      edition: 'community',
      state: 'none',
      license: null,
      activeFeatures: [],
    });
    const migrations = json(entries, 'migrations.json') as {
      applied: { name: string; time: string }[];
      pending: number;
    };
    expect(migrations.pending).toBe(0);
    expect(migrations.applied[0]?.name).toBe('0000_extensions');
    const health = json(entries, 'health.json') as {
      readiness: unknown;
      pool: unknown;
      largestTables: unknown[];
    };
    expect(health.readiness).toMatchObject({ database: true, pendingMigrations: 0, ready: true });
    expect(health.pool).toMatchObject({ total: expect.any(Number) });
    expect(health.largestTables.length).toBeGreaterThan(0);
    expect(health.largestTables.length).toBeLessThanOrEqual(15);
    expect(json(entries, 'scm.json')).toEqual({
      connections: [
        {
          id: connectionId,
          provider: 'gitlab',
          host: 'https://gitlab.example:8443',
          status: 'failing',
          circuit: { state: 'open', failures: 5, openedAt: expect.any(String) },
          lastError: 'GitLab answered 502 for [redacted]',
        },
      ],
    });
  });

  it('writes no logs.jsonl and says how to add them for the command', async () => {
    const bundle = await collectSupportBundle(depsOf(ctx), { source: 'command', now: NOW });
    const entries = readZip(bundle.data);
    expect(entries.map((e) => e.name)).toEqual(Object.keys(KEYS));
    const manifest = json(entries, 'manifest.json') as { source: string; notes: string[] };
    expect(manifest.source).toBe('command');
    expect(manifest.notes[0]).toBe(COMMAND_LOGS_NOTE);
    expect(manifest.notes[0]).toBe('no logs: add `docker logs --tail 5000 <container>`');
    expect(manifest.notes[1]).toMatch(/^scm\.json: no circuit state/);
    expect(json(entries, 'scm.json')).toMatchObject({
      connections: [{ id: connectionId, status: 'unknown', circuit: null, lastError: null }],
    });
  });

  it('holds a section that fails as its error and writes the others', async () => {
    const bundle = await collectSupportBundle(depsOf(ctx, { migrationsDir: 'Z:/no/such/dir' }), {
      source: 'command',
      now: NOW,
    });
    const entries = readZip(bundle.data);
    expect(json(entries, 'migrations.json')).toEqual({ error: expect.stringMatching(/ENOENT/) });
    expect(bundle.notes).toContain('migrations.json: could not be collected');
    expect(json(entries, 'jobs.json')).toHaveProperty('counts');
  });
});

describe('collectSupportBundle: the size cap (4E-3b §1, Review Focus 5)', () => {
  let ctx: TestContext;
  const logs = Array.from(
    { length: 1_000 },
    (_, i) => `{"level":30,"n":${i},"msg":"${'x'.repeat(200)}"}`,
  );

  beforeAll(async () => {
    ctx = await createTestContext();
    const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const project = await createProject(ctx, admin, {
      organizationId: await organizationId(ctx, 'default'),
      key: 'size-app',
    });
    const base = Date.parse('2026-10-01T00:00:00Z');
    await ctx.db.insert(jobs).values(
      Array.from({ length: 60 }, (_, i) => ({
        queue: 'analysis',
        payload: { secretPayload: 'never in the bundle' },
        status: 'dead' as const,
        attempts: 5,
        lastError: `job ${i} failed: ${'e'.repeat(600)}`,
        createdAt: new Date(base + i * 1_000),
        updatedAt: new Date(base + i * 1_000),
      })),
    );
    await ctx.db.insert(analyses).values(
      Array.from({ length: 60 }, (_, i) => ({
        projectId: project.id,
        status: 'failed' as const,
        error: { code: 'REPORT_INVALID', message: `analysis ${i}: ${'m'.repeat(600)}` },
        createdAt: new Date(base + i * 1_000),
      })),
    );
  });
  afterAll(async () => ctx.close());

  const collect = (maxBytes: number) =>
    collectSupportBundle(depsOf(ctx, { scmRuntime: createScmRuntime() }), {
      source: 'ui',
      logs,
      now: NOW,
      maxBytes,
    });

  it('lists the newest 50 failed jobs and analyses, cut to 500 characters, without payloads', async () => {
    const entries = readZip((await collect(SUPPORT_BUNDLE_MAX_BYTES)).data);
    const failedJobs = json(entries, 'jobs.json').failed as { lastError: string }[];
    expect(failedJobs).toHaveLength(MAX_FAILED_ROWS);
    expect(failedJobs[0]?.lastError).toMatch(/^job 59 failed/);
    expect(failedJobs[0]?.lastError).toHaveLength(500);
    expect(failedJobs[0]).toEqual({
      queue: 'analysis',
      status: 'dead',
      attempts: 5,
      maxAttempts: 5,
      createdAt: '2026-10-01T00:00:59.000Z',
      finishedAt: '2026-10-01T00:00:59.000Z',
      lastError: expect.any(String),
    });
    expect(json(entries, 'jobs.json').counts).toEqual([
      { queue: 'analysis', status: 'dead', count: 60 },
    ]);
    const failedAnalyses = json(entries, 'analyses.json').failed as {
      projectKey: string;
      error: { code: string; message: string };
    }[];
    expect(failedAnalyses).toHaveLength(MAX_FAILED_ROWS);
    expect(failedAnalyses[0]).toMatchObject({
      projectKey: 'size-app',
      branch: null,
      createdAt: '2026-10-01T00:00:59.000Z',
      error: { code: 'REPORT_INVALID' },
    });
    expect(failedAnalyses[0]?.error.message).toHaveLength(500);
    for (const entry of entries) expect(entry.data.toString()).not.toContain('secretPayload');
  });

  it('trims the oldest log lines first, then jobs, then analyses, and says so', async () => {
    const full = await collect(SUPPORT_BUNDLE_MAX_BYTES);
    const entries = readZip(full.data);
    const sizeOf = (name: string) => entries.find((e) => e.name === name)!.data.length;
    const withoutFailed = (name: string) =>
      Buffer.byteLength(`${JSON.stringify({ ...json(entries, name), failed: [] }, null, 2)}\n`);
    const logBytes = sizeOf('logs.jsonl');
    const jobBytes = sizeOf('jobs.json') - withoutFailed('jobs.json');
    const analysisBytes = sizeOf('analyses.json') - withoutFailed('analyses.json');

    // Logs only: the newest lines stay.
    let cap = full.data.length - Math.floor(logBytes / 2);
    let bundle = await collect(cap);
    expect(bundle.data.length).toBeLessThanOrEqual(cap);
    let got = readZip(bundle.data);
    const lines = got
      .find((e) => e.name === 'logs.jsonl')!
      .data.toString()
      .trimEnd()
      .split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(logs.length);
    expect(lines.at(-1)).toBe(logs.at(-1));
    expect(lines[0]).toBe(logs[logs.length - lines.length]);
    expect(json(got, 'jobs.json').failed).toHaveLength(MAX_FAILED_ROWS);
    expect(bundle.notes).toEqual([
      UI_LOGS_NOTE,
      `logs trimmed: the ${logs.length - lines.length} oldest lines were dropped to stay under ${cap} bytes`,
    ]);
    expect((json(got, 'manifest.json') as { notes: string[] }).notes).toEqual(bundle.notes);

    // Then jobs: every log line is gone, the newest jobs stay.
    cap = full.data.length - logBytes - Math.floor(jobBytes / 2);
    bundle = await collect(cap);
    expect(bundle.data.length).toBeLessThanOrEqual(cap);
    got = readZip(bundle.data);
    expect(got.find((e) => e.name === 'logs.jsonl')!.data.length).toBe(0);
    const keptJobs = json(got, 'jobs.json').failed as { lastError: string }[];
    expect(keptJobs.length).toBeGreaterThan(0);
    expect(keptJobs.length).toBeLessThan(MAX_FAILED_ROWS);
    expect(keptJobs[0]?.lastError).toMatch(/^job 59 failed/);
    expect(json(got, 'analyses.json').failed).toHaveLength(MAX_FAILED_ROWS);
    expect(bundle.notes.map((n) => n.split(':')[0])).toEqual([
      UI_LOGS_NOTE,
      'logs trimmed',
      'jobs trimmed',
    ]);

    // Then analyses.
    cap = full.data.length - logBytes - jobBytes - Math.floor(analysisBytes / 2);
    bundle = await collect(cap);
    expect(bundle.data.length).toBeLessThanOrEqual(cap);
    got = readZip(bundle.data);
    expect(json(got, 'jobs.json').failed).toEqual([]);
    const keptAnalyses = json(got, 'analyses.json').failed as { error: { message: string } }[];
    expect(keptAnalyses.length).toBeGreaterThan(0);
    expect(keptAnalyses.length).toBeLessThan(MAX_FAILED_ROWS);
    expect(keptAnalyses[0]?.error.message).toMatch(/^analysis 59:/);
    expect(bundle.notes.map((n) => n.split(':')[0])).toEqual([
      UI_LOGS_NOTE,
      'logs trimmed',
      'jobs trimmed',
      'analyses trimmed',
    ]);
  });

  it('writes what is left, and says so, when nothing more can be trimmed', async () => {
    const bundle = await collect(1_000);
    const got = readZip(bundle.data);
    expect(json(got, 'analyses.json').failed).toEqual([]);
    expect(bundle.notes.at(-1)).toBe('nothing left to trim: the archive is over 1000 bytes');
  });
});
