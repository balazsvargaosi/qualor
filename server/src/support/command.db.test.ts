import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../test/config';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import {
  BUSINESS_FEATURES,
  signTest,
  testPayload,
  testSigner,
  verifyWith,
} from '../../test/license';
import { MIGRATIONS_DIR } from '../../test/paths';
import { readZip } from '../../test/zip';
import type { Config } from '../config';
import { auditEvents } from '../db/schema';
import { createLogger } from '../http/logger';
import { VERSION } from '../index';
import type { QualorPlugin } from '../plugins/contract';
import { COMMAND_LOGS_NOTE } from './collect';
import { EXIT_NOT_LICENSED, supportBundleCommand, type SupportCommandOptions } from './command';

// 4E-3b §4: `main.js support-bundle`, in-process, against the test database.

const NOW = new Date('2026-10-14T08:09:10.000Z');
const signer = testSigner();
/** A Business key: its features, and `support-bundle` (once in the list either way). */
const BUSINESS_KEY = signTest(
  signer,
  testPayload({ features: [...new Set([...BUSINESS_FEATURES, 'support-bundle'])] }),
);
const KEY_WITHOUT_FEATURE = signTest(signer, testPayload({ features: [...BUSINESS_FEATURES] }));
const PLUGIN: QualorPlugin = {
  name: 'support-fixture',
  apiVersion: 1,
  features: ['support-bundle'],
  register() {},
};
/** The files of 4E-3b §1 the command writes: everything but `logs.jsonl`. */
const FILES = [
  'manifest.json',
  'versions.json',
  'license.json',
  'plugins.json',
  'migrations.json',
  'config.json',
  'settings.json',
  'health.json',
  'jobs.json',
  'analyses.json',
  'scm.json',
];
const CLOSED_PORT_URL = 'postgres://qualor@127.0.0.1:1/qualor';

/** Standard output as a test sees it: the bytes written, and a TTY flag. */
function capture(isTTY = false) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  return { stream: Object.assign(stream, { isTTY }), data: () => Buffer.concat(chunks) };
}

interface Run {
  code: number;
  stdout: Buffer;
  stderr: string;
}

async function run(
  config: Config,
  extra: Partial<SupportCommandOptions> = {},
  isTTY = false,
): Promise<Run> {
  const out = capture(isTTY);
  let stderr = '';
  const code = await supportBundleCommand({
    args: [],
    config,
    version: VERSION,
    migrationsDir: MIGRATIONS_DIR,
    logger: createLogger('silent'),
    stdout: out.stream,
    stderr: { write: (text: string) => (stderr += text) },
    boot: {
      verifyOptions: (at) => verifyWith(signer, at),
      now: () => NOW,
      checkFile: async (p) => ({ ok: true, realPath: p }),
      importModule: async () => ({ default: PLUGIN }),
    },
    handleSignals: false,
    ...extra,
  });
  return { code, stdout: out.data(), stderr };
}

const names = (zip: Buffer): string[] => readZip(zip).map((e) => e.name);
const manifest = (zip: Buffer): Record<string, unknown> =>
  JSON.parse(
    readZip(zip)
      .find((e) => e.name === 'manifest.json')!
      .data.toString('utf8'),
  ) as Record<string, unknown>;

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => database.close());

const external = (overrides: Partial<Config> = {}): Config =>
  testConfig({
    databaseUrl: database.url,
    license: { text: BUSINESS_KEY, file: null },
    pluginPaths: ['/virtual/support.js'],
    ...overrides,
  });

const auditCount = async (): Promise<number> =>
  (await database.db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0]!.n;

describe('support-bundle with an external database', () => {
  it('writes the zip to standard output, without logs.jsonl, and records nothing', async () => {
    const before = await auditCount();
    const result = await run(external());
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(names(result.stdout)).toEqual(FILES);
    expect(manifest(result.stdout)).toMatchObject({ source: 'command' });
    expect(manifest(result.stdout).notes).toContain(COMMAND_LOGS_NOTE);
    expect(await auditCount()).toBe(before);
  });

  it('--out writes the file atomically, says where on standard error and nothing on standard output', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qualor-bundle-'));
    try {
      const target = path.join(dir, 'bundle.zip');
      writeFileSync(target, 'an older file');
      for (const args of [['--out', target], [`--out=${target}`]]) {
        const result = await run(external(), { args });
        expect(result.code).toBe(0);
        expect(result.stdout.length).toBe(0);
        expect(result.stderr).toBe(`qualor-server: wrote ${target}\n`);
        expect(names(readFileSync(target))).toEqual(FILES);
        expect(readdirSync(dir)).toEqual(['bundle.zip']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['without a licence (community)', { license: { text: null, file: null } }],
    [
      'with a key that does not list support-bundle',
      { license: { text: KEY_WITHOUT_FEATURE, file: null } },
    ],
  ])('exits 2 %s, with a message on standard error only', async (_what, overrides) => {
    const result = await run(external(overrides));
    expect(result.code).toBe(EXIT_NOT_LICENSED);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toBe(
      'qualor-server: the support bundle needs an active Business or Enterprise licence (the feature "support-bundle" is not active)\n',
    );
  });

  it('exits 2 when no plugin implements the feature, though the key lists it', async () => {
    const result = await run(external({ pluginPaths: [] }));
    expect(result.code).toBe(EXIT_NOT_LICENSED);
    expect(result.stdout.length).toBe(0);
  });

  it.each([
    [['--outfile', 'x.zip'], 'unknown argument "--outfile"'],
    [['--out'], '--out needs a file name'],
    [['--out', 'a.zip', '--out', 'b.zip'], '--out is given twice'],
  ])('exits 1 on the arguments %j', async (args, message) => {
    const result = await run(external(), { args });
    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toBe(`qualor-server: ${message}; usage: support-bundle [--out <file>]\n`);
  });

  it('refuses to write the zip to a terminal', async () => {
    const result = await run(external(), {}, true);
    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toMatch(/redirect standard output to a file .* or use --out <file>/);
  });

  it('exits 1 when the database does not answer, never naming the URL', async () => {
    const result = await run(external({ databaseUrl: CLOSED_PORT_URL }));
    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toMatch(
      /^qualor-server: the database did not answer \(.*\); check DATABASE_URL\n$/,
    );
    expect(result.stderr).not.toContain('127.0.0.1:1');
  });

  it('never runs the migrations: a database that was never migrated fails with exit 1 and stays empty', async () => {
    const empty = await createTestDatabase({ migrated: false });
    try {
      const result = await run(external({ databaseUrl: empty.url }));
      expect(result.code).toBe(1);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr).toMatch(
        /^qualor-server: the support bundle failed: DrizzleQueryError \(42P01\); the database is \d+ migration\(s\) behind this server: start the server once to apply them\n$/,
      );
      const tables = await empty.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle')`,
      );
      expect(tables.rows[0]!.n).toBe(0);
    } finally {
      await empty.close();
    }
  });

  it('with a schema behind this server: still writes the bundle, which reports the count', async () => {
    const behind = await createTestDatabase();
    try {
      await behind.db.execute(
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`,
      );
      const result = await run(external({ databaseUrl: behind.url }));
      expect(result.code).toBe(0);
      expect(result.stderr).toBe(
        'qualor-server: the database is 1 migration(s) behind this server; the bundle reports it\n',
      );
      const migrations = readZip(result.stdout).find((e) => e.name === 'migrations.json')!;
      expect(JSON.parse(migrations.data.toString('utf8'))).toMatchObject({ pending: 1 });
    } finally {
      await behind.close();
    }
  });

  it('opens only read-only sessions', async () => {
    // A plugin that tries to write while it registers fails, and with it the command's boot line
    // (the plugin is dropped): the edition then has no support-bundle and the command exits 2.
    const writer: QualorPlugin = {
      ...PLUGIN,
      async register(ctx) {
        await ctx.db.execute(sql`CREATE TABLE support_command_write_probe (id int)`);
      },
    };
    const result = await run(external(), {
      boot: {
        verifyOptions: (at) => verifyWith(signer, at),
        now: () => NOW,
        checkFile: async (p) => ({ ok: true, realPath: p }),
        importModule: async () => ({ default: writer }),
      },
    });
    expect(result.code).toBe(EXIT_NOT_LICENSED);
    const probe = await database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'support_command_write_probe'`,
    );
    expect(probe.rows[0]!.n).toBe(0);
  });
});

/**
 * embedded-postgres.md §5, §6: the embedded database, with a fake PostgreSQL as the embedded
 * tests use (db/embedded.test.ts); `databaseUrlFor` points its socket URL at the test database.
 */
describe('support-bundle with the embedded database', () => {
  let root: string;
  let dataDir: string;
  let postgresDir: string;
  let children: ChildProcess[];

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'qualor-bundle-embedded-'));
    dataDir = path.join(root, 'data');
    postgresDir = path.join(root, 'pg');
    mkdirSync(path.join(postgresDir, 'bin'), { recursive: true });
    writeFileSync(path.join(postgresDir, 'bin', 'postgres'), '');
    writeFileSync(path.join(postgresDir, 'VERSION'), '18.6\n');
    // A data directory that already holds a cluster (a server ran on it before).
    mkdirSync(path.join(dataDir, 'postgres'), { recursive: true });
    writeFileSync(path.join(dataDir, 'postgres', 'PG_VERSION'), '18\n');
    children = [];
  });
  afterEach(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  const leaseFile = (): string => path.join(dataDir, 'server.lease');
  const writeLease = (host: string, renewedAt: number): string => {
    const text = JSON.stringify({ instance: 'the-server', host, renewedAt });
    writeFileSync(leaseFile(), text);
    return text;
  };
  const embedded = (overrides: Partial<Config> = {}): Config =>
    external({ databaseUrl: null, embedded: { dataDir, postgresDir }, ...overrides });

  /** A fake postgres that runs until it is stopped; records whether the lease was held then. */
  function fakePostgres(seen: { lease?: boolean }) {
    return vi.fn(() => {
      seen.lease = existsSync(leaseFile());
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      return child;
    });
  }

  const embeddedOptions = (spawnPostgres: ReturnType<typeof fakePostgres>) => ({
    spawnPostgres,
    probe: async () => undefined,
    lease: { settleMs: 10 },
  });

  it('while a server runs: connects to its socket, never starts PostgreSQL or takes the lease', async () => {
    for (const host of ['another-container', os.hostname()]) {
      const text = writeLease(host, Date.now());
      const spawnPostgres = fakePostgres({});
      const socketUrls: string[] = [];
      const result = await run(embedded(), {
        embedded: embeddedOptions(spawnPostgres),
        databaseUrlFor: (url) => {
          socketUrls.push(url);
          return database.url;
        },
      });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(names(result.stdout)).toEqual(FILES);
      expect(spawnPostgres).not.toHaveBeenCalled();
      expect(socketUrls).toEqual([
        `postgresql://qualor@${encodeURIComponent(path.join(dataDir, 'run'))}/qualor`,
      ]);
      expect(readFileSync(leaseFile(), 'utf8')).toBe(text);
    }
  });

  it('while a server holds the lease but its database does not answer: exit 1, nothing started', async () => {
    const text = writeLease('another-container', Date.now());
    const spawnPostgres = fakePostgres({});
    const result = await run(embedded(), {
      embedded: embeddedOptions(spawnPostgres),
      databaseUrlFor: () => CLOSED_PORT_URL,
    });
    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toMatch(
      /^qualor-server: a Qualor server \(host another-container\) holds .*, but its database did not answer on .* try again once it is up, or in 30 s if it has stopped\n$/,
    );
    expect(spawnPostgres).not.toHaveBeenCalled();
    expect(readFileSync(leaseFile(), 'utf8')).toBe(text);
  });

  it.each([
    ['with no lease', () => undefined],
    ['with a stale lease', () => void writeLease('another-container', Date.now() - 60_000)],
  ])(
    'with nothing running (%s): starts PostgreSQL under the lease, then stops it and releases the lease',
    async (_what, setup) => {
      setup();
      const seen: { lease?: boolean } = {};
      const spawnPostgres = fakePostgres(seen);
      const result = await run(embedded(), {
        embedded: embeddedOptions(spawnPostgres),
        databaseUrlFor: () => database.url,
      });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(names(result.stdout)).toEqual(FILES);
      expect(spawnPostgres).toHaveBeenCalledTimes(1);
      expect(seen.lease).toBe(true);
      expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
      expect(existsSync(leaseFile())).toBe(false);
    },
  );

  it('stops the PostgreSQL it started on a failure too (not licensed: exit 2)', async () => {
    const spawnPostgres = fakePostgres({});
    const result = await run(embedded({ license: { text: null, file: null } }), {
      embedded: embeddedOptions(spawnPostgres),
      databaseUrlFor: () => database.url,
    });
    expect(result.code).toBe(EXIT_NOT_LICENSED);
    expect(spawnPostgres).toHaveBeenCalledTimes(1);
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
    expect(existsSync(leaseFile())).toBe(false);
  });

  it('never creates a cluster: an empty data directory with nothing running is exit 1', async () => {
    rmSync(path.join(dataDir, 'postgres'), { recursive: true, force: true });
    const spawnPostgres = fakePostgres({});
    const result = await run(embedded(), {
      embedded: embeddedOptions(spawnPostgres),
      databaseUrlFor: () => database.url,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `qualor-server: no Qualor server is running on ${dataDir} and it holds no database: start the server first\n`,
    );
    expect(spawnPostgres).not.toHaveBeenCalled();
    expect(existsSync(path.join(dataDir, 'postgres'))).toBe(false);
    expect(existsSync(leaseFile())).toBe(false);
  });

  it('prints the embedded start refusal as restore does (a wrong major version)', async () => {
    writeFileSync(path.join(dataDir, 'postgres', 'PG_VERSION'), '17\n');
    const spawnPostgres = fakePostgres({});
    const result = await run(embedded(), {
      embedded: embeddedOptions(spawnPostgres),
      databaseUrlFor: () => database.url,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'qualor-server: the data directory holds a PostgreSQL 17 cluster and this image carries PostgreSQL 18.6; see the upgrade notes\n',
    );
    expect(spawnPostgres).not.toHaveBeenCalled();
    expect(existsSync(leaseFile())).toBe(false);
  });
});
