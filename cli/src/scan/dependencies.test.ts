import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type QualorConfigInput } from '@qualor/shared';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tmp';
import type { ProcessResult, ProcessSpec } from '../analyzers/process';
import { silentLogger } from '../log';
import { collectDependencies } from './dependencies';

const tmp = useTempDirs();
const here = path.dirname(fileURLToPath(import.meta.url));
const recordedText = (name: string) =>
  readFileSync(
    path.join(here, '..', 'analyzers', '__fixtures__', 'trivy-licenses', `${name}.json`),
    'utf8',
  );

const config = (input: Omit<QualorConfigInput, 'version'> = {}) =>
  parseConfig({ version: 1, ...input });

const result = (r: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
  stdout: '',
  stderr: '',
  ...r,
});

/** The runner's process helper, faked: writes `output` to Trivy's --output and returns `r`. */
function fakeTrivy(output: string | null, r: Partial<ProcessResult> = {}) {
  const calls: ProcessSpec[] = [];
  const run = (spec: ProcessSpec) => {
    calls.push(spec);
    const out = spec.args[spec.args.indexOf('--output') + 1];
    if (output !== null && out !== undefined) writeFileSync(out, output);
    return Promise.resolve(result(r));
  };
  return { calls, run };
}

const options = (o: {
  input?: Omit<QualorConfigInput, 'version'>;
  trivy?: string | null;
  run?: (spec: ProcessSpec) => Promise<ProcessResult>;
  env?: Record<string, string>;
}) => {
  const root = tmp();
  const tempRoot = tmp();
  return {
    root,
    tempRoot,
    config: config(o.input),
    log: silentLogger,
    env: o.env ?? {},
    resolveBinary: () => (o.trivy === undefined ? '/opt/qualor/bin/trivy' : o.trivy),
    runProcess: o.run ?? fakeTrivy(recordedText('npm-lockfile-only')).run,
  };
};

describe('collectDependencies: the licence pass in a scan (spec §1)', () => {
  it('does nothing with licenses: false, or with Trivy disabled', async () => {
    const fake = fakeTrivy(recordedText('npm-lockfile-only'));
    for (const trivy of [
      { licenses: false },
      { enabled: false },
      { enabled: false, licenses: true },
    ]) {
      const o = options({ input: { analyzers: { trivy } }, run: fake.run });
      expect(await collectDependencies(o), JSON.stringify(trivy)).toBeNull();
    }
    expect(fake.calls).toEqual([]);
  });

  it('runs Trivy with its own timeout, offline and without TRIVY_ variables', async () => {
    const fake = fakeTrivy(recordedText('npm-lockfile-only'));
    const o = options({
      input: { analyzers: { trivy: { licenseTimeoutSeconds: 120 } } },
      run: fake.run,
      env: { GOPATH: '/go', TRIVY_DB_REPOSITORY: 'evil.example/db', QUALOR_TOKEN: 'qlr_secret' },
    });
    await collectDependencies(o);
    expect(fake.calls).toHaveLength(1);
    const [spec] = fake.calls;
    expect(spec?.command).toBe('/opt/qualor/bin/trivy');
    expect(spec?.cwd).toBe(o.root);
    expect(spec?.timeoutMs).toBe(120_000);
    expect(spec?.args).toContain('license');
    expect(spec?.env['GOPATH']).toBe('/go');
    expect(spec?.env['TRIVY_DB_REPOSITORY']).toBeUndefined();
    expect(spec?.env['QUALOR_TOKEN']).toBeUndefined();
    expect(spec?.env['HTTPS_PROXY']).toBe('http://127.0.0.1:9');
    // The work directory (Trivy's empty config, cache and output) is gone afterwards.
    expect(readdirSync(o.tempRoot)).toEqual([]);
  });

  it('reports the inventory and an ok engine with Trivy’s version', async () => {
    const pass = await collectDependencies(options({}));
    expect(pass?.engine).toEqual({
      id: 'trivy-licenses',
      kind: 'builtin',
      status: 'ok',
      reason: null,
      version: '0.74.0',
      durationMs: expect.any(Number) as number,
      rules: [],
    });
    expect(pass?.warnings).toEqual([]);
    expect(pass?.entries?.map((e) => `${e.name}@${e.version} ${e.direct}`)).toEqual([
      'express@4.22.3 true',
      'readline-sync@1.4.10 true',
      'accepts@1.3.8 false',
    ]);
  });

  it('gives an empty inventory, not none, for a repository without lockfiles', async () => {
    const empty = JSON.stringify({ SchemaVersion: 2, Trivy: { Version: '0.74.0' } });
    const pass = await collectDependencies(options({ run: fakeTrivy(empty).run }));
    expect(pass?.engine.status).toBe('ok');
    expect(pass?.entries).toEqual([]);
  });

  it('drops the lockfiles under sources.exclude', async () => {
    const json = JSON.stringify({
      SchemaVersion: 2,
      Results: [
        {
          Target: 'a/package-lock.json',
          Class: 'lang-pkgs',
          Type: 'npm',
          Packages: [{ Name: 'a', Version: '1' }],
        },
        {
          Target: 'old/x/package-lock.json',
          Class: 'lang-pkgs',
          Type: 'npm',
          Packages: [{ Name: 'b', Version: '1' }],
        },
      ],
    });
    const pass = await collectDependencies(
      options({ input: { sources: { exclude: ['old/**'] } }, run: fakeTrivy(json).run }),
    );
    expect(pass?.entries?.map((e) => e.path)).toEqual(['a/package-lock.json']);
  });

  it('skips silently under auto when trivy is not installed, and warns under true', async () => {
    const fake = fakeTrivy(recordedText('npm-lockfile-only'));
    const auto = await collectDependencies(options({ trivy: null, run: fake.run }));
    expect(auto).toEqual({
      engine: expect.objectContaining({ id: 'trivy-licenses', status: 'skipped' }) as unknown,
      warnings: [],
    });
    expect(auto?.engine.reason).toMatch(/trivy is not installed/);
    const required = await collectDependencies(
      options({ input: { analyzers: { trivy: { licenses: true } } }, trivy: null, run: fake.run }),
    );
    expect(required?.engine.status).toBe('skipped');
    expect(required?.entries).toBeUndefined();
    expect(required?.warnings).toEqual([
      {
        code: 'LICENSE_SCAN_FAILED',
        message: expect.stringMatching(/^trivy is not installed/),
        count: 1,
      },
    ]);
    expect(fake.calls).toEqual([]);
  });

  it('records a failed run with the first stderr line, and no inventory', async () => {
    const fake = fakeTrivy(null, {
      exitCode: 1,
      stderr:
        '\n2026-10-14T10:00:00Z\tFATAL\tFatal error\trun error: fs scan error: https://ci:hunter2@proxy.example/x\nsecond line\n',
    });
    const pass = await collectDependencies(options({ run: fake.run }));
    expect(pass?.engine).toMatchObject({ status: 'failed', reason: 'exited with code 1' });
    expect(pass?.entries).toBeUndefined();
    expect(pass?.warnings).toEqual([
      {
        code: 'LICENSE_SCAN_FAILED',
        message:
          'the Trivy licence pass exited with code 1: 2026-10-14T10:00:00Z FATAL Fatal error run error: fs scan error: https://«redacted»@proxy.example/x',
        count: 1,
      },
    ]);
  });

  it('records a run whose output is not Trivy JSON as failed', async () => {
    for (const output of [null, 'not json', '{"runs": []}']) {
      const pass = await collectDependencies(options({ run: fakeTrivy(output).run }));
      expect(pass?.engine.status, String(output)).toBe('failed');
      expect(pass?.entries).toBeUndefined();
      expect(pass?.warnings.map((w) => w.code)).toEqual(['LICENSE_SCAN_FAILED']);
    }
  });

  it('records a run that could not start as failed', async () => {
    const run = () =>
      Promise.resolve(
        result({ exitCode: null, spawnError: 'spawn ENOENT', spawnErrorCode: 'ENOENT' }),
      );
    const pass = await collectDependencies(options({ run }));
    expect(pass?.engine).toMatchObject({ status: 'failed', reason: 'not installed' });
    expect(pass?.warnings.map((w) => w.code)).toEqual(['LICENSE_SCAN_FAILED']);
  });

  it('records a timeout with its own warning, and no inventory', async () => {
    const fake = fakeTrivy(recordedText('npm-lockfile-only'), { exitCode: null, timedOut: true });
    const pass = await collectDependencies(options({ run: fake.run }));
    expect(pass?.engine).toMatchObject({ status: 'timeout', reason: 'timed out after 300 s' });
    expect(pass?.entries).toBeUndefined();
    expect(pass?.warnings).toEqual([
      {
        code: 'LICENSE_SCAN_TIMEOUT',
        message: expect.stringContaining('300 s') as string,
        count: 1,
      },
    ]);
  });

  it('keeps 50 000 of 60 000 packages, the direct ones first, with one warning (Review Focus 3)', async () => {
    const packages = Array.from({ length: 60_000 }, (_, i) => ({
      Name: `pkg-${String(i).padStart(5, '0')}`,
      Version: '1.0.0',
      Licenses: ['MIT'],
      Relationship: i % 10 === 0 ? 'direct' : 'indirect',
      Locations: [{ StartLine: i + 1, EndLine: i + 1 }],
    }));
    const json = JSON.stringify({
      SchemaVersion: 2,
      Results: [
        { Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Packages: packages },
      ],
    });
    const pass = await collectDependencies(options({ run: fakeTrivy(json).run }));
    expect(pass?.engine.status).toBe('ok');
    expect(pass?.entries).toHaveLength(50_000);
    expect(pass?.entries?.slice(0, 6_000).every((e) => e.direct === true)).toBe(true);
    expect(pass?.entries?.slice(6_000).every((e) => e.direct === false)).toBe(true);
    expect(pass?.entries?.[6_000]?.name).toBe('pkg-00001');
    expect(pass?.warnings).toEqual([
      {
        code: 'DEPENDENCIES_TRUNCATED',
        message: expect.stringContaining('10000 of 60000') as string,
        count: 10_000,
      },
    ]);
  });

  it('counts the licences left out by the parser and by merging in one warning', async () => {
    const licences = (prefix: string) => Array.from({ length: 10 }, (_, i) => `${prefix}-${i}`);
    const json = JSON.stringify({
      SchemaVersion: 2,
      Results: [
        {
          Target: 'package-lock.json',
          Class: 'lang-pkgs',
          Type: 'npm',
          Packages: [
            { Name: 'x', Version: '1', Licenses: [...licences('A'), 'y'.repeat(257)] },
            { Name: 'x', Version: '1', Licenses: licences('B') },
          ],
        },
      ],
    });
    const pass = await collectDependencies(options({ run: fakeTrivy(json).run }));
    expect(pass?.entries?.map((e) => e.licenses.length)).toEqual([16]);
    expect(pass?.warnings).toEqual([
      {
        code: 'DEPENDENCY_LICENSES_SKIPPED',
        message: expect.stringContaining('5 licence strings') as string,
        count: 5,
      },
    ]);
  });

  it('leaves no work directory behind when the run throws', async () => {
    const o = options({ run: () => Promise.reject(new Error('boom')) });
    const pass = await collectDependencies(o);
    expect(pass?.engine.status).toBe('failed');
    expect(existsSync(o.tempRoot) && readdirSync(o.tempRoot)).toEqual([]);
  });
});
