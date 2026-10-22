import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfig } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { describeWithTools } from '../../test/analyzers';
import { FIXTURES_DIR } from '../../test/fixtures';
import { fakeSecret, fakeSecretEngine } from '../../test/secret-engine';
import { useTempDirs, writeTree } from '../../test/tmp';
import { gitleaksAnalyzer } from '../analyzers/gitleaks';
import type { Analyzer } from '../analyzers/types';
import { silentLogger } from '../log';
import { baseSecretScan } from './base-secrets';

const tmp = useTempDirs();
const CONFIG = parseConfig({ version: 1, project: { key: 'acme/app' } });

describe('baseSecretScan: the secret engine over the merge base (R13)', () => {
  it('is null when the scan runs no secret engine', () => {
    expect(
      baseSecretScan({ analyzers: [], root: tmp(), config: CONFIG, log: silentLogger }),
    ).toBeNull();
    const off = parseConfig({
      version: 1,
      project: { key: 'acme/app' },
      analyzers: { gitleaks: { enabled: false } },
    });
    const engine = fakeSecretEngine(tmp()).analyzer;
    expect(
      baseSecretScan({ analyzers: [engine], root: tmp(), config: off, log: silentLogger }),
    ).toBeNull();
  });

  it("runs the scan's engine, prepared against the checkout, in the directory it is given", async () => {
    const checkout = tmp();
    const dir = tmp();
    const tempRoot = tmp();
    writeTree(checkout, { 'src/a.ts': 'clean\n' });
    writeTree(dir, { 'src/a.ts': `// ${fakeSecret('in-the-merge-base')}\n`, 'b.md': 'none\n' });
    const engine = fakeSecretEngine(tmp());
    const scan = baseSecretScan({
      analyzers: [engine.analyzer],
      root: checkout,
      config: CONFIG,
      log: silentLogger,
      tempRoot,
    });
    expect(await scan?.(dir, ['src/a.ts', 'b.md'])).toEqual([fakeSecret('in-the-merge-base')]);
    // Prepared against the checkout and run in it, as in the scan (Gitleaks resolves its
    // configuration's extends against its working directory); what it scans is the directory.
    expect(engine.prepared).toEqual([checkout]);
    const ran = engine.ran();
    expect(path.resolve(ran?.cwd ?? '')).toBe(path.resolve(checkout));
    expect(path.resolve(ran?.scanned ?? '')).toBe(path.resolve(dir));
    // The runner's work directory (the SARIF holds the secrets) is gone.
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('never runs an engine command it cannot point at the directory', async () => {
    const engine = fakeSecretEngine(tmp());
    const odd: Analyzer = {
      ...engine.analyzer,
      prepare: async (ctx) => {
        const prep = await engine.analyzer.prepare(ctx);
        if (!('run' in prep)) return prep;
        // A shape it does not know (it would run, and scan the checkout).
        return { run: { ...prep.run, args: prep.run.args.map((a) => (a === '.' ? './' : a)) } };
      },
    };
    const dir = tmp();
    writeTree(dir, { 'a.ts': `// ${fakeSecret('never-scanned-here')}\n` });
    const scan = baseSecretScan({
      analyzers: [odd],
      root: tmp(),
      config: CONFIG,
      log: silentLogger,
    });
    expect(await scan?.(dir, ['a.ts'])).toBeNull();
    expect(engine.ran()).toBeNull();
  });

  it('is null when the engine fails there, or cannot run here', async () => {
    for (const mode of ['fail', 'unavailable'] as const) {
      const dir = tmp();
      writeTree(dir, { 'a.ts': `// ${fakeSecret('never-found-here')}\n` });
      const scan = baseSecretScan({
        analyzers: [fakeSecretEngine(tmp(), mode).analyzer],
        root: tmp(),
        config: CONFIG,
        log: silentLogger,
      });
      expect(await scan?.(dir, ['a.ts']), mode).toBeNull();
    }
  });
});

describeWithTools(['gitleaks'])('baseSecretScan with the real Gitleaks', () => {
  it('finds the secret of a merge-base file as the scan would', { timeout: 300_000 }, async () => {
    const dir = tmp();
    const fixture = path.join(FIXTURES_DIR, 'mixed-secrets', 'src', 'config.ts');
    writeTree(dir, { 'src/config.ts': readFileSync(fixture, 'utf8') });
    const scan = baseSecretScan({
      analyzers: [gitleaksAnalyzer],
      root: tmp(),
      config: CONFIG,
      log: silentLogger,
    });
    const found = (await scan?.(dir, ['src/config.ts'])) ?? [];
    expect(found.length).toBeGreaterThan(0);
    const text = readFileSync(fixture, 'utf8');
    for (const secret of found) expect(text).toContain(secret);
  });
});
