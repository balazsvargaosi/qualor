import type { Organization } from '../../api/types';
import { formatDate } from '../../shared/date-time.pipe';
import { formatWhole } from '../../shared/numbers';
import type { StatusLine } from '../../shared/status-list';
import { consentFields } from './consent-impact';
import type { LlmSettings } from './llm-body';
import { namesOf } from './names';

/**
 * The instance's AI as its Status card says it (spec §3.4 M-I3, Appendix A), from what is saved:
 *
 * - the provider: connected, or failing its last Test; its kind, host and models; what that Test
 *   found, which is kept until the provider changes;
 * - the organisations that may use AI, by name up to three;
 * - where AI review runs, or is paused until an organisation's admins confirm the provider now:
 *   on only with a provider, in an organisation allowed to use AI whose admins switched it on and
 *   confirmed (the server's order of reasons); an organisation the settings lack has it off;
 * - once a provider is saved, the limits and the prices.
 *
 * `organizations` is null while they could not be read: the lines then count the organisations
 * the settings hold, unnamed.
 */
export function instanceStatusLines(
  saved: LlmSettings,
  organizations: readonly Organization[] | null,
  locale: string,
): StatusLine[] {
  const known = knownOrganizations(saved, organizations);
  const lines = [
    providerLine(saved, locale),
    organizationsLine(saved, known, organizations !== null, locale),
    reviewLine(saved, known, locale),
  ];
  if (saved.provider !== null) lines.push(limitsLine(saved, locale), pricesLine(saved, locale));
  return lines;
}

function providerLine(saved: LlmSettings, locale: string): StatusLine {
  const label = $localize`:@@aiProvider.status.provider:Provider`;
  const provider = saved.provider;
  if (provider === null) {
    return {
      key: 'provider',
      label,
      tone: 'off',
      state: $localize`:@@aiProvider.status.notConnected:Not connected`,
      action: null,
    };
  }
  const kind =
    provider.kind === 'openai'
      ? $localize`:@@aiProvider.status.kindOpenai:OpenAI-compatible`
      : $localize`:@@aiProvider.status.kindAnthropic:Anthropic`;
  const { host, models } = consentFields(provider);
  const count = models.length;
  const n = formatWhole(count, locale);
  const test = saved.lastTest;
  const failed = test?.models.filter((m) => !m.ok || m.problemCode !== null) ?? [];
  return {
    key: 'provider',
    label,
    tone: failed.length > 0 ? 'broken' : 'ok',
    state:
      failed.length > 0
        ? $localize`:@@aiProvider.status.testFailed:Test failed`
        : $localize`:@@aiProvider.status.connected:Connected`,
    text:
      count === 1
        ? $localize`:@@aiProvider.status.providerTextOne:${kind}:kind: at ${host}:host: · 1 model`
        : $localize`:@@aiProvider.status.providerText:${kind}:kind: at ${host}:host: · ${n}:n: models`,
    sub: testedText(test, locale),
    action: { id: 'test', label: $localize`:@@aiProvider.testAgain:Test again` },
  };
}

/** What the last Test found, in a sentence: failures first, then models that cannot call tools. */
function testedText(test: LlmSettings['lastTest'], locale: string): string {
  if (test === null) {
    return $localize`:@@aiProvider.status.notTested:Not tested since the provider changed.`;
  }
  const date = formatDate(test.at, locale);
  const list = (models: readonly string[]) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(models);
  const failed = test.models.filter((m) => !m.ok || m.problemCode !== null).map((m) => m.model);
  if (failed.length > 0) {
    const models = list(failed);
    return $localize`:@@aiProvider.status.testedFailed:Tested ${date}:date:: the test failed for ${models}:models:.`;
  }
  const noTools = test.models.filter((m) => m.toolCalling === 'not_supported').map((m) => m.model);
  if (noTools.length > 0) {
    const models = list(noTools);
    return $localize`:@@aiProvider.status.testedNoTools:Tested ${date}:date:: ${models}:models: cannot call tools.`;
  }
  const count = test.models.length;
  const n = formatWhole(count, locale);
  if (test.models.some((m) => m.toolCalling === 'not_checked')) {
    return count === 1
      ? $localize`:@@aiProvider.status.testedConnectsOne:Tested ${date}:date:: the model connects.`
      : $localize`:@@aiProvider.status.testedConnects:Tested ${date}:date:: all ${n}:n: models connect.`;
  }
  return count === 1
    ? $localize`:@@aiProvider.status.testedOne:Tested ${date}:date:: the model connects and can call tools.`
    : $localize`:@@aiProvider.status.tested:Tested ${date}:date:: all ${n}:n: models connect and can call tools.`;
}

/** An organisation the lines speak of: by name, or by id alone while the list could not be read. */
interface Known {
  id: string;
  name: string | null;
}

function knownOrganizations(
  saved: LlmSettings,
  organizations: readonly Organization[] | null,
): Known[] {
  return organizations === null
    ? Object.keys(saved.organizations).map((id) => ({ id, name: null }))
    : organizations.map((o) => ({ id: o.id, name: o.name }));
}

/** Organisations in a sentence: those named, and the others counted. */
function whoOf(organizations: readonly Known[], locale: string): string {
  const named = organizations.flatMap((o) => (o.name === null ? [] : [o.name]));
  return namesOf(named, locale, organizations.length - named.length);
}

function organizationsLine(
  saved: LlmSettings,
  organizations: readonly Known[],
  listed: boolean,
  locale: string,
): StatusLine {
  const label = $localize`:@@aiProvider.status.organizations:Organizations`;
  const allowed = organizations.filter((o) => saved.organizations[o.id]?.enabled === true);
  const action = {
    id: 'manage',
    label: $localize`:@@aiProvider.status.manage:Manage`,
    ariaLabel: $localize`:@@aiProvider.status.manageLabel:Manage organizations`,
  };
  if (allowed.length === 0) {
    return {
      key: 'organizations',
      label,
      tone: 'off',
      state: $localize`:@@aiProvider.status.noneAllowed:None may use AI`,
      sub: null,
      action: saved.provider === null ? null : action,
    };
  }
  if (!listed) {
    // How many there are in all is not known: those allowed are counted.
    const who = whoOf(allowed, locale);
    return {
      key: 'organizations',
      label,
      tone: 'ok',
      state: $localize`:@@aiProvider.status.allowedUnlisted:${who}:organizations: may use AI`,
      sub: null,
      action,
    };
  }
  const a = formatWhole(allowed.length, locale);
  const t = formatWhole(organizations.length, locale);
  return {
    key: 'organizations',
    label,
    tone: 'ok',
    state: $localize`:@@aiProvider.status.allowed:${a}:allowed: of ${t}:total: may use AI`,
    sub: whoOf(allowed, locale),
    action,
  };
}

function reviewLine(
  saved: LlmSettings,
  organizations: readonly Known[],
  locale: string,
): StatusLine {
  const label = $localize`:@@aiProvider.status.review:AI review`;
  // The server's reasons, in its order: a provider, the organisation allowed, the switch, the
  // consent. Only the last leaves AI review paused, which its admins can resume.
  const switchedOn =
    saved.provider === null
      ? []
      : organizations.filter((o) => {
          const stored = saved.organizations[o.id];
          return stored?.enabled === true && stored.reviewStatus.enabled;
        });
  const current = (o: Known) => saved.organizations[o.id]?.reviewStatus.consentCurrent;
  const on = switchedOn.filter((o) => current(o));
  const paused = switchedOn.filter((o) => !current(o));
  const onText = (who: readonly Known[]) => {
    const list = whoOf(who, locale);
    return $localize`:@@aiProvider.status.reviewOn:On in ${list}:names:`;
  };
  if (paused.length > 0) {
    const list = whoOf(paused, locale);
    return {
      key: 'review',
      label,
      tone: 'attention',
      state: $localize`:@@aiProvider.status.reviewPaused:Paused in ${list}:names:`,
      text: on.length > 0 ? onText(on) : null,
    };
  }
  if (on.length > 0) return { key: 'review', label, tone: 'ok', state: onText(on) };
  return {
    key: 'review',
    label,
    tone: 'off',
    state: $localize`:@@aiProvider.status.reviewOff:Off everywhere`,
  };
}

function limitsLine(saved: LlmSettings, locale: string): StatusLine {
  const tokens = formatWhole(saved.budgets.tokensPerDay, locale);
  const ceiling = saved.budgets.reviewTokensPerOrganizationPerDay;
  const cap = ceiling === null ? null : formatWhole(ceiling, locale);
  return {
    key: 'limits',
    label: $localize`:@@aiProvider.status.limits:Limits`,
    tone: 'ok',
    state: $localize`:@@aiProvider.limits.chip:Set`,
    text:
      cap === null
        ? $localize`:@@aiProvider.status.limitsNoCap:Assistant: ${tokens}:tokens: tokens a day per organization · AI review: no cap (each organization admin may set up to 1,000,000,000 a day)`
        : $localize`:@@aiProvider.status.limitsCap:Assistant: ${tokens}:tokens: tokens a day per organization · AI review: capped at ${cap}:cap: tokens a day per organization`,
  };
}

function pricesLine(saved: LlmSettings, locale: string): StatusLine {
  const label = $localize`:@@aiProvider.status.prices:Prices`;
  const pricing = saved.pricing;
  if (pricing === null) {
    return {
      key: 'prices',
      label,
      tone: 'off',
      state: $localize`:@@aiProvider.status.pricesNotSet:Not set`,
      sub: $localize`:@@aiProvider.status.pricesNotSetSub:Costs are not counted, and cost limits count nothing.`,
      action: { id: 'prices', label: $localize`:@@aiProvider.status.enterPrices:Enter prices` },
    };
  }
  const count = 1 + (pricing.strong === null ? 0 : 1) + (pricing.fast === null ? 0 : 1);
  const n = formatWhole(count, locale);
  return {
    key: 'prices',
    label,
    tone: 'ok',
    state:
      count === 1
        ? $localize`:@@aiProvider.status.pricesSetOne:Set for 1 model`
        : $localize`:@@aiProvider.status.pricesSet:Set for ${n}:n: models`,
    sub: null,
    action: null,
  };
}
