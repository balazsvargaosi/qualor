import {
  afterNextRender,
  Component,
  computed,
  DOCUMENT,
  effect,
  inject,
  Injector,
  input,
  LOCALE_ID,
  signal,
  untracked,
} from '@angular/core';
import { fieldErrors, problemMessage } from '../../api/errors';
import { keepEdits } from '../../shared/drafts';
import { isChecked } from '../../shared/forms';
import { Icon } from '../../shared/icon';
import { NumberField } from '../../shared/number-field';
import { formatMoney, formatWhole, parseMoney, parseWhole } from '../../shared/numbers';
import { type FootOutcome, SectionFoot } from '../../shared/section-foot';
import { TONE_CHIPS } from '../../shared/status-list';
import type { LlmBody, LlmSettings } from './llm-body';

type Budgets = LlmBody['budgets'];
/** Stores the section's limits: resolves with the settings saved, rejects with the refusal. */
export type SaveLimits = (budgets: Budgets) => Promise<LlmSettings>;

/**
 * The limits as the section holds them: each field as typed, and the switches of the two optional
 * limits. A limit switched off is none; its text is kept, and comes back when it is switched on.
 */
interface Draft {
  explain: string;
  triage: string;
  fix: string;
  tokens: string;
  asks: string;
  costSet: boolean;
  cost: string;
  capSet: boolean;
  cap: string;
}
type TextKey = 'explain' | 'triage' | 'fix' | 'tokens' | 'asks' | 'cost' | 'cap';

/** The fields a refusal can point at, in the section's order; each is the input `#ai-<field>`. */
const FIELDS = [
  'budget-explain',
  'budget-triage',
  'budget-fix',
  'budget-tokens',
  'budget-user',
  'budget-cost',
  'budget-review',
] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;

/** Each field's text in the draft, the budget it stands for, and its bounds. */
const LIMITS: Readonly<
  Record<Field, { key: TextKey; budget: keyof Budgets; min: number; max: number }>
> = {
  'budget-explain': { key: 'explain', budget: 'explainPerDay', min: 0, max: 100_000 },
  'budget-triage': { key: 'triage', budget: 'triagePerDay', min: 0, max: 100_000 },
  'budget-fix': { key: 'fix', budget: 'fixPerDay', min: 0, max: 100_000 },
  'budget-tokens': { key: 'tokens', budget: 'tokensPerDay', min: 0, max: 1_000_000_000 },
  'budget-user': { key: 'asks', budget: 'perUserPerHour', min: 1, max: 10_000 },
  'budget-cost': { key: 'cost', budget: 'costPerDayUsd', min: 0, max: 1_000_000 },
  'budget-review': {
    key: 'cap',
    budget: 'reviewTokensPerOrganizationPerDay',
    min: 0,
    max: 1_000_000_000,
  },
};
/** The fields of the assistant's grid, in its order. */
const GRID: readonly Exclude<Field, 'budget-cost' | 'budget-review'>[] = [
  'budget-explain',
  'budget-triage',
  'budget-fix',
  'budget-tokens',
  'budget-user',
];
/** The server's 422 paths of the budgets (llm.md §16), and the field of each. */
const SERVER_PATHS = new Map<string, Field>(
  FIELDS.map((field) => [`body.budgets.${LIMITS[field].budget}`, field]),
);

/**
 * `q-ai-limits-section` (spec §3.4 M-I6, §7.3 rows 11–12): the instance's AI provider page's
 * Limits, for instance admins. What each allowed organisation may spend per UTC day:
 *
 * - the assistant's budgets (explanations, triage and fix suggestions, tokens) and the asks per
 *   person and hour, as number fields; the cost per day under its switch, which needs prices: the
 *   switch is disabled under a requirement while none are set (unless a cost limit is stored, so
 *   it can be switched off);
 * - the cap on the tokens an organisation's admins may give AI review, under its switch. Every
 *   save sends it, null for none: a body without it would keep a cap stored meanwhile.
 *
 * Its own foot saves them (`saveLimits`); a refusal marks its fields in the page's own words, and
 * an edit made while the save is on its way stays, unsaved. New settings (another section's save)
 * fill only the fields not edited. The page reads `dirty` and `dirtyLabel` for its leave guard.
 */
@Component({
  selector: 'q-ai-limits-section',
  imports: [Icon, NumberField, SectionFoot],
  templateUrl: './limits-section.html',
  styleUrl: './limits-section.css',
})
export class LimitsSection {
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  /** The settings as the server last answered. */
  readonly settings = input.required<LlmSettings>();
  readonly saveLimits = input.required<SaveLimits>();
  /** The section's name, for the question asked before leaving it with unsaved changes. */
  readonly dirtyLabel = $localize`:@@aiProvider.limits.title:Limits`;

  protected readonly texts = {
    title: this.dirtyLabel,
    chip: $localize`:@@aiProvider.limits.chip:Set`,
    tokens: $localize`:@@numberField.tokens:tokens`,
    usd: $localize`:@@numberField.usd:US$`,
    costField: $localize`:@@aiProvider.limits.costField:Cost per day`,
    capField: $localize`:@@aiProvider.limits.capField:Tokens per day, per organization`,
    noPrices: $localize`:@@aiProvider.limits.noPrices:No prices are set, so a cost limit would count nothing. Enter them under`,
    pricesLink: $localize`:@@aiProvider.limits.pricesLink:Provider → Prices`,
    save: $localize`:@@aiProvider.limits.save:Save limits`,
  };
  private readonly labels: Readonly<Record<Field, string>> = {
    'budget-explain': $localize`:@@aiProvider.limits.explain:Explanations per day`,
    'budget-triage': $localize`:@@aiProvider.limits.triage:Triage suggestions per day`,
    'budget-fix': $localize`:@@aiProvider.limits.fix:Fix suggestions per day`,
    'budget-tokens': $localize`:@@aiProvider.limits.tokens:Tokens per day`,
    'budget-user': $localize`:@@aiProvider.limits.asks:Asks per person and hour`,
    'budget-cost': this.texts.costField,
    'budget-review': this.texts.capField,
  };
  protected readonly chip = TONE_CHIPS.ok;

  /** The limits as last saved, as the section holds them: what the draft compares with. */
  private readonly base = signal<Draft>(draftOf(null, this.locale));
  protected readonly draft = signal<Draft>(draftOf(null, this.locale));
  protected readonly errors = signal<Errors>({});
  private readonly saving = signal(false);
  /** Why the last save failed, in the foot; gone with the next edit. */
  private readonly saveError = signal<string | null>(null);
  private readonly savedAt = signal<Date | null>(null);
  /** The draft has taken settings once: later settings keep its edits. */
  private adopted = false;

  /** No prices are set: a cost limit would count nothing. */
  protected readonly noPrices = computed(() => this.settings().pricing === null);
  /** The fields that differ from what is saved, by value. */
  private readonly changed = computed(() => changesOf(this.draft(), this.base()));
  /** Edits wait to be saved: leaving the page asks first. */
  readonly dirty = computed(() => this.changed().size > 0);

  /** The assistant's fields: each with its label, its value, its refusal and what describes it. */
  protected readonly grid = computed(() => {
    const draft = this.draft();
    const errors = this.errors();
    const changed = this.changed();
    return GRID.map((field) => {
      const error = errors[field] ?? null;
      const hint = field === 'budget-user' ? `ai-${field}-hint` : null;
      return {
        field,
        key: LIMITS[field].key,
        id: `ai-${field}`,
        label: this.labels[field],
        value: draft[LIMITS[field].key],
        digits: field === 'budget-tokens' ? (10 as const) : (6 as const),
        unit: field === 'budget-tokens' ? this.texts.tokens : null,
        hint,
        error,
        changed: changed.has(field),
        describedBy: joinIds(error === null ? null : `ai-${field}-error`, hint),
      };
    });
  });
  protected readonly costChanged = computed(() => this.changed().has('budget-cost'));
  protected readonly capChanged = computed(() => this.changed().has('budget-review'));
  /** A limit's field shows while its switch is on, or while it is refused. */
  protected readonly showCost = computed(
    () => this.draft().costSet || this.errors()['budget-cost'] !== undefined,
  );
  protected readonly showCap = computed(
    () => this.draft().capSet || this.errors()['budget-review'] !== undefined,
  );
  protected readonly costSwitchDescribedBy = computed(() =>
    joinIds('ai-budget-cost-set-help', this.noPrices() ? 'ai-budget-no-prices' : null),
  );
  protected readonly costDescribedBy = computed(() =>
    joinIds(
      this.errors()['budget-cost'] === undefined ? null : 'ai-budget-cost-error',
      // The currency before the digits is read with the field.
      'ai-budget-cost-prefix',
    ),
  );
  protected readonly capDescribedBy = computed(() =>
    joinIds(
      this.errors()['budget-review'] === undefined ? null : 'ai-budget-review-error',
      'ai-budget-review-hint',
    ),
  );

  protected readonly footOutcome = computed<FootOutcome>(() => {
    if (this.saving()) return { kind: 'saving' };
    const errors = this.errors();
    const refused = FIELDS.filter((field) => errors[field] !== undefined).map((field) => ({
      id: `ai-${field}`,
      label: this.labels[field],
    }));
    if (refused.length > 0) return { kind: 'refused', fields: refused };
    const failed = this.saveError();
    if (failed !== null) return { kind: 'error', text: failed };
    const count = this.changed().size;
    if (count > 0) return { kind: 'pending', count };
    const at = this.savedAt();
    return at === null ? { kind: 'clean' } : { kind: 'saved', at };
  });

  constructor() {
    // New settings (a save of this or another section): the fields not edited here show them.
    effect(() => {
      const settings = this.settings();
      untracked(() => this.adopt(settings));
    });
  }

  protected errorOf(field: Field): string | null {
    return this.errors()[field] ?? null;
  }

  protected setText(key: TextKey, field: Field, text: string): void {
    const before = this.draft()[key];
    if (before === text) return;
    this.draft.update((d) => ({ ...d, [key]: text }));
    // Digits only grouped again when the field is left keep its refusal.
    const regrouped =
      numberOf(field, before) !== null && numberOf(field, before) === numberOf(field, text);
    if (!regrouped) this.edited(field);
  }

  protected setCostSet(event: Event): void {
    const costSet = isChecked(event);
    this.draft.update((d) => ({ ...d, costSet }));
    this.edited('budget-cost');
  }

  protected setCapSet(event: Event): void {
    const capSet = isChecked(event);
    this.draft.update((d) => ({ ...d, capSet }));
    this.edited('budget-review');
  }

  /** The requirement's link: the prices' switch, in the Provider section above. */
  protected toPrices(event: Event): void {
    event.preventDefault();
    this.document.getElementById('ai-prices')?.focus();
  }

  /** Save limits: the section's checks first (a refusal sends nothing), then the save. */
  protected async save(): Promise<void> {
    if (this.saving()) return;
    const built = budgetsOf(this.draft());
    if ('errors' in built) {
      this.refuse(built.errors);
      return;
    }
    const sent = this.draft();
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const saved = await this.saveLimits()(built.budgets);
      this.showSaved(saved, sent);
      this.savedAt.set(new Date());
    } catch (err) {
      if (!this.refuseFromServer(err)) this.saveError.set(problemMessage(err));
    } finally {
      this.saving.set(false);
    }
  }

  /** The draft takes new settings: a field not edited here shows the saved value. */
  private adopt(settings: LlmSettings): void {
    const next = draftOf(settings, this.locale);
    const before = this.base();
    this.draft.update((now) => (this.adopted ? keepEdits(now, before, next) : next));
    this.base.set(next);
    this.adopted = true;
  }

  /** Puts a save's answer into the draft, except an edit made while it was on its way. */
  private showSaved(saved: LlmSettings, sent: Draft): void {
    const next = draftOf(saved, this.locale);
    this.draft.update((now) => keepEdits(now, sent, next));
    this.base.set(next);
    this.errors.set({});
  }

  /** An edit: the last save's failure is old news, and so is a refusal of the field edited. */
  private edited(field: Field): void {
    this.saveError.set(null);
    if (this.errors()[field] === undefined) return;
    this.errors.update((all) =>
      Object.fromEntries(Object.entries(all).filter(([key]) => key !== field)),
    );
  }

  /** Marks the refused fields and focuses the first. */
  private refuse(errors: Errors): void {
    this.errors.set(errors);
    const first = FIELDS.find((field) => errors[field] !== undefined);
    if (first === undefined) return;
    afterNextRender(() => this.document.getElementById(`ai-${first}`)?.focus(), {
      injector: this.injector,
    });
  }

  /** A 422 of the budgets marks their fields; false for any other refusal. */
  private refuseFromServer(err: unknown): boolean {
    const refused: Errors = {};
    for (const path of Object.keys(fieldErrors(err))) {
      const field = SERVER_PATHS.get(path);
      if (field !== undefined) refused[field] ??= refusal(field);
    }
    if (Object.keys(refused).length === 0) return false;
    this.refuse(refused);
    return true;
  }
}

/** The stored limits as the section holds them, grouped as the locale writes numbers. */
function draftOf(settings: LlmSettings | null, locale: string): Draft {
  const b = settings?.budgets;
  const whole = (n: number | null = null) => (n === null ? '' : formatWhole(n, locale));
  const cost = b?.costPerDayUsd ?? null;
  const cap = b?.reviewTokensPerOrganizationPerDay ?? null;
  return {
    explain: whole(b?.explainPerDay),
    triage: whole(b?.triagePerDay),
    fix: whole(b?.fixPerDay),
    tokens: whole(b?.tokensPerDay),
    asks: whole(b?.perUserPerHour),
    costSet: cost !== null,
    cost: cost === null ? '' : formatMoney(cost, locale),
    capSet: cap !== null,
    cap: whole(cap),
  };
}

/** The draft's budgets as the body sends them (a limit switched off is null), or its refusals. */
function budgetsOf(d: Draft): { budgets: Budgets } | { errors: Errors } {
  const errors: Errors = {};
  const read = (field: Field): number => {
    const { key, min, max } = LIMITS[field];
    const value = field === 'budget-cost' ? parseMoney(d[key], max) : parseWhole(d[key], min, max);
    if (value === null) errors[field] = refusal(field);
    return value ?? 0;
  };
  const budgets: Budgets = {
    explainPerDay: read('budget-explain'),
    triagePerDay: read('budget-triage'),
    fixPerDay: read('budget-fix'),
    tokensPerDay: read('budget-tokens'),
    costPerDayUsd: d.costSet ? read('budget-cost') : null,
    perUserPerHour: read('budget-user'),
    reviewTokensPerOrganizationPerDay: d.capSet ? read('budget-review') : null,
  };
  return Object.keys(errors).length > 0 ? { errors } : { budgets };
}

/**
 * The fields whose value differs between two drafts: a limit switched off stands for none, text
 * that is no number differs from any number, and digits only grouped otherwise are no change.
 */
function changesOf(d: Draft, b: Draft): ReadonlySet<Field> {
  const value = (x: Draft, field: Field): number | string | null => {
    if ((field === 'budget-cost' && !x.costSet) || (field === 'budget-review' && !x.capSet)) {
      return null;
    }
    const text = x[LIMITS[field].key];
    return numberOf(field, text) ?? text.trim();
  };
  return new Set(FIELDS.filter((field) => !Object.is(value(d, field), value(b, field))));
}

/** The number a field's text stands for, whatever its bounds; null when it is not one. */
function numberOf(field: Field, text: string): number | null {
  return field === 'budget-cost'
    ? parseMoney(text, Number.MAX_SAFE_INTEGER)
    : parseWhole(text, 0, Number.MAX_SAFE_INTEGER);
}

function joinIds(...ids: (string | null)[]): string | null {
  const named = ids.filter((id) => id !== null);
  return named.length > 0 ? named.join(' ') : null;
}

/** The section's own words for a refused field (the server's text is never shown). */
function refusal(field: Field): string {
  switch (field) {
    case 'budget-explain':
    case 'budget-triage':
    case 'budget-fix':
    case 'budget-tokens':
      return $localize`:@@ai.settings.badBudget:Use a whole number, 0 or more.`;
    case 'budget-user':
      return $localize`:@@ai.settings.badUserBudget:Use a whole number, 1 or more.`;
    case 'budget-review':
      return $localize`:@@ai.settings.badReviewCeiling:Use a whole number, 0 or more, or switch the cap off.`;
    case 'budget-cost':
      return $localize`:@@ai.settings.badCost:Use an amount in US dollars, or switch the cost limit off.`;
  }
}
