// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_FINDINGS_MAX, RenderTimeoutError, defaultFontsDir, renderPdf } from './pdf';
import { sampleReport } from './test-report';

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

describe('renderPdf (4E-1 §2.5)', () => {
  it('renders a PDF that carries the sha256 and the category titles', async () => {
    const report = sampleReport();
    const pdf = await renderPdf(report);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await textOf(pdf);
    expect(text).toContain(report.id);
    expect(text).toContain('Injection');
    expect(text).toMatch(/Page 1 of \d+/);
    // The cover names the SHA-256 of the canonical JSON, the bytes of the JSON export.
    expect(text).toContain(createHash('sha256').update(JSON.stringify(report)).digest('hex'));
    // No ligatures: copied or searched text keeps every letter ("fi" stays two).
    expect(text).toContain('Open findings in new code');
    // Only the embedded Noto Sans: the built-in Helvetica cannot print Cyrillic.
    const raw = pdf.toString('latin1');
    expect(raw).not.toContain('Helvetica');
    expect(raw.match(/\/BaseFont \/[A-Z]{6}\+NotoSans-(Regular|Bold)/g)?.length).toBeGreaterThan(0);
  });

  it('is byte-identical across renders of the same report', async () => {
    const a = await renderPdf(sampleReport());
    const b = await renderPdf(sampleReport());
    expect(a.equals(b)).toBe(true);
  });

  it('prints Cyrillic, survives CJK, very long text and missing path or line (Review Focus 3)', async () => {
    const report = sampleReport();
    report.findings[0]!.message = 'Небезопасный SQL-запрос ' + 'x'.repeat(10_000);
    report.findings[1]!.message = 'SQL 注入';
    report.findings[1]!.path = null;
    report.findings[1]!.line = null;
    const text = await textOf(await renderPdf(report));
    expect(text).toContain('Небезопасный');
  });

  it('caps the findings list and says where the rest is', async () => {
    const report = sampleReport();
    const base = report.findings[0]!;
    report.findings = Array.from({ length: PDF_FINDINGS_MAX + 5 }, (_, i) => ({
      ...base,
      id: `f${i}`,
      line: i + 1,
    }));
    const text = await textOf(await renderPdf(report));
    expect(text).toContain('The full list is in the CSV and JSON exports');
  }, 60_000);

  it('stops at the deadline', async () => {
    await expect(renderPdf(sampleReport(), { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(
      RenderTimeoutError,
    );
  });

  it('finds the fonts next to the plugin in the image, in a local build and from the source', () => {
    const enterprise = fileURLToPath(new URL('../../', import.meta.url));
    const fonts = path.join(enterprise, 'fonts');
    expect(path.resolve(defaultFontsDir())).toBe(path.resolve(fonts));
    expect(
      path.resolve(defaultFontsDir(pathToFileURL(path.join(enterprise, 'dist', 'plugin.js')))),
    ).toBe(path.resolve(fonts));
    // The image: /app/enterprise/plugin.js next to /app/enterprise/fonts/.
    const app = mkdtempSync(path.join(tmpdir(), 'qualor-fonts-'));
    try {
      mkdirSync(path.join(app, 'enterprise', 'fonts'), { recursive: true });
      copyFileSync(
        path.join(fonts, 'NotoSans-Regular.ttf'),
        path.join(app, 'enterprise', 'fonts', 'NotoSans-Regular.ttf'),
      );
      const plugin = pathToFileURL(path.join(app, 'enterprise', 'plugin.js'));
      expect(path.resolve(defaultFontsDir(plugin))).toBe(path.join(app, 'enterprise', 'fonts'));
      expect(() => defaultFontsDir(pathToFileURL(path.join(app, 'plugin.js')))).toThrow(
        /NotoSans-Regular\.ttf/,
      );
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe('the PDF fonts (4E-1 C3)', () => {
  it('are the files enterprise/fonts/SOURCES.md records, byte for byte', () => {
    const fonts = fileURLToPath(new URL('../../fonts/', import.meta.url));
    const rows = [
      ...readFileSync(path.join(fonts, 'SOURCES.md'), 'utf8').matchAll(
        /^\| `([^`]+)` +\| `[^`]+` +\| `([0-9a-f]{64})` \|$/gm,
      ),
    ];
    expect(rows.map((r) => r[1])).toEqual(['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'OFL.txt']);
    for (const [, file, sha256] of rows) {
      const actual = createHash('sha256')
        .update(readFileSync(path.join(fonts, file!)))
        .digest('hex');
      expect(actual, file).toBe(sha256);
    }
  });
});
