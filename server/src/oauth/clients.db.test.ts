import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { oauthClients } from '../db/schema';
import { clientAllowed, registerDcrClient, resolveClient } from './clients';

const OPEN = { dcr: true, cimd: true, allowedClients: [] as string[] };
const CIMD = 'https://client.example/meta.json';

describe('resolveClient', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database.close();
  });

  it('finds a DCR client and refuses it when DCR is off', async () => {
    const row = await registerDcrClient(database.db, {
      name: 'Claude Code',
      redirectUris: ['http://127.0.0.1/callback'],
      logoUri: null,
      clientUri: null,
      metadata: {},
    });
    expect(row.clientId).toMatch(/^qlr_cli_/);
    expect(await resolveClient({ db: database.db, policy: OPEN }, row.clientId)).toMatchObject({
      ok: true,
      client: { id: row.id },
    });
    expect(
      await resolveClient({ db: database.db, policy: { ...OPEN, dcr: false } }, row.clientId),
    ).toEqual({ ok: false, error: 'client_not_allowed' });
  });

  it('answers unknown_client for an id nobody registered', async () => {
    expect(await resolveClient({ db: database.db, policy: OPEN }, 'qlr_cli_nope')).toEqual({
      ok: false,
      error: 'unknown_client',
    });
  });

  it('refuses a CIMD id when CIMD is off, and one off the allow-list', async () => {
    expect(
      await resolveClient({ db: database.db, policy: { ...OPEN, cimd: false } }, CIMD),
    ).toEqual({ ok: false, error: 'cimd_disabled' });
    expect(
      await resolveClient(
        { db: database.db, policy: { ...OPEN, allowedClients: ['https://other.example/'] } },
        CIMD,
      ),
    ).toEqual({ ok: false, error: 'client_not_allowed' });
  });

  it('caches a fetched CIMD document until it expires', async () => {
    let fetches = 0;
    const fetchDocument = async () => {
      fetches += 1;
      return {
        ok: true as const,
        maxAgeSeconds: 300,
        document: {
          client_id: CIMD,
          client_name: 'Meta client',
          redirect_uris: ['https://client.example/cb'],
        },
      };
    };
    let now = new Date('2026-10-18T10:00:00Z');
    const deps = { db: database.db, policy: OPEN, fetchDocument, now: () => now };
    expect(await resolveClient(deps, CIMD)).toMatchObject({
      ok: true,
      client: { name: 'Meta client' },
    });
    expect(await resolveClient(deps, CIMD)).toMatchObject({ ok: true });
    expect(fetches).toBe(1);
    now = new Date('2026-10-18T10:06:00Z');
    expect(await resolveClient(deps, CIMD)).toMatchObject({ ok: true });
    expect(fetches).toBe(2);
    const rows = await database.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, CIMD));
    expect(rows).toHaveLength(1);
  });

  it('stores a CIMD client name cleaned, or the host when nothing printable is left', async () => {
    const doc = (url: string, name: string) => async () => ({
      ok: true as const,
      maxAgeSeconds: 300,
      document: { client_id: url, client_name: name, redirect_uris: ['https://client.example/cb'] },
    });
    const named = 'https://client.example/named.json';
    expect(
      await resolveClient(
        { db: database.db, policy: OPEN, fetchDocument: doc(named, 'Meta\u202e\r\nclient') },
        named,
      ),
    ).toMatchObject({ ok: true, client: { name: 'Metaclient' } });
    const blank = 'https://client.example/blank.json';
    expect(
      await resolveClient(
        { db: database.db, policy: OPEN, fetchDocument: doc(blank, '\u200b\u2029') },
        blank,
      ),
    ).toMatchObject({ ok: true, client: { name: 'client.example' } });
  });

  it('asks allowFetch before a CIMD fetch and refuses when it says no', async () => {
    let fetches = 0;
    const deps = {
      db: database.db,
      policy: OPEN,
      allowFetch: () => false,
      fetchDocument: async () => {
        fetches += 1;
        return { ok: false as const, reason: 'unreached' };
      },
    };
    expect(await resolveClient(deps, 'https://client.example/limited.json')).toEqual({
      ok: false,
      error: 'cimd_rate_limited',
    });
    expect(fetches).toBe(0);
  });

  it('answers cimd_invalid with the reason when the document is bad', async () => {
    const deps = {
      db: database.db,
      policy: OPEN,
      fetchDocument: async () => ({ ok: false as const, reason: 'HTTP 404' }),
    };
    expect(await resolveClient(deps, 'https://client.example/missing.json')).toEqual({
      ok: false,
      error: 'cimd_invalid',
      reason: 'HTTP 404',
    });
  });
});

describe('clientAllowed', () => {
  it('allows everyone with an empty list, else an exact id or a URL prefix ending in /', () => {
    expect(clientAllowed(OPEN, 'anything')).toBe(true);
    const policy = { ...OPEN, allowedClients: ['qlr_cli_abc', 'https://claude.ai/'] };
    expect(clientAllowed(policy, 'qlr_cli_abc')).toBe(true);
    expect(clientAllowed(policy, 'https://claude.ai/oauth/meta.json')).toBe(true);
    expect(clientAllowed(policy, 'https://claude.ai.evil.example/x')).toBe(false);
    expect(clientAllowed(policy, 'qlr_cli_abcd')).toBe(false);
  });
});
