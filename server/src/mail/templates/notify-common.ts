import { resolveMetricKey, type GateResult } from '@qualor/shared';
import { MAX_SUBJECT_LENGTH } from '../outbox';
import { clipChars, oneLine } from '../text';
import { html, type SafeHtml } from './html';
import type { FooterLink } from './layout';

/** Where a project notification links to. Every URL is null without QUALOR_PUBLIC_URL (E1 M11). */
export interface NotifyLinks {
  publicUrl: string | null;
  /** E1's instanceHost(publicUrl): the host the layout's header shows, null without a public URL. */
  instanceHost: string | null;
  /** `<publicUrl>/unsubscribe#t=<token>`: the UI page that asks, then stops watching. */
  unsubscribeUrl: string | null;
  /** `<publicUrl>/settings/notifications`. */
  settingsUrl: string | null;
}

export interface MailBranch {
  id: string;
  name: string;
  kind: 'branch' | 'merge_request';
  mrTitle: string | null;
  mrTargetBranch: string | null;
}

export type MeasureMap = Readonly<Record<string, number | null | undefined>>;

export interface GateMailInput {
  project: { id: string; name: string };
  branch: MailBranch;
  revision: string | null;
  gate: GateResult;
  measures: MeasureMap;
  /** `reevaluation`: an issue transition changed the verdict of the latest analysis (scm.md §7). */
  cause: 'analysis' | 'reevaluation';
  links: NotifyLinks;
}

export interface AnalysisFailedMailInput {
  project: { id: string; name: string };
  /** Null when the failure happened before a branch was known (an unreadable report). */
  branch: { name: string; kind: 'branch' | 'merge_request' } | null;
  revision: string | null;
  scannerVersion: string | null;
  error: { code: string; message: string } | null;
  links: NotifyLinks;
}

/** At most `max` characters (code points, never half a surrogate pair), ending in "…" if cut. */
export function clip(text: string, max: number): string {
  return [...text].length <= max ? text : `${clipChars(text, max - 1)}…`;
}

/** E1: `mail_messages.subject` is at most 300 characters, and a subject is one header line. */
export function subjectLine(text: string): string {
  return clip(oneLine(text), MAX_SUBJECT_LENGTH);
}

/** `main`, or `!42` for merge request 42 (the UI's merge request titles start the same way). */
export function branchLabel(branch: { name: string; kind: 'branch' | 'merge_request' }): string {
  return branch.kind === 'merge_request' ? `!${branch.name}` : branch.name;
}

/** The catalog's name (packages/shared metrics.ts); `new_x` reads "<name> on new code", as in the UI. */
export function metricLabel(key: string): string {
  const resolved = resolveMetricKey(key);
  if (!resolved) return key;
  return resolved.scope === 'new'
    ? `${resolved.definition.name} on new code`
    : resolved.definition.name;
}

const RATING_LETTERS = ['A', 'B', 'C', 'D', 'E'];

export function metricValue(key: string, value: number | null): string {
  if (value === null) return 'no value';
  const type = resolveMetricKey(key)?.definition.type;
  if (type === 'rating') return RATING_LETTERS[Math.round(value) - 1] ?? String(value);
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return type === 'percent' ? `${shown}%` : shown;
}

/** The operator in words: "greater than 0", "less than 80%", "worse than A". */
export function failsWhen(c: { metric: string; operator: 'gt' | 'lt'; threshold: number }): string {
  const rating = resolveMetricKey(c.metric)?.definition.type === 'rating';
  const word = rating
    ? c.operator === 'gt'
      ? 'worse than'
      : 'better than'
    : c.operator === 'gt'
      ? 'greater than'
      : 'less than';
  return `${word} ${metricValue(c.metric, c.threshold)}`;
}

const SEVERITIES = [
  ['blocker', 'Blocker'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
  ['info', 'Info'],
] as const;

/** "Blocker 0 · High 1 · …" from the `new_<severity>_issues` measures; null when none is known. */
export function newCodeCounts(measures: MeasureMap): string | null {
  const parts = SEVERITIES.flatMap(([key, label]) => {
    const value = measures[`new_${key}_issues`];
    return typeof value === 'number' ? [`${label} ${value}`] : [];
  });
  return parts.length === 0 ? null : parts.join(' · ');
}

export function paragraph(content: SafeHtml): SafeHtml {
  return html`<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#33455f">${content}</p>`;
}

/**
 * The failing conditions as a small table (metric, actual value, operator in words); null if none.
 * E1's text part reads each row as `Condition · value · fails when` on its own line.
 */
export function failingConditions(gate: GateResult): SafeHtml | null {
  const failed = gate.conditions.filter((c) => c.status === 'failed');
  if (failed.length === 0) return null;
  const cell = 'padding:6px 8px;border-top:1px solid #d7e0ec';
  const rows = failed.map(
    (c) =>
      html`<tr><td style="${cell}">${metricLabel(c.metric)}</td><td style="${cell};font-weight:bold">${metricValue(c.metric, c.value)}</td><td style="${cell}">${failsWhen(c)}</td></tr>`,
  );
  return html`<p style="margin:20px 0 8px;font-size:14px;font-weight:bold;color:#0a1b33">Failing conditions</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;color:#33455f"><tr><td style="padding:6px 8px;color:#4a5b73">Condition</td><td style="padding:6px 8px;color:#4a5b73">Value</td><td style="padding:6px 8px;color:#4a5b73">Fails when</td></tr>${rows}</table>`;
}

/** The branch page and its new issues in the UI; null without a public URL. */
export function branchLinks(input: Pick<GateMailInput, 'project' | 'branch' | 'links'>): {
  branch: string | null;
  newIssues: string | null;
} {
  const base = input.links.publicUrl;
  if (base === null) return { branch: null, newIssues: null };
  const project = `${base}/projects/${input.project.id}`;
  return {
    branch: `${project}/branches/${input.branch.id}`,
    newIssues: `${project}/issues?branch=${input.branch.id}&inNewCode=true`,
  };
}

export function gateIntro(input: GateMailInput, outcome: 'failed' | 'passes again'): SafeHtml {
  const label = branchLabel(input.branch);
  const gateName = input.gate.gate?.name;
  const changed = input.cause === 'reevaluation' ? ' after issues were changed' : '';
  const mr =
    input.branch.kind === 'merge_request'
      ? html` Merge request ${label}${input.branch.mrTitle ? html` “${input.branch.mrTitle}”` : ''}${input.branch.mrTargetBranch ? html` targets ${input.branch.mrTargetBranch}` : ''}.`
      : '';
  // Practically unreachable without a gate (`evaluateGate(null)` is status `none`), but never
  // "The quality gate quality gate failed".
  const gate = gateName === undefined ? '' : html` <strong>${gateName}</strong>`;
  return html`The quality gate${gate} ${outcome} on <strong>${label}</strong> of <strong>${input.project.name}</strong>${changed}.${mr}`;
}

export function gateFacts(input: GateMailInput): [string, string][] {
  const isMr = input.branch.kind === 'merge_request';
  const label = branchLabel(input.branch);
  return [
    ['Project', input.project.name],
    [
      isMr ? 'Merge request' : 'Branch',
      isMr && input.branch.mrTitle ? `${label} ${input.branch.mrTitle}` : label,
    ],
    ...(input.revision === null
      ? []
      : [['Revision', input.revision.slice(0, 7)] as [string, string]]),
    ['Gate', input.gate.gate?.name ?? 'None'],
  ];
}

/** mail E3: the reason line of a watch notification (plain text: E1's layout escapes it). */
export function watchReason(projectName: string): string {
  return `You get this because you watch ${oneLine(projectName)} in Qualor.`;
}

/** Its footer links (E1 `LayoutInput.footerLinks`), after the reason line; none without a public URL. */
export function watchFooterLinks(links: NotifyLinks): FooterLink[] {
  if (links.unsubscribeUrl === null || links.settingsUrl === null) return [];
  return [
    { label: 'Stop watching this project', url: links.unsubscribeUrl },
    { label: 'Notification settings', url: links.settingsUrl },
  ];
}

/** mail E3 N6: the reason line of the failing-webhook alert sent to an organisation's administrators. */
export function orgAdminReason(organizationName: string): string {
  return `You get this because you are an administrator of ${oneLine(organizationName)}. Change this in Notification settings.`;
}

/** Its footer link to Notification settings; none without a public URL. */
export function orgAdminFooterLinks(settingsUrl: string | null): FooterLink[] {
  return settingsUrl === null ? [] : [{ label: 'Notification settings', url: settingsUrl }];
}
