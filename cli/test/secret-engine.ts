import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitleaksAnalyzer } from '../src/analyzers/gitleaks';
import type { ProcessResult } from '../src/analyzers/process';
import type { Analyzer } from '../src/analyzers/types';

/** A secret the fake engine's default rule finds: `qk7-` and 8 or more letters, digits or dashes. */
export const fakeSecret = (name: string): string => `qk7-${name}`;

/**
 * A small Gitleaks, run as the scan runs Gitleaks (`<tool> dir <source> <options>`), with what of
 * Gitleaks 8.30.1 the tests rely on:
 * - its configuration: `--config`, else GITLEAKS_CONFIG, else GITLEAKS_CONFIG_TOML, else the
 *   source's `.gitleaks.toml`, else a default rule for `qk7-…` tokens; `[extend] path` is opened
 *   from the working directory (viper), `useDefault` adds the default rule; rules with `id`,
 *   `regex` and `path`, and the allowlists' `paths`;
 * - the paths it reports and matches the rules' `path` and the allowlists against: as walked from
 *   the source argument (`src/a.ts` for `dir .`);
 * - `.gitleaksignore`: the `--gitleaks-ignore-path` file, or one in that directory (default `.`),
 *   and one in the source, with `<path>:<rule>:<line>` entries;
 * - the secret itself in `region.snippet.text`.
 * It writes what it ran with to FAKE_GITLEAKS_RECORD, fails when FAKE_GITLEAKS_MODE is `fail`,
 * writes JSON that is no SARIF log (its secrets cannot be read) when it is `unreadable`, and never
 * ends (until the runner's timeout stops it) when it is `hang`.
 */
const TOOL = `
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const source = args[0] === 'dir' ? args[1] : undefined;
const record = process.env.FAKE_GITLEAKS_RECORD;
if (record) {
  writeFileSync(record, JSON.stringify({ cwd: process.cwd(), args, gitleaksConfig: process.env.GITLEAKS_CONFIG ?? null }));
}
if (source === undefined || process.env.FAKE_GITLEAKS_MODE === 'fail') process.exit(1);
if (process.env.FAKE_GITLEAKS_MODE === 'unreadable') {
  writeFileSync(option('--report-path'), JSON.stringify({ version: '2.1.0', runs: 'none' }));
  process.exit(0);
}
if (process.env.FAKE_GITLEAKS_MODE === 'hang') {
  await new Promise(() => setInterval(() => undefined, 60_000));
}

const DEFAULT_RULE = { id: 'fake-secret', regex: 'qk7-[A-Za-z0-9-]{8,}', path: null };
const quoted = (text) => [...text.matchAll(/'''([^']*)'''|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
const load = (text, depth) => {
  const conf = { rules: [], allow: [] };
  let section = '';
  let rule = null;
  for (const raw of text.split('\\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      section = line;
      rule = line === '[[rules]]' ? { id: '', regex: null, path: null } : null;
      if (rule !== null) conf.rules.push(rule);
      continue;
    }
    const kv = /^([A-Za-z_]+) *= *(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1];
    const value = kv[2];
    const first = quoted(value)[0];
    if (section === '[extend]' && key === 'path' && depth < 2 && first !== undefined) {
      const more = load(readFileSync(first, 'utf8'), depth + 1);
      conf.rules.push(...more.rules);
      conf.allow.push(...more.allow);
    } else if (section === '[extend]' && key === 'useDefault' && value === 'true') {
      conf.rules.push(DEFAULT_RULE);
    } else if (rule !== null && first !== undefined && ['id', 'regex', 'path'].includes(key)) {
      rule[key] = first;
    } else if ((section === '[allowlist]' || section === '[[allowlists]]') && key === 'paths') {
      conf.allow.push(...quoted(value));
    }
  }
  return conf;
};
const configFile = option('--config') ?? (process.env.GITLEAKS_CONFIG || undefined);
const configToml = process.env.GITLEAKS_CONFIG_TOML || undefined;
const searched = path.join(source, '.gitleaks.toml');
let config = { rules: [DEFAULT_RULE], allow: [] };
if (configFile !== undefined) config = load(readFileSync(configFile, 'utf8'), 0);
else if (configToml !== undefined) config = load(configToml, 0);
else if (existsSync(searched)) config = load(readFileSync(searched, 'utf8'), 0);

const ignored = new Set();
const ignorePath = option('--gitleaks-ignore-path') ?? '.';
for (const file of [ignorePath, path.join(ignorePath, '.gitleaksignore'), path.join(source, '.gitleaksignore')]) {
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  for (const entry of readFileSync(file, 'utf8').split('\\n')) if (entry.trim() !== '') ignored.add(entry.trim());
}

const results = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    const shown = file.split(path.sep).join('/');
    if (config.allow.some((p) => new RegExp(p).test(shown))) continue;
    const lines = readFileSync(file, 'utf8').split('\\n');
    for (const rule of config.rules) {
      if (rule.regex === null || (rule.path !== null && !new RegExp(rule.path).test(shown))) continue;
      lines.forEach((text, i) => {
        for (const m of text.matchAll(new RegExp(rule.regex, 'g'))) {
          if (ignored.has(shown + ':' + rule.id + ':' + (i + 1))) continue;
          results.push({
            ruleId: rule.id,
            message: { text: 'a secret' },
            locations: [{ physicalLocation: { artifactLocation: { uri: shown }, region: { startLine: i + 1, snippet: { text: m[0] } } } }],
          });
        }
      });
    }
  }
};
walk(source);
writeFileSync(option('--report-path'), JSON.stringify({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'gitleaks', version: '8.30.1', rules: config.rules.map((r) => ({ id: r.id })) } }, results }],
}));
`;

const VERSION_PROBE: ProcessResult = {
  exitCode: 0,
  timedOut: false,
  durationMs: 0,
  stdout: '8.30.1\n',
  stderr: '',
};

export interface FakeSecretEngine {
  analyzer: Analyzer;
  /** The roots it was prepared with. */
  prepared: string[];
  /** What its tool last ran with: its working directory, its arguments, GITLEAKS_CONFIG. */
  ran(): { cwd: string; args: string[]; gitleaksConfig: string | null } | null;
}

/**
 * A stand-in for the scan's Gitleaks (id `gitleaks`), its tool written to `dir`: Gitleaks' own
 * preparation (its configuration as the scan resolves it, its command line), with the small
 * Gitleaks above for its binary, run by the analyzers' runner like any analyzer. `fail` exits 1;
 * `unavailable` cannot run here; `unreadable` exits 0 with output that is not SARIF; `hang` runs
 * until the runner times it out; `extraArgs` go at the end of its command line.
 */
export function fakeSecretEngine(
  dir: string,
  mode: 'ok' | 'fail' | 'unavailable' | 'unreadable' | 'hang' = 'ok',
  extraArgs: readonly string[] = [],
): FakeSecretEngine {
  const tool = path.join(dir, 'fake-gitleaks.mjs');
  const record = path.join(dir, 'ran.json');
  writeFileSync(tool, TOOL);
  const prepared: string[] = [];
  const analyzer: Analyzer = {
    ...gitleaksAnalyzer,
    prepare: async (ctx) => {
      prepared.push(ctx.root);
      if (mode === 'unavailable') return { unavailable: 'not installed here' };
      const prep = await gitleaksAnalyzer.prepare({
        ...ctx,
        resolveBinary: (name) => (name === 'gitleaks' ? 'gitleaks' : null),
        exec: () => Promise.resolve(VERSION_PROBE),
      });
      if (!('run' in prep)) return prep;
      return {
        run: {
          ...prep.run,
          command: process.execPath,
          args: [tool, ...prep.run.args, ...extraArgs],
          env: { ...prep.run.env, FAKE_GITLEAKS_MODE: mode, FAKE_GITLEAKS_RECORD: record },
        },
      };
    },
  };
  return {
    analyzer,
    prepared,
    ran: () =>
      existsSync(record)
        ? (JSON.parse(readFileSync(record, 'utf8')) as {
            cwd: string;
            args: string[];
            gitleaksConfig: string | null;
          })
        : null,
  };
}
