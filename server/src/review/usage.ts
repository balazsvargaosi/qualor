import { createHash } from 'node:crypto';
import { cutAtGrapheme, LONE_SURROGATE_SOURCE } from '@qualor/shared';
import { eq, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Executor } from '../db/client';
import { first } from '../db/rows';
import { llmRequests, projects, type ReviewRunRow } from '../db/schema';
import { VERSION } from '../index';
import { errorCodeOf } from '../llm/errors';
import {
  costOf,
  jsonbTextBytes,
  LLM_RESULT_MAX_BYTES,
  noteCallFailure,
  type LlmRuntime,
} from '../llm/job';
import {
  converse,
  LlmError,
  type LlmConversation,
  type LlmMessage,
  type LlmToolCall,
  type LlmTurn,
  type ProviderKind,
} from '../llm/providers';
import { UTC_DAY_START } from '../llm/service';
import { providerApiKey, providerConfig, type StoredLlmSettings } from '../llm/settings';
import type { WorkerLogger } from '../queue/worker';
import { CircuitOpenError } from './conversation';
import type { ReviewBudgets } from './settings';

/*
 * What an AI review spends. Every call a review makes to the provider is one finished
 * `llm_requests` row of its own feature: the explain, triage and fix budgets never count it
 * (`todayUsage`), and the review's budgets count nothing else. A row is written once the call has
 * returned or failed, never as `queued` or `running`: the sweep of the `llm` queue fails the rows
 * that no job of that queue will finish, and a review's calls have none.
 */

export const REVIEW_FEATURE = 'review';

/** The largest value of the `redactions` column. */
const MAX_REDACTIONS = 2_147_483_647;

// ─── What a call leaves in the database ──────────────────────────────────────

export interface ReviewCallRecord {
  organizationId: string;
  projectId: string;
  /** The review run the call belongs to: the row has no column for it, so it goes in the stored prompt. */
  runId: string;
  provider: ProviderKind;
  providerHost: string;
  model: string;
  promptVersion: string;
  /** The sha256 of the request body sent (the serialised conversation). */
  inputSha256: string;
  inputBytes: number;
  /** The secrets masked in the text the call added; it is on this row and nowhere else. */
  redactions: number;
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  durationMs: number;
  /**
   * What the call sent and what came back, to be kept as the prompt and the result of the row.
   * Given only when the administrator keeps prompts (`storePrompts`); without it nothing of the
   * conversation is stored. The result is kept only for a call that succeeded.
   */
  stored?: { conversation: LlmConversation; turn: LlmTurn | null };
}

/**
 * The stored prompt stays under the column's CHECK (64 KiB as PostgreSQL writes jsonb text), and
 * the stored result under the one the answers of explain, triage and fix keep to.
 */
const STORED_PROMPT_BYTES = 60 * 1024;
const STORED_RESULT_BYTES = LLM_RESULT_MAX_BYTES;
/**
 * The characters a stored text is cut to, widest first: a document that is too big is made again
 * with the next.
 */
const TEXT_CAPS = [16_000, 4_000, 1_000, 250, 60] as const;
const STORED_SYSTEM_CHARS = 1_000;
const STORED_NAME_CHARS = 100;
const STORED_ARGUMENT_CHARS = 300;
const STORED_CALLS = 20;

const LONE_SURROGATES = new RegExp(LONE_SURROGATE_SOURCE, 'g');

/** U+FFFD, the character that stands for text that could not be read. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** Text a jsonb value can hold: PostgreSQL refuses a NUL and a lone surrogate. */
const storable = (text: string): string =>
  text.replaceAll('\u0000', '').replace(LONE_SURROGATES, REPLACEMENT_CHARACTER);

/** `text` made storable and cut to `max` characters, the cut marked. */
function shown(text: string, max: number): string {
  // Twice the characters hold more than `max` code points whenever the text has more: no need to
  // take apart a megabyte to cut it.
  return cutAtGrapheme(storable(text.slice(0, 2 * max + 4)), max);
}

function argumentsText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Arguments nested deeper than JSON.stringify can follow.
    return '[too deeply nested to show]';
  }
}

function storedCall(call: LlmToolCall) {
  return {
    id: shown(call.id, STORED_NAME_CHARS),
    name: shown(call.name, STORED_NAME_CHARS),
    arguments: shown(argumentsText(call.arguments), STORED_ARGUMENT_CHARS),
  };
}

function storedMessage(message: LlmMessage, chars: number) {
  switch (message.role) {
    case 'user':
      return { role: 'user', text: shown(message.text, chars) };
    case 'tool':
      return {
        role: 'tool',
        callId: shown(message.callId, STORED_NAME_CHARS),
        name: shown(message.name, STORED_NAME_CHARS),
        text: shown(message.text, chars),
      };
    case 'assistant':
      return {
        role: 'assistant',
        text: shown(message.text, chars),
        callCount: message.toolCalls.length,
        calls: message.toolCalls.slice(0, STORED_CALLS).map(storedCall),
      };
  }
}

/**
 * The prompt of a call as a person reads it back: the run, the system prompt (cut), and the newest
 * messages of the conversation that fit, oldest first, with how many came before them. The newest
 * are what the call added, which is what a person looks for; each text is cut, to fewer characters
 * until the newest message fits at all.
 */
function storedPrompt(runId: string, conversation: LlmConversation): unknown {
  const system = shown(conversation.system, STORED_SYSTEM_CHARS);
  const all = conversation.messages;
  for (const chars of TEXT_CAPS) {
    const kept: unknown[] = [];
    let bytes = jsonbTextBytes({ runId, system, omitted: all.length, messages: [] });
    for (const message of [...all].reverse()) {
      const stored = storedMessage(message, chars);
      // The separator between two elements of the list, counted for the first one too.
      const size = jsonbTextBytes(stored) + 2;
      if (bytes + size > STORED_PROMPT_BYTES) break;
      kept.push(stored);
      bytes += size;
    }
    if (kept.length > 0 || all.length === 0) {
      return { runId, system, omitted: all.length - kept.length, messages: kept.reverse() };
    }
  }
  return { runId, system, omitted: all.length, messages: [] };
}

/** The answer of a call as a person reads it back: what the model said, and the calls it made. */
function storedResult(turn: LlmTurn): unknown {
  for (const chars of TEXT_CAPS) {
    const document = {
      finishReason: turn.finishReason,
      text: shown(turn.text, chars),
      callCount: turn.toolCalls.length,
      calls: turn.toolCalls.slice(0, STORED_CALLS).map(storedCall),
    };
    if (jsonbTextBytes(document) <= STORED_RESULT_BYTES) return document;
  }
  return { finishReason: turn.finishReason, text: '', callCount: turn.toolCalls.length, calls: [] };
}

/**
 * Writes the row of one call to the provider, finished: `feature` is `review`, there is no issue
 * and no user. `cache_key` is the hash of the request body, as `input_sha256` is, and is never
 * looked up as a cache (the lookups ask for an issue). The prompt and the result are kept only
 * when the record brings them, and within the bounds of their columns.
 */
export async function recordReviewCall(db: Executor, call: ReviewCallRecord): Promise<void> {
  await db.insert(llmRequests).values({
    organizationId: call.organizationId,
    projectId: call.projectId,
    issueId: null,
    userId: null,
    feature: REVIEW_FEATURE,
    cacheKey: call.inputSha256,
    provider: call.provider,
    providerHost: call.providerHost,
    model: call.model,
    promptVersion: call.promptVersion,
    status: call.status,
    errorCode: call.errorCode,
    attempts: 1,
    inputSha256: call.inputSha256,
    inputBytes: call.inputBytes,
    fields: [REVIEW_FEATURE],
    redactions: Math.min(call.redactions, MAX_REDACTIONS),
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    costMicroUsd: call.costMicroUsd,
    durationMs: call.durationMs,
    prompt: call.stored ? storedPrompt(call.runId, call.stored.conversation) : null,
    result:
      call.status === 'succeeded' && call.stored?.turn ? storedResult(call.stored.turn) : null,
    finishedAt: sql`now()`,
  });
}

// ─── What the day has used, and what is left ─────────────────────────────────

export interface ReviewUsage {
  /** Tokens, input and output, of the calls made since the UTC day began. */
  tokens: number;
  costMicroUsd: number;
  /** Reviews that began the day and spent, or were spending: not the ones skipped. */
  reviews: number;
}

/**
 * The AI reviews of the organisation (or of one of its projects) since the current UTC day began:
 * the tokens and the estimated cost of the `review` rows, and how many reviews ran. The rows of
 * explain, triage and fix are not counted. The number of reviews is that of the runs that started
 * today and did not end skipped: the rows are calls, and carry no run.
 */
export async function reviewUsageToday(
  db: Executor,
  organizationId: string,
  projectId?: string,
): Promise<ReviewUsage> {
  const spent = await db.execute<{ tokens: string; cost: string }>(sql`
    SELECT coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::bigint AS tokens,
           coalesce(sum(cost_micro_usd), 0)::bigint AS cost
      FROM llm_requests
     WHERE feature = ${REVIEW_FEATURE}
       AND organization_id = ${organizationId}
       ${projectId === undefined ? sql`` : sql`AND project_id = ${projectId}`}
       AND created_at >= ${UTC_DAY_START}`);
  const runs = await db.execute<{ reviews: number }>(sql`
    SELECT count(*)::int AS reviews
      FROM review_runs r
      JOIN projects p ON p.id = r.project_id
     WHERE p.organization_id = ${organizationId}
       ${projectId === undefined ? sql`` : sql`AND r.project_id = ${projectId}`}
       AND r.status IN ('running', 'done', 'failed', 'superseded')
       AND r.started_at >= ${UTC_DAY_START}`);
  const row = first(spent.rows);
  return {
    tokens: Number(row.tokens),
    costMicroUsd: Number(row.cost),
    reviews: first(runs.rows).reviews,
  };
}

/**
 * The tokens one review may use now: the smallest of what one review may use, what the
 * organisation has left of its day, and what its project has left of the day when the project has
 * a budget. A cost budget at or past its limit leaves nothing. `maxCostMicroUsd` is that budget in
 * micro-USD, null when there is none or when no prices are set (a cost is then unknown).
 */
export function remainingReviewTokens(
  budgets: ReviewBudgets,
  org: { tokens: number; costMicroUsd: number },
  project: { tokens: number } | null,
  maxCostMicroUsd: number | null,
): number {
  if (maxCostMicroUsd !== null && org.costMicroUsd >= maxCostMicroUsd) return 0;
  const left = [budgets.maxTokensPerReview, budgets.tokensPerDay - org.tokens];
  if (project !== null && budgets.perProjectTokensPerDay !== null) {
    left.push(budgets.perProjectTokensPerDay - project.tokens);
  }
  return Math.max(0, Math.min(...left));
}

// ─── The sender: one call, recorded ──────────────────────────────────────────

/**
 * The secrets masked in the text the next call adds to the conversation: the first message's, then
 * the results of the tools. Whoever masks adds the number; the sender takes it for the row of the
 * call that carries the text. It is stored on that row only: it depends on what the masking found,
 * so neither the merge request's author nor the model may read it. One tally for each
 * conversation: two that run side by side must not share one.
 */
export class RedactionTally {
  private pending = 0;

  add(count: number): void {
    this.pending += count;
  }

  /** What was added since the last take. */
  take(): number {
    const count = this.pending;
    this.pending = 0;
    return count;
  }
}

export interface ReviewSenderDeps {
  db: Executor;
  /** The circuit is the `llm` worker's: both stop calling a provider that is failing. */
  runtime: Pick<LlmRuntime, 'circuit'>;
  config: Pick<Config, 'secretKey' | 'llmInternalHosts'>;
  /** The settings the run started with: its provider, key, prices and `storePrompts`. */
  settings: StoredLlmSettings;
  run: Pick<ReviewRunRow, 'id' | 'projectId'>;
  /** The version of the prompts the conversation was made from, kept on every row. */
  promptVersion: string;
  /** Secrets masked in what each call adds; without it, 0 on every row. */
  redactions?: RedactionTally;
  /** Gets one line for each call: the run, the outcome and the counts, never what was said. */
  logger?: WorkerLogger;
}

/** A call as it was sent, which is what its row is made of besides the outcome. */
interface SentCall {
  conversation: LlmConversation;
  organizationId: string;
  inputSha256: string;
  inputBytes: number;
  redactions: number;
  started: number;
}

/** What came of a call. */
interface Outcome {
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  /** What came back; null for a call that failed. */
  turn: LlmTurn | null;
  /** The provider's HTTP status of a failed call, for the log. */
  providerStatus: number | null;
}

/**
 * The `send` of a conversation (conversation.ts): one call to the configured provider through
 * `converse`, recorded as a row whether it succeeds or fails. The provider's circuit is asked
 * first (open: `CircuitOpenError`, nothing sent and no row) and told how the call went. A review
 * takes no slot of the organisation's `llm` requests: it shares the circuit with that queue and
 * nothing else, so it never holds explain, triage or fix behind it, and they never hold it. A
 * failure is thrown after it is recorded; a key that cannot be read is thrown as the provider
 * refusing it.
 */
export function reviewSender(
  deps: ReviewSenderDeps,
): (conversation: LlmConversation) => Promise<LlmTurn> {
  const provider = deps.settings.provider;
  if (provider === null) throw new Error('AI review needs a model provider');
  const config = providerConfig(provider);
  const providerHost = new URL(provider.baseUrl).host;
  const circuitKey = provider.baseUrl;
  const http = { internalHosts: deps.config.llmInternalHosts, version: VERSION };
  let organizationId: string | undefined;

  /** The organisation of the run's project, read once. */
  async function organizationOfRun(): Promise<string> {
    if (organizationId === undefined) {
      const [project] = await deps.db
        .select({ organizationId: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, deps.run.projectId));
      if (!project) throw new Error('The project of the review run is gone');
      organizationId = project.organizationId;
    }
    return organizationId;
  }

  /** Writes the row of a finished call and its log line. */
  const finish = async (sent: SentCall, outcome: Outcome): Promise<void> => {
    const durationMs = Math.max(0, Date.now() - sent.started);
    await recordReviewCall(deps.db, {
      organizationId: sent.organizationId,
      projectId: deps.run.projectId,
      runId: deps.run.id,
      provider: provider.kind,
      providerHost,
      model: provider.model,
      promptVersion: deps.promptVersion,
      inputSha256: sent.inputSha256,
      inputBytes: sent.inputBytes,
      redactions: sent.redactions,
      status: outcome.status,
      errorCode: outcome.errorCode,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costMicroUsd: outcome.costMicroUsd,
      durationMs,
      ...(deps.settings.storePrompts
        ? { stored: { conversation: sent.conversation, turn: outcome.turn } }
        : {}),
    });
    deps.logger?.info(
      {
        runId: deps.run.id,
        status: outcome.status,
        errorCode: outcome.errorCode,
        providerStatus: outcome.providerStatus,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        durationMs,
      },
      'AI review call finished',
    );
  };

  return async (conversation) => {
    const key = providerApiKey(deps.settings, deps.config.secretKey);
    if (!key.ok) {
      throw new LlmError('refused_key', 'The API key cannot be read; set it again in the settings');
    }
    const body = JSON.stringify(conversation);
    const organization = await organizationOfRun();
    if (!deps.runtime.circuit.tryPass(circuitKey)) throw new CircuitOpenError();
    const sent: SentCall = {
      conversation,
      organizationId: organization,
      inputSha256: createHash('sha256').update(body).digest('hex'),
      inputBytes: Buffer.byteLength(body, 'utf8'),
      redactions: deps.redactions?.take() ?? 0,
      started: Date.now(),
    };

    let turn: LlmTurn;
    try {
      turn = await converse(config, key.key, conversation, http);
      deps.runtime.circuit.success(circuitKey);
    } catch (err) {
      if (!(err instanceof LlmError)) {
        // Not an answer of the provider's, either way: the probe goes to the next call.
        deps.runtime.circuit.release(circuitKey);
        throw err;
      }
      noteCallFailure(deps.runtime.circuit, circuitKey, err);
      await finish(sent, {
        status: 'failed',
        errorCode: errorCodeOf(err),
        inputTokens: null,
        outputTokens: null,
        costMicroUsd: null,
        turn: null,
        providerStatus: err.status,
      });
      throw err;
    }
    await finish(sent, {
      status: 'succeeded',
      errorCode: null,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      costMicroUsd: costOf(deps.settings.pricing, turn.usage),
      turn,
      providerStatus: null,
    });
    return turn;
  };
}
