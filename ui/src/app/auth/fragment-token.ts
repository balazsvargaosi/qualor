/**
 * Mail E2 A2: a one-time link carries its secret in the fragment (`#token=…`), which the browser
 * never sends to a server or puts in a Referer. Reads it once and takes the fragment out of the
 * address bar and the history entry (keeping the entry's state), so the secret is not left in the
 * URL for a bookmark, a screenshot or a shared screen.
 */
export function takeFragmentToken(document: Document): string | null {
  const location = document.location;
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  const history = document.defaultView?.history;
  if (location.hash !== '' && history) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  return token === null || token === '' ? null : token;
}
