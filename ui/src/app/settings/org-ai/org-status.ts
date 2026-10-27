import { formatDate } from '../../shared/date-time.pipe';
import { formatWhole } from '../../shared/numbers';
import type { StatusLine, StatusMeter } from '../../shared/status-list';
import type { OrgAi, OrgAiReview } from '../ai-review';
import { type SelectionSummary, summaryText } from './review-state';

type Feature = keyof OrgAi['features'];
const FEATURES: readonly Feature[] = ['explain', 'triage', 'fix'];

/** AI review as saved: off, on, or on while its consent no longer covers the provider. */
export type ReviewState = 'off' | 'on' | 'paused';

export function reviewStateOf(settings: OrgAiReview | null): ReviewState {
  if (!settings?.enabled) return 'off';
  return settings.consentCurrent ? 'on' : 'paused';
}

/** What the organisation's Status card says besides the review as saved. */
export interface OrgStatusContext {
  /** What the saved scope and projects give AI review; null until the projects are in. */
  summary: SelectionSummary | null;
  /** The organisation's name. */
  organization: string;
  /** The viewer: a notice they confirmed is confirmed "by you". */
  viewerId: string | null;
  /** The assistant's features, budgets and today's use; null while they are not read. */
  assistant: OrgAi | null;
  locale: string;
}

/**
 * The organisation's AI as its Status card says it (spec §3.5), from what is saved:
 *
 * - AI review: off, with what the saved selection would review; on, with how many projects it
 *   reviews and who confirmed the notice for which provider; paused while that confirmation no
 *   longer covers the provider set now, with what was confirmed and what the provider is now;
 * - today's use: AI review against the smaller of its budget and the instance's cap, then the
 *   assistant, once read;
 * - the assistant's features as the instance admin chose them, once read.
 *
 * The page adds the automatic fix suggestions' line after them.
 */
export function orgStatusLines(settings: OrgAiReview, context: OrgStatusContext): StatusLine[] {
  const lines = [reviewLine(settings, context), todayLine(settings, context)];
  const assistant = assistantLine(context);
  if (assistant !== null) lines.push(assistant);
  return lines;
}

function states() {
  return {
    off: $localize`:@@orgAi.state.off:Off`,
    on: $localize`:@@orgAi.state.on:On`,
    paused: $localize`:@@orgAi.state.paused:Paused`,
  };
}

function reviewLine(settings: OrgAiReview, context: OrgStatusContext): StatusLine {
  const label = $localize`:@@orgAi.status.review:AI review`;
  const { summary, organization, locale } = context;
  switch (reviewStateOf(settings)) {
    case 'off':
      return {
        key: 'review',
        label,
        tone: 'off',
        state: states().off,
        sub: summary === null ? null : summaryText(summary, settings.scope, organization, locale),
        action: {
          id: 'switch-on',
          label: $localize`:@@orgAi.action.switchOn:Switch on AI review…`,
          primary: true,
        },
      };
    case 'on':
      return {
        key: 'review',
        label,
        tone: 'ok',
        state: states().on,
        text: summary === null ? null : reviewingText(summary.reviewable, locale),
        sub: confirmedText(settings, context),
        action: {
          id: 'switch-off',
          label: $localize`:@@orgAi.action.switchOff:Switch off AI review`,
        },
      };
    case 'paused':
      return {
        key: 'review',
        label,
        tone: 'attention',
        state: states().paused,
        text: $localize`:@@orgAi.status.changed:The AI provider changed`,
        sub: pausedText(settings, locale),
        action: {
          id: 'confirm',
          label: $localize`:@@orgAi.action.confirm:Review and confirm…`,
          primary: true,
        },
      };
  }
}

function reviewingText(count: number, locale: string): string {
  return count === 1
    ? $localize`:@@orgAi.status.reviewingOne:Reviewing 1 project`
    : $localize`:@@orgAi.status.reviewing:Reviewing ${formatWhole(count, locale)}:count: projects`;
}

/** Who confirmed the notice, when, and for which host and model ("by you" for the viewer). */
function confirmedText(settings: OrgAiReview, context: OrgStatusContext): string | null {
  const consent = settings.consent;
  if (consent === null) return null;
  const date = formatDate(consent.at, context.locale);
  const host = consent.providerHost;
  const model = consent.model;
  return consent.userId === context.viewerId
    ? $localize`:@@orgAi.status.confirmedByYou:Confirmed on ${date}:date: (by you) for ${host}:host: (${model}:model:).`
    : $localize`:@@orgAi.status.confirmed:Confirmed on ${date}:date: for ${host}:host: (${model}:model:).`;
}

/**
 * What was confirmed and what the provider is now. The answer leaves out the consent's set of
 * models (review.md §2.5), so the confirmed side names the standard model alone.
 */
function pausedText(settings: OrgAiReview, locale: string): string | null {
  const consent = settings.consent;
  const provider = settings.provider;
  if (consent === null || provider === null) return null;
  const oldHost = consent.providerHost;
  const oldModel = consent.model;
  const date = formatDate(consent.at, locale);
  const host = provider.host;
  const models = provider.models.join(', ');
  return $localize`:@@orgAi.status.pausedSub:You confirmed ${oldHost}:oldHost: (${oldModel}:oldModel:) on ${date}:date:. It now uses ${host}:host: (${models}:models:). No merge request is reviewed until you confirm.`;
}

/** Today's use: AI review against the smaller of its budget and the cap, then the assistant. */
function todayLine(settings: OrgAiReview, context: OrgStatusContext): StatusLine {
  const { locale } = context;
  const whole = (n: number) => formatWhole(n, locale);
  const usd = (amount: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount);
  const { tokensToday, reviewsToday, costTodayUsd } = settings.usage;
  const ceiling = settings.instanceCeiling.tokensPerDay;
  const reviews =
    reviewsToday === 1
      ? $localize`:@@orgAi.today.reviewsOne:1 review`
      : $localize`:@@orgAi.today.reviews:${whole(reviewsToday)}:count: reviews`;
  const meters: StatusMeter[] = [
    {
      label: $localize`:@@orgAi.today.review:AI review`,
      value: tokensToday,
      max:
        ceiling === null
          ? settings.budgets.tokensPerDay
          : Math.min(settings.budgets.tokensPerDay, ceiling),
      note:
        costTodayUsd === null
          ? reviews
          : $localize`:@@orgAi.today.reviewsCost:${reviews}:reviews: · ${usd(costTodayUsd)}:cost:`,
    },
  ];
  const assistant = context.assistant;
  if (assistant !== null) {
    const { explain, triage, fix, tokens } = assistant.usage;
    meters.push({
      label: $localize`:@@orgAi.today.assistant:Assistant`,
      value: tokens,
      max: assistant.budgets.tokensPerDay,
      note: $localize`:@@orgAi.today.assistantNote:Explanations ${whole(explain)}:explain: · Triage ${whole(triage)}:triage: · Fixes ${whole(fix)}:fix:`,
    });
  }
  return {
    key: 'today',
    label: $localize`:@@orgAi.status.today:Today`,
    tone: 'off',
    state: '',
    meters,
  };
}

/** The assistant's features as the instance admin chose them: on if any is. */
function assistantLine(context: OrgStatusContext): StatusLine | null {
  const assistant = context.assistant;
  if (assistant === null) return null;
  const names: Record<Feature, string> = {
    explain: $localize`:@@orgAi.feature.explain:Explain`,
    triage: $localize`:@@orgAi.feature.triage:Suggest triage`,
    fix: $localize`:@@orgAi.feature.fix:Suggest a fix`,
  };
  const list = (features: readonly Feature[]) =>
    new Intl.ListFormat(context.locale, { type: 'conjunction' }).format(
      features.map((f) => names[f]),
    );
  const on = FEATURES.filter((f) => assistant.features[f]);
  const off = FEATURES.filter((f) => !assistant.features[f]);
  let text: string;
  if (off.length === 0) text = $localize`:@@orgAi.assistant.allOn:${list(on)}:on: on.`;
  else if (on.length === 0) text = $localize`:@@orgAi.assistant.allOff:${list(off)}:off: off.`;
  else text = $localize`:@@orgAi.assistant.features:${list(on)}:on: on, ${list(off)}:off: off.`;
  return {
    key: 'assistant',
    label: $localize`:@@orgAi.status.assistant:Assistant`,
    tone: on.length > 0 ? 'ok' : 'off',
    state: on.length > 0 ? states().on : states().off,
    text,
    sub: $localize`:@@orgAi.assistant.who:An instance admin chooses them.`,
  };
}
