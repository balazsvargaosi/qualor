// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { writeFileSync } from 'node:fs';
import { CURATED, readManifest, sha256, sourcesDir, writeAll } from './generate';

/**
 * 4E-1 §2.2.1: `pnpm --filter @qualor/enterprise standards:update <id>`, developer-only and the
 * one place that touches the network: downloads the sources of standard <id> listed in
 * sources/manifest.json, records their SHA-256 there and regenerates the data files. The product
 * never runs this, and src/ never imports it.
 */
const root = new URL('../../', import.meta.url);
const id = process.argv.slice(2).find((a) => a !== '--');
const manifest = readManifest(root);
const entry = id === undefined ? undefined : manifest[id];

if (id !== undefined && (CURATED as readonly string[]).includes(id)) {
  process.stderr.write(`${id} is curated by hand: edit sources/${id}.source.json\n`);
  process.exit(1);
}
if (id === undefined || entry === undefined) {
  process.stderr.write(
    `usage: standards:update <id>, where <id> is one of ${Object.keys(manifest).join(', ')}\n`,
  );
  process.exit(1);
}

for (const f of entry.files) {
  const response = await fetch(f.url);
  if (!response.ok) throw new Error(`${f.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(new URL(f.file, sourcesDir(root)), bytes);
  f.sha256 = sha256(bytes);
  process.stdout.write(`${f.sha256}  ${f.file}\n`);
}
writeFileSync(new URL('manifest.json', sourcesDir(root)), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of writeAll(root)) process.stdout.write(`wrote ${file}\n`);
process.stdout.write('review the diff before committing\n');
