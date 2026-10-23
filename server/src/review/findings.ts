import { hex32 } from '@qualor/shared';
import type { AiCategory } from '../db/schema';
import { SCOPE_MARGIN, scopeRanges, type ReviewableChange, type ReviewContext } from './context';
import type { PriorFinding } from './findings-query';
import type { JudgedFinding, PipelineOutcome } from './pipeline';

/*
 * From the judge's findings to what is stored: which lines a review may raise findings on, where a
 * finding's thread sits, which earlier finding a new one is, and which earlier findings are closed.
 * All of it is decided here without a database, from the context and the outcome of the review;
 * findings-render.ts makes the values of what is stored, and store.ts writes them.
 */

type Reviewed = Extract<PipelineOutcome, { kind: 'reviewed' }>;

/**
 * The most findings one review stores: the first the judge listed, as it lists them most serious
 * first. The judge's answer holds no more (ANSWER_LIMITS.judgeFindings), so this bounds an outcome
 * made some other way.
 */
export const MAX_FINDINGS_PER_REVIEW = 40;
/** A finding and an earlier one of the same words are the same finding up to this many lines apart. */
export const PRIOR_MATCH_LINES = 20;
/** The largest line number the database holds (`integer`). */
const MAX_LINE = 2_147_483_647;

// ─── Scope and anchors ───────────────────────────────────────────────────────

type Ranges = readonly (readonly [number, number])[];

/** The lines a review may raise new findings on, as sorted ranges, by path. */
export type Scope = ReadonlyMap<string, Ranges>;

/**
 * The scope of a review: for each reviewed change, `scopeRanges`. A first review may raise findings
 * on the lines the change adds and where it removed lines, a re-review on the lines changed since the
 * last reviewed commit, and a change with no ranges of its own is judged as on a first review.
 */
export function reviewScope(
  reviewed: readonly ReviewableChange[],
): Map<string, [number, number][]> {
  return new Map(
    reviewed.map((change): [string, [number, number][]] => [change.path, scopeRanges(change)]),
  );
}

/** Whether lines `from` to `to` meet `ranges`, each widened by SCOPE_MARGIN lines either side. */
function meets(ranges: Ranges, from: number, to: number): boolean {
  return ranges.some(([start, end]) => from <= end + SCOPE_MARGIN && to >= start - SCOPE_MARGIN);
}

/** `a` is nearer to `line` than `b` is, the earlier line first when they are equally near. */
const nearer = (a: number, b: number, line: number): boolean =>
  Math.abs(a - line) < Math.abs(b - line) || (Math.abs(a - line) === Math.abs(b - line) && a < b);

/**
 * The added line a finding's thread sits on: the first added line of the finding's own lines, else
 * the added line nearest to its first line within SCOPE_MARGIN lines of them, else none.
 */
function anchorOf(f: { line: number; endLine: number }, added: ReadonlySet<number>): number | null {
  const low = f.line - SCOPE_MARGIN;
  const high = f.endLine + SCOPE_MARGIN;
  let inside: number | null = null;
  let beside: number | null = null;
  // The added lines are walked, not the finding's: its lines are a model's number.
  for (const line of added) {
    if (line < low || line > high) continue;
    if (line >= f.line && line <= f.endLine) {
      if (inside === null || line < inside) inside = line;
    } else if (beside === null || nearer(line, beside, f.line)) {
      beside = line;
    }
  }
  return inside ?? beside;
}

/**
 * Where a finding stands in the review: `inScope` when its lines meet the lines of the scope widened
 * by SCOPE_MARGIN (a new finding that is not is dropped), and the `anchorLine` its thread sits on,
 * which is null when no added line is near (the finding is then listed in the summary).
 */
export function placeFinding(
  f: { path: string; line: number; endLine: number },
  change: ReviewableChange | undefined,
  scope: Scope,
): { inScope: boolean; anchorLine: number | null } {
  if (change === undefined) return { inScope: false, anchorLine: null };
  return {
    inScope: meets(scope.get(change.path) ?? [], f.line, f.endLine),
    anchorLine: anchorOf(f, change.added),
  };
}

// ─── Identity ────────────────────────────────────────────────────────────────

/** A code span: a run of backticks to the next run of as many. */
const CODE_SPAN = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu;

/**
 * A title as words: lower case, code spans and digits gone, every run of what is not a letter one
 * space. Two titles of one problem agree in the words, and differ in the names, numbers and
 * punctuation a re-worded one changes.
 */
function wordsOf(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(CODE_SPAN, ' ')
    .replace(/\p{Nd}+/gu, '')
    .replace(/[^\p{L}\p{M}]+/gu, ' ')
    .trim();
}

/** The code a title names: the texts of its code spans, as a set. */
function codeOf(title: string): Set<string> {
  return new Set(
    [...title.matchAll(CODE_SPAN)].map(([span, fence]) =>
      span.slice(fence?.length ?? 0, span.length - (fence?.length ?? 0)).trim(),
    ),
  );
}

/** Two titles name the same code: the order and the repeats of the code do not matter. */
function sameCode(a: string, b: string): boolean {
  const first = codeOf(a);
  const second = codeOf(b);
  return first.size === second.size && [...first].every((span) => second.has(span));
}

/**
 * The identity of a finding across reviews, 32 hex digits: its category, its path and the words of
 * its title. A title of nothing but code and digits has no words to tell it from another, and stands
 * for itself.
 */
export function fingerprintOf(category: AiCategory, path: string, title: string): string {
  const words = wordsOf(title);
  const identity =
    words !== '' ? words : title.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
  return hex32(['ai', category, path, identity].join('\u0000'));
}

type Matchable = Pick<JudgedFinding, 'priorId' | 'category' | 'path' | 'line' | 'title'>;

/** The files that were renamed, by their new path, with the path they had. */
export type Renames = ReadonlyMap<string, string>;
const NO_RENAMES: Renames = new Map();

/**
 * The prior finding the judge named, when it is one of those given and the finding is in its file:
 * the judge's id puts an earlier finding in another file only where the file was renamed. Any other
 * id is ignored, as a forged one is, and the finding is judged by its words and its place.
 */
function namedBy(
  f: Matchable,
  prior: readonly PriorFinding[],
  renamedFrom: Renames,
): PriorFinding | null {
  const named = f.priorId === null ? undefined : prior.find((p) => p.id === f.priorId);
  if (named === undefined) return null;
  return named.path === f.path || renamedFrom.get(f.path) === named.path ? named : null;
}

const distance = (f: Matchable, p: PriorFinding): number => Math.abs(f.line - p.line);

/** `a` is the closer prior finding to `f`: then an open one before a dismissed one, then the earlier. */
function closer(f: Matchable, a: PriorFinding, b: PriorFinding): boolean {
  if (distance(f, a) !== distance(f, b)) return distance(f, a) < distance(f, b);
  if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open';
  return a.line < b.line || (a.line === b.line && a.id < b.id);
}

/**
 * The prior finding that is `f` by its words and its place: the same rule (category) and path, an
 * equal fingerprint, and no more than PRIOR_MATCH_LINES lines apart; the closest if several. A
 * dismissal is about the code its title names, and the fingerprint leaves code out, so a dismissed
 * prior finding is `f` only if their titles name the same code.
 */
function nearestSame(f: Matchable, prior: readonly PriorFinding[]): PriorFinding | null {
  const fingerprint = fingerprintOf(f.category, f.path, f.title);
  let best: PriorFinding | null = null;
  for (const p of prior) {
    const same =
      p.category === f.category &&
      p.path === f.path &&
      p.fingerprint === fingerprint &&
      distance(f, p) <= PRIOR_MATCH_LINES &&
      (p.status === 'open' || sameCode(f.title, p.title));
    if (same && (best === null || closer(f, p, best))) best = p;
  }
  return best;
}

/**
 * The prior finding a finding is. The judge's `priorId` wins when it names one of those given (see
 * {@link namedBy}); else the rule of {@link nearestSame} decides.
 */
export function matchPrior(
  f: Matchable,
  prior: readonly PriorFinding[],
  renamedFrom: Renames = NO_RENAMES,
): PriorFinding | null {
  return namedBy(f, prior, renamedFrom) ?? nearestSame(f, prior);
}

/**
 * The prior finding each of `findings` is, or null. A prior finding, open or dismissed, is one
 * finding's: a finding that names one the judge named for an earlier finding is judged by its words
 * and place; the rest are paired by their words and place, the closest pair first, so the order the
 * judge listed them in decides nothing.
 */
export function matchPriors(
  findings: readonly Matchable[],
  prior: readonly PriorFinding[],
  renamedFrom: Renames = NO_RENAMES,
): (PriorFinding | null)[] {
  const matches: (PriorFinding | null)[] = findings.map(() => null);
  const taken = new Set<string>();
  const take = (index: number, found: PriorFinding) => {
    matches[index] = found;
    taken.add(found.id);
  };
  findings.forEach((f, index) => {
    const named = namedBy(f, prior, renamedFrom);
    if (named !== null && !taken.has(named.id)) take(index, named);
  });
  for (;;) {
    const free = prior.filter((p) => !taken.has(p.id));
    let best: { index: number; found: PriorFinding; apart: number } | null = null;
    for (const [index, f] of findings.entries()) {
      if (matches[index] !== null) continue;
      const found = nearestSame(f, free);
      if (found !== null && (best === null || distance(f, found) < best.apart)) {
        best = { index, found, apart: distance(f, found) };
      }
    }
    if (best === null) return matches;
    take(best.index, best.found);
  }
}

// ─── The plan ────────────────────────────────────────────────────────────────

/** Why a finding is not stored. */
export type DropReason =
  'low_confidence' | 'over_limit' | 'bad_lines' | 'dismissed' | 'out_of_scope';
/**
 * Why an earlier finding is closed: the judge found it fixed, or the merge request deleted its file.
 * The lines of an earlier finding are of the head of the review that made it, and the lines changed
 * since the last review are of this one: nothing is closed for the lines it is on.
 */
export type CloseReason = 'fixed' | 'deleted';

/** A finding that is stored, with the change it is in and where its thread sits. */
export interface PlannedFinding {
  /** The judge's finding, its lines held to the file and its path the file has now. */
  finding: JudgedFinding;
  change: ReviewableChange | undefined;
  anchorLine: number | null;
}

export interface FindingsPlan {
  /** Findings that become issues. */
  creates: PlannedFinding[];
  /** Earlier findings, open, that the judge raised again where they can be placed on this head. */
  updates: { prior: PriorFinding; found: PlannedFinding }[];
  /**
   * Earlier findings, open, that stay as they are: the judge found them still there, or a finding
   * named them but could not be used, or raised them again where they cannot be placed.
   */
  keeps: PriorFinding[];
  closes: { prior: PriorFinding; why: CloseReason }[];
  dropped: { finding: JudgedFinding; why: DropReason }[];
}

/**
 * The finding with its lines held to the head file (to what a line number can be when the file is
 * not known), or null when it does not start on a line of it.
 */
function onTheFile(
  finding: JudgedFinding,
  change: ReviewableChange | undefined,
): JudgedFinding | null {
  const last = change?.lines ?? MAX_LINE;
  if (!Number.isSafeInteger(finding.line) || finding.line < 1 || finding.line > last) return null;
  const wanted = Number.isSafeInteger(finding.endLine) ? finding.endLine : finding.line;
  const endLine = Math.max(finding.line, Math.min(wanted, last));
  return endLine === finding.endLine ? finding : { ...finding, endLine };
}

/**
 * The reviewed changes by path, and by the path a renamed file had: an earlier finding is in the
 * file under its old name, and the judge may still use it.
 */
function changesByPath(reviewed: readonly ReviewableChange[]): Map<string, ReviewableChange> {
  const byPath = new Map<string, ReviewableChange>();
  for (const change of reviewed) if (change.oldPath !== null) byPath.set(change.oldPath, change);
  for (const change of reviewed) byPath.set(change.path, change);
  return byPath;
}

/**
 * What to store of a review. A finding of low confidence is never stored, nor more than
 * MAX_FINDINGS_PER_REVIEW, nor one that does not start on a line of its file. What the rest is:
 * - an earlier finding (named by the judge, or the same by its words and place): a dismissed one
 *   (false positive, won't fix) drops the finding, and is never raised again or reopened, one
 *   finding for each; an open one stays open whatever the judge says of it, and is updated when the
 *   finding can be placed on an added line of this head, else kept as it is;
 * - otherwise a new finding, kept when its lines meet the scope and dropped when they do not.
 * An open earlier finding that no finding is: one that a finding named stays open, whatever becomes
 * of that finding; else the judge's `fixed` closes it and `present` keeps it open. One the judge
 * left out or could not tell stays open too, unless the merge request deleted its file. One the
 * judge was not shown is left as it is.
 */
export function planFindings(
  context: Pick<ReviewContext, 'reviewed' | 'prior'>,
  outcome: Pick<Reviewed, 'findings' | 'prior' | 'shownPriorIds'>,
): FindingsPlan {
  const plan: FindingsPlan = { creates: [], updates: [], keeps: [], closes: [], dropped: [] };
  const scope = reviewScope(context.reviewed);
  const changes = changesByPath(context.reviewed);
  const renamedFrom = new Map(
    context.reviewed.flatMap((change): [string, string][] =>
      change.oldPath === null ? [] : [[change.path, change.oldPath]],
    ),
  );
  const drop = (finding: JudgedFinding, why: DropReason) => plan.dropped.push({ finding, why });

  // The ids that findings name: an open prior finding named by one stays open whatever becomes of
  // that finding. An id that is no prior finding's names nothing.
  const named = new Set(outcome.findings.map(({ priorId }) => priorId));

  const candidates: { finding: JudgedFinding; change: ReviewableChange | undefined }[] = [];
  for (const given of outcome.findings) {
    if (given.confidence === 'low') {
      drop(given, 'low_confidence');
      continue;
    }
    const change = changes.get(given.path);
    const finding = onTheFile(given, change);
    if (finding === null) drop(given, 'bad_lines');
    else if (candidates.length >= MAX_FINDINGS_PER_REVIEW) drop(given, 'over_limit');
    else candidates.push({ finding, change });
  }

  const matches = matchPriors(
    candidates.map((c) => c.finding),
    context.prior,
    renamedFrom,
  );
  const raisedAgain = new Set<string>();
  for (const [index, { finding, change }] of candidates.entries()) {
    const prior = matches[index] ?? null;
    if (prior !== null && prior.status !== 'open') {
      drop(finding, 'dismissed');
      continue;
    }
    const placed = placeFinding(finding, change, scope);
    // A finding in a renamed file is stored under the name the file has now.
    const stored =
      change === undefined || change.path === finding.path
        ? finding
        : { ...finding, path: change.path };
    const found: PlannedFinding = { finding: stored, change, anchorLine: placed.anchorLine };
    if (prior !== null) {
      raisedAgain.add(prior.id);
      // Where the new finding has no place on this head, the anchor and the suggestion of the old
      // one are all there is, and they belong to the head they were made for: nothing is rewritten.
      if (placed.anchorLine === null) plan.keeps.push(prior);
      else plan.updates.push({ prior, found });
    } else if (placed.inScope) {
      plan.creates.push(found);
    } else {
      drop(finding, 'out_of_scope');
    }
  }

  const verdicts = new Map<string, string>();
  for (const { id, status } of outcome.prior) if (!verdicts.has(id)) verdicts.set(id, status);
  const shown = new Set(outcome.shownPriorIds);
  for (const prior of context.prior) {
    if (prior.status !== 'open' || raisedAgain.has(prior.id)) continue;
    const verdict = verdicts.get(prior.id);
    if (named.has(prior.id) || verdict === 'present') {
      plan.keeps.push(prior);
    } else if (verdict === 'fixed') {
      plan.closes.push({ prior, why: 'fixed' });
    } else if (shown.has(prior.id) && changes.get(prior.path)?.status === 'deleted') {
      plan.closes.push({ prior, why: 'deleted' });
    }
  }
  return plan;
}
