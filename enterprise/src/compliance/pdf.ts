// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { DETAIL_LIMIT } from './assemble';
import { SEVERITIES, type ReportJson, type SeverityCounts } from './report';

/** 4E-1 §2.5: the findings list, and the triage table, of the PDF hold at most this many rows. */
export const PDF_FINDINGS_MAX = 2_000;
const FULL_LIST = 'The full list is in the CSV and JSON exports.';
/** 50000 as "50 000". */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
/** In a truncated snapshot (`summary.truncated`) the exports do not hold the full lists either. */
const TRUNCATED_LIST = `The JSON and CSV exports list the first ${grouped(DETAIL_LIMIT)}; all counts are exact.`;
/** 4E-1 §2.5: the render budget. */
const RENDER_BUDGET_MS = 60_000;
const MESSAGE_MAX = 300;
const CELL_MAX = 120;
/** Rows laid out between two yields to the event loop, so a long render does not stall the server. */
const ROWS_PER_TICK = 200;

const FONT_FILES = { body: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' } as const;

export class RenderTimeoutError extends Error {
  constructor() {
    super('the PDF render ran past its deadline');
    this.name = 'RenderTimeoutError';
  }
}

/**
 * The directory of the Noto Sans files: `fonts/` next to the plugin in the image
 * (/app/enterprise/plugin.js), `../fonts/` from a local dist/plugin.js, `../../fonts/` from this
 * source file in tests. The first that holds NotoSans-Regular.ttf wins.
 */
export function defaultFontsDir(base: string | URL = import.meta.url): string {
  for (const relative of ['./fonts/', '../fonts/', '../../fonts/']) {
    const dir = fileURLToPath(new URL(relative, base));
    if (existsSync(path.join(dir, FONT_FILES.body))) return dir;
  }
  throw new Error(`the PDF fonts (${FONT_FILES.body}) are missing next to the plugin`);
}

/** Flattens whitespace and control characters, and cuts to `max` characters with an ellipsis. */
function cut(text: string, max: number): string {
  const flat = text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (flat.length <= max) return flat;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

const dash = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : String(value);
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '—');
const time = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
const rating = (value: number | null): string =>
  value === null ? '—' : (['A', 'B', 'C', 'D', 'E'][Math.round(value) - 1] ?? String(value));
const severityCells = (counts: SeverityCounts): string[] => SEVERITIES.map((s) => `${counts[s]}`);
const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const GATE: Record<string, string> = {
  passed: 'Passed',
  failed: 'Failed',
  error: 'Error',
  none: 'No gate',
};
const TRIAGE: Record<string, string> = { false_positive: 'False positive', wont_fix: "Won't fix" };

function categoryList(categories: Record<string, string[]>): string {
  return Object.entries(categories)
    .filter(([, ids]) => ids.length > 0)
    .map(([standard, ids]) => `${standard}: ${ids.join(', ')}`)
    .join('; ');
}

interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

const SIZE = { title: 22, heading: 14, subheading: 11, text: 9, table: 7.5, margin: 7.5 };
const COLOR = { text: '#111111', muted: '#555555', rule: '#cccccc', fill: '#eeeeee' };
const PAD = 3;
/**
 * Without ligatures: a ligature glyph (fi) maps back to one letter only when text is copied or
 * searched. fontkit takes an object of overrides, which the pdfkit typings do not describe.
 */
const FEATURES = { liga: false } as unknown as PDFKit.Mixins.OpenTypeFeatures[];

/** Lays the report out top to bottom on a buffered pdfkit document. */
class Layout {
  private rows = 0;

  constructor(
    readonly doc: PDFKit.PDFDocument,
    private readonly deadline: number,
  ) {}

  private get left(): number {
    return this.doc.page.margins.left;
  }

  get width(): number {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  page(): void {
    this.doc.addPage();
  }

  /** Starts a new page unless `height` more points fit on this one. */
  private room(height: number): void {
    if (this.doc.y + height > this.bottom) this.page();
  }

  heading(text: string, size = SIZE.heading): void {
    this.room(size * 3);
    if (this.doc.y > this.doc.page.margins.top) this.doc.moveDown(0.6);
    this.doc.font('bold').fontSize(size).fillColor(COLOR.text);
    this.doc.text(text, this.left, this.doc.y, { width: this.width, features: FEATURES });
    this.doc.moveDown(0.3);
  }

  text(text: string, color = COLOR.text): void {
    this.doc.font('body').fontSize(SIZE.text).fillColor(color);
    this.doc.text(text, this.left, this.doc.y, { width: this.width, features: FEATURES });
    this.doc.moveDown(0.3);
  }

  /** Label and value pairs, one per line, the label in bold. */
  fields(pairs: readonly (readonly [string, string])[]): void {
    for (const [label, value] of pairs) {
      this.room(SIZE.text * 2);
      this.doc.font('bold').fontSize(SIZE.text).fillColor(COLOR.text);
      this.doc.text(`${label}: `, this.left, this.doc.y, {
        width: this.width,
        continued: true,
        features: FEATURES,
      });
      this.doc.font('body').text(value, { features: FEATURES });
    }
    this.doc.moveDown(0.3);
  }

  private rowHeight(columns: readonly Column[], cells: readonly string[]): number {
    let height = 0;
    for (const [i, column] of columns.entries()) {
      const h = this.doc.heightOfString(cells[i] ?? '', {
        width: column.width - 2 * PAD,
        lineGap: 0,
        features: FEATURES,
      });
      if (h > height) height = h;
    }
    return height + 2 * PAD;
  }

  private drawRow(
    columns: readonly Column[],
    cells: readonly string[],
    y: number,
    height: number,
    header: boolean,
  ): void {
    const { doc } = this;
    if (header) doc.rect(this.left, y, this.width, height).fill(COLOR.fill);
    doc.fillColor(COLOR.text);
    let x = this.left;
    for (const [i, column] of columns.entries()) {
      doc.text(cells[i] ?? '', x + PAD, y + PAD, {
        width: column.width - 2 * PAD,
        align: column.align ?? 'left',
        lineGap: 0,
        features: FEATURES,
      });
      x += column.width;
    }
    doc
      .moveTo(this.left, y + height)
      .lineTo(this.left + this.width, y + height)
      .lineWidth(0.5)
      .strokeColor(COLOR.rule)
      .stroke();
  }

  private header(columns: readonly Column[]): void {
    const cells = columns.map((c) => c.header);
    this.doc.font('bold').fontSize(SIZE.table);
    const height = this.rowHeight(columns, cells);
    this.room(height * 3);
    const y = this.doc.y;
    this.drawRow(columns, cells, y, height, true);
    this.doc.y = y + height;
  }

  /** A table whose header repeats on every page it spans; the deadline is checked before each row. */
  async table(columns: readonly Column[], rows: Iterable<readonly string[]>): Promise<void> {
    this.header(columns);
    for (const cells of rows) {
      if (Date.now() > this.deadline) throw new RenderTimeoutError();
      if (++this.rows % ROWS_PER_TICK === 0) await new Promise<void>((r) => setImmediate(r));
      this.doc.font('body').fontSize(SIZE.table);
      const height = this.rowHeight(columns, cells);
      if (this.doc.y + height > this.bottom) {
        this.page();
        this.header(columns);
        this.doc.font('body').fontSize(SIZE.table);
      }
      const y = this.doc.y;
      this.drawRow(columns, cells, y, height, false);
      this.doc.y = y + height;
    }
    this.doc.moveDown(0.6);
  }

  /** Writes the header (the scope) and the footer (page n of m, the report id) on every page. */
  frame(scope: string, reportId: string): void {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const { margins } = doc.page;
      const saved = { top: margins.top, bottom: margins.bottom };
      // Text in the margins would otherwise start a new page.
      margins.top = 0;
      margins.bottom = 0;
      doc.font('body').fontSize(SIZE.margin).fillColor(COLOR.muted);
      doc.text(scope, this.left, 32, { width: this.width, lineBreak: false, features: FEATURES });
      doc.text(
        `Page ${i - range.start + 1} of ${range.count} · ${reportId}`,
        this.left,
        doc.page.height - 36,
        { width: this.width, lineBreak: false, align: 'center', features: FEATURES },
      );
      margins.top = saved.top;
      margins.bottom = saved.bottom;
    }
  }
}

function scopeLine(report: ReportJson): string {
  const { organization, project, branch } = report.scope;
  return cut([organization.name, project?.key, branch?.name].filter(Boolean).join(' / '), CELL_MAX);
}

function cover(layout: Layout, report: ReportJson, sha256: string): Promise<void> {
  const { scope } = report;
  layout.page();
  layout.doc.moveDown(4);
  layout.heading('Qualor compliance report', SIZE.title);
  layout.text(
    scope.kind === 'project' && scope.project
      ? `Project ${scope.project.name} (${scope.project.key}), branch ${dash(scope.branch?.name)}, ` +
          `organisation ${scope.organization.name}`
      : `Organisation ${scope.organization.name}: the main branch of each of its ` +
          `${report.projects.length} projects`,
  );
  layout.doc.moveDown(1);
  layout.fields([
    ['Generated', time(report.generatedAt)],
    ['Generated by', report.generatedBy],
    ['Server version', report.server.version],
    ['Report id', report.id],
    ['SHA-256 of the JSON export', sha256],
  ]);
  layout.text(
    'The JSON export of this report has the SHA-256 above: compare them to check that this PDF ' +
      'and the JSON are the same snapshot.',
    COLOR.muted,
  );
  layout.heading('Standards', SIZE.subheading);
  return layout.table(
    [
      { header: 'Standard', width: 150 },
      { header: 'Version', width: 50 },
      { header: 'Licence', width: 100 },
      { header: 'Source', width: layout.width - 300 },
    ],
    report.standards.map((s) => [
      cut(s.title, CELL_MAX),
      cut(s.version, CELL_MAX),
      cut(s.licence, CELL_MAX),
      cut(s.source, CELL_MAX),
    ]),
  );
}

async function executiveSummary(layout: Layout, report: ReportJson): Promise<void> {
  const { summary } = report;
  layout.page();
  layout.heading('Executive summary');
  const severityColumns: Column[] = SEVERITIES.map((s) => ({
    header: capitalised(s),
    width: 50,
    align: 'right',
  }));
  await layout.table(
    [
      { header: 'Open', width: layout.width - 300 },
      { header: 'Total', width: 50, align: 'right' },
      ...severityColumns,
    ],
    [
      ['All findings', `${summary.findings.total}`, ...severityCells(summary.findings.bySeverity)],
      [
        'Dependencies',
        `${summary.dependencies.open}`,
        ...severityCells(summary.dependencies.bySeverity),
      ],
    ],
  );
  layout.fields([
    ['Open findings in new code', `${summary.findings.inNewCode}`],
    ['Open secrets', `${summary.secrets.open}`],
    ['Triaged as false positive', `${summary.triage.falsePositive}`],
    ["Triaged as won't fix", `${summary.triage.wontFix}`],
  ]);
  if (summary.truncated) {
    layout.text(
      'The report lists only part of the findings or triage decisions; the counts are exact.',
      COLOR.muted,
    );
  }
  layout.heading('Projects', SIZE.subheading);
  await layout.table(
    [
      { header: 'Project', width: 130 },
      { header: 'Branch', width: 60 },
      { header: 'Last analysis', width: 110 },
      { header: 'Quality gate', width: 60 },
      { header: 'Security issues', width: 70, align: 'right' },
      { header: 'Security rating', width: layout.width - 430, align: 'right' },
    ],
    report.projects.map((p) => {
      const latest = p.trend.at(-1);
      return [
        cut(`${p.name} (${p.key})`, CELL_MAX),
        cut(dash(p.branch), CELL_MAX),
        p.analysis
          ? cut(`${day(p.analysis.date)} ${p.analysis.revision ?? ''}`.trim(), CELL_MAX)
          : 'Never analysed',
        p.gate ? (GATE[p.gate.status] ?? p.gate.status) : '—',
        dash(latest?.security_issues),
        rating(latest?.security_rating ?? null),
      ];
    }),
  );
  const failed = report.projects.flatMap((p) =>
    (p.gate?.failedConditions ?? []).map((c) => [
      cut(p.key, CELL_MAX),
      cut(c.metric, CELL_MAX),
      `${c.op === 'gt' ? '>' : '<'} ${c.threshold}`,
      dash(c.actual),
    ]),
  );
  if (failed.length > 0) {
    layout.heading('Failed gate conditions', SIZE.subheading);
    await layout.table(
      [
        { header: 'Project', width: 130 },
        { header: 'Metric', width: layout.width - 330 },
        { header: 'Fails when', width: 100, align: 'right' },
        { header: 'Actual', width: 100, align: 'right' },
      ],
      failed,
    );
  }
  const only = report.projects.length === 1 ? report.projects[0] : undefined;
  if (only && only.trend.length > 0) {
    layout.heading('Trend', SIZE.subheading);
    await layout.table(
      [
        { header: 'Analysis date', width: 150 },
        { header: 'Security issues', width: 100, align: 'right' },
        { header: 'Security rating', width: 100, align: 'right' },
      ],
      only.trend.map((t) => [day(t.date), dash(t.security_issues), rating(t.security_rating)]),
    );
  }
}

async function standards(layout: Layout, report: ReportJson): Promise<void> {
  for (const s of report.summary.standards) {
    const standard = report.standards.find((d) => d.id === s.id);
    layout.page();
    layout.heading(standard ? `${standard.title} (${standard.version})` : s.id);
    if (standard) {
      layout.text(`Source: ${standard.source} · Licence: ${standard.licence}`, COLOR.muted);
    }
    layout.text(`Open findings in at least one category or not mapped: ${s.distinctTotal}`);
    layout.text(
      'A finding can count in more than one category; the total counts each finding once.',
      COLOR.muted,
    );
    const fixed = 44 + 32 + 5 * 38 + 28 + 30 + 52;
    await layout.table(
      [
        { header: 'Id', width: 44 },
        { header: 'Category', width: layout.width - fixed },
        { header: 'Open', width: 32, align: 'right' },
        ...SEVERITIES.map((sev) => ({
          header: capitalised(sev),
          width: 38,
          align: 'right' as const,
        })),
        { header: 'New', width: 28, align: 'right' },
        { header: 'Rules', width: 30, align: 'right' },
        { header: 'Oldest', width: 52, align: 'right' },
      ],
      [
        ...s.categories.map((c) => [
          cut(c.id, CELL_MAX),
          cut(c.title, CELL_MAX),
          `${c.open}`,
          ...severityCells(c.bySeverity),
          `${c.inNewCode}`,
          `${c.rules}`,
          day(c.oldestFirstSeenAt),
        ]),
        [
          '—',
          'Not mapped',
          `${s.notMapped.open}`,
          ...severityCells(s.notMapped.bySeverity),
          `${s.notMapped.inNewCode}`,
          `${s.notMapped.rules}`,
          '—',
        ],
      ],
    );
  }
}

/**
 * One row per rule of a section's listed findings: severity, open count, oldest first seen. In a
 * truncated snapshot the list holds only part of the findings, and so do these rows.
 */
function byRule(report: ReportJson, section: 'secret' | 'dependency'): string[][] {
  const rules = new Map<string, { name: string; severity: string; open: number; oldest: string }>();
  for (const f of report.findings) {
    if (f.section !== section) continue;
    const row = rules.get(f.rule);
    if (!row) {
      rules.set(f.rule, { name: f.ruleName, severity: f.severity, open: 1, oldest: f.firstSeenAt });
    } else {
      row.open += 1;
      if (f.firstSeenAt < row.oldest) row.oldest = f.firstSeenAt;
    }
  }
  return [...rules.entries()].map(([rule, r]) => [
    cut(rule, CELL_MAX),
    cut(r.name, CELL_MAX),
    capitalised(r.severity),
    `${r.open}`,
    day(r.oldest),
  ]);
}

async function secretsAndDependencies(layout: Layout, report: ReportJson): Promise<void> {
  const columns: Column[] = [
    { header: 'Rule', width: 150 },
    { header: 'Name', width: layout.width - 310 },
    { header: 'Severity', width: 50 },
    { header: 'Open', width: 50, align: 'right' },
    { header: 'Oldest', width: 60, align: 'right' },
  ];
  const rulesTable = async (rows: string[][]): Promise<void> => {
    if (rows.length === 0) return;
    if (report.summary.truncated) layout.text('Rules among the listed findings', COLOR.muted);
    await layout.table(columns, rows);
  };
  layout.page();
  layout.heading('Secrets');
  layout.text(`Open secrets: ${report.summary.secrets.open}`);
  await rulesTable(byRule(report, 'secret'));
  layout.heading('Dependencies');
  layout.text(`Open dependency findings: ${report.summary.dependencies.open}`);
  await rulesTable(byRule(report, 'dependency'));
}

/** The note under a list the PDF cuts: where the rest is, or, in a truncated snapshot, is not. */
const restNote = (report: ReportJson): string =>
  report.summary.truncated ? TRUNCATED_LIST : FULL_LIST;

async function triage(layout: Layout, report: ReportJson): Promise<void> {
  const { summary } = report;
  layout.page();
  layout.heading('Triage decisions');
  layout.text(
    `False positive: ${summary.triage.falsePositive} · Won't fix: ${summary.triage.wontFix}`,
  );
  if (report.triage.length === 0) return;
  // Exact, even when the snapshot lists only part of the decisions.
  const total = summary.triage.falsePositive + summary.triage.wontFix;
  // The newest decisions first, as the report lists them (4E-1 §2.3).
  const shown = Math.min(report.triage.length, PDF_FINDINGS_MAX);
  if (shown < total) layout.text(`The newest ${shown} of ${total} decisions.`);
  await layout.table(
    [
      { header: 'Project', width: 44 },
      { header: 'Path', width: 78 },
      { header: 'Line', width: 26, align: 'right' },
      { header: 'Rule', width: 64 },
      { header: 'Status', width: 44 },
      { header: 'Categories', width: 66 },
      { header: 'By', width: 46 },
      { header: 'At', width: 52 },
      { header: 'Comment', width: layout.width - 420 },
    ],
    (function* () {
      for (const t of report.triage.slice(0, shown)) {
        yield [
          cut(t.project, CELL_MAX),
          cut(dash(t.path), CELL_MAX),
          dash(t.line),
          cut(t.rule, CELL_MAX),
          TRIAGE[t.status] ?? t.status,
          cut(dash(categoryList(t.categories)), CELL_MAX),
          cut(dash(t.by), CELL_MAX),
          day(t.at),
          cut(dash(t.comment), CELL_MAX),
        ];
      }
    })(),
  );
  if (shown < total) layout.text(restNote(report));
}

async function findings(layout: Layout, report: ReportJson): Promise<void> {
  // Exact, even when the snapshot lists only part of the findings.
  const total = report.summary.findings.total;
  const shown = Math.min(report.findings.length, PDF_FINDINGS_MAX);
  layout.page();
  layout.heading('Findings');
  layout.text(
    shown < total
      ? `The first ${shown} of ${total} open findings, by severity.`
      : `${total} open findings, by severity.`,
  );
  if (shown > 0) {
    await layout.table(
      [
        { header: 'Severity', width: 40 },
        { header: 'Project', width: 48 },
        { header: 'Path', width: 104 },
        { header: 'Line', width: 26, align: 'right' },
        { header: 'Rule', width: 70 },
        { header: 'Message', width: layout.width - 340 },
        { header: 'First seen', width: 52 },
      ],
      (function* () {
        for (const f of report.findings.slice(0, shown)) {
          yield [
            capitalised(f.severity),
            cut(f.project, CELL_MAX),
            cut(dash(f.path), CELL_MAX),
            dash(f.line),
            cut(f.rule, CELL_MAX),
            cut(f.message, MESSAGE_MAX),
            day(f.firstSeenAt),
          ];
        }
      })(),
    );
  }
  if (shown < total || report.summary.truncated) {
    layout.text(restNote(report));
  }
}

/**
 * 4E-1 §2.5: the report as an A4 PDF in Noto Sans, byte-identical across renders of one snapshot.
 * pdfkit 0.20.2 puts no time or random value in the file: the dates come from `info`, the file
 * /ID is the MD5 of `info` (which names the report's SHA-256), and the font subset tags derive
 * from the font ids (F1, F2), not from Math.random. The byte-identity test guards this.
 * `sha256` is the stored SHA-256 of the canonical JSON; without it, the report is re-serialised
 * (its canonical form, as parsed from the snapshot) and hashed.
 */
export async function renderPdf(
  report: ReportJson,
  options: { fontsDir?: string; deadline?: number; sha256?: string } = {},
): Promise<Buffer> {
  const fontsDir = options.fontsDir ?? defaultFontsDir();
  const deadline = options.deadline ?? Date.now() + RENDER_BUDGET_MS;
  const sha256 =
    options.sha256 ?? createHash('sha256').update(JSON.stringify(report)).digest('hex');
  const generatedAt = new Date(report.generatedAt);
  const body = path.join(fontsDir, FONT_FILES.body);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 56, left: 48, right: 48 },
    bufferPages: true,
    autoFirstPage: false,
    compress: true,
    // No default font: the built-in Helvetica (no Cyrillic) is never loaded. (A path here would be
    // cached under the path, and every doc.font('body') would re-open and re-parse the file.)
    font: null as unknown as string,
    info: {
      Title: 'Qualor compliance report',
      Author: report.generatedBy,
      Subject: `Report ${report.id}, SHA-256 ${sha256}`,
      Creator: 'Qualor',
      Producer: 'Qualor',
      CreationDate: generatedAt,
      ModDate: generatedAt,
    },
  });
  doc.registerFont('body', body);
  doc.registerFont('bold', path.join(fontsDir, FONT_FILES.bold));
  doc.font('body');
  const layout = new Layout(doc, deadline);
  await cover(layout, report, sha256);
  await executiveSummary(layout, report);
  await standards(layout, report);
  await secretsAndDependencies(layout, report);
  await triage(layout, report);
  await findings(layout, report);
  layout.frame(scopeLine(report), report.id);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.end();
  return done;
}
