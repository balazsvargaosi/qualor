import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { parseModelJson } from '@qualor/shared';
import type { RouteDeps } from '../app';
import { actorOf } from '../audit/recorder';
import { requireInstanceAdmin } from '../auth/access';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { uuidList } from '../db/bulk';
import type { Executor } from '../db/client';
import { LOCKS } from '../db/locks';
import { organizations, type EncryptedValue } from '../db/schema';
import { conflict, ProblemError, validationFailed, type FieldError } from '../http/problem';
import { noNul } from '../http/schemas';
import { VERSION } from '../index';
import { IssueChangeLimiter } from '../issues/rate-limit';
import { ERROR_TEXTS, errorCodeOf, LLM_ERROR_CODES, type LlmErrorCode } from '../llm/errors';
import { callProvider, LlmError, PROVIDER_KINDS } from '../llm/providers';
import {
  ANTHROPIC_TEMPERATURE_TEXT,
  autoFixSettingsSchema,
  budgetsSchema,
  DEFAULT_AUTO_FIX,
  DISABLED_ORGANIZATION,
  globSchema,
  LLM_API_KEY_AAD,
  MAX_LLM_ORGANIZATIONS,
  MAX_ORGANIZATION_PROJECT_IDS,
  MAX_TEMPERATURE,
  MODEL_PATTERN,
  organizationSettings,
  orgLlmSettingsSchema,
  pricingSchema,
  projectOwners,
  providerApiKey,
  providerConfig,
  readLlmSettings,
  writeLlmSettings,
  type OrgLlmSettings,
  type StoredLlmSettings,
  type StoredProvider,
} from '../llm/settings';
import { llmBaseUrlProblem } from '../llm/url';
import { isDefaultReview } from '../review/settings';
import { normalBaseUrl } from '../scm/url';

/** llm.md §16: at most this many Test button presses per admin and minute. */
const TESTS_PER_MINUTE = 10;

/**
 * llm.md §3.2: 1–4 096 printable ASCII characters without spaces (header-safe). The message never
 * repeats the value.
 */
const API_KEY_PATTERN = /^[\x21-\x7e]{1,4096}$/;

const providerBody = z.strictObject({
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: noNul(z.string().min(1).max(2_048)),
  model: z.string().regex(MODEL_PATTERN, 'Letters, digits and . _ : / @ + - only, at most 200'),
  auth: z.enum(['bearer', 'api-key']).default('bearer'),
  jsonMode: z.enum(['json_object', 'none']).default('json_object'),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  temperature: z.number().min(0).max(2).nullable().default(null),
  timeoutSeconds: z.number().int().min(5).max(600).default(60),
  apiKey: z
    .string()
    .regex(API_KEY_PATTERN, '1–4 096 printable ASCII characters without spaces')
    .nullable()
    .optional()
    .meta({
      description:
        'Write-only. A string sets the key, null removes it (a local model), absent keeps it; a new base URL needs it again',
    }),
});

/**
 * An organisation as this route reads and writes it. 6I-2: without its `review` block, which only
 * `PUT /organizations/{id}/ai/review` changes: AI review is the organisation admin's to switch on,
 * and acknowledging the data-sharing notice is theirs to give, so the instance admin's save neither
 * shows nor sets it and always keeps what is stored.
 */
const orgSettingsWithoutReview = orgLlmSettingsSchema.omit({ review: true });

/**
 * An organisation in the body. 4E-3a §2: the auto-fix fields may be left out (a form that does not
 * know them), which keeps what is stored, so a save never undoes an organisation admin's choice.
 */
const orgBody = orgSettingsWithoutReview.extend({
  autoFix: autoFixSettingsSchema.optional().meta({ description: 'Absent keeps the stored value' }),
  autoFixDisabledProjectIds: z
    .array(z.uuid())
    .max(MAX_ORGANIZATION_PROJECT_IDS)
    .optional()
    .meta({ description: 'Absent keeps the stored value' }),
});
type OrgBody = z.infer<typeof orgBody>;

/**
 * An entry that says no more than an absent one (llm.md §3.3: disabled, nothing excluded, the
 * auto-fix defaults). The organisation and project auto-fix routes create such entries, so they
 * do not count towards MAX_LLM_ORGANIZATIONS.
 */
function isDisabledDefault(o: OrgBody): boolean {
  const autoFix = o.autoFix ?? DEFAULT_AUTO_FIX;
  return (
    !o.enabled &&
    !o.features.explain &&
    !o.features.triage &&
    !o.features.fix &&
    o.excludedProjectIds.length === 0 &&
    autoFix.enabled === DEFAULT_AUTO_FIX.enabled &&
    autoFix.minSeverity === DEFAULT_AUTO_FIX.minSeverity &&
    autoFix.maxPerAnalysis === DEFAULT_AUTO_FIX.maxPerAnalysis &&
    (o.autoFixDisabledProjectIds ?? []).length === 0
  );
}

const settingsBody = z.strictObject({
  provider: providerBody.nullable(),
  organizations: z
    .record(z.uuid(), orgBody)
    .refine(
      (o) =>
        Object.values(o).filter((entry) => !isDisabledDefault(entry)).length <=
        MAX_LLM_ORGANIZATIONS,
      `At most ${MAX_LLM_ORGANIZATIONS} organisations`,
    ),
  excludePaths: z.array(globSchema).max(100),
  budgets: budgetsSchema,
  pricing: pricingSchema,
  storePrompts: z.boolean(),
  promptRetentionDays: z.number().int().min(1).max(90),
});
type SettingsBody = z.infer<typeof settingsBody>;

const settingsDto = z.object({
  provider: z
    .object({
      kind: z.enum(PROVIDER_KINDS),
      baseUrl: z.string(),
      model: z.string(),
      auth: z.enum(['bearer', 'api-key']),
      jsonMode: z.enum(['json_object', 'none']),
      maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']),
      temperature: z.number().nullable(),
      timeoutSeconds: z.number().int(),
      /** A key is stored (never the key itself). */
      apiKeySet: z.boolean(),
      /** False when the stored key no longer decrypts (QUALOR_SECRET_KEY changed). */
      apiKeyReadable: z.boolean(),
    })
    .nullable(),
  organizations: z.record(z.string(), orgSettingsWithoutReview),
  excludePaths: z.array(z.string()),
  budgets: budgetsSchema,
  pricing: pricingSchema,
  storePrompts: z.boolean(),
  promptRetentionDays: z.number().int(),
});

const testResult = z.object({
  ok: z.boolean(),
  model: z.string().nullable(),
  latencyMs: z.number().int(),
  problem: z
    .object({
      code: z.enum(LLM_ERROR_CODES),
      message: z.string(),
      /** The provider's HTTP status when it answered with an error (401 and 403 read apart). */
      providerStatus: z.number().int().nullable(),
    })
    .nullable(),
});
type TestResult = z.infer<typeof testResult>;

/**
 * llm.md §3.2: the model name as the provider gave it, at most 200 UTF-16 units, never cut inside
 * a surrogate pair.
 */
function modelName(model: string): string {
  if (model.length <= 200) return model;
  const cut = model.slice(0, 200);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * llm.md §16, Review Focus 1: a 404 from an OpenAI-compatible base URL without a version path is
 * almost always a missing `/v1`: the Test result names it.
 */
function missingV1Hint(provider: StoredProvider, status: number | null): string {
  if (status !== 404 || provider.kind !== 'openai') return '';
  const path = new URL(provider.baseUrl).pathname;
  return /\/v\d+(?:beta)?(?:\/|$)/.test(path)
    ? ''
    : ' (the base URL has no version path: most OpenAI-compatible servers need /v1 at its end)';
}

/** llm.md §16: the Test button's prompt holds no repository data. */
const TEST_CALL = {
  system: 'Answer with the JSON object {"ok": true} and nothing else.',
  user: 'ping',
  maxOutputTokens: 20,
};

/** Every project id the organisations list (excluded, or opted out of auto-fix). */
const listedProjectIdsOf = (
  organizations: Record<string, Pick<OrgBody, 'excludedProjectIds' | 'autoFixDisabledProjectIds'>>,
) =>
  Object.values(organizations).flatMap((o) => [
    ...o.excludedProjectIds,
    ...(o.autoFixDisabledProjectIds ?? []),
  ]);

/** `organizations` without the listed ids of projects that no longer exist (llm.md §3.3). */
function withoutDeletedProjects(
  organizations: Record<string, OrgLlmSettings>,
  owners: ReadonlyMap<string, string>,
): Record<string, OrgLlmSettings> {
  return Object.fromEntries(
    Object.entries(organizations).map(([id, o]) => [
      id,
      {
        ...o,
        excludedProjectIds: o.excludedProjectIds.filter((p) => owners.has(p)),
        // Each id once (a body may repeat one).
        autoFixDisabledProjectIds: [
          ...new Set(o.autoFixDisabledProjectIds.filter((p) => owners.has(p))),
        ],
      },
    ]),
  );
}

/** Which of the organisations still exist. */
async function existingOrganizations(db: Executor, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.id} IN ${uuidList(ids)}`);
  return new Set(found.map((r) => r.id));
}

/** Whether a stored entry holds an auto-fix choice: a value other than the defaults. */
const hasAutoFixChoice = (o: OrgLlmSettings) =>
  o.autoFix.enabled !== DEFAULT_AUTO_FIX.enabled ||
  o.autoFix.minSeverity !== DEFAULT_AUTO_FIX.minSeverity ||
  o.autoFix.maxPerAnalysis !== DEFAULT_AUTO_FIX.maxPerAnalysis ||
  o.autoFixDisabledProjectIds.length > 0;

/** Whether a stored entry holds an AI review setting other than the defaults (6I-2). */
const hasReviewChoice = (o: OrgLlmSettings) => !isDefaultReview(o.review);

/**
 * The body's organisations, an auto-fix field left out keeping the stored one (4E-3a §2), and the
 * AI review block always the stored one (6I-2: the body cannot carry it). An organisation the body
 * leaves out loses its switches and exclusions, as before, but keeps its auto-fix choice and its AI
 * review: a form loaded before an organisation admin made them must not undo them. Its entry is
 * then the one the organisation's own routes create (disabled, the choices kept; review then
 * reports `organization_disabled`). `kept`: those organisations ({@link omittedWithChoice}) that
 * still exist.
 */
function withStoredChoices(
  organizations: Record<string, OrgBody>,
  current: StoredLlmSettings,
  kept: ReadonlySet<string>,
): Record<string, OrgLlmSettings> {
  return Object.fromEntries([
    ...[...kept].map((id): [string, OrgLlmSettings] => {
      const stored = organizationSettings(current, id);
      return [
        id,
        {
          ...DISABLED_ORGANIZATION,
          features: { ...DISABLED_ORGANIZATION.features },
          excludedProjectIds: [],
          autoFix: stored.autoFix,
          autoFixDisabledProjectIds: stored.autoFixDisabledProjectIds,
          review: stored.review,
        },
      ];
    }),
    ...Object.entries(organizations).map(([id, o]): [string, OrgLlmSettings] => {
      const stored = organizationSettings(current, id);
      return [
        id,
        {
          ...o,
          autoFix: o.autoFix ?? stored.autoFix,
          autoFixDisabledProjectIds:
            o.autoFixDisabledProjectIds ?? stored.autoFixDisabledProjectIds,
          review: stored.review,
        },
      ];
    }),
  ]);
}

/**
 * The ids of the organisations the body leaves out whose stored entry holds an auto-fix choice or
 * an AI review setting.
 */
const omittedWithChoice = (
  organizations: Record<string, OrgBody>,
  current: StoredLlmSettings,
): string[] =>
  Object.entries(current.organizations)
    .filter(
      ([id, o]) => !Object.hasOwn(organizations, id) && (hasAutoFixChoice(o) || hasReviewChoice(o)),
    )
    .map(([id]) => id);

/** 4E-3a §2: the organisations without their auto-fix fields, and with only those. */
const withoutAutoFix = (organizations: Record<string, OrgLlmSettings>) =>
  Object.fromEntries(
    Object.entries(organizations).map(([id, o]) => [
      id,
      { enabled: o.enabled, features: o.features, excludedProjectIds: o.excludedProjectIds },
    ]),
  );
const autoFixOf = (organizations: Record<string, OrgLlmSettings>) =>
  Object.fromEntries(
    Object.entries(organizations).map(([id, o]) => [
      id,
      { autoFix: o.autoFix, autoFixDisabledProjectIds: o.autoFixDisabledProjectIds },
    ]),
  );

/** The organisation as this route shows it: all of it but its AI review block (6I-2). */
const withoutReview = (o: OrgLlmSettings): z.infer<typeof orgSettingsWithoutReview> => ({
  enabled: o.enabled,
  features: o.features,
  excludedProjectIds: o.excludedProjectIds,
  autoFix: o.autoFix,
  autoFixDisabledProjectIds: o.autoFixDisabledProjectIds,
});

function dto(s: StoredLlmSettings, secretKey: string): z.infer<typeof settingsDto> {
  return {
    provider: s.provider && {
      ...providerConfig(s.provider),
      apiKeySet: s.provider.apiKeyEnc !== null,
      apiKeyReadable: providerApiKey(s, secretKey).ok,
    },
    organizations: Object.fromEntries(
      Object.entries(s.organizations).map(([id, o]) => [id, withoutReview(o)]),
    ),
    excludePaths: s.excludePaths,
    budgets: s.budgets,
    pricing: s.pricing,
    storePrompts: s.storePrompts,
    promptRetentionDays: s.promptRetentionDays,
  };
}

/**
 * llm.md §3.2: a stored key is only ever sent to the address it was entered for. `baseUrl` is
 * already normalised; `'needs_key'` when the address is new and no key (or null) came with it.
 */
function nextKey(
  current: StoredProvider | null,
  incoming: { baseUrl: string; apiKey?: string | null | undefined },
  key: Buffer,
): EncryptedValue | null | 'needs_key' {
  const moved = current === null || incoming.baseUrl !== current.baseUrl;
  if (incoming.apiKey === undefined) return moved ? 'needs_key' : current.apiKeyEnc;
  return incoming.apiKey === null ? null : encryptSecret(key, incoming.apiKey, LLM_API_KEY_AAD);
}

/** The names of the fields a write changed (never a value), for the audit log line. */
function changedFields(
  current: StoredLlmSettings,
  next: StoredLlmSettings,
  keySent: boolean,
): string[] {
  const fields: string[] = [];
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  if (current.provider === null || next.provider === null) {
    if (current.provider !== next.provider) fields.push('provider');
  } else {
    const before = providerConfig(current.provider);
    const after = providerConfig(next.provider);
    for (const k of Object.keys(after) as (keyof typeof after)[]) {
      if (differs(before[k], after[k])) fields.push(`provider.${k}`);
    }
  }
  if (keySent) fields.push('provider.apiKey');
  return [...fields, ...settingsFieldsChanged(current, next, differs)];
}

/**
 * The names of the settings outside the provider that differ. `organizations` names a change of an
 * organisation's switches or exclusions, `autoFix` one of its automatic fix suggestions or
 * opt-outs (4E-3a §2).
 */
function settingsFieldsChanged(
  current: StoredLlmSettings,
  next: StoredLlmSettings,
  differs: (a: unknown, b: unknown) => boolean,
): string[] {
  const fields: string[] = [];
  if (differs(withoutAutoFix(current.organizations), withoutAutoFix(next.organizations))) {
    fields.push('organizations');
  }
  if (differs(autoFixOf(current.organizations), autoFixOf(next.organizations))) {
    fields.push('autoFix');
  }
  for (const k of [
    'excludePaths',
    'budgets',
    'pricing',
    'storePrompts',
    'promptRetentionDays',
  ] as const) {
    if (differs(current[k], next[k])) fields.push(k);
  }
  return fields;
}

/** The top-level settings keys whose JSON differs (the provider without its key envelope). */
function changedTopLevelKeys(current: StoredLlmSettings, next: StoredLlmSettings): string[] {
  const provider = (s: StoredLlmSettings) => (s.provider ? providerConfig(s.provider) : null);
  // Keys sorted at every level: a row read back from jsonb has another key order than a body.
  const sorted = (_key: string, value: unknown): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value;
  const differs = (a: unknown, b: unknown) =>
    JSON.stringify(a, sorted) !== JSON.stringify(b, sorted);
  const fields: string[] = [];
  if (differs(provider(current), provider(next))) fields.push('provider');
  return [...fields, ...settingsFieldsChanged(current, next, differs)];
}

/** The projects an organisation's lists name that belong to another organisation (`owners`). */
function foreignProjectProblems(
  id: string,
  o: SettingsBody['organizations'][string],
  owners: ReadonlyMap<string, string>,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const list of ['excludedProjectIds', 'autoFixDisabledProjectIds'] as const) {
    (o[list] ?? []).forEach((projectId, i) => {
      const owner = owners.get(projectId);
      if (owner !== undefined && owner !== id) {
        errors.push({
          path: `body.organizations.${id}.${list}.${i}`,
          message: 'Not a project of this organisation',
        });
      }
    });
  }
  return errors;
}

export const llmSettingsRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (
  app,
  { deps },
) => {
  const key = encryptionKey(deps.config.secretKey);
  const tests = new IssueChangeLimiter({ perMinute: TESTS_PER_MINUTE, burst: TESTS_PER_MINUTE });
  /** llm.md §16: one Test in flight per admin (a slow model must not pile up requests). */
  const testing = new Set<string>();

  /**
   * The checks the schema cannot make (llm.md §3–§4), every failing field at once. An excluded
   * project of another organisation is refused; one that no longer exists is dropped (`owners`).
   */
  const fieldProblems = (
    body: SettingsBody,
    known: ReadonlySet<string>,
    owners: ReadonlyMap<string, string>,
    stored: StoredLlmSettings,
  ): FieldError[] => {
    const errors: FieldError[] = [];
    if (body.provider) {
      const problem = llmBaseUrlProblem(body.provider.baseUrl, deps.config.llmInternalHosts);
      if (problem) errors.push({ path: 'body.provider.baseUrl', message: problem });
      const temperature = body.provider.temperature;
      if (temperature !== null && temperature > MAX_TEMPERATURE[body.provider.kind]) {
        errors.push({ path: 'body.provider.temperature', message: ANTHROPIC_TEMPERATURE_TEXT });
      }
    }
    for (const [id, o] of Object.entries(body.organizations)) {
      if (!known.has(id)) {
        errors.push({ path: `body.organizations.${id}`, message: 'No such organisation' });
        continue;
      }
      errors.push(...foreignProjectProblems(id, o, owners));
      // 4E-3a §2: only switching the automatic fix on needs the enterprise feature `llm.auto-fix`.
      // A switch-on saved while the licence allowed it is kept, so the form still saves after the
      // licence lapses.
      if (
        o.autoFix?.enabled === true &&
        !organizationSettings(stored, id).autoFix.enabled &&
        !deps.edition.limits().llm.automaticFixSuggestions
      ) {
        errors.push({
          path: `body.organizations.${id}.autoFix.enabled`,
          message: 'Needs the enterprise feature llm.auto-fix',
        });
      }
    }
    return errors;
  };

  /** The organisations of `ids` that exist. */
  const knownOrganizations = (ids: readonly string[]) => existingOrganizations(deps.db, ids);

  /** The settings as stored, without excluded projects deleted since they were saved. */
  const readForAdmin = async (): Promise<StoredLlmSettings> => {
    const settings = await readLlmSettings(deps.db);
    const owners = await projectOwners(deps.db, listedProjectIdsOf(settings.organizations));
    return {
      ...settings,
      organizations: withoutDeletedProjects(settings.organizations, owners),
    };
  };

  app.get(
    '/system/llm',
    {
      schema: {
        tags: ['llm'],
        summary: 'The AI assistant settings (instance admins); never the API key',
        response: { 200: settingsDto },
      },
    },
    async (request) => {
      requireInstanceAdmin(request);
      return dto(await readForAdmin(), deps.config.secretKey);
    },
  );

  app.put(
    '/system/llm',
    {
      schema: {
        tags: ['llm'],
        summary:
          'Replace the AI assistant settings (instance admins); the API key is write-only, and a new base URL needs it again',
        body: settingsBody,
        response: { 200: settingsDto },
      },
    },
    async (request) => {
      const principal = requireInstanceAdmin(request);
      const body = request.body;
      const owners = await projectOwners(deps.db, listedProjectIdsOf(body.organizations));
      const known = await knownOrganizations(Object.keys(body.organizations));
      const stored = await readLlmSettings(deps.db);
      const errors = fieldProblems(body, known, owners, stored);
      if (errors.length > 0) throw validationFailed(errors);
      const { current, next } = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCKS.llmSettings})`);
        const current = await readLlmSettings(tx);
        let provider: StoredProvider | null = null;
        if (body.provider) {
          const { apiKey, ...given } = body.provider;
          // llm.md §3.2: `auth`, `jsonMode` and `maxTokensField` are the `openai` adapter's; an
          // Anthropic provider stores their defaults, whatever the form sent.
          const rest =
            given.kind === 'anthropic'
              ? {
                  ...given,
                  auth: 'bearer' as const,
                  jsonMode: 'json_object' as const,
                  maxTokensField: 'max_tokens' as const,
                }
              : given;
          const baseUrl = normalBaseUrl(rest.baseUrl);
          const apiKeyEnc = nextKey(current.provider, { baseUrl, apiKey }, key);
          if (apiKeyEnc === 'needs_key') {
            throw validationFailed([
              {
                path: 'body.provider.apiKey',
                message: 'Enter the API key again for a new address (null for none)',
              },
            ]);
          }
          provider = { ...rest, baseUrl, apiKeyEnc };
        }
        const kept = await existingOrganizations(
          tx,
          omittedWithChoice(body.organizations, current),
        );
        const organizations = withStoredChoices(body.organizations, current, kept);
        // A project deleted meanwhile (or since the page read the settings) is dropped, a stored
        // opt-out the body left out included.
        const listed = await projectOwners(tx, listedProjectIdsOf(organizations));
        const next: StoredLlmSettings = {
          v: 1,
          provider,
          organizations: withoutDeletedProjects(organizations, listed),
          excludePaths: body.excludePaths,
          budgets: body.budgets,
          pricing: body.pricing,
          storePrompts: body.storePrompts,
          promptRetentionDays: body.promptRetentionDays,
        };
        await writeLlmSettings(tx, next);
        // rbac-audit.md §8: names of the top-level keys that changed and what became of the key,
        // never a value.
        const given = body.provider?.apiKey;
        await deps.audit.record(tx, actorOf(request), [
          {
            action: 'ai.settings_updated',
            target: { type: 'ai_settings', id: 'llm' },
            details: {
              changed: changedTopLevelKeys(current, next),
              apiKey:
                typeof given === 'string'
                  ? 'set'
                  : (given === null || body.provider === null) && current.provider?.apiKeyEnc
                    ? 'removed'
                    : 'kept',
            },
          },
        ]);
        return { current, next };
      });
      const keySent = body.provider !== null && body.provider.apiKey !== undefined;
      request.log.info(
        { userId: principal.user.id, fields: changedFields(current, next, keySent) },
        'LLM settings changed',
      );
      return dto(next, deps.config.secretKey);
    },
  );

  app.post(
    '/system/llm/test',
    {
      config: {
        openapi: {
          problems: [409, 429],
          problemDescriptions: {
            409: 'No LLM provider is configured (AI_DISABLED)',
            429: 'More than 10 tests a minute by this user, or one of theirs still running (RATE_LIMITED); see Retry-After',
          },
        },
      },
      schema: {
        tags: ['llm'],
        summary:
          'Send a fixed prompt holding no repository data to the saved provider (instance admins); no audit row, no quota',
        response: { 200: testResult },
      },
    },
    async (request): Promise<TestResult> => {
      const principal = requireInstanceAdmin(request);
      const userId = principal.user.id;
      if (testing.has(userId)) {
        throw new ProblemError(429, 'RATE_LIMITED', 'A test of the provider is already running', {
          headers: { 'retry-after': '5' },
        });
      }
      const wait = tests.take(userId, 1);
      if (wait !== null) {
        throw new ProblemError(429, 'RATE_LIMITED', `Too many tests; retry in ${wait} s`, {
          headers: { 'retry-after': String(wait) },
        });
      }
      testing.add(userId);
      try {
        return await runTest();
      } finally {
        testing.delete(userId);
      }
    },
  );

  async function runTest(): Promise<TestResult> {
    const settings = await readLlmSettings(deps.db);
    if (!settings.provider) throw conflict('AI_DISABLED', 'No LLM provider is configured');
    const apiKey = providerApiKey(settings, deps.config.secretKey);
    const failed = (
      code: LlmErrorCode,
      message: string,
      latencyMs: number,
      providerStatus: number | null = null,
    ): TestResult => ({
      ok: false,
      model: null,
      latencyMs,
      problem: { code, message, providerStatus },
    });
    if (!apiKey.ok) return failed('KEY_UNDECRYPTABLE', ERROR_TEXTS.KEY_UNDECRYPTABLE, 0);
    const started = Date.now();
    try {
      const answer = await callProvider(providerConfig(settings.provider), apiKey.key, TEST_CALL, {
        internalHosts: deps.config.llmInternalHosts,
        version: VERSION,
      });
      const latencyMs = Date.now() - started;
      // The model name is the provider's text: bounded, and never anything holding the key.
      const model =
        answer.model === null || (apiKey.key !== null && answer.model.includes(apiKey.key))
          ? null
          : modelName(answer.model);
      const code: LlmErrorCode | null =
        answer.finishReason === 'length'
          ? 'OUTPUT_TRUNCATED'
          : answer.finishReason === 'refusal'
            ? 'MODEL_REFUSED'
            : answer.finishReason === 'tool' || parseModelJson(answer.text) === undefined
              ? 'MALFORMED_OUTPUT'
              : null;
      return {
        ok: code === null,
        model,
        latencyMs,
        problem: code === null ? null : { code, message: ERROR_TEXTS[code], providerStatus: null },
      };
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      return failed(
        errorCodeOf(err),
        err.message + missingV1Hint(settings.provider, err.status),
        Date.now() - started,
        err.status,
      );
    }
  }
};
