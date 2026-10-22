import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  encodeSnapshotLine,
  OMISSION_REASONS,
  type OmissionReason,
  type SnapshotLine,
} from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { snapshotLines } from '../../test/review-snapshot';
import { useTempDirs } from '../../test/tmp';
import {
  planSnapshot,
  writeSnapshot,
  type Candidate,
  type Plan,
  type SnapshotParts,
} from './snapshot-plan';

const tmp = useTempDirs();

const HEADER: SnapshotParts['header'] = {
  type: 'header',
  v: 1,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  sinceSha: null,
  targetBranch: 'main',
  mergeRequest: { id: '7', title: null, description: null },
  generator: 'qualor-cli/test',
};

/** A candidate as the read step leaves it: read as `text`, omitted for `reason`, or not read. */
interface Spec {
  path: string;
  changed?: boolean;
  text?: string;
  reason?: OmissionReason;
}

/**
 * The parts of `specs` (the changed ones first, as the read step orders them): their lines file,
 * and a change line for each changed one.
 */
function partsOf(specs: readonly Spec[]): SnapshotParts {
  const linesFile = path.join(tmp(), 'files.jsonl');
  const written: Buffer[] = [];
  const candidates = specs.map((s): Candidate => {
    let line: Candidate['line'] = null;
    if (s.text !== undefined) {
      const bytes = Buffer.from(encodeSnapshotLine({ type: 'file', path: s.path, text: s.text }));
      written.push(bytes);
      line = { bytes: bytes.length, redactions: 1, lines: 1 };
    }
    return {
      path: s.path,
      oid: '0'.repeat(40),
      changed: s.changed ?? false,
      reason: s.reason ?? null,
      line,
      missing: false,
    };
  });
  writeFileSync(linesFile, Buffer.concat(written));
  const changes = specs
    .filter((s) => s.changed === true)
    .map((s) =>
      Buffer.from(
        encodeSnapshotLine({
          type: 'change',
          path: s.path,
          oldPath: null,
          status: 'modified',
          patch: null,
          since: null,
        }),
      ),
    );
  return { header: HEADER, instructions: [], changes, candidates, linesFile };
}

async function linesOf(
  parts: SnapshotParts,
  plan: Plan,
): Promise<{ lines: SnapshotLine[]; inflated: number }> {
  const file = path.join(tmp(), 'snapshot.jsonl.gz');
  const { inflated } = await writeSnapshot(file, parts, plan);
  return { lines: snapshotLines(file), inflated };
}

describe('planSnapshot', () => {
  it('once a file does not fit, every later one is limit, even one that would fit', async () => {
    const parts = partsOf([
      { path: 'changed.ts', changed: true, text: 'c'.repeat(100) },
      { path: 'big.ts', text: 'b'.repeat(100_000) },
      { path: 'small.ts', text: 's' },
      { path: 'gen.ts', reason: 'excluded' },
    ]);
    const plan = planSnapshot(parts, { budget: 10_000, maxFiles: 100 });
    expect(plan).toMatchObject({ partial: true, files: 1, redactions: 1 });
    expect(plan?.omitted).toEqual([
      { path: 'big.ts', reason: 'limit' },
      { path: 'small.ts', reason: 'limit' },
      { path: 'gen.ts', reason: 'excluded' },
    ]);
    if (plan === null) return;
    const { lines, inflated } = await linesOf(parts, plan);
    expect(inflated).toBeLessThanOrEqual(10_000);
    expect(lines.filter((l) => l.type === 'file').map((l) => l.path)).toEqual(['changed.ts']);
  });

  it('leaves out the omissions the budget cannot hold, the farthest first, and says partial', async () => {
    const rest = Array.from({ length: 50 }, (_, i) => ({
      path: `vendor/${String(i).padStart(2, '0')}-${'x'.repeat(200)}.js`,
      reason: 'excluded' as const,
    }));
    const parts = partsOf([{ path: 'a.ts', changed: true, text: 'a' }, ...rest]);
    const plan = planSnapshot(parts, { budget: 5_000, maxFiles: 100 });
    expect(plan?.partial).toBe(true);
    const kept = plan?.omitted.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(rest.length);
    expect(plan?.omitted).toEqual(rest.slice(0, kept));
    if (plan === null) return;
    expect((await linesOf(parts, plan)).inflated).toBeLessThanOrEqual(5_000);
  });

  it('sends at most maxFiles files', () => {
    const parts = partsOf([
      { path: 'a.ts', changed: true, text: 'a' },
      { path: 'b.ts', text: 'b' },
      { path: 'c.ts', text: 'c' },
    ]);
    expect(planSnapshot(parts, { budget: 1_000_000, maxFiles: 2 })).toMatchObject({
      partial: true,
      files: 2,
      omitted: [{ path: 'c.ts', reason: 'limit' }],
    });
  });

  it('has no plan when the changes alone do not fit, or a changed file was not read', () => {
    const big = partsOf([{ path: 'a.ts', changed: true, text: 'a'.repeat(10_000) }]);
    expect(planSnapshot(big, { budget: 1_000, maxFiles: 10 })).toBeNull();
    const two = partsOf([
      { path: 'a.ts', changed: true, text: 'a' },
      { path: 'b.ts', changed: true, text: 'b' },
    ]);
    expect(planSnapshot(two, { budget: 1_000_000, maxFiles: 1 })).toBeNull();
    expect(
      planSnapshot(partsOf([{ path: 'a.ts', changed: true }]), { budget: 1_000_000, maxFiles: 9 }),
    ).toBeNull();
  });

  it('never goes over the budget, and sends a prefix of the lines file (random plans)', async () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const reasons = OMISSION_REASONS.filter((r) => r !== 'limit');
    let planned = 0;
    for (let round = 0; round < 60; round++) {
      const specs: Spec[] = [];
      for (let i = 0; i < Math.floor(random() * 12); i++) {
        const changed = random() < 0.25;
        const p = `d${Math.floor(random() * 3)}/f${i}.ts`;
        const kind = random();
        if (kind < 0.55)
          specs.push({ path: p, changed, text: 't'.repeat(Math.floor(random() * 3_000)) });
        else if (kind < 0.85) specs.push({ path: p, changed, reason: reasons[i % reasons.length] });
        else if (!changed) specs.push({ path: p });
      }
      specs.sort((a, b) => Number(b.changed === true) - Number(a.changed === true));
      const parts = partsOf(specs);
      const budget = 400 + Math.floor(random() * 20_000);
      const plan = planSnapshot(parts, { budget, maxFiles: 1 + Math.floor(random() * 6) });
      if (plan === null) continue;
      planned += 1;
      const { lines, inflated } = await linesOf(parts, plan);
      expect(inflated, `round ${round}`).toBeLessThanOrEqual(budget);
      expect(lines[0]).toMatchObject({ type: 'header', partial: plan.partial });
      const sent = lines.flatMap((l) => (l.type === 'file' ? [l.path] : []));
      const texts = specs.flatMap((s) => (s.text === undefined ? [] : [s.path]));
      expect(sent, `round ${round}`).toEqual(texts.slice(0, sent.length));
    }
    expect(planned).toBeGreaterThan(20);
  });
});
