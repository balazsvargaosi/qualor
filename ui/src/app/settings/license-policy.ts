import { type Api, ok } from '../api/api';
import { ApiError } from '../api/errors';
import type { ResponseBody } from '../api/types';

/**
 * 6M §5: an organisation's licence policy as its members read it, with the licence groups and the
 * SPDX ids a policy may name (the UI keeps no copy of either).
 */
export type OrgLicensePolicy = ResponseBody<'/api/v0/organizations/{id}/license-policy', 'get'>;
export type LicensePolicy = NonNullable<OrgLicensePolicy['policy']>;
export type LicensePolicyMode = LicensePolicy['mode'];
export type LicenseGroupId = LicensePolicy['forbiddenGroups'][number];
export type LicenseGroup = OrgLicensePolicy['groups'][number];
/** The two lists of SPDX ids and terms a policy names. */
export type LicenseList = 'forbidden' | 'allowed';

/** The enterprise feature that applies a policy (`GET /system/info` lists it while active). */
export const LICENSE_POLICY_FEATURE = 'license-policy';
/** The server's limit for each list (6M global constraints). */
export const MAX_POLICY_ENTRIES = 500;
/** The server's limit for one entry. */
export const MAX_ENTRY_LENGTH = 256;

/** What a policy starts from before an organisation has one: nothing forbidden yet. */
export const DEFAULT_LICENSE_POLICY: Readonly<LicensePolicy> = Object.freeze({
  mode: 'denylist',
  forbiddenGroups: [],
  forbidden: [],
  allowed: [],
  warnUnknown: false,
});

export function readLicensePolicy(api: Api, organizationId: string): Promise<OrgLicensePolicy> {
  return ok(
    api.client.GET('/api/v0/organizations/{id}/license-policy', {
      params: { path: { id: organizationId } },
    }),
  );
}

/** Stores the policy, or removes it with `null`; the answer has the stored, canonical lists. */
export function writeLicensePolicy(
  api: Api,
  organizationId: string,
  policy: LicensePolicy | null,
): Promise<{ available: boolean; policy: LicensePolicy | null }> {
  return ok(
    api.client.PUT('/api/v0/organizations/{id}/license-policy', {
      params: { path: { id: organizationId } },
      body: { policy },
    }),
  );
}

/**
 * The typed entries, split on commas and new lines, each in the spelling of the SPDX list when it
 * names a listed id case-insensitively (`mit` → `MIT`, `gpl-2.0-only with classpath-exception-2.0`
 * → `GPL-2.0-only WITH Classpath-exception-2.0`). Anything else is kept as typed: the server knows
 * more spellings (deprecated ids, `+`) and names what it refuses.
 */
export function licenseEntries(
  typed: string,
  ids: { licenses: readonly string[]; exceptions: readonly string[] },
): string[] {
  const lookup = (list: readonly string[]) => {
    const byLower = new Map(list.map((id) => [id.toLowerCase(), id]));
    return (value: string) => byLower.get(value.toLowerCase()) ?? value;
  };
  const license = lookup(ids.licenses);
  const exception = lookup(ids.exceptions);
  return typed
    .split(/[,\n]/)
    .map((entry) => entry.trim().replace(/\s+/g, ' '))
    .filter((entry) => entry !== '')
    .map((entry) => {
      const parts = entry.split(/ with /i);
      if (parts.length !== 2) return license(entry);
      const [id = '', extra = ''] = parts;
      return `${license(id)} WITH ${exception(extra)}`;
    });
}

/** The entries of the server's 400 INVALID_LICENSE_ID (`details.invalid`), or null for any other problem. */
export function invalidLicenseIds(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.status !== 400 || err.code !== 'INVALID_LICENSE_ID') {
    return null;
  }
  return err.problem?.details?.invalid ?? [];
}

/** The note shown in place of the controls without the licence, as the other licensed pages do. */
export function licensePolicyNotLicensed(): string {
  return $localize`:@@licensePolicy.notLicensed:A licence policy needs the Business plan.`;
}

/** The page's own words for a refused change, or null for any other problem. */
export function licensePolicyRefusal(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 403 && err.code === 'FEATURE_NOT_LICENSED') {
    return licensePolicyNotLicensed();
  }
  return null;
}

/** The field message for entries the server refused. */
export function invalidEntriesMessage(invalid: readonly string[]): string {
  const list = invalid.join(', ');
  return invalid.length === 1
    ? $localize`:@@licensePolicy.invalidOne:Not an SPDX licence identifier: ${list}:entries:. Remove it or correct its spelling.`
    : $localize`:@@licensePolicy.invalidMany:Not SPDX licence identifiers: ${list}:entries:. Remove them or correct their spelling.`;
}
