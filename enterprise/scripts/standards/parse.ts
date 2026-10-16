// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
/**
 * 4E-1 §2.2: the parsers that turn the saved upstream sources (sources/) into standard
 * categories. Pure functions over text: generate.ts reads the files, these read their shapes.
 */
export interface ParsedCategory {
  id: string;
  title: string;
  cwe: number[];
}

const uniqueSorted = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b);

/**
 * One OWASP Top 10 category page (OWASP/Top10, `<year>/docs/en/Axx_<year>-….md`). The title is
 * the H1 after `Axx:<year>` (2021 puts an en dash before it, 2025 does not), without the icon
 * image; the CWEs are the `CWE-n` of the "List of Mapped CWEs" section, up to the next heading.
 */
export function parseOwaspTop10Markdown(md: string, id: string): ParsedCategory {
  const h1 = /^#\s+(A\d{2}):\d{4}\s+(?:–\s+)?(.+)$/m.exec(md);
  if (!h1) throw new Error(`${id}: no "# Axx:<year> <title>" heading`);
  if (h1[1] !== id) throw new Error(`${id}: the page is category ${h1[1]}`);
  const title = (h1[2] ?? '').replace(/!\[.*$/, '').trim();
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+List of Mapped CWEs\s*$/.test(l));
  if (start === -1) throw new Error(`${id}: no "List of Mapped CWEs" section`);
  const next = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  const section = lines.slice(start + 1, next === -1 ? undefined : next).join('\n');
  const cwe = uniqueSorted([...section.matchAll(/CWE-(\d+)/g)].map((m) => Number(m[1])));
  if (cwe.length === 0) throw new Error(`${id}: "List of Mapped CWEs" lists no CWE`);
  return { id, title, cwe };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X'))
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * MITRE's Top 25 page (cwe.mitre.org/top25/archive/<year>/<year>_cwe_top25.html): the rows of its
 * ranked table `<table id="Detail">` (the list below the table repeats them and is not read).
 * One category per row, `{ id: rank, title: 'CWE-n Name', cwe: [n] }`, exactly 25 in rank order.
 */
export function parseCweTop25Html(html: string): ParsedCategory[] {
  const start = html.indexOf('<table id="Detail"');
  const end = start === -1 ? -1 : html.indexOf('</table>', start);
  if (end === -1) throw new Error('the Top 25 page has no <table id="Detail">');
  const row =
    /<tr>\s*<td[^>]*><b>(\d+)<\/b><\/td>\s*<td[^>]*><a [^>]*href="\/data\/definitions\/(\d+)\.html"[^>]*>CWE-(\d+)<\/a><\/td>\s*<td>([^<]*)<\/td>/g;
  const categories = [...html.slice(start, end).matchAll(row)].map((m, i) => {
    const [, rank, href, cwe, name] = m as unknown as [string, string, string, string, string];
    if (Number(rank) !== i + 1) throw new Error(`Top 25 row ${i + 1} has rank ${rank}`);
    if (href !== cwe) throw new Error(`Top 25 rank ${rank} links CWE-${href} but names CWE-${cwe}`);
    return { id: rank, title: `CWE-${cwe} ${decodeHtml(name).trim()}`, cwe: [Number(cwe)] };
  });
  if (categories.length !== 25) {
    throw new Error(`the Top 25 table has ${categories.length} ranked rows, not 25`);
  }
  return categories;
}

/** What parseCsv has read so far: the finished records, the open record and its open field. */
interface CsvState {
  records: string[][];
  record: string[];
  field: string;
  quoted: boolean;
}

/** Reads the character at `i` inside a quoted field and returns how many characters it used. */
function readQuotedChar(text: string, i: number, state: CsvState): number {
  const c = text[i];
  if (c === '"' && text[i + 1] === '"') {
    state.field += '"';
    return 2;
  }
  if (c === '"') state.quoted = false;
  else state.field += c;
  return 1;
}

/** Reads the character at `i` outside a quoted field and returns how many characters it used. */
function readUnquotedChar(text: string, i: number, state: CsvState): number {
  const c = text[i];
  if (c === '"') state.quoted = true;
  else if (c === ',') {
    state.record.push(state.field);
    state.field = '';
  } else if (c === '\n' || c === '\r') {
    state.record.push(state.field);
    state.records.push(state.record);
    state.record = [];
    state.field = '';
    if (c === '\r' && text[i + 1] === '\n') return 2;
  } else state.field += c;
  return 1;
}

/** RFC 4180: comma-separated fields, double-quoted fields may hold commas, `""` and line breaks. */
function parseCsv(text: string): string[][] {
  const state: CsvState = { records: [], record: [], field: '', quoted: false };
  let i = 0;
  while (i < text.length) {
    i += state.quoted ? readQuotedChar(text, i, state) : readUnquotedChar(text, i, state);
  }
  const { records, record, field } = state;
  if (state.quoted) throw new Error('the CSV ends inside a quoted field');
  if (field !== '' || record.length > 0) records.push([...record, field]);
  return records.filter((r) => r.length > 1 || r[0] !== '');
}

/**
 * The ASVS CSV export (OWASP/ASVS, `4.0/docs_en/OWASP Application Security Verification Standard
 * 4.0.3-en.csv`): its requirements grouped by chapter (V1–V14, by number), with the unique,
 * sorted ids of their `cwe` column.
 */
export function parseAsvsCsv(csv: string): ParsedCategory[] {
  const [header, ...rows] = parseCsv(csv);
  const column = (name: string): number => {
    const i = header?.indexOf(name) ?? -1;
    if (i === -1) throw new Error(`the ASVS CSV has no ${name} column`);
    return i;
  };
  const [idAt, titleAt, cweAt] = [column('chapter_id'), column('chapter_name'), column('cwe')];
  const chapters = new Map<string, { title: string; cwe: number[] }>();
  for (const row of rows) {
    const id = row[idAt] ?? '';
    const title = row[titleAt] ?? '';
    if (!/^V\d+$/.test(id)) throw new Error(`the ASVS CSV has a row of chapter "${id}"`);
    const chapter = chapters.get(id) ?? { title, cwe: [] };
    if (chapter.title !== title) {
      throw new Error(`ASVS chapter ${id} is named "${chapter.title}" and "${title}"`);
    }
    chapter.cwe.push(...[...(row[cweAt] ?? '').matchAll(/\d+/g)].map((m) => Number(m[0])));
    chapters.set(id, chapter);
  }
  return [...chapters]
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([id, { title, cwe }]) => ({ id, title, cwe: uniqueSorted(cwe) }));
}
