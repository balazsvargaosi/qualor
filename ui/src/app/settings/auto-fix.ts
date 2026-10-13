import { ApiError } from '../api/errors';
import type { RequestBody, ResponseBody } from '../api/types';

/** 4E-3a §2: an organisation's automatic fix suggestions, as its admin reads them. */
export type OrgAutoFix = ResponseBody<'/api/v0/organizations/{id}/ai/auto-fix', 'get'>;
/** What the organisation route and `/system/llm` store: `{ enabled, minSeverity, maxPerAnalysis }`. */
export type AutoFix = RequestBody<'/api/v0/organizations/{id}/ai/auto-fix', 'put'>;
export type AutoFixSeverity = AutoFix['minSeverity'];

/** The enterprise feature that makes them available (`GET /system/info` lists it while active). */
export const AUTO_FIX_FEATURE = 'llm.auto-fix';
/** Most severe first, as the select lists them. */
export const AUTO_FIX_SEVERITIES: readonly AutoFixSeverity[] = [
  'blocker',
  'high',
  'medium',
  'low',
  'info',
];
export const MAX_AUTO_FIX_PER_ANALYSIS = 25;
/** What an organisation without a stored block has (off, high, 10). */
export const DEFAULT_AUTO_FIX: Readonly<AutoFix> = Object.freeze({
  enabled: false,
  minSeverity: 'high',
  maxPerAnalysis: 10,
});

export function isAutoFixSeverity(value: string): value is AutoFixSeverity {
  return (AUTO_FIX_SEVERITIES as readonly string[]).includes(value);
}

/** The typed maximum per analysis as a whole number from 1 to 25, or null. */
export function parseMaxPerAnalysis(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{1,2}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= MAX_AUTO_FIX_PER_ANALYSIS ? n : null;
}

export function maxPerAnalysisRefusal(): string {
  return $localize`:@@autoFix.badMax:Use a whole number from 1 to 25.`;
}

/** The note shown in place of the controls without the licence (4E-3a §4). */
export function autoFixNotLicensed(): string {
  return $localize`:@@autoFix.notLicensed:Automatic fix suggestions need the Enterprise plan.`;
}

/**
 * The page's own words for a refused switch-on of the organisation route (4E-3a §2), or null for
 * any other problem.
 */
export function autoFixRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 403 && err.code === 'FEATURE_NOT_LICENSED') return autoFixNotLicensed();
  if (err.status === 409 && err.code === 'AI_DISABLED') {
    return $localize`:@@autoFix.aiDisabled:Switching them on needs the AI assistant enabled for this organisation with Suggest a fix. An instance administrator sets that in the AI assistant settings.`;
  }
  return null;
}
