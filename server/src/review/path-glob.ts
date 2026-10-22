/*
 * The model's path filter for a search (`path_glob` of the `grep` tool). What a model writes is
 * untrusted: a glob is never turned into a regular expression or a LIKE pattern, which it could
 * write to hang the server or the database, and the work of matching it is bounded three ways: a
 * glob has at most MAX_GLOB_WILDCARDS wildcards, a path is matched by walking the positions of it
 * the glob can have reached (so the time is at most the tokens times the path, however the
 * wildcards are placed, and a path that no position reaches ends the walk), and the paths of one
 * search share a bound on the steps of all their walks (MAX_GLOB_STEPS).
 */

/** The most wildcards (`?`, `*`, `**`, `**` followed by a slash) a glob may have. */
export const MAX_GLOB_WILDCARDS = 16;
/**
 * The most steps (positions of a path looked at, characters compared) the walks of all the paths
 * of one search may take: a quarter of a second at the worst, for a glob made to be slow. A glob
 * of a few wildcards takes a few hundred steps for a path, so that a search of the 50 000 files
 * of a snapshot is far inside it.
 */
export const MAX_GLOB_STEPS = 50_000_000;

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
      if (char === '?') {
        tokens.push({ kind: 'one' });
        at += 1;
        continue;
      }
      let end = at;
      while (chars[end] === '*') end += 1;
      const segmentStart = at === 0 || chars[at - 1] === '/';
      if (end - at >= 2 && segmentStart && chars[end] === '/') {
        tokens.push({ kind: 'dirs' });
        at = end + 1;
      } else {
        tokens.push({ kind: end - at >= 2 ? 'any' : 'segment' });
        at = end;
      }
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

/** How many of the characters `chars` `text` holds from `at`, one after the other. */
function holds(text: readonly string[], at: number, chars: readonly string[]): number {
  let k = 0;
  while (k < chars.length && text[at + k] === chars[k]) k += 1;
  return k;
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
  const text = Array.from(path);
  const size = text.length;
  /** The positions of `text` the tokens so far can end at, and the positions after the next token. */
  let reach = new Uint8Array(size + 1);
  let next = new Uint8Array(size + 1);
  reach[0] = 1;
  /** The first and the last position in `reach`. */
  let lo = 0;
  let hi = 0;
  let steps = 0;
  for (const token of tokens) {
    let nextLo = size + 1;
    let nextHi = -1;
    const reached = (j: number) => {
      next[j] = 1;
      if (j < nextLo) nextLo = j;
      if (j > nextHi) nextHi = j;
    };
    switch (token.kind) {
      case 'text': {
        const length = token.chars.length;
        for (let j = lo; j <= hi; j += 1) {
          steps += 1;
          if (reach[j] !== 1 || j + length > size) continue;
          const matched = holds(text, j, token.chars);
          steps += matched;
          if (matched === length) reached(j + length);
        }
        break;
      }
      case 'one':
        for (let j = lo; j <= hi; j += 1) {
          steps += 1;
          if (reach[j] === 1 && j < size && text[j] !== '/') reached(j + 1);
        }
        break;
      case 'segment': {
        // From a reachable position on, up to and not past the next '/'.
        let open = false;
        for (let j = lo; j <= size; j += 1) {
          steps += 1;
          if (reach[j] === 1) open = true;
          if (!open) continue;
          reached(j);
          if (text[j] === '/' && j >= hi) break;
          if (text[j] === '/') open = false;
        }
        break;
      }
      case 'any':
        for (let j = lo; j <= size; j += 1) {
          steps += 1;
          reached(j);
        }
        break;
      case 'dirs': {
        // Nothing, or a run of characters that ends with the '/' just before this position.
        let open = false;
        for (let j = lo; j <= size; j += 1) {
          steps += 1;
          if (reach[j] === 1 || (open && j > 0 && text[j - 1] === '/')) reached(j);
          if (reach[j] === 1) open = true;
        }
        break;
      }
    }
    if (work !== undefined) {
      work.steps -= steps;
      steps = 0;
      if (work.steps <= 0) {
        work.exhausted = true;
        return false;
      }
    }
    // Nothing is reachable: no later token can change that.
    if (nextHi < 0) return false;
    reach.fill(0, lo, hi + 1);
    [reach, next] = [next, reach];
    lo = nextLo;
    hi = nextHi;
  }
  return reach[size] === 1;
}

/**
 * The LIKE pattern for the paths that start with `prefix`: its `\`, `%` and `_` escaped with `\`,
 * LIKE's default escape character, so that a name with an underscore or a percent sign matches
 * only itself.
 */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
}
