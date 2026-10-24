import type { IssueKind, ReportQuality, Severity } from '@qualor/shared';
import { and, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { uuidv7 } from '../db/ids';
import { AI_CATEGORIES, rules, type AiCategory } from '../db/schema';
import { AI_ENGINE } from '../rules/server-engines';

// Defined with the other engines only the server runs (rules/server-engines.ts).
export { AI_ENGINE };

/** `ai:<category>`: the key of the builtin rule of a category of AI finding. */
export function aiRuleKey(category: AiCategory): string {
  return `${AI_ENGINE}:${category}`;
}

/** The AI review's three severities. */
export type AiSeverity = 'high' | 'medium' | 'low';

/**
 * An issue's severity as the AI review's three: a review stores its critical, major and minor
 * findings as high, medium and low, and a person may raise one to blocker or lower one to info.
 */
export const AI_SEVERITY: Readonly<Record<Severity, AiSeverity>> = {
  blocker: 'high',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'low',
};

/** `severity` as the AI review's three; null for one that is none of Qualor's. */
export function aiSeverityOf(severity: string): AiSeverity | null {
  return Object.hasOwn(AI_SEVERITY, severity) ? AI_SEVERITY[severity as Severity] : null;
}

/**
 * The issue severities at which an AI finding gets an inline thread for itself: the ones that read
 * as high or medium. A low one gets a thread only for a suggestion that still applies, and is
 * otherwise counted in the summary and never listed.
 */
export const AI_THREAD_SEVERITIES: ReadonlySet<string> = new Set(
  Object.entries(AI_SEVERITY).flatMap(([severity, three]) => (three === 'low' ? [] : [severity])),
);

export interface AiRule {
  category: AiCategory;
  name: string;
  quality: ReportQuality;
  defaultSeverity: Severity;
  descriptionMd: string;
}

/** What every AI rule's description ends with: who found it, that it may be wrong, the gate. */
const NOTICE =
  'An AI review found it by reading the merge request and the repository, so it may be wrong: read the code before you act on it. Findings of the AI review never count in the quality gate.';

/** Each category's rule, with the paragraph of its description that says what it covers. */
const CATEGORY_RULES: Record<
  AiCategory,
  Omit<AiRule, 'category' | 'descriptionMd'> & { covers: string }
> = {
  logic: {
    name: 'AI review: logic error',
    quality: 'reliability',
    defaultSeverity: 'medium',
    covers:
      'The code does not do what it seems meant to do: a wrong condition, an off-by-one, a mixed-up variable, a case that is not handled, or a result that is used the wrong way.',
  },
  'error-handling': {
    name: 'AI review: missing or wrong error handling',
    quality: 'reliability',
    defaultSeverity: 'medium',
    covers:
      'An error is missed or handled wrongly: it is ignored or swallowed, turned into the wrong result, left to crash the caller, or a resource is not released when something fails.',
  },
  compatibility: {
    name: 'AI review: breaking or risky change',
    quality: 'reliability',
    defaultSeverity: 'medium',
    covers:
      'A change that can break what depends on it: a public interface, a stored or sent data format, a configuration key or a behaviour that callers, other services or older versions rely on.',
  },
  concurrency: {
    name: 'AI review: concurrency problem',
    quality: 'reliability',
    defaultSeverity: 'medium',
    covers:
      'Code that is unsafe when it runs more than once at a time: a race, a deadlock, shared state used without protection, or work that cannot safely be repeated or run in parallel.',
  },
  security: {
    name: 'AI review: security problem',
    quality: 'security',
    defaultSeverity: 'high',
    covers:
      'Code that someone could use to attack the application, its data or its users: injection, broken access control, unsafe handling of secrets or untrusted input, weak cryptography. The review may have checked the finding a second time, and the finding says what it concluded.',
  },
  performance: {
    name: 'AI review: performance problem',
    quality: 'reliability',
    defaultSeverity: 'low',
    covers:
      'Code that will be slow or costly at realistic sizes: a query or a request inside a loop, work repeated that could be done once, or an unbounded amount of data held in memory.',
  },
  tests: {
    name: 'AI review: missing or weak tests',
    quality: 'maintainability',
    defaultSeverity: 'low',
    covers:
      'The change is not tested well enough: new or changed behaviour that no test exercises, or a test that cannot fail because it does not check what matters.',
  },
  docs: {
    name: 'AI review: documentation out of date',
    quality: 'maintainability',
    defaultSeverity: 'low',
    covers:
      'Documentation that no longer matches the change: a comment, a README, an API description or a changelog that now says something other than what the code does.',
  },
};

/** The eight rules, in the order of {@link AI_CATEGORIES}. */
export const AI_RULES: readonly AiRule[] = AI_CATEGORIES.map((category) => {
  const { covers, ...rule } = CATEGORY_RULES[category];
  return { category, ...rule, descriptionMd: `${covers}\n\n${NOTICE}` };
});

/**
 * The condition that the issue whose rule column is `ruleId` is not a finding of the AI review.
 * The analyzers' numbers (measures, gate, summary lists, inline threads, fix candidates) are about
 * the analyzers' issues: review runs own the AI ones, and the issue list alone shows both.
 *
 * A NOT EXISTS on the engine's few rules, not a join, so a query that reads no rule keeps its
 * plan and the issue indexes it uses. A query that joins `rules` anyway filters its `engine_id`.
 */
export function notAiIssue(ruleId: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM rules ai_rules WHERE ai_rules.id = ${ruleId} AND ai_rules.engine_id = ${AI_ENGINE})`;
}

const KIND: IssueKind = 'issue';

/**
 * Creates the eight AI review rules when they are missing, repairs one a report created (origin
 * `reported`, before reports were barred from the `ai` engine), brings the name, description,
 * quality and default severity of a built-in one up to date when a release changed them, and
 * returns their ids by category.
 *
 * The usual path writes nothing and takes no row lock: the insert is `ON CONFLICT DO NOTHING`, the
 * repair matches only `origin = 'reported'`, and a rule is updated only when its row differs from
 * the code, so two reviews that store at once do not wait on each other. The read-back is checked:
 * rules are global, and an AI finding must never take another engine or kind.
 */
export async function ensureAiRules(db: Executor): Promise<Map<AiCategory, string>> {
  await db
    .insert(rules)
    .values(
      AI_RULES.map((r) => ({
        id: uuidv7(),
        key: aiRuleKey(r.category),
        engineId: AI_ENGINE,
        engineRuleId: r.category,
        name: r.name,
        descriptionMd: r.descriptionMd,
        languages: ['*'],
        defaultSeverity: r.defaultSeverity,
        quality: r.quality,
        kind: KIND,
        origin: 'builtin' as const,
      })),
    )
    .onConflictDoNothing({ target: rules.key });
  for (const r of AI_RULES) {
    await db
      .update(rules)
      .set({
        origin: 'builtin',
        engineId: AI_ENGINE,
        engineRuleId: r.category,
        name: r.name,
        descriptionMd: r.descriptionMd,
        helpUri: null,
        languages: ['*'],
        defaultSeverity: r.defaultSeverity,
        quality: r.quality,
        kind: KIND,
        tags: [],
        cwe: [],
        status: 'ready',
        updatedAt: sql`now()`,
      })
      .where(and(eq(rules.key, aiRuleKey(r.category)), eq(rules.origin, 'reported')));
  }
  const rows = await db
    .select({
      id: rules.id,
      key: rules.key,
      engineId: rules.engineId,
      kind: rules.kind,
      name: rules.name,
      descriptionMd: rules.descriptionMd,
      quality: rules.quality,
      defaultSeverity: rules.defaultSeverity,
    })
    .from(rules)
    .where(
      inArray(
        rules.key,
        AI_RULES.map((r) => aiRuleKey(r.category)),
      ),
    );
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const ids = new Map<AiCategory, string>();
  const stale: AiRule[] = [];
  for (const r of AI_RULES) {
    const key = aiRuleKey(r.category);
    const row = byKey.get(key);
    if (row === undefined) throw new Error(`AI rule ${key} was not created`);
    if (row.engineId !== AI_ENGINE || row.kind !== KIND) {
      throw new Error(
        `AI rule ${key} is ${row.engineId}/${row.quality}/${row.kind}, not ${AI_ENGINE}/${r.quality}/${KIND}`,
      );
    }
    if (
      row.name !== r.name ||
      row.descriptionMd !== r.descriptionMd ||
      row.quality !== r.quality ||
      row.defaultSeverity !== r.defaultSeverity
    ) {
      stale.push(r);
    }
    ids.set(r.category, row.id);
  }
  for (const r of stale) {
    await db
      .update(rules)
      .set({
        name: r.name,
        descriptionMd: r.descriptionMd,
        quality: r.quality,
        defaultSeverity: r.defaultSeverity,
      })
      .where(eq(rules.key, aiRuleKey(r.category)));
  }
  return ids;
}
