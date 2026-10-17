const MAX_URI_LENGTH = 2048;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** RFC 8252 §7.1 private-use schemes; never the browser's own dangerous ones. */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'blob:',
  'about:',
  'vbscript:',
]);

function parse(uri: string): URL | null {
  if (uri.length > MAX_URI_LENGTH) return null;
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Spec §7 with ruling R5: https anywhere; plain http only to loopback; a private-use scheme
 * (`cursor://`); never a fragment, user info or a browser-internal scheme.
 */
export function redirectUriAllowed(uri: string): boolean {
  const url = parse(uri);
  if (!url || url.hash !== '' || uri.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return url.hostname !== '';
  if (url.protocol === 'http:') return isLoopback(url);
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** Exact string match, except that a loopback URI matches with any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  const p = parse(presented);
  if (!p || !isLoopback(p)) return false;
  return registered.some((r) => {
    const u = parse(r);
    return (
      !!u &&
      isLoopback(u) &&
      u.hostname === p.hostname &&
      u.pathname === p.pathname &&
      u.search === p.search
    );
  });
}

/** What the consent screen names as the place the browser goes back to. */
export function redirectTargetLabel(uri: string): string {
  const url = parse(uri);
  if (!url) return uri;
  if (url.protocol === 'https:') return url.hostname;
  if (isLoopback(url)) return `this computer (${url.hostname})`;
  return uri;
}
