import { parseModelJson } from '@qualor/shared';
import type { Config } from '../config';
import type { Executor } from '../db/client';
import { REPLY_VERDICTS, type ReplyVerdict } from '../db/schema';
import { costOf, type LlmRuntime } from '../llm/job';
import {
  pricingFor,
  providerApiKey,
  type PricePair,
  type StoredLlmSettings,
  type StoredProvider,
} from '../llm/settings';
import type { WorkerLogger } from '../queue/worker';
import { AI_ENGINE } from '../rules/server-engines';
import type { ConversationInput } from './conversation';
import { envelope, newNonce } from './envelope';
import { scrubKeyDeep } from './key-scrub';
import { MaskedFiles } from './masked-files';
import { Masker } from './masker';
import { modelFor, tierOfCall } from './model-tiers';
import { ANSWER_CHARS_PER_TOKEN, REVIEW_OUTPUT_TOKENS } from './pipeline';
import {
  REPLY_LIMITS,
  REPLY_PROMPT_VERSION,
  replyData,
  replyRetryText,
  replySystemPrompt,
  type ReplyData,
  type ReplyIssue,
  type ReplyRefusal,
} from './prompts';
import { REPLY_TOKEN_BUDGET } from './replies';
import { replyAnswerSchema, type ReplyAnswer } from './schemas';
import { effectiveReviewBudgets } from './settings';
import type { SnapshotReader } from './snapshot-reader';
import { converseOverTools, newToolPolicy } from './tool-conversation';
import {
  RedactionTally,
  remainingReviewTokens,
  REVIEW_REPLY_FEATURE,
  reviewCallSettings,
  reviewSender,
  reviewUsageToday,
} from './usage';

export type { ReplyIssue } from './prompts';

/*
 * The answer to a person's reply in a thread Qualor started (6I-4, spec §9): one conversation with
 * the model over the finding, Qualor's first note, the people's notes and, when the merge request
 * has a snapshot, the repository through the review's read-only tools. It decides a verdict and
 * the words of the answer. It posts nothing and writes no ledger row: the job that answers does,
 * from what it returns (reply-job.ts).
 *
 * What the people wrote is untrusted data, and so is Qualor's own note, which for a finding of the
 * AI review holds model text: all of it is masked, cut and put in the data envelope (envelope.ts)
 * with the finding's words. Nothing in it can widen what the thread allows. The model is told which
 * verdicts the thread allows, but the code decides: an answer outside them, or a verdict its intent
 * or the conversation does not bear out, is asked for again once, in the same conversation, with a
 * fixed text that says what was wrong, and then given up (`bad_answer`). So a reply that tries to
 * steer the model can change at most the status of its own thread's finding; only when the people
 * who replied may change a status (the rights the caller read, `mayChangeStatus`, never what the
 * model makes of their words); and only as a person's decision of priority, or a claim that the
 * finding's own file was really read to confirm, allows.
 *
 * `decideReply` is what the job calls: it takes the day's budget, the model of the reply's tier and
 * the provider's calls, each recorded as a `review-reply` row. `runReplyConversation` is the
 * conversation and its checks, which need no database.
 */

/** What the conversation spent, and the model it went to. */
export interface ReplyUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The estimated cost of the calls that were counted; null when no prices are set. */
  costMicroUsd: number | null;
}

/**
 * What a conversation came to: a verdict with the words to post (empty when there is nothing to
 * say), and whether the model read the finding's own file (a `read_file` that showed lines of it,
 * or a `grep` that matched in it); or why it decided nothing; or that it was stopped (the server is
 * stopping, or the caller asked it to), which is no failure of the answer. The decision the ledger
 * stores (replies.ts) is another type.
 */
export type DecidedReply =
  | { verdict: ReplyVerdict; answer: string; readCode: boolean; usage: ReplyUsage }
  | { failed: 'bad_answer' | 'provider_error' | 'provider_no_tools' | 'budget_spent' }
  | { stopped: true };

export interface ReplyInput {
  issue: ReplyIssue;
  /** Qualor's first note of the thread, as it was posted. */
  firstNote: string;
  /** The people's notes of the round, oldest first. */
  notes: readonly { author: string; body: string }[];
  /**
   * Whether every person whose note is in the round may change the issue's status: the SCM rights
   * the caller read (GitLab: access level Developer or more on the project; GitHub: author
   * association OWNER, MEMBER or COLLABORATOR). A status change is a triage decision, and on a
   * public repository anyone can reply: the intent the model reads out of a note is no authorisation.
   */
  mayChangeStatus: boolean;
  /** The snapshot the tools read; null when there is none, and the model is then given no tools. */
  snapshot: SnapshotReader | null;
}

/** An open finding of the AI review: the one kind of thread a person's reply may change. */
const changeable = (issue: Pick<ReplyIssue, 'engine' | 'status'>): boolean =>
  issue.engine === AI_ENGINE && issue.status === 'open';

/**
 * The verdicts a thread allows: every one for an open finding of the AI review whose people may
 * change its status (`mayChangeStatus`), which Qualor may then close after a person's reply; `keep`
 * alone for any other, a finding an analyzer reported, one that is no longer open, or one whose
 * people may not change it, which Qualor only answers.
 */
export function allowedVerdicts(
  issue: Pick<ReplyIssue, 'engine' | 'status'>,
  mayChangeStatus: boolean,
): readonly ReplyVerdict[] {
  return changeable(issue) && mayChangeStatus ? REPLY_VERDICTS : ['keep'];
}

/**
 * What is wrong with an answer the thread does not bear out, or null when it does: its verdict is
 * not one of those offered, a `wont_fix` is no decision of priority, or a `false_positive` is no
 * claim of fact (or the finding's own file was not read for it). `keep` is what any intent leads to.
 */
function refusalOf(
  answer: ReplyAnswer,
  offered: readonly ReplyVerdict[],
  readCode: boolean,
): ReplyRefusal | null {
  if (!offered.includes(answer.verdict)) return 'verdict';
  switch (answer.verdict) {
    case 'wont_fix':
      return answer.intent === 'priority' ? null : 'wont_fix';
    case 'false_positive':
      return answer.intent === 'factual' && readCode ? null : 'false_positive';
    case 'keep':
      return null;
  }
}

/**
 * A text is masked up to this many characters: what is shown of any of them is cut shorter still
 * (REPLY_LIMITS), and a secret that straddles the cut is masked whole before it.
 */
export const MASK_INPUT_CHARS = 20_000;
/** What a text is shown as when it could not be masked in time. */
const NOT_MASKED = '[not shown: it could not be masked in time]';

/** What `runReplyConversation` is given besides the thread: where its calls go, and its limits. */
export interface ReplyConversationIo {
  /** One call to the provider: the sender of the job records it; its model and prices are its own. */
  send: ConversationInput['send'];
  /** Asked before every call to the provider. */
  shouldStop: ConversationInput['shouldStop'];
  /**
   * Masks the text of the thread and what the tools answer (`Masker`, never closed here): a
   * person may paste a secret in a reply, and none of it goes to the provider.
   */
  masker: Masker;
  /**
   * The most tokens, input and output of all its calls, the conversation keeps to (as far as it can
   * tell ahead: conversation.ts). With 0 or less it does not start: `budget_spent`.
   */
  tokenBudget: number;
  /** The provider's API key, taken out of the answer; null when there is none. */
  providerKey: string | null;
  /** The administrator's excluded paths, which the tools never show. */
  excludePaths: readonly string[];
  /** The model the calls go to: the decision's usage names it. */
  model: string;
  /** That model's prices, which cost each call; null: no costs. */
  pricing: PricePair | null;
  /** Told the secrets masked in what each call adds: the first message's, then the tools'. */
  redactions?: RedactionTally;
}

/**
 * A text of the thread made fit to send: masked, or the fixed note for one that could not be masked
 * in time (a hostile text), whose secrets are counted on `io.redactions`.
 */
async function maskedText(io: ReplyConversationIo, text: string): Promise<string> {
  if (text === '') return text;
  const result = await io.masker.mask(
    text.length > MASK_INPUT_CHARS ? text.slice(0, MASK_INPUT_CHARS) : text,
  );
  if (result.kind !== 'masked') return NOT_MASKED;
  io.redactions?.add(result.count);
  return result.text;
}

/**
 * The data of the conversation: every text of the thread masked, then cut (`replyData`), the
 * newest notes of the round (the person who is answered wrote the last) and how many older ones
 * are left out. The authors' names are not text of the repository and are not masked.
 */
async function shownData(input: ReplyInput, io: ReplyConversationIo): Promise<ReplyData> {
  const { issue } = input;
  const newest = input.notes.slice(-REPLY_LIMITS.notes);
  const message = await maskedText(io, issue.message);
  const aiBody = issue.aiBody === null ? null : await maskedText(io, issue.aiBody);
  // The lines of a suggestion are masked as the text they make, which keeps as many of them.
  const suggestionLines =
    issue.suggestion === null || issue.suggestion.lines.length === 0
      ? []
      : (await maskedText(io, issue.suggestion.lines.join('\n'))).split('\n');
  const firstNote = await maskedText(io, input.firstNote);
  const notes: { author: string; body: string }[] = [];
  for (const note of newest) {
    notes.push({ author: note.author, body: await maskedText(io, note.body) });
  }
  return replyData({
    issue: {
      ...issue,
      message,
      aiBody,
      suggestion:
        issue.suggestion === null ? null : { ...issue.suggestion, lines: suggestionLines },
    },
    firstNote,
    notes,
    unlistedNotes: input.notes.length - newest.length,
  });
}

/** The conversation and its checks; `runReplyConversation` turns a stop into its result. */
async function decide(input: ReplyInput, io: ReplyConversationIo): Promise<DecidedReply> {
  const { issue, snapshot } = input;
  // What the model may choose: what the thread allows, and of that only what it has the means for.
  const offered = allowedVerdicts(issue, input.mayChangeStatus).filter(
    (verdict) => verdict !== 'false_positive' || snapshot !== null,
  );
  // An open finding of the AI review whose people may not change its status: the prompt says why.
  const membersOnly = changeable(issue) && !input.mayChangeStatus;
  const nonce = newNonce();
  const user = envelope(await shownData(input, io), nonce);

  /**
   * Whether the model has read the finding's own file: a `read_file` that showed lines of it, or a
   * `grep` that showed a match in it, as the tools did it. Nothing else is a reading: not a
   * refusal, not a path that is not there, not a search with no match, not another file.
   */
  let readCode = false;
  /**
   * What a text is: the answer, when it is one the thread bears out; or what to say to ask again,
   * which is a fixed text for an answer the gate refuses, and false for one that is not the JSON
   * asked for (the loop's own words then).
   */
  const judge = (text: string): { answer: ReplyAnswer } | { retry: string | false } => {
    const parsed = parseModelJson(text, ANSWER_CHARS_PER_TOKEN * REVIEW_OUTPUT_TOKENS.reply);
    if (parsed === undefined) return { retry: false };
    const checked = replyAnswerSchema.safeParse(scrubKeyDeep(parsed, io.providerKey));
    if (!checked.success) return { retry: false };
    const refusal = refusalOf(checked.data, offered, readCode);
    return refusal === null
      ? { answer: checked.data }
      : { retry: replyRetryText(refusal, offered) };
  };
  let cost = 0;
  const send: ConversationInput['send'] = async (conversation) => {
    const turn = await io.send(conversation);
    cost += costOf(io.pricing, turn.usage) ?? 0;
    return turn;
  };

  const result = await converseOverTools(
    {
      role: 'reply',
      system: replySystemPrompt({ verdicts: offered, tools: snapshot !== null, membersOnly }),
      user,
      nonce,
      tokenBudget: io.tokenBudget,
      accept: (text) => {
        const judged = judge(text);
        return 'answer' in judged ? true : judged.retry;
      },
    },
    snapshot === null
      ? { reader: null, send, shouldStop: io.shouldStop }
      : {
          reader: snapshot,
          policy: newToolPolicy({
            excludePaths: io.excludePaths,
            masked: new MaskedFiles(snapshot, { masker: io.masker }),
            masker: io.masker,
          }),
          send,
          shouldStop: io.shouldStop,
          onToolRedactions: (count) => io.redactions?.add(count),
          onToolRead: (paths) => {
            if (issue.path !== null && paths.includes(issue.path)) readCode = true;
          },
        },
  );
  if (result.kind === 'stopped') return { stopped: true };
  if (result.kind === 'failed') return { failed: result.reason };
  // Checked again: a conversation that gave an answer back is not believed without it.
  const judged = judge(result.text);
  if (!('answer' in judged)) return { failed: 'bad_answer' };
  return {
    verdict: judged.answer.verdict,
    answer: judged.answer.answer,
    readCode,
    usage: {
      model: io.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicroUsd: io.pricing === null ? null : cost,
    },
  };
}

/**
 * Runs the conversation that answers the reply, and checks what it says. The model is told which
 * verdicts the thread allows, without `false_positive` when there is no snapshot, and is given the
 * review's tools over the snapshot when there is one, with a tool budget of its own. Its last
 * message has to be the JSON of `replyAnswerSchema`, the provider's key taken out, and the thread
 * has to bear it out (`refusalOf`); one that does not is asked for again once, with a fixed text
 * that says what was wrong, and then the conversation fails as a `bad_answer`. What it spent is
 * reported, with the model it went to, when it answers; the cost is that of the calls the provider
 * counted, at `io.pricing`.
 *
 * A stop is `stopped`: the caller asks to stop, or a masking or a reading is given up while it
 * does, which is no error of the answer. Any other error is thrown.
 */
export async function runReplyConversation(
  input: ReplyInput,
  io: ReplyConversationIo,
): Promise<DecidedReply> {
  if (!(io.tokenBudget > 0)) return { failed: 'budget_spent' };
  try {
    return await decide(input, io);
  } catch (err) {
    if (await io.shouldStop()) return { stopped: true };
    throw err;
  }
}

// ─── What the job calls ──────────────────────────────────────────────────────

export interface ReplyDeps {
  db: Executor;
  /** The circuit is the `llm` worker's: the reply and its explain, triage and fix share it. */
  runtime: Pick<LlmRuntime, 'circuit'>;
  config: Pick<Config, 'secretKey' | 'llmInternalHosts'>;
  /** The settings the answer is made with: the provider and its key, the budgets and the prices. */
  settings: StoredLlmSettings;
  /** The organisation whose day the answer draws on. */
  organizationId: string;
  /**
   * The ledger row the answer is for: its project owns the rows of the calls, and its id is the
   * key their stored prompts and log lines carry.
   */
  reply: { id: string; projectId: string };
  /**
   * Asked before every call to the provider: whether the answer should stop for a reason of the
   * caller's (review switched off, the merge request closed). The server stopping always stops it.
   */
  shouldStop?: () => Promise<boolean>;
  /** Gives up the call in flight and the masking when it aborts: the server is stopping. */
  signal?: AbortSignal;
  /** Gets one line for each call: the reply, the outcome and the counts, never what was said. */
  logger?: WorkerLogger;
}

/**
 * The tokens the answer may use now: the least of REPLY_TOKEN_BUDGET, in the place of a review's
 * ceiling, and what the organisation's day and its project's have left (`remainingReviewTokens`,
 * for the reviews and the answers to replies together).
 */
async function tokensLeft(deps: ReplyDeps, provider: StoredProvider): Promise<number> {
  const { db, settings, organizationId } = deps;
  const [organization, project] = await Promise.all([
    reviewUsageToday(db, organizationId),
    reviewUsageToday(db, organizationId, deps.reply.projectId),
  ]);
  return remainingReviewTokens(
    { ...effectiveReviewBudgets(settings, organizationId), maxTokensPerReview: REPLY_TOKEN_BUDGET },
    { organization, project },
    settings.pricing,
    provider,
  );
}

/**
 * Decides the answer to a reply: it asks what the day has left for it (nothing: `budget_spent`,
 * with no call made), then runs `runReplyConversation` on the model of the `reply` tier at that
 * model's prices, with every call sent through the review's sender as a `review-reply` row, written
 * finished, with the review's 300 s floor on the wait for each. A stop of the server, or of the
 * caller, is `stopped`. Nothing is posted and no ledger row is written: the caller does that with
 * what comes back.
 */
export async function decideReply(input: ReplyInput, deps: ReplyDeps): Promise<DecidedReply> {
  const { settings } = deps;
  const provider = settings.provider;
  const key = providerApiKey(settings, deps.config.secretKey);
  // No provider, or a key that no longer decrypts (the server's secret key changed): no call can be made.
  if (provider === null || !key.ok) return { failed: 'provider_error' };
  const tokenBudget = await tokensLeft(deps, provider);
  const tier = tierOfCall('reply', null);
  const model = modelFor(provider, tier);
  const pricing = pricingFor(settings.pricing, provider, tier);
  const redactions = new RedactionTally();
  const send = reviewSender({
    db: deps.db,
    runtime: deps.runtime,
    config: deps.config,
    settings: reviewCallSettings(settings),
    model,
    pricing,
    feature: REVIEW_REPLY_FEATURE,
    source: { projectId: deps.reply.projectId, promptKey: deps.reply.id },
    promptVersion: REPLY_PROMPT_VERSION,
    redactions,
    logger: deps.logger,
    signal: deps.signal,
  });
  const masker = new Masker({ signal: deps.signal });
  try {
    return await runReplyConversation(input, {
      send,
      shouldStop: async () => deps.signal?.aborted === true || (await deps.shouldStop?.()) === true,
      masker,
      tokenBudget,
      providerKey: key.key,
      excludePaths: settings.excludePaths,
      model,
      pricing,
      redactions,
    });
  } finally {
    await masker.close();
  }
}
