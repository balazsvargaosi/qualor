/**
 * Safe GitLab Markdown for comments (scm.md §6). Every value that did not come from Qualor's own
 * code goes through {@link codeSpan}: inside a code span GitLab renders no Markdown, HTML, image,
 * link, autolink, emoji, reference (`#1`, `!2`) or mention (`@all`), and a value that can never
 * contain a line break never starts a line, where GitLab would run a quick action (`/merge`).
 *
 * The guarantee, tested by the adversarial corpus of `render.test.ts`:
 * - a value is one line: every C0/C1 control (LF, CR, NEL, VT, FF, NUL...), U+2028/U+2029 and
 *   every bidirectional control becomes a space, so it can neither start a line nor reorder
 *   what a reviewer reads;
 * - invisible format characters (zero-width space, word joiner, BOM, soft hyphen, tag
 *   characters...) and blank-looking fillers (Hangul fillers, the braille blank) are removed and
 *   lone surrogates become U+FFFD; ZWJ, ZWNJ and variation selectors stay, so emoji sequences and
 *   scripts that need them render whole;
 * - it is cut to its bound in code points (never inside a grapheme when a whole one fits)
 *   before the fence is chosen, so the fence is at most bound + 1 backticks;
 * - the fence is one backtick longer than the longest run inside and padded with a space, so
 *   the value cannot close the span;
 * - bodies are shortened only at whole lines ({@link linesWithinBytes}), so no span is cut open;
 * - links are Qualor's own http(s) URLs and rules' https documentation links only
 *   ({@link qualorLink}, {@link ruleKeyMarkdown}), with the characters that could end or break a
 *   link destination percent-encoded.
 *
 * The AI review's words are the exception that reads as prose, not as a value in a code span: a
 * model's sentences are posted as text through {@link safeProse}, which keeps ordinary words plain
 * and puts every other word in a code span, so nothing it writes is more than a word to GitLab and
 * GitHub either.
 */
import {
  CONTROL_CHARS,
  cutAtGrapheme,
  INVISIBLE_CHARS,
  JOINER_CHARS,
  safeCodeSpan,
  safePlainValue,
} from '@qualor/shared';

/** Bounds of scm.md §6, in characters (code points). */
export const MAX_MESSAGE_CHARS = 300;
export const MAX_PATH_CHARS = 200;
export const MAX_VALUE_CHARS = 100;

/**
 * Unsafe characters replaced by a space, invisible ones removed, then cut to `max` code points:
 * {@link safePlainValue} of packages/shared, the one implementation the CLI uses too.
 */
export function plainValue(value: string, max: number): string {
  return safePlainValue(value, max);
}

/**
 * `value` as a CommonMark code span ({@link safeCodeSpan} of packages/shared): {@link plainValue},
 * then a backtick fence one longer than the longest backtick run inside, padded with one space on
 * each side (CommonMark strips exactly that padding, so the value shows as it is, even when it
 * starts or ends with a backtick).
 */
export function codeSpan(value: string, max: number = MAX_VALUE_CHARS): string {
  return safeCodeSpan(value, max);
}

/**
 * What prose turns into a space: the control and bidirectional characters, the invisible ones and
 * the joiners (packages/shared's lists, imported). A line break is split off before.
 */
const PROSE_UNSAFE = new RegExp(`[${CONTROL_CHARS}${INVISIBLE_CHARS}${JOINER_CHARS}]`, 'gu');
/**
 * A word of ordinary prose: a core of letters, each with the combining marks that follow it, and
 * decimal digits, with apostrophes and hyphens between its parts, one opening bracket or quote
 * before it and closing marks after it. The other kinds of number (①, ², ½, Ⅷ) are no digits to a
 * provider, and a commit hash beside one is still a hash it links: they are no plain core.
 */
const PROSE_WORD =
  /^[("“‘]?((?:\p{L}\p{M}*|\p{Nd})+(?:['’-](?:\p{L}\p{M}*|\p{Nd})+)*)([.,;:!?)"”’…]*)$/u;
/** The mark a plain word may open with, and the ones it may end in. */
const PROSE_OPENERS = '("“‘';
const PROSE_CLOSERS = '.,;:!?)"”’…';
/** The dashes of running text: plain by themselves, never stuck to a word. */
const PROSE_DASHES: ReadonlySet<string> = new Set(['—', '–']);
/** A list marker at the start of a line: `- `, `* ` or a number (at most the nine CommonMark reads) and a dot. */
const PROSE_LIST_MARKER = /^(?:[-*]|(\d{1,9})\.) +(?=\S)/;
/** Hexadecimal of a commit's size: GitLab and GitHub link it to the commit. */
const COMMIT_LIKE = /^[0-9a-f]{7,64}$/i;
/**
 * A part of a word that starts with a letter and is followed by a hyphen and a digit: `GH-26` links
 * to an issue on GitHub, and `JIRA-123`, `AB1-123` and `X9-1` to the tracker a GitLab project has set up.
 * Left plain, being words: GitLab's EWM integration matches `bug 12` and `task 3`, and ClickUp's
 * matches `CU-abc`. Both link only to the tracker the project has configured.
 */
const TRACKER_LIKE = /(?<![^-'’])\p{L}[^-'’]*-\p{Nd}/u;
/** A combining mark, which changes nothing of a word a provider reads for a link or a reference. */
const COMBINING_MARKS = /\p{M}/gu;
/** Where a hash may begin or end inside a plain core: at a hyphen, an apostrophe or a combining mark. */
const HASH_EDGES = /['’-]|\p{M}+/u;
/** A word or a model's span is cut to this many characters. */
const PROSE_SPAN_CHARS = MAX_PATH_CHARS;

/**
 * Whether `word` is plain: ordinary letters and digits that no provider turns into a link or a
 * reference. A word that is `www` and a full stop (`www. x`, `(www.) x`, `www.… x`) is not: GitHub
 * links it to `http://www` wherever a space or a bracket comes before it and whatever comes after
 * it. Only lower case links there; any case is refused.
 */
function isPlainProse(word: string): boolean {
  if (PROSE_DASHES.has(word)) return true;
  const match = PROSE_WORD.exec(word);
  if (match === null) return false;
  const marked = match[1] ?? '';
  const core = marked.replace(COMBINING_MARKS, '');
  if (core.toLowerCase() === 'www' && (match[2] ?? '').startsWith('.')) return false;
  // A hash is read both with the marks taken out of the word and as the pieces the marks split it
  // into: GitHub reads a hash beside a mark as part of a word, GitLab may not.
  const parts = [...core.split(/['’-]/), ...marked.split(HASH_EDGES)];
  return !TRACKER_LIKE.test(core) && !parts.some((part) => COMMIT_LIKE.test(part));
}

/**
 * The code span the model wrote that begins at `start` (a backtick): its content, as CommonMark
 * reads it (one space off each side when both have one and the content is not only spaces), and
 * where the span ends. A run of backticks is closed by the next run of the same length; one that
 * is never closed is no span. Null for no span.
 */
function modelSpanAt(text: string, start: number): { content: string; end: number } | null {
  let run = 0;
  while (text[start + run] === '`') run += 1;
  let from = start + run;
  for (;;) {
    const found = text.indexOf('`', from);
    if (found < 0) return null;
    let length = 0;
    while (text[found + length] === '`') length += 1;
    if (length === run) {
      const content = text.slice(start + run, found);
      const padded = content.length >= 2 && content.startsWith(' ') && content.endsWith(' ');
      return {
        content: padded && content.trim() !== '' ? content.slice(1, -1) : content,
        end: found + length,
      };
    }
    from = found + length;
  }
}

/** The word of a line that begins at `at`, as prose writes it, and where the next one may begin. */
function proseWordAt(text: string, at: number): { out: string; next: number } {
  // The model's own span, with the mark that opens before it and the marks that end after it.
  const opener =
    PROSE_OPENERS.includes(text.charAt(at)) && text[at + 1] === '`' ? text.charAt(at) : '';
  const start = at + opener.length;
  const span = text[start] === '`' ? modelSpanAt(text, start) : null;
  if (span !== null) {
    let next = span.end;
    while (next < text.length && PROSE_CLOSERS.includes(text.charAt(next))) next += 1;
    // Anything else glued to it makes the whole of it one ordinary word, below.
    if (next >= text.length || text[next] === ' ') {
      const closers = text.slice(span.end, next);
      return { out: `${opener}${codeSpan(span.content, PROSE_SPAN_CHARS)}${closers}`, next };
    }
  }
  const space = text.indexOf(' ', at);
  const end = space < 0 ? text.length : space;
  const word = text.slice(at, end);
  return { out: isPlainProse(word) ? word : codeSpan(word, PROSE_SPAN_CHARS), next: end };
}

/** One line of prose, without its list marker: plain words as they are, anything else in a code span. */
function proseWords(text: string): string {
  const words: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] === ' ') {
      at += 1;
      continue;
    }
    const word = proseWordAt(text, at);
    words.push(word.out);
    at = word.next;
  }
  return words.join(' ');
}

/** A cleaned line as prose: its list marker normalised, its words plain or in code spans. */
function proseLine(line: string): string {
  const marker = PROSE_LIST_MARKER.exec(line);
  if (marker === null) return proseWords(line);
  const prefix = marker[1] === undefined ? '- ' : `${marker[1]}. `;
  return `${prefix}${proseWords(line.slice(marker[0].length))}`;
}

/**
 * A model's sentences as text for people that GitLab and GitHub cannot read as anything but words.
 * The text is cleaned, then every line is written word by word:
 * - a line break is LF, CRLF or CR; every other control, bidirectional, invisible or joiner
 *   character, and every white space but a space, becomes a space;
 * - the text is cut to `maxChars` characters (at a grapheme boundary, with `…`) and to `maxLines`
 *   lines, and repeated blank lines become one;
 * - a line that starts with `- `, `* ` or a number and a dot becomes `- ` or `<n>. ` and keeps its
 *   rest;
 * - the backtick spans the model wrote are written again through {@link codeSpan}, with the marks
 *   that open before and end after them;
 * - every other word, as white space separates them, stays plain only when it is letters and
 *   decimal digits (apostrophes and hyphens inside, combining marks on the letters, a bracket or
 *   quote before, closing marks after) that no provider turns into a commit link, a tracker
 *   reference or a `www.` link; a dash by itself is plain too. Anything else goes in a code span,
 *   so `@x`, `#1`, `!1`, `~x`, `%x`, `&x`, `$x`, `/x`, `<x>`, `[x](y)`, `*`, `|`, `=`, `www.x`,
 *   `x.y`, `a:b`, `①` and the like are never active; a lone surrogate, which is no letter, is in a
 *   code span, where it becomes U+FFFD.
 * A line therefore starts with a letter, a digit, a backtick, an opening mark, a dash or a list
 * marker.
 *
 * Nothing it takes out is deleted: a character it removes leaves a space, so that a provider's key
 * a model split with hidden characters cannot be joined again here (the shared `codeSpan` and
 * `safePlainValue` delete the invisible ones, but they only ever see words from which this has
 * taken them already). The key itself is scrubbed when the answer is parsed (review/key-scrub.ts).
 */
export function safeProse(text: string, options: { maxChars: number; maxLines: number }): string {
  const { maxChars, maxLines } = options;
  if (maxChars < 1 || maxLines < 1) return '';
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw
      .replace(PROSE_UNSAFE, ' ')
      .replace(/[^\S ]/gu, ' ')
      .trim();
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
  }
  const cut = cutAtGrapheme(lines.join('\n').trimEnd(), maxChars).split('\n').slice(0, maxLines);
  while (cut.length > 0 && cut[cut.length - 1] === '') cut.pop();
  return cut.map(proseLine).join('\n');
}

/**
 * The longest run of whole lines, from the first, that fits in `maxBytes` of UTF-8 when joined
 * with `\n`. A line is never cut, so a code span is never left open.
 */
export function linesWithinBytes(lines: readonly string[], maxBytes: number): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  return kept.join('\n');
}

/** Characters that could end or break a Markdown link destination, or start a code span. */
const LINK_UNSAFE = /[()[\]<>`\\ "']/g;

/**
 * `[label](url)` for one of Qualor's own links (`QUALOR_PUBLIC_URL` with ids it generated) or a
 * rule's documentation link ({@link ruleKeyMarkdown}), or null when `url` is null or not a plain
 * http(s) URL. `label` is fixed text or a {@link codeSpan} (never a raw value).
 */
export function qualorLink(label: string, url: string | null): string | null {
  if (url === null || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  // Only what follows the origin is encoded: an IPv6 host keeps its brackets
  // (`http://[::1]:8080`), which WHATWG requires. An http(s) URL without credentials is its origin
  // followed by the rest. A host name WHATWG lets through with a character that could end the
  // destination (`a(b).com`) is refused rather than encoded.
  if (!parsed.href.startsWith(parsed.origin)) return null;
  const host = parsed.origin.replace(/^https?:\/\/\[[0-9a-f:.]+\]/, '');
  if (new RegExp(LINK_UNSAFE.source).test(host)) return null;
  const rest = parsed.href
    .slice(parsed.origin.length)
    .replace(LINK_UNSAFE, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `[${label}](${parsed.origin}${rest})`;
}

/** A rule documentation link longer than this (once encoded) is left out: bodies have byte bounds. */
export const MAX_RULE_LINK_CHARS = 512;
/** A key that holds none of these is safe as link text in its code span (no bracket to balance). */
const LINK_TEXT_UNSAFE = /[[\]`\\]/;

/**
 * A rule's documentation link when it is safe to show (the server-side twin of the UI's
 * `safeHelpUri`, https only): an https URL without credentials, at most
 * {@link MAX_RULE_LINK_CHARS}, with no space, control or invisible character; else null.
 */
export function ruleDocUrl(helpUri: string | null | undefined): string | null {
  if (helpUri === null || helpUri === undefined || helpUri.length > MAX_RULE_LINK_CHARS)
    return null;
  if (/\s/.test(helpUri) || plainValue(helpUri, MAX_RULE_LINK_CHARS) !== helpUri) return null;
  if (!URL.canParse(helpUri)) return null;
  const parsed = new URL(helpUri);
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
  return helpUri;
}

/**
 * A rule's key as a {@link codeSpan}, made a link to the rule's documentation when
 * {@link ruleDocUrl} accepts `helpUri`, it stays within {@link MAX_RULE_LINK_CHARS} once encoded
 * by {@link qualorLink}, and the key holds no bracket, backtick or backslash; else the plain code
 * span. The same inputs always give the same text, so a body compared with the one posted before
 * does not change needlessly.
 */
export function ruleKeyMarkdown(ruleKey: string, helpUri: string | null | undefined): string {
  const label = codeSpan(ruleKey);
  const url = ruleDocUrl(helpUri);
  if (url === null || LINK_TEXT_UNSAFE.test(ruleKey)) return label;
  const link = qualorLink(label, url);
  // `[label](destination)`: the destination is what is left after the label and four brackets.
  return link !== null && link.length - label.length - 4 <= MAX_RULE_LINK_CHARS ? link : label;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IS_UUID = new RegExp(`^${UUID}$`);
const SUMMARY_MARKER = new RegExp(`^<!-- qualor:summary (${UUID}) -->$`);
const ISSUE_MARKER = new RegExp(`^<!-- qualor:issue (${UUID}) -->$`);

function uuid(id: string): string {
  if (!IS_UUID.test(id)) throw new Error('a Qualor marker holds a UUID only');
  return id;
}

/** scm.md §5.3: the first line of a summary note. */
export function summaryMarker(projectId: string): string {
  return `<!-- qualor:summary ${uuid(projectId)} -->`;
}

/** scm.md §5.3: the first line of an inline discussion's first note. */
export function issueMarker(issueId: string): string {
  return `<!-- qualor:issue ${uuid(issueId)} -->`;
}

/**
 * github.md §6.4: the first line of the pull request review that carries a decoration's new
 * threads. Nothing reads it back: a review's body is no review comment, so it is never taken for
 * a thread ({@link markerOf} does not know it).
 */
export function reviewMarker(projectId: string): string {
  return `<!-- qualor:review ${uuid(projectId)} -->`;
}

/**
 * What a note body's first line marks, or null. Only the first line counts: a marker quoted in a
 * reply or inside a value (always on a later line) is ignored. The caller also checks the author.
 */
export function markerOf(
  body: string,
): { kind: 'summary'; projectId: string } | { kind: 'issue'; issueId: string } | null {
  const firstLine = (body.split('\n', 1)[0] ?? '').replace(/\r$/, '');
  const summary = SUMMARY_MARKER.exec(firstLine);
  if (summary?.[1]) return { kind: 'summary', projectId: summary[1] };
  const issue = ISSUE_MARKER.exec(firstLine);
  if (issue?.[1]) return { kind: 'issue', issueId: issue[1] };
  return null;
}
