// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { readFileSync } from 'node:fs';

/**
 * 4E-1 §2.2.1, the freshness alarm, with no network: src/compliance/standards/freshness.json
 * gives each family a `nextCheck` date. A unit test runs it non-strict (a warning past the date);
 * `release:dry-run` runs `standards:freshness --strict`, which fails past the date.
 */
export interface FreshnessEntry {
  family: string;
  /** The standard id of the family's latest edition. */
  current: string;
  /** YYYY-MM-DD (UTC): from this day on, the family is stale. */
  nextCheck: string;
  note: string;
}

export function checkFreshness(
  entries: FreshnessEntry[],
  today: Date,
): { stale: FreshnessEntry[] } {
  return {
    stale: entries.filter((e) => {
      const due = /^\d{4}-\d{2}-\d{2}$/.test(e.nextCheck)
        ? Date.parse(`${e.nextCheck}T00:00:00Z`)
        : Number.NaN;
      if (Number.isNaN(due)) throw new Error(`${e.family}: nextCheck ${e.nextCheck} is not a date`);
      return today.getTime() >= due;
    }),
  };
}

if (process.argv[1]?.endsWith('freshness.ts')) {
  const strict = process.argv.slice(2).includes('--strict');
  const entries = JSON.parse(
    readFileSync(new URL('../../src/compliance/standards/freshness.json', import.meta.url), 'utf8'),
  ) as FreshnessEntry[];
  const { stale } = checkFreshness(entries, new Date());
  for (const e of stale) {
    process.stderr.write(
      `Compliance standards: check whether a new edition of ${e.family} is out, then run ` +
        `standards:update or move nextCheck in enterprise/src/compliance/standards/freshness.json\n`,
    );
  }
  if (stale.length === 0) process.stdout.write('compliance standards: no check is due\n');
  if (strict && stale.length > 0) process.exitCode = 1;
}
