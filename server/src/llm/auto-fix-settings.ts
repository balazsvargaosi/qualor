import type { Severity } from '@qualor/shared';
import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { LOCKS } from '../db/locks';
import type { Limits } from '../limits';
import {
  organizationSettings,
  readLlmSettings,
  type AutoFixSettings,
  type OrgLlmSettings,
  type StoredLlmSettings,
} from './settings';

/** 4E-3a §2: the enterprise feature behind `limits.llm.automaticFixSuggestions`. */
export const AUTO_FIX_FEATURE = 'llm.auto-fix';

export interface EffectiveAutoFix {
  /** Whether automatic fix suggestions run for the project now. */
  allowed: boolean;
  /** The organisation's threshold: findings at or above it. */
  minSeverity: Severity;
  /** At most this many model requests per analysis. */
  maxPerAnalysis: number;
}

/**
 * 4E-3a §2, the effective rule: automatic fix suggestions run for a project only while the
 * licence's seam is on, the AI assistant is configured, the organisation is enabled with its `fix`
 * feature and auto-fix, and the project is neither excluded from AI nor opted out.
 */
export function effectiveAutoFix(
  settings: StoredLlmSettings,
  limits: Limits,
  project: { id: string; organizationId: string },
): EffectiveAutoFix {
  const org = organizationSettings(settings, project.organizationId);
  const allowed =
    limits.llm.automaticFixSuggestions &&
    settings.provider !== null &&
    org.enabled &&
    org.features.fix &&
    org.autoFix.enabled &&
    !org.excludedProjectIds.includes(project.id) &&
    !org.autoFixDisabledProjectIds.includes(project.id);
  return {
    allowed,
    minSeverity: org.autoFix.minSeverity,
    maxPerAnalysis: org.autoFix.maxPerAnalysis,
  };
}

/** Whether the organisation's assistant could make fix suggestions (switching auto-fix on needs it). */
export function fixSuggestionsEnabled(
  settings: StoredLlmSettings,
  organizationId: string,
): boolean {
  const org = organizationSettings(settings, organizationId);
  return settings.provider !== null && org.enabled && org.features.fix;
}

/**
 * 4E-3a §4: the organisation-level part of the effective rule: the assistant configured, the
 * organisation enabled with fix suggestions, and its automatic fix suggestions switched on.
 */
export function organizationAutoFixEnabled(
  settings: StoredLlmSettings,
  organizationId: string,
): boolean {
  return (
    fixSuggestionsEnabled(settings, organizationId) &&
    organizationSettings(settings, organizationId).autoFix.enabled
  );
}

/** The project is not opted out of its organisation's automatic fix suggestions. */
export function projectAutoFixEnabled(
  settings: StoredLlmSettings,
  project: { id: string; organizationId: string },
): boolean {
  return !organizationSettings(settings, project.organizationId).autoFixDisabledProjectIds.includes(
    project.id,
  );
}

function withOrganization(
  settings: StoredLlmSettings,
  organizationId: string,
  change: (org: OrgLlmSettings) => OrgLlmSettings,
): StoredLlmSettings {
  // An organisation absent from the map is disabled (llm.md §3.3): it gets a disabled entry.
  const current = organizationSettings(settings, organizationId);
  return {
    ...settings,
    organizations: { ...settings.organizations, [organizationId]: change(current) },
  };
}

/** The settings with the organisation's `autoFix` block replaced, and nothing else changed. */
export function withOrganizationAutoFix(
  settings: StoredLlmSettings,
  organizationId: string,
  autoFix: AutoFixSettings,
): StoredLlmSettings {
  return withOrganization(settings, organizationId, (org) => ({ ...org, autoFix: { ...autoFix } }));
}

/**
 * The settings with the project opted out of (`enabled` false) or back into its organisation's
 * automatic fix suggestions; the list holds each id once, and only the other ids `keep` accepts
 * (the caller drops the projects deleted since, llm.md §3.3).
 */
export function withProjectAutoFix(
  settings: StoredLlmSettings,
  organizationId: string,
  projectId: string,
  enabled: boolean,
  keep: (id: string) => boolean = () => true,
): StoredLlmSettings {
  return withOrganization(settings, organizationId, (org) => {
    const others = org.autoFixDisabledProjectIds.filter((id) => id !== projectId && keep(id));
    return { ...org, autoFixDisabledProjectIds: enabled ? others : [...others, projectId] };
  });
}

/**
 * The stored settings, read under the advisory lock every write of the row takes (llm.md §3.2),
 * so a change made from them in `tx` never overwrites another write.
 */
export async function lockLlmSettings(tx: Executor): Promise<StoredLlmSettings> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCKS.llmSettings})`);
  return readLlmSettings(tx);
}
