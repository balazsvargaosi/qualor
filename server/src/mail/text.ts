/** Line breaks and runs of spaces as one space: a value that goes into a header. */
export function oneLine(text: string): string {
  return text
    .replaceAll('\u0000', ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** At most `max` characters (code points), never cut inside a surrogate pair. */
export function clipChars(text: string, max: number): string {
  return [...text].slice(0, max).join('');
}

/**
 * At most `maxBytes` UTF-8 bytes, cut at a whole character, without NUL (a `text` column refuses
 * it): the 1 KB columns `last_error` and `smtp_response`.
 */
export function clipUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of text.replaceAll('\u0000', '')) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}
