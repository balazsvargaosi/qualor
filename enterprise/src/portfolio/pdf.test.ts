// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { RenderTimeoutError } from '../pdf/layout';
import { PDF_PROJECTS_MAX, renderPortfolioPdf } from './pdf';
import { sampleOverview, sampleRow, sampleRows } from './test-overview';

const OPTIONS = { generatedBy: 'Ann Admin', serverVersion: '0.7.1' };

async function textOf(pdf: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    text +=
      (await page.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
  }
  return text;
}

describe('renderPortfolioPdf (4E-2 §3)', () => {
  it('renders the cover, totals, trend, organisations and attention lists', async () => {
    const overview = sampleOverview();
    const pdf = await renderPortfolioPdf(overview, sampleRows(), OPTIONS);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await textOf(pdf);
    // The cover.
    expect(text).toContain('Qualor portfolio report');
    expect(text).toContain('All organisations');
    expect(text).toContain('Ann Admin');
    expect(text).toContain('0.7.1');
    expect(text).toContain('Weekly');
    // The totals: grouped lines of code, one-decimal percentages.
    expect(text).toContain('12 345');
    expect(text).toContain('71.3%');
    expect(text).toContain('50.0%');
    // The trend: week start dates as the period labels.
    expect(text).toContain('2026-07-27');
    expect(text).toContain('2026-10-12');
    // The organisations, the attention lists and the project list.
    expect(text).toContain('Mobile apps');
    expect(text).toContain('Platform team');
    expect(text).toContain('Failing quality gates');
    expect(text).toContain('Abandoned projects');
    expect(text).toContain('Project 2 (proj-002)');
    // Header and footer: the footer id is generatedAt.
    expect(text).toMatch(/Page 1 of \d+ · 2026-10-13T09:30:00\.000Z/);
    // A null prints as a dash; ligatures are off.
    expect(text).toContain('—');
    const raw = pdf.toString('latin1');
    expect(raw).not.toContain('Helvetica');
    const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
    expect((await doc.getMetadata()).info).toMatchObject({ CreationDate: 'D:20261013093000Z' });
  });

  it('is byte-identical across renders of the same input', async () => {
    const a = await renderPortfolioPdf(sampleOverview(), sampleRows(), OPTIONS);
    const b = await renderPortfolioPdf(sampleOverview(), sampleRows(), OPTIONS);
    expect(a.equals(b)).toBe(true);
  });

  it('has no organisations table in the organisation scope', async () => {
    const rows = sampleRows().filter((r) => r.organization.key === 'platform');
    const text = await textOf(
      await renderPortfolioPdf(sampleOverview('organization'), rows, OPTIONS),
    );
    expect(text).toContain('Organisation Platform team (platform)');
    expect(text).not.toContain('Mobile apps');
    expect(text).not.toContain('Organisations');
  });

  it('lists the first 50 projects and says the CSV has them all', async () => {
    const overview = sampleOverview();
    overview.totals.projects = 60;
    const rows = Array.from({ length: 60 }, (_, i) => sampleRow(i));
    const text = await textOf(await renderPortfolioPdf(overview, rows, OPTIONS));
    expect(PDF_PROJECTS_MAX).toBe(50);
    expect(text).toContain('The first 50 of 60 projects');
    expect(text).toContain('The CSV export lists every project.');
    expect(text).toContain('(proj-049)');
    expect(text).not.toContain('(proj-050)');
  });

  it('prints Cyrillic in a project name', async () => {
    const rows = sampleRows();
    rows[0]!.project.name = 'Платёжный шлюз';
    const text = await textOf(await renderPortfolioPdf(sampleOverview(), rows, OPTIONS));
    expect(text).toContain('Платёжный шлюз');
  });

  it('labels a monthly trend by month', async () => {
    const overview = sampleOverview();
    overview.granularity = 'month';
    const text = await textOf(await renderPortfolioPdf(overview, sampleRows(), OPTIONS));
    expect(text).toContain('Monthly');
    expect(text).toContain('2026-07');
    expect(text).not.toContain('2026-07-27');
  });

  it('stops at the deadline', async () => {
    await expect(
      renderPortfolioPdf(sampleOverview(), sampleRows(), { ...OPTIONS, deadline: Date.now() - 1 }),
    ).rejects.toBeInstanceOf(RenderTimeoutError);
  });
});
