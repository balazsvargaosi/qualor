import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `pnpm spdx:update`: refreshes packages/shared/src/licenses/spdx-ids.json from the official SPDX
 * license-list-data (CC0). A developer tool: it needs the network, and neither tests nor CI run it.
 */
const BASE = 'https://raw.githubusercontent.com/spdx/license-list-data/main/json';
const OUT = path.join(process.cwd(), 'packages', 'shared', 'src', 'licenses', 'spdx-ids.json');

interface ListFile {
  licenseListVersion: string;
  releaseDate: string;
  licenses?: { licenseId: string }[];
  exceptions?: { licenseExceptionId: string }[];
}

async function fetchJson(name: string): Promise<ListFile> {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return (await res.json()) as ListFile;
}

/** The order of two ids by code unit, as the JSON file lists them. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const sort = (ids: string[]): string[] => [...new Set(ids)].sort(compareIds);

const [licenses, exceptions] = await Promise.all([
  fetchJson('licenses.json'),
  fetchJson('exceptions.json'),
]);
const out = {
  version: licenses.licenseListVersion,
  date: licenses.releaseDate.slice(0, 10),
  licenses: sort((licenses.licenses ?? []).map((l) => l.licenseId)),
  exceptions: sort((exceptions.exceptions ?? []).map((e) => e.licenseExceptionId)),
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(
  `SPDX ${out.version} (${out.date}): ${out.licenses.length} licences, ${out.exceptions.length} exceptions -> ${OUT}`,
);
