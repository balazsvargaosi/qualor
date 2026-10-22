import { cutAtGrapheme, LONE_SURROGATE_SOURCE, REDACTED, redactLongText } from '@qualor/shared';

// The masking of a text of any length is the shared one; the review snapshot's other modules and
// the tests of this one read it here.
export { redactLongText };

/*
 * The masking of the repository snapshot of a merge request (6I-2): every text the snapshot sends
 * (files, patches, instructions files, the merge request's title and description) has the secrets
 * the analyzers found replaced with «redacted», then goes through the shared redaction that the
 * server also runs before a prompt leaves (llm.md §5.2).
 */

/** A shorter secret is too likely to be ordinary text: the bound the report's scrubbing uses. */
const MIN_SECRET_CHARS = 8;

export interface Redacted {
  text: string;
  /** Replacements made. */
  count: number;
}

const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** `secret` with its line ends as LF: a scan of a CRLF working tree, a commit that holds LF. */
const withLf = (secret: string): string => secret.split('\n').map(withoutCr).join('\n');

/**
 * The secrets worth masking: 8 characters or more, once each, the longest first. Each comes as
 * found and with its line ends as LF, since the analyzers read the working tree (CRLF in a
 * Windows checkout) and the snapshot the commit.
 */
export function prepareSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((s) => [s, withLf(s)]))]
    .filter((s) => s.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length);
}

/**
 * The lines of every multi-line secret, trimmed (so a copy indented anew matches too), each of 8
 * characters or more that are not blank (a run of spaces is no secret): a patch shows a secret's
 * lines apart, each behind its `+`, `-` or space, so the whole never occurs in it.
 */
export function secretLines(secrets: readonly string[]): string[] {
  const lines = secrets
    .filter((s) => s.includes('\n'))
    .flatMap((s) => s.split('\n').map((line) => line.trim()))
    .filter((line) => line.replace(/\s/g, '').length >= MIN_SECRET_CHARS);
  return [...new Set(lines)];
}

/**
 * Every occurrence of every secret replaced by «redacted». The occurrences are found in the text as
 * it is and merged where they overlap or touch, so two secrets that share characters leave no
 * piece of either behind (replacing one first would hide the other).
 */
export function maskSecrets(text: string, secrets: readonly string[]): Redacted {
  const spans: [number, number][] = [];
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      spans.push([at, at + secret.length]);
    }
  }
  if (spans.length === 0) return { text, count: 0 };
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let count = 0;
  let from = 0;
  let span: [number, number] = spans[0] ?? [0, 0];
  for (const next of spans.slice(1)) {
    if (next[0] <= span[1]) {
      span = [span[0], Math.max(span[1], next[1])];
      continue;
    }
    out += text.slice(from, span[0]) + REDACTED;
    count += 1;
    from = span[1];
    span = next;
  }
  out += text.slice(from, span[0]) + REDACTED + text.slice(span[1]);
  return { text: out, count: count + 1 };
}

/** The analyzers' secrets masked, then the shared redaction (over a text of any length). */
export function redactSnapshotText(text: string, secrets: readonly string[]): Redacted {
  const masked = maskSecrets(text, secrets);
  const redacted = redactLongText(masked.text);
  return { text: redacted.text, count: masked.count + redacted.count };
}

const LONE_SURROGATE = new RegExp(LONE_SURROGATE_SOURCE, 'g');

/**
 * The merge request's title or description as the header sends it: without NUL characters and
 * lone surrogates (neither can be stored), redacted, then cut to `maxChars` code points, after the
 * masking so no half of a secret is left at the cut.
 */
export function mergeRequestText(
  text: string | null,
  maxChars: number,
  secrets: readonly string[],
): { text: string | null; count: number } {
  if (text === null) return { text: null, count: 0 };
  const clean = text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '');
  const redacted = redactSnapshotText(clean, secrets);
  return { text: cutAtGrapheme(redacted.text, maxChars), count: redacted.count };
}
