import { describe, expect, it } from 'vitest';
import {
  QUALOR_KIND_PROPERTY,
  QUALOR_SEVERITY_PROPERTY,
  qualorManifestSchema,
  qualorRuleId,
  qualorRuleMeta,
} from './qualor';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'java/sql-injection',
  path: 'rules/java/sql/sql-injection.yml',
  sha256: 'a'.repeat(64),
  languages: ['java'],
  kind: 'issue',
  severity: 'high',
  cwe: ['CWE-89'],
  title: 'A synthetic rule',
  ...over,
});
const manifest = (over: Record<string, unknown> = {}) => ({
  version: '2026.10.0',
  opengrep: '1.30.0',
  rules: [entry()],
  ...over,
});

describe('qualor rule ids (plan 6B-1)', () => {
  it('maps the OpenGrep id <lang>.<name> to the Qualor id <lang>/<name>', () => {
    expect(qualorRuleId('java.sql-injection')).toBe('java/sql-injection');
    expect(qualorRuleId('js.open-redirect')).toBe('js/open-redirect');
    expect(qualorRuleId('go.ssrf')).toBe('go/ssrf');
    expect(qualorRuleId('csharp.sql-injection')).toBe('csharp/sql-injection');
  });

  it('answers null for anything else', () => {
    for (const id of [
      'ruby.sql-injection',
      'java/sql-injection',
      'java.',
      'java.Sql',
      'java.a.b',
      '',
      '__proto__',
    ]) {
      expect(qualorRuleId(id), id).toBeNull();
    }
  });
});

describe('qualorManifestSchema (plan 6B-1)', () => {
  it('accepts a pack manifest, and keeps every field a newer pack adds', () => {
    const parsed = qualorManifestSchema.parse(
      manifest({ released: '2026-10-03', rules: [entry({ frameworks: ['jdbc'] })] }),
    );
    expect(parsed).toMatchObject({
      version: '2026.10.0',
      opengrep: '1.30.0',
      released: '2026-10-03',
    });
    expect(parsed.rules[0]).toEqual(entry({ frameworks: ['jdbc'] }));
  });

  it('accepts a csharp rule of the pack', () => {
    const rule = entry({
      id: 'csharp/sql-injection',
      path: 'rules/csharp/sql/sql-injection.yml',
      languages: ['csharp'],
    });
    expect(qualorManifestSchema.parse(manifest({ rules: [rule] })).rules[0]).toEqual(rule);
  });

  it('reads taintIntrafile, the pack being tested with OpenGrep --taint-intrafile (plan 6B-6)', () => {
    expect(qualorManifestSchema.parse(manifest({ taintIntrafile: true })).taintIntrafile).toBe(
      true,
    );
    expect(qualorManifestSchema.parse(manifest()).taintIntrafile).toBeUndefined();
    expect(qualorManifestSchema.safeParse(manifest({ taintIntrafile: 'yes' })).success).toBe(false);
  });

  it('refuses what the CLI could not trust', () => {
    const bad = [
      manifest({ version: '2026.01.0' }),
      manifest({ version: '2026.13.0' }),
      // Over-long parts: a patch has at most 6 digits, the year exactly 4.
      manifest({ version: '2026.10.1234567' }),
      manifest({ version: '20260.10.0' }),
      manifest({ opengrep: 'latest' }),
      manifest({ rules: [] }),
      manifest({ rules: [entry({ id: 'java.sql-injection' })] }),
      manifest({ rules: [entry({ path: 'rules/java/sql/other.yml' })] }),
      manifest({ rules: [entry({ path: 'rules/python/sql/sql-injection.yml' })] }),
      manifest({ rules: [entry({ path: '../rules/java/sql/sql-injection.yml' })] }),
      manifest({ rules: [entry({ sha256: 'A'.repeat(64) })] }),
      manifest({ rules: [entry({ kind: 'bug' })] }),
      manifest({ rules: [entry({ severity: 'critical' })] }),
      manifest({ rules: [entry({ cwe: ['89'] })] }),
      manifest({ rules: [entry({ title: '' })] }),
      manifest({ rules: [entry(), entry()] }),
    ];
    for (const m of bad) {
      expect(qualorManifestSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
    }
    // A pack of a language this CLI does not know (as Qualor 0.7.x sees a pack with C# rules)
    // is refused as a whole, never half-loaded.
    expect(
      qualorManifestSchema.safeParse(
        manifest({
          rules: [
            entry({ id: 'kotlin/sql-injection', path: 'rules/kotlin/sql/sql-injection.yml' }),
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('qualorManifestSchema dotnetEngine (6B-C# R, spec §4.1)', () => {
  const engine = (over: Record<string, unknown> = {}) => ({
    version: '2026.10.4',
    entry: 'dotnet/engine/Qualor.Taint.Cli.dll',
    models: 'dotnet/models',
    files: [
      { path: 'dotnet/engine/Qualor.Taint.Cli.dll', sha256: 'a'.repeat(64) },
      { path: 'dotnet/engine/Qualor.Taint.Cli.runtimeconfig.json', sha256: 'b'.repeat(64) },
      { path: 'dotnet/engine/licenses/YamlDotNet.txt', sha256: 'c'.repeat(64) },
      { path: 'dotnet/models/csharp/sql-injection.yml', sha256: 'd'.repeat(64) },
    ],
    ...over,
  });

  it('reads the engine of a pack, and leaves it out for a pack without one', () => {
    expect(qualorManifestSchema.parse(manifest({ dotnetEngine: engine() })).dotnetEngine).toEqual(
      engine(),
    );
    expect(qualorManifestSchema.parse(manifest()).dotnetEngine).toBeUndefined();
  });

  it('marks an engine whose files are not confined to dotnet/, or that does not hold its entry, as invalid, and keeps the pack (ruling R-E14)', () => {
    const file = (p: string) => ({ path: p, sha256: 'e'.repeat(64) });
    const bad = [
      engine({ entry: 'dotnet/engine/Other.dll' }),
      engine({ entry: '../Qualor.Taint.Cli.dll' }),
      engine({ models: 'models' }),
      engine({ models: 'dotnet/../models' }),
      // No listed file below the models directory.
      engine({ models: 'dotnet/other' }),
      engine({ files: [] }),
      engine({ files: [...engine().files, file('rules/csharp/x.yml')] }),
      engine({ files: [...engine().files, file('dotnet/../x.dll')] }),
      engine({ files: [...engine().files, file('dotnet/./x.dll')] }),
      engine({ files: [...engine().files, file('/dotnet/x.dll')] }),
      engine({ files: [...engine().files, file('dotnet\\engine\\x.dll')] }),
      engine({ files: [...engine().files, file('dotnet//x.dll')] }),
      engine({ files: [...engine().files, file('dotnet/engine/Qualor.Taint.Cli.dll')] }),
      engine({ files: [{ path: 'dotnet/engine/Qualor.Taint.Cli.dll', sha256: 'A'.repeat(64) }] }),
      engine({ version: '' }),
      engine({ version: 'x'.repeat(65) }),
    ];
    for (const e of [...bad, null, 'dotnet', []]) {
      const parsed = qualorManifestSchema.safeParse(manifest({ dotnetEngine: e }));
      expect(parsed.success, JSON.stringify(e)).toBe(true);
      expect(parsed.data?.rules, JSON.stringify(e)).toHaveLength(1);
      expect(parsed.data?.dotnetEngine, JSON.stringify(e)).toEqual({ invalid: expect.any(String) });
    }
    // The reason names the field that is wrong.
    const named = (e: unknown) =>
      qualorManifestSchema.parse(manifest({ dotnetEngine: e })).dotnetEngine;
    expect(named(engine({ entry: 'dotnet/engine/Other.dll' }))).toEqual({ invalid: 'entry' });
    expect(named(engine({ files: [...engine().files, file('dotnet/../x.dll')] }))).toEqual({
      invalid: 'files.4.path',
    });
    expect(named(engine({ version: '' }))).toEqual({ invalid: 'version' });
    expect(named(null)).toEqual({ invalid: '(the field itself)' });
  });
});

describe('qualorRuleMeta (report-format.md §7.1, plan 6B-1)', () => {
  it('reads the kind and severity the CLI copied from the manifest', () => {
    expect(
      qualorRuleMeta({ [QUALOR_KIND_PROPERTY]: 'hotspot', [QUALOR_SEVERITY_PROPERTY]: 'low' }),
    ).toEqual({ kind: 'hotspot', severity: 'low' });
  });

  it('falls back to issue/medium for missing or invalid values, and never throws', () => {
    for (const p of [
      undefined,
      {},
      { qualorKind: 'bug', qualorSeverity: 'critical' },
      { qualorKind: 1 },
      { kind: 'hotspot' },
    ]) {
      expect(qualorRuleMeta(p), JSON.stringify(p)).toEqual({ kind: 'issue', severity: 'medium' });
    }
  });
});
