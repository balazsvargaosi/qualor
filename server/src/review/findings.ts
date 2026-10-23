import {
  contextHash,
  CONTEXT_LINES,
  cutAtGrapheme,
  filelessHash,
  hex32,
  LONE_SURROGATE_SOURCE,
  lineHash,
  MAX_HASHED_LINES,
  REPORT_BOUNDS,
  safeMultilineText,
  type Severity,
} from '@qualor/shared';
import { z } from 'zod';
import type { AiCategory } from '../db/schema';
import { SCOPE_MARGIN, scopeRanges, type ReviewableChange, type ReviewContext } from './context';
import type { PriorFinding } from './findings-query';
import type { MaskedText } from './masked-files';
import { REVIEW_NOTES, type JudgedFinding, type PipelineOutcome } from './pipeline';
import { aiRuleKey } from './rules';
import { ANSWER_LIMITS, type FindingSeverity } from './schemas';
import { checkReviewSuggestion, type ReviewSuggestion } from './suggestion';

/*
 * From the judge's findings to what is stored: which lines a review may raise findings on, where a
 * finding's thread sits, which earlier finding a new one is, which earlier findings are closed, and
 * the values of an issue and of its finding row. All of it is decided here without a database, from
 * the context and the outcome of the review; store.ts writes the decisions.
 */

type Reviewed = Extract<PipelineOutcome, { kind: 'reviewed' }>;

/** At most this many findings become issues in one review: the most serious come first. */
export const MAX_FINDINGS_PER_REVIEW = 40;
/** A finding and an earlier one of the same words are the same finding up to this many lines apart. */
export const PRIOR_MATCH_LINES = 20;
/** The largest line number the database holds (`integer`). */
const MAX_LINE = 2_147_483_647;
/** The columns' bounds, in characters. */
const BODY_CHARS = 2_000;
const ASSUMPTION_CHARS = 300;
/** Lines of context a report's snippet keeps either side of the flagged lines (sarif/normalize.ts). */
const SNIPPET_CONTEXT = 3;

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

/** The prior finding the judge named, when it is one of those given. */
const namedBy = (f: Matchable, prior: readonly PriorFinding[]): PriorFinding | null =>
  f.priorId === null ? null : (prior.find((p) => p.id === f.priorId) ?? null);

const distance = (f: Matchable, p: PriorFinding): number => Math.abs(f.line - p.line);

/** `a` is the closer prior finding to `f`: then an open one before a dismissed one, then the earlier. */
function closer(f: Matchable, a: PriorFinding, b: PriorFinding): boolean {
  if (distance(f, a) !== distance(f, b)) return distance(f, a) < distance(f, b);
  if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open';
  return a.line < b.line || (a.line === b.line && a.id < b.id);
}

/**
 * The prior finding that is `f` by its words and its place: the same rule (category) and path, an
 * equal fingerprint, and no more than PRIOR_MATCH_LINES lines apart; the closest if several.
 */
function nearestSame(f: Matchable, prior: readonly PriorFinding[]): PriorFinding | null {
  const fingerprint = fingerprintOf(f.category, f.path, f.title);
  let best: PriorFinding | null = null;
  for (const p of prior) {
    const same =
      p.category === f.category &&
      p.path === f.path &&
      p.fingerprint === fingerprint &&
      distance(f, p) <= PRIOR_MATCH_LINES;
    if (same && (best === null || closer(f, p, best))) best = p;
  }
  return best;
}

/**
 * The prior finding a finding is. The judge's `priorId` wins when it names one of those given (an id
 * that names none is ignored); else the rule of {@link nearestSame} decides.
 */
export function matchPrior(f: Matchable, prior: readonly PriorFinding[]): PriorFinding | null {
  return namedBy(f, prior) ?? nearestSame(f, prior);
}

/**
 * The prior finding each of `findings` is, or null. An open prior finding is one finding's: a finding
 * that names one the judge named for an earlier finding is judged by its words and place; the rest
 * are paired by their words and place, the closest pair first, so the order the judge listed them in
 * decides nothing. A dismissed prior finding can be any number of findings: each is dropped.
 */
export function matchPriors(
  findings: readonly Matchable[],
  prior: readonly PriorFinding[],
): (PriorFinding | null)[] {
  const matches: (PriorFinding | null)[] = findings.map(() => null);
  const taken = new Set<string>();
  const take = (index: number, found: PriorFinding) => {
    matches[index] = found;
    if (found.status === 'open') taken.add(found.id);
  };
  findings.forEach((f, index) => {
    const named = namedBy(f, prior);
    if (named !== null && !taken.has(named.id)) take(index, named);
  });
  for (;;) {
    const free = prior.filter((p) => p.status !== 'open' || !taken.has(p.id));
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
/** Why an earlier finding is closed: fixed, left out where the code changed, or its file deleted. */
export type CloseReason = 'fixed' | 'left_out' | 'deleted';

/** A finding that is stored, with the change it is in and where its thread sits. */
export interface PlannedFinding {
  /** The judge's finding, its lines held to the file. */
  finding: JudgedFinding;
  change: ReviewableChange | undefined;
  anchorLine: number | null;
}

export interface FindingsPlan {
  /** Findings that become issues. */
  creates: PlannedFinding[];
  /** Earlier findings, open, that the judge raised again: updated from the finding. */
  updates: { prior: PriorFinding; found: PlannedFinding }[];
  /** Earlier findings, open, that the judge found still there but did not raise again. */
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
 * Whether the lines of an earlier finding that the judge was shown and did not raise again were
 * changed, so that it may be closed: they meet the scope, or the merge request deleted the file.
 */
function leftOut(
  prior: PriorFinding,
  change: ReviewableChange | undefined,
  scope: Scope,
): CloseReason | null {
  if (change?.status === 'deleted') return 'deleted';
  return meets(scope.get(prior.path) ?? [], prior.line, prior.endLine) ? 'left_out' : null;
}

/**
 * What to store of a review. A finding of low confidence is never stored, nor more than
 * MAX_FINDINGS_PER_REVIEW, nor one that does not start on a line of its file. What the rest is:
 * - an earlier finding (named by the judge, or the same by its words and place): a dismissed one
 *   (false positive, won't fix) drops the finding, and is never raised again or reopened; an open
 *   one is updated, wherever in the file the finding is, and stays open whatever the judge says of
 *   it (the file is the earlier finding's, or one the review has a change of);
 * - otherwise a new finding, kept when its lines meet the scope and dropped when they do not.
 * An open earlier finding that no finding is: the judge's `fixed` closes it, `present` keeps it open;
 * one it was shown, and left out or could not tell, is closed only where the code changed or the file
 * is deleted. One it was not shown is left as it is.
 */
export function planFindings(
  context: Pick<ReviewContext, 'reviewed' | 'prior'>,
  outcome: Pick<Reviewed, 'findings' | 'prior' | 'shownPriorIds'>,
): FindingsPlan {
  const plan: FindingsPlan = { creates: [], updates: [], keeps: [], closes: [], dropped: [] };
  const scope = reviewScope(context.reviewed);
  const changes = new Map(context.reviewed.map((change) => [change.path, change]));
  const drop = (finding: JudgedFinding, why: DropReason) => plan.dropped.push({ finding, why });

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
  );
  const raisedAgain = new Set<string>();
  for (const [index, { finding, change }] of candidates.entries()) {
    const prior = matches[index] ?? null;
    if (prior !== null && prior.status !== 'open') {
      drop(finding, 'dismissed');
      continue;
    }
    const placed = placeFinding(finding, change, scope);
    const found: PlannedFinding = { finding, change, anchorLine: placed.anchorLine };
    if (prior !== null) {
      // The judge's id puts an earlier finding in another file only where the review has a change
      // of that file (a rename); a path from nowhere is not stored as the place of an issue.
      if (change === undefined && finding.path !== prior.path) {
        drop(finding, 'out_of_scope');
        continue;
      }
      raisedAgain.add(prior.id);
      plan.updates.push({ prior, found });
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
    if (verdict === 'fixed') {
      plan.closes.push({ prior, why: 'fixed' });
    } else if (verdict === 'present') {
      plan.keeps.push(prior);
    } else if (shown.has(prior.id)) {
      const why = leftOut(prior, changes.get(prior.path), scope);
      if (why !== null) plan.closes.push({ prior, why });
    }
  }
  return plan;
}

// ─── The values of an issue and its finding row ──────────────────────────────

/** The severity of an issue by the finding's: critical is high, major medium, minor low. */
const SEVERITY: Readonly<Record<FindingSeverity, Severity>> = {
  critical: 'high',
  major: 'medium',
  minor: 'low',
};

/** What an issue and its finding row hold of a finding. */
export interface RenderedFinding {
  category: AiCategory;
  path: string;
  startLine: number;
  endLine: number;
  /** The title: the issue's message. */
  message: string;
  severity: Severity;
  confidence: 'high' | 'medium';
  fingerprint: string;
  lineHash: string;
  contextHash: string;
  /** In ingestion's format, from the masked head file; null where there is none to read. */
  snippet: { startLine: number; lines: string[] } | null;
  body: string;
  assumption: string | null;
  verification: 'confirmed' | 'needs_validation' | null;
  suggestion: ReviewSuggestion | null;
  anchorLine: number | null;
}

const LONE_SURROGATES = new RegExp(LONE_SURROGATE_SOURCE, 'g');
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** Text a PostgreSQL column holds: a NUL and a lone surrogate become the replacement character. */
const storable = (text: string): string =>
  text.replaceAll('\u0000', REPLACEMENT_CHARACTER).replace(LONE_SURROGATES, REPLACEMENT_CHARACTER);

/** A line of the snippet: without its carriage return, cut as a report cuts it. */
function snippetLine(line: string): string {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  const max = REPORT_BOUNDS.snippetLineChars;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  // Not through the middle of a character outside the basic plane: jsonb refuses half of one.
  return `${/[\ud800-\udbff]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** The snippet a report gives a finding: its lines (at most MAX_HASHED_LINES) and some around them. */
function snippetOf(text: MaskedText, startLine: number, endLine: number) {
  const from = Math.max(1, startLine - SNIPPET_CONTEXT);
  const to = Math.min(
    text.lineCount,
    Math.min(endLine, startLine + MAX_HASHED_LINES - 1) + SNIPPET_CONTEXT,
  );
  const lines: string[] = [];
  for (let n = from; n <= to; n += 1) lines.push(snippetLine(text.line(n - 1)));
  return { startLine: from, lines };
}

/**
 * The hashes of a finding's lines, as a report's are. They read the flagged lines (at most
 * MAX_HASHED_LINES) and CONTEXT_LINES either side, and only those are cut from the text.
 */
function hashesOf(text: MaskedText, startLine: number, endLine: number) {
  const flaggedEnd = Math.min(endLine, text.lineCount, startLine + MAX_HASHED_LINES - 1);
  const first = Math.max(1, startLine - CONTEXT_LINES);
  const last = Math.min(text.lineCount, flaggedEnd + CONTEXT_LINES);
  const window: string[] = [];
  for (let n = first; n <= last; n += 1) window.push(text.line(n - 1));
  const shift = first - 1;
  return {
    lineHash: lineHash(window, startLine - shift, flaggedEnd - shift),
    contextHash: contextHash(window, startLine - shift, flaggedEnd - shift),
  };
}

/**
 * The suggestion of a finding when it may be posted: it replaces lines at or within SCOPE_MARGIN of
 * the finding's own, and passes `checkReviewSuggestion` against the masked head text `head`.
 */
function usableSuggestion(
  finding: JudgedFinding,
  change: ReviewableChange | undefined,
  head: MaskedText | null,
): ReviewSuggestion | null {
  const s = finding.suggestion;
  if (s === null || change === undefined) return null;
  if (s.endLine < finding.line - SCOPE_MARGIN || s.startLine > finding.endLine + SCOPE_MARGIN) {
    return null;
  }
  if (!checkReviewSuggestion(s, { ...change, text: head }).ok) return null;
  return { startLine: s.startLine, endLine: s.endLine, lines: [...s.lines] };
}

/**
 * The values to store for a planned finding. `category` is the rule's: the earlier finding's when the
 * judge raised it again. `head` is the masked text of the head file, or null when there is none: the
 * snippet and the hashes are made of it and of nothing else, so a secret never reaches them, and a
 * finding with no text hashes its rule, path and words as a finding with no source does.
 *
 * A finding with a suggestion that passes is anchored at the suggestion's first line, where GitLab's
 * suggestion block starts; one without is anchored where the plan put it. Texts are cut to their
 * columns.
 */
export function renderFinding(
  planned: PlannedFinding,
  category: AiCategory,
  head: MaskedText | null,
): RenderedFinding {
  const { finding, change } = planned;
  if (finding.confidence === 'low') throw new Error('a finding of low confidence is not stored');
  const message = cutAtGrapheme(storable(finding.title).trim(), ANSWER_LIMITS.titleChars);
  const assumption = storable(finding.assumption ?? '').trim();
  const readable = head !== null && finding.line <= head.lineCount ? head : null;
  const words = filelessHash(aiRuleKey(category), message, finding.path);
  const suggestion = usableSuggestion(finding, change, head);
  return {
    category,
    path: finding.path,
    startLine: finding.line,
    endLine: finding.endLine,
    message,
    severity: SEVERITY[finding.severity],
    confidence: finding.confidence,
    fingerprint: fingerprintOf(category, finding.path, finding.title),
    ...(readable === null
      ? { lineHash: words, contextHash: words, snippet: null }
      : {
          ...hashesOf(readable, finding.line, finding.endLine),
          snippet: snippetOf(readable, finding.line, finding.endLine),
        }),
    body: cutAtGrapheme(storable(finding.body), BODY_CHARS),
    assumption: assumption === '' ? null : cutAtGrapheme(assumption, ASSUMPTION_CHARS),
    verification: finding.verification,
    suggestion,
    anchorLine: suggestion === null ? planned.anchorLine : suggestion.startLine,
  };
}

// ─── The summary ─────────────────────────────────────────────────────────────

/** Text of at most `max` characters, counted as the cut counts them: whole characters. */
const upTo = (max: number) =>
  z.string().refine((value) => [...value].length <= max, `at most ${max} characters`);

/** What a run keeps of the review's summary, and what its readers can rely on. */
export const reviewSummarySchema = z.strictObject({
  verdict: upTo(ANSWER_LIMITS.verdictChars),
  walkthrough: z
    .array(upTo(ANSWER_LIMITS.walkthroughChars).min(1))
    .max(ANSWER_LIMITS.walkthroughItems),
  notes: z.array(z.enum(REVIEW_NOTES)).max(REVIEW_NOTES.length),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

/** One line of the model's, as plain text for people: no control or hidden character, bounded. */
const oneLine = (text: string, max: number): string => safeMultilineText(text.trim(), max, 1);

/** The summary of a review as the run stores it: the model's words made plain, and the notes. */
export function reviewSummary(outcome: Pick<Reviewed, 'summary' | 'notes'>): ReviewSummary {
  return reviewSummarySchema.parse({
    verdict: oneLine(outcome.summary.verdict, ANSWER_LIMITS.verdictChars),
    walkthrough: outcome.summary.walkthrough
      .map((item) => oneLine(item, ANSWER_LIMITS.walkthroughChars))
      .filter((item) => item !== '')
      .slice(0, ANSWER_LIMITS.walkthroughItems),
    notes: [...outcome.notes],
  });
}
