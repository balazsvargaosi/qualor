import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineSarif, writeEnginePack } from '../../test/taint';
import { useTempDirs, writeTree } from '../../test/tmp';
import { loadQualorPack, type QualorPack } from '../analyzers/qualor';
import type { ProcessResult, ProcessSpec } from '../analyzers/process';
import { removeActiveWorkDirs } from '../analyzers/runner';
import { silentLogger } from '../log';
import {
  runTaintEngine,
  TAINT_MEMORY_LIMIT_MB,
  TAINT_TIME_LIMIT_S,
  taintBudgets,
  type TaintEngineOptions,
} from './engine';

const tmp = useTempDirs();
const DOTNET = '/usr/share/dotnet/dotnet';

function pack(o: Parameters<typeof writeEnginePack>[1] = {}): QualorPack {
  const loaded = loadQualorPack(writeEnginePack(tmp(), o));
  if ('problem' in loaded) throw new Error(loaded.problem);
  return loaded;
}

/** A checkout with a session the hook filled: one project's compiler inputs. */
function checkout(inputs = true): { root: string; sessionDir: string } {
  const root = tmp();
  const sessionDir = path.join(root, '.qualor', 'dotnet');
  mkdirSync(path.join(sessionDir, 'compilations'), { recursive: true });
  if (inputs) {
    // Two projects, as the hook writes them (CRLF on a Windows runner): sources in and out of
    // the checkout, and the SDK's generated files under obj/.
    writeFileSync(
      path.join(sessionDir, 'compilations', 'a1b2.txt'),
      [
        'qualor-compilation=1',
        `project=${path.join(root, 'src', 'App.csproj')}`,
        `source=${path.join(root, 'src', 'A.cs')}`,
        `source=${path.join(root, 'src', 'obj', 'Debug', 'App.AssemblyInfo.cs')}`,
        `source=${path.join(path.dirname(root), 'elsewhere', 'Shared.cs')}`,
        'reference=/usr/share/dotnet/System.Runtime.dll',
        '',
      ].join('\r\n'),
    );
    writeFileSync(
      path.join(sessionDir, 'compilations', 'c3d4.txt'),
      `qualor-compilation=1\nsource=${path.join(root, 'lib', 'B.cs')}\nsource=${path.join(root, 'src', 'A.cs')}\n`,
    );
    // Not the format: ignored.
    writeFileSync(
      path.join(sessionDir, 'compilations', 'e5f6.txt'),
      `source=${path.join(root, 'x.cs')}\n`,
    );
  }
  return { root, sessionDir };
}

interface Fake {
  calls: ProcessSpec[];
  run: (spec: ProcessSpec) => Promise<ProcessResult>;
}

/** A fake engine process: `act` gets the spec and the --sarif path and answers the result. */
function fake(
  act: (spec: ProcessSpec, sarif: string) => Partial<ProcessResult> = () => ({}),
): Fake {
  const calls: ProcessSpec[] = [];
  return {
    calls,
    run: (spec) => {
      calls.push(spec);
      const sarif = spec.args[spec.args.indexOf('--sarif') + 1] ?? '';
      return Promise.resolve({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: '',
        stderr: '',
        ...act(spec, sarif),
      });
    },
  };
}

function options(
  o: Partial<TaintEngineOptions> & { root: string; sessionDir: string },
): TaintEngineOptions {
  return {
    pack: pack(),
    env: { PATH: '/usr/bin' },
    timeLimitS: TAINT_TIME_LIMIT_S,
    memoryLimitMb: TAINT_MEMORY_LIMIT_MB,
    log: silentLogger,
    resolveDotnet: () => DOTNET,
    ...o,
  };
}

describe('runTaintEngine (6B-C# R, R-4)', () => {
  it('falls back without running anything for no pack or a pack without the engine (Review Focus 4)', async () => {
    const { root, sessionDir } = checkout();
    const engine = fake();
    expect(
      await runTaintEngine(options({ root, sessionDir, pack: null, run: engine.run })),
    ).toEqual({
      kind: 'fallback',
      reason: 'no-engine',
      detail: 'no valid rules pack',
    });
    expect(
      await runTaintEngine(
        options({ root, sessionDir, pack: pack({ engine: false }), run: engine.run }),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'no-engine',
      detail: 'the rules pack 2026.10.4 has no Roslyn taint engine',
    });
    const bad = pack();
    expect(
      await runTaintEngine(
        options({
          root,
          sessionDir,
          pack: {
            ...bad,
            manifest: { ...bad.manifest, dotnetEngine: { invalid: 'files.4.path' } },
          },
          run: engine.run,
        }),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'no-engine',
      detail: "the rules pack's dotnetEngine is not valid (files.4.path)",
    });
    expect(engine.calls).toEqual([]);
  });

  it('falls back on a crash when something throws on the way, without running the engine', async () => {
    const { root, sessionDir } = checkout();
    const engine = fake();
    const out = await runTaintEngine(
      options({
        root,
        sessionDir,
        run: engine.run,
        resolveDotnet: () => {
          throw new Error('EACCES: permission denied');
        },
      }),
    );
    expect(out).toEqual({ kind: 'fallback', reason: 'crash', detail: 'EACCES: permission denied' });
    expect(engine.calls).toEqual([]);
  });

  it('never runs an engine whose files differ from the manifest, are missing or are not alone (Review Focus 4)', async () => {
    const { root, sessionDir } = checkout();
    const cases: [string, (dir: string) => void, string][] = [
      [
        'a changed DLL',
        (d) => writeFileSync(path.join(d, 'dotnet/engine/Qualor.Taint.Cli.dll'), 'patched\n'),
        'the engine file dotnet/engine/Qualor.Taint.Cli.dll does not match its manifest checksum',
      ],
      [
        'a changed model',
        (d) => writeFileSync(path.join(d, 'dotnet/models/csharp/sources.yml'), 'sources: [x]\n'),
        'the engine file dotnet/models/csharp/sources.yml does not match its manifest checksum',
      ],
      [
        'a missing file',
        (d) => rmSync(path.join(d, 'dotnet/engine/licenses/YamlDotNet.txt')),
        'the engine is missing dotnet/engine/licenses/YamlDotNet.txt',
      ],
      [
        'an unlisted model, which the engine would load',
        (d) => writeTree(d, { 'dotnet/models/csharp/extra.yml': 'sinks: []\n' }),
        'the engine holds dotnet/models/csharp/extra.yml, which its manifest does not list',
      ],
      [
        'an unlisted assembly',
        (d) => writeTree(d, { 'dotnet/engine/Evil.dll': 'x' }),
        'the engine holds dotnet/engine/Evil.dll, which its manifest does not list',
      ],
      [
        'a directory in place of a file',
        (d) => {
          rmSync(path.join(d, 'dotnet/engine/Qualor.Taint.Cli.runtimeconfig.json'));
          mkdirSync(path.join(d, 'dotnet/engine/Qualor.Taint.Cli.runtimeconfig.json'));
        },
        'the engine file dotnet/engine/Qualor.Taint.Cli.runtimeconfig.json is not a regular file',
      ],
    ];
    for (const [name, change, detail] of cases) {
      const p = pack();
      change(p.dir);
      const engine = fake();
      expect(
        await runTaintEngine(options({ root, sessionDir, pack: p, run: engine.run })),
        name,
      ).toEqual({ kind: 'fallback', reason: 'engine-mismatch', detail });
      expect(engine.calls, name).toEqual([]);
    }
  });

  it('falls back without compiler inputs, before running anything', async () => {
    const empty = checkout(false);
    const engine = fake();
    const detail = 'the build recorded no compiler inputs';
    expect(await runTaintEngine(options({ ...empty, run: engine.run }))).toEqual({
      kind: 'fallback',
      reason: 'no-inputs',
      detail,
    });
    rmSync(empty.sessionDir, { recursive: true });
    expect(await runTaintEngine(options({ ...empty, run: engine.run }))).toEqual({
      kind: 'fallback',
      reason: 'no-inputs',
      detail,
    });
    expect(engine.calls).toEqual([]);
  });

  it('falls back when dotnet is not on PATH or cannot be started', async () => {
    const { root, sessionDir } = checkout();
    const engine = fake();
    expect(
      await runTaintEngine(
        options({ root, sessionDir, run: engine.run, resolveDotnet: () => null }),
      ),
    ).toEqual({ kind: 'fallback', reason: 'dotnet-missing', detail: 'dotnet is not installed' });
    expect(engine.calls).toEqual([]);
    const gone = fake(() => ({
      exitCode: null,
      spawnError: 'spawn ENOENT',
      spawnErrorCode: 'ENOENT',
    }));
    expect(await runTaintEngine(options({ root, sessionDir, run: gone.run }))).toEqual({
      kind: 'fallback',
      reason: 'dotnet-missing',
      detail: 'dotnet is not installed',
    });
  });

  it('falls back on the budget when the engine reports an incomplete run, or is killed (Review Focus 3)', async () => {
    const { root, sessionDir } = checkout();
    // Exit 3: the SARIF is written, marked incomplete; it is never used.
    const over = fake((_spec, sarif) => {
      writeFileSync(sarif, JSON.stringify(engineSarif(root, [], { complete: false })));
      return {
        exitCode: 3,
        stderr: 'input: a warning\n12 finding(s); incomplete: time limit of 600 s exceeded\n',
      };
    });
    expect(await runTaintEngine(options({ root, sessionDir, run: over.run }))).toEqual({
      kind: 'fallback',
      reason: 'budget',
      detail: 'time limit of 600 s exceeded',
    });
    const killed = fake(() => ({ exitCode: null, timedOut: true }));
    expect(
      await runTaintEngine(options({ root, sessionDir, run: killed.run, timeLimitS: 30 })),
    ).toEqual({
      kind: 'fallback',
      reason: 'budget',
      detail: 'the engine did not finish within 330 s',
    });
    // Exit 0 but marked incomplete is never used either.
    const marked = fake((_spec, sarif) => {
      writeFileSync(sarif, JSON.stringify(engineSarif(root, [], { complete: false })));
      return {};
    });
    expect(await runTaintEngine(options({ root, sessionDir, run: marked.run }))).toMatchObject({
      kind: 'fallback',
      reason: 'budget',
    });
  });

  it('falls back with the load reason when the sources of a project did not all load (R-E42)', async () => {
    const { root, sessionDir } = checkout();
    const reason =
      'the sources of 1 project(s) could not be loaded; first: /r/App.csproj (net8.0): 1 source(s) not loaded, 1 error(s) while loading or compiling';
    const lost = fake((_spec, sarif) => {
      writeFileSync(
        sarif,
        JSON.stringify(
          engineSarif(root, [], {
            complete: false,
            problems: { withErrors: 1, withoutSources: 1 },
          }),
        ),
      );
      return {
        exitCode: 3,
        stderr: `project: x
3 finding(s); incomplete: ${reason}\n`,
      };
    });
    expect(await runTaintEngine(options({ root, sessionDir, run: lost.run }))).toEqual({
      kind: 'fallback',
      reason: 'load',
      detail: reason,
    });
    // The stats alone are enough (an engine whose stderr carries no reason line).
    const stats = fake((_spec, sarif) => {
      writeFileSync(
        sarif,
        JSON.stringify(engineSarif(root, [], { complete: false, problems: { withoutSources: 2 } })),
      );
      return { exitCode: 3 };
    });
    expect(await runTaintEngine(options({ root, sessionDir, run: stats.run }))).toMatchObject({
      kind: 'fallback',
      reason: 'load',
    });
    // A budget stop with clean stats stays a budget fallback.
    const slow = fake((_spec, sarif) => {
      writeFileSync(
        sarif,
        JSON.stringify(engineSarif(root, [], { complete: false, problems: {} })),
      );
      return { exitCode: 3, stderr: '1 finding(s); incomplete: time limit of 600 s exceeded\n' };
    });
    expect(await runTaintEngine(options({ root, sessionDir, run: slow.run }))).toMatchObject({
      reason: 'budget',
    });
  });

  it('trusts the incompleteKind of the engine, and without it chooses load only for a stop that was not a budget stop (RC2)', async () => {
    const { root, sessionDir } = checkout();
    const run = (o: Parameters<typeof engineSarif>[2], stderr: string, exitCode = 3) =>
      runTaintEngine(
        options({
          root,
          sessionDir,
          run: fake((_spec, sarif) => {
            writeFileSync(sarif, JSON.stringify(engineSarif(root, [], o)));
            return { exitCode, stderr };
          }).run,
        }),
      );
    const budget = '1 finding(s); incomplete: time limit of 600 s exceeded\n';
    // Budget first: missing sources do not turn a budget stop into a load fallback.
    expect(
      await run({ complete: false, kind: 'budget', problems: { withoutSources: 1 } }, budget),
    ).toMatchObject({ reason: 'budget' });
    expect(
      await run({ complete: false, kind: 'load', problems: { withoutSources: 1 } }, ''),
    ).toMatchObject({
      reason: 'load',
    });
    expect(await run({ complete: false, kind: 'failed' }, '')).toMatchObject({ reason: 'crash' });
    // Exit 0 marked incomplete uses the field too.
    expect(
      await run({ complete: false, kind: 'budget', problems: { withoutSources: 1 } }, '', 0),
    ).toMatchObject({ reason: 'budget' });
    // An older engine: no field. A budget reason stays budget, even with missing sources.
    expect(await run({ complete: false, problems: { withoutSources: 1 } }, budget)).toMatchObject({
      reason: 'budget',
    });
    expect(await run({ complete: false, problems: {} }, budget)).toMatchObject({
      reason: 'budget',
    });
  });

  it('keeps a complete run with compile errors, and counts them for the report (R-E42)', async () => {
    const { root, sessionDir } = checkout();
    const warned: string[] = [];
    const run = fake((_spec, sarif) => {
      writeFileSync(
        sarif,
        JSON.stringify(
          engineSarif(root, [], {
            problems: {
              withErrors: 2,
              unresolved: 3,
              notes: [
                'project: /r/App.csproj (net8.0): 1 error(s) while loading or compiling; first: CS0246',
              ],
            },
          }),
        ),
      );
      return {};
    });
    const out = await runTaintEngine(
      options({
        root,
        sessionDir,
        run: run.run,
        log: { ...silentLogger, warn: (m: string) => void warned.push(m) },
      }),
    );
    expect(out).toMatchObject({
      kind: 'ok',
      problems: { projects: 2, unresolvedReferences: 3 },
    });
    expect(warned.join('\n')).toContain('App.csproj');
  });

  it('falls back when the engine read no project from the inputs: an empty result would hide the OpenGrep findings', async () => {
    const { root, sessionDir } = checkout();
    const none = fake((_spec, sarif) => {
      const log = engineSarif(root, []);
      log.runs[0]!.properties.analysisStats.projects = 0;
      writeFileSync(sarif, JSON.stringify(log));
      return { stderr: 'input: compilations/a1b2.txt: does not start with qualor-compilation=1\n' };
    });
    expect(await runTaintEngine(options({ root, sessionDir, run: none.run }))).toEqual({
      kind: 'fallback',
      reason: 'no-inputs',
      detail: 'the engine read no project from the compiler inputs',
    });
  });

  it('falls back on a crash with the first line that says why', async () => {
    const { root, sessionDir } = checkout();
    const crash = fake(() => ({
      exitCode: 1,
      stderr:
        'input: compilations/a1b2.txt: unknown key x\ncrash: System.InvalidOperationException: boom\n   at Qualor.Taint.X()\n',
    }));
    expect(await runTaintEngine(options({ root, sessionDir, run: crash.run }))).toEqual({
      kind: 'fallback',
      reason: 'crash',
      detail: 'exited with code 1: crash: System.InvalidOperationException: boom',
    });
    const invalid = fake(() => ({
      exitCode: 2,
      stderr: 'invalid models: sources.yml(3): bad\nusage: …\n',
    }));
    expect(await runTaintEngine(options({ root, sessionDir, run: invalid.run }))).toEqual({
      kind: 'fallback',
      reason: 'crash',
      detail: 'exited with code 2: invalid models: sources.yml(3): bad',
    });
    const signal = fake(() => ({ exitCode: null }));
    expect(await runTaintEngine(options({ root, sessionDir, run: signal.run }))).toEqual({
      kind: 'fallback',
      reason: 'crash',
      detail: 'exited with code null',
    });
    const noSarif = fake();
    expect(await runTaintEngine(options({ root, sessionDir, run: noSarif.run }))).toEqual({
      kind: 'fallback',
      reason: 'crash',
      detail: "the engine's SARIF could not be read",
    });
    const badSarif = fake((_spec, sarif) => {
      writeFileSync(sarif, '{"version":"1.0"}');
      return {};
    });
    expect(await runTaintEngine(options({ root, sessionDir, run: badSarif.run }))).toEqual({
      kind: 'fallback',
      reason: 'crash',
      detail: "the engine's SARIF could not be read",
    });
  });

  it('runs the verified engine on the session inputs and returns its SARIF', async () => {
    const { root, sessionDir } = checkout();
    const p = pack();
    const log = engineSarif(root, [{ rule: 'csharp.sql-injection', uri: 'src/A.cs', line: 3 }]);
    const engine = fake((_spec, sarif) => {
      writeFileSync(sarif, JSON.stringify(log));
      return { stderr: '1 finding(s); complete\n' };
    });
    const out = await runTaintEngine(
      options({
        root,
        sessionDir,
        pack: p,
        run: engine.run,
        env: { PATH: '/usr/bin', QUALOR_TOKEN: 'secret', HOME: '/home/ci' },
        timeLimitS: 90,
        memoryLimitMb: 2048,
      }),
    );
    // The files the engine analysed: the recorded sources inside the checkout, once each.
    expect(out).toEqual({
      kind: 'ok',
      sarif: log,
      sources: ['lib/B.cs', 'src/A.cs', 'src/obj/Debug/App.AssemblyInfo.cs'],
    });
    expect(engine.calls).toHaveLength(1);
    const spec = engine.calls[0]!;
    const sarif = spec.args[spec.args.indexOf('--sarif') + 1]!;
    expect(spec).toMatchObject({
      command: DOTNET,
      args: [
        path.join(p.dir, 'dotnet', 'engine', 'Qualor.Taint.Cli.dll'),
        'analyze',
        '--inputs',
        path.join(sessionDir, 'compilations'),
        '--models',
        path.join(p.dir, 'dotnet', 'models', 'csharp'),
        '--sarif',
        sarif,
        '--time-limit',
        '90',
        '--memory-limit',
        '2048',
        '--root',
        root,
        '--version',
        '2026.10.4',
      ],
      // Never the checkout: a relative path in the environment must not resolve into it.
      cwd: p.dir,
      timeoutMs: 390_000,
    });
    // The SARIF goes to a private directory outside the checkout, removed afterwards.
    expect(path.relative(root, sarif).startsWith('..')).toBe(true);
    expect(spec.env['QUALOR_TOKEN']).toBeUndefined();
    expect(spec.env['HOME']).toBe('/home/ci');
  });
});

describe('runTaintEngine work directory (final review M5)', () => {
  it('tracks the temporary directory, so the signal handler removes it, and releases it afterwards', async () => {
    const { root, sessionDir } = checkout();
    let work = '';
    const engine = fake((spec, sarif) => {
      work = path.dirname(sarif);
      expect(existsSync(work)).toBe(true);
      removeActiveWorkDirs(silentLogger); // what Ctrl+C does
      expect(existsSync(work)).toBe(false);
      writeFileSync(sarif, '{}');
      return { exitCode: 1 };
    });
    await runTaintEngine(options({ root, sessionDir, pack: pack(), run: engine.run }));
    expect(work).not.toBe('');
    expect(existsSync(work)).toBe(false);
  });
});

describe('taintBudgets (6B-C# R)', () => {
  const GB = 1024 ** 3;
  /** Memory sources of a machine: `total` bytes of host memory, files by path. */
  const machine = (total: number, files: Record<string, string> = {}) => ({
    totalmem: () => total,
    readFile: (p: string) => files[p] ?? null,
  });
  const V2 = '/sys/fs/cgroup/memory.max';
  const V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
  const limit = (m: ReturnType<typeof machine>, env: Record<string, string> = {}) => {
    const info: string[] = [];
    const out = taintBudgets(env, () => undefined, { memory: m, info: (l) => info.push(l) });
    return { ...out, info };
  };

  it('defaults to 600 s and an adaptive memory limit, overridable by QUALOR_TAINT_TIME_LIMIT and QUALOR_TAINT_MEMORY_LIMIT', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const memory = machine(16 * GB);
    expect(taintBudgets({}, warn, { memory })).toEqual({ timeLimitS: 600, memoryLimitMb: 8192 });
    expect(
      taintBudgets({ QUALOR_TAINT_TIME_LIMIT: '1200', QUALOR_TAINT_MEMORY_LIMIT: '2048' }, warn, {
        memory,
      }),
    ).toEqual({ timeLimitS: 1200, memoryLimitMb: 2048 });
    expect(warnings).toEqual([]);
    expect(
      taintBudgets({ QUALOR_TAINT_TIME_LIMIT: '10m', QUALOR_TAINT_MEMORY_LIMIT: '0' }, warn, {
        memory,
      }),
    ).toEqual({ timeLimitS: 600, memoryLimitMb: 8192 });
    expect(warnings).toEqual([
      'QUALOR_TAINT_TIME_LIMIT must be a whole number of seconds from 1 to 86400; using 600',
      'QUALOR_TAINT_MEMORY_LIMIT must be a whole number of megabytes from 1 to 1048576; using 8192',
    ]);
  });

  it('takes half the machine, never below 4096 MB unless it is too small, and leaves 1024 MB free', () => {
    expect(limit(machine(16 * GB)).memoryLimitMb).toBe(8192);
    expect(limit(machine(64 * GB)).memoryLimitMb).toBe(32_768);
    expect(limit(machine(8 * GB)).memoryLimitMb).toBe(4096);
    expect(limit(machine(64 * GB, { [V2]: `${6 * GB}\n` })).memoryLimitMb).toBe(4096);
    expect(limit(machine(64 * GB, { [V2]: `${4 * GB}\n` })).memoryLimitMb).toBe(3072);
    expect(limit(machine(64 * GB, { [V2]: `${2 * GB}\n` })).memoryLimitMb).toBe(1024);
    expect(limit(machine(GB / 2)).memoryLimitMb).toBe(1024); // never below 1024
  });

  it('reads the container limit of cgroup v2 and v1, and ignores "max", the unlimited v1 value and unreadable files', () => {
    expect(limit(machine(64 * GB, { [V1]: `${4 * GB}\n` })).memoryLimitMb).toBe(3072);
    // The smaller of the two cgroups and the host.
    expect(limit(machine(3 * GB, { [V2]: `${16 * GB}\n` })).memoryLimitMb).toBe(2048);
    expect(limit(machine(16 * GB, { [V2]: 'max\n' })).memoryLimitMb).toBe(8192);
    expect(limit(machine(16 * GB, { [V1]: '9223372036854771712\n' })).memoryLimitMb).toBe(8192);
    expect(limit(machine(16 * GB, { [V2]: 'garbage' })).memoryLimitMb).toBe(8192);
    expect(limit(machine(16 * GB, {})).memoryLimitMb).toBe(8192);
    const throwing = {
      totalmem: () => 16 * GB,
      readFile: () => {
        throw new Error('EACCES');
      },
    };
    expect(limit(throwing).memoryLimitMb).toBe(8192);
  });

  it('logs the chosen limit and where it came from', () => {
    expect(limit(machine(16 * GB)).info).toEqual([
      'taint engine memory limit: 8192 MB (adaptive, from 16384 MB of host memory)',
    ]);
    expect(limit(machine(64 * GB, { [V2]: `${4 * GB}\n` })).info).toEqual([
      'taint engine memory limit: 3072 MB (adaptive, from 4096 MB of cgroup v2 memory)',
    ]);
    expect(limit(machine(16 * GB), { QUALOR_TAINT_MEMORY_LIMIT: '2048' }).info).toEqual([
      'taint engine memory limit: 2048 MB (QUALOR_TAINT_MEMORY_LIMIT)',
    ]);
  });
});
