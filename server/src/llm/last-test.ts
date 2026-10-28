import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../db/client';
import { instanceSettings } from '../db/schema';
import { distinctModels, modelSet } from '../review/model-tiers';
import { instanceSetting } from '../settings';
import { LLM_ERROR_CODES } from './errors';
import {
  comparedProvider,
  MODEL_TIERS,
  type StoredLlmSettings,
  type StoredProvider,
} from './settings';

/** The `instance_settings` row that keeps the provider's last Test. */
export const LLM_TEST_KEY = 'llm-test';

/**
 * What the last Test of the provider found, as codes and names only: never the provider's own
 * words, what it answered, or the key. The `fingerprint` ties it to the provider it ran against.
 */
export const storedTestSchema = z.strictObject({
  v: z.literal(1),
  at: z.iso.datetime(),
  userId: z.uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  models: z
    .array(
      z.strictObject({
        tier: z.enum(MODEL_TIERS),
        model: z.string().max(200),
        ok: z.boolean(),
        toolCalling: z.enum(['supported', 'not_supported', 'not_checked']),
        problemCode: z.enum(LLM_ERROR_CODES).nullable(),
      }),
    )
    .min(1)
    .max(3),
});
export type StoredTest = z.infer<typeof storedTestSchema>;

/** Code-unit order of two strings, for a sort. */
function byteOrder(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The digest a Test is tied to: the provider as calls see it, with the models of its tiers
 * (`comparedProvider`), and the initialization vector of its key's envelope, which is new whenever
 * the key is set. A change of the connection, of a model or of the key gives another digest.
 * Nothing of the key goes in: the vector is no secret, the settings row holds it in the clear
 * beside the ciphertext, and the record keeps the digest alone. A change of what is hashed makes
 * every stored Test stale, which asks for a new Test and breaks nothing.
 */
export function testFingerprint(p: StoredProvider): string {
  const compared = { ...comparedProvider(p), keyIv: p.apiKeyEnc?.iv ?? null };
  // Keys in byte order, so that the digest does not depend on how the fields are listed.
  const sorted = Object.fromEntries(Object.entries(compared).sort(([a], [b]) => byteOrder(a, b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** The stored Test; none when there is no row, or it does not parse (read as no Test). */
export function readStoredTest(db: Executor): Promise<StoredTest | null> {
  return instanceSetting(db, LLM_TEST_KEY, storedTestSchema.nullable(), null);
}

/** Keeps `test` in place of the one before it. */
export async function writeStoredTest(db: Executor, test: StoredTest): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: LLM_TEST_KEY, value: test })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: test, updatedAt: sql`now()` },
    });
}

/**
 * The Test, while it still describes the provider: the one that ran against the provider
 * configured now. Another address, model, key or setting of the connection makes it stale, and so
 * does having no provider.
 */
export function freshTest(settings: StoredLlmSettings, test: StoredTest | null): StoredTest | null {
  if (test === null || settings.provider === null) return null;
  return test.fingerprint === testFingerprint(settings.provider) ? test : null;
}

/** Whether the provider's models can call tools, as an organisation's admins are told. */
export interface ProviderTest {
  /** When the Test ran; null without a fresh one. */
  at: string | null;
  /**
   * `supported`: every model of the provider called the tool. `not_supported`: `modelsWithoutTools`
   * did not. `unknown`: no fresh Test, or one that could not tell for some model.
   */
  toolCalling: 'supported' | 'not_supported' | 'unknown';
  /** The models that did not call the tool, once each and sorted. */
  modelsWithoutTools: string[];
}

/** What the last Test says of the models of the provider configured now. */
export function providerTestOf(settings: StoredLlmSettings, test: StoredTest | null): ProviderTest {
  const fresh = freshTest(settings, test);
  if (fresh === null || settings.provider === null) {
    return { at: null, toolCalling: 'unknown', modelsWithoutTools: [] };
  }
  const without = modelSet(
    fresh.models.filter((m) => m.toolCalling === 'not_supported').map((m) => m.model),
  );
  if (without.length > 0) {
    return { at: fresh.at, toolCalling: 'not_supported', modelsWithoutTools: without };
  }
  const supported = new Set(
    fresh.models.filter((m) => m.toolCalling === 'supported').map((m) => m.model),
  );
  return {
    at: fresh.at,
    toolCalling: distinctModels(settings.provider).every((m) => supported.has(m))
      ? 'supported'
      : 'unknown',
    modelsWithoutTools: [],
  };
}
