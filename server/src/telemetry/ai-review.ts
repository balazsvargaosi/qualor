import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { ownModel, type StoredLlmSettings, type StoredProvider } from '../llm/settings';
import { organizationReviewInactive, reviewActive } from '../review/settings';

/**
 * The model provider as the report names it (R39): its kind and, for OpenAI, its API. Never its
 * address or its models.
 */
export type AiProviderToken = 'none' | 'anthropic' | 'openai_chat_completions' | 'openai_responses';

/** telemetry.md `aiReview`: how AI review is used, in counts and flags only (schema 2). */
export interface AiReviewUsage {
  /** The existing organisations whose review runs: on, with a consent that covers the provider. */
  organizations: number;
  /** The projects AI review runs for (`reviewActive`). */
  projects: number;
  provider: AiProviderToken;
  /** Whether the strong and the fast tier have a model of their own (`ownModel`). */
  tiers: { strong: boolean; fast: boolean };
  /** The runs that ended in the last 30 days, by how they ended. */
  reviews30d: { done: number; skipped: number; failed: number; superseded: number };
  /** The AI findings raised in the last 30 days. */
  findings30d: number;
  /** Those of them placed on a changed line (`anchor_line`), not the threads posted. */
  inline30d: number;
  /** Those of them with a one-click suggestion. */
  suggestions30d: number;
  /** The replies answered in the last 30 days, and those that changed a status. */
  replies30d: { answered: number; statusChanges: number };
  /** The `qualor review`, `fix` and `stop` commands handled in the last 30 days. */
  commands30d: { review: number; fix: number; stop: number };
}

/**
 * telemetry.md `assistant30d`: the Explain, Suggest triage and Suggest a fix people asked for in
 * 30 days.
 */
export interface AssistantUsage {
  explain: number;
  triage: number;
  fix: number;
}

export function providerToken(p: Pick<StoredProvider, 'kind' | 'api'> | null): AiProviderToken {
  if (p === null) return 'none';
  switch (p.kind) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return p.api === 'responses' ? 'openai_responses' : 'openai_chat_completions';
  }
}

/** The one row of an aggregate query, each of its counts a number. */
async function counts<K extends string>(db: Db, query: SQL): Promise<Record<K, number>> {
  const row = (await db.execute<Record<K, string | number>>(query)).rows[0];
  const out = {} as Record<K, number>;
  for (const [key, value] of Object.entries(row ?? {})) {
    out[key as K] = Number(value ?? 0);
  }
  return out;
}

/**
 * The AI review numbers of the report. Every window is the last 30 days on the database's clock.
 * The organisations are counted over those that exist, never over the settings' map, which may
 * outlive an organisation.
 */
export async function collectAiReviewUsage(
  db: Db,
  settings: StoredLlmSettings,
): Promise<AiReviewUsage> {
  const [organizations, projects, runs, findings, replies] = await Promise.all([
    db.execute<{ id: string }>(sql`SELECT id FROM organizations`),
    db.execute<{ id: string; organization_id: string; scm_connection_id: string | null }>(
      sql`SELECT id, organization_id, scm_connection_id FROM projects`,
    ),
    counts<'done' | 'skipped' | 'failed' | 'superseded'>(
      db,
      sql`
        SELECT count(*) FILTER (WHERE status = 'done') AS done,
               count(*) FILTER (WHERE status = 'skipped') AS skipped,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               count(*) FILTER (WHERE status = 'superseded') AS superseded
          FROM review_runs
         WHERE finished_at > now() - interval '30 days'`,
    ),
    counts<'findings' | 'inline' | 'suggestions'>(
      db,
      sql`
        SELECT count(*) AS findings,
               count(*) FILTER (WHERE anchor_line IS NOT NULL) AS inline,
               count(*) FILTER (WHERE suggestion IS NOT NULL) AS suggestions
          FROM review_findings
         WHERE created_at > now() - interval '30 days'`,
    ),
    counts<'answered' | 'status_changes' | 'review' | 'fix' | 'stop'>(
      db,
      sql`
        SELECT count(*) FILTER (WHERE kind = 'reply' AND status = 'done') AS answered,
               count(*) FILTER (
                 WHERE kind = 'reply' AND outcome IN ('wont_fix', 'false_positive')
               ) AS status_changes,
               count(*) FILTER (
                 WHERE kind = 'command' AND status = 'done' AND command = 'review'
               ) AS review,
               count(*) FILTER (WHERE kind = 'command' AND status = 'done' AND command = 'fix') AS fix,
               count(*) FILTER (WHERE kind = 'command' AND status = 'done' AND command = 'stop') AS stop
          FROM review_replies
         WHERE finished_at > now() - interval '30 days'`,
    ),
  ]);
  const provider = settings.provider;
  return {
    organizations: organizations.rows.filter(
      (o) => organizationReviewInactive(settings, o.id) === null,
    ).length,
    projects: projects.rows.filter(
      (p) =>
        reviewActive(settings, {
          id: p.id,
          organizationId: p.organization_id,
          scmConnectionId: p.scm_connection_id,
        }).active,
    ).length,
    // An address that does not parse still sends its kind; its organisations count 0 (no_provider).
    provider: providerToken(provider),
    tiers: {
      strong: provider !== null && ownModel(provider, 'strong') !== null,
      fast: provider !== null && ownModel(provider, 'fast') !== null,
    },
    reviews30d: {
      done: runs.done,
      skipped: runs.skipped,
      failed: runs.failed,
      superseded: runs.superseded,
    },
    findings30d: findings.findings,
    inline30d: findings.inline,
    suggestions30d: findings.suggestions,
    replies30d: { answered: replies.answered, statusChanges: replies.status_changes },
    commands30d: { review: replies.review, fix: replies.fix, stop: replies.stop },
  };
}

export async function collectAssistantUsage(db: Db): Promise<AssistantUsage> {
  const row = await counts<'explain' | 'triage' | 'fix'>(
    db,
    sql`
      SELECT count(*) FILTER (WHERE feature = 'explain') AS explain,
             count(*) FILTER (WHERE feature = 'triage') AS triage,
             count(*) FILTER (WHERE feature = 'fix') AS fix
        FROM llm_requests
       WHERE feature IN ('explain', 'triage', 'fix') AND user_id IS NOT NULL
         AND created_at > now() - interval '30 days'`,
  );
  return { explain: row.explain, triage: row.triage, fix: row.fix };
}
