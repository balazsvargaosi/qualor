// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import type { ReportJson } from './report';

const FORMULA = /^[=+\-@\t\r]/;

type Cell = string | number | boolean | null | undefined;

/** RFC 4180 with formula neutralising (4E-1 §2.5). */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const line = (cells: readonly Cell[]): string => `${cells.map(csvCell).join(',')}\r\n`;

export function* csvRows(report: ReportJson): Generator<string> {
  const ids = report.standards.map((s) => s.id);
  yield '﻿' +
    line([
      'section',
      'project',
      'path',
      'line',
      'rule',
      'rule_name',
      'engine',
      'severity',
      'kind',
      'cwe',
      'status',
      'in_new_code',
      'first_seen_at',
      ...ids,
      'triage_by',
      'triage_at',
      'triage_comment',
    ]);
  for (const f of report.findings) {
    yield line([
      f.section,
      f.project,
      f.path,
      f.line,
      f.rule,
      f.ruleName,
      f.engine,
      f.severity,
      f.kind,
      f.cwe.join(';'),
      'open',
      f.inNewCode,
      f.firstSeenAt,
      ...ids.map((id) => (f.categories[id] ?? []).join(';')),
      null,
      null,
      null,
    ]);
  }
  for (const t of report.triage) {
    yield line([
      t.section,
      t.project,
      t.path,
      t.line,
      t.rule,
      null,
      null,
      t.severity,
      null,
      t.cwe.join(';'),
      t.status,
      null,
      null,
      ...ids.map((id) => (t.categories[id] ?? []).join(';')),
      t.by,
      t.at,
      t.comment,
    ]);
  }
}
