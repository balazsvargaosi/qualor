import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeTree } from './tmp';

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/** The engine files of a synthetic pack: never the real engine (qualor-rules is not MIT). */
export const ENGINE_FILES: Readonly<Record<string, string>> = {
  'dotnet/engine/Qualor.Taint.Cli.dll': 'not a real assembly\n',
  'dotnet/engine/Qualor.Taint.Cli.runtimeconfig.json': '{}\n',
  'dotnet/engine/licenses/YamlDotNet.txt': 'MIT\n',
  'dotnet/models/csharp/sources.yml': 'sources: []\n',
  'dotnet/models/csharp/sql-injection.yml': 'sinks: []\n',
};

/**
 * A synthetic qualor-rules pack at `dir` with the C# rules `ids` (`csharp/<name>`, kind issue,
 * severity `severity`, CWE-89) and, unless `engine` is false, a `dotnetEngine` listing
 * ENGINE_FILES. Returns `dir`.
 */
export function writeEnginePack(
  dir: string,
  o: { ids?: readonly string[]; engine?: boolean; severity?: string } = {},
): string {
  const ids = o.ids ?? ['csharp/sql-injection'];
  const rules = ids.map((id) => {
    const name = id.split('/')[1] ?? '';
    const file = `rules/csharp/${name}/${name}.yml`;
    const text = `rules: [] # ${id}\n`;
    writeTree(dir, { [file]: text });
    return {
      id,
      path: file,
      sha256: sha256(text),
      languages: ['csharp'],
      kind: 'issue',
      severity: o.severity ?? 'high',
      cwe: ['CWE-89'],
      title: `A synthetic rule ${name}`,
    };
  });
  const manifest: Record<string, unknown> = { version: '2026.10.4', opengrep: '1.30.0', rules };
  if (o.engine !== false) {
    writeTree(dir, ENGINE_FILES);
    manifest['dotnetEngine'] = {
      version: '2026.10.4',
      entry: 'dotnet/engine/Qualor.Taint.Cli.dll',
      models: 'dotnet/models',
      files: Object.entries(ENGINE_FILES).map(([p, text]) => ({ path: p, sha256: sha256(text) })),
    };
  }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/** One location of the engine's SARIF: relative to --root with `%SRCROOT%`, as it writes them. */
function location(uri: string, line: number, message?: string) {
  return {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
      region: { startLine: line, startColumn: 1, endLine: line, endColumn: 2 },
    },
    ...(message !== undefined && { message: { text: message } }),
  };
}

export interface EngineFinding {
  rule: string;
  uri: string;
  line: number;
  /** The path from source to sink: [uri, line, message]. */
  steps?: [string, number, string][];
  others?: [string, number][];
}

/** SARIF in the shape Qualor.Taint.Cli `analyze` writes (qualor-rules SarifWriter.cs). */
export function engineSarif(
  root: string,
  findings: readonly EngineFinding[],
  o: { complete?: boolean } = {},
) {
  const ids = [...new Set(findings.map((f) => f.rule))].sort();
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'qualor-taint',
            semanticVersion: '2026.10.4',
            rules: ids.map((id) => ({
              id,
              name: id.slice(id.indexOf('.') + 1),
              shortDescription: { text: `${id}: request data reaches a sink` },
            })),
          },
        },
        originalUriBaseIds: {
          '%SRCROOT%': { uri: `file:///${root.replace(/\\/g, '/').replace(/^\//, '')}/` },
        },
        results: findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ids.indexOf(f.rule),
          level: 'error',
          message: { text: `${f.rule}: request data reaches the sink` },
          locations: [location(f.uri, f.line)],
          ...(f.steps !== undefined && {
            codeFlows: [
              {
                threadFlows: [
                  { locations: f.steps.map(([u, l, m]) => ({ location: location(u, l, m) })) },
                ],
              },
            ],
          }),
          ...(f.others !== undefined && {
            relatedLocations: f.others.map(([u, l], i) => ({
              id: i + 1,
              ...location(u, l, 'other request data reaching the same sink'),
            })),
          }),
        })),
        invocations: [{ executionSuccessful: o.complete ?? true }],
        properties: { analysisStats: { projects: 1, methods: 10, failedMethods: 0 } },
      },
    ],
  };
}
