import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, done, ok } from '../api/api';
import { problemMessage } from '../api/errors';
import type { RequestBody, ResponseBody } from '../api/types';
import { isChecked } from '../shared/forms';
import { Icon } from '../shared/icon';

export type WatchState = ResponseBody<'/api/v0/projects/{id}/watch', 'get'>;
export type WatchSettings = RequestBody<'/api/v0/projects/{id}/watch', 'put'>;
export type EventKey = keyof WatchSettings['events'];

/** What "Watch" starts with (mail E3 N2, N3): the main branch and every event. */
export const DEFAULT_WATCH: WatchSettings = {
  branches: 'main',
  events: { gateFailed: true, gateRecovered: true, analysisFailed: true },
};

/**
 * The project's Watch button in the band (mail E3): off, "Watch" starts watching with the defaults
 * and opens the menu; on, "Watching" opens the menu with the scope, the three events and "Stop
 * watching". The menu says why no email would arrive. Escape closes it and gives the focus back; a
 * click elsewhere, scrolling or resizing closes it too. The band clips what overflows it, so the
 * menu is a manual popover in the top layer, placed under the button (as the shell's user menu).
 */
@Component({
  selector: 'q-watch-button',
  imports: [Icon, RouterLink],
  templateUrl: './watch-button.html',
  styleUrl: './watch-button.css',
  host: {
    '(keydown.escape)': 'close()',
    '(document:click)': 'clickOutside($event)',
    '(window:resize)': 'close(false)',
    '(window:scroll)': 'close(false)',
  },
})
export class WatchButton {
  private readonly api = inject(Api);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly projectId = input.required<string>();

  protected readonly state = signal<WatchState | null>(null);
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly button = viewChild.required<ElementRef<HTMLButtonElement>>('button');
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  protected readonly settings = computed<WatchSettings | null>(() => {
    const s = this.state();
    return s?.watching ? { branches: s.branches, events: s.events } : null;
  });
  protected readonly hint = computed(() => {
    switch (this.state()?.emailBlocker) {
      case 'no_address':
        return $localize`:@@watch.hint.noAddress:You have no email address: ask an administrator to add one.`;
      case 'not_configured':
        return $localize`:@@watch.hint.notConfigured:Email isn't set up on this server.`;
      case 'preference_off':
        return $localize`:@@watch.hint.preferenceOff:Notification email is off in your settings.`;
      default:
        return null;
    }
  });

  constructor() {
    effect(() => {
      const id = this.projectId();
      untracked(() => {
        this.open.set(false);
        this.state.set(null);
        this.error.set(null);
        void this.load(id);
      });
    });
    // The opened menu goes to the top layer under the button, its right edge on the button's.
    effect(() => {
      const el = this.menu()?.nativeElement;
      if (!el) return;
      const rect = this.button().nativeElement.getBoundingClientRect();
      el.style.top = `${Math.round(rect.bottom + 6)}px`;
      el.style.right = `${Math.max(0, Math.round(document.documentElement.clientWidth - rect.right))}px`;
      // jsdom has no Popover API (the shell's closeMenu does the same check).
      const popover = el as Partial<Pick<HTMLElement, 'showPopover'>>;
      if (popover.showPopover && !el.matches(':popover-open')) popover.showPopover.call(el);
    });
  }

  private async load(id: string): Promise<void> {
    try {
      const state = await ok(
        this.api.client.GET('/api/v0/projects/{id}/watch', { params: { path: { id } } }),
      );
      if (id === this.projectId()) this.state.set(state);
    } catch (err) {
      if (id === this.projectId()) this.error.set(problemMessage(err));
    }
  }

  protected async toggle(): Promise<void> {
    if (this.busy()) return;
    if (this.open()) {
      this.close();
      return;
    }
    if (this.state()?.watching === false) await this.save(DEFAULT_WATCH);
    this.open.set(true);
  }

  /** Closes the menu; `refocus` gives the focus back to the button (not after a click elsewhere). */
  protected close(refocus = true): void {
    if (!this.open()) return;
    this.open.set(false);
    if (refocus) this.button().nativeElement.focus();
  }

  protected clickOutside(event: Event): void {
    if (event.target instanceof Node && !this.host.nativeElement.contains(event.target)) {
      this.close(false);
    }
  }

  protected async setBranches(branches: WatchSettings['branches']): Promise<void> {
    const current = this.settings();
    if (current) await this.save({ ...current, branches });
  }

  protected async setEvent(key: EventKey, event: Event): Promise<void> {
    const current = this.settings();
    if (!current) return;
    const events = { ...current.events };
    events[key] = isChecked(event);
    await this.save({ ...current, events });
  }

  protected async stop(): Promise<void> {
    const state = this.state();
    if (this.busy() || !state) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await done(
        this.api.client.DELETE('/api/v0/projects/{id}/watch', {
          params: { path: { id: this.projectId() } },
        }),
      );
      this.state.set({
        watching: false,
        emailReady: state.emailReady,
        emailBlocker: state.emailBlocker,
      });
      this.close();
    } catch (err) {
      this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async save(body: WatchSettings): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.state.set(
        await ok(
          this.api.client.PUT('/api/v0/projects/{id}/watch', {
            params: { path: { id: this.projectId() } },
            body,
          }),
        ),
      );
    } catch (err) {
      this.error.set(problemMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
