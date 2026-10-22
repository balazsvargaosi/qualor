import {
  OMISSION_REASONS,
  type OmissionReason,
  type SnapshotChange as ChangeStatus,
} from '@qualor/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { reviewSnapshotFiles as files, reviewSnapshots } from '../db/schema';
import { compilePathGlob, likePrefix, newGlobWork, type PathGlob } from './path-glob';

/*
 * What the review reads of a merge request's repository: the snapshot the scanner uploaded
 * (snapshot-store.ts), as one `SnapshotReader`. The database reader answers from
 * `review_snapshot_files`, one query for each call, so a snapshot deleted while a review runs
 * (housekeeping, a newer push, a merged merge request) reads as nothing: no file, no change, no
 * hit. The memory reader holds the same snapshot in an object, for tests and the evaluation set;
 * both share one rule for lines, paths and globs (path-glob.ts), so they answer alike.
 *
 * Everything here is read-only, and nothing a model sends reaches SQL as anything but a bound value:
 * the needle of a search is compared as text (`strpos`) and a glob is matched in JavaScript; only
 * its literal prefix goes to SQL, as an escaped LIKE prefix.
 */

/** What the review knows of the snapshot it reads. */
export interface SnapshotMeta {
  /** The stored snapshot; null for one that exists only in memory (tests, the evaluation set). */
  snapshotId: string | null;
  /** The merge request's head commit, whose files the snapshot holds. */
  headSha: string;
  /** The merge base with the target branch. */
  baseSha: string;
  /** The last reviewed commit that is an ancestor of the head; null when there is none. */
  sinceSha: string | null;
  targetBranch: string;
  mrTitle: string | null;
  mrDescription: string | null;
  /** The instructions files as the merge base had them. */
  instructions: readonly { name: string; text: string }[];
  /** The scanner left files out to stay within its limits. */
  partial: boolean;
}

/** What the merge request did to a path. */
export interface SnapshotChange {
  path: string;
  /** The path before a rename; null for any other status. */
  oldPath: string | null;
  status: ChangeStatus;
  /** The unified diff against the merge base; null when it was too large to send. */
  patch: string | null;
  /** The 1-based inclusive line ranges changed since `sinceSha`; null without one. */
  since: readonly [number, number][] | null;
}

/** A file of the head commit: its text, why it has none, or no such file (a deleted one too). */
export type SnapshotFile =
  { kind: 'text'; text: string } | { kind: 'omitted'; reason: OmissionReason } | { kind: 'absent' };

export interface SnapshotReader {
  readonly meta: SnapshotMeta;
  /** The paths the merge request changed, in path order. */
  changes(): Promise<SnapshotChange[]>;
  /** The file as the snapshot stores it: its text is the scanner's, not masked again here. */
  file(path: string): Promise<SnapshotFile>;
  /**
   * The lines that hold `needle` (fixed text, case-sensitive, within one line) in the files with
   * text whose path matches `glob` (see {@link compilePathGlob}) and that `exclude` does not name,
   * in path order and line order: at most `limit` hits, and `truncated` when there are more. A
   * path `exclude` names is dropped before any text is read, so that it neither costs a read nor
   * counts towards `truncated`. A glob that takes more work than one search may (path-glob.ts)
   * ends the search early, and `truncated` says so. A hit's `text` is its line without the line
   * end, cut to {@link MAX_HIT_TEXT_CHARS}. The lines are searched, and shown, as stored: a caller
   * that shows one to a model shows its masked line (masked-files.ts), and keeps this for the
   * place of the hit.
   */
  grep(
    needle: string,
    glob: string | null,
    limit: number,
    exclude?: (path: string) => boolean,
  ): Promise<{ hits: { path: string; line: number; text: string }[]; truncated: boolean }>;
  /**
   * What is directly in `dir` (the root is `''`), sorted: at most `limit` entries, and `truncated`
   * when there are more. A file the scanner left out is listed; one the merge request deleted is
   * not (it is not in the head).
   */
  list(
    dir: string,
    limit: number,
  ): Promise<{ entries: { name: string; kind: 'file' | 'dir' }[]; truncated: boolean }>;
}

type Hits = Awaited<ReturnType<SnapshotReader['grep']>>;
type Listing = Awaited<ReturnType<SnapshotReader['list']>>;

/** The longest text of a hit the readers keep, so that a search of minified files holds no megabytes. */
export const MAX_HIT_TEXT_CHARS = 1_000;
/** Files whose text a search reads at a time. */
const FETCH_FILES = 16;

// ─── Order, lines and hits ───────────────────────────────────────────────────

/** UTF-16 units put in code point order: a surrogate (an astral character) sorts above U+FFFF. */
const rank = (unit: number): number =>
  unit < 0xd800 ? unit : unit < 0xe000 ? unit + 0x2000 : unit - 0x800;

/**
 * Orders strings by code point, as PostgreSQL's `"C"` collation orders UTF-8 text (JavaScript's
 * `<` orders UTF-16 units, which puts an astral character before U+E000–U+FFFF). The order of
 * every listing and search, whatever the collation of the database.
 */
function compareCodePoints(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return rank(x) - rank(y);
  }
  return a.length - b.length;
}

/**
 * The lines of a text, split at `\n` as git counts them: a final newline ends the last line, it
 * does not start another, so `a\n` is one line and an empty text has none.
 */
export function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line as a hit shows it: without its carriage return, and without a surrogate cut in two. */
function hitText(line: string): string {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text.length <= MAX_HIT_TEXT_CHARS) return text;
  const cut = text.slice(0, MAX_HIT_TEXT_CHARS);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The files a search is about, in path order. */
interface Search {
  paths: readonly string[];
  /** False when the work bound of the glob ended the walk: the paths after the last are unknown. */
  complete: boolean;
}

/**
 * The paths of `sorted` (the files that hold the needle, in path order) a search is about: those
 * `exclude` does not name and the glob matches. An excluded path costs no walk of the glob. Walking
 * the glob over the paths is bounded (path-glob.ts), and the paths come in order, so a walk that is
 * cut short has found the first of them.
 */
function selectPaths(
  sorted: readonly string[],
  glob: PathGlob | null,
  exclude: ((path: string) => boolean) | undefined,
): Search {
  const work = newGlobWork();
  const paths: string[] = [];
  for (const path of sorted) {
    if (exclude?.(path) === true) continue;
    if (glob !== null && !glob.matches(path, work)) {
      if (work.exhausted) return { paths, complete: false };
      continue;
    }
    paths.push(path);
  }
  return { paths, complete: true };
}

/**
 * The hits of a search once SQL (or the memory reader) has named its files: those files read in
 * groups, in path order, their lines scanned for the needle until there is one hit more than
 * `limit`. A file that has gone since it was named is skipped.
 */
async function collectHits(
  search: Search,
  textsOf: (paths: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  needle: string,
  limit: number,
): Promise<Hits> {
  const hits: Hits['hits'] = [];
  for (let from = 0; from < search.paths.length; from += FETCH_FILES) {
    const group = search.paths.slice(from, from + FETCH_FILES);
    const texts = await textsOf(group);
    for (const path of group) {
      const lines = linesOf(texts.get(path) ?? '');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.includes(needle)) continue;
        if (hits.length === limit) return { hits, truncated: true };
        hits.push({ path, line: index + 1, text: hitText(line) });
      }
    }
  }
  return { hits, truncated: !search.complete };
}

/** The entries directly in `dir`, from every path of the head: the memory reader's `list`. */
function childrenOf(paths: Iterable<string>, dir: string, limit: number): Listing {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, boolean>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    children.set(name, (children.get(name) ?? false) || slash !== -1);
  }
  const names = [...children.keys()].sort(compareCodePoints);
  return {
    entries: names.slice(0, limit).map((name) => ({
      name,
      kind: children.get(name) === true ? 'dir' : 'file',
    })),
    truncated: names.length > limit,
  };
}

// ─── The snapshot in memory ──────────────────────────────────────────────────

/**
 * A snapshot held in an object: for tests and the evaluation set. `files` is by path; an `absent`
 * entry is no file. The answers are those of the database reader, for the same snapshot.
 */
export function memorySnapshotReader(input: {
  meta: SnapshotMeta;
  changes: SnapshotChange[];
  files: Record<string, SnapshotFile>;
}): SnapshotReader {
  // A Map, not the object: a path such as `constructor` or `__proto__` must not read a property.
  const held = new Map(Object.entries(input.files).filter(([, file]) => file.kind !== 'absent'));
  return {
    meta: input.meta,
    changes: () =>
      Promise.resolve(
        input.changes
          .map((change) => ({ ...change }))
          .sort((a, b) => compareCodePoints(a.path, b.path)),
      ),
    file: (path) => Promise.resolve(held.get(path) ?? { kind: 'absent' }),
    grep: (needle, glob, limit, exclude) => {
      const texts = new Map<string, string>();
      for (const [path, file] of held) {
        if (file.kind === 'text' && file.text.includes(needle)) texts.set(path, file.text);
      }
      const sorted = [...texts.keys()].sort(compareCodePoints);
      const search = selectPaths(sorted, glob === null ? null : compilePathGlob(glob), exclude);
      return collectHits(search, () => Promise.resolve(texts), needle, limit);
    },
    list: (dir, limit) => Promise.resolve(childrenOf(held.keys(), dir, limit)),
  };
}

// ─── The stored snapshot ─────────────────────────────────────────────────────

const isOmissionReason = (value: string): value is OmissionReason =>
  OMISSION_REASONS.some((reason) => reason === value);

/** Paths in code point order, whatever the collation of the database. */
const byPath = sql`${files.path} COLLATE "C"`;

/**
 * The reader of a stored snapshot, or null when there is none or it is not `ready` (still an
 * upload, or refused). The reader keeps nothing of the snapshot but its meta: each call is a query
 * of its own, which finds nothing once the snapshot has been deleted.
 */
export async function openSnapshotReader(
  db: Executor,
  snapshotId: string,
): Promise<SnapshotReader | null> {
  const [row] = await db
    .select({
      status: reviewSnapshots.status,
      headSha: reviewSnapshots.headSha,
      baseSha: reviewSnapshots.baseSha,
      sinceSha: reviewSnapshots.sinceSha,
      targetBranch: reviewSnapshots.targetBranch,
      mrTitle: reviewSnapshots.mrTitle,
      mrDescription: reviewSnapshots.mrDescription,
      instructions: reviewSnapshots.instructions,
      partial: reviewSnapshots.partial,
    })
    .from(reviewSnapshots)
    .where(eq(reviewSnapshots.id, snapshotId));
  // Unpacking sets the head, the base and the target branch with the status.
  if (row?.status !== 'ready') return null;
  const { headSha, baseSha, targetBranch } = row;
  if (headSha === null || baseSha === null || targetBranch === null) return null;
  const meta: SnapshotMeta = {
    snapshotId,
    headSha,
    baseSha,
    sinceSha: row.sinceSha,
    targetBranch,
    mrTitle: row.mrTitle,
    mrDescription: row.mrDescription,
    instructions: row.instructions.map(({ name, text }) => ({ name, text })),
    partial: row.partial,
  };
  const inSnapshot = eq(files.snapshotId, snapshotId);
  /** The files the last search named. */
  let lastSearch:
    { key: string; exclude: ((path: string) => boolean) | undefined; search: Search } | undefined;

  return {
    meta,

    async changes() {
      const rows = await db
        .select({
          path: files.path,
          oldPath: files.oldPath,
          status: files.change,
          patch: files.patch,
          since: files.since,
        })
        .from(files)
        .where(and(inSnapshot, isNotNull(files.change)))
        .orderBy(byPath);
      return rows.flatMap(({ status, ...rest }) => (status === null ? [] : [{ ...rest, status }]));
    },

    async file(path) {
      const [stored] = await db
        .select({ text: files.text, omitted: files.omitted })
        .from(files)
        .where(and(inSnapshot, eq(files.path, path)));
      if (stored === undefined) return { kind: 'absent' };
      if (stored.text !== null) return { kind: 'text', text: stored.text };
      if (stored.omitted !== null && isOmissionReason(stored.omitted)) {
        return { kind: 'omitted', reason: stored.omitted };
      }
      // A path with a change and nothing else: a file the merge request deleted.
      return { kind: 'absent' };
    },

    async grep(needle, glob, limit, exclude) {
      // A search that asks again for more (its caller dropped some hits) has its files already.
      const key = JSON.stringify([needle, glob]);
      let search =
        lastSearch?.key === key && lastSearch.exclude === exclude ? lastSearch.search : undefined;
      if (search === undefined) {
        const compiled = glob === null ? null : compilePathGlob(glob);
        const prefix = compiled?.prefix ?? '';
        // `strpos` is false for a row without text. The literal start of the glob narrows the
        // files; the glob itself is matched on the paths this finds, in their order.
        const named = await db
          .select({ path: files.path })
          .from(files)
          .where(
            and(
              inSnapshot,
              sql`strpos(${files.text}, ${needle}) > 0`,
              prefix === '' ? undefined : sql`${files.path} LIKE ${likePrefix(prefix)}`,
            ),
          )
          .orderBy(byPath);
        search = selectPaths(
          named.map((row) => row.path),
          compiled,
          exclude,
        );
        lastSearch = { key, exclude, search };
      }
      return collectHits(
        search,
        async (paths) => {
          const rows = await db
            .select({ path: files.path, text: files.text })
            .from(files)
            .where(and(inSnapshot, inArray(files.path, [...paths])));
          return new Map(rows.flatMap((row) => (row.text === null ? [] : [[row.path, row.text]])));
        },
        needle,
        limit,
      );
    },

    async list(dir, limit) {
      const prefix = dir === '' ? '' : `${dir}/`;
      // The part of a path after `dir/` (substr counts characters), up to its next '/'.
      const rest = sql`substr(${files.path}, ${Array.from(prefix).length + 1})`;
      const result = await db.execute<{ name: string; is_dir: boolean }>(sql`
        SELECT split_part(${rest}, '/', 1) COLLATE "C" AS name,
               bool_or(strpos(${rest}, '/') > 0) AS is_dir
          FROM ${files}
         WHERE ${inSnapshot}
           AND (${files.text} IS NOT NULL OR ${files.omitted} IS NOT NULL)
           ${prefix === '' ? sql`` : sql`AND ${files.path} LIKE ${likePrefix(prefix)}`}
         GROUP BY 1
         ORDER BY 1
         LIMIT ${limit + 1}`);
      return {
        entries: result.rows
          .slice(0, limit)
          .map((row) => ({ name: row.name, kind: row.is_dir ? 'dir' : 'file' })),
        truncated: result.rows.length > limit,
      };
    },
  };
}
