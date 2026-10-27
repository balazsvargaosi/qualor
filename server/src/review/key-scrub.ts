import { INVISIBLE_CHARS, JOINER_CHARS, REDACTED } from '@qualor/shared';
import { MIN_SCRUBBED_KEY_LENGTH, scrub } from '../llm/job';
import type { LlmTurn } from '../llm/providers';

/*
 * The provider's API key, taken out of what the model says (llm.md §5.2 item 2, §9.3). The model
 * never sees the key, but a repository can hold it, and what the model writes is posted to the
 * merge request: the key is scrubbed from the answer before anything is stored, returned or
 * posted, as the llm job scrubs the answer of explain, triage and fix.
 *
 * A JSON text and the value it parses to are not the same string, so the key is looked for twice.
 * A JSON string can spell any character more than one way (a `/` is also `\/`, and every
 * character has the escape of its code, `\uXXXX`), which puts the key in an answer that does not
 * contain it:
 *
 * - `scrubText` reads the answer as written, every JSON escape as the character it stands for,
 *   and replaces what spells the key where it stands. The rest of the text is not touched.
 * - `scrubKeyDeep` reads what a parser made of the answer. Whatever the parser understood by an
 *   escape (a lenient one reads more than JSON does), the strings it holds are what gets posted.
 *
 * A text can also write the key with characters between its own that a comment does not show:
 * `safePlainValue` of packages/shared deletes the invisible ones (under `codeSpan` and
 * `safeMultilineText`), and the joiners it keeps are invisible between two characters too. A key
 * split by a zero width space is the key once it is posted, so both readings skip those
 * characters, escapes of them included, between the characters of the key. A match takes in what
 * it skips and nothing before or after it.
 */

const BACKSLASH = 0x5c;
const HEX_ESCAPE = /^[0-9a-fA-F]{4}$/;

/**
 * The characters a comment leaves out or does not show: the invisible ones `safePlainValue` deletes
 * and the joiners it keeps, the lists of packages/shared (imported, so that they cannot drift).
 */
const HIDDEN = new RegExp(`[${INVISIBLE_CHARS}${JOINER_CHARS}]`, 'u');
const HIDDEN_EVERYWHERE = new RegExp(HIDDEN.source, 'gu');
/** Nothing below this code point is hidden: the soft hyphen U+00AD is the first. */
const FIRST_HIDDEN = 0xad;

/** What the short escapes of a JSON string stand for, by the character after the backslash. */
const SHORT_ESCAPES: ReadonlyMap<string, number> = new Map([
  ['"', 0x22],
  ['\\', 0x5c],
  ['/', 0x2f],
  ['b', 0x08],
  ['f', 0x0c],
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
]);

/** One character as a text spells it: as it is, or as an escape of JSON. */
interface Spelled {
  /** The UTF-16 code unit it stands for. */
  unit: number;
  /** How many characters of the text spell it. */
  length: number;
}

/**
 * The character spelled at `at`, which is where a character begins. A backslash that starts no
 * escape of JSON (the half of an escape, `\q`) stands for itself, as every other character does.
 */
function spelledAt(text: string, at: number): Spelled {
  const unit = text.charCodeAt(at);
  if (unit === BACKSLASH) {
    const after = text.charAt(at + 1);
    if (after === 'u') {
      const digits = text.slice(at + 2, at + 6);
      if (HEX_ESCAPE.test(digits)) return { unit: Number.parseInt(digits, 16), length: 6 };
    } else {
      const short = SHORT_ESCAPES.get(after);
      if (short !== undefined) return { unit: short, length: 2 };
    }
  }
  return { unit, length: 1 };
}

/**
 * How many characters of the text spell the hidden character at `at` (0 if the character there is
 * not hidden): a code point outside the basic plane is two surrogates, each written as it is or as
 * an escape, and half of a pair is no character of those lists.
 */
function hiddenLength(text: string, at: number): number {
  if (at >= text.length) return 0;
  const first = spelledAt(text, at);
  if (first.unit < FIRST_HIDDEN) return 0;
  let codePoint = first.unit;
  let length = first.length;
  if (first.unit >= 0xd800 && first.unit <= 0xdbff && at + length < text.length) {
    const second = spelledAt(text, at + length);
    if (second.unit >= 0xdc00 && second.unit <= 0xdfff) {
      codePoint = 0x10000 + ((first.unit - 0xd800) << 10) + (second.unit - 0xdc00);
      length += second.length;
    }
  }
  return HIDDEN.test(String.fromCodePoint(codePoint)) ? length : 0;
}

/** The place after the hidden characters that begin at `at`. */
function skipHidden(text: string, at: number): number {
  let next = at;
  for (let length = hiddenLength(text, next); length > 0; length = hiddenLength(text, next)) {
    next += length;
  }
  return next;
}

/**
 * Where the key ends, if the text spells it from `from` on, with hidden characters between its
 * own; -1 if it does not. `key` has none of its own (see `scrubText`).
 */
function endOfKeyAt(text: string, from: number, key: string): number {
  let at = from;
  for (let index = 0; index < key.length; index += 1) {
    if (index > 0) at = skipHidden(text, at);
    if (at >= text.length) return -1;
    const spelled = spelledAt(text, at);
    if (spelled.unit !== key.charCodeAt(index)) return -1;
    at += spelled.length;
  }
  return at;
}

/**
 * `text` with each place that spells the key, escapes and hidden characters between its own
 * included, replaced as a whole. A match begins and ends between two characters of the text, never
 * inside an escape, and everything outside the matches stays as it was written, byte for byte.
 */
function scrubSpelled(text: string, key: string): string {
  let scrubbed = '';
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    const end = endOfKeyAt(text, at, key);
    if (end < 0) {
      at += spelledAt(text, at).length;
    } else {
      scrubbed += text.slice(copied, at) + REDACTED;
      copied = end;
      at = end;
    }
  }
  return scrubbed + text.slice(copied);
}

/** Whether the text ends in an odd number of backslashes: the last one starts an escape. */
function endsInOpenEscape(text: string): boolean {
  let backslashes = 0;
  while (text.charCodeAt(text.length - 1 - backslashes) === BACKSLASH) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * `text` with each place that holds the key as it is replaced. A key whose first character makes
 * an escape with a backslash before it (`\/key`) takes that backslash with it: left behind, it
 * would turn the replacement into a bad escape, and the text into invalid JSON. Before any other
 * character, a backslash is the text's own (the half of an escape is left as it is).
 */
function scrubRaw(text: string, key: string): string {
  if (spelledAt(`\\${key.slice(0, 5)}`, 0).length === 1) return scrub(text, key);
  const parts = text.split(key);
  return parts
    .map((part, index) =>
      index < parts.length - 1 && endsInOpenEscape(part) ? part.slice(0, -1) : part,
    )
    .join(REDACTED);
}

/**
 * `text` without the key, however it is written: as it is, and with any of the escapes of a JSON
 * string for any of its characters (`\/`, `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t` and `\uXXXX`,
 * a surrogate pair included), in any mix, and with hidden characters (invisible ones and joiners,
 * escaped or not) between its characters. A key of fewer than 8 characters, and none, are not
 * looked for; nor is one of which fewer than 8 characters show, other than as it is written.
 */
export function scrubText(text: string, key: string | null): string {
  if (key === null || key.length < MIN_SCRUBBED_KEY_LENGTH) return text;
  // As it is first: a key with a backslash in it can be in the text as it stands, and the escapes
  // would read its backslash and the character after it as something else.
  const plain = scrubRaw(text, key);
  // What shows of a key that has hidden characters of its own is what a comment gives away.
  const shown = HIDDEN.test(key) ? key.replace(HIDDEN_EVERYWHERE, '') : key;
  if (shown.length < MIN_SCRUBBED_KEY_LENGTH) return plain;
  const spelledOtherwise = plain.includes('\\') || HIDDEN.test(plain) || shown !== key;
  return spelledOtherwise ? scrubSpelled(plain, shown) : plain;
}

/** A list or an object of the value, and the copy that is being filled with what is in it. */
type Pending =
  | { list: true; from: unknown[]; to: unknown[] }
  | { list: false; from: object; to: Record<string, unknown> };

/**
 * A copy of a parsed JSON value with the key taken out of every string and every name in it, at
 * every level (the value is not changed). This is the check of an answer as a parser read it,
 * for every answer parsed from what the model said (after `parseModelJson`): the strings of the
 * copy are what would be posted. A string that still spells the key with escapes, text that is
 * JSON itself, is scrubbed like the text of an answer. Two names that become the same keep the
 * later value.
 *
 * The value is walked with a list of its own, not by recursion: a parser reads a value nested far
 * deeper than a call stack follows. A key of fewer than 8 characters, and none, are not looked
 * for, and the value itself is returned.
 */
export function scrubKeyDeep(value: unknown, key: string | null): unknown {
  if (key === null || key.length < MIN_SCRUBBED_KEY_LENGTH) return value;
  const pending: Pending[] = [];
  /** The copy of an item: a scrubbed string, a primitive, or an empty list or object to fill. */
  const copy = (item: unknown): unknown => {
    if (typeof item === 'string') return scrubText(item, key);
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      const to: unknown[] = [];
      pending.push({ list: true, from: item, to });
      return to;
    }
    const to: Record<string, unknown> = {};
    pending.push({ list: false, from: item, to });
    return to;
  };
  const scrubbed = copy(value);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.list) {
      for (const item of next.from) next.to.push(copy(item));
    } else {
      for (const [name, item] of Object.entries(next.from)) {
        // Defined, not assigned: a name that is `__proto__` is a name here, as the parser made it.
        Object.defineProperty(next.to, scrubText(name, key), {
          value: copy(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }
  return scrubbed;
}

/** The turn with the key taken out of its text and of everything in its calls. */
export function scrubTurn(turn: LlmTurn, key: string | null): LlmTurn {
  if (key === null || key.length < MIN_SCRUBBED_KEY_LENGTH) return turn;
  return {
    ...turn,
    text: scrubText(turn.text, key),
    toolCalls: turn.toolCalls.map((call) => ({
      id: scrubText(call.id, key),
      name: scrubText(call.name, key),
      arguments: scrubKeyDeep(call.arguments, key),
    })),
  };
}
