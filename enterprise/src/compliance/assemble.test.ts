// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComplianceSource } from '@qualor/server/plugin-contract';
import { assembleReport, categoriesOf, parseCanonical } from './assemble';
import type { StandardData } from './standard';

const STD: StandardData = {
  id: 's',
  family: 'owasp-top10',
  version: '1',
  title: 'S',
  source: 'src',
  licence: 'L',
  sourceSha256: '0'.repeat(64),
  categories: [
    { id: 'A', title: 'Injection', cwe: [89, 78] },
    { id: 'B', title: 'Secrets', cwe: [798, 89] },
    { id: 'H', title: 'High', cwe: [], severities: ['blocker', 'high'] },
  ],
};

const source = (over: Partial<ComplianceSource> = {}): ComplianceSource => ({
  generatedAt: '2026-10-12T10:00:00.000Z',
  createdBy: 'Ann',
  scope: {
    kind: 'project',
    organization: { id: 'o', key: 'acme', name: 'Acme' },
    project: { id: 'p', key: 'alpha', name: 'Alpha' },
    branch: { id: 'b', name: 'main' },
  },
  projects: [
    {
      id: 'p',
      key: 'alpha',
      name: 'Alpha',
      branch: { id: 'b', name: 'main' },
      analysis: null,
      gate: null,
      trend: [],
    },
  ],
  groups: [
    {
      status: 'open',
      section: 'code',
      rule: 'semgrep:sqli',
      severity: 'high',
      kind: 'issue',
      inNewCode: true,
      cwe: [89],
      count: 2,
      oldestFirstSeenAt: '2026-01-01T00:00:00.000Z',
    },
    {
      status: 'open',
      section: 'secret',
      rule: 'gitleaks:aws',
      severity: 'blocker',
      kind: 'issue',
      inNewCode: false,
      cwe: [798],
      count: 1,
      oldestFirstSeenAt: '2026-02-01T00:00:00.000Z',
    },
    {
      status: 'open',
      section: 'code',
      rule: 'x:hot',
      severity: 'low',
      kind: 'hotspot',
      inNewCode: false,
      cwe: [],
      count: 3,
      oldestFirstSeenAt: '2026-03-01T00:00:00.000Z',
    },
    {
      status: 'false_positive',
      section: 'code',
      rule: 'semgrep:sqli',
      severity: 'high',
      kind: 'issue',
      inNewCode: false,
      cwe: [89],
      count: 1,
      oldestFirstSeenAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  findings: [
    {
      id: 'f1',
      project: 'alpha',
      path: 'a.ts',
      line: 1,
      rule: 'semgrep:sqli',
      ruleName: 'SQLi',
      engine: 'semgrep',
      severity: 'high',
      kind: 'issue',
      cwe: [89],
      message: 'm',
      inNewCode: true,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      section: 'code',
    },
    {
      id: 'f2',
      project: 'alpha',
      path: 'b.ts',
      line: 2,
      rule: 'semgrep:sqli',
      ruleName: 'SQLi',
      engine: 'semgrep',
      severity: 'high',
      kind: 'issue',
      cwe: [89],
      message: 'm',
      inNewCode: true,
      firstSeenAt: '2026-01-02T00:00:00.000Z',
      section: 'code',
    },
  ],
  triage: [
    {
      id: 't1',
      project: 'alpha',
      path: 'c.ts',
      line: 3,
      rule: 'semgrep:sqli',
      severity: 'low',
      cwe: [798],
      status: 'false_positive',
      section: 'code',
      by: 'Bob',
      at: '2026-02-02T00:00:00.000Z',
      comment: 'ok',
    },
  ],
  ...over,
});

describe('assembleReport (4E-1 §2.2, §2.3)', () => {
  it('maps a finding to every matching category, severities included', () => {
    expect(categoriesOf(STD, [89], 'high')).toEqual(['A', 'B', 'H']);
    expect(categoriesOf(STD, [], 'low')).toEqual([]);
  });

  it('counts categories from the groups: multi-category, not mapped, rules, oldest', () => {
    const { summary } = assembleReport({
      id: 'r',
      generatedBy: 'Ann',
      serverVersion: '0.8.0',
      source: source(),
      standards: [STD],
    });
    const s = summary.standards[0]!;
    expect(s.categories.find((c) => c.id === 'A')).toMatchObject({
      open: 2,
      inNewCode: 2,
      rules: 1,
      oldestFirstSeenAt: '2026-01-01T00:00:00.000Z',
    });
    expect(s.categories.find((c) => c.id === 'B')!.open).toBe(3); // sqli 2 + secret 1
    expect(s.categories.find((c) => c.id === 'H')!.open).toBe(3); // high 2 + blocker 1
    expect(s.notMapped).toMatchObject({ open: 3, rules: 1 });
    expect(s.distinctTotal).toBe(6);
    expect(summary.findings).toEqual({
      total: 6,
      bySeverity: { blocker: 1, high: 2, medium: 0, low: 3, info: 0 },
      inNewCode: 2,
    });
    expect(summary.secrets.open).toBe(1);
    expect(summary.triage).toEqual({ falsePositive: 1, wontFix: 0 });
    expect(summary.truncated).toBe(false);
  });

  it('truncates the detail lists, keeps exact counts, and flags it', () => {
    const { json, summary } = assembleReport({
      id: 'r',
      generatedBy: 'Ann',
      serverVersion: '0.8.0',
      source: source(),
      standards: [STD],
      limit: 1,
    });
    expect(json.findings).toHaveLength(1);
    expect(summary.truncated).toBe(true);
    expect(summary.findings.total).toBe(6);
  });

  it('writes canonical bytes: stable, schema key order, sha256 of the bytes', () => {
    const a = assembleReport({
      id: 'r',
      generatedBy: 'Ann',
      serverVersion: '0.8.0',
      source: source(),
      standards: [STD],
    });
    const b = assembleReport({
      id: 'r',
      generatedBy: 'Ann',
      serverVersion: '0.8.0',
      source: source(),
      standards: [STD],
    });
    expect(a.canonical.equals(b.canonical)).toBe(true);
    expect(a.sha256).toBe(createHash('sha256').update(a.canonical).digest('hex'));
    expect(Object.keys(JSON.parse(a.canonical.toString('utf8')))).toEqual([
      'schemaVersion',
      'id',
      'generatedAt',
      'generatedBy',
      'server',
      'scope',
      'standards',
      'projects',
      'summary',
      'findings',
      'triage',
    ]);
    expect(a.canonical.toString('utf8')).not.toMatch(/\n/);
    expect(parseCanonical(a.canonical)).toEqual(a.json);
    expect(a.json.findings[0]!.categories).toEqual({ s: ['A', 'B', 'H'] });
    // R2: triage entries carry computed categories, in spec key order
    expect(a.json.triage[0]!.categories).toEqual({ s: ['B'] });
    expect(Object.keys(a.json.triage[0]!)).toEqual([
      'id',
      'project',
      'path',
      'line',
      'rule',
      'severity',
      'cwe',
      'categories',
      'status',
      'section',
      'by',
      'at',
      'comment',
    ]);
  });
});
