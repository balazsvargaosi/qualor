import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { MAX_SNAPSHOT_ROWS, parseSnapshotLine, type SnapshotLine } from '@qualor/shared';
import { expect } from 'vitest';

const KINDS = ['header', 'instructions', 'change', 'file', 'omitted', 'end'] as const;

/**
 * What the server checks over a whole review snapshot (server/src/review/snapshot-store.ts): one
 * header first and one end line last with the counts, the kinds in order, each path once per kind,
 * never a file and an omission for one path, no text for a deleted path, at most
 * MAX_SNAPSHOT_ROWS paths.
 */
export function expectAcceptable(lines: SnapshotLine[]): void {
  expect(lines[0]?.type).toBe('header');
  expect(lines.filter((l) => l.type === 'header')).toHaveLength(1);
  expect(lines.filter((l) => l.type === 'end')).toHaveLength(1);
  const ranks = lines.map((l) => KINDS.indexOf(l.type));
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  const byKind = { file: new Set<string>(), omitted: new Set<string>(), change: new Set<string>() };
  const names = new Set<string>();
  const deleted = new Set<string>();
  let repeated = 0;
  for (const line of lines) {
    if (line.type === 'instructions') {
      if (names.has(line.name)) repeated += 1;
      names.add(line.name);
    }
    if (line.type !== 'file' && line.type !== 'omitted' && line.type !== 'change') continue;
    if (byKind[line.type].has(line.path)) repeated += 1;
    byKind[line.type].add(line.path);
    if (line.type === 'change' && line.status === 'deleted') deleted.add(line.path);
  }
  expect(repeated).toBe(0);
  expect([...byKind.file].filter((p) => byKind.omitted.has(p) || deleted.has(p))).toEqual([]);
  const paths = new Set([...byKind.file, ...byKind.omitted, ...byKind.change]);
  expect(paths.size).toBeLessThanOrEqual(MAX_SNAPSHOT_ROWS);
  expect(lines.at(-1)).toEqual({
    type: 'end',
    files: byKind.file.size,
    changes: byKind.change.size,
    omitted: byKind.omitted.size,
  });
}

/** The inflated text of a gzip'd snapshot file. */
export function snapshotText(file: string): string {
  return gunzipSync(readFileSync(file)).toString('utf8');
}

/** The lines of a gzip'd snapshot file, each checked by the shared schema, the whole as above. */
export function snapshotLines(file: string): SnapshotLine[] {
  const text = snapshotText(file);
  expect(text.endsWith('\n')).toBe(true);
  const lines = text.slice(0, -1).split('\n').map(parseSnapshotLine);
  expectAcceptable(lines);
  return lines;
}
