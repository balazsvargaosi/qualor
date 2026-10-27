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
} from '@angular/core';
import { Router } from '@angular/router';
import { Api, ok } from '../../api/api';
import { problemMessage } from '../../api/errors';
import type { ItemOf, Organization, ResponseBody } from '../../api/types';
import { OrgContext } from '../../org/org-context';
import { keepFocus } from '../../shared/focus';
import { inputValue, isChecked } from '../../shared/forms';
import { Icon } from '../../shared/icon';
import { formatWhole } from '../../shared/numbers';
import { type PickedProject, ProjectPicker } from '../../shared/project-picker';
import { Requirement } from '../../shared/requirement';
import { type FootOutcome, SectionFoot } from '../../shared/section-foot';
import { TONE_CHIPS } from '../../shared/status-list';

type LlmSettings = ResponseBody<'/api/v0/system/llm', 'get'>;
type StoredOrg = LlmSettings['organizations'][string];
type Project = ItemOf<'/api/v0/projects'>;

/**
 * What the instance admin sets for an organisation: whether it may use AI, its assistant
 * features, and the projects never sent to the provider. Its admins' own switches (AI review,
 * automatic fix suggestions) are theirs, so a save never carries them.
 */
export interface OrgEntry {
  enabled: boolean;
  features: { explain: boolean; triage: boolean; fix: boolean };
  excludedProjectIds: string[];
}
/** Stores one organisation's entry; rejects with the server's refusal (`ApiError`). */
export type SaveEntry = (organizationId: string, entry: OrgEntry) => Promise<void>;

type Feature = keyof OrgEntry['features'];
const FEATURES: readonly Feature[] = ['explain', 'triage', 'fix'];

/** The rows shown at first, and how many more each "Show more" adds. */
const PAGE = 25;
/** The projects of an organisation read for the names of those never sent: pages, and their size. */
const PROJECT_PAGES = 20;
const PROJECT_PAGE_SIZE = 100;

/** An organisation the settings do not hold: not allowed, nothing on. */
const NOT_SET: OrgEntry = {
  enabled: false,
  features: { explain: false, triage: false, fix: false },
  excludedProjectIds: [],
};

/** The open editor: its organisation, what its draft compares with, and the draft. */
interface Editor {
  id: string;
  /** The stored entry; once a save succeeds, the entry it sent (what the server now holds). */
  base: OrgEntry;
  draft: OrgEntry;
}

/** An organisation's row: what is stored for it, in words. */
interface Row {
  org: Organization;
  allowed: boolean;
  /** The names of the features on. */
  features: string[];
  excluded: number;
  excludedText: string;
  /** What its admins switched on, while it is allowed. */
  admins: string[];
  editing: boolean;
  openLabel: string;
}

/**
 * `q-ai-organizations-section` (spec §3.4 M-I5, §7.3 rows 8–10, §7.4): the instance's AI provider
 * page's organisations, for instance admins. A table of every organisation the page read, sorted
 * by name, 25 rows at first and a filter by name or key: whether it may use AI, the assistant
 * features on, how many projects are never sent, and what its admins switched on (read-only).
 *
 * - **Edit** opens the row's editor under it, one at a time: "Allow AI" with the three features
 *   and the projects never sent hanging from it. Its own foot saves the entry (`saveEntry`); an
 *   edit made while the save is on its way stays, unsaved.
 * - The names of the projects never sent are read from the organisation's list when the editor
 *   opens (never every project of the instance); "Add a project" searches the server.
 * - **Open** switches the header's organisation, asking the pages with unsaved changes first, and
 *   goes to its AI page.
 *
 * The page reads `dirty` and `dirtyLabel` for its leave guard.
 */
@Component({
  selector: 'q-ai-organizations-section',
  imports: [Icon, ProjectPicker, Requirement, SectionFoot],
  templateUrl: './organizations-section.html',
  styleUrl: './organizations-section.css',
})
export class OrganizationsSection {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly org = inject(OrgContext);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly locale = inject(LOCALE_ID);
  /** Names as people sort them: "Org 2" before "Org 10". */
  private readonly collator = new Intl.Collator(this.locale, { numeric: true });

  /** The settings as the server last answered (`reviewStatus` per organisation). */
  readonly settings = input.required<LlmSettings>();
  /** Every organisation the page read. */
  readonly organizations = input.required<readonly Organization[]>();
  /** The automatic fix suggestions are licensed (`llm.auto-fix`). */
  readonly autoFixAvailable = input.required<boolean>();
  readonly saveEntry = input.required<SaveEntry>();
  /** The section's name, for the question asked before leaving it with unsaved changes. */
  readonly dirtyLabel = $localize`:@@aiProvider.orgs.title:Organizations`;

  protected readonly texts = {
    title: this.dirtyLabel,
    filter: $localize`:@@aiProvider.orgs.filter:Filter organizations`,
    org: $localize`:@@aiProvider.orgs.col.org:Organization`,
    ai: $localize`:@@aiProvider.orgs.col.ai:AI`,
    features: $localize`:@@aiProvider.orgs.col.features:Assistant features`,
    neverSent: $localize`:@@aiProvider.orgs.col.neverSent:Never sent`,
    admins: $localize`:@@aiProvider.orgs.col.admins:Switched on by its admins`,
    actions: $localize`:@@aiProvider.orgs.col.actions:Actions`,
    edit: $localize`:@@aiProvider.orgs.edit:Edit`,
    close: $localize`:@@aiProvider.orgs.close:Close`,
    open: $localize`:@@aiProvider.orgs.open:Open`,
    editorFeatures: $localize`:@@aiProvider.orgs.features:Assistant features`,
    editorNeverSent: $localize`:@@aiProvider.orgs.neverSent:Never sent to the provider`,
    add: $localize`:@@aiProvider.orgs.add:Add a project`,
    remove: $localize`:@@aiProvider.orgs.remove:Remove`,
    cancel: $localize`:@@aiProvider.orgs.cancel:Cancel`,
  };
  private readonly switchTexts = {
    review: $localize`:@@aiProvider.orgs.review:AI review`,
    reviewPaused: $localize`:@@aiProvider.orgs.reviewPaused:AI review (paused)`,
    fix: $localize`:@@aiProvider.orgs.fix:Fix suggestions`,
    fixNotRunning: $localize`:@@aiProvider.orgs.fixNotRunning:Fix suggestions (not running)`,
  };
  private readonly featureTexts: Record<Feature, { name: string; help: string }> = {
    explain: {
      name: $localize`:@@orgAi.feature.explain:Explain`,
      help: $localize`:@@aiProvider.orgs.explainHelp:What the rule checks, why this code triggers it, and how to fix it.`,
    },
    triage: {
      name: $localize`:@@orgAi.feature.triage:Suggest triage`,
      help: $localize`:@@aiProvider.orgs.triageHelp:Whether the finding looks like a false positive. A person decides.`,
    },
    fix: {
      name: $localize`:@@orgAi.feature.fix:Suggest a fix`,
      help: $localize`:@@aiProvider.orgs.fixHelp:A replacement for the flagged lines, which a person may post to the merge request.`,
    },
  };

  protected readonly filter = signal('');
  /** How many of the organisations found are shown. */
  private readonly limit = signal(PAGE);
  private readonly editor = signal<Editor | null>(null);
  private readonly editingId = computed(() => this.editor()?.id ?? null);
  /** The section's polite status: an organisation saved, or why Edit did not open another. */
  protected readonly status = signal('');
  private readonly saving = signal(false);
  /** Why the open editor's last save failed, in its foot; gone with the next edit. */
  private readonly saveError = signal<string | null>(null);
  /** The projects the open editor can name: read from its organisation's list, or picked. */
  private readonly known = signal<ReadonlyMap<string, Project>>(new Map());
  /** The names are being read. */
  protected readonly looking = signal(false);
  protected readonly lookupError = signal<string | null>(null);
  /** Counts the editors opened and closed: what was asked for an earlier one is dropped. */
  private generation = 0;

  /** The head's chip: how many of the organisations may use AI. */
  protected readonly chip = computed(() => {
    const stored = this.settings().organizations;
    const all = this.organizations();
    const allowed = all.filter((o) => stored[o.id]?.enabled === true).length;
    return {
      ...TONE_CHIPS[allowed > 0 ? 'ok' : 'off'],
      text: $localize`:@@aiProvider.orgs.chip:${formatWhole(allowed, this.locale)}:allowed: of ${formatWhole(all.length, this.locale)}:total: allowed`,
    };
  });

  private readonly sorted = computed(() =>
    [...this.organizations()].sort(
      (a, b) => this.collator.compare(a.name, b.name) || this.collator.compare(a.key, b.key),
    ),
  );
  /** The organisations the filter finds, by name or key in any case. */
  private readonly matching = computed(() => {
    const query = this.filter().trim().toLocaleLowerCase(this.locale);
    if (query === '') return this.sorted();
    return this.sorted().filter(
      (o) =>
        o.name.toLocaleLowerCase(this.locale).includes(query) ||
        o.key.toLocaleLowerCase(this.locale).includes(query),
    );
  });
  /** How many of those found are shown: the first so many. */
  private readonly shownCount = computed(() => Math.min(this.limit(), this.matching().length));
  /**
   * The rows shown: the first so many found, and the one being edited wherever it is, so neither
   * a filter nor the page hides an editor. That one is held in view, not found: it is not counted.
   */
  protected readonly rows = computed<Row[]>(() => {
    const shown = new Set(
      this.matching()
        .slice(0, this.shownCount())
        .map((o) => o.id),
    );
    const editing = this.editingId();
    const settings = this.settings();
    const autoFix = this.autoFixAvailable();
    return this.sorted()
      .filter((o) => shown.has(o.id) || o.id === editing)
      .map((o) => this.rowOf(o, settings, autoFix, o.id === editing));
  });
  /**
   * "{shown} of {total} organizations", or that the filter finds none. It counts what the filter
   * and the page show, never the row held for its editor: closing it changes no count, so this
   * line never speaks over the status.
   */
  protected readonly countText = computed(() => {
    const total = this.matching().length;
    if (total === 0) {
      return this.filter().trim() === ''
        ? ''
        : $localize`:@@aiProvider.orgs.noMatch:No organization matches.`;
    }
    const shown = formatWhole(this.shownCount(), this.locale);
    return $localize`:@@aiProvider.orgs.count:${shown}:shown: of ${formatWhole(total, this.locale)}:total: organizations`;
  });
  /** "Show 25 more", or fewer for the last ones; null when every one found is shown. */
  protected readonly moreText = computed(() => {
    const n = Math.min(PAGE, this.matching().length - this.shownCount());
    return n > 0
      ? $localize`:@@aiProvider.orgs.more:Show ${formatWhole(n, this.locale)}:n: more`
      : null;
  });

  /** The open editor's changes: each switch, and each project added to or taken from the list. */
  private readonly changeCount = computed(() => {
    const editor = this.editor();
    return editor === null ? 0 : changes(editor.draft, editor.base);
  });
  /** The open editor has unsaved changes: leaving the page asks first. */
  readonly dirty = computed(() => this.changeCount() > 0);

  protected readonly footOutcome = computed<FootOutcome>(() => {
    if (this.saving()) return { kind: 'saving' };
    const failed = this.saveError();
    if (failed !== null) return { kind: 'error', text: failed };
    const count = this.changeCount();
    return count > 0 ? { kind: 'pending', count } : { kind: 'clean' };
  });

  /** The open editor in words: its organisation's texts, the draft, and the notes it needs. */
  protected readonly view = computed(() => {
    const editor = this.editor();
    const org = this.organizations().find((o) => o.id === editor?.id);
    if (editor === null || org === undefined) return null;
    const { id, draft, base } = editor;
    const name = org.name;
    const stored = this.settings().organizations[id];
    const prefix = `org-${id}`;
    // A note under a switch says what switching it off stops; each stands only for a change.
    const allowNote =
      stored?.enabled === true && !draft.enabled && stored.reviewStatus.enabled
        ? $localize`:@@aiProvider.orgs.allowNote:AI review is on in ${name}:org:: it stops, and its repository copies are deleted, when you save.`
        : null;
    const fixNote =
      this.autoFixAvailable() &&
      stored?.autoFix.enabled === true &&
      stored.features.fix &&
      !draft.features.fix
        ? $localize`:@@aiProvider.orgs.fixNote:${name}:org:'s automatic fix suggestions stop without it.`
        : null;
    const known = this.known();
    // A project the names did not include: not listed, when they were all read; else not known.
    const unlisted = this.lookupError() === null;
    return {
      id,
      enabled: draft.enabled,
      enabledChanged: draft.enabled !== base.enabled,
      allowId: `${prefix}-allow`,
      allowDescribedBy: describedBy(`${prefix}-allow`, allowNote),
      allowNote,
      label: $localize`:@@aiProvider.orgs.editor:Edit ${name}:org:`,
      allow: $localize`:@@aiProvider.orgs.allow:Allow AI in ${name}:org:`,
      allowHelp: $localize`:@@aiProvider.orgs.allowHelp:People in ${name}:org: can use the features below, and ${name}:org:'s admins can switch on AI review, which sends repository code, and automatic fix suggestions.`,
      off: $localize`:@@aiProvider.orgs.off:${name}:org: sends nothing to the provider.`,
      save: $localize`:@@aiProvider.orgs.save:Save ${name}:org:`,
      features: FEATURES.map((feature) => {
        const inputId = `${prefix}-${feature}`;
        const note = feature === 'fix' ? fixNote : null;
        return {
          feature,
          inputId,
          ...this.featureTexts[feature],
          on: draft.features[feature],
          changed: draft.features[feature] !== base.features[feature],
          note,
          describedBy: describedBy(inputId, note),
        };
      }),
      excludedIds: draft.excludedProjectIds,
      excluded: draft.excludedProjectIds.map((projectId) => {
        const project = known.get(projectId);
        const projectName =
          project?.name ??
          (unlisted
            ? $localize`:@@ai.settings.orgExcludedUnlisted:A project not listed here (${projectId}:INTERPOLATION:)`
            : null);
        return {
          id: projectId,
          /** Null while the names could not be read: the id alone stands for it. */
          name: projectName,
          key: project?.key ?? null,
          removeLabel: $localize`:@@aiProvider.orgs.removeLabel:Remove ${projectName ?? projectId}:name:`,
        };
      }),
    };
  });

  constructor() {
    // New settings (a save of this or another section): an editor without changes shows them;
    // one with changes keeps its draft, which now compares with them.
    effect(() => {
      const settings = this.settings();
      untracked(() => {
        const editor = this.editor();
        if (editor === null) return;
        const stored = entryOf(settings, editor.id);
        if (changes(stored, editor.base) === 0) return;
        const draft = changes(editor.draft, editor.base) === 0 ? copyOf(stored) : editor.draft;
        this.editor.set({ id: editor.id, base: stored, draft });
      });
    });
  }

  protected setFilter(event: Event): void {
    this.filter.set(inputValue(event));
    this.limit.set(PAGE);
    this.status.set('');
  }

  /** Shows the next rows; the focus stays on the button, or goes to the first row it showed. */
  protected showMore(): void {
    const first = this.matching()[this.limit()];
    this.limit.update((n) => n + PAGE);
    keepFocus(this.injector, this.document, () =>
      first ? this.document.getElementById(`org-${first.id}-edit`) : null,
    );
  }

  /**
   * Edit, or Close for the row being edited. Another row's Edit closes an editor without changes
   * and opens its own; one with changes stays open, and the status says so.
   */
  protected toggle(org: Organization): void {
    const editor = this.editor();
    this.status.set('');
    if (editor?.id === org.id) {
      this.close();
      return;
    }
    if (editor !== null && this.dirty()) {
      const name = this.organizations().find((o) => o.id === editor.id)?.name ?? '';
      this.status.set(
        $localize`:@@aiProvider.orgs.busy:Save or cancel the changes to ${name}:org: first.`,
      );
      return;
    }
    this.open(org.id);
  }

  /**
   * Close and Cancel: the draft goes, and the focus goes back to the row's Edit; to the filter when
   * the row leaves with its editor (it showed only while edited), else to the section's heading.
   */
  protected close(): void {
    const id = this.editingId();
    if (id === null) return;
    this.generation++;
    this.editor.set(null);
    this.saving.set(false);
    this.saveError.set(null);
    this.status.set('');
    keepFocus(
      this.injector,
      this.document,
      () => this.document.getElementById(`org-${id}-edit`),
      () => this.document.getElementById('ai-orgs-filter'),
      () => this.document.getElementById('ai-orgs-heading'),
    );
  }

  protected setAllowed(event: Event): void {
    const enabled = isChecked(event);
    this.edit((draft) => ({ ...draft, enabled }));
  }

  protected setFeature(feature: Feature, event: Event): void {
    const on = isChecked(event);
    this.edit((draft) => ({ ...draft, features: { ...draft.features, [feature]: on } }));
  }

  protected addExcluded(picked: PickedProject[]): void {
    this.known.update((known) => new Map([...known, ...picked.map((p) => [p.id, p] as const)]));
    this.edit((draft) => {
      const ids = new Set(draft.excludedProjectIds);
      const fresh = picked.map((p) => p.id).filter((id) => !ids.has(id));
      return { ...draft, excludedProjectIds: [...draft.excludedProjectIds, ...fresh] };
    });
  }

  /** Removes a project from the list; the focus goes to the next one's Remove, else the picker. */
  protected removeExcluded(projectId: string, index: number): void {
    this.edit((draft) => ({
      ...draft,
      excludedProjectIds: draft.excludedProjectIds.filter((id) => id !== projectId),
    }));
    const editor = () => this.host.nativeElement.querySelector('tr.editor');
    const removeButton = (at: number) =>
      editor()?.querySelectorAll<HTMLElement>('.list-editor li button')[at];
    keepFocus(
      this.injector,
      this.document,
      () => removeButton(index),
      () => removeButton(index - 1),
      () => editor()?.querySelector<HTMLElement>('q-project-picker button'),
    );
  }

  /**
   * Save {org}: the entry as it is now. On success the editor closes, unless something was edited
   * while the save was on its way: that stays, unsaved. A refusal shows in the editor's foot.
   */
  protected async save(): Promise<void> {
    const editor = this.editor();
    const org = this.organizations().find((o) => o.id === editor?.id);
    if (editor === null || org === undefined || this.saving()) return;
    const sent = copyOf(editor.draft);
    const generation = this.generation;
    this.saving.set(true);
    this.saveError.set(null);
    this.status.set('');
    try {
      await this.saveEntry()(editor.id, sent);
      const now = this.editor();
      if (generation === this.generation && now !== null) {
        if (changes(now.draft, sent) === 0) this.close();
        else this.editor.set({ ...now, base: sent });
      }
      // Said once the editor closed, which clears the status: a Cancel meanwhile changes nothing
      // of what the server stored.
      this.status.set($localize`:@@aiProvider.orgs.saved:${org.name}:org: saved.`);
    } catch (err) {
      if (generation === this.generation) this.saveError.set(problemMessage(err));
    } finally {
      if (generation === this.generation) this.saving.set(false);
    }
  }

  /** Open: the organisation becomes the header's, once the pages with unsaved changes let it. */
  protected async openPage(org: Organization): Promise<void> {
    if (await this.org.switchTo(org.id)) await this.router.navigate(['/settings/ai-review']);
  }

  private rowOf(
    org: Organization,
    settings: LlmSettings,
    autoFixAvailable: boolean,
    editing: boolean,
  ): Row {
    const stored = settings.organizations[org.id];
    const allowed = stored?.enabled === true;
    const excluded = stored?.excludedProjectIds.length ?? 0;
    return {
      org,
      allowed,
      features:
        stored && allowed
          ? FEATURES.filter((f) => stored.features[f]).map((f) => this.featureTexts[f].name)
          : [],
      excluded,
      excludedText: formatWhole(excluded, this.locale),
      admins:
        stored && allowed
          ? this.adminSwitches(stored, settings.provider !== null, autoFixAvailable)
          : [],
      editing,
      openLabel: $localize`:@@aiProvider.orgs.openLabel:Open ${org.name}:org:'s AI page`,
    };
  }

  /**
   * What an allowed organisation's admins switched on: AI review, paused while their consent does
   * not cover the provider set now; automatic fix suggestions (licensed only), not running while
   * the organisation's Suggest a fix is off.
   */
  private adminSwitches(
    stored: StoredOrg,
    providerSet: boolean,
    autoFixAvailable: boolean,
  ): string[] {
    const t = this.switchTexts;
    const review = stored.reviewStatus;
    const switches: string[] = [];
    if (review.enabled) {
      switches.push(providerSet && !review.consentCurrent ? t.reviewPaused : t.review);
    }
    if (autoFixAvailable && stored.autoFix.enabled) {
      switches.push(stored.features.fix ? t.fix : t.fixNotRunning);
    }
    return switches;
  }

  private open(id: string): void {
    const stored = entryOf(this.settings(), id);
    this.generation++;
    this.editor.set({ id, base: stored, draft: copyOf(stored) });
    this.saving.set(false);
    this.saveError.set(null);
    this.known.set(new Map());
    this.lookupError.set(null);
    void this.lookUp(id, stored.excludedProjectIds, this.generation);
    this.focusLater(`org-${id}-allow`);
  }

  private edit(change: (draft: OrgEntry) => OrgEntry): void {
    const editor = this.editor();
    if (editor === null) return;
    this.editor.set({ ...editor, draft: change(editor.draft) });
    this.saveError.set(null);
  }

  /**
   * Reads the organisation's projects page by page until every project never sent is found (20
   * pages at most), for their names; one not found is named by its id.
   */
  private async lookUp(
    organizationId: string,
    ids: readonly string[],
    generation: number,
  ): Promise<void> {
    const missing = new Set(ids);
    this.looking.set(missing.size > 0);
    if (missing.size === 0) return;
    let cursor: string | null = null;
    try {
      for (let page = 0; page < PROJECT_PAGES && missing.size > 0; page++) {
        const answer: { items: Project[]; nextCursor: string | null } = await ok(
          this.api.client.GET('/api/v0/projects', {
            params: {
              query: { organizationId, limit: PROJECT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
            },
          }),
        );
        if (generation !== this.generation) return;
        const found = answer.items.filter((p) => missing.delete(p.id));
        if (found.length > 0) {
          this.known.update(
            (known) => new Map([...known, ...found.map((p) => [p.id, p] as const)]),
          );
        }
        if (answer.nextCursor === null || answer.nextCursor === cursor) break;
        cursor = answer.nextCursor;
      }
    } catch (err) {
      if (generation === this.generation) this.lookupError.set(problemMessage(err));
    } finally {
      if (generation === this.generation) this.looking.set(false);
    }
  }

  private focusLater(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }
}

/** An organisation's entry as stored, or not allowed with nothing on when the settings lack it. */
function entryOf(settings: LlmSettings, id: string): OrgEntry {
  const stored = settings.organizations[id];
  return stored === undefined
    ? copyOf(NOT_SET)
    : copyOf({
        enabled: stored.enabled,
        features: stored.features,
        excludedProjectIds: stored.excludedProjectIds,
      });
}

function copyOf(entry: OrgEntry): OrgEntry {
  return {
    enabled: entry.enabled,
    features: { ...entry.features },
    excludedProjectIds: [...entry.excludedProjectIds],
  };
}

/** The changes from `b` to `a`: each switch, and each project added or removed. */
function changes(a: OrgEntry, b: OrgEntry): number {
  const inA = new Set(a.excludedProjectIds);
  const inB = new Set(b.excludedProjectIds);
  return (
    Number(a.enabled !== b.enabled) +
    FEATURES.filter((f) => a.features[f] !== b.features[f]).length +
    [...inA].filter((id) => !inB.has(id)).length +
    [...inB].filter((id) => !inA.has(id)).length
  );
}

/** A switch is described by its help, then by the note under it while one stands there. */
function describedBy(inputId: string, note: string | null): string {
  return note === null ? `${inputId}-help` : `${inputId}-help ${inputId}-note`;
}
