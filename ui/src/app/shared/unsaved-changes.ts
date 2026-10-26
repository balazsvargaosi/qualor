import { DestroyRef, DOCUMENT, inject, Injectable } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';

/**
 * A page whose sections keep drafts (spec §3.3): leaving it asks first while one has unsaved
 * changes. `canLeave` answers at once when nothing is unsaved, else asks (`q-leave-confirm`).
 */
export interface LeaveGuarded {
  canLeave(): boolean | Promise<boolean>;
}

/**
 * The route's `canDeactivate`: the page decides, and the navigation waits for its answer. Angular
 * passes null for a route whose outlet was never activated: there is no page to ask, so it goes.
 */
export const unsavedChangesGuard: CanDeactivateFn<LeaveGuarded> = (c: LeaveGuarded | null) =>
  c?.canLeave() ?? true;

/**
 * The pages on screen that keep drafts, for a change that is no navigation and still replaces
 * what they show: switching the organisation in the header asks them first, as the route guard
 * asks a page the router leaves. A page registers itself, in its injection context, for its life.
 */
@Injectable({ providedIn: 'root' })
export class LeaveGuards {
  private readonly pages = new Set<LeaveGuarded>();

  /**
   * Asks `page` before such a change from now on. Call it in an injection context: the page is
   * forgotten when the component or injector it is called in is destroyed.
   */
  register(page: LeaveGuarded): void {
    this.pages.add(page);
    inject(DestroyRef).onDestroy(() => this.pages.delete(page));
  }

  /** Asks each page in turn; false as soon as one keeps the person on it (Stay). */
  async canLeave(): Promise<boolean> {
    for (const page of [...this.pages]) {
      if (!(await page.canLeave())) return false;
    }
    return true;
  }
}

/**
 * Asks the browser to confirm a reload, a closed tab or another address while `dirty()` holds
 * (the browser's own question: a page cannot word it). The router's navigations are the guard's.
 * Call it in an injection context; the listener goes with the component or injector.
 */
export function whileDirty(dirty: () => boolean): void {
  const view = inject(DOCUMENT).defaultView;
  if (!view) return;
  const listener = (event: BeforeUnloadEvent): void => {
    if (dirty()) event.preventDefault();
  };
  view.addEventListener('beforeunload', listener);
  inject(DestroyRef).onDestroy(() => view.removeEventListener('beforeunload', listener));
}
