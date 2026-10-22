import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs, writeTree } from '../../test/tmp';
import type { AnalyzerCommand } from '../analyzers/types';
import { gitleaksOverMergeBase } from './base-gitleaks';

const tmp = useTempDirs();
type Env = Readonly<Record<string, string | undefined>>;

/** The scan's Gitleaks command (analyzers/gitleaks.ts), as prepared against `checkout`. */
function scanCommand(checkout: string, config?: string): AnalyzerCommand {
  return {
    command: 'gitleaks',
    args: [
      'dir',
      '.',
      '--report-format',
      'sarif',
      '--report-path',
      path.join(checkout, '..', 'work', 'gitleaks.sarif'),
      ...(config === undefined ? [] : ['--config', config]),
      '--no-banner',
      '--no-color',
      '--log-level',
      'error',
      '--exit-code',
      '0',
    ],
    cwd: checkout,
    env: { HTTP_PROXY: 'http://127.0.0.1:9' },
    sarifPath: path.join(checkout, '..', 'work', 'gitleaks.sarif'),
    okExitCodes: [0],
  };
}

function runOf(over: ReturnType<typeof gitleaksOverMergeBase>): AnalyzerCommand {
  if ('cannot' in over) throw new Error(`cannot: ${over.cannot}`);
  return over.run;
}

const cannotOf = (over: ReturnType<typeof gitleaksOverMergeBase>): string | null =>
  'cannot' in over ? over.cannot : null;

describe("gitleaksOverMergeBase: the scan's Gitleaks run in the merge base's directory", () => {
  it("runs over `.` in the directory, with the scan's configuration and .gitleaksignore", () => {
    const checkout = tmp();
    const dir = tmp();
    writeTree(checkout, { '.gitleaks.toml': 'title = "t"\n', '.gitleaksignore': 'a.ts:r:1\n' });
    const config = path.join(checkout, '.gitleaks.toml');
    const run = runOf(gitleaksOverMergeBase(scanCommand(checkout, config), { dir, env: {} }));
    expect(run.cwd).toBe(dir);
    expect(run.args.slice(0, 2)).toEqual(['dir', '.']);
    expect(run.args[run.args.indexOf('--config') + 1]).toBe(config);
    expect(run.args.slice(-2)).toEqual([
      '--gitleaks-ignore-path',
      path.join(checkout, '.gitleaksignore'),
    ]);
    expect(run.env).toEqual({ HTTP_PROXY: 'http://127.0.0.1:9' });
    expect(readdirSync(dir)).toEqual([]);
    // A relative `--config` is the scan's working directory's file.
    const relative = runOf(
      gitleaksOverMergeBase(scanCommand(checkout, '.gitleaks.toml'), { dir, env: {} }),
    );
    expect(relative.args[relative.args.indexOf('--config') + 1]).toBe(config);
    // Without a .gitleaksignore in the checkout, none is named.
    const bare = runOf(gitleaksOverMergeBase(scanCommand(tmp()), { dir, env: {} }));
    expect(bare.args).not.toContain('--gitleaks-ignore-path');
  });

  it('makes GITLEAKS_CONFIG absolute unless --config wins, and places the extends of GITLEAKS_CONFIG_TOML', () => {
    const checkout = tmp();
    writeTree(checkout, { 'gl/custom.toml': 'title = "c"\n', 'gl/rules.toml': 'title = "r"\n' });
    const custom = path.join(checkout, 'gl', 'custom.toml');
    const fromEnv = runOf(
      gitleaksOverMergeBase(scanCommand(checkout), {
        dir: tmp(),
        env: { GITLEAKS_CONFIG: 'gl/custom.toml' },
      }),
    );
    expect(fromEnv.env?.['GITLEAKS_CONFIG']).toBe(custom);
    const explicit = runOf(
      gitleaksOverMergeBase(scanCommand(checkout, custom), {
        dir: tmp(),
        env: { GITLEAKS_CONFIG: 'never-read.toml' },
      }),
    );
    expect(explicit.env?.['GITLEAKS_CONFIG']).toBeUndefined();
    const empty = runOf(
      gitleaksOverMergeBase(scanCommand(checkout), { dir: tmp(), env: { GITLEAKS_CONFIG: '' } }),
    );
    expect(empty.env?.['GITLEAKS_CONFIG']).toBeUndefined();
    const dir = tmp();
    runOf(
      gitleaksOverMergeBase(scanCommand(checkout), {
        dir,
        env: { GITLEAKS_CONFIG_TOML: '[extend]\npath = "gl/rules.toml"\n' },
      }),
    );
    expect(readFileSync(path.join(dir, 'gl', 'rules.toml'), 'utf8')).toBe('title = "r"\n');
  });

  it('reads GITLEAKS_CONFIG as the child process does: in any case on Windows only', () => {
    const checkout = tmp();
    writeTree(checkout, { 'gl/custom.toml': 'title = "c"\n' });
    const run = runOf(
      gitleaksOverMergeBase(scanCommand(checkout), {
        dir: tmp(),
        env: { Gitleaks_Config: 'gl/custom.toml' },
      }),
    );
    expect(run.env?.['GITLEAKS_CONFIG']).toBe(
      process.platform === 'win32' ? path.join(checkout, 'gl', 'custom.toml') : undefined,
    );
  });

  it('copies the [extend] chain to its relative paths, two levels deep as Gitleaks follows it', () => {
    const checkout = tmp();
    const dir = tmp();
    writeTree(checkout, {
      '.gitleaks.toml': '[extend]\npath = "gl/one.toml"\n',
      'gl/one.toml': '[extend]\npath = "gl/two.toml"\n',
      // Gitleaks never opens a third level: it need not even exist.
      'gl/two.toml': '[extend]\npath = "gl/three.toml"\n',
    });
    const top = path.join(checkout, '.gitleaks.toml');
    runOf(gitleaksOverMergeBase(scanCommand(checkout, top), { dir, env: {} }));
    expect(readdirSync(path.join(dir, 'gl')).sort()).toEqual(['one.toml', 'two.toml']);
    expect(readFileSync(path.join(dir, 'gl', 'two.toml'), 'utf8')).toBe(
      '[extend]\npath = "gl/three.toml"\n',
    );
    // An absolute path is the same file for both runs: nothing is copied.
    const elsewhere = tmp();
    writeTree(elsewhere, { 'rules.toml': 'title = "r"\n' });
    writeTree(checkout, {
      'abs.toml': `[extend]\npath = '${path.join(elsewhere, 'rules.toml')}'\n`,
    });
    const clean = tmp();
    const abs = path.join(checkout, 'abs.toml');
    runOf(gitleaksOverMergeBase(scanCommand(checkout, abs), { dir: clean, env: {} }));
    expect(readdirSync(clean)).toEqual([]);
  });

  it('cannot reproduce a command or a configuration it does not know exactly', () => {
    const parent = tmp();
    const checkout = path.join(parent, 'repo');
    writeTree(parent, { 'outside.toml': 'title = "o"\n' });
    writeTree(checkout, {
      '.gitleaks.toml': 'title = "t"\n',
      'out.toml': '[extend]\npath = "../outside.toml"\n',
      'array.toml': '[[extend]]\npath = "x.toml"\n',
      'gone.toml': '[extend]\npath = "missing.toml"\n',
      'taken.toml': '[extend]\npath = "src/rules.toml"\n',
      'src/rules.toml': 'title = "the scan rules"\n',
    });
    const at = (name: string) => path.join(checkout, name);
    const command = scanCommand(checkout, at('.gitleaks.toml'));
    const shape = 'its command is not the one the scan runs';
    const unread = 'its configuration cannot be read';
    const cases: [AnalyzerCommand, Env, string][] = [
      // An option it does not know, one before `dir`, no `dir .`, a --config without its value.
      [{ ...command, args: [...command.args, '--redact'] }, {}, shape],
      [{ ...command, args: ['--config', 'x.toml', ...command.args] }, {}, shape],
      [{ ...command, args: command.args.map((a) => (a === '.' ? './' : a)) }, {}, shape],
      [{ ...command, args: [...command.args, '--config'] }, {}, shape],
      [scanCommand(checkout, at('none.toml')), {}, unread],
      [scanCommand(checkout), { GITLEAKS_CONFIG: 'none.toml' }, unread],
      [
        scanCommand(checkout, at('out.toml')),
        {},
        'a configuration it extends lies outside the repository',
      ],
      [
        scanCommand(checkout, at('array.toml')),
        {},
        'its configuration has an [[extend]] array, which Qualor does not check',
      ],
      [scanCommand(checkout, at('gone.toml')), {}, 'a configuration it extends cannot be read'],
    ];
    for (const [cmd, env, why] of cases) {
      expect(cannotOf(gitleaksOverMergeBase(cmd, { dir: tmp(), env }))).toBe(why);
    }
    // The merge base's version of the extended file is in the directory: it is left as it is.
    const dir = tmp();
    writeTree(dir, { 'src/rules.toml': 'title = "the merge base rules"\n' });
    expect(
      cannotOf(gitleaksOverMergeBase(scanCommand(checkout, at('taken.toml')), { dir, env: {} })),
    ).toBe('a configuration it extends is a file of the merge base too');
    expect(readFileSync(path.join(dir, 'src', 'rules.toml'), 'utf8')).toBe(
      'title = "the merge base rules"\n',
    );
  });
});
