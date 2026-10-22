import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfig, type QualorConfig } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { describeWithTools } from '../../test/analyzers';
import { FIXTURES_DIR } from '../../test/fixtures';
import { fakeSecret, fakeSecretEngine } from '../../test/secret-engine';
import { useTempDirs, writeTree } from '../../test/tmp';
import { gitleaksAnalyzer } from '../analyzers/gitleaks';
import { fileLines, normalizeCaptures } from '../analyzers/normalize';
import { runAnalyzers } from '../analyzers/runner';
import type { Analyzer } from '../analyzers/types';
import type { Git } from '../git/git';
import { silentLogger } from '../log';
import { baseSecretScan, scanMergeBase, type BaseSecretScanResult } from './base-secrets';

const tmp = useTempDirs();
const CONFIG = parseConfig({ version: 1, project: { key: 'acme/app' } });
type Env = Readonly<Record<string, string | undefined>>;

const secretsOf = (result: BaseSecretScanResult | undefined): string[] | 'failed' =>
  result === undefined || 'failed' in result ? 'failed' : [...result.secrets].sort();

/** The secrets the scan's own run of `analyzer` reports over `root` (`dir .`, in the root). */
async function headSecrets(
  analyzer: Analyzer,
  root: string,
  env?: Env,
  config: QualorConfig = CONFIG,
): Promise<string[]> {
  const [capture] = await runAnalyzers([analyzer], {
    root,
    config,
    files: [],
    log: silentLogger,
    ...(env !== undefined && { env }),
  });
  if (capture?.status !== 'ok') throw new Error(`the head run failed: ${capture?.reason ?? ''}`);
  const found: { texts: readonly string[] } = { texts: [] };
  normalizeCaptures([capture], {
    repoRoot: root,
    readLines: fileLines(root),
    knownPaths: new Set(),
    log: silentLogger,
    onSecrets: (texts) => {
      found.texts = texts;
    },
  });
  return [...found.texts].sort();
}

/** What the scan of the merge base reports for `files`, written to a fresh directory. */
async function baseSecrets(
  analyzer: Analyzer,
  checkout: string,
  files: Record<string, string>,
  o: { env?: Env; dir?: string } = {},
): Promise<string[] | 'failed'> {
  const dir = o.dir ?? tmp();
  writeTree(dir, files);
  const scan = baseSecretScan({
    analyzers: [analyzer],
    root: checkout,
    config: CONFIG,
    log: silentLogger,
    ...(o.env !== undefined && { env: o.env }),
  });
  return secretsOf(await scan?.(dir, Object.keys(files)));
}

/** The merge request's files, in the checkout and (as the merge base had them) elsewhere. */
const CODE = {
  'config/app.ts': `// ${fakeSecret('config-SECRET-0001')}\n`,
  'src/other.ts': `// ${fakeSecret('other-SECRET-0002')} qk8-other-SECRET-0002\n`,
  'tmp/scratch.ts': '// qk8-tmp-SECRET-0003\n',
};
/** A configuration whose rule `path` and allowlist `paths` match repository-relative paths. */
const PATH_RULES = [
  'title = "paths"',
  '[[rules]]',
  'id = "config-only"',
  "regex = '''qk7-[A-Za-z0-9-]{8,}'''",
  "path = '''^config/'''",
  '[[rules]]',
  'id = "anywhere"',
  "regex = '''qk8-[A-Za-z0-9-]{8,}'''",
  '[[allowlists]]',
  'description = "scratch files"',
  "paths = ['''tmp/''']",
  '',
].join('\n');

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

  it("runs the scan's engine in the directory, at its repository paths, with the scan's configuration", async () => {
    const checkout = tmp();
    const tempRoot = tmp();
    writeTree(checkout, { 'src/a.ts': 'clean\n' });
    const dir = tmp();
    writeTree(dir, { 'src/a.ts': `// ${fakeSecret('in-the-merge-base')}\n`, 'b.md': 'none\n' });
    const engine = fakeSecretEngine(tmp());
    const scan = baseSecretScan({
      analyzers: [engine.analyzer],
      root: checkout,
      config: CONFIG,
      log: silentLogger,
      tempRoot,
    });
    expect(secretsOf(await scan?.(dir, ['src/a.ts', 'b.md']))).toEqual([
      fakeSecret('in-the-merge-base'),
    ]);
    // Prepared against the checkout, as in the scan; run in the directory, over `.`, so the paths
    // it reports and matches are the repository's (`src/a.ts`), as in the scan.
    expect(engine.prepared).toEqual([checkout]);
    const ran = engine.ran();
    expect(path.resolve(ran?.cwd ?? '')).toBe(path.resolve(dir));
    expect(ran?.args.slice(0, 2)).toEqual(['dir', '.']);
    // The runner's work directory (the SARIF holds the secrets) is gone.
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('finds what the head side finds: rule paths and allowlist paths at repository paths', async () => {
    const checkout = tmp();
    writeTree(checkout, { '.gitleaks.toml': PATH_RULES, ...CODE });
    const engine = fakeSecretEngine(tmp()).analyzer;
    const head = await headSecrets(engine, checkout);
    expect(head).toEqual([fakeSecret('config-SECRET-0001'), 'qk8-other-SECRET-0002']);
    expect(await baseSecrets(engine, checkout, CODE)).toEqual(head);
  });

  it(".gitleaksignore: the checkout's suppressions hold on the merge base too", async () => {
    const checkout = tmp();
    writeTree(checkout, {
      '.gitleaks.toml': PATH_RULES,
      '.gitleaksignore': 'config/app.ts:config-only:1\n',
      ...CODE,
    });
    const engine = fakeSecretEngine(tmp()).analyzer;
    const head = await headSecrets(engine, checkout);
    expect(head).toEqual(['qk8-other-SECRET-0002']);
    expect(await baseSecrets(engine, checkout, CODE)).toEqual(head);
  });

  it('GITLEAKS_CONFIG relative to the checkout, and an [extend] path, resolve as in the scan', async () => {
    const checkout = tmp();
    writeTree(checkout, {
      'gl/custom.toml': '[extend]\npath = "gl/rules.toml"\n',
      'gl/rules.toml': PATH_RULES,
      ...CODE,
    });
    const engine = fakeSecretEngine(tmp());
    const env = { ...process.env, GITLEAKS_CONFIG: 'gl/custom.toml' };
    const head = await headSecrets(engine.analyzer, checkout, env);
    expect(head).toEqual([fakeSecret('config-SECRET-0001'), 'qk8-other-SECRET-0002']);
    expect(await baseSecrets(engine.analyzer, checkout, CODE, { env })).toEqual(head);
    expect(engine.ran()?.gitleaksConfig).toBe(path.join(checkout, 'gl', 'custom.toml'));
  });

  it('cannot reproduce the scan when an [extend] path is a file of the merge base, or an option is unknown', async () => {
    const checkout = tmp();
    writeTree(checkout, {
      '.gitleaks.toml': '[extend]\npath = "gl/rules.toml"\n',
      'gl/rules.toml': PATH_RULES,
      ...CODE,
    });
    const engine = fakeSecretEngine(tmp());
    // The merge request changed gl/rules.toml: the merge base's version is in the directory.
    const changed = { ...CODE, 'gl/rules.toml': 'title = "the old rules"\n' };
    expect(await baseSecrets(engine.analyzer, checkout, changed)).toBe('failed');
    expect(engine.ran()).toBeNull();
    const odd = fakeSecretEngine(tmp(), 'ok', ['--redact']);
    expect(await baseSecrets(odd.analyzer, tmp(), CODE)).toBe('failed');
    expect(odd.ran()).toBeNull();
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
    expect(await baseSecrets(odd, tmp(), { 'a.ts': `// ${fakeSecret('never-here')}\n` })).toBe(
      'failed',
    );
    expect(engine.ran()).toBeNull();
  });

  it('fails when the engine fails there, or cannot run here', async () => {
    for (const mode of ['fail', 'unavailable'] as const) {
      const files = { 'a.ts': `// ${fakeSecret('never-found-here')}\n` };
      const engine = fakeSecretEngine(tmp(), mode).analyzer;
      expect(await baseSecrets(engine, tmp(), files), mode).toBe('failed');
    }
  });
});

describe('scanMergeBase', () => {
  it('keeps the signal cleanup on for the whole life of the merge base directory', async () => {
    const before = process.listenerCount('SIGINT');
    let during = -1;
    let dir = '';
    const noGit: Git = () => Promise.reject(new Error('no git call is due'));
    const result = await scanMergeBase(
      noGit,
      'b'.repeat(40),
      { paths: [], instructions: [{ name: 'AGENTS.md', content: Buffer.from('rules\n') }] },
      {
        scan: (scanned) => {
          during = process.listenerCount('SIGINT');
          dir = scanned;
          return Promise.resolve({ secrets: [] });
        },
        budget: 1_000_000,
        log: silentLogger,
        tempRoot: tmp(),
      },
    );
    expect(result.secrets).toEqual([]);
    expect(during).toBeGreaterThan(before);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(readdirSync(path.dirname(dir))).toEqual([]);
  });
});

describeWithTools(['gitleaks'])('baseSecretScan with the real Gitleaks', () => {
  it('finds the secret of a merge-base file as the scan would', { timeout: 300_000 }, async () => {
    const fixture = path.join(FIXTURES_DIR, 'mixed-secrets', 'src', 'config.ts');
    const found = await baseSecrets(gitleaksAnalyzer, tmp(), {
      'src/config.ts': readFileSync(fixture, 'utf8'),
    });
    expect(found).not.toBe('failed');
    expect(found.length).toBeGreaterThan(0);
    const text = readFileSync(fixture, 'utf8');
    for (const secret of found) expect(text).toContain(secret);
  });

  it(
    'finds what the head side finds: rule paths and allowlist paths at repository paths',
    { timeout: 300_000 },
    async () => {
      const checkout = tmp();
      writeTree(checkout, { '.gitleaks.toml': PATH_RULES, ...CODE });
      const head = await headSecrets(gitleaksAnalyzer, checkout);
      expect(head).toEqual([fakeSecret('config-SECRET-0001'), 'qk8-other-SECRET-0002']);
      expect(await baseSecrets(gitleaksAnalyzer, checkout, CODE)).toEqual(head);
    },
  );
});
