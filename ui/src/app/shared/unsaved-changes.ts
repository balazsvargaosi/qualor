import { DestroyRef, DOCUMENT, inject } from '@angular/core';
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
