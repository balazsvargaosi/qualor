import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { expect, inject } from 'vitest';
import { createDatabase, type Database, type Db } from '../src/db/client';
import { pgErrorCode } from '../src/db/errors';
import { databaseUrl, TEMPLATE_DATABASE } from './urls';

export interface TestDatabase extends Database {
  url: string;
  name: string;
}

async function adminQueries(statements: readonly string[]): Promise<void> {
  const client = new pg.Client({ connectionString: inject('databaseAdminUrl') });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

/** A fresh database per test file: a clone of the migrated template (default) or empty. */
export async function createTestDatabase(
  options: { migrated?: boolean } = {},
): Promise<TestDatabase> {
  const name = `qualor_test_${randomBytes(6).toString('hex')}`;
  const template = options.migrated === false ? '' : ` TEMPLATE ${TEMPLATE_DATABASE}`;
  // Two files cloning the template at the same instant can collide; serialise the CREATE.
  await adminQueries([
    'SELECT pg_advisory_lock(7310099)',
    `CREATE DATABASE ${name}${template}`,
    'SELECT pg_advisory_unlock(7310099)',
  ]);
  const database = createDatabase(databaseUrl(inject('databaseAdminUrl'), name), { max: 10 });
  return {
    ...database,
    url: databaseUrl(inject('databaseAdminUrl'), name),
    name,
    close: async () => {
      await database.close();
      await adminQueries([`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    },
  };
}

/**
 * The SQLSTATE `action` fails with, or undefined when it succeeds or fails without one: for a test
 * that asserts it itself, `expect(await sqlStateOf(insert)).toBe(PG_UNIQUE_VIOLATION)`.
 */
export async function sqlStateOf(action: PromiseLike<unknown>): Promise<string | undefined> {
  return Promise.resolve(action).then(
    () => undefined,
    (err: unknown) => pgErrorCode(err),
  );
}

export async function expectPgError(action: PromiseLike<unknown>, code: string): Promise<void> {
  expect(await sqlStateOf(action), `expected SQLSTATE ${code}`).toBe(code);
}

/**
 * Polls until `n` backends of this test's own database wait on a lock (never a fixed sleep): a
 * test that holds a row lock sends its requests, waits for them to queue behind it, and lets go.
 */
export async function waitForLockWaiters(db: Db, n: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`);
    if (Number(result.rows[0]?.n) >= n) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${n} lock waiter(s)`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
