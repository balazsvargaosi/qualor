// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
const FORMULA = /^[=+\-@\t\r]/;

/** The byte order mark that opens a CSV file, so spreadsheets read it as UTF-8. */
export const CSV_BOM = '﻿';

export type Cell = string | number | boolean | null | undefined;

/** RFC 4180 with formula neutralising (4E-1 §2.5). */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV record: the cells joined by commas and a CRLF. */
export const csvLine = (cells: readonly Cell[]): string => `${cells.map(csvCell).join(',')}\r\n`;
