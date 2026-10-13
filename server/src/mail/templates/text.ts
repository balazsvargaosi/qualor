import type { SafeHtml } from './html';

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/**
 * The text a piece of markup shows: tags dropped, paragraphs and <br> kept, entities decoded once.
 * An http(s) link reads `label (URL)`, so a text-only reader can still follow it (E2's "reset your
 * password now", E3's "New issues"); a table's cells are joined with ` · `, one line per row.
 */
export function htmlToText(markup: SafeHtml): string {
  return markup
    .toString()
    .replace(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/t[dh]>\s*(?=<t[dh][\s>])/gi, ' · ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|table|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Wraps each line at `width` columns between words; a longer word (a URL) keeps a line of its own. */
export function wrapText(text: string, width = 76): string {
  return text
    .split('\n')
    .map((line) => {
      const words = line.split(/ +/).filter((w) => w !== '');
      const out: string[] = [];
      let current = '';
      for (const word of words) {
        if (current === '') current = word;
        else if (current.length + 1 + word.length <= width) current += ` ${word}`;
        else {
          out.push(current);
          current = word;
        }
      }
      if (current !== '') out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/** "Oct 13, 2026, 9:00 AM UTC", as the UI shows times. */
export function formatUtc(date: Date): string {
  return DATE_TIME.format(date);
}

/** "Oct 13, 2026" (UTC). */
export function formatDay(date: Date): string {
  return DAY.format(date);
}

/** QUALOR_PUBLIC_URL's host (and port) for the header and the reason line, or null. */
export function instanceHost(publicUrl: string | null): string | null {
  return publicUrl === null ? null : new URL(publicUrl).host;
}

/**
 * M11: a link into Qualor, keeping the public URL's path prefix (`https://example.com/qualor` +
 * `/settings/license`); null without QUALOR_PUBLIC_URL.
 */
export function publicLink(publicUrl: string | null, path: string): string | null {
  return publicUrl === null ? null : `${publicUrl}${path}`;
}

/** The reason line of the alerts for instance administrators (E1 spec). */
export function adminAlertReason(host: string | null): string {
  return `You get this because you are an instance administrator of ${host ?? 'this Qualor server'}. Turn these alerts off in Settings → Email.`;
}
