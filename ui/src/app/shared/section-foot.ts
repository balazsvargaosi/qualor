import { Component, computed, DOCUMENT, inject, input, LOCALE_ID, output } from '@angular/core';
import { formatTime } from './date-time.pipe';
import { Icon } from './icon';

/**
 * What a section's foot says beside its Save: nothing changed, how many changes wait, a save on
 * its way, the time it was saved, the fields a save refused (by their input ids and labels), or
 * why the server refused it.
 */
export type FootOutcome =
  | { kind: 'clean' }
  | { kind: 'pending'; count: number }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'refused'; fields: readonly { id: string; label: string }[] }
  | { kind: 'error'; text: string };

/** A refused field's link, or the words between two links (" and "), in the locale's own order. */
interface RefusalPart {
  field: { id: string; label: string } | null;
  words: string;
}

/**
 * `q-section-foot` (spec §7.2, §7.7): a section's foot. At its left a polite live region says the
 * outcome; then the buttons the section projects (Cancel, Test again); then its one Save, named
 * for what it saves ("Save limits"). Save is enabled and primary while changes wait, and after a
 * save that failed, so it can be tried again as it is; it is unavailable while a save is on its
 * way, while nothing is unsaved, and while a field is refused (saving that again would be
 * refused). Unavailable is `aria-disabled`, never `disabled`: a press does nothing, and a focused
 * Save keeps the focus through its save instead of dropping it to the page's body. A refusal names
 * the fields as links that take the focus to each.
 */
@Component({
  selector: 'q-section-foot',
  imports: [Icon],
  templateUrl: './section-foot.html',
})
export class SectionFoot {
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  readonly outcome = input.required<FootOutcome>();
  readonly saveLabel = input.required<string>();
  readonly save = output();

  protected readonly kind = computed(() => this.outcome().kind);
  /** Changes wait, or the last save of them failed. */
  protected readonly canSave = computed(() => this.kind() === 'pending' || this.kind() === 'error');
  /** The changes waiting, or the fields refused. */
  protected readonly count = computed(() => {
    const outcome = this.outcome();
    if (outcome.kind === 'pending') return outcome.count;
    return outcome.kind === 'refused' ? outcome.fields.length : 0;
  });
  /** The time of a save, in UTC and labelled ("2:05 PM UTC"). */
  protected readonly savedAt = computed(() => {
    const outcome = this.outcome();
    return outcome.kind === 'saved' ? formatTime(outcome.at.toISOString(), this.locale) : '';
  });
  protected readonly errorText = computed(() => {
    const outcome = this.outcome();
    return outcome.kind === 'error' ? outcome.text : '';
  });
  /** The refused fields joined as the locale lists things: "A and B", "A, B, and C". */
  protected readonly refusal = computed<readonly RefusalPart[]>(() => {
    const outcome = this.outcome();
    if (outcome.kind !== 'refused') return [];
    const fields = outcome.fields;
    let next = 0;
    return new Intl.ListFormat(this.locale, { type: 'conjunction' })
      .formatToParts(fields.map((f) => f.label))
      .map((part) =>
        part.type === 'element'
          ? { field: fields[next++] ?? null, words: part.value }
          : { field: null, words: part.value },
      );
  });

  protected onSave(): void {
    if (this.canSave()) this.save.emit();
  }

  /** A refused field's link moves the focus to the field; the page's address stays. */
  protected focusField(id: string, event: Event): void {
    event.preventDefault();
    this.document.getElementById(id)?.focus();
  }
}
