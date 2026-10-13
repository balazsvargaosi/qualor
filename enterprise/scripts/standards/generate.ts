// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StandardCategory, StandardData } from '../../src/compliance/standard';
import { parseAsvsCsv, parseCweTop25Html, parseOwaspTop10Markdown } from './parse';

/**
 * 4E-1 §2.2: `pnpm --filter @qualor/enterprise standards:generate` turns the committed sources
 * (scripts/standards/sources/) into the data files src/compliance/standards/<id>.json, offline.
 * generate.test.ts checks that the committed data files are exactly what this makes of them.
 */
export interface SourceFile {
  url: string;
  /** Relative to sources/. */
  file: string;
  sha256: string;
}

export interface ManifestEntry {
  family: StandardData['family'];
  version: string;
  title: string;
  parser: 'owasp-top10-markdown' | 'cwe-top25-html' | 'asvs-csv';
  source: string;
  licence: string;
  files: SourceFile[];
}

export type Manifest = Record<string, ManifestEntry>;

/** The hand-curated standards: one `sources/<id>.source.json` each, no URL (4E-1 §2.2). */
export const CURATED = ['pci-dss-4.0.1-6.2.4'] as const;

/** `root` is the enterprise package directory. */
export const sourcesDir = (root: URL): URL => new URL('scripts/standards/sources/', root);
export const dataDir = (root: URL): URL => new URL('src/compliance/standards/', root);

export const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export function readManifest(root: URL): Manifest {
  return JSON.parse(readFileSync(new URL('manifest.json', sourcesDir(root)), 'utf8')) as Manifest;
}

function parseFiles(id: string, entry: ManifestEntry, texts: string[]): StandardCategory[] {
  switch (entry.parser) {
    case 'owasp-top10-markdown':
      return entry.files.map((f, i) => {
        const category = /^A\d{2}(?=\.md$)/.exec(f.file.slice(f.file.lastIndexOf('/') + 1));
        if (!category) throw new Error(`${id}: ${f.file} is not named Axx.md`);
        return parseOwaspTop10Markdown(texts[i] ?? '', category[0]);
      });
    case 'cwe-top25-html':
    case 'asvs-csv': {
      if (texts.length !== 1) throw new Error(`${id}: ${entry.parser} reads one file`);
      const text = texts[0] ?? '';
      return entry.parser === 'asvs-csv' ? parseAsvsCsv(text) : parseCweTop25Html(text);
    }
    default:
      throw new Error(`${id}: unknown parser ${String(entry.parser)}`);
  }
}

/** The data file's text: keys in StandardData order, two-space indent, a trailing newline. */
function render(s: StandardData): string {
  const data: StandardData = {
    id: s.id,
    family: s.family,
    version: s.version,
    title: s.title,
    source: s.source,
    licence: s.licence,
    sourceSha256: s.sourceSha256,
    categories: s.categories.map((c) => ({
      id: c.id,
      title: c.title,
      cwe: c.cwe,
      ...(c.severities === undefined ? {} : { severities: c.severities }),
    })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

function fromSources(root: URL, id: string, entry: ManifestEntry): StandardData {
  const bytes = entry.files.map((f) => {
    const content = readFileSync(new URL(f.file, sourcesDir(root)));
    const actual = sha256(content);
    if (actual !== f.sha256) {
      throw new Error(
        `${id}: sources/${f.file} has SHA-256 ${actual}, not the manifest's ${f.sha256}; ` +
          `run standards:update ${id}`,
      );
    }
    return content;
  });
  return {
    id,
    family: entry.family,
    version: entry.version,
    title: entry.title,
    source: entry.source,
    licence: entry.licence,
    // The SHA-256 over each file's SHA-256 hex and a newline, in manifest order.
    sourceSha256: sha256(entry.files.map((f) => `${f.sha256}\n`).join('')),
    categories: parseFiles(
      id,
      entry,
      bytes.map((b) => b.toString('utf8')),
    ),
  };
}

function curated(root: URL, id: string): StandardData {
  const bytes = readFileSync(new URL(`${id}.source.json`, sourcesDir(root)));
  const s = JSON.parse(bytes.toString('utf8')) as Omit<StandardData, 'sourceSha256'>;
  if (s.id !== id) throw new Error(`${id}.source.json has id ${s.id}`);
  for (const c of s.categories) {
    const sorted = [...new Set(c.cwe)].sort((a, b) => a - b);
    if (sorted.join() !== c.cwe.join()) {
      throw new Error(`${id} category ${c.id}: its CWE ids are not unique and sorted`);
    }
  }
  return { ...s, sourceSha256: sha256(bytes) };
}

/** Every generated data file, by file name, as the text the CLI writes. */
export function generateAll(root: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(readManifest(root))) {
    out[`${id}.json`] = render(fromSources(root, id, entry));
  }
  for (const id of CURATED) out[`${id}.json`] = render(curated(root, id));
  return out;
}

export function writeAll(root: URL): string[] {
  mkdirSync(dataDir(root), { recursive: true });
  return Object.entries(generateAll(root)).map(([file, text]) => {
    const target = new URL(file, dataDir(root));
    writeFileSync(target, text);
    return fileURLToPath(target);
  });
}

if (process.argv[1]?.endsWith('generate.ts')) {
  for (const file of writeAll(new URL('../../', import.meta.url))) {
    process.stdout.write(`wrote ${file}\n`);
  }
}
