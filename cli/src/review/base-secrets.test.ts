import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseConfig, type QualorConfig } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { describeWithTools } from '../../test/analyzers';
import { FIXTURES_DIR } from '../../test/fixtures';
import { commitAll, GIT_TEST_ENV, initRepo } from '../../test/git';
import { fakeSecret, fakeSecretEngine } from '../../test/secret-engine';
import { useTempDirs, writeTree } from '../../test/tmp';
import { gitleaksAnalyzer } from '../analyzers/gitleaks';
import { fileLines, normalizeCaptures } from '../analyzers/normalize';
import { runAnalyzers } from '../analyzers/runner';
import type { Analyzer } from '../analyzers/types';
import { createGit, type Git } from '../git/git';
import { createLogger, silentLogger } from '../log';
import {
  baseSecretScan,
  scanHeadFiles,
  scanMergeBase,
  type BaseSecretScan,
  type BaseSecretScanResult,
} from './base-secrets';

const tmp = useTempDirs();
const CONFIG = parseConfig({ version: 1, project: { key: 'acme/app' } });
type Env = Readonly<Record<string, string | undefined>>;
const noGit: Git = () => Promise.reject(new Error('no git call is due'));

/** The files below `dir`, as `/`-separated paths relative to it. */
const filesBelow = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => statSync(path.join(dir, p)).isFile())
    .map((p) => p.split(path.sep).join('/'))
    .sort();

/** A scan that finds nothing, and records the files it was given and the paths it was told. */
function recordingScan(): { scan: BaseSecretScan; files: string[]; paths: string[] } {
  const seen = {
    files: [] as string[],
    paths: [] as string[],
    scan: (dir: string, paths: readonly string[]): Promise<BaseSecretScanResult> => {
      seen.files = filesBelow(dir);
      seen.paths = [...paths].sort();
      return Promise.resolve({ secrets: [] });
    },
  };
  return seen;
}

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

/** A configuration whose rule and allowlist name instructions files by their repository paths. */
const INSTRUCTION_RULES = [
  'title = "instructions"',
  '[[rules]]',
  'id = "agents-only"',
  "regex = '''qk9-[A-Za-z0-9-]{8,}'''",
  "path = '''^AGENTS\\.md$'''",
  '[[rules]]',
  'id = "anywhere"',
  "regex = '''qk8-[A-Za-z0-9-]{8,}'''",
  '[[allowlists]]',
  'description = "the review rules"',
  "paths = ['''^CLAUDE\\.md$''']",
  '',
].join('\n');
/**
 * A token INSTRUCTION_RULES finds, built at run time: listed as literals, these would read as
 * keyword assignments to the repository's own Gitleaks.
 */
const token = (kind: 'qk8' | 'qk9', name: string): string => `${kind}-${name}`;
/** The instructions files, in the checkout and (unchanged) at the merge base. */
const INSTRUCTIONS = {
  'AGENTS.md': `${token('qk9', 'agents-SECRET-0001')} ${token('qk8', 'agents-SECRET-0002')}\n`,
  'CLAUDE.md': `${token('qk8', 'claude-SECRET-0003')}\n`,
  'REVIEW.md': `${token('qk9', 'review-SECRET-0004')} ${token('qk8', 'review-SECRET-0005')}\n`,
};

/** What the scan of the merge base finds in INSTRUCTIONS, with the checkout's configuration. */
async function instructionSecrets(analyzer: Analyzer, checkout: string): Promise<string[]> {
  const result = await scanMergeBase(
    noGit,
    'b'.repeat(40),
    {
      paths: [],
      instructions: Object.entries(INSTRUCTIONS).map(([p, text]) => ({
        path: p,
        content: Buffer.from(text),
      })),
    },
    {
      scan: baseSecretScan({
        analyzers: [analyzer],
        root: checkout,
        config: CONFIG,
        log: silentLogger,
      }),
      budget: 1_000_000,
      log: silentLogger,
      tempRoot: tmp(),
    },
  );
  return [...result.secrets].sort();
}

/** The secrets INSTRUCTION_RULES finds in INSTRUCTIONS, by their paths. */
const INSTRUCTION_SECRETS = [
  token('qk8', 'agents-SECRET-0002'),
  token('qk8', 'review-SECRET-0005'),
  token('qk9', 'agents-SECRET-0001'),
];

describe('scanMergeBase', () => {
  it('scans the instructions files at their repository paths, as the head scan sees them', async () => {
    const checkout = tmp();
    writeTree(checkout, { '.gitleaks.toml': INSTRUCTION_RULES, ...INSTRUCTIONS });
    const engine = fakeSecretEngine(tmp()).analyzer;
    // The rule scoped to AGENTS.md, and the allowlist of CLAUDE.md, apply by path.
    const head = await headSecrets(engine, checkout);
    expect(head).toEqual(INSTRUCTION_SECRETS);
    expect(await instructionSecrets(engine, checkout)).toEqual(head);
  });

  it("scans an instructions file that is a changed file's old side once, from that copy", async () => {
    const repo = tmp();
    initRepo(repo);
    writeTree(repo, { 'AGENTS.md': 'old rules\n', 'src/a.ts': 'a\n' });
    const base = commitAll(repo, 'base');
    const recorded = recordingScan();
    const logs: string[] = [];
    const result = await scanMergeBase(
      createGit(repo, GIT_TEST_ENV),
      base,
      {
        paths: ['AGENTS.md', 'src/a.ts'],
        instructions: [{ path: 'AGENTS.md', content: Buffer.from('old rules\n') }],
      },
      {
        scan: recorded.scan,
        budget: 1_000_000,
        log: createLogger('debug', (t) => logs.push(t)),
        tempRoot: tmp(),
      },
    );
    expect(recorded.files).toEqual(['AGENTS.md', 'src/a.ts']);
    expect(recorded.paths).toEqual(['AGENTS.md', 'src/a.ts']);
    expect([...result.scanned].sort()).toEqual(['AGENTS.md', 'src/a.ts']);
    expect(logs.filter((l) => l.includes('instructions'))).toEqual([]);
  });

  it('says so once when it cannot put an instructions file where the scan reads it', async () => {
    const repo = tmp();
    initRepo(repo);
    writeTree(repo, { 'agents.md': 'other notes\n', 'CLAUDE.md': 'old\n' });
    const base = commitAll(repo, 'base');
    const recorded = recordingScan();
    const logs: string[] = [];
    await scanMergeBase(
      createGit(repo, GIT_TEST_ENV),
      base,
      {
        paths: ['agents.md', 'CLAUDE.md'],
        instructions: [
          // A changed agents.md holds the place a file system that ignores case gives AGENTS.md.
          { path: 'AGENTS.md', content: Buffer.from('rules\n') },
          // A copy at its path that is not the instructions file's own is never taken for it.
          { path: 'CLAUDE.md', content: Buffer.from('other\n') },
        ],
      },
      {
        scan: recorded.scan,
        budget: 1_000_000,
        log: createLogger('info', (t) => logs.push(t)),
        tempRoot: tmp(),
      },
    );
    expect(recorded.files).toEqual(['CLAUDE.md', 'agents.md']);
    expect(recorded.paths).toEqual(['CLAUDE.md', 'agents.md']);
    const said = logs.filter((l) => l.includes('instructions'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('AGENTS.md, CLAUDE.md');
  });

  it('keeps the signal cleanup on for the whole life of the merge base directory', async () => {
    const before = process.listenerCount('SIGINT');
    let during = -1;
    let dir = '';
    const result = await scanMergeBase(
      noGit,
      'b'.repeat(40),
      { paths: [], instructions: [{ path: 'AGENTS.md', content: Buffer.from('rules\n') }] },
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

  it(
    'scans the instructions files at their repository paths, as the head scan sees them',
    { timeout: 300_000 },
    async () => {
      const checkout = tmp();
      writeTree(checkout, { '.gitleaks.toml': INSTRUCTION_RULES, ...INSTRUCTIONS });
      const head = await headSecrets(gitleaksAnalyzer, checkout);
      expect(head).toEqual(INSTRUCTION_SECRETS);
      expect(await instructionSecrets(gitleaksAnalyzer, checkout)).toEqual(head);
    },
  );
});

describe("a commit's files written for the secret engine", () => {
  /** A commit whose tree holds names git itself accepts but no checkout would: `..`, `.`, `\`. */
  function craftedCommit(): { repo: string; head: string; crafted: string[] } {
    const repo = tmp();
    initRepo(repo);
    const git = (args: string[], input?: string) =>
      execFileSync('git', args, { cwd: repo, env: GIT_TEST_ENV, input, encoding: 'utf8' }).trim();
    const blob = git(['hash-object', '-w', '--stdin'], 'hello\n');
    const tree = (entries: string[]) =>
      git(['mktree', '-z'], entries.map((e) => `${e}\u0000`).join(''));
    const up = tree([`100644 blob ${blob}\tescape.ts`]);
    const dot = tree([`100644 blob ${blob}\ty.ts`]);
    const x = tree([`040000 tree ${dot}\t.`]);
    const root = tree([
      `100644 blob ${blob}\tok.ts`,
      `100644 blob ${blob}\ta\\b.ts`,
      `040000 tree ${up}\t..`,
      `040000 tree ${x}\tx`,
    ]);
    const head = git(['commit-tree', root, '-m', 'crafted']);
    return { repo, head, crafted: ['../escape.ts', 'a\\b.ts', 'x/./y.ts'] };
  }

  it('never writes one outside its directory, nor one that is not a plain relative path', async () => {
    const { repo, head, crafted } = craftedCommit();
    const listed = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', head], {
      cwd: repo,
      env: GIT_TEST_ENV,
      encoding: 'utf8',
    });
    expect(listed.split('\u0000').filter(Boolean).sort()).toEqual([...crafted, 'ok.ts'].sort());
    const tempRoot = tmp();
    const recorded = recordingScan();
    const o = { scan: recorded.scan, budget: 1_000_000, log: silentLogger, tempRoot };
    const git = createGit(repo, GIT_TEST_ENV);
    // The head's files (R14): the crafted ones are left unscanned, so their text goes nowhere.
    expect(await scanHeadFiles(git, head, ['ok.ts', ...crafted], o)).toEqual({
      secrets: [],
      unscanned: new Set(crafted),
    });
    expect(recorded.files).toEqual(['ok.ts']);
    expect(readdirSync(tempRoot)).toEqual([]);
    // The merge base's (R13), written by the same code: the crafted ones send no removed line.
    const base = await scanMergeBase(
      git,
      head,
      { paths: ['ok.ts', ...crafted], instructions: [] },
      o,
    );
    expect([...base.scanned]).toEqual(['ok.ts']);
    expect(recorded.files).toEqual(['ok.ts']);
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});
