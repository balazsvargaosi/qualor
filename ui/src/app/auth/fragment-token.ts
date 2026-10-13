import { DOCUMENT } from '@angular/common';
import { afterNextRender, inject } from '@angular/core';
import { Router } from '@angular/router';

/**
 * Mail E2 A2: a one-time link carries its secret in the fragment (`#token=…`), which the browser
 * never sends to a server or puts in a Referer. Reads it once and takes the fragment out of the
 * address bar and the history entry (keeping the entry's state), so the secret is not left in the
 * URL for a bookmark, a screenshot or a shared screen.
 *
 * `name`: the fragment parameter, `token` for E2's links, `t` for E3's stop link.
 */
export function takeFragmentToken(document: Document, name = 'token'): string | null {
  const location = document.location;
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get(name);
  const history = document.defaultView?.history;
  if (location.hash !== '' && history) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  return token === null || token === '' ? null : token;
}

/**
 * The token of the link that opened this page (reset, invitation), for a field initialiser of the
 * page component. Besides the address bar, the router keeps the URL it navigated to, fragment
 * included (`router.url`), and may write it back: to the address bar (after the page read it, or
 * when a later navigation fails) or into a `returnUrl` (an expired session). So after the first
 * render the fragment is cleared once more and the router moves to the same address without it;
 * the route is the same, so the page and its token stay. `name`: see `takeFragmentToken`.
 */
export function takeLinkToken(name = 'token'): string | null {
  const document = inject(DOCUMENT);
  const router = inject(Router);
  const token = takeFragmentToken(document, name);
  afterNextRender(() => {
    takeFragmentToken(document);
    const at = router.url.indexOf('#');
    if (at !== -1) void router.navigateByUrl(router.url.slice(0, at), { replaceUrl: true });
  });
  return token;
}
