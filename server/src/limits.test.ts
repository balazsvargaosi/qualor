import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_LLM_LIMITS,
  communityLimits,
  ENTERPRISE_MAX_FIX_PER_DAY,
  LICENSE_GRACE_DAYS,
  licensedLimits,
} from './limits';

describe('licensed limits (enterprise.md §7.2)', () => {
  it('keeps the constants in one place', () => {
    expect(LICENSE_GRACE_DAYS).toBe(14);
    expect(ENTERPRISE_MAX_FIX_PER_DAY).toBe(100_000);
  });

  it('has no organisation limit: only the LLM limits (enterprise.md §1.3)', () => {
    expect(communityLimits()).toEqual({
      llm: { maxFixPerOrganizationPerDay: 25, automaticFixSuggestions: false },
      licenses: { policy: false },
    });
    expect(licensedLimits([])).toEqual({ llm: COMMUNITY_LLM_LIMITS, licenses: { policy: false } });
    expect(licensedLimits([{ llm: { maxFixPerOrganizationPerDay: 100_000 } }])).toEqual({
      llm: { maxFixPerOrganizationPerDay: 100_000, automaticFixSuggestions: false },
      licenses: { policy: false },
    });
  });

  it('reads each override value once (a getter cannot pass one value and use another)', () => {
    let reads = 0;
    const llm = {
      get maxFixPerOrganizationPerDay(): number {
        reads += 1;
        return reads === 1 ? 50 : 100_001;
      },
    };
    expect(licensedLimits([{ llm }]).llm.maxFixPerOrganizationPerDay).toBe(50);
    expect(reads).toBe(1);
  });

  it('applies LLM overrides in order and ignores anything else', () => {
    const limits = licensedLimits([
      { llm: { maxFixPerOrganizationPerDay: 500 } },
      { llm: { maxFixPerOrganizationPerDay: ENTERPRISE_MAX_FIX_PER_DAY } },
      { organizations: 9999 } as never,
    ]);
    expect(limits).toEqual({
      llm: { maxFixPerOrganizationPerDay: 100_000, automaticFixSuggestions: false },
      licenses: { policy: false },
    });
  });

  it('ignores an override outside 0–100 000 or of the wrong type (enterprise.md §7.2)', () => {
    const limits = licensedLimits([
      { llm: { maxFixPerOrganizationPerDay: 100_001 } },
      { llm: { maxFixPerOrganizationPerDay: -1 } },
      { llm: { maxFixPerOrganizationPerDay: 1.5 } },
      { llm: { automaticFixSuggestions: 'yes' as never } },
    ]);
    expect(limits.llm).toEqual(COMMUNITY_LLM_LIMITS);
    expect(licensedLimits([{ llm: { maxFixPerOrganizationPerDay: 0 } }]).llm).toEqual({
      maxFixPerOrganizationPerDay: 0,
      automaticFixSuggestions: false,
    });
  });

  it('turns the licence policy on only with a boolean override (6M)', () => {
    expect(licensedLimits([{ licenses: { policy: true } }]).licenses).toEqual({ policy: true });
    // In order: a later boolean wins, anything else is ignored.
    expect(
      licensedLimits([
        { licenses: { policy: true } },
        { licenses: { policy: 'no' as never } },
        { licenses: {} },
      ]).licenses,
    ).toEqual({ policy: true });
    expect(
      licensedLimits([{ licenses: { policy: true } }, { licenses: { policy: false } }]).licenses,
    ).toEqual({ policy: false });
    expect(licensedLimits([{ licenses: { policy: 1 as never } }]).licenses).toEqual({
      policy: false,
    });
    // An unknown key is ignored, and the policy limit leaves the LLM limits alone.
    const limits = licensedLimits([
      { licenses: { policy: true, inventory: true } as never },
      { licences: { policy: true } } as never,
    ]);
    expect(limits).toEqual({ llm: COMMUNITY_LLM_LIMITS, licenses: { policy: true } });
  });

  it('reads the policy override once', () => {
    let reads = 0;
    const licenses = {
      get policy(): boolean {
        reads += 1;
        return reads === 1;
      },
    };
    expect(licensedLimits([{ licenses }]).licenses.policy).toBe(true);
    expect(reads).toBe(1);
  });
});
