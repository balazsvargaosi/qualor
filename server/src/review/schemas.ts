import { z } from 'zod';
import { AI_CATEGORIES, type AiCategory } from '../db/schema';

/*
 * The answers of a review's model, as strict schemas (llm.md §9.3): an unknown key, a value of the
 * wrong kind, a line that is not a line of a file and a text over its bound are each refused, and
 * the whole answer with them. The pipeline reads every answer with `parseModelJson`, takes the
 * provider's key out of what it read, and only then checks it here; an answer that does not pass is
 * not used (fail closed). The bounds are the ones the prompts give the model.
 */

export const FINDING_SEVERITIES = ['critical', 'major', 'minor'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];
/** What the judge says of a finding an earlier review raised. */
export const PRIOR_VERDICTS = ['present', 'fixed', 'unclear'] as const;
export type PriorStatus = (typeof PRIOR_VERDICTS)[number];
/** What the independent verification says of a serious security finding. */
export const VERIFY_VERDICTS = ['confirmed', 'needs_validation', 'rejected'] as const;
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

/** The bounds of an answer, in characters (UTF-16 code units) and items. */
export const ANSWER_LIMITS = {
  specialistFindings: 30,
  judgeFindings: 40,
  /** Every specialist finding, of four reviewers. */
  dropped: 120,
  sources: 120,
  /** A verdict for each prior finding the judge is shown (prompts.ts). */
  priorVerdicts: 50,
  pathChars: 1_024,
  titleChars: 120,
  bodyChars: 1_200,
  assumptionChars: 300,
  reasonChars: 300,
  /** A dropped finding's reason is a few words: a judge may drop many, and its answer stays short. */
  dropReasonChars: 150,
  verdictChars: 200,
  walkthroughItems: 6,
  walkthroughChars: 200,
  /** The lines a suggestion may replace; the storing of findings drops one that replaces more. */
  suggestionReplacedLines: 15,
  suggestionLines: 30,
  suggestionLineChars: 400,
  idChars: 64,
} as const;
const L = ANSWER_LIMITS;

/** A line of a file: a whole number from 1. */
const lineNumber = z.number().int().min(1);
/** Text of at most `max` characters that is not blank. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim() !== '', 'blank');
const id = z.string().min(1).max(L.idChars);

const suggestionSchema = z
  .strictObject({
    startLine: lineNumber,
    endLine: lineNumber,
    lines: z.array(z.string().max(L.suggestionLineChars)).max(L.suggestionLines),
  })
  .refine((s) => s.endLine >= s.startLine, { path: ['endLine'], message: 'before startLine' });

/** What a finding of any reviewer is made of. An optional part may be left out or null. */
const findingFields = {
  category: z.enum(AI_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  confidence: z.enum(FINDING_CONFIDENCES),
  path: text(L.pathChars),
  line: lineNumber,
  endLine: lineNumber.nullish(),
  title: text(L.titleChars),
  body: text(L.bodyChars),
  assumption: z.string().max(L.assumptionChars).nullish(),
  suggestion: suggestionSchema.nullish(),
};
const endsAfterItStarts = {
  check: (f: { line: number; endLine?: number | null }) => (f.endLine ?? f.line) >= f.line,
  params: { path: ['endLine'], message: 'before line' },
};

const findingSchema = z
  .strictObject(findingFields)
  .refine(endsAfterItStarts.check, endsAfterItStarts.params);
const judgedFindingSchema = z
  .strictObject({
    ...findingFields,
    /** The ids of the specialist findings it comes from. */
    sources: z.array(id).max(L.sources),
    /** The prior finding it is, re-emitted. */
    priorId: id.nullish(),
  })
  .refine(endsAfterItStarts.check, endsAfterItStarts.params);

export const specialistAnswerSchema = z.strictObject({
  findings: z.array(findingSchema).max(L.specialistFindings),
});

export const judgeAnswerSchema = z.strictObject({
  findings: z.array(judgedFindingSchema).max(L.judgeFindings),
  dropped: z.array(z.strictObject({ source: id, reason: text(L.dropReasonChars) })).max(L.dropped),
  prior: z
    .array(z.strictObject({ id, status: z.enum(PRIOR_VERDICTS), reason: text(L.reasonChars) }))
    .max(L.priorVerdicts),
  summary: z.strictObject({
    verdict: text(L.verdictChars),
    walkthrough: z.array(text(L.walkthroughChars)).max(L.walkthroughItems),
  }),
});

export const verifyAnswerSchema = z.strictObject({
  verdict: z.enum(VERIFY_VERDICTS),
  reason: text(L.reasonChars),
});

export type SpecialistAnswer = z.infer<typeof specialistAnswerSchema>;
export type JudgeAnswer = z.infer<typeof judgeAnswerSchema>;
export type VerifyAnswer = z.infer<typeof verifyAnswerSchema>;

/** A finding as the pipeline hands it on: its optional parts filled in. */
export interface ReviewFinding {
  category: AiCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  path: string;
  line: number;
  endLine: number;
  title: string;
  body: string;
  assumption: string | null;
  suggestion: { startLine: number; endLine: number; lines: string[] } | null;
}

/**
 * The finding an answer holds, of a specialist or of the judge, with what it left out filled in:
 * `endLine` is `line`, and a missing or blank assumption and a missing suggestion are null.
 */
export function reviewFindingOf(found: z.infer<typeof findingSchema>): ReviewFinding {
  const assumption = found.assumption ?? '';
  const suggestion = found.suggestion ?? null;
  return {
    category: found.category,
    severity: found.severity,
    confidence: found.confidence,
    path: found.path,
    line: found.line,
    endLine: found.endLine ?? found.line,
    title: found.title,
    body: found.body,
    assumption: assumption.trim() === '' ? null : assumption,
    suggestion:
      suggestion === null
        ? null
        : {
            startLine: suggestion.startLine,
            endLine: suggestion.endLine,
            lines: [...suggestion.lines],
          },
  };
}
