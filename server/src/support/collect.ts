import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism, hostname } from 'node:os';
import { join } from 'node:path';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { pgErrorCode } from '../db/errors';
import { pendingMigrations } from '../db/migrate';
import {
  analyses,
  branches,
  instanceSettings,
  jobs,
  projects,
  scmConnections,
  ssoConnections,
} from '../db/schema';
import type { Edition } from '../license/edition';
import { PLUGIN_API_VERSION } from '../plugins/contract';
import type { ScmRuntime } from '../scm/runtime';
import { allowlistedConfig, allowlistedSetting, urlHost } from './allowlist';
import { cleanErrorText, cleanLogLine, configuredSecrets, createRedactor } from './secrets';
import { zipStore } from './zip';

/** 4E-3b §1: the archive is at most this large; logs, then jobs, then analyses are trimmed. */
export const SUPPORT_BUNDLE_MAX_BYTES = 20 * 1024 * 1024;
export const SUPPORT_BUNDLE_FORMAT = 1;
/** 4E-3b §1: the failed jobs and failed analyses listed, the newest first. */
export const MAX_FAILED_ROWS = 50;
/** 4E-3b §1: the tables whose estimated row counts health.json lists, the largest first. */
export const LARGEST_TABLES = 15;

export const UI_LOGS_NOTE = 'logs come from this replica only';
export const COMMAND_LOGS_NOTE = 'no logs: add `docker logs --tail 5000 <container>`';
const NO_SCM_WORKER_NOTE =
  'scm.json: no circuit state or last error, because no SCM worker runs in this process';

/** What the collector reads. It needs no HTTP request and no actor (the command has neither). */
export interface SupportCollectDeps {
  db: Db;
  config: Config;
  edition: Pick<Edition, 'state' | 'edition' | 'activeFeatures' | 'plugins' | 'bootSource'>;
  /** The server's version. */
  version: string;
  /** The server's migrations folder (`drizzle/`), for the pending count; null when unknown. */
  migrationsDir: string | null;
  /** The SCM worker's runtime in this process, for the circuits; none in the command. */
  scmRuntime?: Pick<ScmRuntime, 'circuit' | 'health'> | undefined;
}

export interface SupportBundleOptions {
  source: 'ui' | 'command';
  /** The log ring buffer's lines, oldest first; absent, the archive has no `logs.jsonl`. */
  logs?: readonly string[];
  maxBytes?: number;
  now?: Date;
}

export interface SupportBundle {
  fileName: string;
  data: Buffer;
  notes: string[];
}

interface SectionContext {
  deps: SupportCollectDeps;
  /** An error text: configured secrets redacted, credentials dropped, at most 500 characters. */
  clean: (text: string) => string;
}

type Json = unknown;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const databaseKind = (config: Config): 'embedded' | 'external' =>
  config.databaseUrl === null ? 'embedded' : 'external';

/** An error as text, never a query or its parameters (the logger's rule, http/logger.ts). */
function describeError(err: unknown): string {
  if (err instanceof Error && ('query' in err || 'params' in err)) {
    const code = pgErrorCode(err);
    return `${err.constructor.name}: database query failed${code ? ` (${code})` : ''}`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function inContainer(): Promise<boolean> {
  if (existsSync('/.dockerenv')) return true;
  try {
    const cgroup = await readFile('/proc/1/cgroup', 'utf8');
    return /docker|kubepods|containerd|libpod/.test(cgroup);
  } catch {
    return false;
  }
}

/** `versions.json`. */
async function versionsSection({ deps }: SectionContext): Promise<Json> {
  const pg = await deps.db.execute<{ server_version: string }>(sql`SHOW server_version`);
  return {
    server: deps.version,
    plugins: deps.edition.plugins().map((p) => ({
      name: p.name,
      state: p.state,
      contractVersion: PLUGIN_API_VERSION,
    })),
    node: process.version,
    postgres: pg.rows[0]?.server_version ?? null,
    database: databaseKind(deps.config),
    platform: process.platform,
    arch: process.arch,
    container: await inContainer(),
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    cpus: availableParallelism(),
  };
}

/** `license.json`: the state and the payload's fields, never the key text. */
async function licenseSection({ deps }: SectionContext): Promise<Json> {
  const state = deps.edition.state();
  const license = state.license;
  return {
    edition: deps.edition.edition(),
    state: state.state,
    reason: state.reason,
    source: deps.edition.bootSource,
    license: license
      ? {
          id: license.id,
          customer: license.customer,
          issued: license.issued,
          expires: license.expires,
          graceEndsAt: iso(state.graceEndsAt),
          features: [...license.features],
        }
      : null,
    activeFeatures: deps.edition.activeFeatures(),
  };
}

/** `plugins.json`: the plugin reports. */
async function pluginsSection({ deps, clean }: SectionContext): Promise<Json> {
  return {
    plugins: deps.edition.plugins().map((p) => ({
      name: p.name,
      state: p.state,
      features: [...p.features],
      error: p.error === null ? null : clean(p.error),
    })),
  };
}

/** `migrations.json`: drizzle keeps each migration's own timestamp, not the time it was applied. */
async function migrationsSection({ deps }: SectionContext): Promise<Json> {
  const tags = new Map<number, string>();
  if (deps.migrationsDir !== null) {
    try {
      const journal = JSON.parse(
        await readFile(join(deps.migrationsDir, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { tag: string; when: number }[] };
      for (const entry of journal.entries) tags.set(entry.when, entry.tag);
    } catch {
      // No journal: the hashes name the migrations.
    }
  }
  let rows: { hash: string; created_at: string | number }[] = [];
  try {
    const result = await deps.db.execute<{ hash: string; created_at: string | number }>(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id`,
    );
    rows = result.rows;
  } catch (err) {
    // 42P01 undefined_table, 3F000 invalid_schema_name: nothing applied yet.
    const code = pgErrorCode(err);
    if (code !== '42P01' && code !== '3F000') throw err;
  }
  return {
    applied: rows.map((row) => {
      const when = Number(row.created_at);
      return {
        name: tags.get(when) ?? `hash ${row.hash.slice(0, 12)}`,
        time: Number.isFinite(when) ? new Date(when).toISOString() : null,
      };
    }),
    pending:
      deps.migrationsDir === null ? null : await pendingMigrations(deps.db, deps.migrationsDir),
  };
}

/** `config.json`: the effective configuration through the allowlist (4E-3b §2). */
async function configSection({ deps, clean }: SectionContext): Promise<Json> {
  return { database: databaseKind(deps.config), values: allowlistedConfig(deps.config, clean) };
}

/** `settings.json`: every `instance_settings` row through its allowlist, and the SSO connections. */
async function settingsSection({ deps, clean }: SectionContext): Promise<Json> {
  const rows = await deps.db
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings)
    .orderBy(sql`${instanceSettings.key} COLLATE "C"`);
  const sso = await deps.db
    .select({
      protocol: ssoConnections.protocol,
      enabled: ssoConnections.enabled,
      config: ssoConnections.config,
    })
    .from(ssoConnections)
    .orderBy(asc(ssoConnections.id));
  return {
    instanceSettings: Object.fromEntries(
      rows.map((row) => [row.key, allowlistedSetting(row.key, row.value, clean)]),
    ),
    // 4E-3b §2: the connection types and the issuer hosts only.
    ssoConnections: sso.map((row) => {
      const config = (row.config ?? {}) as { issuer?: unknown; idpSsoUrl?: unknown };
      const issuer = row.protocol === 'oidc' ? config.issuer : config.idpSsoUrl;
      return {
        protocol: row.protocol,
        enabled: row.enabled,
        issuerHost: typeof issuer === 'string' ? urlHost(issuer) : null,
      };
    }),
  };
}

function poolCounts(db: Db): { total: number; idle: number; waiting: number } | null {
  const pool = (db as unknown as { $client?: Record<string, unknown> }).$client;
  const { totalCount, idleCount, waitingCount } = pool ?? {};
  return typeof totalCount === 'number' &&
    typeof idleCount === 'number' &&
    typeof waitingCount === 'number'
    ? { total: totalCount, idle: idleCount, waiting: waitingCount }
    : null;
}

/** `health.json`: readiness, the pool, the database size and the largest tables. */
async function healthSection({ deps }: SectionContext): Promise<Json> {
  const { db } = deps;
  const started = performance.now();
  await db.execute(sql`SELECT 1`);
  const latencyMs = Math.round(performance.now() - started);
  const pending =
    deps.migrationsDir === null ? null : await pendingMigrations(db, deps.migrationsDir);
  const size = await db.execute<{ bytes: string }>(
    sql`SELECT pg_database_size(current_database())::text AS bytes`,
  );
  const tables = await db.execute<{ name: string; rows: string; bytes: string }>(sql`
    SELECT c.relname AS name, c.reltuples::bigint::text AS rows,
           pg_total_relation_size(c.oid)::text AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
    ORDER BY pg_total_relation_size(c.oid) DESC, c.relname COLLATE "C"
    LIMIT ${LARGEST_TABLES}`);
  return {
    readiness: {
      database: true,
      latencyMs,
      pendingMigrations: pending,
      ready: pending === null ? null : pending === 0,
    },
    pool: poolCounts(db),
    databaseBytes: Number(size.rows[0]?.bytes ?? 0),
    largestTables: tables.rows.map((t) => ({
      name: t.name,
      // -1: never analysed or vacuumed, so PostgreSQL has no estimate.
      estimatedRows: Number(t.rows) < 0 ? null : Number(t.rows),
      bytes: Number(t.bytes),
    })),
  };
}

interface JobsSection {
  counts: { queue: string; status: string; count: number }[];
  failed: Json[];
}

/** `jobs.json`: counts by queue and status, and the last failed or dead jobs, without payloads. */
async function jobsSection({ deps, clean }: SectionContext): Promise<JobsSection> {
  const counts = await deps.db
    .select({ queue: jobs.queue, status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.queue, jobs.status)
    .orderBy(sql`${jobs.queue} COLLATE "C"`, sql`${jobs.status} COLLATE "C"`);
  const failed = await deps.db
    .select({
      queue: jobs.queue,
      status: jobs.status,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      createdAt: jobs.createdAt,
      finishedAt: jobs.updatedAt,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(inArray(jobs.status, ['failed', 'dead']))
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .limit(MAX_FAILED_ROWS);
  return {
    counts,
    failed: failed.map((job) => ({
      ...job,
      createdAt: iso(job.createdAt),
      finishedAt: iso(job.finishedAt),
      lastError: job.lastError === null ? null : clean(job.lastError),
    })),
  };
}

/** `analyses.json`: the last failed analyses, with their error code and message. */
async function analysesSection({ deps, clean }: SectionContext): Promise<{ failed: Json[] }> {
  const rows = await deps.db
    .select({
      projectKey: projects.key,
      branch: branches.name,
      analysisId: analyses.id,
      createdAt: analyses.createdAt,
      error: analyses.error,
    })
    .from(analyses)
    .innerJoin(projects, eq(projects.id, analyses.projectId))
    .leftJoin(branches, eq(branches.id, analyses.branchId))
    .where(eq(analyses.status, 'failed'))
    .orderBy(desc(analyses.createdAt), desc(analyses.id))
    .limit(MAX_FAILED_ROWS);
  return {
    failed: rows.map((row) => ({
      projectKey: row.projectKey,
      branch: row.branch,
      analysisId: row.analysisId,
      createdAt: iso(row.createdAt),
      error:
        row.error === null
          ? null
          : {
              code: clean(String(row.error.code ?? '')),
              message: clean(String(row.error.message ?? '')),
            },
    })),
  };
}

/** `scm.json`: each connection's host and, where an SCM worker runs here, its circuit. */
async function scmSection({ deps, clean }: SectionContext): Promise<Json> {
  const rows = await deps.db
    .select({
      id: scmConnections.id,
      provider: scmConnections.provider,
      baseUrl: scmConnections.baseUrl,
    })
    .from(scmConnections)
    .orderBy(asc(scmConnections.id));
  const runtime = deps.scmRuntime;
  return {
    connections: rows.map((row) => {
      const circuit = runtime?.circuit.inspect(row.id) ?? null;
      const health = runtime?.health.get(row.id) ?? null;
      const status =
        runtime === undefined
          ? 'unknown'
          : circuit?.state === 'open' || health?.ok === false
            ? 'failing'
            : health?.ok
              ? 'ok'
              : 'unknown';
      return {
        id: row.id,
        provider: row.provider,
        host: urlHost(row.baseUrl),
        status,
        circuit: circuit && { ...circuit, openedAt: iso(circuit.openedAt) },
        lastError: health?.error ? clean(health.error) : null,
      };
    }),
  };
}

const SECTIONS: readonly [string, (c: SectionContext) => Promise<Json>][] = [
  ['versions.json', versionsSection],
  ['license.json', licenseSection],
  ['plugins.json', pluginsSection],
  ['migrations.json', migrationsSection],
  ['config.json', configSection],
  ['settings.json', settingsSection],
  ['health.json', healthSection],
  ['jobs.json', jobsSection],
  ['analyses.json', analysesSection],
  ['scm.json', scmSection],
];

/** `qualor-support-<yyyymmdd-hhmmss>.zip`, in UTC. */
export function supportBundleFileName(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`;
  const time = `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
  return `qualor-support-${date}-${time}.zip`;
}

/** The size `zipStore` gives these files (30 + 46 bytes of headers and the name twice each). */
function archiveBytes(files: readonly { name: string; data: Buffer }[]): number {
  return files.reduce(
    (total, file) => total + 76 + 2 * Buffer.byteLength(file.name) + file.data.length,
    22,
  );
}

/** How many entries from the start of `sizes` add up to at least `bytes` (at least one). */
function enoughToCover(sizes: readonly number[], bytes: number): number {
  let removed = 0;
  let n = 0;
  while (n < sizes.length && removed < bytes) removed += sizes[n++] ?? 0;
  return Math.max(1, n);
}

/**
 * 4E-3b §1, §2: the support bundle. Every section is collected on its own; one that fails holds
 * its error, and the others are still written. Error texts and log lines are cleaned (configured
 * secret values redacted), and every file passes the redaction once more as a whole. Over
 * `maxBytes`, the oldest log lines go first, then the oldest failed jobs, then the oldest failed
 * analyses; `manifest.notes` says what was dropped.
 */
export async function collectSupportBundle(
  deps: SupportCollectDeps,
  opts: SupportBundleOptions,
): Promise<SupportBundle> {
  const now = opts.now ?? new Date();
  const maxBytes = opts.maxBytes ?? SUPPORT_BUNDLE_MAX_BYTES;
  // Without the secret values nothing can be checked, so a failure here fails the bundle.
  const redact = createRedactor(await configuredSecrets(deps.db, deps.config));
  const ctx: SectionContext = { deps, clean: (text) => cleanErrorText(text, redact) };
  const notes: string[] = [opts.logs === undefined ? COMMAND_LOGS_NOTE : UI_LOGS_NOTE];
  if (deps.scmRuntime === undefined) notes.push(NO_SCM_WORKER_NOTE);

  const sections = new Map<string, Json>();
  for (const [name, collect] of SECTIONS) {
    try {
      sections.set(name, await collect(ctx));
    } catch (err) {
      sections.set(name, { error: ctx.clean(describeError(err)) });
      notes.push(`${name}: could not be collected`);
    }
  }
  const jobsData = sections.get('jobs.json') as Partial<JobsSection>;
  const analysesData = sections.get('analyses.json') as { failed?: Json[] };
  const failedJobs = Array.isArray(jobsData.failed) ? [...jobsData.failed] : null;
  const failedAnalyses = Array.isArray(analysesData.failed) ? [...analysesData.failed] : null;
  let logLines = opts.logs?.map((line) => cleanLogLine(line, redact)) ?? null;
  const dropped = { logs: 0, jobs: 0, analyses: 0 };
  let overCap = false;

  const text = (value: Json): Buffer =>
    Buffer.from(redact(`${JSON.stringify(value, null, 2)}\n`), 'utf8');
  // The sections that are never trimmed are encoded once.
  const encoded = new Map<string, Buffer>();
  for (const [name, value] of sections) {
    if (name !== 'jobs.json' && name !== 'analyses.json') encoded.set(name, text(value));
  }
  const fileNames = [...SECTIONS.map(([name]) => name), ...(logLines ? ['logs.jsonl'] : [])];
  const trimNotes = (): string[] => {
    const under = `to stay under ${maxBytes} bytes`;
    return [
      ...(dropped.logs > 0
        ? [`logs trimmed: the ${dropped.logs} oldest lines were dropped ${under}`]
        : []),
      ...(dropped.jobs > 0
        ? [`jobs trimmed: the ${dropped.jobs} oldest failed jobs were dropped ${under}`]
        : []),
      ...(dropped.analyses > 0
        ? [`analyses trimmed: the ${dropped.analyses} oldest failed analyses were dropped ${under}`]
        : []),
    ];
  };
  const build = (): { files: { name: string; data: Buffer }[]; notes: string[] } => {
    const allNotes = [
      ...notes,
      ...trimNotes(),
      ...(overCap ? [`nothing left to trim: the archive is over ${maxBytes} bytes`] : []),
    ];
    const data = new Map(encoded);
    data.set('jobs.json', text(failedJobs ? { ...jobsData, failed: failedJobs } : jobsData));
    data.set(
      'analyses.json',
      text(failedAnalyses ? { ...analysesData, failed: failedAnalyses } : analysesData),
    );
    if (logLines) {
      data.set('logs.jsonl', Buffer.from(logLines.map((line) => `${line}\n`).join(''), 'utf8'));
    }
    const manifest = {
      format: SUPPORT_BUNDLE_FORMAT,
      generatedAt: now.toISOString(),
      source: opts.source,
      replica: hostname(),
      sections: fileNames,
      notes: allNotes,
    };
    return {
      files: [
        { name: 'manifest.json', data: text(manifest) },
        ...fileNames.map((name) => ({ name, data: data.get(name) ?? Buffer.alloc(0) })),
      ],
      notes: allNotes,
    };
  };
  const entrySizes = (entries: readonly Json[]): number[] =>
    entries.map((entry) => Buffer.byteLength(JSON.stringify(entry, null, 2))).reverse();

  for (;;) {
    const { files, notes: finalNotes } = build();
    const over = archiveBytes(files) - maxBytes;
    if (over <= 0) {
      return { fileName: supportBundleFileName(now), data: zipStore(files), notes: finalNotes };
    }
    if (logLines && logLines.length > 0) {
      const n = enoughToCover(
        logLines.map((line) => Buffer.byteLength(line) + 1),
        over,
      );
      logLines = logLines.slice(n);
      dropped.logs += n;
    } else if (failedJobs && failedJobs.length > 0) {
      const n = enoughToCover(entrySizes(failedJobs), over);
      failedJobs.splice(failedJobs.length - n, n);
      dropped.jobs += n;
    } else if (failedAnalyses && failedAnalyses.length > 0) {
      const n = enoughToCover(entrySizes(failedAnalyses), over);
      failedAnalyses.splice(failedAnalyses.length - n, n);
      dropped.analyses += n;
    } else {
      // Every other section is small and bounded; it is written as it is, and says so.
      overCap = true;
      const last = build();
      return {
        fileName: supportBundleFileName(now),
        data: zipStore(last.files),
        notes: last.notes,
      };
    }
  }
}
