import { canonicalTerm, licensePolicySchema, type LicensePolicy } from '@qualor/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../db/client';
import { LOCKS } from '../db/locks';
import { instanceSettings, organizations } from '../db/schema';
import { instanceSetting } from '../settings';

/** 6M §4: the `instance_settings` row of the organisation licence policies. */
export const LICENSE_POLICY_SETTINGS_KEY = 'licensePolicy';

/** An organisation without an entry has no policy. */
export interface LicensePolicySettings {
  organizations: Record<string, LicensePolicy>;
}

export const DEFAULT_LICENSE_POLICY_SETTINGS: LicensePolicySettings = { organizations: {} };

/** The stored row's shape, its entries unchecked. */
const storedRowSchema = z.object({ organizations: z.record(z.string(), z.unknown()).default({}) });

/**
 * The stored row. An entry that does not parse (an operator's edit) is dropped on its own, so it
 * never takes the other organisations' policies with it, and the next write removes it. The
 * licence stage does not read it through this: see {@link storedPolicyFor}.
 */
export const licensePolicySettingsSchema: z.ZodType<LicensePolicySettings> =
  storedRowSchema.transform(({ organizations: entries }) => {
    const valid: Record<string, LicensePolicy> = {};
    for (const [id, entry] of Object.entries(entries)) {
      const parsed = licensePolicySchema.safeParse(entry);
      if (parsed.success) valid[id] = parsed.data;
    }
    return { organizations: valid };
  });

export async function readLicensePolicies(db: Executor): Promise<LicensePolicySettings> {
  return instanceSetting(
    db,
    LICENSE_POLICY_SETTINGS_KEY,
    licensePolicySettingsSchema,
    DEFAULT_LICENSE_POLICY_SETTINGS,
  );
}

/**
 * The organisation's stored policy as the licence stage needs it (final review M4): `none` when
 * nothing is stored for it (no row, or no entry: the empty policy applies), `invalid` when the row
 * or its entry is stored but does not parse (an operator's edit, or a policy a newer version
 * wrote: a group id this one does not know). Judging against the empty policy then would close
 * every licence issue of the organisation, so the stage does not run.
 */
export type StoredLicensePolicy =
  { state: 'none' } | { state: 'policy'; policy: LicensePolicy } | { state: 'invalid' };

export async function storedPolicyFor(
  db: Executor,
  organizationId: string,
): Promise<StoredLicensePolicy> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, LICENSE_POLICY_SETTINGS_KEY));
  if (!row) return { state: 'none' };
  const stored = storedRowSchema.safeParse(row.value);
  if (!stored.success) return { state: 'invalid' };
  const entries = stored.data.organizations;
  if (!Object.hasOwn(entries, organizationId)) return { state: 'none' };
  const parsed = licensePolicySchema.safeParse(entries[organizationId]);
  return parsed.success ? { state: 'policy', policy: parsed.data } : { state: 'invalid' };
}

/** The organisation's policy, or `null` when it has none (or its entry does not parse). */
export async function policyFor(
  db: Executor,
  organizationId: string,
): Promise<LicensePolicy | null> {
  return (await readLicensePolicies(db)).organizations[organizationId] ?? null;
}

/**
 * The stored policies, read under the advisory lock every write of the row takes, so a change
 * made from them in `tx` never overwrites another write.
 */
export async function lockLicensePolicies(tx: Executor): Promise<LicensePolicySettings> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCKS.licensePolicy})`);
  return readLicensePolicies(tx);
}

const isUuid = (id: string): boolean => z.uuid().safeParse(id).success;

/**
 * Sets (or with `null` removes) the organisation's policy, under the lock. The entries of
 * organisations deleted since are dropped (6M §4). Call it inside a transaction.
 */
export async function writeLicensePolicy(
  tx: Executor,
  organizationId: string,
  policy: LicensePolicy | null,
): Promise<void> {
  const current = await lockLicensePolicies(tx);
  const others = Object.keys(current.organizations).filter(
    (id) => id !== organizationId && isUuid(id),
  );
  const existing =
    others.length === 0
      ? new Set<string>()
      : new Set(
          (
            await tx
              .select({ id: organizations.id })
              .from(organizations)
              .where(inArray(organizations.id, others))
          ).map((r) => r.id),
        );
  const next: Record<string, LicensePolicy> = {};
  for (const [id, kept] of Object.entries(current.organizations)) {
    if (existing.has(id)) next[id] = kept;
  }
  if (policy !== null) next[organizationId] = policy;
  const value: LicensePolicySettings = { organizations: next };
  await tx
    .insert(instanceSettings)
    .values({ key: LICENSE_POLICY_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: sql`now()` } });
}

const sortedUnique = <T extends string>(values: readonly T[]): T[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * 6M §5: the policy as it is stored: every id in its canonical spelling (`gpl-3.0` is
 * GPL-3.0-only), and each list sorted with each entry once. Validate the ids first
 * (`invalidLicenseIds`): an unknown id comes back as written.
 */
export function normalizeLicensePolicy(policy: LicensePolicy): LicensePolicy {
  return {
    mode: policy.mode,
    forbiddenGroups: sortedUnique(policy.forbiddenGroups),
    forbidden: sortedUnique(policy.forbidden.map(canonicalTerm)),
    allowed: sortedUnique(policy.allowed.map(canonicalTerm)),
    warnUnknown: policy.warnUnknown,
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Two stored (normalised) policies are the same, or both absent. */
export function sameLicensePolicy(a: LicensePolicy | null, b: LicensePolicy | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.mode === b.mode &&
    a.warnUnknown === b.warnUnknown &&
    sameList(a.forbiddenGroups, b.forbiddenGroups) &&
    sameList(a.forbidden, b.forbidden) &&
    sameList(a.allowed, b.allowed)
  );
}
