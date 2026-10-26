import {
  afterNextRender,
  afterRenderEffect,
  Component,
  computed,
  DOCUMENT,
  effect,
  ElementRef,
  inject,
  Injector,
  LOCALE_ID,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api, ok } from '../api/api';
import { ApiError, fieldErrors, problemMessage } from '../api/errors';
import type { ItemOf } from '../api/types';
import { SessionStore } from '../auth/session';
import { OrgContext } from '../org/org-context';
import { formatDate } from '../shared/date-time.pipe';
import { closeModal, openAfterRender } from '../shared/dialog';
import { keepFocus } from '../shared/focus';
import { isChecked } from '../shared/forms';
import { Icon } from '../shared/icon';
import type { IconName } from '../shared/icons';
import { KeysetList } from '../shared/keyset';
import { LeaveConfirm } from '../shared/leave-confirm';
import { NumberField } from '../shared/number-field';
import { formatWhole } from '../shared/numbers';
import { type PickedProject, ProjectPicker } from '../shared/project-picker';
import { Requirement } from '../shared/requirement';
import { type FootOutcome, SectionFoot } from '../shared/section-foot';
import { type StatusLine, StatusList, type StatusMeter } from '../shared/status-list';
import { type LeaveGuarded, LeaveGuards, whileDirty } from '../shared/unsaved-changes';
import { SystemInfo } from '../shell/system-info';
import {
  AI_REVIEW_BUDGET_FIELDS,
  AI_REVIEW_BUDGET_INPUT,
  type AiReviewBody,
  type AiReviewBudgetErrors,
  type AiReviewBudgets,
  type AiReviewBudgetField,
  type AiReviewBudgetsDraft,
  type AiReviewProvider,
  type AiReviewScope,
  aiReviewRefusal,
  aiUnavailableText,
  budgetFieldOfPath,
  budgetNumber,
  budgetRefusal,
  budgetsDraftOf,
  changedBudgets,
  DEFAULT_AI_REVIEW_BUDGETS,
  MAX_REVIEW_TOKENS_PER_DAY,
  MAX_REVIEW_TOKENS_PER_REVIEW,
  type OrgAi,
  type OrgAiReview,
  parseBudgets,
  pickerUnavailable,
} from './ai-review';
import { AUTO_FIX_FEATURE } from './auto-fix';
import { FixSuggestionsSection } from './org-ai/fix-suggestions-section';
import { chosenState, selectionSummary, summaryText } from './org-ai/review-state';

type Project = ItemOf<'/api/v0/projects'>;
type Feature = keyof OrgAi['features'];

/**
 * What the data-sharing dialog shows: the provider and the notice of the settings as they were
 * read, which a Confirm acknowledges (R10, amended: the provider the admin was shown, not "yes").
 * `changed` marks a dialog opened again because the provider changed under it.
 */
interface Consent extends AiReviewProvider {
  notice: string;
  changed: boolean;
}

/** What sent a `PUT`: Save AI review (the section), or a switch on or off (a status action). */
type SaveOrigin = 'save' | 'switch';

/** A state chip: its badge, its icon and its word (spec §7.8). */
interface Chip {
  badge: string;
  icon: IconName;
  state: string;
}

const FEATURES: readonly Feature[] = ['explain', 'triage', 'fix'];

/**
 * Settings → AI (spec §3.5), for the organisation's admins (`org.ai.manage`), in every edition:
 * what the organisation chosen in the header does with this server's AI provider. The provider,
 * whether the organisation may use it and the assistant's features stay the instance admin's
 * (Settings → AI provider); this page shows them read-only.
 *
 * - **Status** first, computed from what is saved: AI review off, on or paused (its consent no
 *   longer covers the provider), its one action, today's use and the assistant.
 * - **AI review**: the projects to review (all, or a chosen list that says which of them can be
 *   reviewed), the budgets in a fold, and one Save for both, whether review is on or off.
 *   Switching it on sends repository code to the provider, so it is a button of the status that
 *   opens a dialog with the server's notice, word for word; Confirm saves the section's edits
 *   with `acknowledgeDataSharing: { host, model, models }`, the provider the dialog showed. A
 *   provider switched meanwhile is a 409 AI_REVIEW_PROVIDER_CHANGED, an acknowledgement the
 *   server wanted and did not get a 409 AI_REVIEW_CONSENT_REQUIRED: both read the settings again,
 *   keep the edits and ask again. Switching off asks first, and sends what is stored.
 * - **Assistant**, read-only: the features, the projects never sent, the daily limits.
 * - **Automatic fix suggestions** (`q-fix-suggestions-section`), while the Enterprise feature
 *   `llm.auto-fix` is active; without it the status ends with one line that says they are part
 *   of Qualor Enterprise.
 *
 * An index under the head leads to the sections, and an address that names one
 * (`/settings/auto-fix` leads to `#fix-suggestions`) scrolls to it once it has rendered. Without a
 * provider, or while the organisation may not use AI, the page says who changes that (and offers
 * an instance admin to set up the provider), and only switches off a review stored on. Leaving it
 * with unsaved edits in any section asks first.
 */
@Component({
  selector: 'q-ai-review-page',
  imports: [
    FixSuggestionsSection,
    Icon,
    LeaveConfirm,
    NumberField,
    ProjectPicker,
    Requirement,
    RouterLink,
    SectionFoot,
    StatusList,
  ],
  templateUrl: './ai-review.page.html',
  styleUrl: './ai-review.page.css',
})
export class AiReviewPage implements LeaveGuarded {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);
  private readonly session = inject(SessionStore);
  private readonly info = inject(SystemInfo);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly fragment = toSignal(inject(ActivatedRoute).fragment, { initialValue: null });
  protected readonly org = inject(OrgContext);

  /** The status line of the automatic fix suggestions, after the assistant's, as their section says. */
  readonly fixLine = signal<StatusLine | null>(null);

  protected readonly texts = {
    reviewTitle: $localize`:@@orgAi.review.title:AI review`,
    fixTitle: $localize`:@@orgAi.fix.title:Automatic fix suggestions`,
    save: $localize`:@@orgAi.save:Save AI review`,
    switchOff: $localize`:@@orgAi.action.switchOff:Switch off AI review`,
    addProjects: $localize`:@@orgAi.addProjects:Add projects`,
    project: $localize`:@@orgAi.col.project:Project`,
    reviewed: $localize`:@@orgAi.col.reviewed:Reviewed?`,
    budgets: $localize`:@@orgAi.budgets:Budgets`,
    tokensPerDay: $localize`:@@orgAi.tokensPerDay:Tokens per day`,
    tokensPerReview: $localize`:@@orgAi.tokensPerReview:Tokens per review`,
    perProject: $localize`:@@orgAi.perProject:Tokens per project per day`,
    costPerDay: $localize`:@@orgAi.costPerDay:Cost per day`,
    tokens: $localize`:@@numberField.tokens:tokens`,
    usd: $localize`:@@numberField.usd:US$`,
    notLinked: $localize`:@@orgAi.notLinked:Not linked to a GitLab or GitHub repository, so it is not reviewed. Link it in`,
    noPrices: $localize`:@@orgAi.noPrices:No prices are set on this server, so a cost limit would count nothing. An instance admin enters model prices in`,
  };
  private readonly states = {
    off: $localize`:@@orgAi.state.off:Off`,
    on: $localize`:@@orgAi.state.on:On`,
    paused: $localize`:@@orgAi.state.paused:Paused`,
  };
  private readonly featureNames: Record<Feature, string> = {
    explain: $localize`:@@orgAi.feature.explain:Explain`,
    triage: $localize`:@@orgAi.feature.triage:Suggest triage`,
    fix: $localize`:@@orgAi.feature.fix:Suggest a fix`,
  };
  private readonly fieldLabels: Record<AiReviewBudgetField, string> = {
    tokensPerDay: this.texts.tokensPerDay,
    maxTokensPerReview: this.texts.tokensPerReview,
    perProjectTokensPerDay: this.texts.perProject,
    costPerDayUsd: this.texts.costPerDay,
  };
  protected readonly pickerUnavailable = pickerUnavailable;

  protected readonly allowed = computed(
    () => this.org.currentId() !== null && this.org.can('org.ai.manage'),
  );
  protected readonly orgName = computed(() => this.org.current()?.name ?? '');
  /** The provider's settings for whoever can open them; for others the place is named only. */
  protected readonly providerLink = computed(() =>
    this.session.user()?.isInstanceAdmin === true ? '/settings/ai' : null,
  );
  /**
   * The automatic fix suggestions are licensed (`llm.auto-fix`): their section shows; without
   * them the status says they are Enterprise. Null while the system info is not in: neither.
   */
  protected readonly fixSuggestions = computed(() =>
    this.info.info() === null ? null : this.info.features().includes(AUTO_FIX_FEATURE),
  );
  private readonly fixSection = viewChild(FixSuggestionsSection);

  /** The settings as the server last answered: what the status says and what edits compare with. */
  protected readonly current = signal<OrgAiReview | null>(null);
  protected readonly loadError = signal<string | null>(null);
  /** The organisation's assistant, read-only here. */
  protected readonly orgAi = signal<OrgAi | null>(null);
  protected readonly orgAiError = signal<string | null>(null);
  /** The organisation's projects, every page (the chosen ones and the counts come from them). */
  protected readonly projects = new KeysetList<Project, string>((organizationId, cursor) =>
    ok(
      this.api.client.GET('/api/v0/projects', {
        params: { query: { organizationId, limit: 100, ...(cursor ? { cursor } : {}) } },
      }),
    ),
  );

  /** The AI review section's edits: its scope, its chosen projects and its budgets. */
  protected readonly scope = signal<AiReviewScope>('selected');
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly budgets = signal<AiReviewBudgetsDraft>(
    budgetsDraftOf(DEFAULT_AI_REVIEW_BUDGETS, this.locale),
  );
  /** Projects the picker added, as it read them: the list lacks one created after it loaded. */
  private readonly picked = signal<ReadonlyMap<string, PickedProject>>(new Map());
  protected readonly budgetErrors = signal<AiReviewBudgetErrors>({});
  protected readonly budgetsOpen = signal(false);

  protected readonly busy = signal(false);
  /** Why the last save failed, in the section's foot; gone with the next edit. */
  private readonly saveError = signal<string | null>(null);
  private readonly savedAt = signal<Date | null>(null);
  /**
   * A refusal said under the page's head: AI went, a switch on or off failed (Save would not try
   * it again), or the section is not there to say it.
   */
  protected readonly error = signal<string | null>(null);
  /** The data-sharing dialog's question while it is open; null while it is closed. */
  protected readonly consent = signal<Consent | null>(null);
  /** The switch-off confirmation is open. */
  private readonly switchingOff = signal(false);

  /**
   * The organisation's projects as far as the page knows them: the list, then those the picker
   * added that the list lacks. The chosen projects' states, the counts and the summaries read it.
   */
  protected readonly knownProjects = computed<readonly Project[]>(() => {
    const listed = this.projects.items();
    const ids = new Set(listed.map((p) => p.id));
    const extra = [...this.picked().values()].filter((p) => !ids.has(p.id));
    return extra.length === 0 ? listed : [...listed, ...extra];
  });
  private readonly projectsById = computed(
    () => new Map(this.knownProjects().map((p) => [p.id, p])),
  );
  /** Every page of the projects is in: what is counted from them is the whole of it. */
  protected readonly projectsReady = computed(
    () =>
      this.projects.loaded() &&
      this.projects.nextCursor() === null &&
      this.projects.error() === null,
  );
  /** The projects, for the fix suggestions to name those opted out; null until all are in. */
  protected readonly fixProjects = computed(() =>
    this.projectsReady() ? this.knownProjects() : null,
  );
  /** What the saved scope and projects give AI review; null until the projects are in. */
  private readonly storedSummary = computed(() => {
    const settings = this.current();
    return settings === null || !this.projectsReady()
      ? null
      : selectionSummary(this.knownProjects(), settings.scope, settings.projectIds);
  });
  /** What the edited scope and projects would give it, in a sentence; null until the projects are in. */
  protected readonly draftSummaryText = computed(() =>
    this.projectsReady()
      ? summaryText(
          selectionSummary(this.knownProjects(), this.scope(), this.selected()),
          this.scope(),
          this.orgName(),
          this.locale,
        )
      : null,
  );
  /** The chosen projects, in their order, with what review does with each. */
  protected readonly chosenRows = computed(() => {
    const byId = this.projectsById();
    return this.selected().map((id) => {
      const project = byId.get(id);
      return {
        id,
        name: project?.name ?? id,
        key: project?.key ?? '',
        state: project ? chosenState(project) : null,
        removeLabel: $localize`:@@orgAi.removeProject:Remove ${project?.name ?? id}:name:`,
      };
    });
  });

  /** AI review as saved: off, on, or on while its consent no longer covers the provider. */
  private readonly reviewState = computed<'off' | 'on' | 'paused'>(() => {
    const settings = this.current();
    if (!settings?.enabled) return 'off';
    return settings.consentCurrent ? 'on' : 'paused';
  });
  /** A paused review: its dialog may also switch it off instead of confirming the provider now. */
  protected readonly paused = computed(() => this.reviewState() === 'paused');
  protected readonly reviewChip = computed<Chip>(() => {
    switch (this.reviewState()) {
      case 'on':
        return { badge: 'badge-passed', icon: 'check', state: this.states.on };
      case 'paused':
        return { badge: 'badge-warn', icon: 'alert', state: this.states.paused };
      default:
        return { badge: 'badge-none', icon: 'minus', state: this.states.off };
    }
  });
  /** Every model the provider names, as the notice lists them. */
  protected readonly providerModels = computed(
    () => this.current()?.provider?.models.join(', ') ?? '',
  );

  protected readonly statusLines = computed<readonly StatusLine[]>(() => {
    const settings = this.current();
    if (settings === null) return [];
    const lines: StatusLine[] = [this.reviewLine(settings), this.todayLine(settings)];
    const assistant = this.assistantLine();
    if (assistant !== null) lines.push(assistant);
    const licensed = this.fixSuggestions();
    const fix = this.fixLine();
    if (licensed === true && fix !== null) lines.push(fix);
    if (licensed === false) {
      // One muted line, the only place the plan is named (spec §3.5).
      lines.push({
        key: 'community',
        label: '',
        tone: 'off',
        state: '',
        sub: $localize`:@@orgAi.community:Automatic fix suggestions are part of Qualor Enterprise.`,
      });
    }
    return lines;
  });

  /** The edits not saved yet: the scope, each project added or removed, each budget changed. */
  protected readonly changeCount = computed(() => {
    const settings = this.current();
    if (settings === null || !settings.available) return 0;
    const stored = new Set(settings.projectIds);
    const chosen = new Set(this.selected());
    const projects =
      [...chosen].filter((id) => !stored.has(id)).length +
      [...stored].filter((id) => !chosen.has(id)).length;
    return (
      (this.scope() === settings.scope ? 0 : 1) +
      projects +
      changedBudgets(this.budgets(), settings.budgets)
    );
  });
  /** The sections with unsaved edits, by their headings: AI review, the fix suggestions. */
  private readonly unsavedSections = computed(() => [
    ...(this.changeCount() > 0 ? [this.texts.reviewTitle] : []),
    ...(this.fixSection()?.dirty() ? [this.texts.fixTitle] : []),
  ]);
  private readonly dirty = computed(() => this.unsavedSections().length > 0);

  protected readonly footOutcome = computed<FootOutcome>(() => {
    if (this.busy()) return { kind: 'saving' };
    const errors = this.budgetErrors();
    const refused = AI_REVIEW_BUDGET_FIELDS.filter((f) => errors[f] !== undefined).map((f) => ({
      id: AI_REVIEW_BUDGET_INPUT[f],
      label: this.fieldLabels[f],
    }));
    if (refused.length > 0) return { kind: 'refused', fields: refused };
    const failed = this.saveError();
    if (failed !== null) return { kind: 'error', text: failed };
    const count = this.changeCount();
    if (count > 0) return { kind: 'pending', count };
    const at = this.savedAt();
    return at === null ? { kind: 'clean' } : { kind: 'saved', at };
  });

  /**
   * The values of the closed fold, as chips; a value other than the default is marked, and a field
   * left empty (a limit just switched on, say) says it is not set rather than show no number.
   */
  protected readonly budgetChips = computed(() => {
    const draft = this.budgets();
    const tokens = budgetNumber('tokensPerDay', draft.tokensPerDay);
    const perReview = budgetNumber('maxTokensPerReview', draft.maxTokensPerReview);
    const perProject = budgetNumber('perProjectTokensPerDay', draft.perProjectTokensPerDay);
    const cost = budgetNumber('costPerDayUsd', draft.costPerDayUsd);
    const shown = (n: number | null, typed: string) => (n === null ? typed : this.whole(n));
    const unset = (field: AiReviewBudgetField) =>
      draft[field].trim() === ''
        ? {
            text: $localize`:@@orgAi.chip.unset:${this.fieldLabels[field]}:field:: not set`,
            set: true,
          }
        : null;
    return [
      unset('tokensPerDay') ?? {
        text: $localize`:@@orgAi.chip.tokens:${shown(tokens, draft.tokensPerDay)}:n: tokens a day`,
        set: tokens !== DEFAULT_AI_REVIEW_BUDGETS.tokensPerDay,
      },
      unset('maxTokensPerReview') ?? {
        text: $localize`:@@orgAi.chip.perReview:${shown(perReview, draft.maxTokensPerReview)}:n: per review`,
        set: perReview !== DEFAULT_AI_REVIEW_BUDGETS.maxTokensPerReview,
      },
      draft.perProjectLimited
        ? (unset('perProjectTokensPerDay') ?? {
            text: $localize`:@@orgAi.chip.perProject:${shown(perProject, draft.perProjectTokensPerDay)}:n: per project a day`,
            set: true,
          })
        : { text: $localize`:@@orgAi.chip.noPerProject:No limit per project`, set: false },
      draft.costLimited
        ? (unset('costPerDayUsd') ?? {
            text: $localize`:@@orgAi.chip.cost:${cost === null ? draft.costPerDayUsd : this.usd(cost)}:amount: a day`,
            set: true,
          })
        : { text: $localize`:@@orgAi.chip.noCost:No cost limit`, set: false },
    ];
  });
  /** The instance's cap, while it is below the organisation's own daily budget, and what is left. */
  protected readonly ceilingNote = computed(() => {
    const settings = this.current();
    const ceiling = settings?.instanceCeiling.tokensPerDay ?? null;
    if (settings === null || ceiling === null) return null;
    const own =
      budgetNumber('tokensPerDay', this.budgets().tokensPerDay) ?? settings.budgets.tokensPerDay;
    return ceiling < own
      ? { ceiling: this.whole(ceiling), effective: this.whole(Math.min(own, ceiling)) }
      : null;
  });
  /** How many reviews of the most tokens one may use the day allows: the smaller budget over it. */
  protected readonly perReviewEcho = computed(() => {
    const draft = this.budgets();
    const daily = budgetNumber('tokensPerDay', draft.tokensPerDay);
    const perReview = budgetNumber('maxTokensPerReview', draft.maxTokensPerReview);
    if (
      daily === null ||
      perReview === null ||
      daily > MAX_REVIEW_TOKENS_PER_DAY ||
      perReview < 1 ||
      perReview > MAX_REVIEW_TOKENS_PER_REVIEW
    ) {
      return null;
    }
    const ceiling = this.current()?.instanceCeiling.tokensPerDay ?? null;
    const count = Math.floor((ceiling === null ? daily : Math.min(daily, ceiling)) / perReview);
    return { count, text: this.whole(count) };
  });
  /** No prices on the server: a cost limit would count nothing (`costTodayUsd` is null then). */
  protected readonly noPrices = computed(() => this.current()?.usage.costTodayUsd === null);
  /** The models the last Test found unable to call tools, which AI review needs; null if none. */
  protected readonly noToolsText = computed(() => {
    const test = this.current()?.providerTest;
    if (test?.toolCalling !== 'not_supported') return null;
    const models = new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(
      test.modelsWithoutTools,
    );
    return $localize`:@@orgAi.dialog.noTools:The last Test found that ${models}:models: cannot call tools, so reviews would fail. An instance admin can check`;
  });
  /** What the dialog's switch-on is read with: the edits it saves too, then the warning of tools. */
  protected readonly confirmDescribedBy = computed(() => {
    const ids = [
      this.changeCount() > 0 ? 'ai-review-unsaved' : null,
      this.noToolsText() === null ? null : 'ai-review-no-tools',
    ].filter((id) => id !== null);
    return ids.length > 0 ? ids.join(' ') : null;
  });

  protected readonly assistantFeatures = computed(() => {
    const assistant = this.orgAi();
    return FEATURES.map((feature) => {
      const on = assistant?.features[feature] === true;
      return {
        key: feature,
        name: this.featureNames[feature],
        chip: on
          ? { badge: 'badge-passed', icon: 'check' as IconName, state: this.states.on }
          : { badge: 'badge-none', icon: 'minus' as IconName, state: this.states.off },
      };
    });
  });
  /** The projects an instance admin excluded from AI, by name; null until the projects are in. */
  protected readonly neverSent = computed(() => {
    if (!this.projectsReady()) return null;
    const names = this.projects
      .items()
      .filter((p) => p.autoFix.excludedFromAi)
      .map((p) => p.name);
    return names.length === 0
      ? ''
      : new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(names);
  });
  protected readonly limits = computed(() => {
    const budgets = this.orgAi()?.budgets;
    return budgets === undefined
      ? null
      : {
          explain: this.whole(budgets.explainPerDay),
          triage: this.whole(budgets.triagePerDay),
          fix: this.whole(budgets.fixPerDay),
          tokens: this.whole(budgets.tokensPerDay),
          asks: this.whole(budgets.perUserPerHour),
        };
  });

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly reviewHeading = viewChild<ElementRef<HTMLElement>>('reviewHeading');
  private readonly chosenTable = viewChild<ElementRef<HTMLTableElement>>('chosenTable');
  private readonly reviewSection = viewChild<ElementRef<HTMLElement>>('reviewSection');
  private readonly consentDialog = viewChild<ElementRef<HTMLDialogElement>>('consentDialog');
  private readonly offDialog = viewChild<ElementRef<HTMLDialogElement>>('offDialog');
  private readonly leaveConfirm = viewChild.required(LeaveConfirm);
  /** Counts the organisations read: an answer for an earlier one is dropped. */
  private generation = 0;
  /** The section the address named was scrolled to, or the index was used: not again. */
  private revealed = false;

  constructor() {
    whileDirty(() => this.dirty());
    // Switching the organisation in the header replaces the edits: it asks first, as leaving does.
    inject(LeaveGuards).register(this);
    effect(() => {
      const id = this.org.currentId();
      const allowed = this.allowed();
      untracked(() => {
        this.generation++;
        // A dialog left open for the organisation we are leaving closes with nothing sent.
        this.consent.set(null);
        this.switchingOff.set(false);
        this.closeDialogs();
        this.current.set(null);
        this.loadError.set(null);
        this.orgAi.set(null);
        this.orgAiError.set(null);
        this.error.set(null);
        this.saveError.set(null);
        this.savedAt.set(null);
        this.budgetErrors.set({});
        this.budgetsOpen.set(false);
        this.picked.set(new Map());
        this.projects.clear();
        this.fixLine.set(null);
        if (allowed && id) {
          void this.load(id, this.generation);
          void this.loadAssistant(id, this.generation);
          void this.loadProjects(id, this.generation);
        }
      });
    });
    // An address that names a section: scroll to it once it has rendered (the fix suggestions
    // wait for the system info too).
    afterRenderEffect(() => {
      const fragment = this.fragment();
      if (this.revealed || fragment === null || this.current() === null) return;
      this.fixSuggestions();
      if (this.reveal(fragment)) this.revealed = true;
    });
  }

  /** Leaving with unsaved edits asks first (the route's `canDeactivate`), naming their sections. */
  canLeave(): boolean | Promise<boolean> {
    const sections = this.unsavedSections();
    return sections.length > 0 ? this.leaveConfirm().ask(sections) : true;
  }

  /** An index link: keeps the section in the address, scrolls to it and focuses its heading. */
  protected go(id: string, event: Event): void {
    event.preventDefault();
    this.revealed = true;
    void this.router.navigate([], { fragment: id, replaceUrl: true });
    this.reveal(id);
  }

  /** Scrolls to the page's section `id` and focuses its heading; false while it is not there. */
  private reveal(id: string): boolean {
    // By id, not by a selector: the address may hold any text.
    const section = this.document.getElementById(id);
    if (section?.tagName !== 'SECTION' || !this.host.nativeElement.contains(section)) return false;
    section.scrollIntoView();
    section.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
    return true;
  }

  /** The status line's action: switch on, confirm again (both the dialog), or switch off. */
  protected onAct(id: string): void {
    if (this.busy()) return;
    if (id === 'switch-off') this.askSwitchOff();
    else if (id === 'switch-on' || id === 'confirm') this.askConsent(false);
  }

  protected setScope(scope: AiReviewScope): void {
    this.scope.set(scope);
    this.edited(null);
  }

  /** Removes a chosen project; the focus goes to the row that takes its place, or the next one. */
  protected remove(projectId: string, index: number): void {
    this.selected.update((ids) => ids.filter((id) => id !== projectId));
    this.edited(null);
    const removeButton = (at: number) =>
      this.chosenTable()?.nativeElement.querySelectorAll('tbody tr')[at]?.querySelector('button');
    keepFocus(
      this.injector,
      this.document,
      () => removeButton(index),
      () => removeButton(index - 1),
      () => this.reviewSection()?.nativeElement.querySelector('q-project-picker button'),
    );
  }

  protected addProjects(picked: PickedProject[]): void {
    const chosen = new Set(this.selected());
    const fresh = picked.filter((p) => !chosen.has(p.id));
    this.picked.update((known) => new Map([...known, ...fresh.map((p) => [p.id, p] as const)]));
    this.selected.update((ids) => [...ids, ...fresh.map((p) => p.id)]);
    this.edited(null);
  }

  /** A budget's text changed; digits the field only grouped again keep its refusal. */
  protected setBudget(field: AiReviewBudgetField, text: string): void {
    const before = this.budgets()[field];
    this.budgets.update((draft) => ({ ...draft, [field]: text }));
    const regrouped =
      budgetNumber(field, before) !== null &&
      budgetNumber(field, before) === budgetNumber(field, text);
    if (before !== text && !regrouped) this.edited(field);
  }

  protected setPerProjectLimited(event: Event): void {
    const on = isChecked(event);
    this.budgets.update((draft) => ({ ...draft, perProjectLimited: on }));
    this.edited('perProjectTokensPerDay');
  }

  protected setCostLimited(event: Event): void {
    const on = isChecked(event);
    this.budgets.update((draft) => ({ ...draft, costLimited: on }));
    this.edited('costPerDayUsd');
  }

  protected onBudgetsToggle(event: Event): void {
    this.budgetsOpen.set((event.target as HTMLDetailsElement).open);
  }

  /** The ids the input of a budget points at: its refusal, then what it is told about. */
  protected describedBy(field: AiReviewBudgetField): string | null {
    const ids = [
      this.budgetErrors()[field] !== undefined ? `${AI_REVIEW_BUDGET_INPUT[field]}-error` : null,
    ];
    if (field === 'tokensPerDay' && this.ceilingNote() !== null) ids.push('ai-review-ceiling');
    if (field === 'maxTokensPerReview') {
      if (this.perReviewEcho() !== null) ids.push('ai-review-max-per-review-echo');
      ids.push('ai-review-max-per-review-hint');
    }
    // The currency before the digits is read with the field.
    if (field === 'costPerDayUsd') ids.push('ai-review-cost-prefix');
    const named = ids.filter((id) => id !== null);
    return named.length > 0 ? named.join(' ') : null;
  }

  /** Save AI review: the section's edits, the switch as stored. */
  protected async saveReview(): Promise<void> {
    const settings = this.current();
    if (this.busy() || settings === null || !settings.available) return;
    // A review whose consent no longer covers the provider needs it again: the server would
    // refuse the save, so the dialog asks for it instead, once the budgets can be sent.
    if (settings.enabled && !settings.consentCurrent) {
      if (this.sendableBudgets() !== null) this.askConsent(false);
      return;
    }
    await this.put(settings.enabled, null, 'save');
  }

  /** Confirm: acknowledges the provider the dialog showed, and saves the section with it. */
  protected async confirmConsent(): Promise<void> {
    const asked = this.consent();
    if (!asked || this.busy()) return;
    // Cleared first: the dialog's close event then finds nothing to cancel.
    this.consent.set(null);
    closeDialog(this.consentDialog());
    await this.put(true, { host: asked.host, model: asked.model, models: asked.models }, 'switch');
  }

  /** Cancel, Escape or the dialog closing otherwise: nothing is sent. */
  protected cancelConsent(): void {
    this.consent.set(null);
    closeDialog(this.consentDialog());
  }

  protected askSwitchOff(): void {
    if (this.busy() || this.current() === null) return;
    this.switchingOff.set(true);
    openAfterRender(
      this.injector,
      () => this.offDialog()?.nativeElement,
      () => this.switchingOff(),
    );
  }

  protected cancelSwitchOff(): void {
    this.switchingOff.set(false);
    closeDialog(this.offDialog());
  }

  protected async confirmSwitchOff(): Promise<void> {
    if (!this.switchingOff() || this.busy()) return;
    this.switchingOff.set(false);
    closeDialog(this.offDialog());
    await this.switchOff();
  }

  /** The paused review's other way out of its dialog: off, with nothing acknowledged. */
  protected async switchOffPaused(): Promise<void> {
    if (!this.consent() || this.busy()) return;
    // Cleared first: the dialog's close event then finds nothing to cancel.
    this.consent.set(null);
    closeDialog(this.consentDialog());
    await this.switchOff();
  }

  /** Switches review off: the stored scope, projects and budgets with the switch off; the edits stay. */
  private async switchOff(): Promise<void> {
    const settings = this.current();
    const id = this.org.currentId();
    if (settings === null || !id) return;
    await this.send(
      id,
      {
        enabled: false,
        scope: settings.scope,
        projectIds: [...settings.projectIds],
        budgets: { ...settings.budgets },
      },
      false,
      'switch',
    );
  }

  /**
   * Opens the dialog with the provider and notice of the settings as read, unless the section
   * could not be sent with it: refused budgets are shown first. A paused review's dialog opens
   * whatever the budgets hold: its Switch off sends only what is stored, and Confirm checks them.
   */
  private askConsent(changed: boolean): void {
    const settings = this.current();
    if (
      settings === null ||
      !settings.available ||
      settings.provider === null ||
      settings.notice === null
    ) {
      return;
    }
    const paused = settings.enabled && !settings.consentCurrent;
    if (!paused && this.sendableBudgets() === null) return;
    this.consent.set({
      host: settings.provider.host,
      model: settings.provider.model,
      models: settings.provider.models,
      notice: settings.notice,
      changed,
    });
    openAfterRender(
      this.injector,
      () => this.consentDialog()?.nativeElement,
      () => this.consent() !== null,
    );
  }

  /** The section's `PUT`; `acknowledged` is the provider of the dialog that was just confirmed. */
  private async put(
    enabled: boolean,
    acknowledged: AiReviewProvider | null,
    origin: SaveOrigin,
  ): Promise<void> {
    const id = this.org.currentId();
    if (!id) return;
    const budgets = this.sendableBudgets();
    if (budgets === null) return;
    await this.send(
      id,
      {
        enabled,
        scope: this.scope(),
        projectIds: [...this.selected()],
        budgets,
        ...(acknowledged
          ? {
              acknowledgeDataSharing: {
                host: acknowledged.host,
                model: acknowledged.model,
                models: acknowledged.models,
              },
            }
          : {}),
      },
      true,
      origin,
    );
  }

  /**
   * Sends a `PUT`; the answer is the new saved copy, and the edits too when they were sent.
   * `origin` says where a refusal is told: Save AI review's foot, or the page's head for a switch.
   */
  private async send(
    id: string,
    body: AiReviewBody,
    edits: boolean,
    origin: SaveOrigin,
  ): Promise<void> {
    const generation = this.generation;
    this.busy.set(true);
    this.error.set(null);
    this.saveError.set(null);
    try {
      const saved = await ok(
        this.api.client.PUT('/api/v0/organizations/{id}/ai/review', {
          params: { path: { id } },
          body,
        }),
      );
      if (generation !== this.generation) return;
      this.current.set(saved);
      if (edits) this.showEdits(saved);
      this.savedAt.set(new Date());
      // A button that went with the save (the stopped review's) leaves the focus in the page.
      keepFocus(
        this.injector,
        this.document,
        () => this.reviewHeading()?.nativeElement,
        () => this.heading().nativeElement,
      );
    } catch (err) {
      if (generation !== this.generation) return;
      await this.refused(err, id, generation, origin);
    } finally {
      this.busy.set(false);
    }
  }

  /** What a refused `PUT` does: asks again, names the budget, or says why in the page's words. */
  private async refused(
    err: unknown,
    id: string,
    generation: number,
    origin: SaveOrigin,
  ): Promise<void> {
    if (err instanceof ApiError && err.status === 409) {
      if (err.code === 'AI_REVIEW_CONSENT_REQUIRED' || err.code === 'AI_REVIEW_PROVIDER_CHANGED') {
        // The settings are read again (the edits are kept), and the dialog shows the provider now.
        const fresh = await this.reread(id, generation);
        if (generation !== this.generation) return;
        if (fresh?.available && fresh.provider) {
          this.askConsent(err.code === 'AI_REVIEW_PROVIDER_CHANGED');
          return;
        }
        // The dialog stays closed, and the page says why: AI went meanwhile, or the read failed
        // (which `reread` said).
        if (fresh !== null) this.error.set(aiUnavailableText());
        this.heading().nativeElement.focus();
        return;
      }
      if (err.code === 'AI_DISABLED') {
        await this.reread(id, generation);
        if (generation !== this.generation) return;
        this.error.set(aiReviewRefusal(err));
        this.heading().nativeElement.focus();
        return;
      }
    }
    const refusedBudgets: AiReviewBudgetErrors = {};
    for (const path of Object.keys(fieldErrors(err))) {
      const field = budgetFieldOfPath(path);
      if (field !== null) refusedBudgets[field] = budgetRefusal(field);
    }
    if (Object.keys(refusedBudgets).length > 0) {
      this.refuse(refusedBudgets);
      return;
    }
    const message = aiReviewRefusal(err) ?? problemMessage(err);
    // Beside Save only what Save would try again; a switch, or a section no longer shown, says it
    // under the page's head.
    if (origin === 'save' && this.current()?.available) {
      this.saveError.set(message);
    } else {
      this.error.set(message);
      this.heading().nativeElement.focus();
    }
  }

  /**
   * The budgets as they would be sent, and no refusal left on them; null when a field cannot be
   * sent, which is then shown refused.
   */
  private sendableBudgets(): AiReviewBudgets | null {
    const parsed = parseBudgets(this.budgets());
    if ('errors' in parsed) {
      this.refuse(parsed.errors);
      return null;
    }
    this.budgetErrors.set({});
    return parsed.budgets;
  }

  /** Shows refused budgets: the fold opens on them, and the first takes the focus. */
  private refuse(errors: AiReviewBudgetErrors): void {
    this.budgetErrors.set(errors);
    this.budgetsOpen.set(true);
    const first = AI_REVIEW_BUDGET_FIELDS.find((field) => errors[field] !== undefined);
    if (first === undefined) return;
    afterNextRender(() => this.document.getElementById(AI_REVIEW_BUDGET_INPUT[first])?.focus(), {
      injector: this.injector,
    });
  }

  /** An edit: the last save's outcome is old news, and so is a refusal of the field edited. */
  private edited(field: AiReviewBudgetField | null): void {
    this.saveError.set(null);
    if (field !== null && this.budgetErrors()[field] !== undefined) {
      this.budgetErrors.update((all) =>
        Object.fromEntries(Object.entries(all).filter(([key]) => key !== field)),
      );
    }
  }

  private async load(id: string, generation: number): Promise<void> {
    try {
      const settings = await ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai/review', {
          params: { path: { id } },
        }),
      );
      if (generation !== this.generation) return;
      this.current.set(settings);
      this.showEdits(settings);
    } catch (err) {
      if (generation === this.generation) this.loadError.set(problemMessage(err));
    }
  }

  private async loadAssistant(id: string, generation: number): Promise<void> {
    try {
      const assistant = await ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai', { params: { path: { id } } }),
      );
      if (generation === this.generation) this.orgAi.set(assistant);
    } catch (err) {
      if (generation === this.generation) this.orgAiError.set(problemMessage(err));
    }
  }

  /** Reads the settings again and keeps the edits; null when the read failed or the page moved on. */
  private async reread(id: string, generation: number): Promise<OrgAiReview | null> {
    try {
      const fresh = await ok(
        this.api.client.GET('/api/v0/organizations/{id}/ai/review', {
          params: { path: { id } },
        }),
      );
      if (generation !== this.generation) return null;
      this.current.set(fresh);
      return fresh;
    } catch (err) {
      if (generation === this.generation) this.error.set(problemMessage(err));
      return null;
    }
  }

  private async loadProjects(organizationId: string, generation: number): Promise<void> {
    await this.projects.reset(organizationId);
    await this.projects.loadRest(() => generation === this.generation);
  }

  /** Puts saved settings into the section's edits: as read, or as saved. */
  private showEdits(settings: OrgAiReview): void {
    this.scope.set(settings.scope);
    this.selected.set([...settings.projectIds]);
    this.budgets.set(budgetsDraftOf(settings.budgets, this.locale));
    this.budgetErrors.set({});
  }

  private reviewLine(settings: OrgAiReview): StatusLine {
    const label = $localize`:@@orgAi.status.review:AI review`;
    const summary = this.storedSummary();
    switch (this.reviewState()) {
      case 'off':
        return {
          key: 'review',
          label,
          tone: 'off',
          state: this.states.off,
          sub:
            summary === null
              ? null
              : summaryText(summary, settings.scope, this.orgName(), this.locale),
          action: {
            id: 'switch-on',
            label: $localize`:@@orgAi.action.switchOn:Switch on AI review…`,
            primary: true,
          },
        };
      case 'on':
        return {
          key: 'review',
          label,
          tone: 'ok',
          state: this.states.on,
          text: summary === null ? null : this.reviewingText(summary.reviewable),
          sub: this.confirmedText(settings),
          action: { id: 'switch-off', label: this.texts.switchOff },
        };
      case 'paused':
        return {
          key: 'review',
          label,
          tone: 'attention',
          state: this.states.paused,
          text: $localize`:@@orgAi.status.changed:The AI provider changed`,
          sub: this.pausedText(settings),
          action: {
            id: 'confirm',
            label: $localize`:@@orgAi.action.confirm:Review and confirm…`,
            primary: true,
          },
        };
    }
  }

  private reviewingText(count: number): string {
    return count === 1
      ? $localize`:@@orgAi.status.reviewingOne:Reviewing 1 project`
      : $localize`:@@orgAi.status.reviewing:Reviewing ${this.whole(count)}:count: projects`;
  }

  /** Who confirmed the notice, when, and for which host and model ("by you" for the viewer). */
  private confirmedText(settings: OrgAiReview): string | null {
    const consent = settings.consent;
    if (consent === null) return null;
    const date = formatDate(consent.at, this.locale);
    const host = consent.providerHost;
    const model = consent.model;
    return consent.userId === this.session.user()?.id
      ? $localize`:@@orgAi.status.confirmedByYou:Confirmed on ${date}:date: (by you) for ${host}:host: (${model}:model:).`
      : $localize`:@@orgAi.status.confirmed:Confirmed on ${date}:date: for ${host}:host: (${model}:model:).`;
  }

  /**
   * What was confirmed and what the provider is now. The answer leaves out the consent's set of
   * models (review.md §2.5), so the confirmed side names the standard model alone.
   */
  private pausedText(settings: OrgAiReview): string | null {
    const consent = settings.consent;
    const provider = settings.provider;
    if (consent === null || provider === null) return null;
    const oldHost = consent.providerHost;
    const oldModel = consent.model;
    const date = formatDate(consent.at, this.locale);
    const host = provider.host;
    const models = provider.models.join(', ');
    return $localize`:@@orgAi.status.pausedSub:You confirmed ${oldHost}:oldHost: (${oldModel}:oldModel:) on ${date}:date:. It now uses ${host}:host: (${models}:models:). No merge request is reviewed until you confirm.`;
  }

  /** Today's use: AI review against the smaller of its budget and the cap, then the assistant. */
  private todayLine(settings: OrgAiReview): StatusLine {
    const { tokensToday, reviewsToday, costTodayUsd } = settings.usage;
    const ceiling = settings.instanceCeiling.tokensPerDay;
    const reviews =
      reviewsToday === 1
        ? $localize`:@@orgAi.today.reviewsOne:1 review`
        : $localize`:@@orgAi.today.reviews:${this.whole(reviewsToday)}:count: reviews`;
    const meters: StatusMeter[] = [
      {
        label: $localize`:@@orgAi.today.review:AI review`,
        value: tokensToday,
        max:
          ceiling === null
            ? settings.budgets.tokensPerDay
            : Math.min(settings.budgets.tokensPerDay, ceiling),
        note:
          costTodayUsd === null
            ? reviews
            : $localize`:@@orgAi.today.reviewsCost:${reviews}:reviews: · ${this.usd(costTodayUsd)}:cost:`,
      },
    ];
    const assistant = this.orgAi();
    if (assistant !== null) {
      const { explain, triage, fix, tokens } = assistant.usage;
      meters.push({
        label: $localize`:@@orgAi.today.assistant:Assistant`,
        value: tokens,
        max: assistant.budgets.tokensPerDay,
        note: $localize`:@@orgAi.today.assistantNote:Explanations ${this.whole(explain)}:explain: · Triage ${this.whole(triage)}:triage: · Fixes ${this.whole(fix)}:fix:`,
      });
    }
    return {
      key: 'today',
      label: $localize`:@@orgAi.status.today:Today`,
      tone: 'off',
      state: '',
      meters,
    };
  }

  /** The assistant's features as the instance admin chose them: on if any is. */
  private assistantLine(): StatusLine | null {
    const assistant = this.orgAi();
    if (assistant === null) return null;
    const list = (features: readonly Feature[]) =>
      new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(
        features.map((f) => this.featureNames[f]),
      );
    const on = FEATURES.filter((f) => assistant.features[f]);
    const off = FEATURES.filter((f) => !assistant.features[f]);
    let text: string;
    if (off.length === 0) text = $localize`:@@orgAi.assistant.allOn:${list(on)}:on: on.`;
    else if (on.length === 0) text = $localize`:@@orgAi.assistant.allOff:${list(off)}:off: off.`;
    else text = $localize`:@@orgAi.assistant.features:${list(on)}:on: on, ${list(off)}:off: off.`;
    return {
      key: 'assistant',
      label: $localize`:@@orgAi.status.assistant:Assistant`,
      tone: on.length > 0 ? 'ok' : 'off',
      state: on.length > 0 ? this.states.on : this.states.off,
      text,
      sub: $localize`:@@orgAi.assistant.who:An instance admin chooses them.`,
    };
  }

  private closeDialogs(): void {
    closeDialog(this.consentDialog());
    closeDialog(this.offDialog());
  }

  private whole(n: number): string {
    return formatWhole(n, this.locale);
  }

  private usd(amount: number): string {
    return new Intl.NumberFormat(this.locale, { style: 'currency', currency: 'USD' }).format(
      amount,
    );
  }
}

function closeDialog(ref: ElementRef<HTMLDialogElement> | undefined): void {
  const dialog = ref?.nativeElement;
  if (dialog?.open) closeModal(dialog);
}
