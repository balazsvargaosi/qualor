import { cutAtGrapheme } from '@qualor/shared';
import {
  LlmCallAborted,
  LlmError,
  type LlmConversation,
  type LlmMessage,
  type LlmToolCall,
  type LlmToolSpec,
  type LlmTurn,
} from '../llm/providers';
import { toolResultMessage } from './envelope';

/*
 * The conversation a reviewer has with the model over the read-only tools (llm.md §2.5, review.md
 * §9.1). The provider layer answers one turn at a time and runs nothing; this loop sends a turn,
 * runs the calls the model made, sends the results and goes on, until the model answers in text.
 * It owns what bounds a model: the caps on turns, on calls per turn and on the arguments it sends,
 * the wrap-up turn when the tokens or the turns are used up, the retries, and the stop check
 * before every call to the provider. It does not make a call itself (`send` does, and records
 * it), run a tool (`runTool`) or read an answer's JSON (the pipeline does).
 *
 * Nothing the model said is logged here, and nothing in the result of a conversation that did not
 * answer carries any of it.
 */

export const CONVERSATION_LIMITS = {
  /** Turns the model may take with tools; the wrap-up turn comes after the last of them. */
  maxTurns: 16,
  maxCallsPerTurn: 8,
  /** The share of the token budget after which the next turn is the wrap-up. */
  wrapUpAt: 0.85,
  /** Arguments of one call, as JSON text. */
  maxArgumentBytes: 16_384,
  /** Levels of objects and lists inside the arguments of one call; the arguments are level 1. */
  maxArgumentDepth: 20,
} as const;

/** How a call the provider failed is tried again; each call of the conversation has its own. */
export const CONVERSATION_RETRIES = {
  /** Retries after a rate limit, each after the provider's Retry-After. */
  rateLimited: 2,
  /** Retries in all after a timeout or an unreachable provider. */
  transient: 1,
  /** The waits, in seconds, when the provider named none: llm.md §14's backoff. */
  backoffSeconds: [5, 30],
  minWaitSeconds: 1,
  maxWaitSeconds: 60,
} as const;

/** What the loop itself says to the model, word for word. */
export const CONVERSATION_TEXTS = {
  wrapUp: 'Token budget reached: answer now, with what you have, in the required JSON.',
  shorter:
    'Your answer was cut off because it was too long: answer again, shorter, in the required JSON.',
  /** After an answer the caller did not accept (`accept`), when it gave no text of its own. */
  retry: 'Your answer did not match the required JSON; answer again with JSON only.',
  tooManyCalls: 'too many calls in one turn; this one was not run',
  badArguments: 'the arguments were not valid JSON; call again',
} as const;

/** Characters of a tool's name the envelope shows. */
const TOOL_LABEL_CHARS = 100;
/** The refusals of a request that tools can be the reason for. */
const TOOL_REFUSAL_STATUSES: readonly number[] = [400, 404, 422];

export interface ConversationInput {
  system: string;
  /** The first message: the data under review, already in its envelope (envelope.ts). */
  user: string;
  /** The nonce of that envelope: every tool message is put between the same markers. */
  nonce: string;
  tools: readonly LlmToolSpec[];
  /**
   * Runs one call and answers what to tell the model. It is given the arguments checked and
   * limited here. A rejection (a closed masker, a reader that failed) ends the conversation.
   */
  runTool: (call: LlmToolCall) => Promise<string>;
  limits: {
    maxTurns: number;
    maxCallsPerTurn: number;
    /**
     * The tokens, input and output of all its calls, the conversation stays within as far as it
     * can tell ahead: at 85 % of it, or when another turn of tools would leave no room for the
     * wrap-up after it, the next turn is the wrap-up (`wrapUpDue`). That call can still go past it,
     * by as much as the guesses fell short, and by more when the first turn of tools already left
     * no room for it. More than 0: a caller with nothing to spend does not start a conversation.
     */
    tokenBudget: number;
    maxOutputTokens: number;
  };
  /**
   * One call to the provider, recorded, through its circuit. It throws an `LlmError` for a call
   * the provider did not answer, a `CircuitOpenError` for one it was not asked, which fails the
   * conversation at once, and an `LlmCallAborted` for one its caller gave up (the server is
   * stopping), which stops it. Anything else it throws ends the conversation.
   */
  send: (conversation: LlmConversation) => Promise<LlmTurn>;
  /** Asked before every call to the provider, a retry included. */
  shouldStop: () => Promise<boolean>;
  /**
   * Whether an answer is one the caller can use (its JSON reads as the caller's schema): `true`
   * takes it. One that is not is asked for once more, in the same conversation; without a check
   * every answer is used. A caller that says no with `false` gets the loop's own words (`retry`
   * of CONVERSATION_TEXTS); one that says no with a text gets that text sent in their place, which
   * can say what was wrong. It is fixed text: never a word of the answer that was refused. A blank
   * text is no text.
   */
  accept?: (text: string) => boolean | string;
  /**
   * How a retry waits, in milliseconds.
   * @internal Tests only: nothing else sets it.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What a conversation spent and did, whichever way it ended: a conversation that fails after
 * spending its share still counts against the review's ceiling. `turns` counts the provider's
 * answers (retried failures and the stop check not), `toolCalls` the calls that were run. The
 * tokens are the provider's counts; for a count it did not give they are a guess made for the
 * budget (see `tokensOf`). The input of a call that timed out, or whose answer could not be read,
 * is charged as a guess too: the provider most likely billed it, and the day counts it (usage.ts).
 */
export interface ConversationCounts {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  toolCalls: number;
}

/**
 * How a conversation ended. `text` of an answer is the model's: it goes to the parser, never to a
 * log. `budgetReached` says that the answer came after the wrap-up turn.
 */
export type ConversationResult =
  | ({ kind: 'answer'; text: string; budgetReached: boolean } & ConversationCounts)
  | ({ kind: 'stopped' } & ConversationCounts)
  | ({
      kind: 'failed';
      reason: 'provider_error' | 'provider_no_tools' | 'bad_answer';
    } & ConversationCounts);

/** How a conversation ends without an answer, before the counts are put to it. */
type FailureReason = Extract<ConversationResult, { kind: 'failed' }>['reason'];
type Ended = { kind: 'stopped' } | { kind: 'failed'; reason: FailureReason };
const failed = (reason: FailureReason): Ended => ({ kind: 'failed', reason });

/** What `send` throws when it made no call because the provider's circuit is open. */
export class CircuitOpenError extends Error {
  constructor() {
    super('The model provider is failing; Qualor is not calling it for now');
    this.name = 'CircuitOpenError';
  }
}

// ─── The arguments a model sends ─────────────────────────────────────────────

/**
 * Whether objects and lists inside `root` (level 1) go deeper than `limit` levels. It follows the
 * structure with a list of its own, not the call stack, and goes no further than `limit` levels:
 * a model can send arguments that JSON.parse reads and JSON.stringify cannot follow.
 */
function nestedDeeperThan(root: object, limit: number): boolean {
  const pending: { node: object; depth: number }[] = [{ node: root, depth: 1 }];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.depth > limit) return true;
    for (const child of Object.values(item.node)) {
      if (typeof child === 'object' && child !== null) {
        pending.push({ node: child, depth: item.depth + 1 });
      }
    }
  }
  return false;
}

/**
 * The arguments to run a call with, and to echo back in the history, or null when they cannot be
 * either. A call with none has `{}`. Text that was not JSON, a list, a number or a boolean is not
 * an object, which every tool takes; arguments nested too deep or too long are refused before
 * they are written out (a strict server refuses the echo of a raw string, and JSON.stringify of
 * a deep value throws a RangeError, which is not an LlmError).
 */
function usableArguments(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (nestedDeeperThan(raw, CONVERSATION_LIMITS.maxArgumentDepth)) return null;
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (Buffer.byteLength(json, 'utf8') > CONVERSATION_LIMITS.maxArgumentBytes) return null;
  return raw as Record<string, unknown>;
}

// ─── One call to the provider, and what a failure of it means ────────────────

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Whether the provider refused a first request because it carried tools: a refusal of the request
 * itself (400, 404 or 422) whose own words named tools or functions (the provider layer says so
 * with `refusedTools`). A server without tool calling cannot review, whatever else is right. The
 * provider test reads a refusal the same way.
 */
export function refusedForTools(err: LlmError, tools: readonly LlmToolSpec[]): boolean {
  return (
    tools.length > 0 &&
    err.failure === 'rejected' &&
    err.refusedTools &&
    err.status !== null &&
    TOOL_REFUSAL_STATUSES.includes(err.status)
  );
}

/**
 * The seconds to wait before trying a failed call again, counted against the retries of that call
 * (`retried`), or null when it is not tried again: a rate limit waits what the provider asked, but
 * never more than a minute and never less than a second, and twice at most; a timeout or an
 * unreachable provider waits the backoff, once in all; anything else is not tried again.
 */
function retryWait(
  err: LlmError,
  retried: { rateLimited: number; transient: number },
): number | null {
  const { backoffSeconds, minWaitSeconds, maxWaitSeconds } = CONVERSATION_RETRIES;
  if (err.failure === 'rate_limited' && retried.rateLimited < CONVERSATION_RETRIES.rateLimited) {
    const asked = err.retryAfterSeconds ?? backoffSeconds[retried.rateLimited] ?? maxWaitSeconds;
    retried.rateLimited += 1;
    return Math.min(maxWaitSeconds, Math.max(minWaitSeconds, asked));
  }
  if (
    (err.failure === 'timeout' || err.failure === 'unavailable') &&
    retried.transient < CONVERSATION_RETRIES.transient
  ) {
    retried.transient += 1;
    return backoffSeconds[0];
  }
  return null;
}

/** A turn of the model, with the conversation that was sent for it. */
interface Taken {
  turn: LlmTurn;
  sent: LlmConversation;
}

/** The bytes of JSON a token is guessed to stand for. The day guesses the same (usage.ts). */
const BYTES_PER_TOKEN = 4;

/** The guess for the tokens of what is sent as JSON: a quarter of a token for each byte. */
const guessedTokens = (value: unknown): number =>
  Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / BYTES_PER_TOKEN);

/** The guess for the input of a call the provider did not count: the JSON that was sent. */
const guessedInput = (sent: LlmConversation): number => guessedTokens(sent);

/**
 * The model's next turn, or why there is none: the stop check is asked before every call, a
 * failed call is tried again as `retryWait` says, and the first call refused for its tools ends
 * the conversation as such. A call the provider most likely billed although it gave no turn, one
 * that timed out or whose answer could not be read, is charged its guessed input through `charge`.
 * A call its caller gave up stops the conversation: it is no failure of the provider's, so it is
 * neither tried again nor charged.
 */
async function nextTurn(
  input: ConversationInput,
  conversation: () => LlmConversation,
  first: boolean,
  charge: (inputTokens: number) => void,
): Promise<Taken | Ended> {
  const retried = { rateLimited: 0, transient: 0 };
  for (;;) {
    if (await input.shouldStop()) return { kind: 'stopped' };
    const sent = conversation();
    try {
      return { turn: await input.send(sent), sent };
    } catch (err) {
      if (err instanceof CircuitOpenError) return failed('provider_error');
      if (err instanceof LlmCallAborted) return { kind: 'stopped' };
      if (!(err instanceof LlmError)) throw err;
      if (first && refusedForTools(err, input.tools)) return failed('provider_no_tools');
      if (err.failure === 'timeout' || err.failure === 'bad_answer') charge(guessedInput(sent));
      const wait = retryWait(err, retried);
      if (wait === null) return failed('provider_error');
      await (input.sleep ?? sleepFor)(wait * 1_000);
    }
  }
}

// ─── The calls of a turn ─────────────────────────────────────────────────────

/**
 * Adds the model's turn to the history, with every call echoed (so that each has its answer), and
 * the answer to each: the first `maxCallsPerTurn` calls are run, in order, unless their arguments
 * are unusable, and the others are told there were too many. Every answer is put in the data
 * envelope. Returns how many calls were run.
 */
async function answerCalls(
  input: ConversationInput,
  text: string,
  calls: readonly LlmToolCall[],
  messages: LlmMessage[],
): Promise<number> {
  const prepared = calls.map((call) => ({ call, args: usableArguments(call.arguments) }));
  messages.push({
    role: 'assistant',
    text,
    toolCalls: prepared.map(({ call, args }) => ({
      id: call.id,
      name: call.name,
      arguments: args ?? {},
    })),
  });
  let run = 0;
  for (const [index, { call, args }] of prepared.entries()) {
    let answer: string;
    if (index >= input.limits.maxCallsPerTurn) {
      answer = CONVERSATION_TEXTS.tooManyCalls;
    } else if (args === null) {
      answer = CONVERSATION_TEXTS.badArguments;
    } else {
      answer = await input.runTool({ id: call.id, name: call.name, arguments: args });
      run += 1;
    }
    messages.push({
      role: 'tool',
      callId: call.id,
      name: call.name,
      text: toolResultMessage(cutAtGrapheme(call.name, TOOL_LABEL_CHARS), answer, input.nonce),
    });
  }
  return run;
}

// ─── The conversation ────────────────────────────────────────────────────────

/**
 * What a turn costs the budget: the provider's counts, and for a count it did not give a guess, so
 * that a provider which counts nothing cannot spend without limit. The guess for the input is
 * `guessedInput`, and for the output the longest answer a call may write. The conversation is
 * serialised only when the input count is missing.
 */
function tokensOf(
  turn: LlmTurn,
  sent: LlmConversation,
  maxOutputTokens: number,
): { input: number; output: number } {
  return {
    input: turn.usage.inputTokens ?? guessedInput(sent),
    output: turn.usage.outputTokens ?? maxOutputTokens,
  };
}

/**
 * Whether the turn after a turn of tools must be the wrap-up for the tokens: `used` has reached
 * 85 % of the budget, or another turn of tools would leave no room for the wrap-up after it. Both
 * calls are guessed from the last one (`last`, what it cost) and from what its tools answered
 * (`grown`), since the history only grows:
 * - the next call sends the last one's input, its output and what the tools answered, and writes
 *   as much as the last one wrote;
 * - the wrap-up after it sends that call's input and output again, with as much more from its
 *   tools, and writes at most `maxOutputTokens`.
 * The wrap-up can still go past the budget: by as much as those guesses fall short, or when the
 * first turn of tools, which runs before anything is known of what a turn costs, already left no
 * room for it. A whole turn of tools past it cannot.
 */
function wrapUpDue(
  limits: ConversationInput['limits'],
  used: number,
  last: { input: number; output: number },
  grown: number,
): boolean {
  if (used >= CONVERSATION_LIMITS.wrapUpAt * limits.tokenBudget) return true;
  const nextInput = last.input + last.output + grown;
  const nextCall = nextInput + last.output;
  const wrapUpAfter = nextInput + last.output + grown + limits.maxOutputTokens;
  return used + nextCall + wrapUpAfter >= limits.tokenBudget;
}

/**
 * Talks with the model until it answers in text:
 * - the tool list goes with every turn, the wrap-up included (Anthropic refuses tool blocks in the
 *   history without it);
 * - once the model has had `maxTurns` turns, or the calls have used 85 % of the token budget, or
 *   another turn of tools would leave no room for the wrap-up after it (`wrapUpDue`), the next turn
 *   is the wrap-up: a user message that says to answer now. Calls in its answer are not run, and
 *   its text is the answer;
 * - a call is told apart by what is there, not by the finish reason: `tool` also comes without
 *   calls, and then text is an answer and no text is none;
 * - an answer cut off at the output limit is asked for again, shorter, once; a refusal, a blank
 *   answer and a call id used twice in a turn end the conversation as a bad answer;
 * - an answer the caller does not accept (`accept`) is asked for again once: the answer stays in
 *   the history and a user message says what was wrong with it (the caller's text, or the loop's
 *   own). From then on calls are not run, and that turn may go past the budget, as the wrap-up's
 *   may; a second answer it does not accept ends the conversation as a bad answer.
 *
 * Every end reports what was spent (`ConversationCounts`), the tokens of a call the provider did
 * not count being guessed. The token budget must be more than 0 (see `limits.tokenBudget`).
 */
export async function runConversation(input: ConversationInput): Promise<ConversationResult> {
  const { limits } = input;
  const messages: LlmMessage[] = [{ role: 'user', text: input.user }];
  // A copy of the history for each call: what `send` is given is not changed after it.
  const conversation = (): LlmConversation => ({
    system: input.system,
    messages: [...messages],
    tools: input.tools,
    maxOutputTokens: limits.maxOutputTokens,
  });
  let turns = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let wrappingUp = false;
  let askedForShorter = false;
  /** An answer was not accepted: the model is asked for it again, and runs no more tools. */
  let askedAgain = false;
  /** An end without an answer, with what the conversation spent. */
  const ended = (end: Ended): ConversationResult => ({
    ...end,
    inputTokens,
    outputTokens,
    turns,
    toolCalls,
  });

  for (;;) {
    const next = await nextTurn(input, conversation, turns === 0, (guessed) => {
      inputTokens += guessed;
    });
    if (!('turn' in next)) return ended(next);
    const { turn, sent } = next;
    turns += 1;
    const spent = tokensOf(turn, sent, limits.maxOutputTokens);
    inputTokens += spent.input;
    outputTokens += spent.output;
    if (turn.finishReason === 'refusal') return ended(failed('bad_answer'));

    if (turn.toolCalls.length > 0 && !wrappingUp && !askedAgain) {
      const ids = new Set(turn.toolCalls.map((call) => call.id));
      if (ids.size !== turn.toolCalls.length) return ended(failed('bad_answer'));
      // The model's turn joins the history first, then the answers to its calls.
      const answersFrom = messages.length + 1;
      toolCalls += await answerCalls(input, turn.text, turn.toolCalls, messages);
      const grown = guessedTokens(messages.slice(answersFrom));
      if (turns >= limits.maxTurns || wrapUpDue(limits, inputTokens + outputTokens, spent, grown)) {
        messages.push({ role: 'user', text: CONVERSATION_TEXTS.wrapUp });
        wrappingUp = true;
      }
      continue;
    }

    if (turn.finishReason === 'length' && turn.toolCalls.length === 0) {
      if (askedForShorter) return ended(failed('bad_answer'));
      askedForShorter = true;
      // The API refuses an assistant message with nothing in it.
      if (turn.text.trim() !== '') {
        messages.push({ role: 'assistant', text: turn.text, toolCalls: [] });
      }
      messages.push({ role: 'user', text: CONVERSATION_TEXTS.shorter });
      continue;
    }

    if (turn.text.trim() === '') return ended(failed('bad_answer'));
    const accepted = input.accept?.(turn.text) ?? true;
    if (accepted !== true) {
      if (askedAgain) return ended(failed('bad_answer'));
      askedAgain = true;
      // The calls of this turn, if any, were not run: the answer goes back as text alone.
      messages.push({ role: 'assistant', text: turn.text, toolCalls: [] });
      const said = typeof accepted === 'string' && accepted.trim() !== '';
      messages.push({ role: 'user', text: said ? accepted : CONVERSATION_TEXTS.retry });
      continue;
    }
    return {
      kind: 'answer',
      text: turn.text,
      inputTokens,
      outputTokens,
      turns,
      toolCalls,
      budgetReached: wrappingUp,
    };
  }
}
