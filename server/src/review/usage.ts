import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Executor } from '../db/client';
import { first } from '../db/rows';
import { llmRequests, projects } from '../db/schema';
import { VERSION } from '../index';
import { errorCodeOf } from '../llm/errors';
import { costOf, noteCallFailure, type LlmRuntime } from '../llm/job';
import {
  converse,
  LlmError,
  type LlmConversation,
  type LlmTurn,
  type ProviderKind,
  type StreamLimits,
} from '../llm/providers';
import { UTC_DAY_START } from '../llm/service';
import {
  dearestTokenPrice,
  providerApiKey,
  providerConfig,
  type PricePair,
  type StoredLlmSettings,
  type StoredPricing,
  type StoredProvider,
} from '../llm/settings';
import type { WorkerLogger } from '../queue/worker';
import { CircuitOpenError } from './conversation';
import { scrubTurn } from './key-scrub';
import type { ReviewBudgets } from './settings';
import { storedPrompt, storedResult } from './usage-store';

/*
 * What an AI review spends. Every call a review makes to the provider is one finished
 * `llm_requests` row of its own feature: `review` for the calls of a review run, `review-reply` for
 * those that answer a person's reply in a merge request (6I-4). The explain, triage and fix budgets
 * never count them (`todayUsage`), and the review's budgets count nothing else, the two features
 * together. A row is written once the call has returned or failed, never as `queued` or `running`:
 * the sweep of the `llm` queue fails the rows that no job of that queue will finish, and these calls
 * have none.
 */

export const REVIEW_FEATURE = 'review';
/** The feature of the calls that answer a person's reply. */
export const REVIEW_REPLY_FEATURE = 'review-reply';
/** The features a review's day is counted over. */
const REVIEW_FEATURES = [REVIEW_FEATURE, REVIEW_REPLY_FEATURE] as const;
export type ReviewFeature = (typeof REVIEW_FEATURES)[number];

/**
 * What a call belongs to, by feature: the name the stored prompt and the log line give its id (a
 * review run's, or a reply's), and the log line.
 */
const OWNER: Readonly<Record<ReviewFeature, { name: 'runId' | 'replyId'; logLine: string }>> = {
  review: { name: 'runId', logLine: 'AI review call finished' },
  'review-reply': { name: 'replyId', logLine: 'AI review reply call finished' },
};

/**
 * The least a review call waits for its answer, in seconds. A review runs in the background and its
 * answers are long: one call of a reasoning model can take minutes, so the assistant's timeout
 * (60 s by default, set for a person waiting on Explain, Triage or Fix) would cut it off.
 */
export const REVIEW_CALL_MIN_TIMEOUT_SECONDS = 300;

/**
 * The settings a review sends its calls with: the assistant's, with the provider's timeout raised
 * to at least REVIEW_CALL_MIN_TIMEOUT_SECONDS (a longer one the admin set is kept).
 */
export function reviewCallSettings(settings: StoredLlmSettings): StoredLlmSettings {
  const { provider } = settings;
  if (provider === null || provider.timeoutSeconds >= REVIEW_CALL_MIN_TIMEOUT_SECONDS) {
    return settings;
  }
  return {
    ...settings,
    provider: { ...provider, timeoutSeconds: REVIEW_CALL_MIN_TIMEOUT_SECONDS },
  };
}

/** The longest a review call that streams may take in all, in seconds: 15 minutes. */
export const REVIEW_STREAM_TOTAL_SECONDS = 900;

/** The most raw bytes the stream of a review call may send: 16 MiB. */
const REVIEW_STREAM_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The limits of a review call's stream, for a provider whose timeout is `timeoutSeconds`: that
 * timeout, but never less than REVIEW_CALL_MIN_TIMEOUT_SECONDS, is the wait for the first byte and
 * the longest the stream may be silent between two chunks, as a reasoning model can think for
 * minutes before it writes, after its stream began; the whole call has 15 minutes, and its stream
 * 16 MiB.
 */
export function reviewStreamLimits(timeoutSeconds: number): StreamLimits {
  const silentMs = Math.max(timeoutSeconds, REVIEW_CALL_MIN_TIMEOUT_SECONDS) * 1_000;
  return {
    firstByteMs: silentMs,
    idleMs: silentMs,
    totalMs: REVIEW_STREAM_TOTAL_SECONDS * 1_000,
    maxStreamBytes: REVIEW_STREAM_MAX_BYTES,
  };
}

/** The largest value of the `redactions` column. */
const MAX_REDACTIONS = 2_147_483_647;

// ─── What a call leaves in the database ──────────────────────────────────────

export interface ReviewCallRecord {
  organizationId: string;
  projectId: string;
  /** What the call is for: a review run's, or the answer to a person's reply. */
  feature: ReviewFeature;
  /**
   * What the call belongs to, the review run or the reply (its id): the row has no column for it,
   * so it goes in the stored prompt.
   */
  promptKey: string;
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
 * Writes the row of one call to the provider, finished, of the call's own feature (`review` or
 * `review-reply`); there is no issue and no user. `cache_key` is the hash of the request body, as
 * `input_sha256` is, and is never looked up as a cache (the lookups ask for an issue). The prompt and
 * the result are kept only when the record brings them, and within the bounds of their columns.
 */
export async function recordReviewCall(db: Executor, call: ReviewCallRecord): Promise<void> {
  await db.insert(llmRequests).values({
    organizationId: call.organizationId,
    projectId: call.projectId,
    issueId: null,
    userId: null,
    feature: call.feature,
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
    fields: [call.feature],
    redactions: Math.min(call.redactions, MAX_REDACTIONS),
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    costMicroUsd: call.costMicroUsd,
    durationMs: call.durationMs,
    prompt: call.stored
      ? storedPrompt(call.promptKey, call.stored.conversation, OWNER[call.feature].name)
      : null,
    result:
      call.status === 'succeeded' && call.stored?.turn ? storedResult(call.stored.turn) : null,
    finishedAt: sql`now()`,
  });
}

// ─── What the day has used, and what is left ─────────────────────────────────

export interface ReviewUsage {
  /**
   * Tokens, input and output, of the calls made since the UTC day began. A call the provider
   * answered, answered unreadably, or timed out on, without counting the input, is counted at a
   * quarter of the bytes sent.
   */
  tokens: number;
  costMicroUsd: number;
  /** Reviews that began the day and spent, or were spending: not the ones skipped. */
  reviews: number;
}

/**
 * The AI reviews of the organisation (or of one of its projects) since the current UTC day began:
 * the tokens and the estimated cost of the `review` and the `review-reply` rows, which draw on one
 * day's budget, and how many reviews ran. The rows of explain, triage and fix are not counted. The
 * number of reviews is that of the runs that started today and did not end skipped: the rows are
 * calls, and carry no run, so the answers to replies add tokens and cost and no review.
 *
 * A provider that does not count its tokens must not spend without limit: the input of a row that
 * succeeded, timed out or was answered in a way that could not be read (a 2xx the provider most
 * likely billed), and has no count, is a quarter of its `input_bytes` (the guess the loop makes
 * too). The row keeps its null (llm.md §10.1) and so does its cost: the cost of the day is the sum
 * of the costs that are known. An output count the provider did not give is 0 here: the row does
 * not know the limit its call was made with. A call the provider refused, did not take or could not
 * be reached for is not counted.
 */
export async function reviewUsageToday(
  db: Executor,
  organizationId: string,
  projectId?: string,
): Promise<ReviewUsage> {
  const features = sql.join(
    REVIEW_FEATURES.map((feature) => sql`${feature}`),
    sql`, `,
  );
  const spent = await db.execute<{ tokens: string; cost: string }>(sql`
    SELECT coalesce(sum(
             CASE WHEN status = 'succeeded'
                       OR error_code IN ('PROVIDER_TIMEOUT', 'PROVIDER_BAD_ANSWER')
                  THEN coalesce(input_tokens, ceil(input_bytes / 4.0))
                  ELSE coalesce(input_tokens, 0) END
             + coalesce(output_tokens, 0)), 0)::bigint AS tokens,
           coalesce(sum(cost_micro_usd), 0)::bigint AS cost
      FROM llm_requests
     WHERE feature IN (${features})
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
 * What the running reviews of the organisation (or of one of its projects), but `exceptRunId`'s own,
 * may still spend: each counts `perReview` less what it has written as spent, and no less than 0.
 * No day filter: what a run still spends lands today, however long ago it started. A run that ended
 * reserves nothing, and so does one the sweep ended.
 */
export async function reservedReviewTokens(
  db: Executor,
  o: { organizationId: string; projectId?: string; exceptRunId: string; perReview: number },
): Promise<number> {
  const rows = await db.execute<{ reserved: string }>(sql`
    SELECT coalesce(sum(greatest(0, ${o.perReview}::bigint - (r.input_tokens + r.output_tokens))), 0)::bigint
             AS reserved
      FROM review_runs r
      JOIN projects p ON p.id = r.project_id
     WHERE p.organization_id = ${o.organizationId}
       ${o.projectId === undefined ? sql`` : sql`AND r.project_id = ${o.projectId}`}
       AND r.status = 'running'
       AND r.id <> ${o.exceptRunId}`);
  return Number(first(rows.rows).reserved);
}

/**
 * The tokens one review may use now: the smallest of what one review may use, what the
 * organisation has left of its day, what its project has left of the day when the project has a
 * budget, and, when the review has a cost budget (`costPerDayUsd`) and there are prices, what the
 * cost left buys at the `dearestTokenPrice` of the provider's models: the cost of a call is not
 * known before it is made and any model's may be the next, so the price that cannot overspend is the
 * dearest a token may cost, of input written to the cache, input read from it and output. Without
 * a provider, as without prices, nothing is priced. A cost budget at or past its limit leaves
 * nothing. `usage` is the day so far, as `reviewUsageToday` counts it for the organisation and for the project. `reserved` is
 * what the other running reviews may still spend (`reservedReviewTokens`): the organisation's
 * tokens left, the project's and the tokens the cost buys each lose their part of it, and Tokens
 * per review never does. The answer to a
 * reply asks it with its own ceiling in the place of `maxTokensPerReview`.
 */
export function remainingReviewTokens(
  budgets: ReviewBudgets,
  usage: {
    organization: { tokens: number; costMicroUsd: number };
    project: { tokens: number } | null;
  },
  pricing: StoredPricing,
  provider: Pick<StoredProvider, 'model' | 'strongModel' | 'fastModel'> | null,
  reserved: { organization: number; project: number } = { organization: 0, project: 0 },
): number {
  const left = [
    budgets.maxTokensPerReview,
    budgets.tokensPerDay - usage.organization.tokens - reserved.organization,
  ];
  if (usage.project !== null && budgets.perProjectTokensPerDay !== null) {
    left.push(budgets.perProjectTokensPerDay - usage.project.tokens - reserved.project);
  }
  if (budgets.costPerDayUsd !== null) {
    const costLeft =
      Math.round(budgets.costPerDayUsd * 1_000_000) - usage.organization.costMicroUsd;
    if (costLeft <= 0) return 0;
    // A price is in dollars for a million tokens, which is micro-USD for a token.
    const perToken = (provider === null ? null : dearestTokenPrice(pricing, provider)) ?? 0;
    if (perToken > 0) left.push(Math.floor(costLeft / perToken) - reserved.organization);
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
  /** The settings the run started with: its provider, key and `storePrompts`. */
  settings: StoredLlmSettings;
  /**
   * The model every call of the conversation is sent to, and its row names: the model of the tier
   * the conversation runs on (`modelFor`), which is not always the provider's standard model.
   */
  model: string;
  /** That model's prices, which cost each call; null: no costs (`pricingFor`). */
  pricing: PricePair | null;
  /** What the calls are for: a review run, or the answer to a person's reply. Every row has it. */
  feature: ReviewFeature;
  /**
   * What the calls belong to: the project, whose organisation the rows are written for, and the id
   * of the review run or of the reply, which the stored prompt and the log line name.
   */
  source: { projectId: string; promptKey: string };
  /** The version of the prompts the conversation was made from, kept on every row. */
  promptVersion: string;
  /** Secrets masked in what each call adds; without it, 0 on every row. */
  redactions?: RedactionTally;
  /** Gets one line for each call: the run, the outcome and the counts, never what was said. */
  logger?: WorkerLogger;
  /** Gives up the call in flight when it aborts (the server is stopping): see `reviewSender`. */
  signal?: AbortSignal;
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
  /** Every prompt token, as the provider counted it, whatever its cache did (R49). */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Of the input, what the provider read from its cache and wrote to it; null: not counted. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costMicroUsd: number | null;
  /** What came back; null for a call that failed. */
  turn: LlmTurn | null;
  /** The provider's HTTP status of a failed call, for the log. */
  providerStatus: number | null;
}

/**
 * The `send` of a conversation (conversation.ts): one call to the configured provider through
 * `converse`, recorded as a row of `deps.feature` whether it succeeds or fails. The provider's
 * circuit is asked first (open: `CircuitOpenError`, nothing sent and no row) and told how the call
 * went. A review, or the answer to a reply, takes no slot of the organisation's `llm` requests: it
 * shares the circuit with that queue and nothing else, so it never holds explain, triage or fix
 * behind it, and they never hold it. The provider's key is taken out of what the model said before
 * it is returned or stored. A failure is thrown after it is recorded; a key that cannot be read is
 * thrown as the provider refusing it. A call that `deps.signal` gives up is cut at once and thrown
 * as `LlmCallAborted`, with no row: the provider gave no answer and failed at nothing, so the call
 * is charged to no budget and the circuit only hands its probe on. Every call is streamed, within
 * `reviewStreamLimits` (R35), so that a gateway that cuts a connection which stays idle does not cut
 * a long answer; a server that will not stream is asked again without it in the same call, which is
 * still one row, and the later calls of the model are not streamed (one log line says so). On
 * Anthropic every call marks its prompt for the provider's cache (R49, `markedForCache`), and a
 * server that refuses the markers is asked again without them in the same call, still one row. The
 * row's input is every prompt token, the cached ones among them; its cost prices what the cache
 * read and wrote apart (`costOf`), and its log line gives those two counts.
 */
export function reviewSender(
  deps: ReviewSenderDeps,
): (conversation: LlmConversation) => Promise<LlmTurn> {
  const provider = deps.settings.provider;
  if (provider === null) throw new Error('AI review needs a model provider');
  const config = { ...providerConfig(provider), model: deps.model };
  const providerHost = new URL(provider.baseUrl).host;
  const circuitKey = provider.baseUrl;
  const owner = OWNER[deps.feature];
  const http = {
    internalHosts: deps.config.llmInternalHosts,
    version: VERSION,
    stream: reviewStreamLimits(provider.timeoutSeconds),
    // One line when the server will not stream: it says why the calls wait longer from then on.
    onStreamRefused: () =>
      deps.logger?.info(
        { [owner.name]: deps.source.promptKey },
        'AI review call asked again without streaming: the model provider refused the stream',
      ),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
  let organizationId: string | undefined;

  /** The organisation of the project the calls are for, read once. */
  async function organizationOfSource(): Promise<string> {
    if (organizationId === undefined) {
      const [project] = await deps.db
        .select({ organizationId: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, deps.source.projectId));
      if (!project) throw new Error('The project the calls are made for is gone');
      organizationId = project.organizationId;
    }
    return organizationId;
  }

  /** Writes the row of a finished call and its log line. */
  const finish = async (sent: SentCall, outcome: Outcome): Promise<void> => {
    const durationMs = Math.max(0, Date.now() - sent.started);
    await recordReviewCall(deps.db, {
      organizationId: sent.organizationId,
      projectId: deps.source.projectId,
      feature: deps.feature,
      promptKey: deps.source.promptKey,
      provider: provider.kind,
      providerHost,
      model: deps.model,
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
        [owner.name]: deps.source.promptKey,
        status: outcome.status,
        errorCode: outcome.errorCode,
        providerStatus: outcome.providerStatus,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        // Counts only: what the provider's prompt cache did with the input (R49).
        cacheReadTokens: outcome.cacheReadTokens,
        cacheWriteTokens: outcome.cacheWriteTokens,
        durationMs,
      },
      owner.logLine,
    );
  };

  return async (conversation) => {
    const key = providerApiKey(deps.settings, deps.config.secretKey);
    if (!key.ok) {
      throw new LlmError('refused_key', 'The API key cannot be read; set it again in the settings');
    }
    const body = JSON.stringify(conversation);
    const organization = await organizationOfSource();
    if (!deps.runtime.circuit.tryPass(circuitKey)) throw new CircuitOpenError();
    const sent: SentCall = {
      conversation,
      organizationId: organization,
      inputSha256: createHash('sha256').update(body).digest('hex'),
      inputBytes: Buffer.byteLength(body, 'utf8'),
      redactions: deps.redactions?.take() ?? 0,
      started: Date.now(),
    };

    let answered: LlmTurn;
    try {
      answered = await converse(config, key.key, conversation, http);
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
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicroUsd: null,
        turn: null,
        providerStatus: err.status,
      });
      throw err;
    }
    // What the model said leaves here without the provider's key, also in the stored result.
    const turn = scrubTurn(answered, key.key);
    await finish(sent, {
      status: 'succeeded',
      errorCode: null,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      cacheReadTokens: turn.usage.cacheReadTokens ?? null,
      cacheWriteTokens: turn.usage.cacheWriteTokens ?? null,
      // Every prompt token is counted as input; the cost prices the cache's parts apart (R49).
      costMicroUsd: costOf(deps.pricing, turn.usage),
      turn,
      providerStatus: null,
    });
    return turn;
  };
}
