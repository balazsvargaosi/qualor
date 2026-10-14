import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiError } from '../api/errors';
import { problem } from '../../testing/fake-server';
import { SEARCH_DELAY_MS, type UserSource, type UserSuggestion, UserPicker } from './user-picker';

const ALICE: UserSuggestion = { id: 'u-alice', username: 'alice', displayName: 'Alice Smith' };
const ALBERT: UserSuggestion = { id: 'u-albert', username: 'albert', displayName: null };
const ALI: UserSuggestion = { id: 'u-ali', username: 'ali', displayName: 'ali' };

/** A source whose answers the test releases one by one, in any order. */
function heldSource() {
  const calls: {
    query: string;
    resolve: (users: UserSuggestion[]) => void;
    reject: (err: unknown) => void;
  }[] = [];
  const source: UserSource = (query) =>
    new Promise((resolve, reject) => calls.push({ query, resolve, reject }));
  return { source, calls };
}

describe('UserPicker', () => {
  beforeEach(() => {
    // Only the timers: Angular's scheduling and the promises still run, the debounce waits.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  let fixture: ComponentFixture<UserPicker>;

  async function flush(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
    }
  }

  async function render(source: UserSource, minLength?: number) {
    fixture = TestBed.createComponent(UserPicker);
    fixture.componentRef.setInput('inputId', 'who');
    fixture.componentRef.setInput('source', source);
    if (minLength !== undefined) fixture.componentRef.setInput('minLength', minLength);
    await flush();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input#who')!;
    return { root, input, picker: fixture.componentInstance };
  }

  /** Types into the field, which has the focus as a person's typing gives it. */
  function type(input: HTMLInputElement, value: string): void {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  /** Presses a key in the input; true when the picker took it (its default was prevented). */
  function press(
    input: HTMLInputElement,
    key: string,
    init: KeyboardEventInit = {},
  ): { prevented: boolean; stopped: boolean } {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    let stopped = true;
    const outside = () => (stopped = false);
    document.addEventListener('keydown', outside);
    try {
      input.dispatchEvent(event);
    } finally {
      document.removeEventListener('keydown', outside);
    }
    fixture.detectChanges();
    return { prevented: event.defaultPrevented, stopped };
  }

  function options(root: HTMLElement): string[] {
    return [...root.querySelectorAll('[role="option"]')].map((o) =>
      (o.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
  }

  function status(root: HTMLElement): string {
    return (root.querySelector('[aria-live="polite"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('is an ARIA 1.2 combobox over a listbox, closed until there are suggestions', async () => {
    const source = vi.fn<UserSource>(async () => [ALICE, ALBERT]);
    const { root, input } = await render(source);
    const listbox = root.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(listbox.id).toBe('who-listbox');
    expect(listbox.getAttribute('aria-label')).toBe('Suggestions');
    expect(listbox.hidden).toBe(true);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(input.getAttribute('maxlength')).toBe('64');

    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(listbox.hidden).toBe(false);
    const items = [...root.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(items.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false']);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    // The live region counts the suggestions for a screen reader.
    expect(status(root)).toBe('2 suggestions: choose with the arrow keys and Enter.');

    press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(items[0]!.id);
    expect(items[0]!.getAttribute('aria-selected')).toBe('true');
    expect(items[0]!.id).toBe('who-option-0');
  });

  it('shows "username — Display Name", sorted by username, the display name only when it adds', async () => {
    const { root, input } = await render(async () => [ALICE, ALI, ALBERT]);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    expect(options(root)).toEqual(['albert', 'ali', 'alice — Alice Smith']);
  });

  it('asks once typing has paused for 250 ms, with the text as it is then', async () => {
    const source = vi.fn<UserSource>(async () => []);
    const { input } = await render(source);
    type(input, 'al');
    await flush(100);
    type(input, 'ali');
    await flush(100);
    type(input, 'alic');
    await flush(SEARCH_DELAY_MS - 1);
    expect(source).not.toHaveBeenCalled();
    await flush(1);
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith('alic');
  });

  it('sends no query shorter than the minimum, and says how much to type', async () => {
    const source = vi.fn<UserSource>(async () => [ALICE]);
    const { root, input } = await render(source);
    type(input, 'a');
    await flush(SEARCH_DELAY_MS * 2);
    expect(source).not.toHaveBeenCalled();
    expect(status(root)).toBe('Type at least 2 characters to see suggestions.');
    // Characters as a person counts them: one emoji is one character, not two UTF-16 units.
    type(input, '😀');
    await flush(SEARCH_DELAY_MS * 2);
    expect(source).not.toHaveBeenCalled();
    // An empty field asks nothing and says nothing.
    type(input, '  ');
    await flush(SEARCH_DELAY_MS * 2);
    expect(source).not.toHaveBeenCalled();
    expect(status(root)).toBe('');
  });

  it('asks from one character for an instance admin (minLength 1)', async () => {
    const source = vi.fn<UserSource>(async () => [ALICE]);
    const { root, input } = await render(source, 1);
    type(input, 'a');
    await flush(SEARCH_DELAY_MS);
    expect(source).toHaveBeenCalledWith('a');
    expect(options(root)).toEqual(['alice — Alice Smith']);
  });

  it('shows only the answer to the latest request, whatever order they arrive in', async () => {
    const { source, calls } = heldSource();
    const { root, input } = await render(source);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    type(input, 'alb');
    await flush(SEARCH_DELAY_MS);
    expect(calls.map((c) => c.query)).toEqual(['al', 'alb']);
    calls[1]!.resolve([ALBERT]);
    await flush();
    expect(options(root)).toEqual(['albert']);
    // The earlier, broader answer arrives late: it is dropped.
    calls[0]!.resolve([ALICE, ALBERT]);
    await flush();
    expect(options(root)).toEqual(['albert']);
    // A late refusal of a replaced request is dropped too.
    type(input, 'albe');
    await flush(SEARCH_DELAY_MS);
    type(input, 'alber');
    await flush(SEARCH_DELAY_MS);
    calls[3]!.resolve([ALBERT]);
    calls[2]!.reject(new ApiError(429, problem(429, 'RATE_LIMITED') as never));
    await flush();
    expect(options(root)).toEqual(['albert']);
    expect(status(root)).not.toContain('Too many');
  });

  it('moves with ArrowDown and ArrowUp, wrapping, and Enter picks the highlighted one', async () => {
    const { root, input, picker } = await render(async () => [ALICE, ALBERT]);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    const ids = [...root.querySelectorAll('[role="option"]')].map((o) => o.id);
    expect(press(input, 'ArrowDown').prevented).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe(ids[0]);
    press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(ids[1]);
    press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(ids[0]);
    press(input, 'ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe(ids[1]);
    expect(root.querySelector('[role="option"].active')?.textContent).toContain('alice');

    // Enter picks: the form around it is not submitted.
    expect(press(input, 'Enter').prevented).toBe(true);
    expect(picker.selected()).toEqual(ALICE);
    expect(picker.text()).toBe('alice');
    expect(input.value).toBe('alice');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('Escape closes the list and only the list; closed, Escape is left to the dialog', async () => {
    const source = vi.fn<UserSource>(async () => [ALICE]);
    const { input } = await render(source);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const open = press(input, 'Escape');
    expect(open).toEqual({ prevented: true, stopped: true });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('al');
    const closed = press(input, 'Escape');
    expect(closed).toEqual({ prevented: false, stopped: false });
    // ArrowDown opens the list again on the suggestions it had, without asking again.
    press(input, 'ArrowDown');
    await flush();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('scrolls the highlighted suggestion into view as the keys move it', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `u-${i}`,
      username: `user${i}`,
      displayName: null,
    }));
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
      expect(options).toEqual({ block: 'nearest' });
      scrolled.push(this.id);
    } as typeof Element.prototype.scrollIntoView;
    try {
      const { input } = await render(async () => many);
      type(input, 'us');
      await flush(SEARCH_DELAY_MS);
      for (let i = 0; i < 8; i++) press(input, 'ArrowDown');
      await flush();
      expect(input.getAttribute('aria-activedescendant')).toBe('who-option-7');
      expect(scrolled.at(-1)).toBe('who-option-7');
      press(input, 'ArrowUp');
      await flush();
      expect(scrolled.at(-1)).toBe('who-option-6');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('keeps an answer that arrives after the field lost the focus, the list closed', async () => {
    const { source, calls } = heldSource();
    const { root, input } = await render(source);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    input.blur();
    calls[0]!.resolve([ALICE]);
    await flush();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(status(root)).toBe('');
    // Back in the field, ArrowDown opens the kept suggestions, without asking again.
    input.focus();
    press(input, 'ArrowDown');
    await flush();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(options(root)).toEqual(['alice — Alice Smith']);
    expect(calls).toHaveLength(1);
  });

  it('asks again on ArrowDown after no match or a refusal only when the text changed', async () => {
    const source = vi.fn<UserSource>(async () => []);
    const { input } = await render(source);
    type(input, 'zz');
    await flush(SEARCH_DELAY_MS);
    press(input, 'ArrowDown');
    press(input, 'ArrowDown');
    await flush();
    expect(source).toHaveBeenCalledTimes(1);
    type(input, 'zzz');
    press(input, 'ArrowDown');
    await flush();
    expect(source).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenLastCalledWith('zzz');
  });

  it('leaves Enter to an input method that is composing a character', async () => {
    const { input, picker } = await render(async () => [ALICE]);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    press(input, 'ArrowDown');
    expect(press(input, 'Enter', { isComposing: true }).prevented).toBe(false);
    expect(picker.selected()).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps its live region rendered and shown while it has nothing to say', async () => {
    const { root, input } = await render(async () => []);
    const region = root.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(region.textContent?.trim()).toBe('');
    expect(getComputedStyle(region).display).not.toBe('none');
    type(input, 'zz');
    await flush(SEARCH_DELAY_MS);
    // The same element says it: it was never removed nor hidden.
    expect(root.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toContain('No user matches.');
  });

  it('keeps free text: Enter without a highlighted suggestion submits, and typing forgets a pick', async () => {
    const { root, input, picker } = await render(async () => [ALICE]);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    // Nothing highlighted: Enter is the form's (the page resolves the name with /users/lookup).
    expect(press(input, 'Enter').prevented).toBe(false);
    expect(picker.selected()).toBeNull();
    expect(picker.text()).toBe('al');

    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    root.querySelector<HTMLElement>('[role="option"]')!.click();
    fixture.detectChanges();
    expect(picker.selected()).toEqual(ALICE);
    type(input, 'alicex');
    expect(picker.selected()).toBeNull();
    expect(picker.text()).toBe('alicex');
  });

  it('a click picks a suggestion, and pressing it keeps the focus in the field', async () => {
    const { root, input, picker } = await render(async () => [ALICE, ALBERT]);
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    const second = root.querySelectorAll<HTMLElement>('[role="option"]')[1]!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    second.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    second.click();
    fixture.detectChanges();
    expect(picker.selected()).toEqual(ALICE);
    expect(input.value).toBe('alice');
  });

  it('says when nothing matches', async () => {
    const { root, input } = await render(async () => []);
    type(input, 'zz');
    await flush(SEARCH_DELAY_MS);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(status(root)).toBe('No user matches. You can still type the whole user name.');
  });

  it('shows a refused search (429 RATE_LIMITED) in the live region, and the field still works', async () => {
    const { root, input, picker } = await render(async () => {
      throw new ApiError(429, problem(429, 'RATE_LIMITED') as never, '30');
    });
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    const live = root.querySelector('[aria-live="polite"]')!;
    expect(live.querySelector('.field-error')?.textContent).toBe(
      'Too many searches in a minute. Wait a moment, or type the whole user name.',
    );
    expect(input.getAttribute('aria-expanded')).toBe('false');
    type(input, 'alice');
    expect(picker.text()).toBe('alice');
  });

  it('shows any other refusal with its reason', async () => {
    const { root, input } = await render(async () => {
      throw new ApiError(403, problem(403, 'FORBIDDEN') as never);
    });
    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    expect(status(root)).toBe(
      'Suggestions are not available: You are not allowed to do this. You can still type the whole user name.',
    );
  });

  it('close() drops the pending search and an answer still on its way; clear() empties the field', async () => {
    const source = vi.fn<UserSource>(async () => [ALICE]);
    const { root, input, picker } = await render(source);
    type(input, 'al');
    picker.close();
    await flush(SEARCH_DELAY_MS * 2);
    expect(source).not.toHaveBeenCalled();
    expect(options(root)).toEqual([]);

    type(input, 'al');
    await flush(SEARCH_DELAY_MS);
    press(input, 'ArrowDown');
    press(input, 'Enter');
    picker.clear();
    fixture.detectChanges();
    expect(input.value).toBe('');
    expect(picker.text()).toBe('');
    expect(picker.selected()).toBeNull();
  });

  it('marks the field invalid and described by the page error when the page says so', async () => {
    const { input } = await render(async () => []);
    fixture.componentRef.setInput('invalid', true);
    fixture.componentRef.setInput('describedBy', 'who-error');
    expect(input.hasAttribute('aria-required')).toBe(false);
    fixture.componentRef.setInput('autofocus', true);
    fixture.componentRef.setInput('required', true);
    fixture.detectChanges();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('who-error');
    expect(input.hasAttribute('autofocus')).toBe(true);
    expect(input.getAttribute('aria-required')).toBe('true');
  });
});
