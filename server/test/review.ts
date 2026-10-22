import { hex32 } from '@qualor/shared';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../src/db/client';
import { first } from '../src/db/rows';
import { branches, issues, type AiCategory } from '../src/db/schema';
import { AI_RULES, ensureAiRules } from '../src/review/rules';

export interface AiIssueSeed {
  branchId: string;
  category: AiCategory;
  path: string;
  line: number;
  /** The rule's default severity unless given. */
  severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
  status?: 'open' | 'resolved' | 'wont_fix' | 'false_positive' | 'closed';
  snippet?: unknown;
}

let seedCounter = 0;

/**
 * Inserts one issue of engine `ai` on a branch, as a review run leaves it: the category's builtin
 * rule (created when missing), the rule's quality, in new code, no duplicate, `high` confidence.
 * The issue alone: no `review_findings` row and no run. Returns its id.
 */
export async function seedAiIssue(db: Executor, seed: AiIssueSeed): Promise<string> {
  seedCounter += 1;
  const branch = first(
    await db
      .select({ projectId: branches.projectId })
      .from(branches)
      .where(eq(branches.id, seed.branchId)),
  );
  const ruleId = (await ensureAiRules(db)).get(seed.category);
  const rule = AI_RULES.find((r) => r.category === seed.category);
  if (ruleId === undefined || rule === undefined) throw new Error(`no AI rule ${seed.category}`);
  const status = seed.status ?? 'open';
  const row = first(
    await db
      .insert(issues)
      .values({
        projectId: branch.projectId,
        branchId: seed.branchId,
        ruleId,
        fingerprint: hex32(`ai-fp:${seedCounter}`),
        lineHash: hex32(`ai-line:${seedCounter}`),
        contextHash: hex32(`ai-context:${seedCounter}`),
        path: seed.path,
        startLine: seed.line,
        endLine: seed.line,
        message: `AI finding ${seedCounter}`,
        severity: seed.severity ?? rule.defaultSeverity,
        quality: rule.quality,
        kind: 'issue',
        status,
        inNewCode: true,
        confidence: 'high',
        snippet: seed.snippet ?? null,
        firstSeenAt: sql`now()`,
        closedAt: status === 'closed' ? sql`now()` : null,
      })
      .returning({ id: issues.id }),
  );
  return row.id;
}
