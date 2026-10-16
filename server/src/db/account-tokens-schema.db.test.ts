import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../../test/db';
import { PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION } from './errors';
import { uuidv7 } from './ids';

const KEY = (c: string) => c.repeat(64);

describe('migration 0010: account tokens (mail E2 A1)', () => {
  let t: TestDatabase;
  let userId: string;
  let adminId: string;
  const exec = (q: ReturnType<typeof sql>) => t.db.execute(q);

  beforeAll(async () => {
    t = await createTestDatabase();
    userId = uuidv7();
    adminId = uuidv7();
    await exec(
      sql`INSERT INTO users (id, username) VALUES (${userId}, 'e2-user'), (${adminId}, 'e2-admin')`,
    );
  });
  afterAll(async () => t.close());

  it('keeps one token per user and kind', async () => {
    await exec(sql`INSERT INTO account_tokens (key, kind, user_id, expires_at)
      VALUES (${KEY('a')}, 'password_reset', ${userId}, now() + interval '1 hour'),
             (${KEY('b')}, 'invitation', ${userId}, now() + interval '1 hour')`);
    expect(
      await sqlStateOf(
        exec(sql`INSERT INTO account_tokens (key, kind, user_id, expires_at)
        VALUES (${KEY('c')}, 'password_reset', ${userId}, now())`),
      ),
    ).toBe(PG_UNIQUE_VIOLATION);
  });

  it('accepts only the two kinds and a SHA-256 hex key', async () => {
    expect(
      await sqlStateOf(
        exec(sql`INSERT INTO account_tokens (key, kind, user_id, expires_at)
        VALUES (${KEY('d')}, 'magic_link', ${adminId}, now())`),
      ),
    ).toBe(PG_CHECK_VIOLATION);
    expect(
      await sqlStateOf(
        exec(sql`INSERT INTO account_tokens (key, kind, user_id, expires_at)
        VALUES ('not-a-hash', 'invitation', ${adminId}, now())`),
      ),
    ).toBe(PG_CHECK_VIOLATION);
  });

  it('goes with its user and forgets a deleted creator', async () => {
    const invitee = uuidv7();
    const creator = uuidv7();
    await exec(
      sql`INSERT INTO users (id, username) VALUES (${invitee}, 'e2-invitee'), (${creator}, 'e2-creator')`,
    );
    await exec(sql`INSERT INTO account_tokens (key, kind, user_id, created_by, expires_at)
      VALUES (${KEY('e')}, 'invitation', ${invitee}, ${creator}, now() + interval '7 days'),
             (${KEY('f')}, 'invitation', ${adminId}, ${creator}, now() + interval '7 days')`);
    await exec(sql`DELETE FROM users WHERE id = ${creator}`);
    expect(
      (await exec(sql`SELECT created_by FROM account_tokens WHERE key = ${KEY('f')}`)).rows,
    ).toEqual([{ created_by: null }]);
    await exec(sql`DELETE FROM users WHERE id = ${invitee}`);
    expect((await exec(sql`SELECT 1 FROM account_tokens WHERE key = ${KEY('e')}`)).rows).toEqual(
      [],
    );
  });
});
