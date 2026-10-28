import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  type ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  LOCALE_ID,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, ok } from '../../api/api';
import { fieldErrors, problemMessage } from '../../api/errors';
import type { Organization, ResponseBody } from '../../api/types';
import { SessionStore } from '../../auth/session';
import { formatDateTime } from '../../shared/date-time.pipe';
import { closeModal, openAfterRender } from '../../shared/dialog';
import { keepEdits } from '../../shared/drafts';
import { keepFocus } from '../../shared/focus';
import { inputValue, isChecked } from '../../shared/forms';
import { Icon } from '../../shared/icon';
import type { IconName } from '../../shared/icons';
import { NumberField } from '../../shared/number-field';
import { formatWhole, parseWhole } from '../../shared/numbers';
import { type FootOutcome, SectionFoot } from '../../shared/section-foot';
import { storedTestLine, testHintText, type TestLine, testLine } from '../ai-text';
import {
  type ConsentInput,
  consentFields,
  pausesReview,
  reviewingOrganizations,
  unnamedReviewing,
} from './consent-impact';
import type { LlmBody, LlmSettings } from './llm-body';
import { namesOf } from './names';
import {
  changesOf,
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_TIMEOUT,
  defaultOutputLimitField,
  type Draft,
  draftOf,
  FIELDS,
  type Field,
  hostOf,
  isCachedPrice,
  isHttpUrl,
  type KeyHeader,
  keyFormat,
  modelOf,
  normalUrl,
  OPENAI_HOST,
  type OpenAiApi,
  type OutputLimit,
  PRICE_FIELDS,
  PRICE_ROWS,
  type PriceField,
  pricedTiers,
  pricingOf,
  refusal,
  temperatureOf,
  type Tier,
} from './provider-draft';

type SavedProvider = NonNullable<LlmSettings['provider']>;
type TestAnswer = ResponseBody<'/api/v0/system/llm/test', 'post'>;

/** The section's provider and its prices, which a save puts in place of the stored ones. */
export interface ProviderChange {
  /** Null removes the provider and its key. */
  provider: LlmBody['provider'];
  pricing: LlmBody['pricing'];
}
/** Stores the section's change: resolves with the settings saved, rejects with the refusal (`ApiError`). */
export type SaveProvider = (change: ProviderChange) => Promise<LlmSettings>;

type Errors = Partial<Record<Field, string>>;

/** The address and the model names of the draft, trimmed; the ones refused are marked. */
function modelNamesOf(d: Draft, refuse: (field: Field) => void) {
  const baseUrl = d.url.trim();
  if (!isHttpUrl(baseUrl)) refuse('url');
  const model = d.model.trim();
  if (!MODEL_NAME.test(model)) refuse('model');
  // A tier's model is optional: empty is sent as null, and the tier uses the model above.
  const strongModel = d.tiers ? d.strongModel.trim() : '';
  const fastModel = d.tiers ? d.fastModel.trim() : '';
  if (strongModel !== '' && !MODEL_NAME.test(strongModel)) refuse('strong-model');
  if (fastModel !== '' && !MODEL_NAME.test(fastModel)) refuse('fast-model');
  return { baseUrl, model, strongModel, fastModel };
}

/** The draft's timeout, context window and temperature; the ones refused are marked. */
function limitsOf(d: Draft, refuse: (field: Field) => void) {
  const timeoutSeconds = parseWhole(d.timeout, 5, 600);
  if (timeoutSeconds === null) refuse('timeout');
  // Empty is the default: sent as null. Anything else is a whole number within the bounds.
  const windowText = d.contextWindow.trim();
  const contextWindowTokens =
    windowText === '' ? null : parseWhole(windowText, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX);
  if (windowText !== '' && contextWindowTokens === null) refuse('context-window');
  const temperature = temperatureOf(d);
  if (Number.isNaN(temperature)) refuse('temperature');
  return { timeoutSeconds, contextWindowTokens, temperature };
}
/** The fields inside Connection options: a refusal of one opens the fold. */
const OPTION_FIELDS: readonly Field[] = ['timeout', 'context-window', 'temperature'];

const PRICE_FIELD_NAMES = Object.keys(PRICE_FIELDS) as PriceField[];

/** The server's 422 paths (llm.md §16) of the provider and its prices, and the field of each. */
const SERVER_PATHS: [string, Field][] = [
  ['body.provider.kind', 'kind'],
  ['body.provider.baseUrl', 'url'],
  ['body.provider.model', 'model'],
  ['body.provider.strongModel', 'strong-model'],
  ['body.provider.fastModel', 'fast-model'],
  ['body.provider.apiKey', 'key'],
  ['body.provider.workspaceId', 'workspace-id'],
  ['body.provider.timeoutSeconds', 'timeout'],
  ['body.provider.contextWindowTokens', 'context-window'],
  ['body.provider.temperature', 'temperature'],
  ['body.pricing.inputUsdPerMTok', 'price-input'],
  ['body.pricing.outputUsdPerMTok', 'price-output'],
  ['body.pricing.cachedInputUsdPerMTok', 'price-cached-input'],
  ['body.pricing.strong.inputUsdPerMTok', 'price-strong-input'],
  ['body.pricing.strong.outputUsdPerMTok', 'price-strong-output'],
  ['body.pricing.strong.cachedInputUsdPerMTok', 'price-strong-cached-input'],
  // A tier's prices missing for its own model ("Give … prices too"). The server's other refusal
  // there, a pair for a tier without a model of its own ("Set … first"), cannot come from this
  // section: it sends no pair for such a tier.
  ['body.pricing.strong', 'price-strong-input'],
  ['body.pricing.fast.inputUsdPerMTok', 'price-fast-input'],
  ['body.pricing.fast.outputUsdPerMTok', 'price-fast-output'],
  ['body.pricing.fast.cachedInputUsdPerMTok', 'price-fast-cached-input'],
  ['body.pricing.fast', 'price-fast-input'],
  ['body.pricing', 'price-input'],
];

/** A model's name as the provider spells it (the server's `MODEL_PATTERN`). */
const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;
/** An Anthropic workspace as the console names it (the server's `WORKSPACE_ID_PATTERN`). */
const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{1,64}$/;
/** An API key: 1 to 4 096 printable characters without spaces (the server's `API_KEY_PATTERN`). */
const API_KEY = /^[\x21-\x7e]{1,4096}$/;
/** The address an empty Base URL takes when Anthropic is chosen. */
const ANTHROPIC_URL = 'https://api.anthropic.com';

/** One model's line of a Test: its icon and words, the model set apart in code. */
interface LineView {
  tier: string;
  tone: 'ok' | 'bad' | 'unknown';
  icon: IconName;
  before: string;
  model: string;
  after: string;
}
const LINE_ICONS: Record<LineView['tone'], IconName> = {
  ok: 'check',
  bad: 'cross',
  unknown: 'minus',
};
/** How a model fared in a Test: it failed or does not call tools, does, or was not checked. */
function lineToneOf(m: { toolCalling: string; failed: boolean }): LineView['tone'] {
  if (m.failed || m.toolCalling === 'not_supported') return 'bad';
  return m.toolCalling === 'supported' ? 'ok' : 'unknown';
}
/** The question the pause dialog asks while it is open. */
interface PauseQuestion {
  title: string;
  was: string;
  now: string;
}

/**
 * `q-ai-provider-section` (spec §3.4, §7.3 rows 1–7, §7.4, mockup `#i-first`, `#i-ok`,
 * `#i-confirm`): the instance's AI provider page's Provider, for instance admins. The kind as two
 * choice cards, and nothing else until one is chosen; then the address, the API key, the
 * workspace (Anthropic), the model with the tiers' models under a switch, the prices under a
 * switch (a row beside each model of its own), the connection options in a fold that lists them
 * while closed, the last Test, and the removal of the provider.
 *
 * - **Save and test** checks the section here first, asks before a change of the address or the
 *   models pauses AI review where its admins confirmed the provider (`#ai-pause-dialog`), saves
 *   (`saveProvider`), then tests the saved provider and emits `tested`. A 422 marks its fields.
 *   Edits made while the save is on its way stay, unsaved.
 * - **The API key is write-only.** It stays in its field through a refusal here, leaves the field
 *   only with the request, and the field is emptied as it leaves, after every request and when the
 *   section goes; the section's state never holds it.
 *
 * The page reads `dirty` and `dirtyLabel` for its leave guard, and calls `test` for its status
 * line's Test again.
 */
@Component({
  selector: 'q-ai-provider-section',
  imports: [Icon, NumberField, RouterLink, SectionFoot],
  templateUrl: './provider-section.html',
  styleUrl: './provider-section.css',
})
export class ProviderSection {
  private readonly api = inject(Api);
  private readonly session = inject(SessionStore);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  /** The settings as the server last answered. */
  readonly settings = input.required<LlmSettings>();
  /** Every organisation the page read, for the names of those a change pauses. */
  readonly organizations = input.required<readonly Organization[]>();
  readonly saveProvider = input.required<SaveProvider>();
  /** A Test answered: the server keeps it as the last Test, and the page reads the settings again. */
  readonly tested = output();
  /** The section's name, for the question asked before leaving it with unsaved changes. */
  readonly dirtyLabel = $localize`:@@aiProvider.provider.title:Provider`;

  protected readonly texts = {
    title: this.dirtyLabel,
    kind: $localize`:@@aiProvider.kind:Provider`,
    url: $localize`:@@ai.settings.url:Base URL`,
    key: $localize`:@@ai.settings.key:API key`,
    keyBadge: $localize`:@@aiProvider.key.badge:Set`,
    keySet: $localize`:@@aiProvider.key.set:An API key is set.`,
    replace: $localize`:@@aiProvider.key.replace:Replace the key`,
    remove: $localize`:@@aiProvider.key.remove:Remove the key`,
    removing: $localize`:@@aiProvider.key.removing:The key is removed when you save.`,
    undo: $localize`:@@aiProvider.key.undo:Undo`,
    workspace: $localize`:@@ai.settings.workspaceId:Workspace ID`,
    model: $localize`:@@ai.settings.model:Model`,
    strongModel: $localize`:@@ai.settings.strongModel:Strong model`,
    fastModel: $localize`:@@ai.settings.fastModel:Fast model`,
    prices: $localize`:@@aiProvider.prices:Prices`,
    pricesOn: $localize`:@@aiProvider.prices.on:US dollars per million tokens.`,
    pricesOff: $localize`:@@aiProvider.prices.off:Off: tokens are counted, costs are not.`,
    colModel: $localize`:@@aiProvider.prices.col.model:Model`,
    colInput: $localize`:@@aiProvider.prices.col.input:Input`,
    colOutput: $localize`:@@aiProvider.prices.col.output:Output`,
    colCached: $localize`:@@aiProvider.prices.colCached:Cached input`,
    usd: $localize`:@@numberField.usd:US$`,
    seconds: $localize`:@@numberField.seconds:seconds`,
    tokens: $localize`:@@numberField.tokens:tokens`,
    contextWindow: $localize`:@@aiProvider.contextWindow.label:Context window`,
    options: $localize`:@@aiProvider.options:Connection options`,
    apiLabel: $localize`:@@ai.settings.api:API`,
    auth: $localize`:@@ai.settings.auth:Key header`,
    maxTokensField: $localize`:@@ai.settings.maxTokensField:Output limit parameter`,
    chat: $localize`:@@aiProvider.chip.chat:Chat Completions`,
    responses: $localize`:@@aiProvider.chip.responses:Responses`,
    bearer: $localize`:@@aiProvider.chip.bearer:Authorization: Bearer`,
    apiKeyHeader: $localize`:@@aiProvider.chip.apiKey:api-key (Azure)`,
    maxTokens: $localize`:@@aiProvider.chip.maxTokens:max_tokens`,
    maxCompletionTokens: $localize`:@@aiProvider.chip.maxCompletionTokens:max_completion_tokens`,
    timeout: $localize`:@@aiProvider.timeout:Timeout`,
    temperature: $localize`:@@aiProvider.temperatureValue:Temperature`,
    testTitle: $localize`:@@aiProvider.test.title:Last test`,
    testing: $localize`:@@aiProvider.test.running:Testing…`,
    useResponses: testHintText('USE_RESPONSES_API'),
    removeRow: $localize`:@@aiProvider.remove.row:Remove the provider`,
    removeButton: $localize`:@@aiProvider.remove.button:Remove the provider…`,
    saveAndTest: $localize`:@@aiProvider.saveAndTest:Save and test`,
    testAgain: $localize`:@@aiProvider.testAgain:Test again`,
  };
  private readonly chipTexts = {
    jsonOn: $localize`:@@aiProvider.chip.jsonOn:JSON mode on`,
    jsonOff: $localize`:@@aiProvider.chip.jsonOff:JSON mode off`,
    noTemperature: $localize`:@@aiProvider.chip.noTemperature:No temperature`,
  };
  private readonly tierNames: Record<Tier, string> = {
    standard: $localize`:@@aiProvider.tier.standard:Standard`,
    strong: $localize`:@@aiProvider.tier.strong:Strong`,
    fast: $localize`:@@aiProvider.tier.fast:Fast`,
  };

  /** The settings as last saved: the page's, or a save's answer before the page passes it on. */
  private readonly saved = linkedSignal(() => this.settings());
  protected readonly provider = computed(() => this.saved().provider);
  /** The saved provider and prices as the section holds them: what the draft compares with. */
  private readonly base = signal<Draft>(draftOf(null, this.locale));
  protected readonly draft = signal<Draft>(draftOf(null, this.locale));
  /** Whether the key field holds text: never the key. */
  private readonly keyTyped = signal(false);
  /** Replace the key was pressed: the field shows beside a key that is set. */
  private readonly replacing = signal(false);
  protected readonly errors = signal<Errors>({});
  protected readonly optionsOpen = signal(false);
  private readonly saving = signal(false);
  /** Why the last save failed, in the foot; gone with the next edit. */
  private readonly saveError = signal<string | null>(null);
  private readonly savedAt = signal<Date | null>(null);
  protected readonly testing = signal(false);
  protected readonly testError = signal<string | null>(null);
  /** This visit's Test: its answer, with the time each call took (the stored Test has none). */
  private readonly visitTest = signal<{ answer: TestAnswer; at: Date } | null>(null);
  protected readonly pause = signal<PauseQuestion | null>(null);
  private readonly removing = signal(false);
  /** The draft has taken settings once: later settings keep its edits. */
  private adopted = false;
  /** Counts the Tests started and dropped: the answer of one a save or removal overtook is dropped. */
  private testRun = 0;
  /** The admin chose the API, or the output limit parameter, here: the address presets neither. */
  private apiChosen = false;
  private maxTokensFieldChosen = false;

  private readonly keyField = viewChild<ElementRef<HTMLInputElement>>('keyField');
  private readonly pauseDialog = viewChild<ElementRef<HTMLDialogElement>>('pauseDialog');
  private readonly removeDialog = viewChild<ElementRef<HTMLDialogElement>>('removeDialog');

  protected readonly keySet = computed(() => this.provider()?.apiKeySet === true);
  /** The address typed is another than the saved one: a stored key is never sent to it. */
  protected readonly addressChanged = computed(() => {
    const saved = this.provider();
    return saved !== null && normalUrl(this.draft().url) !== normalUrl(saved.baseUrl);
  });
  /**
   * The key field shows while no key is stored, on Replace, for a new address, while it holds a
   * key, or while the server refused it; never while the stored key is to be removed.
   */
  protected readonly showKeyField = computed(
    () =>
      !this.keySet() ||
      (!this.draft().removeKey &&
        (this.replacing() ||
          this.addressChanged() ||
          this.keyTyped() ||
          this.errors().key !== undefined)),
  );
  /**
   * The organisations a change of the address or the models pauses, as `reviewStatus` says: by
   * name where the page's list has them, else counted.
   */
  private readonly reviewing = computed(() => {
    const saved = this.saved();
    const organizations = this.organizations();
    const named = reviewingOrganizations(saved, organizations).map((o) => o.name);
    const unnamed = unnamedReviewing(saved, organizations);
    return { named, unnamed, count: named.length + unnamed };
  });
  /** What changing the address does, while a provider is saved. */
  protected readonly urlNote = computed(() => {
    if (this.provider() === null) return null;
    const reviewing = this.reviewing();
    if (reviewing.count === 0) {
      return $localize`:@@aiProvider.url.keyOnly:Changing the address needs the API key again.`;
    }
    const names = namesOf(reviewing.named, this.locale, reviewing.unnamed);
    return $localize`:@@aiProvider.url.pauses:Changing the address needs the API key again, and pauses AI review in ${names}:names: until an organization admin confirms the new address.`;
  });
  protected readonly urlDescribedBy = computed(() =>
    [
      this.errors().url === undefined ? null : 'ai-url-error',
      'ai-url-hint',
      this.urlNote() === null ? null : 'ai-url-note',
    ]
      .filter((id) => id !== null)
      .join(' '),
  );
  /** The tiers' models show while their switch is on, or while one of them is refused. */
  protected readonly showTiers = computed(
    () =>
      this.draft().tiers ||
      this.errors()['strong-model'] !== undefined ||
      this.errors()['fast-model'] !== undefined,
  );
  /** The prices show while their switch is on, or while one of them is refused. */
  protected readonly showPrices = computed(
    () => this.draft().prices || PRICE_FIELD_NAMES.some((field) => this.errors()[field]),
  );
  /**
   * A row for the standard model, and one for each tier with a model of its own: its input, output
   * and cached input prices (R49), the last described by the words under the table.
   */
  protected readonly priceRows = computed(() => {
    const draft = this.draft();
    const errors = this.errors();
    const columns = [this.texts.colInput, this.texts.colOutput, this.texts.colCached];
    return pricedTiers(draft).map((tier) => {
      const model = modelOf(draft, tier);
      return {
        tier,
        model,
        tierName: this.tierNames[tier],
        cells: PRICE_ROWS[tier].map((field, i) => {
          const id = `ai-${field}`;
          const error = errors[field] ?? null;
          const describedBy = [
            error === null ? null : `${id}-error`,
            isCachedPrice(field) ? 'ai-prices-cached-help' : null,
          ].filter((part) => part !== null);
          return {
            field,
            id,
            column: columns[i] ?? '',
            label: this.priceLabel(field, model),
            value: draft[PRICE_FIELDS[field].key],
            error,
            describedBy: describedBy.length === 0 ? null : describedBy.join(' '),
          };
        }),
      };
    });
  });
  /** The chips of an OpenAI-compatible provider's own options. */
  private openaiChips(d: Draft): { text: string; set: boolean }[] {
    const t = this.texts;
    const chips = [
      {
        text: d.api === 'responses' ? t.responses : t.chat,
        set: d.api !== 'chat_completions',
      },
      {
        text: d.auth === 'api-key' ? t.apiKeyHeader : t.bearer,
        set: d.auth !== 'bearer',
      },
      { text: d.json ? this.chipTexts.jsonOn : this.chipTexts.jsonOff, set: !d.json },
    ];
    if (d.api === 'chat_completions') {
      chips.push({
        text: d.maxTokensField === 'max_tokens' ? t.maxTokens : t.maxCompletionTokens,
        set: d.maxTokensField !== defaultOutputLimitField(d.url),
      });
    }
    return chips;
  }
  /** The connection options as chips while the fold is closed; one other than the default is set. */
  protected readonly chips = computed(() => {
    const d = this.draft();
    const chips: { text: string; set: boolean }[] = [];
    if (d.kind === 'openai') chips.push(...this.openaiChips(d));
    const seconds = parseWhole(d.timeout, 0, Number.MAX_SAFE_INTEGER);
    const n = seconds === null ? d.timeout.trim() : formatWhole(seconds, this.locale);
    chips.push({
      text: $localize`:@@aiProvider.chip.timeout:Timeout ${n}:n: s`,
      set: seconds !== DEFAULT_TIMEOUT,
    });
    const windowTokens =
      d.contextWindow.trim() === ''
        ? DEFAULT_CONTEXT_WINDOW
        : parseWhole(d.contextWindow, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX);
    const tokens =
      windowTokens === null ? d.contextWindow.trim() : formatWhole(windowTokens, this.locale);
    chips.push({
      text: $localize`:@@aiProvider.chip.contextWindow:Context window ${tokens}:n: tokens`,
      set: windowTokens !== DEFAULT_CONTEXT_WINDOW,
    });
    const temperature = d.kind === 'openai' && d.temperatureSet ? d.temperature.trim() : '';
    chips.push(
      temperature === ''
        ? { text: this.chipTexts.noTemperature, set: false }
        : {
            text: $localize`:@@aiProvider.chip.temperature:Temperature ${temperature}:t:`,
            set: true,
          },
    );
    return chips;
  });

  /** The changes from what is saved, by name: the foot counts them, each control's name is dotted. */
  protected readonly changed = computed(() =>
    changesOf(this.draft(), this.base(), this.keyTyped()),
  );
  protected readonly tiersChanged = computed(
    () => this.changed().has('strongModel') || this.changed().has('fastModel'),
  );
  protected readonly pricesChanged = computed(() =>
    ['prices', ...PRICE_FIELD_NAMES.map((field) => PRICE_FIELDS[field].key)].some((key) =>
      this.changed().has(key),
    ),
  );
  protected readonly optionsChanged = computed(() =>
    ['api', 'auth', 'json', 'maxTokensField', 'timeout', 'contextWindow', 'temperature'].some(
      (key) => this.changed().has(key),
    ),
  );
  /** Edits wait to be saved: leaving the page asks first. */
  readonly dirty = computed(() => this.changed().size > 0);

  /** The fields refused, as the foot names them. */
  private readonly refusedFields = computed(() => {
    const errors = this.errors();
    return FIELDS.filter((field) => errors[field] !== undefined).map((field) => ({
      id: this.inputIdOf(field),
      label: this.labelOf(field),
    }));
  });
  protected readonly footOutcome = computed<FootOutcome>(() => {
    if (this.saving()) return { kind: 'saving' };
    const refused = this.refusedFields();
    if (refused.length > 0) return { kind: 'refused', fields: refused };
    const failed = this.saveError();
    if (failed !== null) return { kind: 'error', text: failed };
    const count = this.changed().size;
    if (count > 0) return { kind: 'pending', count };
    const at = this.savedAt();
    return at === null ? { kind: 'clean' } : { kind: 'saved', at };
  });
  /** The foot shows once a kind is chosen, and after a removal, to say it was saved. */
  protected readonly showFoot = computed(() => this.draft().kind !== '' || this.savedAt() !== null);
  /** Test again: the saved provider, while nothing is changed. */
  protected readonly showTestAgain = computed(() => this.provider() !== null && !this.dirty());

  /**
   * The last Test: this visit's, else the one the server keeps (A2). Its time, who ran it (the
   * viewer, or another instance admin, never looked up by name), a line for each model, how many
   * failed, and whether a model takes tools only through the Responses API.
   */
  protected readonly testView = computed(() => {
    const visit = this.visitTest();
    if (visit !== null) {
      return this.viewOf(
        visit.at.toISOString(),
        true,
        visit.answer.models.map((m) => ({
          tier: m.tier,
          line: testLine(m),
          toolCalling: m.toolCalling,
          failed: m.problem !== null,
        })),
        visit.answer.models.some((m) => m.hint?.code === 'USE_RESPONSES_API'),
      );
    }
    const stored = this.saved().lastTest;
    if (stored === null) return null;
    return this.viewOf(
      stored.at,
      stored.userId === this.session.user()?.id,
      stored.models.map((m) => ({
        tier: m.tier,
        line: storedTestLine(m),
        toolCalling: m.toolCalling,
        failed: m.problemCode !== null,
      })),
      false,
    );
  });

  constructor() {
    // New settings (a save of this or another section): the fields not edited here show them.
    effect(() => {
      const settings = this.saved();
      untracked(() => this.adopt(settings));
    });
    // Nothing typed into the key field outlives the section.
    inject(DestroyRef).onDestroy(() => this.emptyKey());
  }

  protected errorOf(field: Field): string | null {
    return this.errors()[field] ?? null;
  }

  /** The kind; the workspace and the temperature, each one kind's own, take their refusal along. */
  protected setKind(kind: 'openai' | 'anthropic'): void {
    this.edit(
      (d) => ({
        ...d,
        kind,
        url: kind === 'anthropic' && d.url.trim() === '' ? ANTHROPIC_URL : d.url,
      }),
      'kind',
      'workspace-id',
      'temperature',
    );
  }

  /**
   * The address, and with it the presets the admin has not chosen here: the output limit
   * parameter when the host changes kind (an OpenAI host or another server), and for a new
   * provider the Responses API at api.openai.com.
   */
  protected setUrl(event: Event): void {
    const url = inputValue(event);
    this.edit((d) => {
      const next = { ...d, url };
      const limit = defaultOutputLimitField(url);
      if (!this.maxTokensFieldChosen && limit !== defaultOutputLimitField(d.url)) {
        next.maxTokensField = limit;
      }
      if (!this.apiChosen && this.provider() === null) {
        next.api = hostOf(url) === OPENAI_HOST ? 'responses' : 'chat_completions';
      }
      return next;
    }, 'url');
    // Back at the saved address with nothing typed, the stored key is good there again: the
    // request for it goes. A refusal of a key typed is about that key, and stays.
    if (!this.addressChanged() && !this.keyTyped()) this.clearError('key');
  }

  protected setText(
    key: 'model' | 'strongModel' | 'fastModel' | 'workspaceId',
    field: Field,
    event: Event,
  ): void {
    const value = inputValue(event);
    this.edit((d) => ({ ...d, [key]: value }), field);
  }

  protected setTiers(event: Event): void {
    const tiers = isChecked(event);
    this.edit((d) => ({ ...d, tiers }), 'strong-model', 'fast-model');
  }

  protected setPrices(event: Event): void {
    const prices = isChecked(event);
    this.edit((d) => ({ ...d, prices }), ...PRICE_FIELD_NAMES);
  }

  protected setPrice(field: PriceField, text: string): void {
    const { key } = PRICE_FIELDS[field];
    if (this.draft()[key] === text) return;
    this.edit((d) => ({ ...d, [key]: text }), field);
  }

  protected setApi(api: OpenAiApi): void {
    this.apiChosen = true;
    this.edit((d) => ({ ...d, api }));
  }

  protected setAuth(auth: KeyHeader): void {
    this.edit((d) => ({ ...d, auth }));
  }

  protected setMaxTokensField(maxTokensField: OutputLimit): void {
    this.maxTokensFieldChosen = true;
    this.edit((d) => ({ ...d, maxTokensField }));
  }

  protected setJson(event: Event): void {
    const json = isChecked(event);
    this.edit((d) => ({ ...d, json }));
  }

  protected setTimeoutSeconds(text: string): void {
    if (this.draft().timeout === text) return;
    this.edit((d) => ({ ...d, timeout: text }), 'timeout');
  }

  protected setContextWindow(text: string): void {
    if (this.draft().contextWindow === text) return;
    this.edit((d) => ({ ...d, contextWindow: text }), 'context-window');
  }

  protected setTemperatureSet(event: Event): void {
    const temperatureSet = isChecked(event);
    this.edit((d) => ({ ...d, temperatureSet }), 'temperature');
  }

  protected setTemperature(event: Event): void {
    const temperature = inputValue(event);
    this.edit((d) => ({ ...d, temperature }), 'temperature');
  }

  /** The key field changed: whether it holds anything is all the section keeps of it. */
  protected onKeyInput(event: Event): void {
    this.keyTyped.set(inputValue(event) !== '');
    this.edit((d) => d, 'key');
  }

  protected replaceKey(): void {
    this.replacing.set(true);
    this.focusLater('ai-key');
  }

  /** Remove the key: its field goes, with anything typed in it, and Undo takes it back. */
  protected removeKey(): void {
    this.replacing.set(false);
    this.keyTyped.set(false);
    this.edit((d) => ({ ...d, removeKey: true }), 'key');
    this.focusLater('ai-key-undo');
  }

  protected undoRemoveKey(): void {
    this.edit((d) => ({ ...d, removeKey: false }));
    this.focusLater('ai-key-remove');
  }

  protected onOptionsToggle(event: Event): void {
    this.optionsOpen.set((event.target as HTMLDetailsElement).open);
  }

  /**
   * Save and test: the section's checks first (a refusal sends nothing and keeps the key in its
   * field), then the question when the change pauses AI review somewhere, then the save.
   */
  protected async save(): Promise<void> {
    if (this.saving()) return;
    const built = this.build();
    if ('errors' in built) {
      this.refuse(built.errors);
      return;
    }
    const saved = this.provider();
    const reviewing = this.reviewing();
    if (saved !== null && reviewing.count > 0 && pausesReview(saved, built.consent)) {
      this.askPause(saved, built.consent, namesOf(reviewing.named, this.locale, reviewing.unnamed));
      return;
    }
    await this.send(built.change);
  }

  /** Save and pause AI review: the section as it is now (the dialog kept it as it was asked). */
  protected async confirmPause(): Promise<void> {
    if (this.pause() === null || this.saving()) return;
    // Cleared first: the dialog's close event then finds nothing to cancel.
    this.pause.set(null);
    closeDialog(this.pauseDialog());
    const built = this.build();
    if ('errors' in built) {
      this.refuse(built.errors);
      return;
    }
    await this.send(built.change);
  }

  /** Cancel, Escape or the dialog closing otherwise: nothing is sent. */
  protected cancelPause(): void {
    this.pause.set(null);
    closeDialog(this.pauseDialog());
  }

  protected askRemove(): void {
    if (this.saving()) return;
    this.removing.set(true);
    openAfterRender(
      this.injector,
      () => this.removeDialog()?.nativeElement,
      () => this.removing(),
    );
  }

  protected cancelRemove(): void {
    this.removing.set(false);
    closeDialog(this.removeDialog());
  }

  /** Removes the provider and its key, and its prices; the section starts over from the kinds. */
  protected async confirmRemove(): Promise<void> {
    if (!this.removing() || this.saving()) return;
    this.removing.set(false);
    closeDialog(this.removeDialog());
    this.saving.set(true);
    this.saveError.set(null);
    this.errors.set({});
    this.dropTest();
    try {
      const request = this.saveProvider()({ provider: null, pricing: null });
      this.emptyKey();
      this.startOver(await request);
    } catch (err) {
      this.saveError.set(problemMessage(err));
    } finally {
      this.emptyKey();
      this.saving.set(false);
    }
    keepFocus(this.injector, this.document, () =>
      this.document.getElementById('ai-provider-heading'),
    );
  }

  /** Test again: a Test of the saved provider, unless one or a save is on its way. */
  async test(): Promise<void> {
    if (this.testing() || this.saving()) return;
    await this.runTest();
  }

  /**
   * Sends a fixed prompt holding no repository data to each model of the saved provider (llm.md
   * §16), and lists what it found; the server keeps it as the last Test. A hint that a model takes
   * tools only through Responses opens the connection options, where that is chosen. It takes the
   * place of a Test on its way, whose answer is then dropped.
   */
  private async runTest(): Promise<void> {
    this.dropTest();
    const run = this.testRun;
    this.testing.set(true);
    try {
      const answer = await ok(this.api.client.POST('/api/v0/system/llm/test'));
      if (run !== this.testRun) return;
      this.visitTest.set({ answer, at: new Date() });
      if (answer.models.some((m) => m.hint?.code === 'USE_RESPONSES_API')) {
        this.optionsOpen.set(true);
      }
      this.tested.emit();
    } catch (err) {
      if (run === this.testRun) this.testError.set(problemMessage(err));
    } finally {
      if (run === this.testRun) this.testing.set(false);
    }
  }

  /** Forgets this visit's Test, and drops the answer of one on its way: the provider changes. */
  private dropTest(): void {
    this.testRun++;
    this.testing.set(false);
    this.visitTest.set(null);
    this.testError.set(null);
  }

  /**
   * The save itself. The key leaves its field only now, with the request, and the field is emptied
   * as it leaves and again when the answer comes, whatever it is. Then the Test.
   */
  private async send(change: ProviderChange): Promise<void> {
    const sent = this.draft();
    this.saving.set(true);
    this.saveError.set(null);
    this.dropTest();
    let saved: LlmSettings;
    try {
      const provider = change.provider && { ...change.provider, ...this.takeKey() };
      const request = this.saveProvider()({ provider, pricing: change.pricing });
      this.emptyKey();
      saved = await request;
    } catch (err) {
      this.saving.set(false);
      if (!this.refuseFromServer(err)) this.saveError.set(problemMessage(err));
      return;
    } finally {
      this.emptyKey();
    }
    this.saving.set(false);
    this.showSaved(saved, sent);
    this.savedAt.set(new Date());
    await this.runTest();
  }

  /**
   * The key part of the provider: the key typed; null after Remove, or for a new address (or a new
   * provider) without a stored key, which the server needs said; else none, which keeps whatever
   * key is stored, one another admin set meanwhile too.
   */
  private takeKey(): { apiKey?: string | null } {
    const typed = this.keyField()?.nativeElement.value ?? '';
    if (typed !== '') return { apiKey: typed };
    const newAddress = this.provider() === null || this.addressChanged();
    return this.draft().removeKey || (!this.keySet() && newAddress) ? { apiKey: null } : {};
  }

  private emptyKey(): void {
    const field = this.keyField()?.nativeElement;
    if (field) field.value = '';
    this.keyTyped.set(false);
  }

  /**
   * The section's change from the draft, without the key, and what a confirmation would name of
   * it; or the refused fields, in the page's own words. The key field is looked at (is it empty,
   * is it a key), never taken.
   */
  private build(): { change: ProviderChange; consent: ConsentInput } | { errors: Errors } {
    const d = this.draft();
    const errors: Errors = {};
    const refuse = (field: Field) => {
      errors[field] ??= refusal(field);
    };
    if (d.kind === '') {
      refuse('kind');
      return { errors };
    }
    const { baseUrl, model, strongModel, fastModel } = modelNamesOf(d, refuse);
    const keyProblem = this.keyProblem(d);
    if (keyProblem !== null) errors.key = keyProblem;
    const workspaceId = d.workspaceId.trim();
    if (d.kind === 'anthropic' && workspaceId !== '' && !WORKSPACE_ID.test(workspaceId)) {
      refuse('workspace-id');
    }
    const { timeoutSeconds, contextWindowTokens, temperature } = limitsOf(d, refuse);
    const pricing = pricingOf(d, refuse);
    if (Object.keys(errors).length > 0 || timeoutSeconds === null) return { errors };
    const provider: NonNullable<LlmBody['provider']> = {
      kind: d.kind,
      baseUrl,
      model,
      strongModel: strongModel === '' ? null : strongModel,
      fastModel: fastModel === '' ? null : fastModel,
      ...(d.kind === 'openai'
        ? {
            api: d.api,
            auth: d.auth,
            jsonMode: d.json ? ('json_object' as const) : ('none' as const),
            maxTokensField: d.maxTokensField,
          }
        : { workspaceId: workspaceId === '' ? null : workspaceId }),
      temperature,
      timeoutSeconds,
      contextWindowTokens,
    };
    return {
      change: { provider, pricing },
      consent: {
        baseUrl,
        model,
        strongModel: provider.strongModel ?? null,
        fastModel: provider.fastModel ?? null,
      },
    };
  }

  /**
   * What is wrong with the key typed, if anything; the key itself is not kept. A new address of
   * a provider with a stored key needs the key again, or Remove: the stored one is never sent
   * there (an address that is none is refused on its own field).
   */
  private keyProblem(d: Draft): string | null {
    const typed = this.keyField()?.nativeElement.value ?? '';
    if (typed === '') {
      const needsKey =
        this.keySet() && !d.removeKey && this.addressChanged() && isHttpUrl(d.url.trim());
      return needsKey ? refusal('key') : null;
    }
    return API_KEY.test(typed) ? null : keyFormat();
  }

  /** Marks the refused fields, opening the fold around one, and focuses the first. */
  private refuse(errors: Errors): void {
    this.errors.set(errors);
    if (OPTION_FIELDS.some((field) => errors[field] !== undefined)) this.optionsOpen.set(true);
    const first = FIELDS.find((field) => errors[field] !== undefined);
    if (first) this.focusLater(this.inputIdOf(first));
  }

  /** A 422 of the provider or its prices marks its fields; false for any other refusal. */
  private refuseFromServer(err: unknown): boolean {
    const refused: Errors = {};
    for (const path of Object.keys(fieldErrors(err))) {
      const match = SERVER_PATHS.find(
        ([prefix]) => path === prefix || path.startsWith(`${prefix}.`),
      );
      if (match) refused[match[1]] ??= refusal(match[1]);
    }
    if (Object.keys(refused).length === 0) return false;
    this.refuse(refused);
    return true;
  }

  /** Opens the question before a change pauses AI review in `who` (their names, or a count). */
  private askPause(saved: SavedProvider, next: ConsentInput, who: string): void {
    const before = consentFields(saved);
    const after = consentFields(next);
    const wasModels = before.models.join(', ');
    const nowModels = after.models.join(', ');
    this.pause.set({
      title: $localize`:@@aiProvider.pause.title:Pause AI review in ${who}:names:?`,
      was: $localize`:@@aiProvider.pause.was:${who}:names: confirmed sending code to ${before.host}:host: (${wasModels}:models:).`,
      now: $localize`:@@aiProvider.pause.now:After this change, AI review stops there until an organization admin confirms the new provider: ${after.host}:host: (${nowModels}:models:).`,
    });
    openAfterRender(
      this.injector,
      () => this.pauseDialog()?.nativeElement,
      () => this.pause() !== null,
    );
  }

  /** The draft takes new settings: a field not edited here shows the saved value. */
  private adopt(settings: LlmSettings): void {
    const next = draftOf(settings, this.locale);
    const before = this.base();
    this.draft.update((now) => (this.adopted ? keepEdits(now, before, next) : next));
    this.base.set(next);
    this.adopted = true;
  }

  /**
   * Puts a save's answer into the draft, except an edit made while it was on its way: that one
   * stays, unsaved, and the foot says so.
   */
  private showSaved(saved: LlmSettings, sent: Draft): void {
    const next = draftOf(saved, this.locale);
    this.draft.update((now) => keepEdits(now, sent, next));
    this.base.set(next);
    this.replacing.set(false);
    this.errors.set({});
    this.maxTokensFieldChosen = false;
    this.saved.set(saved);
  }

  /** After a removal: the saved settings, and the section as it is before a first setup. */
  private startOver(saved: LlmSettings): void {
    const next = draftOf(saved, this.locale);
    this.draft.set(next);
    this.base.set(next);
    this.replacing.set(false);
    this.optionsOpen.set(false);
    this.apiChosen = false;
    this.maxTokensFieldChosen = false;
    this.savedAt.set(new Date());
    this.saved.set(saved);
  }

  /** Changes the draft; the fields named lose their refusal, and the foot its failed save. */
  private edit(change: (d: Draft) => Draft, ...fields: Field[]): void {
    this.draft.update(change);
    this.saveError.set(null);
    this.clearError(...fields);
  }

  private clearError(...fields: Field[]): void {
    if (fields.some((field) => this.errors()[field] !== undefined)) {
      this.errors.update((all) =>
        Object.fromEntries(Object.entries(all).filter(([key]) => !fields.includes(key as Field))),
      );
    }
  }

  private viewOf(
    at: string,
    byViewer: boolean,
    models: readonly {
      tier: string;
      line: TestLine;
      toolCalling: 'supported' | 'not_supported' | 'not_checked';
      failed: boolean;
    }[],
    responsesHint: boolean,
  ) {
    const when = $localize`:@@aiProvider.test.at:Tested ${formatDateTime(at, this.locale)}:at:`;
    const failed = models.filter((m) => m.failed).length;
    const total = models.length;
    return {
      when: byViewer
        ? $localize`:@@aiProvider.test.byYou:${when}:when:, by you.`
        : $localize`:@@aiProvider.test.byAdmin:${when}:when:, by an instance admin.`,
      lines: models.map((m): LineView => {
        const tone = lineToneOf(m);
        const icon = LINE_ICONS[tone];
        return { tier: m.tier, tone, icon, ...withModel(m.line) };
      }),
      // How many models failed of how many, which the template words as a plural of the total.
      failed: failed === 0 ? null : { count: failed, total },
      responsesHint,
    };
  }

  /** A field's input: the chosen kind's radio for the kind. */
  private inputIdOf(field: Field): string {
    return field === 'kind' ? `ai-kind-${this.draft().kind || 'openai'}` : `ai-${field}`;
  }

  /** A field's name, as the foot lists it. */
  private labelOf(field: Field): string {
    const t = this.texts;
    switch (field) {
      case 'kind':
        return t.kind;
      case 'url':
        return t.url;
      case 'key':
        return t.key;
      case 'workspace-id':
        return t.workspace;
      case 'model':
        return t.model;
      case 'strong-model':
        return t.strongModel;
      case 'fast-model':
        return t.fastModel;
      case 'timeout':
        return t.timeout;
      case 'context-window':
        return t.contextWindow;
      case 'temperature':
        return t.temperature;
      default:
        return this.priceLabel(field, modelOf(this.draft(), PRICE_FIELDS[field].tier));
    }
  }

  /** A price field's name: its model, its side, and the currency the "US$" before it means. */
  private priceLabel(field: PriceField, model: string): string {
    if (isCachedPrice(field)) {
      return $localize`:@@aiProvider.prices.cachedLabel:${model}:model:: cached input, US$ per million tokens`;
    }
    return field.endsWith('-input')
      ? $localize`:@@aiProvider.prices.inputLabel:${model}:model:: input, US$ per million tokens`
      : $localize`:@@aiProvider.prices.outputLabel:${model}:model:: output, US$ per million tokens`;
  }

  private focusLater(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }
}

/** A line's words split around its model, which the line shows in code. */
function withModel(line: TestLine): { before: string; model: string; after: string } {
  const at = line.text.indexOf(line.model);
  return at < 0
    ? { before: line.text, model: '', after: '' }
    : {
        before: line.text.slice(0, at),
        model: line.model,
        after: line.text.slice(at + line.model.length),
      };
}

function closeDialog(ref: ElementRef<HTMLDialogElement> | undefined): void {
  const dialog = ref?.nativeElement;
  if (dialog?.open) closeModal(dialog);
}
