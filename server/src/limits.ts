/** The community-edition limits (llm.md §13); there is no organisation limit (enterprise.md §1.3). */
export const COMMUNITY_LLM_LIMITS = {
  maxFixPerOrganizationPerDay: 25,
  /**
   * The seam for the enterprise automatic fix suggestions (`llm.auto-fix`, 4E-3a): read by the
   * auto-fix settings routes and `effectiveAutoFix` (llm/auto-fix-settings.ts).
   */
  automaticFixSuggestions: false,
} as const;

export interface LlmLimits {
  maxFixPerOrganizationPerDay: number;
  automaticFixSuggestions: boolean;
}

/**
 * 6M §5: the organisation licence policy (`license-policy`, Business and Enterprise). `policy` is
 * the seam the policy routes, the dependency verdicts and the ingest stage read.
 */
export interface LicenseLimits {
  policy: boolean;
}

export const COMMUNITY_LICENSE_LIMITS: Readonly<LicenseLimits> = { policy: false };

export interface Limits {
  llm: LlmLimits;
  licenses: LicenseLimits;
}

/** The community edition's limits; a licence changes them through `licensedLimits` (enterprise.md §7.2). */
export function communityLimits(): Limits {
  return { llm: { ...COMMUNITY_LLM_LIMITS }, licenses: { ...COMMUNITY_LICENSE_LIMITS } };
}

/** enterprise.md §5: enterprise features stay on this many days after `expires`. */
export const LICENSE_GRACE_DAYS = 14;

/** enterprise.md §7.2: with `llm.fix-quota`, the admin's budget (≤ 100 000) is the only ceiling. */
export const ENTERPRISE_MAX_FIX_PER_DAY = 100_000;

/** What a plugin may override (enterprise.md §10.5): the LLM limits and the licence policy. */
export interface PluginLimitOverride {
  llm?: Partial<LlmLimits>;
  licenses?: Partial<LicenseLimits>;
}

function isFixQuota(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= ENTERPRISE_MAX_FIX_PER_DAY
  );
}

/**
 * enterprise.md §7.2: the community limits, then the active overrides in order. Anything else a
 * plugin passes, or a value outside the spec's bounds, is ignored.
 */
export function licensedLimits(overrides: readonly PluginLimitOverride[]): Limits {
  const llm: LlmLimits = { ...COMMUNITY_LLM_LIMITS };
  const licenses: LicenseLimits = { ...COMMUNITY_LICENSE_LIMITS };
  for (const override of overrides) {
    const o: Partial<Record<keyof LlmLimits, unknown>> = override.llm ?? {};
    // Each value is read once: what is checked is what is used.
    const fixQuota = o.maxFixPerOrganizationPerDay;
    if (isFixQuota(fixQuota)) llm.maxFixPerOrganizationPerDay = fixQuota;
    const automatic = o.automaticFixSuggestions;
    if (typeof automatic === 'boolean') llm.automaticFixSuggestions = automatic;
    const l: Partial<Record<keyof LicenseLimits, unknown>> = override.licenses ?? {};
    const policy = l.policy;
    if (typeof policy === 'boolean') licenses.policy = policy;
  }
  return { llm, licenses };
}
