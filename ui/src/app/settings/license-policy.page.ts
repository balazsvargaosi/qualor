import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Api } from '../api/api';
import { problemMessage } from '../api/errors';
import { label } from '../i18n/labels';
import { OrgContext } from '../org/org-context';
import { closeModal, openAfterRender } from '../shared/dialog';
import { inputValue, isChecked } from '../shared/forms';
import { Icon } from '../shared/icon';
import {
  DEFAULT_LICENSE_POLICY,
  invalidEntriesMessage,
  invalidLicenseIds,
  type LicenseGroup,
  type LicenseGroupId,
  type LicenseList,
  type LicensePolicy,
  type LicensePolicyMode,
  licenseEntries,
  licensePolicyNotLicensed,
  licensePolicyRefusal,
  MAX_ENTRY_LENGTH,
  MAX_POLICY_ENTRIES,
  type OrgLicensePolicy,
  readLicensePolicy,
  writeLicensePolicy,
} from './license-policy';

const LISTS: readonly LicenseList[] = ['forbidden', 'allowed'];

/**
 * Settings → Licence policy (6M §8), for the organisation's admins (`org.licenses.manage`): which
 * dependency licences the organisation chosen in the header forbids. Either it forbids the listed
 * licences (Qualor's licence groups and SPDX ids, with allowed ids as exceptions) or it allows only
 * the listed ones; it may also warn about dependencies without a known licence. The groups, their
 * members and the SPDX ids offered while typing come from the server. Without the enterprise feature
 * `license-policy` the server answers `available: false` and the page shows the Business note in
 * place of the controls. Removing the policy is confirmed in the page's own dialog.
 */
@Component({
  selector: 'q-license-policy-page',
  imports: [Icon],
  templateUrl: './license-policy.page.html',
  styleUrl: './license-policy.page.css',
})
export class LicensePolicyPage {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  protected readonly org = inject(OrgContext);

  protected readonly allowed = computed(
    () => this.org.currentId() !== null && this.org.can('org.licenses.manage'),
  );
  protected readonly current = signal<OrgLicensePolicy | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly mode = signal<LicensePolicyMode>('denylist');
  protected readonly forbiddenGroups = signal<ReadonlySet<LicenseGroupId>>(new Set());
  protected readonly lists = signal<Record<LicenseList, readonly string[]>>({
    forbidden: [],
    allowed: [],
  });
  protected readonly drafts = signal<Record<LicenseList, string>>({ forbidden: '', allowed: '' });
  protected readonly warnUnknown = signal(false);
  /** The groups whose members are shown. */
  protected readonly expanded = signal<ReadonlySet<LicenseGroupId>>(new Set());
  /** A list's own message (too many entries, none allowed); the server's refusals come next. */
  private readonly listErrors = signal<Record<LicenseList, string | null>>({
    forbidden: null,
    allowed: null,
  });
  /** The entries the server refused (400 INVALID_LICENSE_ID), until they are removed. */
  protected readonly invalid = signal<ReadonlySet<string>>(new Set());
  protected readonly fieldErrors = computed<Record<LicenseList, string | null>>(() => {
    const own = this.listErrors();
    const refused = (list: LicenseList) =>
      this.lists()[list].filter((entry) => this.invalid().has(entry));
    const message = (list: LicenseList) => {
      const entries = refused(list);
      return own[list] ?? (entries.length > 0 ? invalidEntriesMessage(entries) : null);
    };
    return { forbidden: message('forbidden'), allowed: message('allowed') };
  });
  protected readonly error = signal<string | null>(null);
  protected readonly announcement = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notLicensed = licensePolicyNotLicensed();
  protected readonly maxEntries = MAX_POLICY_ENTRIES;
  protected readonly inputValue = inputValue;
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly removeDialog = viewChild<ElementRef<HTMLDialogElement>>('removeDialog');
  /** Counts the organisations read: an answer for an earlier one is dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const id = this.org.currentId();
      const allowed = this.allowed();
      untracked(() => {
        this.generation++;
        this.current.set(null);
        this.error.set(null);
        this.announcement.set(null);
        if (allowed && id) void this.load(id, this.generation);
      });
    });
  }

  /** A group's name in the UI's words; one this UI does not know keeps the server's. */
  protected groupLabel(group: LicenseGroup): string {
    const known = label('licenseGroup', group.id);
    return known === group.id ? group.label : known;
  }

  /** "4 licences": how many licences a group lists, on the button that shows them. */
  protected membersText(group: LicenseGroup): string {
    const count = group.members.length;
    return count === 1
      ? $localize`:@@licensePolicy.membersOne:1 licence`
      : $localize`:@@licensePolicy.members:${count}:count: licences`;
  }

  /** "4 licences in Strong copyleft": the visible words first, then which group (label in name). */
  protected membersLabel(group: LicenseGroup): string {
    const count = group.members.length;
    const name = this.groupLabel(group);
    return count === 1
      ? $localize`:@@licensePolicy.membersLabelOne:1 licence in ${name}:group:`
      : $localize`:@@licensePolicy.membersLabel:${count}:count: licences in ${name}:group:`;
  }

  /** "Remove GPL-3.0-only". */
  protected removeLabel(entry: string): string {
    return $localize`:@@licensePolicy.removeEntry:Remove ${entry}:entry:`;
  }

  /** "Add to forbidden licences": the visible word first (WCAG label in name). */
  protected addLabel(list: LicenseList): string {
    return list === 'forbidden'
      ? $localize`:@@licensePolicy.addForbidden:Add to forbidden licences`
      : $localize`:@@licensePolicy.addAllowed:Add to allowed licences`;
  }

  protected setMode(mode: LicensePolicyMode): void {
    this.mode.set(mode);
    this.listErrors.set({ forbidden: null, allowed: null });
    this.announcement.set(null);
  }

  protected toggleGroup(id: LicenseGroupId, event: Event): void {
    const next = new Set(this.forbiddenGroups());
    if (isChecked(event)) next.add(id);
    else next.delete(id);
    this.forbiddenGroups.set(next);
    this.announcement.set(null);
  }

  protected toggleMembers(id: LicenseGroupId): void {
    const next = new Set(this.expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded.set(next);
  }

  protected setWarnUnknown(event: Event): void {
    this.warnUnknown.set(isChecked(event));
    this.announcement.set(null);
  }

  protected setDraft(list: LicenseList, event: Event): void {
    this.drafts.update((d) => ({ ...d, [list]: inputValue(event) }));
  }

  /** Enter adds what was typed, and never submits the form. */
  protected onKey(list: LicenseList, event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.add(list);
  }

  /** Adds the typed entries to a list; false when a limit refused them. */
  protected add(list: LicenseList): boolean {
    const ids = this.current()?.spdxIds ?? { licenses: [], exceptions: [] };
    const entries = licenseEntries(this.drafts()[list], ids);
    if (entries.length === 0) return true;
    this.announcement.set(null);
    if (entries.some((e) => e.length > MAX_ENTRY_LENGTH)) {
      this.setListError(
        list,
        $localize`:@@licensePolicy.tooLong:A licence identifier has at most 256 characters.`,
      );
      return false;
    }
    const current = this.lists()[list];
    const added = entries.filter((e, i) => !current.includes(e) && entries.indexOf(e) === i);
    if (current.length + added.length > MAX_POLICY_ENTRIES) {
      this.setListError(
        list,
        $localize`:@@licensePolicy.tooMany:A list holds at most ${MAX_POLICY_ENTRIES}:max: licences.`,
      );
      return false;
    }
    this.lists.update((l) => ({ ...l, [list]: [...current, ...added] }));
    this.drafts.update((d) => ({ ...d, [list]: '' }));
    this.setListError(list, null);
    return true;
  }

  protected remove(list: LicenseList, entry: string): void {
    this.lists.update((l) => ({ ...l, [list]: l[list].filter((e) => e !== entry) }));
    const invalid = new Set(this.invalid());
    invalid.delete(entry);
    this.invalid.set(invalid);
    this.setListError(list, null);
    this.announcement.set(null);
    this.focus(`license-policy-${list}`);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const id = this.org.currentId();
    if (this.busy() || !id || !this.current()?.available) return;
    // What is still typed in a field counts, as if Enter had been pressed.
    for (const list of this.shownLists()) {
      if (!this.add(list)) return this.focus(`license-policy-${list}`);
    }
    const mode = this.mode();
    if (mode === 'allowlist' && this.lists().allowed.length === 0) {
      this.setListError(
        'allowed',
        $localize`:@@licensePolicy.noneAllowed:Name at least one allowed licence: this mode forbids every other one.`,
      );
      return this.focus('license-policy-allowed');
    }
    const groups = this.current()?.groups ?? [];
    const denylist = mode === 'denylist';
    const policy: LicensePolicy = {
      mode,
      forbiddenGroups: denylist
        ? groups.map((g) => g.id).filter((g) => this.forbiddenGroups().has(g))
        : [],
      forbidden: denylist ? [...this.lists().forbidden] : [],
      allowed: [...this.lists().allowed],
      warnUnknown: this.warnUnknown(),
    };
    await this.write(
      id,
      policy,
      $localize`:@@licensePolicy.saved:The licence policy was saved. It applies from each project's next analysis.`,
    );
  }

  protected askRemove(): void {
    openAfterRender(this.injector, () => this.removeDialog()?.nativeElement);
  }

  protected closeRemove(): void {
    const dialog = this.removeDialog()?.nativeElement;
    if (dialog) closeModal(dialog);
  }

  protected async confirmRemove(): Promise<void> {
    const id = this.org.currentId();
    this.closeRemove();
    if (this.busy() || !id) return;
    await this.write(id, null, $localize`:@@licensePolicy.removed:The licence policy was removed.`);
  }

  /** The lists the mode shows: an allowlist has no forbidden ids. */
  protected shownLists(): readonly LicenseList[] {
    return this.mode() === 'denylist' ? LISTS : ['allowed'];
  }

  private async write(id: string, policy: LicensePolicy | null, done: string): Promise<void> {
    const generation = this.generation;
    this.busy.set(true);
    this.error.set(null);
    this.announcement.set(null);
    try {
      const saved = await writeLicensePolicy(this.api, id, policy);
      if (generation !== this.generation) return;
      const current = this.current();
      if (current) this.show({ ...current, available: saved.available, policy: saved.policy });
      this.announcement.set(done);
    } catch (err) {
      if (generation !== this.generation) return;
      const invalid = invalidLicenseIds(err);
      if (invalid) {
        this.invalid.set(new Set(invalid));
        const first = this.shownLists().find((l) => this.fieldErrors()[l] !== null);
        if (first) return this.focus(`license-policy-${first}`);
      }
      this.error.set(licensePolicyRefusal(err) ?? problemMessage(err));
      this.heading().nativeElement.focus();
    } finally {
      this.busy.set(false);
    }
  }

  private async load(id: string, generation: number): Promise<void> {
    this.loadError.set(null);
    try {
      const answer = await readLicensePolicy(this.api, id);
      if (generation === this.generation) this.show(answer);
    } catch (err) {
      if (generation === this.generation) this.loadError.set(problemMessage(err));
    }
  }

  private show(answer: OrgLicensePolicy): void {
    const policy = answer.policy ?? DEFAULT_LICENSE_POLICY;
    this.current.set(answer);
    this.mode.set(policy.mode);
    this.forbiddenGroups.set(new Set(policy.forbiddenGroups));
    this.lists.set({ forbidden: [...policy.forbidden], allowed: [...policy.allowed] });
    this.drafts.set({ forbidden: '', allowed: '' });
    this.warnUnknown.set(policy.warnUnknown);
    this.listErrors.set({ forbidden: null, allowed: null });
    this.invalid.set(new Set());
  }

  private setListError(list: LicenseList, message: string | null): void {
    this.listErrors.update((e) => ({ ...e, [list]: message }));
  }

  private focus(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }
}
