import { DOCUMENT, inject, InjectionToken } from '@angular/core';

/**
 * Leaves the app for another address with a full navigation (linking goes through the identity
 * provider; the OAuth consent answer goes back to the client). A token, so tests can see the
 * address without leaving the test page.
 */
export const LEAVE_APP = new InjectionToken<(url: string) => void>('LEAVE_APP', {
  providedIn: 'root',
  factory: () => {
    const document = inject(DOCUMENT);
    return (url: string) => document.location.assign(url);
  },
});
