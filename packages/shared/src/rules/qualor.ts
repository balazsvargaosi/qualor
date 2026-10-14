import { z } from 'zod';
import { ISSUE_KINDS, SEVERITIES, type IssueKind, type Severity } from '../report/taxonomy';

/**
 * Qualor's own security rules (plan 6B-1, config.md §6): the `<lang>` directories of the
 * qualor-rules pack. `js` holds the JavaScript and TypeScript rules, `csharp` the C# rules (6B-C#).
 */
export const QUALOR_RULE_LANGS = ['js', 'python', 'java', 'go', 'csharp'] as const;

const NAME = '[a-z0-9]+(?:-[a-z0-9]+)*';
const LANG = `(${QUALOR_RULE_LANGS.join('|')})`;

/** A Qualor rule id, `<lang>/<name>` (`java/sql-injection`); its key is `qualor:<id>`. */
export const QUALOR_RULE_ID = new RegExp(`^${LANG}/${NAME}$`);

/** OpenGrep refuses `/` in a rule id, so the pack's YAML id is `<lang>.<name>`. */
const OPENGREP_RULE_ID = new RegExp(`^${LANG}\\.(${NAME})$`);

const RULE_PATH = new RegExp(`^rules/${LANG}/${NAME}/(${NAME})\\.yml$`);

/** Pack versions: YYYY.M.patch, the month without a leading zero, the patch up to 6 digits (`2026.10.0`). */
export const QUALOR_PACK_VERSION = /^\d{4}\.([1-9]|1[0-2])\.(0|[1-9]\d{0,5})$/;

/** The Qualor rule id of a pack rule's OpenGrep id (`java.sql-injection` → `java/sql-injection`), else null. */
export function qualorRuleId(opengrepId: string): string | null {
  const m = OPENGREP_RULE_ID.exec(opengrepId);
  return m ? `${m[1]}/${m[2]}` : null;
}

const manifestRule = z.looseObject({
  id: z.string().regex(QUALOR_RULE_ID),
  path: z.string().regex(RULE_PATH),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  languages: z.array(z.string().min(1).max(64)).min(1).max(16),
  kind: z.enum(ISSUE_KINDS),
  severity: z.enum(SEVERITIES),
  cwe: z.array(z.string().regex(/^CWE-[1-9]\d{0,6}$/)).max(16),
  title: z.string().min(1).max(120),
});

/**
 * A path below the pack's `dotnet/` directory: `/`-separated, no empty, `.` or `..` segment and no
 * segment starting with a dot, so it can never leave `dotnet/`.
 */
const DOTNET_PATH = /^dotnet(?:\/[A-Za-z0-9_][A-Za-z0-9._+-]*)+$/;

/**
 * Qualor's Roslyn taint engine in the pack (6B-C# R, spec §4.1): the published tool and its models
 * under `dotnet/`, every file with its SHA-256. The CLI runs `entry` only when every listed file
 * matches and nothing else is there.
 */
const dotnetEngine = z
  .looseObject({
    version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/),
    entry: z.string().max(512).regex(DOTNET_PATH),
    models: z.string().max(512).regex(DOTNET_PATH),
    files: z
      .array(
        z.looseObject({
          path: z.string().max(512).regex(DOTNET_PATH),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(1)
      .max(1_000),
  })
  .superRefine((e, ctx) => {
    const paths = new Set<string>();
    e.files.forEach((f, i) => {
      if (paths.has(f.path)) {
        ctx.addIssue({ code: 'custom', path: ['files', i], message: `${f.path} is listed twice` });
      }
      paths.add(f.path);
    });
    if (!paths.has(e.entry)) {
      ctx.addIssue({ code: 'custom', path: ['entry'], message: 'is not a listed file' });
    }
    if (!e.files.some((f) => f.path.startsWith(`${e.models}/`))) {
      ctx.addIssue({ code: 'custom', path: ['models'], message: 'holds no listed file' });
    }
  });

/** The first field a failed parse names, as `files.4.path`, for a fallback reason. */
function invalidField(issues: readonly z.core.$ZodIssue[]): string {
  // A union reports its members' issues nested; the engine object's own are the useful ones.
  const first = issues[0];
  const nested =
    first !== undefined && first.code === 'invalid_union' ? first.errors[0]?.[0] : undefined;
  const issue = nested ?? first;
  const field = issue?.path.join('.') ?? '';
  return field === '' ? '(the field itself)' : field.slice(0, 200);
}

/**
 * The pack's `manifest.json` (config.md §6): every rule file with its SHA-256 and the metadata the
 * CLI copies into the report. Unknown fields are ignored, so an older CLI reads a newer pack; a rule
 * path must name the rule's own language and name, and ids and paths are unique.
 */
export const qualorManifestSchema = z
  .looseObject({
    version: z.string().regex(QUALOR_PACK_VERSION),
    opengrep: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** The rules are tested with OpenGrep `--taint-intrafile`, so they run that way (plan 6B-6). */
    taintIntrafile: z.boolean().optional(),
    rules: z.array(manifestRule).min(1).max(2_000),
    /**
     * Qualor's Roslyn taint engine for the C# rules under `qualor dotnet end` (6B-C# R). A
     * malformed one never refuses the pack (ruling R-E14): it reads as `{ invalid: <field> }`, the
     * engine does not run and the OpenGrep rules still do.
     */
    dotnetEngine: z
      .union([dotnetEngine, z.strictObject({ invalid: z.string().max(200) })])
      .catch((ctx) => ({ invalid: invalidField(ctx.error.issues) }))
      .optional(),
  })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    m.rules.forEach((r, i) => {
      const [lang, name] = r.id.split('/');
      const p = RULE_PATH.exec(r.path);
      if (!p || p[1] !== lang || p[2] !== name) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'path'],
          message: `does not name ${r.id}`,
        });
      }
      if (ids.has(r.id) || paths.has(r.path)) {
        ctx.addIssue({ code: 'custom', path: ['rules', i], message: `${r.id} is listed twice` });
      }
      ids.add(r.id);
      paths.add(r.path);
    });
  });

export type QualorManifest = z.infer<typeof qualorManifestSchema>;
export type QualorManifestRule = QualorManifest['rules'][number];
/** A valid `dotnetEngine` of the manifest (6B-C# R). */
export type QualorDotnetEngine = z.infer<typeof dotnetEngine>;

/** The SARIF rule properties the CLI's transform writes from the manifest (config.md §6). */
export const QUALOR_KIND_PROPERTY = 'qualorKind';
export const QUALOR_SEVERITY_PROPERTY = 'qualorSeverity';

/**
 * report-format.md §7.1: a qualor rule's kind and severity, from the properties the CLI copied out
 * of the verified manifest; `issue`/`medium` when they are missing or invalid (another pack on a
 * host), never an error.
 */
export function qualorRuleMeta(properties: Readonly<Record<string, unknown>> | undefined): {
  kind: IssueKind;
  severity: Severity;
} {
  const kind = properties?.[QUALOR_KIND_PROPERTY];
  const severity = properties?.[QUALOR_SEVERITY_PROPERTY];
  return {
    kind: (ISSUE_KINDS as readonly unknown[]).includes(kind) ? (kind as IssueKind) : 'issue',
    severity: (SEVERITIES as readonly unknown[]).includes(severity)
      ? (severity as Severity)
      : 'medium',
  };
}
