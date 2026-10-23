import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { AI_CATEGORIES, rules } from '../db/schema';
import { AI_ENGINE, AI_RULES, aiRuleKey, ensureAiRules } from './rules';

/** [key, name, quality, default severity] of the eight rules, by category. */
const EXPECTED = {
  logic: ['ai:logic', 'AI review: logic error', 'reliability', 'medium'],
  'error-handling': [
    'ai:error-handling',
    'AI review: missing or wrong error handling',
    'reliability',
    'medium',
  ],
  compatibility: [
    'ai:compatibility',
    'AI review: breaking or risky change',
    'reliability',
    'medium',
  ],
  concurrency: ['ai:concurrency', 'AI review: concurrency problem', 'reliability', 'medium'],
  security: ['ai:security', 'AI review: security problem', 'security', 'high'],
  performance: ['ai:performance', 'AI review: performance problem', 'reliability', 'low'],
  tests: ['ai:tests', 'AI review: missing or weak tests', 'maintainability', 'low'],
  docs: ['ai:docs', 'AI review: documentation out of date', 'maintainability', 'low'],
} as const;

/**
 * 6I-3: the builtin rules of the AI review. Their issues are made by review runs only, so the
 * rules are the server's own: a report cannot define them.
 */
describe('the rules of engine ai (6I-3)', () => {
  let t: TestDatabase;
  const aiRows = () =>
    t.db.select().from(rules).where(eq(rules.engineId, AI_ENGINE)).orderBy(asc(rules.key));

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.db.delete(rules).where(eq(rules.engineId, AI_ENGINE));
  });

  it('names the engine and the key of every category', () => {
    expect(AI_ENGINE).toBe('ai');
    expect(AI_RULES.map((r) => r.category)).toEqual([...AI_CATEGORIES]);
    for (const category of AI_CATEGORIES) expect(aiRuleKey(category)).toBe(`ai:${category}`);
    expect(aiRuleKey('error-handling')).toBe('ai:error-handling');
  });

  it('ensureAiRules creates the eight builtin rules and is idempotent', async () => {
    expect(await aiRows()).toEqual([]);

    const ids = await ensureAiRules(t.db);
    expect([...ids.keys()]).toEqual([...AI_CATEGORIES]);
    const rows = await aiRows();
    expect(rows).toHaveLength(8);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const category of AI_CATEGORIES) {
      const [key, name, quality, defaultSeverity] = EXPECTED[category];
      const row = byKey.get(key);
      expect(row, key).toMatchObject({
        key,
        engineId: 'ai',
        engineRuleId: category,
        name,
        quality,
        defaultSeverity,
        kind: 'issue',
        origin: 'builtin',
        status: 'ready',
        languages: ['*'],
        cwe: [],
        tags: [],
        helpUri: null,
      });
      expect(ids.get(category), key).toBe(row?.id);
    }

    // A second call finds the same rules and rewrites none of them.
    expect(await ensureAiRules(t.db)).toEqual(ids);
    expect(await aiRows()).toEqual(rows);
    // Nor does one inside a transaction, as the review store calls it.
    expect(await t.db.transaction((tx) => ensureAiRules(tx))).toEqual(ids);
    expect(await aiRows()).toEqual(rows);
  });

  it("writes each rule's fixed description: what it covers, that an AI review found it, that it may be wrong, and that it never counts in the quality gate", async () => {
    await ensureAiRules(t.db);
    const rows = await aiRows();
    for (const row of rows) {
      const text = row.descriptionMd ?? '';
      expect(text, row.key).toMatch(/An AI review found it/);
      expect(text, row.key).toMatch(/may be wrong/);
      expect(text, row.key).toMatch(/never count in the quality gate/);
      // What the category covers comes first, before the notice every rule shares.
      expect(text.split('\n\n')[0]?.length, row.key).toBeGreaterThan(60);
    }
    expect(new Set(rows.map((r) => r.descriptionMd)).size).toBe(8);
  });

  it('repairs a rule a report created before reports were barred from the engine, and keeps its id', async () => {
    const ids = await ensureAiRules(t.db);
    // As an older server let a report leave it: reported, a hotspot, with a CWE and a link.
    await t.db
      .update(rules)
      .set({
        origin: 'reported',
        quality: 'maintainability',
        kind: 'hotspot',
        defaultSeverity: 'blocker',
        name: 'logic',
        descriptionMd: 'Something else',
        helpUri: 'https://example.com/x',
        languages: ['typescript'],
        tags: ['x'],
        cwe: [79],
        status: 'deprecated',
      })
      .where(eq(rules.key, 'ai:logic'));

    expect(await ensureAiRules(t.db)).toEqual(ids);
    const [repaired] = await t.db.select().from(rules).where(eq(rules.key, 'ai:logic'));
    expect(repaired).toMatchObject({
      id: ids.get('logic'),
      origin: 'builtin',
      engineId: 'ai',
      engineRuleId: 'logic',
      name: 'AI review: logic error',
      descriptionMd: AI_RULES[0]?.descriptionMd,
      helpUri: null,
      languages: ['*'],
      defaultSeverity: 'medium',
      quality: 'reliability',
      kind: 'issue',
      tags: [],
      cwe: [],
      status: 'ready',
    });
  });

  it('does not wait for a transaction that holds the rules: two reviews can store at once', async () => {
    const ids = await ensureAiRules(t.db);
    let holding!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = t.db.transaction(async (tx) => {
      await tx.select().from(rules).where(eq(rules.engineId, AI_ENGINE)).for('update');
      holding();
      await released;
    });
    try {
      await held;
      // A wait on a locked row would end in 55P03 after two seconds, not hang the test.
      const second = await t.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        return ensureAiRules(tx);
      });
      expect(second).toEqual(ids);
    } finally {
      release();
      await holder;
    }
  });

  it('brings a builtin rule that differs from the code up to date: a changed text reaches an existing row', async () => {
    const ids = await ensureAiRules(t.db);
    const before = await aiRows();
    // As an earlier release left a rule: other words, another quality, another severity. Each
    // difference alone is enough, and nothing else about the row changes.
    const older = [
      { key: 'ai:logic', set: { name: 'AI review: an older name' } },
      { key: 'ai:docs', set: { descriptionMd: 'An older description.' } },
      { key: 'ai:tests', set: { quality: 'reliability' } },
      { key: 'ai:security', set: { defaultSeverity: 'medium' } },
    ];
    for (const { key, set } of older) {
      await t.db.update(rules).set(set).where(eq(rules.key, key));
      const stale = await aiRows();
      expect(
        stale.find((r) => r.key === key),
        key,
      ).toMatchObject(set);

      expect(await ensureAiRules(t.db), key).toEqual(ids);
      const after = await aiRows();
      expect(
        after.map((r) => ({ ...r, updatedAt: null })),
        key,
      ).toEqual(before.map((r) => ({ ...r, updatedAt: null })));
      // The rows that were right are not written.
      for (const row of after.filter((r) => r.key !== key)) {
        expect(row.updatedAt, row.key).toEqual(stale.find((r) => r.key === row.key)?.updatedAt);
      }
    }

    // All four at once, and a second call writes nothing more.
    await t.db
      .update(rules)
      .set({
        name: 'Older',
        descriptionMd: 'Older.',
        quality: 'maintainability',
        defaultSeverity: 'low',
      })
      .where(eq(rules.key, 'ai:logic'));
    expect(await ensureAiRules(t.db)).toEqual(ids);
    const refreshed = await aiRows();
    expect(refreshed.map((r) => ({ ...r, updatedAt: null }))).toEqual(
      before.map((r) => ({ ...r, updatedAt: null })),
    );
    expect(await ensureAiRules(t.db)).toEqual(ids);
    expect(await aiRows()).toEqual(refreshed);
  });

  it('refuses a builtin rule of another engine or kind: its issues would take them', async () => {
    await ensureAiRules(t.db);
    for (const change of [
      { key: 'ai:tests', set: { kind: 'hotspot' as const }, problem: 'ai/maintainability/hotspot' },
      { key: 'ai:logic', set: { engineId: 'eslint' }, problem: 'eslint/reliability/issue' },
    ]) {
      const [before] = await t.db.select().from(rules).where(eq(rules.key, change.key));
      await t.db.update(rules).set(change.set).where(eq(rules.key, change.key));
      try {
        await expect(ensureAiRules(t.db), change.key).rejects.toThrow(
          new RegExp(`${change.key} is ${change.problem}`),
        );
      } finally {
        await t.db
          .update(rules)
          .set({ kind: before?.kind ?? 'issue', engineId: 'ai' })
          .where(eq(rules.key, change.key));
      }
    }
    expect(await ensureAiRules(t.db)).toHaveProperty('size', 8);
  });
});
