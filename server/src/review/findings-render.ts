import {
  contextHash,
  CONTEXT_LINES,
  cutAtGrapheme,
  filelessHash,
  LONE_SURROGATE_SOURCE,
  lineHash,
  MAX_HASHED_LINES,
  REPORT_BOUNDS,
  safeMultilineText,
  type Severity,
} from '@qualor/shared';
import type { AiCategory } from '../db/schema';
import { SCOPE_MARGIN, type ReviewableChange } from './context';
import { fingerprintOf, type PlannedFinding } from './findings';
import type { MaskedText } from './masked-files';
import type { JudgedFinding, PipelineOutcome } from './pipeline';
import { aiRuleKey } from './rules';
import {
  ANSWER_LIMITS,
  reviewSummarySchema,
  type FindingSeverity,
  type ReviewSummary,
} from './schemas';
import { checkReviewSuggestion, type ReviewSuggestion } from './suggestion';

/*
 * What an issue of the AI review and its finding row hold of a finding, and what a run keeps of the
 * review's summary: the model's texts cut to their columns and made storable, the snippet and the
 * hashes of the masked head file as a report's are made, the suggestion when it may be posted, and
 * the summary as plain text. Which findings are stored is decided in findings.ts; store.ts writes.
 */

type Reviewed = Extract<PipelineOutcome, { kind: 'reviewed' }>;

/** The columns' bounds, in characters. */
const BODY_CHARS = 2_000;
const ASSUMPTION_CHARS = 300;
/** Lines of context a report's snippet keeps either side of the flagged lines (sarif/normalize.ts). */
const SNIPPET_CONTEXT = 3;

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

// What a run keeps of the review's summary is `reviewSummarySchema` (schemas.ts).
export { reviewSummarySchema, type ReviewSummary };

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
