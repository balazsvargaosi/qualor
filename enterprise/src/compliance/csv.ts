// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { CSV_BOM, csvLine as line } from '../csv';
import type { ReportJson } from './report';

export function* csvRows(report: ReportJson): Generator<string> {
  const ids = report.standards.map((s) => s.id);
  yield CSV_BOM +
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
