import type { ConditionResult } from '@qualor/shared';

/** What one tool answer's text may hold before it is cut (a model reads all of it). */
export const MAX_TEXT = 12_000;

/** The part of an issue (list or detail) the one-line form needs. */
export interface IssueListItem {
  id: string;
  severity: string;
  quality: string;
  rule: { key: string; name: string };
  message: string;
  path: string | null;
  startLine: number | null;
  inNewCode: boolean;
  status: string;
}

/** `src/db.ts:42 [high security] qualor:js.sqli — message (new code; id …)`: one line to act on. */
export function issueLine(i: IssueListItem): string {
  const where = i.path ? `${i.path}${i.startLine ? `:${i.startLine}` : ''}` : '(project)';
  const tags = i.inNewCode ? `new code; id ${i.id}` : `id ${i.id}`;
  return `${where} [${i.severity} ${i.quality}] ${i.rule.key} — ${i.message} (${tags})`;
}

/** `new_coverage is 61.5, must not be below 80`. */
export function conditionLine(c: ConditionResult): string {
  const bound =
    c.operator === 'lt' ? `must not be below ${c.threshold}` : `must not be above ${c.threshold}`;
  return c.value === null
    ? `${c.metric} has no value, ${bound}`
    : `${c.metric} is ${c.value}, ${bound}`;
}

export function truncate(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

/** Line ranges as `3, 7–9` (a range of one line is the line). */
export function lineRanges(ranges: readonly (readonly [number, number])[]): string {
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(', ');
}
