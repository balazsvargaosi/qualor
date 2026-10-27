import {
  afterNextRender,
  Component,
  computed,
  DOCUMENT,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  LOCALE_ID,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { fieldErrors, problemMessage } from '../../api/errors';
import { keepEdits } from '../../shared/drafts';
import { keepFocus } from '../../shared/focus';
import { clearField, inputValue, isChecked } from '../../shared/forms';
import { Icon } from '../../shared/icon';
import { NumberField } from '../../shared/number-field';
import { formatWhole, parseWhole } from '../../shared/numbers';
import { type FootOutcome, SectionFoot } from '../../shared/section-foot';
import type { LlmSettings, SectionChange } from './llm-body';

/** What the section saves: the paths never sent, and the copies of what is sent. */
export type DataChange = Omit<Extract<SectionChange, { section: 'data' }>, 'section'>;
/** Stores the section's change: resolves with the settings saved, rejects with the refusal. */
export type SaveData = (data: DataChange) => Promise<LlmSettings>;

/**
 * The section as it holds its settings: the paths never sent, the copies switch, and the days as
 * typed. Switched off, the days are kept, and come back with the switch.
 */
interface Draft {
  paths: readonly string[];
  storePrompts: boolean;
  retention: string;
}

/** The fields a refusal can point at, in the section's order. */
const FIELDS = ['exclude', 'retention'] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;
/** Each field's input: the add field stands for the list of paths. */
const INPUTS: Readonly<Record<Field, string>> = {
  exclude: 'ai-exclude-add',
  retention: 'ai-retention',
};

/** llm.md §3.2: at most 100 paths, each a glob of at most 200 characters. */
const MAX_PATHS = 100;
const MAX_GLOB = 200;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

/**
 * `q-ai-data-section` (spec §3.4 M-I7, §7.3 row 13): the instance's AI provider page's Data and
 * privacy, for instance admins.
 *
 * - **What is sent** to the provider's host, feature by feature, and what is never sent.
 * - **Never send these paths:** a list of globs with Remove, and a field that adds one. A glob is
 *   checked as the server does (not empty, at most 200 characters, from the repository root, no
 *   NUL), and once only; at most 100. A pattern typed and not added is an unsaved change: Save
 *   adds it first, or refuses it as Add would and sends nothing.
 * - **Copies of what is sent:** the switch, and the days they are kept under it.
 *
 * Its own foot saves them (`saveData`); a refusal marks its field in the page's own words, and an
 * edit made while the save is on its way stays, unsaved. New settings (another section's save)
 * fill only what is not edited. The page reads `dirty` and `dirtyLabel` for its leave guard.
 */
@Component({
  selector: 'q-ai-data-section',
  imports: [Icon, NumberField, SectionFoot],
  templateUrl: './data-section.html',
  styleUrl: './data-section.css',
})
export class DataSection {
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly locale = inject(LOCALE_ID);

  /** The settings as the server last answered. */
  readonly settings = input.required<LlmSettings>();
  /** The provider's host, which the data goes to; null while none is saved. */
  readonly host = input<string | null>(null);
  readonly saveData = input.required<SaveData>();
  /** The section's name, for the question asked before leaving it with unsaved changes. */
  readonly dirtyLabel = $localize`:@@aiProvider.data.title:Data and privacy`;

  protected readonly texts = {
    title: this.dirtyLabel,
    colFeature: $localize`:@@aiProvider.data.col.feature:Feature`,
    colStarts: $localize`:@@aiProvider.data.col.startsIt:Starts it`,
    colGets: $localize`:@@aiProvider.data.col.gets:What the model gets`,
    enterprise: $localize`:@@orgAi.enterprise:Enterprise`,
    paths: $localize`:@@aiProvider.data.paths:Never send these paths`,
    addLabel: $localize`:@@aiProvider.data.addLabel:Add a path pattern`,
    keepFor: $localize`:@@aiProvider.data.keepFor:Keep for`,
    days: $localize`:@@numberField.days:days`,
    save: $localize`:@@aiProvider.data.save:Save data and privacy`,
  };
  private readonly labels: Readonly<Record<Field, string>> = {
    exclude: this.texts.paths,
    retention: this.texts.keepFor,
  };

  /** The settings as last saved, as the section holds them: what the draft compares with. */
  private readonly base = signal<Draft>(draftOf(null, this.locale));
  protected readonly draft = signal<Draft>(draftOf(null, this.locale));
  /** The add field's text: a pattern typed and not added yet is one change, which Save adds. */
  protected readonly pattern = signal('');
  /** Why Add did not take the pattern: the field says it. */
  private readonly addError = signal<string | null>(null);
  protected readonly errors = signal<Errors>({});
  private readonly saving = signal(false);
  /** Why the last save failed, in the foot; gone with the next edit. */
  private readonly saveError = signal<string | null>(null);
  private readonly savedAt = signal<Date | null>(null);
  /** The draft has taken settings once: later settings keep its edits. */
  private adopted = false;
  /** The days as last saved, which a save sends back while the copies are switched off. */
  private savedDays = 7;

  private readonly addField = viewChild<ElementRef<HTMLInputElement>>('addField');

  /** A pattern is typed and not added: Save adds it first. Spaces alone are no pattern. */
  private readonly typed = computed(() => this.pattern().trim() !== '');
  /**
   * The changes from what is saved: each path added or removed, the switch, the days, and a
   * pattern typed and not added.
   */
  private readonly changes = computed(() => {
    const changes = changesOf(this.draft(), this.base());
    const typed = Number(this.typed());
    return { ...changes, paths: changes.paths + typed, count: changes.count + typed };
  });
  /** Edits wait to be saved: leaving the page asks first. */
  readonly dirty = computed(() => this.changes().count > 0);
  protected readonly pathsChanged = computed(() => this.changes().paths > 0);
  protected readonly copiesChanged = computed(() => this.changes().copies);
  protected readonly retentionChanged = computed(() => this.changes().retention);
  /** The days show while the switch is on, or while they are refused. */
  protected readonly showRetention = computed(
    () => this.draft().storePrompts || this.errors().retention !== undefined,
  );
  protected readonly paths = computed(() =>
    this.draft().paths.map((path) => ({
      path,
      removeLabel: $localize`:@@aiProvider.data.removeLabel:Remove ${path}:path:`,
    })),
  );
  /** What the add field says is wrong: the server's refusal of the list, or Add's of the pattern. */
  protected readonly patternError = computed(() => this.errors().exclude ?? this.addError());
  protected readonly addDescribedBy = computed(() =>
    this.patternError() === null
      ? 'ai-exclude-add-hint'
      : 'ai-exclude-add-error ai-exclude-add-hint',
  );

  protected readonly footOutcome = computed<FootOutcome>(() => {
    if (this.saving()) return { kind: 'saving' };
    const errors = this.errors();
    const refused = FIELDS.filter((field) => errors[field] !== undefined).map((field) => ({
      id: INPUTS[field],
      label: this.labels[field],
    }));
    if (refused.length > 0) return { kind: 'refused', fields: refused };
    const failed = this.saveError();
    if (failed !== null) return { kind: 'error', text: failed };
    const count = this.changes().count;
    if (count > 0) return { kind: 'pending', count };
    const at = this.savedAt();
    return at === null ? { kind: 'clean' } : { kind: 'saved', at };
  });

  constructor() {
    // New settings (a save of this or another section): what is not edited here shows them.
    effect(() => {
      const settings = this.settings();
      untracked(() => this.adopt(settings));
    });
  }

  protected errorOf(field: Field): string | null {
    return this.errors()[field] ?? null;
  }

  /** Typing is an edit of the list: the pattern waits to be saved, and a refusal of it goes. */
  protected setPattern(event: Event): void {
    this.pattern.set(inputValue(event));
    this.addError.set(null);
    this.edited('exclude');
  }

  /** Enter in the add field adds, as Add does. */
  protected onPatternKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.add();
  }

  /**
   * Add: the pattern joins the list when it is a glob from the repository root not listed yet,
   * and the list has room; else the field says why, keeps the pattern and takes the focus.
   */
  protected add(): void {
    const refused = refusalOf(this.pattern().trim(), this.draft().paths);
    this.addError.set(refused);
    if (refused !== null) {
      this.focusLater(INPUTS.exclude);
      return;
    }
    this.takePattern();
  }

  /** Removes a path; the focus goes to the Remove that takes its place, else the add field. */
  protected remove(path: string, index: number): void {
    this.draft.update((d) => ({ ...d, paths: d.paths.filter((p) => p !== path) }));
    this.edited('exclude');
    const removeButton = (at: number) =>
      this.element.nativeElement.querySelectorAll<HTMLElement>('.list-editor li button')[at];
    keepFocus(
      this.injector,
      this.document,
      () => removeButton(index),
      () => removeButton(index - 1),
      () => this.addField()?.nativeElement,
    );
  }

  protected setStorePrompts(event: Event): void {
    const storePrompts = isChecked(event);
    this.draft.update((d) => ({ ...d, storePrompts }));
    this.edited('retention');
  }

  protected setRetention(text: string): void {
    const before = this.draft().retention;
    if (before === text) return;
    this.draft.update((d) => ({ ...d, retention: text }));
    // Digits only grouped again when the field is left keep their refusal.
    const read = (t: string) => parseWhole(t, 0, Number.MAX_SAFE_INTEGER);
    if (read(before) === null || read(before) !== read(text)) this.edited('retention');
  }

  /**
   * Save data and privacy: a pattern typed and not added joins the list first, and the days are
   * checked; either refused, nothing is sent and the field says why. Then the save.
   */
  protected async save(): Promise<void> {
    if (this.saving()) return;
    if (this.typed()) {
      const refused = refusalOf(this.pattern().trim(), this.draft().paths);
      if (refused !== null) {
        this.addError.set(null);
        this.refuse({ exclude: refused });
        return;
      }
      this.takePattern();
    }
    const d = this.draft();
    let promptRetentionDays = this.savedDays;
    if (d.storePrompts) {
      const days = parseWhole(d.retention, MIN_DAYS, MAX_DAYS);
      if (days === null) {
        this.refuse({ retention: badRetention() });
        return;
      }
      promptRetentionDays = days;
    }
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const saved = await this.saveData()({
        excludePaths: [...d.paths],
        storePrompts: d.storePrompts,
        promptRetentionDays,
      });
      this.showSaved(saved, d);
      this.savedAt.set(new Date());
    } catch (err) {
      if (!this.refuseFromServer(err)) this.saveError.set(problemMessage(err));
    } finally {
      this.saving.set(false);
    }
  }

  /** The pattern typed joins the list, and the add field empties. */
  private takePattern(): void {
    const glob = this.pattern().trim();
    this.draft.update((d) => ({ ...d, paths: [...d.paths, glob] }));
    clearField(this.addField(), this.pattern);
    this.edited('exclude');
  }

  /** The draft takes new settings: what is not edited here shows the saved value. */
  private adopt(settings: LlmSettings): void {
    const next = draftOf(settings, this.locale);
    const before = this.base();
    this.draft.update((now) => (this.adopted ? keepEdits(now, before, next) : next));
    this.base.set(next);
    this.savedDays = settings.promptRetentionDays;
    this.adopted = true;
  }

  /** Puts a save's answer into the draft, except an edit made while it was on its way. */
  private showSaved(saved: LlmSettings, sent: Draft): void {
    const next = draftOf(saved, this.locale);
    this.draft.update((now) => keepEdits(now, sent, next));
    this.base.set(next);
    this.savedDays = saved.promptRetentionDays;
    this.errors.set({});
  }

  /** An edit: the last save's failure is old news, and so is a refusal of the field edited. */
  private edited(field: Field): void {
    this.saveError.set(null);
    this.clearError(field);
  }

  private clearError(field: Field): void {
    if (this.errors()[field] === undefined) return;
    this.errors.update((all) =>
      Object.fromEntries(Object.entries(all).filter(([key]) => key !== field)),
    );
  }

  /** Marks the refused fields and focuses the first. */
  private refuse(errors: Errors): void {
    this.errors.set(errors);
    const first = FIELDS.find((field) => errors[field] !== undefined);
    if (first !== undefined) this.focusLater(INPUTS[first]);
  }

  private focusLater(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }

  /** A 422 of the paths or the days marks its field; false for any other refusal. */
  private refuseFromServer(err: unknown): boolean {
    const refused: Errors = {};
    for (const path of Object.keys(fieldErrors(err))) {
      if (path === 'body.excludePaths') refused.exclude ??= tooManyPaths();
      else if (path.startsWith('body.excludePaths.')) refused.exclude ??= badGlob();
      else if (path === 'body.promptRetentionDays') refused.retention ??= badRetention();
    }
    if (Object.keys(refused).length === 0) return false;
    this.refuse(refused);
    return true;
  }
}

/** The stored paths and copies as the section holds them. */
function draftOf(settings: LlmSettings | null, locale: string): Draft {
  return {
    paths: settings?.excludePaths ?? [],
    storePrompts: settings?.storePrompts ?? false,
    retention: formatWhole(settings?.promptRetentionDays ?? 7, locale),
  };
}

/**
 * The changes between two drafts: each path one has and the other has not, the switch, and the
 * days by their value while the copies are kept (switched off, they are not sent).
 */
function changesOf(
  d: Draft,
  b: Draft,
): { paths: number; copies: boolean; retention: boolean; count: number } {
  const ours = new Set(d.paths);
  const theirs = new Set(b.paths);
  const paths =
    [...ours].filter((p) => !theirs.has(p)).length + [...theirs].filter((p) => !ours.has(p)).length;
  const copies = d.storePrompts !== b.storePrompts;
  const days = (text: string) => parseWhole(text, 0, Number.MAX_SAFE_INTEGER) ?? text.trim();
  const retention = d.storePrompts && !Object.is(days(d.retention), days(b.retention));
  return { paths, copies, retention, count: paths + Number(copies) + Number(retention) };
}

/** A glob as the server takes one: 1 to 200 characters, from the repository root, without NUL. */
function isGlob(glob: string): boolean {
  return glob !== '' && glob.length <= MAX_GLOB && !glob.startsWith('/') && !glob.includes('\0');
}

/**
 * Why a pattern cannot join the list, or null when it can: a glob from the repository root, not
 * listed yet, while the list has room.
 */
function refusalOf(glob: string, paths: readonly string[]): string | null {
  if (!isGlob(glob)) return badGlob();
  if (paths.includes(glob)) {
    return $localize`:@@aiProvider.data.listed:That pattern is already listed.`;
  }
  return paths.length >= MAX_PATHS ? tooManyPaths() : null;
}

function badGlob(): string {
  return $localize`:@@aiProvider.data.badGlob:Use a glob from the repository root, such as config/** or **/*.pem.`;
}

function tooManyPaths(): string {
  return $localize`:@@ai.settings.badExclude:Use at most 100 globs, relative to the repository root.`;
}

function badRetention(): string {
  return $localize`:@@ai.settings.badRetention:Use a whole number of days from 1 to 90.`;
}
