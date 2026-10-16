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
import { DEFAULT_QUALOR_RULES_DIR, loadQualorPack } from '../analyzers/qualor';
import { EXIT } from '../errors';
import { silentLogger } from '../log';
import { runDotnetBegin } from './begin';
import { runDotnetEnd } from './end';
import { hookPath, installHook } from './hook';

const tmp = useTempDirs();
const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/csharp-basic');
const ENGINE_FIXTURE = path.resolve(
  import.meta.dirname,
  '../../../fixtures/qualor-security-dotnet',
);

/** The installed rules pack when it carries the Roslyn taint engine (a published pack before the engine release does not). */
const enginePack = (() => {
  const pack = loadQualorPack(DEFAULT_QUALOR_RULES_DIR);
  const declared = 'manifest' in pack ? pack.manifest.dotnetEngine : undefined;
  return declared !== undefined && !('invalid' in declared);
})();

/** The values of a compilation record's `key=` lines, in order. */
function recordValues(lines: readonly string[], key: string): string[] {
  return lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
}

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
    'builds a large dictionary initializer after an early return within a minute (CA1508 stalls under AnalysisMode=All)',
    { timeout: 300_000 },
    () => {
      const root = tmp();
      const env = {
        ...process.env,
        XDG_DATA_HOME: tmp(),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      };
      const entries = Array.from({ length: 200 }, (_, i) => `["key${i}"] = "value${i}"`).join(
        ',\n      ',
      );
      mkdirSync(path.join(root, 'lib'), { recursive: true });
      writeFileSync(
        path.join(root, 'lib/Lib.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n',
      );
      writeFileSync(
        path.join(root, 'lib/Big.cs'),
        `using System;
using System.Collections.Generic;
namespace Lib;
public static class Ext
{
  public static void Put(this object o, Dictionary<string, string> d) { }
}
public class Big
{
  private static bool Installed() => Environment.TickCount > 0;
  public void Up()
  {
    if (!Installed()) return;
    this.Put(new Dictionary<string, string>
    {
      ${entries},
    });
  }
}
`,
      );
      initRepo(root);
      commitAll(root, 'fixture');
      expect(runDotnetBegin({}, captureIO({ cwd: root, env }).io, silentLogger)).toBe(EXIT.OK);
      const started = Date.now();
      const build = spawnSync(
        'dotnet',
        ['build', '--no-incremental', '-nologo', 'lib/Lib.csproj'],
        { cwd: root, env, encoding: 'utf8', timeout: 120_000 },
      );
      expect(build.status, build.stdout + build.stderr).toBe(0);
      expect(Date.now() - started).toBeLessThan(60_000);
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
    <InterceptorsNamespaces>$(InterceptorsNamespaces);Lib.Gen</InterceptorsNamespaces>
  </PropertyGroup>
  <ItemGroup><ProjectReference Include="../lib/Lib.csproj" /></ItemGroup>
  <ItemGroup>
    <None Remove="Views/Shared/Lay out.cshtml;Excluded.cshtml" />
    <Content Include="Views/Shared/Lay out.cshtml" />
    <AdditionalFiles Include="Views/Shared/Lay out.cshtml" />
    <None Update="Views/Home/Copied.cshtml" CopyToOutputDirectory="PreserveNewest" />
    <None Update="Plugins/**" CopyToPublishDirectory="PreserveNewest" />
  </ItemGroup>
</Project>
`,
      );
      write('app dir/Program.cs', 'System.Console.WriteLine(Lib.L.N);\n');
      // R-11: the Razor views among the project's items are recorded once each; a None item only
      // when the project copies it to its output (a plain SDK project's None items take every
      // file, and an application may hold other projects' built views as None, as nopCommerce's
      // Nop.Web does with its Plugins folder); a file in no item and other extensions are not.
      write('app dir/Views/Home/Ïndex.cshtml', '<p>@Model</p>\n');
      write('app dir/Views/Home/Copied.cshtml', '<p>@Model</p>\n');
      write('app dir/Plugins/Other/Views/Configure.cshtml', '<p>@Model</p>\n');
      write('app dir/Views/Shared/Lay out.cshtml', '@RenderBody()\n');
      write('app dir/Views/readme.txt', 'not a view\n');
      write('app dir/Excluded.cshtml', '<p>in no item</p>\n');
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
          get: (k: string) => recordValues(lines, k),
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
      const asm = app.get('project-reference-assembly');
      expect(asm).toHaveLength(1); // paired by index with project-reference
      expect(asm[0]).toMatch(/\/lib\/(obj\/[^/]+\/[^/]+\/ref|bin\/[^/]+\/[^/]+)\/Lib\.dll$/);
      expect(existsSync(asm[0]!)).toBe(true);
      expect(lib.get('project-reference-assembly')).toEqual([]);
      expect(app.get('reference').some((r) => r.endsWith('Lib.dll'))).toBe(false);
      const defines = app.get('defines');
      expect(app.get('interceptors-namespaces')).toHaveLength(1);
      expect(app.get('interceptors-namespaces')[0]!.split(';')).toContain('Lib.Gen');
      expect(app.get('features')).toHaveLength(1);
      expect(defines).toHaveLength(1);
      expect(defines[0]!.split(';')).toEqual(expect.arrayContaining(['A', 'B']));
      expect(app.get('razor-view').sort()).toEqual(
        [
          path.join(root, 'app dir', 'Views', 'Home', 'Copied.cshtml'),
          path.join(root, 'app dir', 'Views', 'Shared', 'Lay out.cshtml'),
        ].sort(),
      );
      expect(lib.get('razor-view')).toEqual([]);
    },
  );
});

interface EngineReport {
  findings: {
    engineId: string;
    ruleId: string;
    location: { path: string; startLine: number };
    secondaryLocations?: { path: string; startLine: number; message?: string }[];
  }[];
  warnings: { code: string; message: string }[];
}

const CORE = 'src/Shop.Core/CustomerLookup.cs';
const WEB = 'src/Shop.Web/Controllers/CustomersController.cs';

// Needs a pack that carries the engine (dotnetEngine in its manifest): skipped, with the reason in
// the test's name, while the installed pack is one published before the engine's release.
describeWithDotnet()(
  'qualor dotnet with the Roslyn taint engine (fixtures/qualor-security-dotnet)',
  () => {
    const scan = async (extraEnv: NodeJS.ProcessEnv) => {
      const root = tmp();
      cpSync(ENGINE_FIXTURE, root, { recursive: true });
      initRepo(root);
      commitAll(root, 'fixture');
      const env = {
        ...process.env,
        XDG_DATA_HOME: tmp(),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        ...extraEnv,
      };
      expect(runDotnetBegin({}, captureIO({ cwd: root, env }).io, silentLogger)).toBe(EXIT.OK);
      // Restore first (NuGet downloads on a cold cache are not the build), then time the build alone.
      const restore = spawnSync('dotnet', ['restore', '-nologo', 'Shop.slnx'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 600_000,
      });
      expect(restore.status, restore.stdout + restore.stderr).toBe(0);
      const started = Date.now();
      const build = spawnSync(
        'dotnet',
        ['build', '--no-restore', '--no-incremental', '-nologo', 'Shop.slnx'],
        {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 600_000,
        },
      );
      const buildMs = Date.now() - started;
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const out = path.join(tmp(), 'r.json.gz');
      await runDotnetEnd(
        { sarif: [], coverage: [], wait: true, dryRun: true, output: out, projectKey: 'p' },
        captureIO({ cwd: root, env }).io,
        silentLogger,
        { parsers: await testParsers(), baselineClient: null },
      );
      const report = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8')) as EngineReport;
      const sql = report.findings.filter(
        (f) => f.engineId === 'qualor' && f.ruleId === 'csharp/sql-injection',
      );
      return { report, sql, buildMs };
    };
    const at = (f: { location: { path: string; startLine: number } }) =>
      `${f.location.path}:${f.location.startLine}`;

    it.runIf(enginePack)(
      'finds the cross-project flow once, with the controller in its code flow, and builds quickly',
      { timeout: 600_000 },
      async () => {
        const { report, sql, buildMs } = await scan({});
        // Shop.Web targets net8.0 and net10.0: each finding is reported once, not per framework.
        expect(sql.map(at).sort()).toEqual([`${CORE}:15`, `${WEB}:37`].sort());
        const cross = sql.find((f) => f.location.path === CORE)!;
        expect(cross.secondaryLocations?.some((l) => l.path === WEB && l.startLine === 20)).toBe(
          true,
        );
        expect(cross.secondaryLocations?.some((l) => l.path === WEB && l.startLine === 22)).toBe(
          true,
        );
        expect(report.warnings.map((w) => w.code)).not.toContain('TAINT_ENGINE_FALLBACK');
        expect(buildMs).toBeLessThan(120_000); // AnalysisMode=Recommended: seconds, not the minutes of All
      },
    );

    it.runIf(enginePack)(
      'falls back to the OpenGrep rules with a warning when the engine goes over its budget',
      { timeout: 600_000 },
      async () => {
        // QUALOR_TAINT_TIME_LIMIT has a minimum of 1 s, which this small solution meets; a memory
        // limit of 1 MB is over at the engine's first check.
        const { report, sql } = await scan({ QUALOR_TAINT_MEMORY_LIMIT: '1' });
        expect(report.warnings.map((w) => w.code)).toContain('TAINT_ENGINE_FALLBACK');
        // OpenGrep follows taint inside one file only: the controller's own flow, with no code flow.
        expect(sql.map(at)).toEqual([`${WEB}:37`]);
        expect(sql[0]!.secondaryLocations ?? []).toEqual([]);
      },
    );

    it.skipIf(enginePack)(
      `skipped: the installed rules pack (${DEFAULT_QUALOR_RULES_DIR}) carries no dotnetEngine`,
      () => {},
    );
  },
);
