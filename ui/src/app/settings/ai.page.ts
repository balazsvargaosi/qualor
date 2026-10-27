import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  resource,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ok } from '../api/api';
import { fieldErrors, problemMessage } from '../api/errors';
import type { ItemOf, Organization, RequestBody, ResponseBody } from '../api/types';
import { SessionStore } from '../auth/session';
import { Meter } from '../charts/meter';
import { label } from '../i18n/labels';
import { OrgContext } from '../org/org-context';
import { inputValue, isChecked } from '../shared/forms';
import { SystemInfo } from '../shell/system-info';
import {
  settingsProblemText,
  testHintText,
  type TestHintCode,
  type TestLine,
  testLine,
} from './ai-text';
import { defaultOutputLimitField } from './ai/provider-section';
import {
  AUTO_FIX_FEATURE,
  AUTO_FIX_SEVERITIES,
  type AutoFix,
  type AutoFixSeverity,
  autoFixNotLicensed,
  DEFAULT_AUTO_FIX,
  isAutoFixSeverity,
  MAX_AUTO_FIX_PER_ANALYSIS,
  maxPerAnalysisRefusal,
  parseMaxPerAnalysis,
} from './auto-fix';

type Settings = ResponseBody<'/api/v0/system/llm', 'get'>;
type SettingsBody = RequestBody<'/api/v0/system/llm', 'put'>;
/**
 * What this form edits of an organisation, besides its automatic fix suggestions. Organisation and
 * project admins change `autoFix` and `autoFixDisabledProjectIds` meanwhile, and the server keeps
 * the stored values of the fields a save leaves out: the form sends an organisation's `autoFix`
 * only when it was edited here (ruling R1), and never `autoFixDisabledProjectIds`.
 */
type OrgSettings = Pick<
  Settings['organizations'][string],
  'enabled' | 'features' | 'excludedProjectIds'
>;
type Feature = keyof OrgSettings['features'];
type Kind = '' | 'openai' | 'anthropic';
type Project = ItemOf<'/api/v0/projects'>;
/** An organisation's automatic fix suggestions as the form holds them: the maximum as typed. */
interface AutoFixDraft {
  enabled: boolean;
  minSeverity: AutoFixSeverity;
  maxPerAnalysis: string;
}
/** A project an organisation may exclude: a listed one, or an excluded id the list did not have. */
interface ExcludableProject {
  id: string;
  name: string | null;
}

/** The form's fields a refusal can point at; each is the input `#ai-<field>`. */
const FIELDS = [
  'kind',
  'url',
  'model',
  'strong-model',
  'fast-model',
  'key',
  'workspace-id',
  'timeout',
  'temperature',
  'exclude',
  'budget-explain',
  'budget-triage',
  'budget-fix',
  'budget-tokens',
  'budget-cost',
  'budget-user',
  'budget-review',
  'price-input',
  'price-output',
  'price-strong-input',
  'price-strong-output',
  'price-fast-input',
  'price-fast-output',
  'retention',
] as const;
type Field = (typeof FIELDS)[number];

/** The server's 422 paths (llm.md §16) and the field each one refuses. */
const SERVER_PATHS: [string, Field][] = [
  ['body.provider.kind', 'kind'],
  ['body.provider.baseUrl', 'url'],
  ['body.provider.model', 'model'],
  ['body.provider.strongModel', 'strong-model'],
  ['body.provider.fastModel', 'fast-model'],
  ['body.provider.apiKey', 'key'],
  ['body.provider.workspaceId', 'workspace-id'],
  ['body.provider.timeoutSeconds', 'timeout'],
  ['body.provider.temperature', 'temperature'],
  ['body.excludePaths', 'exclude'],
  ['body.budgets.explainPerDay', 'budget-explain'],
  ['body.budgets.triagePerDay', 'budget-triage'],
  ['body.budgets.fixPerDay', 'budget-fix'],
  ['body.budgets.tokensPerDay', 'budget-tokens'],
  ['body.budgets.costPerDayUsd', 'budget-cost'],
  ['body.budgets.perUserPerHour', 'budget-user'],
  ['body.budgets.reviewTokensPerOrganizationPerDay', 'budget-review'],
  ['body.pricing.inputUsdPerMTok', 'price-input'],
  ['body.pricing.outputUsdPerMTok', 'price-output'],
  ['body.pricing.strong.inputUsdPerMTok', 'price-strong-input'],
  ['body.pricing.strong.outputUsdPerMTok', 'price-strong-output'],
  // A tier's prices missing for its own model ("Give … prices too"). The server's other refusal
  // there, a pair for a tier without a model of its own ("Set … first"), cannot come from this
  // page: it sends no pair for such a tier (`pricingBody`).
  ['body.pricing.strong', 'price-strong-input'],
  ['body.pricing.fast.inputUsdPerMTok', 'price-fast-input'],
  ['body.pricing.fast.outputUsdPerMTok', 'price-fast-output'],
  ['body.pricing.fast', 'price-fast-input'],
  ['body.pricing', 'price-input'],
  ['body.promptRetentionDays', 'retention'],
];

/** A 422 path of an organisation's automatic fix block: its id, then the field. */
const AUTO_FIX_PATH = /^body\.organizations\.([^.]+)\.autoFix(?:\.(\w+))?$/;

/** llm.md §3.2: at most 100 excluded path globs. */
const MAX_EXCLUDE_PATHS = 100;
/** A model's name as the provider spells it (the server's `MODEL_PATTERN`). */
const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;
/** An Anthropic workspace as the console names it (the server's `WORKSPACE_ID_PATTERN`). */
const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{1,64}$/;
/** The most a temperature may be: OpenAI-compatible providers only, Anthropic's models take none. */
const MAX_TEMPERATURE = 2;
/** The organisations an instance admin sees (ruling R11), read page by page up to this bound. */
const ORG_PAGES = 10;
/** The projects offered for exclusion (all of the instance's), read page by page up to this bound. */
const PROJECT_PAGES = 20;

/**
 * The AI assistant (llm.md §3, §18), for instance admins: the one provider of the instance (its
 * kind, address, model, the optional models of AI review's strong and fast tiers, and options, and
 * an API key that is write-only: read from its field once at a submission, emptied at once whatever
 * happens next, never kept in the page's state, never shown), each organisation's enablement and
 * features and its automatic fix suggestions (4E-3a §4: the Enterprise note in place of them
 * without `llm.auto-fix`), the excluded paths, the budgets (the fix budget has no edition ceiling,
 * 6I D10; the ceiling on AI review's tokens per organisation and day, which every save sends back
 * because the server clears one that is left out, 6I-2), prices (the model's, and a pair for each
 * tier that has a model of its own), prompt storage, and a Test of the saved provider's models.
 * Refusals and test problems are shown in the page's own words (plan 1F ruling Y3).
 *
 * Step 8 of the redesign (spec §7.8): today's use of the current organisation against its budgets
 * as meters (`GET /organizations/{id}/ai`; a failed read leaves an alert in its panel), then the
 * settings in setting rows, panel by panel; the fields keep their ids.
 */
@Component({
  selector: 'q-ai-settings-page',
  imports: [Meter, RouterLink],
  templateUrl: './ai.page.html',
  styleUrl: './ai.page.css',
})
export class AiSettingsPage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly session = inject(SessionStore);
  private readonly info = inject(SystemInfo);
  protected readonly org = inject(OrgContext);
  protected readonly instanceAdmin = computed(() => this.session.user()?.isInstanceAdmin === true);
  /** Today's use and the budgets of the organisation chosen in the header (llm.md §12.1). */
  protected readonly today = resource({
    params: () => (this.instanceAdmin() ? (this.org.currentId() ?? undefined) : undefined),
    loader: ({ params }) =>
      ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai', { params: { path: { id: params } } }),
      ),
  });
  protected readonly todayValue = computed(() =>
    this.today.hasValue() ? this.today.value() : null,
  );
  /** Whether today's token or cost budget is spent: every feature waits then, not only one. */
  protected readonly budgetHold = computed(() => {
    const t = this.todayValue();
    if (!t?.enabled) return false;
    const { tokensPerDay, costPerDayUsd } = t.budgets;
    const cost = t.usage.costUsd;
    // A budget of 0 allows none (its meter says so): nothing waits for midnight then.
    return (
      (tokensPerDay !== null && tokensPerDay > 0 && t.usage.tokens >= tokensPerDay) ||
      (costPerDayUsd !== null && costPerDayUsd > 0 && cost !== null && cost >= costPerDayUsd)
    );
  });

  protected readonly settings = signal<Settings | null>(null);
  protected readonly organizations = signal<Organization[]>([]);
  /** Each organisation's projects, by organisation id. */
  protected readonly projects = signal<Record<string, Project[]>>({});
  protected readonly loadError = signal<string | null>(null);

  protected readonly kind = signal<Kind>('');
  protected readonly url = signal('');
  protected readonly model = signal('');
  protected readonly strongModel = signal('');
  protected readonly fastModel = signal('');
  /** The API an OpenAI-compatible provider is asked through (the server's `api`). */
  protected readonly openAiApi = signal<'chat_completions' | 'responses'>('chat_completions');
  protected readonly auth = signal<'bearer' | 'api-key'>('bearer');
  protected readonly jsonMode = signal<'json_object' | 'none'>('json_object');
  protected readonly maxTokensField = signal<'max_tokens' | 'max_completion_tokens'>('max_tokens');
  /** Set once the admin picks the output limit field; until then the base URL's host decides. */
  private maxTokensFieldChosen = false;
  protected readonly workspaceId = signal('');
  protected readonly timeout = signal('60');
  protected readonly temperature = signal('');
  protected readonly removeKey = signal(false);
  protected readonly orgSettings = signal<Record<string, OrgSettings>>({});
  protected readonly exclude = signal('');
  protected readonly budgets = signal<Record<string, string>>({});
  protected readonly priceInput = signal('');
  protected readonly priceOutput = signal('');
  protected readonly priceStrongInput = signal('');
  protected readonly priceStrongOutput = signal('');
  protected readonly priceFastInput = signal('');
  protected readonly priceFastOutput = signal('');
  protected readonly storePrompts = signal(false);
  protected readonly retention = signal('7');

  /** Each organisation's automatic fix suggestions (4E-3a §2), stored or as edited. */
  protected readonly autoFix = signal<Record<string, AutoFixDraft>>({});
  /** The blocks as last loaded or saved: a save sends only those that differ (ruling R1). */
  private loadedAutoFix: Readonly<Record<string, AutoFixDraft>> = {};
  /** A refused automatic fix block, by organisation id. */
  protected readonly autoFixErrors = signal<Record<string, string>>({});
  /** The enterprise feature `llm.auto-fix` is active: else the note replaces the controls. */
  protected readonly autoFixAvailable = computed(() =>
    this.info.features().includes(AUTO_FIX_FEATURE),
  );
  protected readonly autoFixNotLicensed = autoFixNotLicensed();
  protected readonly severities = AUTO_FIX_SEVERITIES;
  protected readonly maxAutoFix = MAX_AUTO_FIX_PER_ANALYSIS;

  protected readonly errors = signal<Partial<Record<Field, string>>>({});
  protected readonly announcement = signal<string | null>(null);
  /**
   * What the last Test found out about tool calling, which AI review needs; null while it is not
   * known (no Test yet, a Test that failed, or a check that could not tell).
   */
  protected readonly toolCalling = signal<'supported' | 'not_supported' | null>(null);
  /**
   * What the last Test suggests changing, when it can tell: the model takes tools only through the
   * Responses API (asked through Chat Completions). Null: nothing to suggest. It is shown with the
   * tool calling it explains, and a Test sets both.
   */
  protected readonly toolsHint = signal<TestHintCode | null>(null);
  protected readonly useResponsesHint = testHintText('USE_RESPONSES_API');
  /**
   * What the last Test found out about each model, one line per model, when the provider has more
   * than one; empty otherwise (a single model is shown as the connection and its tool calling).
   */
  protected readonly testLines = signal<TestLine[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly provider = computed(() => this.settings()?.provider ?? null);
  /**
   * The Responses API is chosen for an OpenAI-compatible provider: its limit is always
   * `max_output_tokens`, so the settings' output limit field is not shown. The choice is the OpenAI
   * kind's alone.
   */
  protected readonly responsesChosen = computed(
    () => this.kind() === 'openai' && this.openAiApi() === 'responses',
  );
  /**
   * A tier's model as typed, when it has one of its own: only such a tier has prices of its own, so
   * only its price fields are shown. With the kind None there is no provider and so no model of a
   * tier: no price of a tier is shown or sent, which the server would refuse.
   */
  protected readonly strongOwn = computed(() => this.ownModelOf(this.strongModel()));
  protected readonly fastOwn = computed(() => this.ownModelOf(this.fastModel()));
  protected readonly enabledCount = computed(
    () => Object.values(this.settings()?.organizations ?? {}).filter((o) => o.enabled).length,
  );
  /** The host the data would go to: the address typed, else the saved one. */
  protected readonly targetHost = computed(() => {
    for (const raw of [this.url(), this.provider()?.baseUrl ?? '']) {
      try {
        return new URL(raw.trim()).host;
      } catch {
        // Not a URL (yet): try the saved one.
      }
    }
    return null;
  });

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly keyField = viewChild<ElementRef<HTMLInputElement>>('keyField');

  constructor() {
    effect(() => {
      const admin = this.instanceAdmin();
      untracked(() => {
        if (admin) void this.load();
      });
    });
    // Nothing typed into the key field outlives the page.
    inject(DestroyRef).onDestroy(() => this.emptyKey());
  }

  /** The tier's model as the server counts it, none while the kind is None. */
  private ownModelOf(tier: string): string | null {
    return this.kind() === '' ? null : ownModel(this.model(), tier);
  }

  protected set(field: Field, target: { set(value: string): void }, event: Event): void {
    target.set(inputValue(event));
    this.clearError(field);
  }

  protected setKind(event: Event): void {
    const value = inputValue(event);
    this.kind.set(value === 'openai' || value === 'anthropic' ? value : '');
    this.clearError('kind');
  }

  protected setApi(event: Event): void {
    this.openAiApi.set(inputValue(event) === 'responses' ? 'responses' : 'chat_completions');
  }

  protected setAuth(event: Event): void {
    this.auth.set(inputValue(event) === 'api-key' ? 'api-key' : 'bearer');
  }

  protected setJsonMode(event: Event): void {
    this.jsonMode.set(inputValue(event) === 'none' ? 'none' : 'json_object');
  }

  protected setMaxTokensField(event: Event): void {
    this.maxTokensFieldChosen = true;
    this.maxTokensField.set(
      inputValue(event) === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
    );
  }

  /**
   * The base URL, and with it the output limit field's default when the host changes kind (an
   * OpenAI host or another server) and the admin has not picked the field on this page.
   */
  protected setUrl(event: Event): void {
    const before = defaultOutputLimitField(this.url());
    this.set('url', this.url, event);
    const after = defaultOutputLimitField(this.url());
    if (!this.maxTokensFieldChosen && after !== before) this.maxTokensField.set(after);
  }

  protected setBudget(name: string, field: Field, event: Event): void {
    const value = inputValue(event);
    this.budgets.update((all) => ({ ...all, [name]: value }));
    this.clearError(field);
  }

  protected budget(name: string): string {
    return this.budgets()[name] ?? '';
  }

  protected orgOf(id: string): OrgSettings {
    return (
      this.orgSettings()[id] ?? {
        enabled: false,
        features: { explain: false, triage: false, fix: false },
        excludedProjectIds: [],
      }
    );
  }

  protected setOrgEnabled(id: string, event: Event): void {
    const enabled = isChecked(event);
    this.orgSettings.update((all) => ({ ...all, [id]: { ...this.orgOf(id), enabled } }));
  }

  protected setOrgFeature(id: string, feature: Feature, event: Event): void {
    const on = isChecked(event);
    this.orgSettings.update((all) => {
      const current = this.orgOf(id);
      return { ...all, [id]: { ...current, features: { ...current.features, [feature]: on } } };
    });
  }

  /**
   * The projects an organisation's "Excluded projects" offers: its own, then any excluded id the
   * project list did not include (past the list's bound), so that it too can be removed.
   */
  protected excludable(orgId: string): ExcludableProject[] {
    const listed = this.projects()[orgId] ?? [];
    const known = new Set(listed.map((p) => p.id));
    return [
      ...listed.map((p) => ({ id: p.id, name: p.name })),
      ...this.orgOf(orgId)
        .excludedProjectIds.filter((id) => !known.has(id))
        .map((id) => ({ id, name: null })),
    ];
  }

  protected excludedCount(orgId: string): number {
    return this.orgOf(orgId).excludedProjectIds.length;
  }

  protected isExcluded(orgId: string, projectId: string): boolean {
    return this.orgOf(orgId).excludedProjectIds.includes(projectId);
  }

  protected setExcluded(orgId: string, projectId: string, event: Event): void {
    const excluded = isChecked(event);
    this.orgSettings.update((all) => {
      const current = this.orgOf(orgId);
      const others = current.excludedProjectIds.filter((id) => id !== projectId);
      return {
        ...all,
        [orgId]: { ...current, excludedProjectIds: excluded ? [...others, projectId] : others },
      };
    });
  }

  protected autoFixOf(id: string): AutoFixDraft {
    return this.autoFix()[id] ?? draftOf(DEFAULT_AUTO_FIX);
  }

  protected severityLabel(severity: AutoFixSeverity): string {
    return label('severity', severity);
  }

  protected setAutoFixEnabled(id: string, event: Event): void {
    this.editAutoFix(id, { enabled: isChecked(event) });
  }

  protected setAutoFixSeverity(id: string, event: Event): void {
    const value = inputValue(event);
    if (isAutoFixSeverity(value)) this.editAutoFix(id, { minSeverity: value });
  }

  protected setAutoFixMax(id: string, event: Event): void {
    this.editAutoFix(id, { maxPerAnalysis: inputValue(event) });
  }

  protected autoFixError(id: string): string | null {
    return this.autoFixErrors()[id] ?? null;
  }

  private editAutoFix(id: string, change: Partial<AutoFixDraft>): void {
    this.autoFix.update((all) => ({ ...all, [id]: { ...this.autoFixOf(id), ...change } }));
    if (this.autoFixError(id) === null) return;
    this.autoFixErrors.update((all) =>
      Object.fromEntries(Object.entries(all).filter(([key]) => key !== id)),
    );
  }

  /**
   * Whether the organisation's block was edited here: it differs from what was loaded or saved
   * (the default for an organisation the settings did not hold). Only then does a save send it.
   * The maximum compares as a number ("010" is 10); one that is not a number from 1 to 25 counts
   * as edited, so the save refuses it.
   */
  private autoFixEdited(id: string): boolean {
    const draft = this.autoFixOf(id);
    const loaded = this.loadedAutoFix[id] ?? draftOf(DEFAULT_AUTO_FIX);
    const max = parseMaxPerAnalysis(draft.maxPerAnalysis);
    return (
      draft.enabled !== loaded.enabled ||
      draft.minSeverity !== loaded.minSeverity ||
      max === null ||
      max !== Number(loaded.maxPerAnalysis)
    );
  }

  protected setRemoveKey(event: Event): void {
    this.removeKey.set(isChecked(event));
    this.clearError('key');
  }

  protected setStorePrompts(event: Event): void {
    this.storePrompts.set(isChecked(event));
  }

  protected clearError(field: Field): void {
    if (this.errors()[field] === undefined) return;
    this.errors.update((all) =>
      Object.fromEntries(Object.entries(all).filter(([key]) => key !== field)),
    );
  }

  protected fieldError(field: Field): string | null {
    return this.errors()[field] ?? null;
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    // The key is read once and its field emptied at once, before any check or request: whatever
    // happens next (an ignored submit, a refusal here, a 422, a network error), it never stays.
    const apiKey = this.keyField()?.nativeElement.value ?? '';
    this.emptyKey();
    if (this.busy() || this.settings() === null) return;
    const errors: Partial<Record<Field, string>> = {};
    const autoFixErrors: Record<string, string> = {};
    const body = this.body(apiKey, errors, autoFixErrors);
    this.errors.set(errors);
    this.autoFixErrors.set(autoFixErrors);
    if (!body) {
      this.focusFirstInvalid();
      return;
    }
    await this.run(
      async () => {
        const saved = await ok(this.api.client.PUT('/api/v0/system/llm', { body }));
        this.fill(saved);
        // Budgets and the organisation's switch may have changed: the meters read them again.
        this.today.reload();
        this.announcement.set(
          $localize`:@@ai.settings.saved:The AI assistant settings were saved.`,
        );
      },
      (err) => {
        const fields = fieldErrors(err);
        const refused: Partial<Record<Field, string>> = {};
        const autoFixRefused: Record<string, string> = {};
        for (const path of Object.keys(fields)) {
          const autoFix = AUTO_FIX_PATH.exec(path);
          if (autoFix?.[1] !== undefined) {
            autoFixRefused[autoFix[1]] ??=
              autoFix[2] === 'enabled' ? this.autoFixNotLicensed : maxPerAnalysisRefusal();
            continue;
          }
          const match = SERVER_PATHS.find(
            ([prefix]) => path === prefix || path.startsWith(`${prefix}.`),
          );
          if (match && refused[match[1]] === undefined) refused[match[1]] = refusal(match[1]);
        }
        if (Object.keys(refused).length === 0 && Object.keys(autoFixRefused).length === 0) {
          return false;
        }
        this.errors.set(refused);
        this.autoFixErrors.set(autoFixRefused);
        this.focusFirstInvalid();
        return true;
      },
    );
  }

  /**
   * llm.md §16: sends a fixed prompt holding no repository data to the saved provider's models.
   * With one model the page shows its connection and its tool calling, a failed Test as an error
   * (role="alert") and a successful one as a status; with several, a line for each.
   */
  protected async test(): Promise<void> {
    if (this.busy()) return;
    await this.run(async () => {
      const result = await ok(this.api.client.POST('/api/v0/system/llm/test'));
      if (result.models.length > 1) {
        const lines = result.models.map(testLine);
        this.testLines.set(lines);
        // The list is in the polite live region: a failure is also said in an alert, as one is for a
        // single model.
        const failed = lines.filter((line) => line.tone === 'error').length;
        if (failed > 0) {
          this.error.set(
            $localize`:@@ai.test.modelsFailed:The test failed for ${failed}:failed: of ${lines.length}:total: models.`,
          );
        }
      } else if (result.problem) {
        this.error.set(settingsProblemText(result.problem.code, result.problem.providerStatus));
      } else {
        this.announcement.set(
          $localize`:@@ai.settings.testOk:Connected to ${result.model ?? this.provider()?.model ?? ''}:model: in ${result.latencyMs}:latency: ms.`,
        );
        this.toolCalling.set(result.toolCalling === 'not_checked' ? null : result.toolCalling);
        this.toolsHint.set(result.hint?.code ?? null);
      }
    });
  }

  private async load(): Promise<void> {
    this.loadError.set(null);
    try {
      const [settings, organizations, projects] = await Promise.all([
        ok(this.api.client.GET('/api/v0/system/llm')),
        this.allOrganizations(),
        this.allProjects(),
      ]);
      this.organizations.set(organizations);
      const byOrg: Record<string, Project[]> = {};
      for (const project of projects) (byOrg[project.organizationId] ??= []).push(project);
      this.projects.set(byOrg);
      this.fill(settings);
    } catch (err) {
      this.loadError.set(problemMessage(err));
    }
  }

  private async allOrganizations(): Promise<Organization[]> {
    const all: Organization[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < ORG_PAGES; i++) {
      const answer: { items: Organization[]; nextCursor: string | null } = await ok(
        this.api.client.GET('/api/v0/organizations', {
          params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
        }),
      );
      all.push(...answer.items);
      if (answer.nextCursor === null || answer.nextCursor === cursor) break;
      cursor = answer.nextCursor;
    }
    return all;
  }

  private async allProjects(): Promise<Project[]> {
    const all: Project[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < PROJECT_PAGES; i++) {
      const answer: { items: Project[]; nextCursor: string | null } = await ok(
        this.api.client.GET('/api/v0/projects', {
          params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
        }),
      );
      all.push(...answer.items);
      if (answer.nextCursor === null || answer.nextCursor === cursor) break;
      cursor = answer.nextCursor;
    }
    return all;
  }

  /** Puts saved settings into the form (never a key: the server has none to give). */
  private fill(settings: Settings): void {
    this.settings.set(settings);
    const p = settings.provider;
    this.kind.set(p?.kind ?? '');
    this.url.set(p?.baseUrl ?? '');
    this.model.set(p?.model ?? '');
    this.strongModel.set(p?.strongModel ?? '');
    this.fastModel.set(p?.fastModel ?? '');
    this.openAiApi.set(p?.api ?? 'chat_completions');
    this.auth.set(p?.auth ?? 'bearer');
    this.jsonMode.set(p?.jsonMode ?? 'json_object');
    this.maxTokensField.set(p?.maxTokensField ?? 'max_tokens');
    this.maxTokensFieldChosen = false;
    this.workspaceId.set(p?.workspaceId ?? '');
    this.timeout.set(String(p?.timeoutSeconds ?? 60));
    this.temperature.set(p?.temperature === null || p === null ? '' : String(p.temperature));
    this.removeKey.set(false);
    this.orgSettings.set(
      Object.fromEntries(
        Object.entries(settings.organizations).map(([id, o]) => [
          id,
          {
            enabled: o.enabled,
            features: { ...o.features },
            excludedProjectIds: [...o.excludedProjectIds],
          },
        ]),
      ),
    );
    this.autoFix.set(
      Object.fromEntries(
        Object.entries(settings.organizations).map(([id, o]) => [id, draftOf(o.autoFix)]),
      ),
    );
    this.loadedAutoFix = this.autoFix();
    this.autoFixErrors.set({});
    this.exclude.set(settings.excludePaths.join('\n'));
    const b = settings.budgets;
    this.budgets.set({
      explainPerDay: String(b.explainPerDay),
      triagePerDay: String(b.triagePerDay),
      fixPerDay: String(b.fixPerDay),
      tokensPerDay: String(b.tokensPerDay),
      costPerDayUsd: b.costPerDayUsd === null ? '' : String(b.costPerDayUsd),
      perUserPerHour: String(b.perUserPerHour),
      reviewTokensPerOrganizationPerDay:
        b.reviewTokensPerOrganizationPerDay === null
          ? ''
          : String(b.reviewTokensPerOrganizationPerDay),
    });
    const pricing = settings.pricing;
    this.priceInput.set(pricing ? String(pricing.inputUsdPerMTok) : '');
    this.priceOutput.set(pricing ? String(pricing.outputUsdPerMTok) : '');
    this.priceStrongInput.set(pricing?.strong ? String(pricing.strong.inputUsdPerMTok) : '');
    this.priceStrongOutput.set(pricing?.strong ? String(pricing.strong.outputUsdPerMTok) : '');
    this.priceFastInput.set(pricing?.fast ? String(pricing.fast.inputUsdPerMTok) : '');
    this.priceFastOutput.set(pricing?.fast ? String(pricing.fast.outputUsdPerMTok) : '');
    this.storePrompts.set(settings.storePrompts);
    this.retention.set(String(settings.promptRetentionDays));
    this.errors.set({});
  }

  /** The whole `PUT` body from the form, or null with `errors` filled. */
  private body(
    apiKey: string,
    errors: Partial<Record<Field, string>>,
    autoFixErrors: Record<string, string>,
  ): SettingsBody | null {
    const provider = this.providerBody(apiKey, errors);

    const excludePaths = this.exclude()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (excludePaths.length > MAX_EXCLUDE_PATHS) refuse(errors, 'exclude');

    const budgets = this.budgetsBody(errors);
    const pricing = this.pricingBody(errors);
    const organizations = this.organizationsBody(autoFixErrors);

    const body: SettingsBody = {
      provider,
      organizations,
      excludePaths,
      budgets,
      pricing,
      storePrompts: this.storePrompts(),
      promptRetentionDays: wholeNumber(errors, 'retention', this.retention(), 1, 90),
    };
    return Object.keys(errors).length === 0 && Object.keys(autoFixErrors).length === 0
      ? body
      : null;
  }

  /** The provider part of the body: null for None, with `errors` filled for a refused field. */
  private providerBody(
    apiKey: string,
    errors: Partial<Record<Field, string>>,
  ): SettingsBody['provider'] {
    const kind = this.kind();
    if (kind === '') {
      // A key typed with no provider would be dropped silently: refuse it instead.
      if (apiKey !== '') errors.key = keyWithoutKind();
      return null;
    }
    const baseUrl = this.url().trim();
    const model = this.model().trim();
    const strongModel = this.strongModel().trim();
    const fastModel = this.fastModel().trim();
    if (baseUrl === '') refuse(errors, 'url');
    if (!MODEL_NAME.test(model)) refuse(errors, 'model');
    // A tier's model is optional: empty is sent as null, and the tier uses the model above.
    if (strongModel !== '' && !MODEL_NAME.test(strongModel)) refuse(errors, 'strong-model');
    if (fastModel !== '' && !MODEL_NAME.test(fastModel)) refuse(errors, 'fast-model');
    if (apiKey !== '' && this.removeKey()) errors.key = keyAndRemove();
    else if (apiKey !== '' && !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) errors.key = keyFormat();
    const workspaceId = this.workspaceId().trim();
    if (kind === 'anthropic' && workspaceId !== '' && !WORKSPACE_ID.test(workspaceId)) {
      refuse(errors, 'workspace-id');
    }
    // Anthropic's current models take no temperature: none is sent for them, whatever was typed.
    const temperature =
      kind === 'anthropic' || this.temperature().trim() === ''
        ? null
        : decimalNumber(errors, 'temperature', this.temperature(), 0, MAX_TEMPERATURE);
    return {
      kind,
      baseUrl,
      model,
      strongModel: strongModel === '' ? null : strongModel,
      fastModel: fastModel === '' ? null : fastModel,
      ...(kind === 'openai'
        ? {
            api: this.openAiApi(),
            auth: this.auth(),
            jsonMode: this.jsonMode(),
            maxTokensField: this.maxTokensField(),
          }
        : { workspaceId: workspaceId === '' ? null : workspaceId }),
      temperature,
      timeoutSeconds: wholeNumber(errors, 'timeout', this.timeout(), 5, 600),
      ...keyChange(apiKey, this.removeKey()),
    };
  }

  /** The budgets part of the body, with `errors` filled for a refused budget. */
  private budgetsBody(errors: Partial<Record<Field, string>>): SettingsBody['budgets'] {
    const budget = (field: Field, key: keyof SettingsBody['budgets'], min: number, max: number) =>
      wholeNumber(errors, field, this.budget(key), min, max);
    const costRaw = this.budget('costPerDayUsd').trim();
    const ceilingRaw = this.budget('reviewTokensPerOrganizationPerDay').trim();
    return {
      explainPerDay: budget('budget-explain', 'explainPerDay', 0, 100_000),
      triagePerDay: budget('budget-triage', 'triagePerDay', 0, 100_000),
      fixPerDay: budget('budget-fix', 'fixPerDay', 0, 100_000),
      tokensPerDay: budget('budget-tokens', 'tokensPerDay', 0, 1_000_000_000),
      costPerDayUsd:
        costRaw === '' ? null : decimalNumber(errors, 'budget-cost', costRaw, 0, 1_000_000),
      perUserPerHour: budget('budget-user', 'perUserPerHour', 1, 10_000),
      // Always sent, null for no ceiling: a save writes what the page shows. (A body that left it
      // out would keep the stored ceiling; only null removes it.)
      reviewTokensPerOrganizationPerDay:
        ceilingRaw === ''
          ? null
          : wholeNumber(errors, 'budget-review', ceilingRaw, 0, 1_000_000_000),
    };
  }

  /**
   * The prices part of the body: null when none is given, with `errors` filled for a refusal. Once
   * a price is given the server needs the standard model's pair and the pair of each tier that has
   * a model of its own, so a pair left out is refused; a tier without a model of its own sends none.
   */
  private pricingBody(errors: Partial<Record<Field, string>>): SettingsBody['pricing'] {
    const standard = { input: this.priceInput(), output: this.priceOutput() };
    const strong =
      this.strongOwn() === null
        ? null
        : { input: this.priceStrongInput(), output: this.priceStrongOutput() };
    const fast =
      this.fastOwn() === null
        ? null
        : { input: this.priceFastInput(), output: this.priceFastOutput() };
    const typed = [standard, strong, fast].some(
      (pair) => pair !== null && (pair.input.trim() !== '' || pair.output.trim() !== ''),
    );
    if (!typed) return null;
    return {
      ...pricePair(errors, ['price-input', 'price-output'], standard),
      strong: strong && pricePair(errors, ['price-strong-input', 'price-strong-output'], strong),
      fast: fast && pricePair(errors, ['price-fast-input', 'price-fast-output'], fast),
    };
  }

  /** The organisations part of the body, with `autoFixErrors` filled for a refused maximum. */
  private organizationsBody(autoFixErrors: Record<string, string>): SettingsBody['organizations'] {
    // An organisation's automatic fix block goes only when it was edited here (ruling R1), so a
    // save keeps what an organisation admin changed meanwhile; the projects opted out never go.
    const edited = new Set(Object.keys(this.autoFix()).filter((id) => this.autoFixEdited(id)));
    const organizations: SettingsBody['organizations'] = {};
    for (const id of new Set([...Object.keys(this.orgSettings()), ...edited])) {
      const settings = this.orgOf(id);
      if (!edited.has(id)) {
        organizations[id] = settings;
        continue;
      }
      const draft = this.autoFixOf(id);
      const maxPerAnalysis = parseMaxPerAnalysis(draft.maxPerAnalysis);
      if (maxPerAnalysis === null) autoFixErrors[id] = maxPerAnalysisRefusal();
      const autoFix: AutoFix = {
        enabled: draft.enabled,
        minSeverity: draft.minSeverity,
        maxPerAnalysis: maxPerAnalysis ?? 0,
      };
      organizations[id] = { ...settings, autoFix };
    }
    return organizations;
  }

  private emptyKey(): void {
    const field = this.keyField()?.nativeElement;
    if (field) field.value = '';
  }

  private focusFirstInvalid(): void {
    const errors = this.errors();
    const first = FIELDS.find((field) => errors[field] !== undefined);
    // Else the first organisation (in the page's order) whose automatic fix block was refused.
    const id = first ? `ai-${first}` : this.firstRefusedAutoFix();
    if (!id) return;
    // After the render that marks it invalid (and, for the key, shows its error text).
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${id}`)?.focus(), {
      injector: this.injector,
    });
  }

  /** The maximum's input of the first organisation whose automatic fix block was refused. */
  private firstRefusedAutoFix(): string | null {
    const autoFix = this.organizations().find((o) => this.autoFixError(o.id) !== null);
    return autoFix ? `ai-org-${autoFix.id}-auto-fix-max` : null;
  }

  /**
   * Runs one request; while one runs, the buttons stay enabled (and focusable) but do nothing. A
   * refused field goes to its field; anything else to the page's alert.
   */
  private async run(action: () => Promise<void>, field?: (err: unknown) => boolean): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.announcement.set(null);
    this.toolCalling.set(null);
    this.testLines.set([]);
    try {
      await action();
    } catch (err) {
      if (field?.(err)) return;
      this.error.set(problemMessage(err));
      const active = this.document.activeElement;
      if (active === null || active === this.document.body) this.heading()?.nativeElement.focus();
    } finally {
      this.busy.set(false);
    }
  }
}

function draftOf(autoFix: AutoFix): AutoFixDraft {
  return {
    enabled: autoFix.enabled,
    minSeverity: autoFix.minSeverity,
    maxPerAnalysis: String(autoFix.maxPerAnalysis),
  };
}

/** The page's own words for a refused field (the server's text is never shown). */
function refusal(field: Field): string {
  switch (field) {
    case 'kind':
      return $localize`:@@ai.settings.badKind:Choose OpenAI-compatible or Anthropic.`;
    case 'url':
      return $localize`:@@ai.settings.badUrl:Use the provider's http(s) address, such as https://api.openai.com/v1. An internal host must be listed, with its port, by the operator in QUALOR_LLM_INTERNAL_HOSTS.`;
    case 'model':
    case 'strong-model':
    case 'fast-model':
      return $localize`:@@ai.settings.badModel:Use the model's name as the provider spells it: letters, digits and . _ : / @ + - only.`;
    case 'key':
      return $localize`:@@ai.settings.keyForNewUrl:Enter the API key again for a new address, or check Remove the key. The key is 1 to 4096 printable characters without spaces.`;
    case 'workspace-id':
      return $localize`:@@ai.settings.badWorkspaceId:Use the workspace ID as the console shows it: wrkspc_ and then letters and digits.`;
    case 'timeout':
      return $localize`:@@ai.settings.badTimeout:Use a whole number of seconds from 5 to 600.`;
    case 'temperature':
      return $localize`:@@ai.settings.badTemperature:Use a number from 0 to 2, or leave it empty.`;
    case 'exclude':
      return $localize`:@@ai.settings.badExclude:Use at most 100 globs, one per line, relative to the repository root.`;
    case 'budget-explain':
    case 'budget-triage':
    case 'budget-fix':
    case 'budget-tokens':
      return $localize`:@@ai.settings.badBudget:Use a whole number, 0 or more.`;
    case 'budget-user':
      return $localize`:@@ai.settings.badUserBudget:Use a whole number, 1 or more.`;
    case 'budget-review':
      return $localize`:@@ai.settings.badReviewCeiling:Use a whole number, 0 or more, or leave it empty for no limit.`;
    case 'budget-cost':
      return $localize`:@@ai.settings.badCost:Use an amount in US dollars, or leave it empty for no cost budget.`;
    case 'price-input':
    case 'price-output':
      return $localize`:@@ai.settings.badPrice:Give both prices, in US dollars per million tokens (0 to 10000), or neither.`;
    case 'price-strong-input':
    case 'price-strong-output':
      return $localize`:@@ai.settings.badStrongPrice:Give the strong model's prices too, in US dollars per million tokens (0 to 10000).`;
    case 'price-fast-input':
    case 'price-fast-output':
      return $localize`:@@ai.settings.badFastPrice:Give the fast model's prices too, in US dollars per million tokens (0 to 10000).`;
    case 'retention':
      return $localize`:@@ai.settings.badRetention:Use a whole number of days from 1 to 90.`;
  }
}

/** Records the refusal of `field` (its first refusal stays) and stands in 0 for its value. */
function refuse(errors: Partial<Record<Field, string>>, field: Field): number {
  errors[field] ??= refusal(field);
  return 0;
}

/** A whole number from `min` to `max` as typed in `field`, else refused. */
function wholeNumber(
  errors: Partial<Record<Field, string>>,
  field: Field,
  raw: string,
  min: number,
  max: number,
): number {
  const value = raw.trim();
  if (!/^\d{1,10}$/.test(value)) return refuse(errors, field);
  const n = Number(value);
  return n >= min && n <= max ? n : refuse(errors, field);
}

/** A number from `min` to `max` as typed in `field`, else refused. */
function decimalNumber(
  errors: Partial<Record<Field, string>>,
  field: Field,
  raw: string,
  min: number,
  max: number,
): number {
  const value = raw.trim();
  const n = value === '' ? Number.NaN : Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : refuse(errors, field);
}

/**
 * The tier's model as the server counts it: its own when it is set and is not the standard model,
 * else none. A tier without one runs on the standard model, at its prices.
 */
function ownModel(standard: string, tier: string): string | null {
  const model = tier.trim();
  return model === '' || model === standard.trim() ? null : model;
}

/** A pair of prices as typed, each from 0 to 10 000, else refused on its own field. */
function pricePair(
  errors: Partial<Record<Field, string>>,
  fields: readonly [Field, Field],
  typed: { input: string; output: string },
): { inputUsdPerMTok: number; outputUsdPerMTok: number } {
  return {
    inputUsdPerMTok: decimalNumber(errors, fields[0], typed.input, 0, 10_000),
    outputUsdPerMTok: decimalNumber(errors, fields[1], typed.output, 0, 10_000),
  };
}

/** The key part of the provider: the key typed, its removal, or else the stored key kept. */
function keyChange(apiKey: string, remove: boolean): { apiKey?: string | null } {
  if (apiKey !== '') return { apiKey };
  return remove ? { apiKey: null } : {};
}

function keyWithoutKind(): string {
  return $localize`:@@ai.settings.keyWithoutKind:Choose a provider kind before typing an API key; with None no key is kept.`;
}

function keyFormat(): string {
  return $localize`:@@ai.settings.keyFormat:This is not an API key: a key is 1 to 4096 printable characters without spaces.`;
}

function keyAndRemove(): string {
  return $localize`:@@ai.settings.keyAndRemove:Type a new API key or check Remove the key, not both.`;
}
