import { randomUUID } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { destination, type Logger } from 'pino';
import type { Config } from '../config';
import { createDatabase, type Database } from '../db/client';
import {
  EmbeddedPostgresError,
  liveLease,
  socketUrl,
  startEmbeddedPostgres,
  type EmbeddedOptions,
  type EmbeddedPostgres,
  type LeaseOptions,
} from '../db/embedded';
import { pendingMigrations } from '../db/migrate';
import { createLogger } from '../http/logger';
import type { Edition } from '../license/edition';
import { LicenseFileError } from '../license/source';
import type { VerifyOptions } from '../license/verify';
import { bootEnterprise } from '../plugins/boot';
import type { LoadPluginsOptions } from '../plugins/loader';
import { formatStartupError } from '../startup-error';
import { collectSupportBundle, type SupportBundle } from './collect';
import { FEATURE } from './service';

/** 4E-3b §4: the exit code when `support-bundle` is not an active licence feature. */
export const EXIT_NOT_LICENSED = 2;
export const USAGE = 'usage: support-bundle [--out <file>]';

/** Where the zip goes when there is no `--out`; nothing else is ever written to it. */
export interface CommandOutput {
  write(chunk: Buffer, callback: (err?: Error | null) => void): boolean;
  once(event: 'error', listener: (err: Error) => void): unknown;
  off(event: 'error', listener: (err: Error) => void): unknown;
  isTTY?: boolean;
}

export interface SupportCommandOptions {
  /** The arguments after `support-bundle`. */
  args: readonly string[];
  config: Config;
  version: string;
  migrationsDir: string;
  /** Defaults to a logger on standard error: standard output carries only the zip. */
  logger?: Logger;
  stdout?: CommandOutput;
  stderr?: { write(text: string): unknown };
  /** Tests: the licence's keys and clock, and the plugins, as `bootEnterprise` takes them. */
  boot?: {
    verifyOptions?: (now: Date) => VerifyOptions;
    now?: () => Date;
    importModule?: LoadPluginsOptions['importModule'];
    checkFile?: LoadPluginsOptions['checkFile'];
  };
  /** Tests: how the embedded PostgreSQL is started and probed, and the lease's timings. */
  embedded?: Pick<
    EmbeddedOptions,
    'spawnPostgres' | 'probe' | 'readyTimeoutMs' | 'stopTimeoutMs'
  > & {
    lease?: Pick<LeaseOptions, 'settleMs' | 'renewMs' | 'hostname'>;
  };
  /** Tests: the URL connected to for an embedded socket URL (their own database). */
  databaseUrlFor?: (socketUrl: string) => string;
  /** Interrupts stop the embedded PostgreSQL first; tests switch this off. Default true. */
  handleSignals?: boolean;
}

/** A failure the command explains itself, with its exit code. */
class CommandError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

function parseArgs(args: readonly string[]): { out: string | null } | { error: string } {
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    let value: string | undefined;
    if (arg === '--out') value = args[++i];
    else if (arg.startsWith('--out=')) value = arg.slice('--out='.length);
    else return { error: `unknown argument ${JSON.stringify(arg)}` };
    if (value === undefined || value === '') return { error: '--out needs a file name' };
    if (out !== null) return { error: '--out is given twice' };
    out = value;
  }
  return { out };
}

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * 4E-3b §4: `main.js support-bundle [--out <file>]`. Loads the licence as the server does at
 * start, opens the database without HTTP, workers, schedulers or migrations, and writes the
 * bundle (source `command`, no logs) to the file or to standard output. Every session is
 * read-only, so it records no audit event and changes nothing.
 *
 * The embedded database (embedded-postgres.md §5, §6): while a server (or `restore`) renews the
 * data directory's lease, the command connects to its socket and neither takes the lease nor
 * starts PostgreSQL, and fails if that socket does not answer. With no live lease, it starts the
 * embedded PostgreSQL as `restore` does, under the lease, and stops it afterwards, on a failure
 * or an interrupt too. It never creates a cluster in an empty data directory.
 *
 * Returns the exit code: 0, 2 when the feature is not active, 1 on any other failure.
 */
export async function supportBundleCommand(options: SupportCommandOptions): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const say = (message: string): void => {
    stderr.write(`qualor-server: ${message}\n`);
  };
  const parsed = parseArgs(options.args);
  if ('error' in parsed) {
    say(`${parsed.error}; ${USAGE}`);
    return 1;
  }
  const stdout = options.stdout ?? process.stdout;
  if (parsed.out === null && stdout.isTTY) {
    say(
      'the bundle is a zip archive: redirect standard output to a file (support-bundle > bundle.zip) or use --out <file>',
    );
    return 1;
  }
  const { config } = options;
  const logger =
    options.logger ?? createLogger(config.logLevel, destination({ dest: 2, sync: true }));

  const held: { database?: Database; starting?: Promise<EmbeddedPostgres>; tmp?: string } = {};
  let cleaning: Promise<void> | undefined;
  /** Closes the pool, stops a PostgreSQL this command started and removes a partial file. */
  const cleanup = (): Promise<void> =>
    (cleaning ??= (async () => {
      await held.database?.close().catch(() => undefined);
      await held.starting?.then(
        (embedded) => embedded.stop(),
        () => undefined,
      );
      if (held.tmp !== undefined) await rm(held.tmp, { force: true });
    })());
  const onSignal = (signal: NodeJS.Signals): void => {
    void cleanup().finally(() => {
      say(`interrupted (${signal}); no bundle was written`);
      process.exit(1);
    });
  };
  if (options.handleSignals !== false) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  try {
    await collectAndWrite(options, parsed.out, logger, held, say, stdout);
    return 0;
  } catch (err) {
    if (err instanceof CommandError) {
      say(err.message);
      return err.exitCode;
    }
    // Never the error's message: a driver failure's carries the query (startup-error.ts).
    say(`the support bundle failed: ${formatStartupError(err)}`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

async function collectAndWrite(
  options: SupportCommandOptions,
  out: string | null,
  logger: Logger,
  held: { database?: Database; starting?: Promise<EmbeddedPostgres>; tmp?: string },
  say: (message: string) => void,
  stdout: CommandOutput,
): Promise<void> {
  const { config } = options;
  const connection = await openConnection(options, logger, held, say);
  const database = createDatabase(connection.url, {
    max: 4,
    readOnly: true,
    onError: (err) => logger.warn({ err }, 'idle database connection failed'),
  });
  held.database = database;
  // The first query; it also says how far the schema is behind this server (never migrated here).
  let pending: number;
  try {
    pending = await pendingMigrations(database.db, options.migrationsDir);
  } catch (err) {
    throw new CommandError(1, connection.unreachable(err));
  }
  const behind =
    pending > 0
      ? `; the database is ${pending} migration(s) behind this server: start the server once to apply them`
      : '';
  let edition: Edition;
  try {
    ({ edition } = await bootEnterprise({
      config,
      db: database.db,
      logger,
      serverVersion: options.version,
      ...options.boot,
    }));
  } catch (err) {
    if (err instanceof LicenseFileError) throw new CommandError(1, err.message);
    throw new CommandError(1, `the licence could not be read: ${formatStartupError(err)}${behind}`);
  }
  if (!edition.isFeatureActive(FEATURE)) {
    throw new CommandError(
      EXIT_NOT_LICENSED,
      `the support bundle needs an active Business or Enterprise licence (the feature "${FEATURE}" is not active)`,
    );
  }
  // A schema behind this server: produce what can be read (migrations.json reports the count, a
  // section that fails holds its error); only a failure of the whole bundle stops it.
  let bundle: SupportBundle;
  try {
    bundle = await collectSupportBundle(
      {
        db: database.db,
        config,
        edition,
        version: options.version,
        migrationsDir: options.migrationsDir,
      },
      { source: 'command' },
    );
  } catch (err) {
    throw new CommandError(1, `the support bundle failed: ${formatStartupError(err)}${behind}`);
  }
  if (connection.lost()) {
    throw new CommandError(
      1,
      'another server took the data directory over while the bundle was collected; no bundle was written',
    );
  }
  const warnBehind = (): void => {
    if (pending > 0)
      say(`the database is ${pending} migration(s) behind this server; the bundle reports it`);
  };
  if (out === null) {
    await writeOut(stdout, bundle.data);
    warnBehind();
    return;
  }
  const target = path.resolve(out);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  held.tmp = tmp;
  await writeFile(tmp, bundle.data, { flag: 'wx' });
  await rename(tmp, target);
  delete held.tmp;
  say(`wrote ${target}`);
  warnBehind();
}

/** Writes `data` and waits until it is handed to the OS, so process.exit cannot cut it short. */
function writeOut(stdout: CommandOutput, data: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // A closed pipe (`| head`) emits 'error' too; it fails the command instead of crashing it.
    const onError = (err: Error): void => reject(err);
    stdout.once('error', onError);
    stdout.write(data, (err) => {
      stdout.off('error', onError);
      if (err) reject(err);
      else resolve();
    });
  });
}

interface Connection {
  url: string;
  /** The message for a database that does not answer. */
  unreachable(err: unknown): string;
  /** Whether another server took over the lease of a PostgreSQL this command started. */
  lost(): boolean;
}

async function openConnection(
  options: SupportCommandOptions,
  logger: Logger,
  held: { starting?: Promise<EmbeddedPostgres> },
  say: (message: string) => void,
): Promise<Connection> {
  const { config } = options;
  if (config.databaseUrl !== null) {
    return {
      url: config.databaseUrl,
      // Never the URL: it holds the password.
      unreachable: (err) =>
        `the database did not answer (${formatStartupError(err)}); check DATABASE_URL`,
      lost: () => false,
    };
  }
  const { dataDir } = config.embedded;
  const urlFor = options.databaseUrlFor ?? ((url: string) => url);
  const run = path.join(dataDir, 'run');
  const lease = await liveLease(dataDir);
  if (lease !== null) {
    logger.info(
      { component: 'support', host: lease.host },
      'a server is running on the data directory; connecting to its database',
    );
    return {
      url: urlFor(socketUrl(run)),
      unreachable: (err) =>
        `a Qualor server (host ${lease.host}) holds ${dataDir}, but its database did not answer on ${run} (${formatStartupError(err)}): try again once it is up, or in 30 s if it has stopped`,
      lost: () => false,
    };
  }
  if (!(await exists(path.join(dataDir, 'postgres', 'PG_VERSION')))) {
    throw new CommandError(
      1,
      `no Qualor server is running on ${dataDir} and it holds no database: start the server first`,
    );
  }
  let lost = false;
  held.starting = startEmbeddedPostgres({
    ...config.embedded,
    logger,
    ...options.embedded,
    lease: {
      ...options.embedded?.lease,
      onLost: () => {
        lost = true;
        say('another server took the data directory over; stopping the embedded PostgreSQL');
        void held.starting?.then((embedded) => embedded.stop());
      },
    },
  });
  let embedded: EmbeddedPostgres;
  try {
    embedded = await held.starting;
  } catch (err) {
    // The start's own refusals (another server holds the volume, a wrong major version) are
    // written for the operator, as `restore` prints them.
    if (err instanceof EmbeddedPostgresError) throw new CommandError(1, err.message);
    throw err;
  }
  return {
    url: urlFor(embedded.url),
    unreachable: (err) => `the embedded PostgreSQL did not answer (${formatStartupError(err)})`,
    lost: () => lost,
  };
}
