import { cutAtGrapheme } from '@qualor/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import {
  AI_CATEGORIES,
  analyses,
  issues,
  reviewFindings,
  rules,
  type AiCategory,
} from '../db/schema';
import { AI_ENGINE } from './rules';

/*
 * The findings a review is given besides the diff: what the analyzers already reported on the
 * merge request's files, and what an earlier review said and a person made of it. Both are read
 * from the issues of the merge request's branch. Their texts are the report's and a model's: they
 * are masked before they reach a prompt (context.ts).
 */

const MAX_ANALYZER_FINDINGS = 100;
const ANALYZER_MESSAGE_CHARS = 300;
const PRIOR_BODY_CHARS = 500;

export interface AnalyzerFinding {
  ruleKey: string;
  severity: string;
  message: string;
  path: string;
  line: number | null;
}

export interface PriorFinding {
  id: string;
  category: AiCategory;
  severity: string;
  status: 'open' | 'false_positive' | 'wont_fix';
  path: string;
  line: number;
  endLine: number;
  title: string;
  body: string;
  fingerprint: string;
}

/**
 * The open issues of the analysis' branch that the analyzers made (not engine `ai`, not duplicates)
 * on `paths`, the most severe first and at most 100. The paths go to the database as one value,
 * as a merge request can change more paths than a statement can bind values for.
 */
export async function analyzerFindings(
  db: Executor,
  analysisId: string,
  paths: readonly string[],
): Promise<AnalyzerFinding[]> {
  if (paths.length === 0) return [];
  const found = await db
    .select({
      ruleKey: rules.key,
      severity: issues.severity,
      message: issues.message,
      path: issues.path,
      line: issues.startLine,
    })
    .from(analyses)
    .innerJoin(issues, eq(issues.branchId, analyses.branchId))
    .innerJoin(rules, eq(rules.id, issues.ruleId))
    .where(
      and(
        eq(analyses.id, analysisId),
        eq(issues.status, 'open'),
        isNull(issues.duplicateOfIssueId),
        ne(rules.engineId, AI_ENGINE),
        sql`${issues.path} = ANY(${sql.param([...paths])}::text[])`,
      ),
    )
    .orderBy(
      asc(issues.severityRank),
      asc(issues.path),
      sql`${issues.startLine} ASC NULLS LAST`,
      asc(issues.id),
    )
    .limit(MAX_ANALYZER_FINDINGS);
  return found.flatMap(({ path, message, ...rest }) =>
    path === null
      ? []
      : [{ ...rest, path, message: cutAtGrapheme(message, ANALYZER_MESSAGE_CHARS) }],
  );
}

const PRIOR_STATUSES = ['open', 'false_positive', 'wont_fix'] as const;
const isPriorStatus = (status: string): status is PriorFinding['status'] =>
  PRIOR_STATUSES.some((known) => known === status);
const isAiCategory = (category: string): category is AiCategory =>
  AI_CATEGORIES.some((known) => known === category);

/**
 * The AI issues of the branch that are open or that a person dismissed (a false positive, or one
 * that will not be fixed), with the body of their finding: what a re-review re-checks, and does
 * not raise again. An issue with no place in a file is of no use to either and is left out.
 */
export async function priorAiFindings(db: Executor, branchId: string): Promise<PriorFinding[]> {
  const found = await db
    .select({
      id: issues.id,
      category: rules.engineRuleId,
      severity: issues.severity,
      status: issues.status,
      path: issues.path,
      line: issues.startLine,
      endLine: issues.endLine,
      title: issues.message,
      body: reviewFindings.body,
      fingerprint: issues.fingerprint,
    })
    .from(issues)
    .innerJoin(rules, eq(rules.id, issues.ruleId))
    .leftJoin(reviewFindings, eq(reviewFindings.issueId, issues.id))
    .where(
      and(
        eq(issues.branchId, branchId),
        eq(rules.engineId, AI_ENGINE),
        inArray(issues.status, [...PRIOR_STATUSES]),
      ),
    )
    .orderBy(asc(issues.path), asc(issues.startLine), asc(issues.id));
  return found.flatMap((row) => {
    const { path, line, category, status } = row;
    if (path === null || line === null || !isAiCategory(category) || !isPriorStatus(status)) {
      return [];
    }
    return [
      {
        id: row.id,
        category,
        severity: row.severity,
        status,
        path,
        line,
        endLine: row.endLine ?? line,
        title: row.title,
        body: cutAtGrapheme(row.body ?? '', PRIOR_BODY_CHARS),
        fingerprint: row.fingerprint,
      },
    ];
  });
}
