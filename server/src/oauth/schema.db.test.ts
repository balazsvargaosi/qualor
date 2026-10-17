import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { oauthClients, oauthGrants, oauthRequests, oauthTokens, users } from '../db/schema';

/** drizzle wraps the driver error, so match the whole `cause` chain. */
async function expectRejection(action: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const error: unknown = await Promise.resolve(action).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error, 'expected the query to be rejected').not.toBeNull();
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  expect(messages.join('\n')).toMatch(pattern);
}

describe('migration 0013_oauth', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database.close();
  });

  it('creates the four tables and cascades a user deletion to grants and tokens', async () => {
    const { db } = database;
    const [user] = await db
      .insert(users)
      .values({ username: 'agent-owner', passwordHash: null })
      .returning();
    const [client] = await db
      .insert(oauthClients)
      .values({
        clientId: 'qlr_cli_abc',
        source: 'dcr',
        name: 'Test client',
        redirectUris: ['http://127.0.0.1/callback'],
        metadata: {},
      })
      .returning();
    const [grant] = await db
      .insert(oauthGrants)
      .values({ userId: user!.id, clientRowId: client!.id, scopes: ['mcp:read'] })
      .returning();
    await db.insert(oauthTokens).values({
      grantId: grant!.id,
      kind: 'access',
      prefix: 'qlr_oat_abcd',
      secretHash: Buffer.alloc(32),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(oauthRequests).values({
      clientRowId: client!.id,
      redirectUri: 'http://127.0.0.1/callback',
      state: null,
      scopes: ['mcp:read'],
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      resource: 'https://q.example/mcp',
      expiresAt: new Date(Date.now() + 600_000),
    });
    await db.delete(users).where(eq(users.id, user!.id));
    const left = await db.execute(
      sql`SELECT (SELECT count(*) FROM oauth_grants)::int AS g, (SELECT count(*) FROM oauth_tokens)::int AS t`,
    );
    expect(left.rows[0]).toEqual({ g: 0, t: 0 });
  });

  it('refuses an unknown client source, token kind and request status', async () => {
    const { db } = database;
    await expectRejection(
      db.execute(
        sql`INSERT INTO oauth_clients (id, client_id, source, name, redirect_uris, metadata) VALUES (gen_random_uuid(), 'x', 'admin', 'x', '{}', '{}')`,
      ),
      /oauth_clients_source_check/,
    );
    const [client] = await db
      .insert(oauthClients)
      .values({ clientId: 'qlr_cli_def', source: 'dcr', name: 'c', redirectUris: [], metadata: {} })
      .returning();
    await expectRejection(
      db.execute(
        sql`INSERT INTO oauth_requests (id, client_row_id, redirect_uri, scopes, code_challenge, resource, status, expires_at) VALUES (gen_random_uuid(), ${client!.id}, 'u', '{}', 'c', 'r', 'done', now())`,
      ),
      /oauth_requests_status_check/,
    );
    const [user] = await db.insert(users).values({ username: 'kind-owner' }).returning();
    const [grant] = await db
      .insert(oauthGrants)
      .values({ userId: user!.id, clientRowId: client!.id, scopes: ['mcp:read'] })
      .returning();
    await expectRejection(
      db.execute(
        sql`INSERT INTO oauth_tokens (id, grant_id, kind, prefix, secret_hash, expires_at) VALUES (gen_random_uuid(), ${grant!.id}, 'id', 'p', ${Buffer.alloc(32)}, now())`,
      ),
      /oauth_tokens_kind_check/,
    );
  });
});
