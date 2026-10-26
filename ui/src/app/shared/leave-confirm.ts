import {
  Component,
  computed,
  type ElementRef,
  inject,
  Injector,
  LOCALE_ID,
  signal,
  viewChild,
} from '@angular/core';
import { closeModal, openAfterRender } from './dialog';

/**
 * `q-leave-confirm`: "Leave without saving?", asked by a page's `canLeave()` while sections have
 * unsaved changes, naming them ("Your changes to Limits are not saved yet."). Stay comes first and
 * has the focus; Stay, Escape or the dialog closing otherwise keep the person on the page.
 */
@Component({
  selector: 'q-leave-confirm',
  templateUrl: './leave-confirm.html',
})
export class LeaveConfirm {
  private readonly injector = inject(Injector);
  private readonly locale = inject(LOCALE_ID);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** The names of the sections with unsaved changes, as their headings say them. */
  private readonly sections = signal<readonly string[]>([]);
  protected readonly question = computed(() => {
    const names = new Intl.ListFormat(this.locale, { type: 'conjunction' }).format(this.sections());
    return $localize`:@@leave.text:Your changes to ${names}:sections: are not saved yet.`;
  });
  /** Answers the question on screen; null while none is. */
  private pending: ((leave: boolean) => void) | null = null;

  /** Asks whether to leave the page without saving `sections`; true when the person leaves. */
  ask(sections: readonly string[]): Promise<boolean> {
    // A question still open (Back pressed while it asks) is answered "stay", and the open dialog
    // asks the new one. Closing it here would fire its close event later, on the new question.
    this.pending?.(false);
    this.pending = null;
    this.sections.set(sections);
    return new Promise<boolean>((resolve) => {
      this.pending = resolve;
      openAfterRender(
        this.injector,
        () => this.dialog().nativeElement,
        () => this.pending === resolve,
      );
    });
  }

  /** Stay (false), Leave without saving (true), or the dialog closing otherwise (Escape: false). */
  protected answer(leave: boolean): void {
    const resolve = this.pending;
    this.pending = null;
    closeModal(this.dialog().nativeElement);
    resolve?.(leave);
  }
}
