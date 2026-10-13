import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { describeWithDotnet } from '../../test/analyzers';
import { commitAll, initRepo } from '../../test/git';
import { captureIO } from '../../test/io';
import { testParsers } from '../../test/parsers';
import { useTempDirs } from '../../test/tmp';
import { EXIT } from '../errors';
import { silentLogger } from '../log';
import { runDotnetBegin } from './begin';
import { runDotnetEnd } from './end';
import { hookPath, installHook } from './hook';

const tmp = useTempDirs();
const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/csharp-basic');

describeWithDotnet()('qualor dotnet with a real build (fixtures/csharp-basic)', () => {
  const dotnet = (cwd: string, env: NodeJS.ProcessEnv) =>
    spawnSync('dotnet', ['build', '--no-incremental', '-nologo', 'Fixture.slnx'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 600_000,
    });

  // A real dotnet build (restore, two target frameworks) is slower than vitest's 5 s default,
  // especially alongside every other real-tool test of a full `pnpm test` run (Task 9's Linux
  // check); as generous as the other real-tool suites (pmd.test.ts 180 s, spotbugs.test.ts 300 s).
  it(
    'reports the fixture findings once each, builds despite TreatWarningsAsErrors, and cleans up (Review Focus 1, 3)',
    { timeout: 300_000 },
    async () => {
      const root = tmp();
      cpSync(FIXTURE, root, { recursive: true });
      initRepo(root);
      commitAll(root, 'fixture');
      const env = {
        ...process.env,
        XDG_DATA_HOME: tmp(),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      };
      expect(runDotnetBegin({}, captureIO({ cwd: root, env }).io, silentLogger)).toBe(EXIT.OK);
      const build = dotnet(root, env);
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const out = path.join(tmp(), 'r.json.gz');
      await runDotnetEnd(
        { sarif: [], coverage: [], wait: true, dryRun: true, output: out, projectKey: 'p' },
        captureIO({ cwd: root, env }).io,
        silentLogger,
        { parsers: await testParsers(), baselineClient: null },
      );
      const report = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8'));
      const keys = report.findings
        .filter((f: { engineId: string }) => f.engineId === 'roslyn')
        .map(
          (f: { ruleId: string; location: { path: string; startLine: number } }) =>
            `${f.ruleId}@${f.location.path}:${f.location.startLine}`,
        );
      expect(keys).toContain('CA5351@src/Acme.Store/Hashing.cs:9');
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.some((k: string) => k.startsWith('CA1822@'))).toBe(false); // #pragma-suppressed
      expect(existsSync(hookPath(path.join(env.XDG_DATA_HOME, 'Microsoft', 'MSBuild')))).toBe(
        false,
      );
      expect(existsSync(path.join(root, '.qualor', 'dotnet'))).toBe(false);
    },
  );

  it(
    'a hook left behind changes no build outside a session (Review Focus 2)',
    { timeout: 300_000 },
    () => {
      const root = tmp();
      cpSync(FIXTURE, root, { recursive: true });
      const env = {
        ...process.env,
        XDG_DATA_HOME: tmp(),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      };
      installHook(path.join(env.XDG_DATA_HOME, 'Microsoft', 'MSBuild'));
      const build = dotnet(root, env);
      // The library sets TreatWarningsAsErrors and has analyzer warnings only inside a session:
      // outside one it builds, and nothing is written below the checkout.
      expect(build.status, build.stdout + build.stderr).toBe(0);
      expect(existsSync(path.join(root, '.qualor'))).toBe(false);
      expect(readdirSync(root)).not.toContain('.qualor');
    },
  );

  it(
    "records each project's compiler inputs, exactly (Roslyn engine, Review Focus 5)",
    { timeout: 300_000 },
    () => {
      const root = tmp();
      const env = {
        ...process.env,
        XDG_DATA_HOME: tmp(),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      };
      const write = (rel: string, text: string) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
      };
      write(
        'lib/Lib.csproj',
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
</Project>
`,
      );
      write('lib/Lib.cs', 'namespace Lib; public static class L { public static int N => 1; }\n');
      write(
        'app dir/App.csproj',
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <DefineConstants>$(DefineConstants);A;B</DefineConstants>
  </PropertyGroup>
  <ItemGroup><ProjectReference Include="../lib/Lib.csproj" /></ItemGroup>
</Project>
`,
      );
      write('app dir/Program.cs', 'System.Console.WriteLine(Lib.L.N);\n');
      write('app dir/sub dir/Ünï cödé.cs', 'namespace App; public static class U { }\n');
      initRepo(root);
      commitAll(root, 'fixture');
      expect(runDotnetBegin({}, captureIO({ cwd: root, env }).io, silentLogger)).toBe(EXIT.OK);
      const build = spawnSync(
        'dotnet',
        ['build', '--no-incremental', '-nologo', 'app dir/App.csproj'],
        { cwd: root, env, encoding: 'utf8', timeout: 600_000 },
      );
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const dir = path.join(root, '.qualor', 'dotnet', 'compilations');
      const files = readdirSync(dir);
      expect(files).toHaveLength(2);
      const parsed = files.map((f) => {
        const raw = readFileSync(path.join(dir, f), 'utf8');
        expect(raw.includes('\r')).toBe(false);
        const lines = raw.split('\n').filter((l) => l !== '');
        return {
          lines,
          get: (k: string) =>
            lines.filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1)),
        };
      });
      for (const c of parsed) {
        expect(c.lines[0]).toBe('qualor-compilation=1');
        expect(c.get('tfm')).toEqual(['net8.0']);
        expect(existsSync(c.get('generated-dir')[0]!)).toBe(true);
        expect(c.get('reference').length).toBeGreaterThan(0);
      }
      const app = parsed.find((c) => c.get('assembly')[0] === 'App')!;
      const lib = parsed.find((c) => c.get('assembly')[0] === 'Lib')!;
      expect(app.get('project')).toEqual([path.join(root, 'app dir', 'App.csproj')]);
      expect(app.get('output-kind')).toEqual(['Exe']);
      expect(lib.get('output-kind')).toEqual(['Library']);
      expect(
        app
          .get('source')
          .filter((f) => !f.includes(`${path.sep}obj${path.sep}`))
          .sort(),
      ).toEqual(
        [
          path.join(root, 'app dir', 'Program.cs'),
          path.join(root, 'app dir', 'sub dir', 'Ünï cödé.cs'),
        ].sort(),
      );
      expect(lib.get('source').filter((f) => !f.includes(`${path.sep}obj${path.sep}`))).toEqual([
        path.join(root, 'lib', 'Lib.cs'),
      ]);
      expect(app.get('project-reference')).toEqual([path.join(root, 'lib', 'Lib.csproj')]);
      expect(lib.get('project-reference')).toEqual([]);
      expect(app.get('reference').some((r) => r.endsWith('Lib.dll'))).toBe(false);
      const defines = app.get('defines');
      expect(defines).toHaveLength(1);
      expect(defines[0]!.split(';')).toEqual(expect.arrayContaining(['A', 'B']));
    },
  );
});
