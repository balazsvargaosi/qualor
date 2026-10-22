import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Analyzer } from '../src/analyzers/types';

/** A secret the fake engine below finds: `qk7-` and 8 or more letters, digits or dashes. */
export const fakeSecret = (name: string): string => `qk7-${name}`;

/**
 * The fake engine's tool, run like Gitleaks (`<tool> dir <path> <sarif> <mode> <record>`): it
 * records its working directory and the directory it scans, then reports every `qk7-…` token of
 * every file below that directory as a secret, the way Gitleaks does (the secret in
 * `region.snippet.text`).
 */
const TOOL = `
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [, target, out, mode, record] = process.argv.slice(2);
const scanned = path.resolve(target);
writeFileSync(record, JSON.stringify({ cwd: process.cwd(), scanned }));
if (mode === 'fail') process.exit(1);
const results = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    for (const m of readFileSync(file, 'utf8').matchAll(/qk7-[A-Za-z0-9-]{8,}/g)) {
      const uri = path.relative(scanned, file).split(path.sep).join('/');
      results.push({
        ruleId: 'fake-secret',
        message: { text: 'a secret' },
        locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1, snippet: { text: m[0] } } } }],
      });
    }
  }
};
walk(scanned);
writeFileSync(out, JSON.stringify({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'gitleaks', version: '8.30.1', rules: [{ id: 'fake-secret' }] } }, results }],
}));
`;

export interface FakeSecretEngine {
  analyzer: Analyzer;
  /** The roots it was prepared with. */
  prepared: string[];
  /** Where its tool last ran (its working directory) and what it scanned. */
  ran(): { cwd: string; scanned: string } | null;
}

/**
 * A stand-in for the scan's Gitleaks (id `gitleaks`), its tool written to `dir`: a node script the
 * analyzers' runner runs like any analyzer's, its command shaped like Gitleaks' (`dir .`, the
 * checkout it is prepared against). `fail` exits 1; `unavailable` cannot run here.
 */
export function fakeSecretEngine(
  dir: string,
  mode: 'ok' | 'fail' | 'unavailable' = 'ok',
): FakeSecretEngine {
  const tool = path.join(dir, 'fake-secret-engine.mjs');
  const record = path.join(dir, 'ran.json');
  writeFileSync(tool, TOOL);
  const prepared: string[] = [];
  const analyzer: Analyzer = {
    id: 'gitleaks',
    languages: [],
    prepare: (ctx) => {
      prepared.push(ctx.root);
      if (mode === 'unavailable') return Promise.resolve({ unavailable: 'not installed here' });
      const sarifPath = path.join(ctx.workDir, 'gitleaks.sarif');
      return Promise.resolve({
        run: {
          command: process.execPath,
          args: [tool, 'dir', '.', sarifPath, mode, record],
          cwd: ctx.root,
          sarifPath,
          okExitCodes: [0],
          version: '8.30.1',
        },
      });
    },
  };
  return {
    analyzer,
    prepared,
    ran: () =>
      existsSync(record)
        ? (JSON.parse(readFileSync(record, 'utf8')) as { cwd: string; scanned: string })
        : null,
  };
}
