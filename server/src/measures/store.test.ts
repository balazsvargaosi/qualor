import type { DependencyEntry } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { mergeDependencyEntries } from './store';

const dep = (overrides: Partial<DependencyEntry> = {}): DependencyEntry => ({
  ecosystem: 'npm',
  path: 'package-lock.json',
  name: 'pkg',
  version: '1.0.0',
  licenses: ['MIT'],
  ...overrides,
});

describe('mergeDependencyEntries (6M §2: one row per path, ecosystem, name and version)', () => {
  it('keeps entries without a duplicate as given, in report order', () => {
    const entries = [
      dep({ name: 'b', licenses: ['MIT', 'Apache-2.0'], direct: true, line: 4 }),
      dep({ name: 'a', licenses: [] }),
      dep({ name: 'b', version: '2.0.0' }),
      dep({ name: 'b', ecosystem: 'yarn' }),
      dep({ name: 'b', path: 'web/package-lock.json' }),
    ];
    expect(mergeDependencyEntries(entries)).toEqual([
      {
        path: 'package-lock.json',
        ecosystem: 'npm',
        name: 'b',
        version: '1.0.0',
        licenses: ['MIT', 'Apache-2.0'],
        direct: true,
        line: 4,
      },
      { ...entries[1], direct: null, line: null },
      { ...entries[2], direct: null, line: null },
      { ...entries[3], direct: null, line: null },
      { ...entries[4], direct: null, line: null },
    ]);
  });

  it('merges duplicates: sorted licence union, direct true over false over unknown, first line', () => {
    expect(
      mergeDependencyEntries([
        dep({ licenses: ['MIT'] }),
        dep({ licenses: ['ISC', 'MIT'], direct: false, line: 7 }),
        dep({ licenses: ['Apache-2.0'], direct: true, line: 9 }),
        dep({ direct: false }),
      ]),
    ).toEqual([
      {
        path: 'package-lock.json',
        ecosystem: 'npm',
        name: 'pkg',
        version: '1.0.0',
        licenses: ['Apache-2.0', 'ISC', 'MIT'],
        direct: true,
        line: 7,
      },
    ]);
    expect(
      mergeDependencyEntries([dep(), dep({ direct: false }), dep()]).map((r) => r.direct),
    ).toEqual([false]);
    expect(mergeDependencyEntries([dep(), dep()]).map((r) => [r.direct, r.line])).toEqual([
      [null, null],
    ]);
  });

  it('caps the merged licences at 16', () => {
    const many = (from: number) => Array.from({ length: 16 }, (_, i) => `L-${from + i}`);
    const [row] = mergeDependencyEntries([
      dep({ licenses: many(10) }),
      dep({ licenses: many(20) }),
    ]);
    expect(row!.licenses).toHaveLength(16);
    expect(row!.licenses).toEqual([...new Set([...many(10), ...many(20)])].sort().slice(0, 16));
  });

  it('strips NUL first, so keys and licences equal after stripping are merged', () => {
    expect(
      mergeDependencyEntries([
        dep({ name: 'n\u0000ul', licenses: ['M\u0000IT'] }),
        dep({ name: 'nul', path: 'package-lock.json\u0000', licenses: ['MIT', 'ISC'] }),
      ]),
    ).toEqual([
      {
        path: 'package-lock.json',
        ecosystem: 'npm',
        name: 'nul',
        version: '1.0.0',
        licenses: ['ISC', 'MIT'],
        direct: null,
        line: null,
      },
    ]);
  });
});
