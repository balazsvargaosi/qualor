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
import { keepFocus } from '../../shared/focus';
import { inputValue, isChecked } from '../../shared/forms';
import { Icon } from '../../shared/icon';
import type { IconName } from '../../shared/icons';
import { NumberField } from '../../shared/number-field';
import { formatWhole, parseMoney, parseWhole } from '../../shared/numbers';
import { type FootOutcome, SectionFoot } from '../../shared/section-foot';
import { storedTestLine, testHintText, type TestLine, testLine } from '../ai-text';
import {
  type ConsentInput,
  consentFields,
  pausesReview,
  reviewingOrganizations,
} from './consent-impact';
import type { LlmBody } from './llm-body';

type LlmSettings = ResponseBody<'/api/v0/system/llm', 'get'>;
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

type Kind = '' | 'openai' | 'anthropic';
type OpenAiApi = 'chat_completions' | 'responses';
type KeyHeader = 'bearer' | 'api-key';
type OutputLimit = 'max_tokens' | 'max_completion_tokens';
type Tier = 'standard' | 'strong' | 'fast';
type PriceKey =
  | 'priceInput'
  | 'priceOutput'
  | 'priceStrongInput'
  | 'priceStrongOutput'
  | 'priceFastInput'
  | 'priceFastOutput';

/**
 * The provider and its prices as the section holds them: each field as typed, each switch. A
 * group switched off keeps its fields, which come back with it; only the key is never here.
 */
interface Draft {
  kind: Kind;
  url: string;
  model: string;
  tiers: boolean;
  strongModel: string;
  fastModel: string;
  workspaceId: string;
  prices: boolean;
  priceInput: string;
  priceOutput: string;
  priceStrongInput: string;
  priceStrongOutput: string;
  priceFastInput: string;
  priceFastOutput: string;
  api: OpenAiApi;
  auth: KeyHeader;
  json: boolean;
  maxTokensField: OutputLimit;
  timeout: string;
  temperatureSet: boolean;
  temperature: string;
  /** Remove the key was pressed: a save removes the stored key. */
  removeKey: boolean;
}

/** The fields a refusal can point at, in the section's order; each is the input `#ai-<field>`. */
const FIELDS = [
  'kind',
  'url',
  'key',
  'workspace-id',
  'model',
  'strong-model',
  'fast-model',
  'price-input',
  'price-output',
  'price-strong-input',
  'price-strong-output',
  'price-fast-input',
  'price-fast-output',
  'timeout',
  'temperature',
] as const;
type Field = (typeof FIELDS)[number];
type PriceField = Extract<Field, `price-${string}`>;
type Errors = Partial<Record<Field, string>>;
/** The fields inside Connection options: a refusal of one opens the fold. */
const OPTION_FIELDS: readonly Field[] = ['timeout', 'temperature'];

/** The models' rows in the prices table, in its order. */
const TIERS: readonly Tier[] = ['standard', 'strong', 'fast'];
/** Each row's fields: the input price, then the output price. */
const PRICE_ROWS: Readonly<Record<Tier, readonly [PriceField, PriceField]>> = {
  standard: ['price-input', 'price-output'],
  strong: ['price-strong-input', 'price-strong-output'],
  fast: ['price-fast-input', 'price-fast-output'],
};
/** Each price field's row, and where the draft keeps its text. */
const PRICE_FIELDS: Readonly<Record<PriceField, { tier: Tier; key: PriceKey }>> = {
  'price-input': { tier: 'standard', key: 'priceInput' },
  'price-output': { tier: 'standard', key: 'priceOutput' },
  'price-strong-input': { tier: 'strong', key: 'priceStrongInput' },
  'price-strong-output': { tier: 'strong', key: 'priceStrongOutput' },
  'price-fast-input': { tier: 'fast', key: 'priceFastInput' },
  'price-fast-output': { tier: 'fast', key: 'priceFastOutput' },
};
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
  ['body.provider.temperature', 'temperature'],
  ['body.pricing.inputUsdPerMTok', 'price-input'],
  ['body.pricing.outputUsdPerMTok', 'price-output'],
  ['body.pricing.strong.inputUsdPerMTok', 'price-strong-input'],
  ['body.pricing.strong.outputUsdPerMTok', 'price-strong-output'],
  // A tier's prices missing for its own model ("Give … prices too"). The server's other refusal
  // there, a pair for a tier without a model of its own ("Set … first"), cannot come from this
  // section: it sends no pair for such a tier.
  ['body.pricing.strong', 'price-strong-input'],
  ['body.pricing.fast.inputUsdPerMTok', 'price-fast-input'],
  ['body.pricing.fast.outputUsdPerMTok', 'price-fast-output'],
  ['body.pricing.fast', 'price-fast-input'],
  ['body.pricing', 'price-input'],
];

/** A model's name as the provider spells it (the server's `MODEL_PATTERN`). */
const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;
/** An Anthropic workspace as the console names it (the server's `WORKSPACE_ID_PATTERN`). */
const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{1,64}$/;
/** An API key: 1 to 4 096 printable characters without spaces (the server's `API_KEY_PATTERN`). */
const API_KEY = /^[\x21-\x7e]{1,4096}$/;
/** The most a temperature may be: OpenAI-compatible providers only, Anthropic's models take none. */
const MAX_TEMPERATURE = 2;
/** The most a price may be, in US dollars per million tokens. */
const MAX_PRICE = 10_000;
const DEFAULT_TIMEOUT = 60;
/** The address an empty Base URL takes when Anthropic is chosen. */
const ANTHROPIC_URL = 'https://api.anthropic.com';
/** OpenAI's own host, whose newest models call tools only through the Responses API. */
const OPENAI_HOST = 'api.openai.com';
/** How many organisations a sentence names; the others are counted. */
const NAMED = 3;
/**
 * A price as people write it: digits grouped in threes by commas, and any decimals after a point;
 * a point with nothing after it ("5.") or before it (".5") reads as the number.
 */
const PRICE = /^(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d*)?$/;
const SEPARATORS = /[\s_\u00a0\u202f]/g;

/** One model's line of a Test: its icon and words, the model set apart in code. */
interface LineView {
  tier: string;
  tone: 'ok' | 'bad' | 'unknown';
  icon: IconName;
  before: string;
  model: string;
  after: string;
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
    usd: $localize`:@@numberField.usd:US$`,
    seconds: $localize`:@@numberField.seconds:seconds`,
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
  /** The organisations a change of the address or the models pauses, as `reviewStatus` says. */
  private readonly reviewing = computed(() =>
    reviewingOrganizations(this.saved(), this.organizations()),
  );
  /** What changing the address does, while a provider is saved. */
  protected readonly urlNote = computed(() => {
    if (this.provider() === null) return null;
    const reviewing = this.reviewing();
    if (reviewing.length === 0) {
      return $localize`:@@aiProvider.url.keyOnly:Changing the address needs the API key again.`;
    }
    const names = this.namesOf(reviewing.map((o) => o.name));
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
  /** A row for the standard model, and one for each tier with a model of its own. */
  protected readonly priceRows = computed(() => {
    const draft = this.draft();
    const errors = this.errors();
    return pricedTiers(draft).map((tier) => {
      const model = modelOf(draft, tier);
      return {
        tier,
        model,
        tierName: this.tierNames[tier],
        cells: PRICE_ROWS[tier].map((field, i) => ({
          field,
          id: `ai-${field}`,
          column: i === 0 ? this.texts.colInput : this.texts.colOutput,
          label: this.priceLabel(field, model),
          value: draft[PRICE_FIELDS[field].key],
          error: errors[field] ?? null,
        })),
      };
    });
  });
  /** The connection options as chips while the fold is closed; one other than the default is set. */
  protected readonly chips = computed(() => {
    const d = this.draft();
    const t = this.texts;
    const chips: { text: string; set: boolean }[] = [];
    if (d.kind === 'openai') {
      chips.push({
        text: d.api === 'responses' ? t.responses : t.chat,
        set: d.api !== 'chat_completions',
      });
      chips.push({
        text: d.auth === 'api-key' ? t.apiKeyHeader : t.bearer,
        set: d.auth !== 'bearer',
      });
      chips.push({ text: d.json ? this.chipTexts.jsonOn : this.chipTexts.jsonOff, set: !d.json });
      if (d.api === 'chat_completions') {
        chips.push({
          text: d.maxTokensField === 'max_tokens' ? t.maxTokens : t.maxCompletionTokens,
          set: d.maxTokensField !== defaultOutputLimitField(d.url),
        });
      }
    }
    const seconds = parseWhole(d.timeout, 0, Number.MAX_SAFE_INTEGER);
    const n = seconds === null ? d.timeout.trim() : formatWhole(seconds, this.locale);
    chips.push({
      text: $localize`:@@aiProvider.chip.timeout:Timeout ${n}:n: s`,
      set: seconds !== DEFAULT_TIMEOUT,
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
    ['api', 'auth', 'json', 'maxTokensField', 'timeout', 'temperature'].some((key) =>
      this.changed().has(key),
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
          line: testLine({ ...m, hint: null }),
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
    if (saved !== null && reviewing.length > 0 && pausesReview(saved, built.consent)) {
      this.askPause(
        saved,
        built.consent,
        reviewing.map((o) => o.name),
      );
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
    const baseUrl = d.url.trim();
    if (!isHttpUrl(baseUrl)) refuse('url');
    const model = d.model.trim();
    if (!MODEL_NAME.test(model)) refuse('model');
    // A tier's model is optional: empty is sent as null, and the tier uses the model above.
    const strongModel = d.tiers ? d.strongModel.trim() : '';
    const fastModel = d.tiers ? d.fastModel.trim() : '';
    if (strongModel !== '' && !MODEL_NAME.test(strongModel)) refuse('strong-model');
    if (fastModel !== '' && !MODEL_NAME.test(fastModel)) refuse('fast-model');
    const keyProblem = this.keyProblem(d);
    if (keyProblem !== null) errors.key = keyProblem;
    const workspaceId = d.workspaceId.trim();
    if (d.kind === 'anthropic' && workspaceId !== '' && !WORKSPACE_ID.test(workspaceId)) {
      refuse('workspace-id');
    }
    const timeoutSeconds = parseWhole(d.timeout, 5, 600);
    if (timeoutSeconds === null) refuse('timeout');
    const temperature = temperatureOf(d);
    if (Number.isNaN(temperature)) refuse('temperature');
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
    if (d.removeKey) return keyAndRemove();
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

  private askPause(saved: SavedProvider, next: ConsentInput, names: readonly string[]): void {
    const before = consentFields(saved);
    const after = consentFields(next);
    const who = this.namesOf(names);
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

  /** Names as the locale lists them; past three, the first three and how many more. */
  private namesOf(names: readonly string[]): string {
    if (names.length <= NAMED) {
      return new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(names);
    }
    const shown = new Intl.ListFormat(this.locale, { type: 'unit' }).format(names.slice(0, NAMED));
    const n = formatWhole(names.length - NAMED, this.locale);
    const more = $localize`:@@aiProvider.pause.more:and ${n}:n: more`;
    return `${shown} ${more}`;
  }

  /** The draft takes new settings: a field not edited here shows the saved value. */
  private adopt(settings: LlmSettings): void {
    const next = draftOf(settings, this.locale);
    const before = this.base();
    this.draft.update((now) => (this.adopted ? mergeDraft(now, before, next) : next));
    this.base.set(next);
    this.adopted = true;
  }

  /**
   * Puts a save's answer into the draft, except an edit made while it was on its way: that one
   * stays, unsaved, and the foot says so.
   */
  private showSaved(saved: LlmSettings, sent: Draft): void {
    const next = draftOf(saved, this.locale);
    this.draft.update((now) => mergeDraft(now, sent, next));
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
        const tone =
          m.failed || m.toolCalling === 'not_supported'
            ? 'bad'
            : m.toolCalling === 'supported'
              ? 'ok'
              : 'unknown';
        const icon: IconName = tone === 'ok' ? 'check' : tone === 'bad' ? 'cross' : 'minus';
        return { tier: m.tier, tone, icon, ...withModel(m.line) };
      }),
      failedText:
        failed === 0
          ? null
          : $localize`:@@ai.test.modelsFailed:The test failed for ${failed}:failed: of ${total}:total: models.`,
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
      case 'temperature':
        return t.temperature;
      default:
        return this.priceLabel(field, modelOf(this.draft(), PRICE_FIELDS[field].tier));
    }
  }

  /** A price field's name: its model, its side, and the currency the "US$" before it means. */
  private priceLabel(field: PriceField, model: string): string {
    return field.endsWith('-input')
      ? $localize`:@@aiProvider.prices.inputLabel:${model}:model:: input, US$ per million tokens`
      : $localize`:@@aiProvider.prices.outputLabel:${model}:model:: output, US$ per million tokens`;
  }

  private focusLater(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }
}

/**
 * The output limit parameter an OpenAI-compatible base URL needs by default (llm.md §2.2): OpenAI's
 * and Azure OpenAI's current models refuse `max_tokens`; vLLM, Ollama and the others want it.
 */
export function defaultOutputLimitField(url: string): OutputLimit {
  const host = hostOf(url);
  return host !== null && (host === OPENAI_HOST || host.endsWith('.openai.azure.com'))
    ? 'max_completion_tokens'
    : 'max_tokens';
}

/** The provider and prices of the settings as the section holds them; none for no settings. */
function draftOf(settings: LlmSettings | null, locale: string): Draft {
  const p = settings?.provider ?? null;
  const pricing = settings?.pricing ?? null;
  const price = (n: number | undefined) => (n === undefined ? '' : formatPrice(n, locale));
  return {
    kind: p?.kind ?? '',
    url: p?.baseUrl ?? '',
    model: p?.model ?? '',
    tiers: (p?.strongModel ?? null) !== null || (p?.fastModel ?? null) !== null,
    strongModel: p?.strongModel ?? '',
    fastModel: p?.fastModel ?? '',
    workspaceId: p?.workspaceId ?? '',
    prices: pricing !== null,
    priceInput: price(pricing?.inputUsdPerMTok),
    priceOutput: price(pricing?.outputUsdPerMTok),
    priceStrongInput: price(pricing?.strong?.inputUsdPerMTok),
    priceStrongOutput: price(pricing?.strong?.outputUsdPerMTok),
    priceFastInput: price(pricing?.fast?.inputUsdPerMTok),
    priceFastOutput: price(pricing?.fast?.outputUsdPerMTok),
    // A provider saved before the API was a setting asks through Chat Completions.
    api: p?.api ?? 'chat_completions',
    auth: p?.auth ?? 'bearer',
    json: (p?.jsonMode ?? 'json_object') === 'json_object',
    maxTokensField: p?.maxTokensField ?? 'max_tokens',
    timeout: formatWhole(p?.timeoutSeconds ?? DEFAULT_TIMEOUT, locale),
    temperatureSet: (p?.temperature ?? null) !== null,
    temperature: (p?.temperature ?? null) === null ? '' : String(p?.temperature),
    removeKey: false,
  };
}

/** `now`, with each field that still holds what `from` had replaced by `to`'s. */
function mergeDraft(now: Draft, from: Draft, to: Draft): Draft {
  const merged = { ...now };
  for (const key of Object.keys(now) as (keyof Draft)[]) {
    if (now[key] === from[key]) (merged as Record<keyof Draft, unknown>)[key] = to[key];
  }
  return merged;
}

/**
 * The draft's changes from what is saved, by name, as a save would send them: a tier's model while
 * its switch is on, the shown prices while theirs is on, the OpenAI options for that kind only
 * (Anthropic stores their defaults), numbers by their value, and the key typed or removed.
 */
function changesOf(d: Draft, b: Draft, keyTyped: boolean): ReadonlySet<string> {
  const changed = new Set<string>();
  const differ = (key: string, x: unknown, y: unknown) => {
    if (!Object.is(x, y)) changed.add(key);
  };
  const openAi = <T>(x: Draft, value: T, otherwise: T) => (x.kind === 'openai' ? value : otherwise);
  differ('kind', d.kind, b.kind);
  differ('url', normalUrl(d.url), normalUrl(b.url));
  differ('model', d.model.trim(), b.model.trim());
  differ('strongModel', d.tiers ? d.strongModel.trim() : '', b.tiers ? b.strongModel.trim() : '');
  differ('fastModel', d.tiers ? d.fastModel.trim() : '', b.tiers ? b.fastModel.trim() : '');
  differ(
    'workspaceId',
    d.kind === 'anthropic' ? d.workspaceId.trim() : '',
    b.kind === 'anthropic' ? b.workspaceId.trim() : '',
  );
  if (d.prices !== b.prices) {
    changed.add('prices');
  } else if (d.prices) {
    for (const tier of pricedTiers(d)) {
      for (const field of PRICE_ROWS[tier]) {
        const { key } = PRICE_FIELDS[field];
        differ(key, priceValue(d[key]), priceValue(b[key]));
      }
    }
  }
  differ('api', openAi(d, d.api, 'chat_completions'), openAi(b, b.api, 'chat_completions'));
  differ('auth', openAi(d, d.auth, 'bearer'), openAi(b, b.auth, 'bearer'));
  differ('json', openAi(d, d.json, true), openAi(b, b.json, true));
  differ(
    'maxTokensField',
    openAi(d, d.maxTokensField, 'max_tokens'),
    openAi(b, b.maxTokensField, 'max_tokens'),
  );
  differ('timeout', wholeValue(d.timeout), wholeValue(b.timeout));
  differ('temperature', temperatureValue(d), temperatureValue(b));
  if (d.removeKey || keyTyped) changed.add('key');
  return changed;
}

/** A tier's model as the server counts it: its own when set and not the standard one, else none. */
function ownModel(d: Draft, tier: Tier): string | null {
  if (tier === 'standard' || d.kind === '' || !d.tiers) return null;
  const model = (tier === 'strong' ? d.strongModel : d.fastModel).trim();
  return model === '' || model === d.model.trim() ? null : model;
}

/** The model a price row is for. */
function modelOf(d: Draft, tier: Tier): string {
  return ownModel(d, tier) ?? d.model.trim();
}

/** The rows of the prices table: the standard model, and each tier with a model of its own. */
function pricedTiers(d: Draft): Tier[] {
  return TIERS.filter((tier) => tier === 'standard' || ownModel(d, tier) !== null);
}

/**
 * The prices part of the body: null while their switch is off or none is given; refused through
 * `refuse` otherwise. Once a price is given the server needs the standard model's pair and the
 * pair of each tier that has a model of its own, so a pair left out is refused; a tier without a
 * model of its own sends none.
 */
function pricingOf(d: Draft, refuse: (field: Field) => void): LlmBody['pricing'] {
  if (!d.prices) return null;
  const typed = pricedTiers(d).some((tier) =>
    PRICE_ROWS[tier].some((field) => d[PRICE_FIELDS[field].key].trim() !== ''),
  );
  if (!typed) return null;
  const price = (field: PriceField) => {
    const value = parsePrice(d[PRICE_FIELDS[field].key]);
    if (value === null) refuse(field);
    return value ?? 0;
  };
  const pair = (tier: Tier) => {
    const [input, output] = PRICE_ROWS[tier];
    return { inputUsdPerMTok: price(input), outputUsdPerMTok: price(output) };
  };
  return {
    ...pair('standard'),
    strong: ownModel(d, 'strong') === null ? null : pair('strong'),
    fast: ownModel(d, 'fast') === null ? null : pair('fast'),
  };
}

/**
 * The temperature the body sends: none for Anthropic (its current models take none), while the
 * switch is off, or while the field is empty; NaN for one that is not a number from 0 to 2.
 */
function temperatureOf(d: Draft): number | null {
  const typed = d.temperature.trim();
  if (d.kind !== 'openai' || !d.temperatureSet || typed === '') return null;
  const n = Number(typed);
  return Number.isFinite(n) && n >= 0 && n <= MAX_TEMPERATURE ? n : Number.NaN;
}

/**
 * A price as typed, from 0 to 10 000: as the money field writes it ("1,000.00"), with more
 * decimals ("0.075"), or with a bare point ("5."); null when it is not one.
 */
function parsePrice(text: string): number | null {
  const grouped = parseMoney(text, MAX_PRICE);
  if (grouped !== null) return grouped;
  const plain = text.replace(SEPARATORS, '');
  if (plain === '' || plain === '.' || !PRICE.test(plain)) return null;
  const n = Number(plain.replaceAll(',', ''));
  return Number.isFinite(n) && n <= MAX_PRICE ? n : null;
}

function formatPrice(n: number, locale: string): string {
  // As the money field writes it, without rounding a price of more decimals away.
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 20,
  }).format(n);
}

/** A value to compare: the number a text stands for, else the text. */
const priceValue = (text: string) => parsePrice(text) ?? text.trim();
const wholeValue = (text: string) => parseWhole(text, 0, Number.MAX_SAFE_INTEGER) ?? text.trim();
function temperatureValue(d: Draft): number | string | null {
  const n = temperatureOf(d);
  return Number.isNaN(n) ? d.temperature.trim() : n;
}

/** The address as the server keeps it, or as typed when it does not parse. */
function normalUrl(text: string): string {
  try {
    return consentFields({ baseUrl: text, model: '', strongModel: null, fastModel: null }).url;
  } catch {
    return text.trim();
  }
}

/** The host name of an address, in lower case; null when it does not parse. */
function hostOf(text: string): string | null {
  try {
    return new URL(text.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
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

/** The section's own words for a refused field (the server's text is never shown). */
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
    case 'price-input':
    case 'price-output':
      return $localize`:@@ai.settings.badPrice:Give both prices, in US dollars per million tokens (0 to 10000), or neither.`;
    case 'price-strong-input':
    case 'price-strong-output':
      return $localize`:@@ai.settings.badStrongPrice:Give the strong model's prices too, in US dollars per million tokens (0 to 10000).`;
    case 'price-fast-input':
    case 'price-fast-output':
      return $localize`:@@ai.settings.badFastPrice:Give the fast model's prices too, in US dollars per million tokens (0 to 10000).`;
  }
}

function keyFormat(): string {
  return $localize`:@@ai.settings.keyFormat:This is not an API key: a key is 1 to 4096 printable characters without spaces.`;
}

function keyAndRemove(): string {
  return $localize`:@@ai.settings.keyAndRemove:Type a new API key or check Remove the key, not both.`;
}
