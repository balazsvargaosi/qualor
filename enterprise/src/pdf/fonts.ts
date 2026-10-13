// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONT_FILES = { body: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' } as const;

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

/** Registers the Noto Sans files as 'body' and 'bold' and selects 'body'. */
export function registerFonts(doc: PDFKit.PDFDocument, fontsDir: string): void {
  doc.registerFont('body', path.join(fontsDir, FONT_FILES.body));
  doc.registerFont('bold', path.join(fontsDir, FONT_FILES.bold));
  doc.font('body');
}
