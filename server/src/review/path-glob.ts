/*
 * The model's path filter for a search (`path_glob` of the `grep` tool). What a model writes is
 * untrusted: a glob is never turned into a regular expression or a LIKE pattern, which it could
 * write to hang the server or the database, and the work of matching it is bounded three ways: a
 * glob has at most MAX_GLOB_WILDCARDS wildcards, a path is matched by walking the positions of it
 * the glob can have reached (so the time is at most the tokens times the path, however the
 * wildcards are placed, and a path that no position reaches ends the walk), and the paths of one
 * search share a bound on the steps of all their walks (MAX_GLOB_STEPS), a path's own length
 * charged before its tokens are.
 */

/** The most wildcards (`?`, `*`, `**`, `**` followed by a slash) a glob may have. */
export const MAX_GLOB_WILDCARDS = 16;
/**
 * The most steps the walks of all the paths of one search may take: the length of each path, the
 * positions of it a token looks at and the characters it compares. The slowest globs and paths
 * measured (16 wildcards over paths of 1 000 characters) take 5 ms for a million steps, so this is
 * about a tenth of a second at the worst. A plain glob takes about 300 steps for a path of a
 * hundred characters, so that a search over the 50 000 files of a snapshot is inside it.
 */
export const MAX_GLOB_STEPS = 20_000_000;

/** What is left of the work bound of one search. */
export interface GlobWork {
  steps: number;
  /** A walk was refused or cut short for want of steps: the paths after it were not matched. */
  exhausted: boolean;
}

export const newGlobWork = (): GlobWork => ({ steps: MAX_GLOB_STEPS, exhausted: false });

type GlobToken =
  /** A run of literal characters (code points). */
  | { kind: 'text'; chars: readonly string[] }
  | { kind: 'one' }
  | { kind: 'segment' }
  | { kind: 'any' }
  | { kind: 'dirs' };

export interface PathGlob {
  /** The literal text the glob starts with: every path it matches starts with it. */
  readonly prefix: string;
  /** Its wildcards: `?`, `*`, `**` and `**` followed by a slash each count one. */
  readonly wildcards: number;
  /**
   * Whether the glob matches `path`. With `work`, the walk is charged to it; once it is out of
   * steps `work.exhausted` is set and every later call answers false without a walk.
   */
  matches(path: string, work?: GlobWork): boolean;
}

/**
 * `?` is one character and `*` any run of characters within a path segment. `**` is any run of
 * characters, across segments; as a segment of its own followed by a slash it may also be
 * nothing, so that the glob with `**` between `src/` and `/c.ts` takes `src/c.ts` as well as
 * `src/a/b/c.ts`. Every other character is itself, case included: there are no classes, no
 * braces and no escapes.
 */
export function compilePathGlob(glob: string): PathGlob {
  const chars = Array.from(glob);
  const tokens: GlobToken[] = [];
  let prefix = '';
  let literal = true;
  let wildcards = 0;
  let run: string[] = [];
  const endRun = () => {
    if (run.length > 0) tokens.push({ kind: 'text', chars: run });
    run = [];
  };
  let at = 0;
  while (at < chars.length) {
    const char = chars[at] ?? '';
    if (char === '*' || char === '?') {
      endRun();
      literal = false;
      wildcards += 1;
      const wildcard = wildcardAt(chars, at);
      tokens.push(wildcard.token);
      at = wildcard.next;
    } else {
      run.push(char);
      if (literal) prefix += char;
      at += 1;
    }
  }
  endRun();
  return {
    prefix,
    wildcards,
    matches: (path, work) => globMatches(tokens, path, work),
  };
}

/** The wildcard that starts at `at` (a `*` or a `?`), and where the glob goes on after it. */
function wildcardAt(chars: readonly string[], at: number): { token: GlobToken; next: number } {
  if (chars[at] === '?') return { token: { kind: 'one' }, next: at + 1 };
  let end = at;
  while (chars[end] === '*') end += 1;
  const segmentStart = at === 0 || chars[at - 1] === '/';
  if (end - at >= 2 && segmentStart && chars[end] === '/') {
    return { token: { kind: 'dirs' }, next: end + 1 };
  }
  return { token: { kind: end - at >= 2 ? 'any' : 'segment' }, next: end };
}

/** How many of the characters `chars` `text` holds from `at`, one after the other. */
function holds(text: string | readonly string[], at: number, chars: readonly string[]): number {
  let k = 0;
  while (k < chars.length && text[at + k] === chars[k]) k += 1;
  return k;
}

/**
 * The positions of a path the walk of a glob has reached so far, and the positions after the token
 * it is walking: one array each, kept between walks so that a walk allocates nothing. Both are all
 * zero between walks.
 */
let reachScratch = new Uint8Array(1_100);
let nextScratch = new Uint8Array(1_100);

/** A UTF-16 surrogate: a path with none is read by position, and one with a pair by character. */
const SURROGATE = new RegExp(`[${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdfff)}]`);

/**
 * One walk of a path: the positions reached so far (`reach`, from `lo` to `hi`) and the positions
 * after the token being walked (`next`, from `nextLo` to `nextHi`, which is -1 while there are
 * none). The positions of `next` are marked in order.
 */
interface Walk {
  text: string | readonly string[];
  size: number;
  reach: Uint8Array;
  next: Uint8Array;
  lo: number;
  hi: number;
  nextLo: number;
  nextHi: number;
}

/** Marks the position `j` as reached by the token being walked. */
function markNext(walk: Walk, j: number): void {
  walk.next[j] = 1;
  if (walk.nextHi < 0) walk.nextLo = j;
  walk.nextHi = j;
}

/** Charges `steps` to the work of the search: false once it is out of them. */
function charge(work: GlobWork, steps: number): boolean {
  work.steps -= steps;
  if (work.steps > 0) return true;
  work.exhausted = true;
  return false;
}

/** Walks a run of literal characters; returns the steps taken. */
function walkText(walk: Walk, chars: readonly string[]): number {
  const { reach, text, size } = walk;
  const length = chars.length;
  let steps = 0;
  for (let j = walk.lo; j <= walk.hi; j += 1) {
    steps += 1;
    if (reach[j] !== 1 || j + length > size) continue;
    const matched = holds(text, j, chars);
    steps += matched;
    if (matched === length) markNext(walk, j + length);
  }
  return steps;
}

/** Walks a `?`: any one character but a slash. */
function walkOne(walk: Walk): number {
  const { reach, text, size } = walk;
  let steps = 0;
  for (let j = walk.lo; j <= walk.hi; j += 1) {
    steps += 1;
    if (reach[j] === 1 && j < size && text[j] !== '/') markNext(walk, j + 1);
  }
  return steps;
}

/** Walks a `*`: from a reachable position on, up to and not past the next '/'. */
function walkSegment(walk: Walk): number {
  const { reach, text, size } = walk;
  let steps = 0;
  let open = false;
  for (let j = walk.lo; j <= size; j += 1) {
    steps += 1;
    if (reach[j] === 1) open = true;
    if (!open) continue;
    markNext(walk, j);
    if (text[j] === '/') {
      if (j >= walk.hi) break;
      open = false;
    }
  }
  return steps;
}

/** Walks a `**`: every position from the first reached on. */
function walkAny(walk: Walk): number {
  walk.next.fill(1, walk.lo, walk.size + 1);
  walk.nextLo = walk.lo;
  walk.nextHi = walk.size;
  return walk.size - walk.lo + 1;
}

/** Walks a `**` and its slash: nothing, or a run of characters that ends with the '/' just before the position. */
function walkDirs(walk: Walk): number {
  const { reach, text, size } = walk;
  let steps = 0;
  let open = false;
  for (let j = walk.lo; j <= size; j += 1) {
    steps += 1;
    if (reach[j] === 1 || (open && j > 0 && text[j - 1] === '/')) markNext(walk, j);
    if (reach[j] === 1) open = true;
  }
  return steps;
}

/** Walks one token from the positions reached; returns the steps taken. */
function walkToken(walk: Walk, token: GlobToken): number {
  switch (token.kind) {
    case 'text':
      return walkText(walk, token.chars);
    case 'one':
      return walkOne(walk);
    case 'segment':
      return walkSegment(walk);
    case 'any':
      return walkAny(walk);
    case 'dirs':
      return walkDirs(walk);
  }
}

function globMatches(
  tokens: readonly GlobToken[],
  path: string,
  work: GlobWork | undefined,
): boolean {
  if (work !== undefined && (work.exhausted || work.steps <= 0)) {
    work.exhausted = true;
    return false;
  }
  const text: string | readonly string[] = SURROGATE.test(path) ? Array.from(path) : path;
  const size = text.length;
  // Looking at a path costs its length, before a token is walked: the walk of a path that no token
  // takes anywhere is as long as that.
  if (work !== undefined && !charge(work, size)) return false;
  if (reachScratch.length < size + 1) {
    reachScratch = new Uint8Array(2 * (size + 1));
    nextScratch = new Uint8Array(2 * (size + 1));
  }
  const walk: Walk = {
    text,
    size,
    reach: reachScratch,
    next: nextScratch,
    lo: 0,
    hi: 0,
    nextLo: 0,
    nextHi: -1,
  };
  walk.reach[0] = 1;
  try {
    for (const token of tokens) {
      walk.nextLo = size + 1;
      walk.nextHi = -1;
      const steps = walkToken(walk, token);
      if (work !== undefined && !charge(work, steps)) return false;
      // Nothing is reachable: no later token can change that.
      if (walk.nextHi < 0) return false;
      walk.reach.fill(0, walk.lo, walk.hi + 1);
      [walk.reach, walk.next] = [walk.next, walk.reach];
      walk.lo = walk.nextLo;
      walk.hi = walk.nextHi;
      walk.nextHi = -1;
    }
    return walk.reach[size] === 1;
  } finally {
    // The scratch is clean for the next walk, whichever way this one ended.
    walk.reach.fill(0, walk.lo, walk.hi + 1);
    if (walk.nextHi >= 0) walk.next.fill(0, walk.nextLo, walk.nextHi + 1);
  }
}

/**
 * The LIKE pattern for the paths that start with `prefix`: its `\`, `%` and `_` escaped with `\`,
 * LIKE's default escape character, so that a name with an underscore or a percent sign matches
 * only itself.
 */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
}
