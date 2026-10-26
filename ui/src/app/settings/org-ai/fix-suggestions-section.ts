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
  output,
  signal,
  untracked,
} from '@angular/core';
import { Api, ok } from '../../api/api';
import { fieldErrors, problemMessage } from '../../api/errors';
import type { ItemOf } from '../../api/types';
import { label } from '../../i18n/labels';
import { inputValue, isChecked } from '../../shared/forms';
import { Icon } from '../../shared/icon';
import type { IconName } from '../../shared/icons';
import { NumberField } from '../../shared/number-field';
import { formatWhole } from '../../shared/numbers';
import { Requirement } from '../../shared/requirement';
import { type FootOutcome, SectionFoot } from '../../shared/section-foot';
import type { StatusLine, StatusTone } from '../../shared/status-list';
import type { OrgAi } from '../ai-review';
import {
  AUTO_FIX_SEVERITIES,
  type AutoFixSeverity,
  autoFixNotLicensed,
  autoFixRefusal,
  isAutoFixSeverity,
  maxPerAnalysisRefusal,
  type OrgAutoFix,
  parseMaxPerAnalysis,
} from '../auto-fix';

type Project = ItemOf<'/api/v0/projects'>;

/** The input of the maximum per analysis, which a refusal names and focuses. */
const MAX_INPUT = 'auto-fix-max';

/** The stored switch as the status and the section's head say it (spec §7.8). */
const CHIPS: Record<StatusTone, { badge: string; icon: IconName }> = {
  ok: { badge: 'badge-passed', icon: 'check' },
  off: { badge: 'badge-none', icon: 'minus' },
  attention: { badge: 'badge-warn', icon: 'alert' },
  broken: { badge: 'badge-failed', icon: 'cross' },
};

/**
 * `q-fix-suggestions-section` (spec §3.5 M-O8): the organisation AI page's automatic fix
 * suggestions, Enterprise only (`llm.auto-fix`), which the page shows while the feature is
 * active. Qualor posts AI fix suggestions for the new findings of each merge request without a
 * click, at or above a severity and at most so many per analysis.
 *
 * - They run only while the instance admin gives the organisation Suggest a fix. Without it the
 *   switch is disabled under what is missing and who changes it; a switch stored on says it is
 *   on but not running, and can still be switched off.
 * - The severity and the maximum hang from the switch while it is on; the projects whose admins
 *   opted out are named under them.
 * - One Save for the section (`PUT /organizations/{id}/ai/auto-fix`); its foot says the outcome.
 *   The page reads `dirty` for its leave guard, and shows `status` as the last line of its Status.
 */
@Component({
  selector: 'q-fix-suggestions-section',
  imports: [Icon, NumberField, Requirement, SectionFoot],
  templateUrl: './fix-suggestions-section.html',
  styleUrl: './fix-suggestions-section.css',
})
export class FixSuggestionsSection {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  readonly organizationId = input.required<string>();
  readonly organizationName = input.required<string>();
  /** The organisation's projects, every page of them; null until all are in (or when they failed). */
  readonly projects = input.required<readonly Project[] | null>();
  /** The organisation's assistant, whose Suggest a fix the suggestions need; null while unknown. */
  readonly orgAi = input.required<OrgAi | null>();
  /** The line of the page's Status, from what is saved; null until it is read. */
  readonly status = output<StatusLine | null>();

  protected readonly texts = {
    title: $localize`:@@orgAi.fix.title:Automatic fix suggestions`,
    label: $localize`:@@orgAi.status.fix:Fix suggestions`,
    enterprise: $localize`:@@orgAi.enterprise:Enterprise`,
    max: $localize`:@@orgAi.fix.max:At most per analysis`,
    save: $localize`:@@orgAi.fix.save:Save fix suggestions`,
  };
  private readonly states = {
    off: $localize`:@@orgAi.state.off:Off`,
    on: $localize`:@@orgAi.state.on:On`,
    notRunning: $localize`:@@orgAi.state.notRunning:Not running`,
  };
  protected readonly severities = AUTO_FIX_SEVERITIES;
  protected readonly notLicensed = autoFixNotLicensed();

  /** The settings as the server last answered: what the status says and what edits compare with. */
  protected readonly current = signal<OrgAutoFix | null>(null);
  protected readonly loadError = signal<string | null>(null);
  /** The edits: the switch, the severity and the maximum as typed. */
  protected readonly enabled = signal(false);
  protected readonly minSeverity = signal<AutoFixSeverity>('high');
  protected readonly maxPerAnalysis = signal('10');
  protected readonly maxError = signal<string | null>(null);
  private readonly busy = signal(false);
  /** Why the last save failed, in the foot; gone with the next edit. */
  private readonly saveError = signal<string | null>(null);
  private readonly savedAt = signal<Date | null>(null);
  /** Counts the organisations read: an answer for an earlier one is dropped. */
  private generation = 0;

  /**
   * The assistant does not suggest fixes for the organisation, so neither does this; false while
   * the assistant is not known (the server then decides).
   */
  protected readonly fixMissing = computed(() => {
    const assistant = this.orgAi();
    return assistant !== null && !(assistant.enabled && assistant.features.fix);
  });
  /** Stored on, while the assistant does not suggest fixes: on, but not running. */
  protected readonly notRunning = computed(
    () => this.fixMissing() && this.current()?.enabled === true,
  );
  /** Stored off, while it could not run: it cannot be switched on. */
  protected readonly needsFix = computed(
    () => this.fixMissing() && this.current()?.enabled === false,
  );
  /** Disabled until Suggest a fix is on; a switch on in the edits can always be switched off. */
  protected readonly switchDisabled = computed(() => this.needsFix() && !this.enabled());
  protected readonly needsFixText = computed(
    () =>
      $localize`:@@orgAi.fix.needsFix:Needs Suggest a fix for ${this.organizationName()}:org:, which an instance admin turns on in`,
  );
  protected readonly notRunningText = computed(
    () =>
      $localize`:@@orgAi.fix.notRunning:On, but not running: Suggest a fix is off for ${this.organizationName()}:org:. An instance admin turns it on in`,
  );
  /** The switch's help, with the daily fix budget; null while the assistant is not known. */
  protected readonly switchHelp = computed(() => {
    const budget = this.orgAi()?.budgets.fixPerDay;
    return budget === undefined
      ? null
      : $localize`:@@orgAi.fix.switchHelp:For the new findings of each merge request, within the daily fix budget (${formatWhole(budget, this.locale)}:budget:).`;
  });
  /** What the switch is read with: its help, then what keeps it from running. */
  protected readonly switchDescribedBy = computed(() => {
    const ids = [
      this.switchHelp() === null ? null : 'auto-fix-enabled-help',
      this.needsFix() ? 'auto-fix-needs-fix' : null,
      this.notRunning() ? 'auto-fix-not-running' : null,
    ].filter((id) => id !== null);
    return ids.length > 0 ? ids.join(' ') : null;
  });
  /** The severity and the maximum show while the switch is on, or while the maximum is refused. */
  protected readonly showDependents = computed(() => this.enabled() || this.maxError() !== null);
  /** The projects whose admins opted out, as a sentence; null until every project is known. */
  protected readonly optedOutText = computed(() => {
    const projects = this.projects();
    if (projects === null) return null;
    const names = projects.filter((p) => !p.autoFix.enabled).map((p) => p.name);
    if (names.length === 0) return $localize`:@@orgAi.fix.optedOutNone:No project opted out.`;
    const list = new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(names);
    return $localize`:@@orgAi.fix.optedOut:Opted out by their project admins: ${list}:names:.`;
  });

  /** The edits not saved yet: the switch, the severity and the maximum, each one change. */
  protected readonly changeCount = computed(() => {
    const settings = this.current();
    if (settings === null || !settings.available) return 0;
    return (
      Number(this.enabled() !== settings.enabled) +
      Number(this.minSeverity() !== settings.minSeverity) +
      Number(parseMaxPerAnalysis(this.maxPerAnalysis()) !== settings.maxPerAnalysis)
    );
  });
  /** Edits wait to be saved: leaving the page asks first. */
  readonly dirty = computed(() => this.changeCount() > 0);

  protected readonly footOutcome = computed<FootOutcome>(() => {
    if (this.busy()) return { kind: 'saving' };
    if (this.maxError() !== null) {
      return { kind: 'refused', fields: [{ id: MAX_INPUT, label: this.texts.max }] };
    }
    const failed = this.saveError();
    if (failed !== null) return { kind: 'error', text: failed };
    const count = this.changeCount();
    if (count > 0) return { kind: 'pending', count };
    const at = this.savedAt();
    return at === null ? { kind: 'clean' } : { kind: 'saved', at };
  });

  /** The page's Status line, from what is saved: off, on (from a severity up), or not running. */
  private readonly line = computed<StatusLine | null>(() => {
    const settings = this.current();
    if (settings === null || !settings.available) return null;
    const line = { key: 'fix', label: this.texts.label, tags: [this.texts.enterprise] };
    if (!settings.enabled) return { ...line, tone: 'off', state: this.states.off };
    if (this.fixMissing()) return { ...line, tone: 'attention', state: this.states.notRunning };
    const severity = label('severity', settings.minSeverity);
    return {
      ...line,
      tone: 'ok',
      state: this.states.on,
      text: $localize`:@@orgAi.status.fixOn:For new findings of ${severity}:severity: and above.`,
    };
  });
  /** The head's state chip: the status line's word. */
  protected readonly chip = computed(() => {
    const line = this.line();
    return line === null ? null : { ...CHIPS[line.tone], state: line.state };
  });

  constructor() {
    effect(() => this.status.emit(this.line()));
    effect(() => {
      const id = this.organizationId();
      untracked(() => {
        this.generation++;
        this.current.set(null);
        this.loadError.set(null);
        this.maxError.set(null);
        this.saveError.set(null);
        this.savedAt.set(null);
        void this.load(id, this.generation);
      });
    });
  }

  protected severityLabel(severity: AutoFixSeverity): string {
    return label('severity', severity);
  }

  protected setEnabled(event: Event): void {
    this.enabled.set(isChecked(event));
    this.saveError.set(null);
  }

  protected setMinSeverity(event: Event): void {
    const value = inputValue(event);
    if (isAutoFixSeverity(value)) this.minSeverity.set(value);
    this.saveError.set(null);
  }

  /** The maximum's text changed: a refusal of the text it had goes with it. */
  protected setMaxPerAnalysis(text: string): void {
    if (text === this.maxPerAnalysis()) return;
    this.maxPerAnalysis.set(text);
    this.maxError.set(null);
    this.saveError.set(null);
  }

  /** Save fix suggestions: the switch, the severity and the maximum, a maximum from 1 to 25. */
  protected async save(): Promise<void> {
    const id = this.organizationId();
    if (this.busy() || !this.current()?.available) return;
    const maxPerAnalysis = parseMaxPerAnalysis(this.maxPerAnalysis());
    if (maxPerAnalysis === null) {
      this.refuseMax();
      return;
    }
    const generation = this.generation;
    this.busy.set(true);
    this.saveError.set(null);
    try {
      const saved = await ok(
        this.api.client.PUT('/api/v0/organizations/{id}/ai/auto-fix', {
          params: { path: { id } },
          body: { enabled: this.enabled(), minSeverity: this.minSeverity(), maxPerAnalysis },
        }),
      );
      if (generation !== this.generation) return;
      this.show(saved);
      this.savedAt.set(new Date());
    } catch (err) {
      if (generation !== this.generation) return;
      if ('body.maxPerAnalysis' in fieldErrors(err)) {
        this.refuseMax();
        return;
      }
      this.saveError.set(autoFixRefusal(err) ?? problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Marks the maximum refused, and moves the focus to it once it has rendered. */
  private refuseMax(): void {
    this.maxError.set(maxPerAnalysisRefusal());
    afterNextRender(() => this.document.getElementById(MAX_INPUT)?.focus(), {
      injector: this.injector,
    });
  }

  private async load(id: string, generation: number): Promise<void> {
    try {
      const settings = await ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai/auto-fix', {
          params: { path: { id } },
        }),
      );
      if (generation === this.generation) this.show(settings);
    } catch (err) {
      if (generation === this.generation) this.loadError.set(problemMessage(err));
    }
  }

  /** Puts saved settings into the edits: as read, or as saved. */
  private show(settings: OrgAutoFix): void {
    this.current.set(settings);
    this.enabled.set(settings.enabled);
    this.minSeverity.set(settings.minSeverity);
    this.maxPerAnalysis.set(formatWhole(settings.maxPerAnalysis, this.locale));
    this.maxError.set(null);
  }
}
