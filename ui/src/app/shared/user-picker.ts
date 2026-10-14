import {
  booleanAttribute,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { ApiError, problemMessage } from '../api/errors';

/** A person the picker suggests: what `GET /users/search` and the members list both carry. */
export interface UserSuggestion {
  id: string;
  username: string;
  displayName: string | null;
}

/**
 * Where the suggestions come from: the page's request for the people whose name starts with
 * `query` (at most ten). A refusal is thrown as the API's error, so the picker can say why.
 */
export type UserSource = (query: string) => Promise<readonly UserSuggestion[]>;

/** How long typing must pause before the picker asks (each keystroke would be a request). */
export const SEARCH_DELAY_MS = 250;
/** A user name is 1 to 64 characters (`GET /users/lookup`, `GET /users/search`). */
const USERNAME_MAX_LENGTH = 64;

type State = 'idle' | 'short' | 'loading' | 'results' | 'empty' | 'error';

/**
 * `q-user-picker`: a user name field that suggests people as one types, in the ARIA 1.2 combobox
 * pattern (an input with role combobox, aria-expanded, aria-controls and aria-activedescendant,
 * over a listbox of options). The page owns the label (`for` = `inputId`), the field's error and
 * the source of the suggestions, so each screen decides who may be suggested.
 *
 * - It asks `source` once typing has paused for 250 ms, and only from `minLength` characters
 *   (code points, as the server counts them); a shorter name gets a hint, not a request. Only the
 *   answer to the latest request is shown: an earlier one arriving late is dropped.
 * - ArrowDown and ArrowUp move through the suggestions, Enter picks one, Escape closes the list
 *   (and only the list: a dialog around it stays open); a click picks one too.
 * - Free text stays allowed: `selected` is the suggestion picked, null as soon as the text changes,
 *   and a page that gets a name without a pick resolves it itself (`GET /users/lookup`).
 * - Searching, no match, a short name and a refused search are said in a polite live region; a
 *   refusal (429 RATE_LIMITED among them) is shown, never dropped.
 */
@Component({
  selector: 'q-user-picker',
  templateUrl: './user-picker.html',
  styleUrl: './user-picker.css',
})
export class UserPicker {
  /** The input's id, which the page's `<label for>` names. */
  readonly inputId = input.required<string>();
  readonly source = input.required<UserSource>();
  /** The fewest characters the source accepts (`GET /users/search`: 2, or 1 for an instance admin). */
  readonly minLength = input(2);
  /** The page's error for the field: marks the input invalid when set. */
  readonly invalid = input(false);
  /** The id of the page's error (or hint) that describes the input, if any. */
  readonly describedBy = input<string | null>(null);
  /** The input takes the focus when its dialog opens (the dialog's `autofocus`). */
  readonly autofocus = input(false, { transform: booleanAttribute });

  /** The text in the field. */
  readonly text = model('');
  /** The suggestion picked; null once the text no longer is its name (free text). */
  readonly selected = model<UserSuggestion | null>(null);

  protected readonly state = signal<State>('idle');
  protected readonly suggestions = signal<readonly UserSuggestion[]>([]);
  protected readonly active = signal(-1);
  protected readonly errorText = signal('');
  protected readonly open = computed(
    () => this.state() === 'results' && this.suggestions().length > 0,
  );
  protected readonly listboxId = computed(() => `${this.inputId()}-listbox`);
  protected readonly statusId = computed(() => `${this.inputId()}-status`);
  protected readonly activeId = computed(() =>
    this.open() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );
  protected readonly maxLength = USERNAME_MAX_LENGTH;

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts requests (and cancellations): only the latest request's answer is shown. */
  private generation = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  protected optionId(index: number): string {
    return `${this.inputId()}-option-${index}`;
  }

  /** "username — Display Name"; the display name only when it says something more. */
  protected extra(user: UserSuggestion): string | null {
    const name = user.displayName?.trim() ?? '';
    return name === '' || name === user.username ? null : name;
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.text.set(value);
    if (this.selected() !== null) this.selected.set(null);
    this.schedule(value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (this.open()) this.move(1);
        else if (this.suggestions().length > 0 && this.state() === 'idle') this.reopen(0);
        else this.searchNow();
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (this.open()) this.move(-1);
        else if (this.suggestions().length > 0 && this.state() === 'idle') {
          this.reopen(this.suggestions().length - 1);
        }
        return;
      case 'Enter': {
        const user = this.open() ? this.suggestions()[this.active()] : undefined;
        // Without a highlighted suggestion, Enter submits the form with the text as typed.
        if (!user) {
          this.close();
          return;
        }
        event.preventDefault();
        this.pick(user);
        return;
      }
      case 'Escape':
        // The list closes; a dialog around the field must not close with it.
        if (!this.open()) return;
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
    }
  }

  /** Keeps the focus in the input while an option is clicked. */
  protected keepFocus(event: MouseEvent): void {
    event.preventDefault();
  }

  protected pick(user: UserSuggestion): void {
    this.cancel();
    this.text.set(user.username);
    this.field().nativeElement.value = user.username;
    this.selected.set(user);
    this.state.set('idle');
    this.suggestions.set([]);
    this.active.set(-1);
  }

  /** Focus left the field: the list closes, the suggestions are kept for ArrowDown. */
  protected onBlur(): void {
    if (this.state() === 'results') this.state.set('idle');
    this.active.set(-1);
  }

  /** Focuses the input (a page's refused name keeps the focus on it). */
  focus(): void {
    this.field().nativeElement.focus();
  }

  /** Empties the field and forgets the pick (after an addition). */
  clear(): void {
    this.close();
    this.text.set('');
    this.selected.set(null);
    this.field().nativeElement.value = '';
  }

  /** Stops a pending or running search and closes the list (the page submits). */
  close(): void {
    this.cancel();
    this.state.set('idle');
    this.suggestions.set([]);
    this.active.set(-1);
    this.errorText.set('');
  }

  private reopen(index: number): void {
    this.state.set('results');
    this.active.set(index);
  }

  private move(step: number): void {
    const count = this.suggestions().length;
    const next = this.active() + step;
    // From the first, ArrowUp wraps to the last; from the last, ArrowDown wraps to the first.
    this.active.set(next < 0 ? count - 1 : next >= count ? 0 : next);
  }

  private schedule(value: string): void {
    this.cancel();
    this.suggestions.set([]);
    this.active.set(-1);
    this.errorText.set('');
    const query = value.trim();
    if (query === '') {
      this.state.set('idle');
      return;
    }
    if ([...query].length < this.minLength()) {
      this.state.set('short');
      return;
    }
    this.state.set('loading');
    this.timer = setTimeout(() => void this.search(query), SEARCH_DELAY_MS);
  }

  /** ArrowDown on a closed list: ask at once for the text as it stands. */
  private searchNow(): void {
    const query = this.text().trim();
    if (query === '' || [...query].length < this.minLength()) return;
    this.cancel();
    this.state.set('loading');
    void this.search(query);
  }

  private async search(query: string): Promise<void> {
    this.timer = undefined;
    const generation = ++this.generation;
    try {
      const found = await this.source()(query);
      if (generation !== this.generation) return;
      const sorted = [...found].sort((a, b) =>
        a.username < b.username ? -1 : a.username > b.username ? 1 : 0,
      );
      this.suggestions.set(sorted);
      this.active.set(-1);
      this.state.set(sorted.length > 0 ? 'results' : 'empty');
    } catch (err) {
      if (generation !== this.generation) return;
      this.suggestions.set([]);
      this.errorText.set(
        err instanceof ApiError && err.code === 'RATE_LIMITED'
          ? $localize`:@@userPicker.rateLimited:Too many searches in a minute. Wait a moment, or type the whole user name.`
          : $localize`:@@userPicker.failed:Suggestions are not available: ${problemMessage(err)}:reason: You can still type the whole user name.`,
      );
      this.state.set('error');
    }
  }

  /** Forgets the pending search and any answer still on its way. */
  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
  }
}
