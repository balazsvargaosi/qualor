// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import PDFDocument from 'pdfkit';
import { registerFonts, defaultFontsDir } from './fonts';

/** Rows laid out between two yields to the event loop, so a long render does not stall the server. */
const ROWS_PER_TICK = 200;

export class RenderTimeoutError extends Error {
  constructor() {
    super('the PDF render ran past its deadline');
    this.name = 'RenderTimeoutError';
  }
}

/** Flattens whitespace and control characters, and cuts to `max` characters with an ellipsis. */
export function cut(text: string, max: number): string {
  const flat = text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (flat.length <= max) return flat;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

export interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

export const SIZE = { title: 22, heading: 14, subheading: 11, text: 9, table: 7.5, margin: 7.5 };
export const COLOR = { text: '#111111', muted: '#555555', rule: '#cccccc', fill: '#eeeeee' };
const PAD = 3;
/**
 * Without ligatures: a ligature glyph (fi) maps back to one letter only when text is copied or
 * searched. fontkit takes an object of overrides, which the pdfkit typings do not describe.
 */
export const FEATURES = { liga: false } as unknown as PDFKit.Mixins.OpenTypeFeatures[];

/** Lays the report out top to bottom on a buffered pdfkit document. */
export class Layout {
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

/**
 * A buffered A4 pdfkit document in Noto Sans whose info fields are fixed by the caller, so one
 * input renders to the same bytes (the file /ID is the MD5 of `info`). `done` settles after
 * `doc.end()` with the whole file.
 */
export function createDocument(options: {
  title: string;
  author: string;
  date: Date;
  subject: string;
  fontsDir?: string;
}): { doc: PDFKit.PDFDocument; done: Promise<Buffer> } {
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
      Title: options.title,
      Author: options.author,
      Subject: options.subject,
      Creator: 'Qualor',
      Producer: 'Qualor',
      CreationDate: options.date,
      ModDate: options.date,
    },
  });
  registerFonts(doc, options.fontsDir ?? defaultFontsDir());
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  // A pdfkit 'error' during the layout, before the caller awaits `done`, is never an unhandled
  // rejection; the caller that awaits `done` still gets it.
  done.catch(() => undefined);
  return { doc, done };
}
