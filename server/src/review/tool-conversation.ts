import { REASONING_ALLOWANCE_TOKENS } from '../llm/providers';
import {
  CONVERSATION_LIMITS,
  runConversation,
  type ConversationInput,
  type ConversationResult,
} from './conversation';
import type { MaskedFiles } from './masked-files';
import type { Masker } from './masker';
import type { ConversationRole } from './model-tiers';
import { REVIEW_OUTPUT_TOKENS } from './pipeline';
import { SYSTEM_PROMPTS } from './prompts';
import type { SnapshotReader } from './snapshot-reader';
import {
  REVIEW_TOOLS,
  runReviewTool,
  TOOL_LIMITS,
  type ShownLines,
  type ToolPolicy,
} from './tools';

/*
 * The parts of a review's conversations that are the same wherever the review runs: the `ai-review`
 * job (job.ts) records every call in the database, the evaluation set (tools/review) calls the
 * provider and records nothing. Each supplies where a call goes (`send`) and when to stop
 * (`shouldStop`); the role's prompt, the tools, their budget and the caps of the loop are these.
 * The answer to a person's reply (reply-engine.ts) is one more conversation of the same kind, with
 * a prompt of its own and, for a merge request that has no snapshot, no tools.
 */

/** One conversation the pipeline asks for (`PipelineDeps.converse`), or a reply's. */
export interface RoleCall {
  role: ConversationRole;
  /**
   * The system prompt, when the role's fixed one (`SYSTEM_PROMPTS`) is not it: the prompt of a
   * reply names the verdicts its thread allows, which no fixed text can.
   */
  system?: string;
  /** The first message: the data under review, in its envelope. */
  user: string;
  /** The nonce of that envelope, which the tools' answers are put in too. */
  nonce: string;
  tokenBudget: number;
  /**
   * The caller's check of an answer (`ConversationInput.accept`): `true` takes it; `false`, or a
   * text, asks once more, with the loop's own words or with that text.
   */
  accept: (text: string) => boolean | string;
}

/** The reader a conversation's tools read, with the policy they run under. */
interface ToolsIo {
  /** The snapshot the tools read. */
  reader: SnapshotReader;
  policy: ToolPolicy;
  /** Told the secrets masked in each tool answer. */
  onToolRedactions?: (count: number) => void;
  /**
   * Told the lines of files a tool answer showed (`ToolAnswer.read`), for each call that showed
   * any: what the model really read, as the tool did it, never as its text says.
   */
  onToolRead?: (shown: readonly ShownLines[]) => void;
}

/**
 * Where a conversation reads, calls and stops. Without a snapshot (`reader: null`) the model is
 * given no tools: a reply can be answered from what its first message holds.
 */
export type ConversationIo = {
  send: ConversationInput['send'];
  shouldStop: ConversationInput['shouldStop'];
  /** Wakes the wait of a retry when it aborts: the server is stopping (`ConversationInput.signal`). */
  signal?: ConversationInput['signal'];
} & (ToolsIo | { reader: null });

/** What a call is answered when it is made though the model has no tools. */
const NO_TOOLS_ANSWER = 'no tools are available; answer from what you were given';

/**
 * The policy of one review's tools: all of its budget of calls, searches and bytes to mask
 * (`TOOL_LIMITS`), over its masked files and its masker, which its caller closes. The budget is
 * shared by every conversation of the review.
 */
export function newToolPolicy(o: {
  excludePaths: readonly string[];
  masked: MaskedFiles;
  masker: Masker;
}): ToolPolicy {
  return {
    excludePaths: o.excludePaths,
    budget: {
      calls: TOOL_LIMITS.callsPerReview,
      greps: TOOL_LIMITS.grepsPerReview,
      maskedBytes: TOOL_LIMITS.maskedBytesPerReview,
    },
    masked: o.masked,
    masker: o.masker,
  };
}

/**
 * One conversation of a role over the read-only tools: the role's system prompt, the three tools
 * run over the reader under its policy (none without a reader), the loop's caps, and the role's
 * output limit: its answer's tokens (REVIEW_OUTPUT_TOKENS) and the room for the model to think
 * before it answers (REASONING_ALLOWANCE_TOKENS), which the loop takes as the most a call may write.
 * The pipeline's contract for `converse` (pipeline.ts).
 */
export function converseOverTools(call: RoleCall, io: ConversationIo): Promise<ConversationResult> {
  return runConversation({
    system: call.system ?? SYSTEM_PROMPTS[call.role],
    user: call.user,
    nonce: call.nonce,
    tools: io.reader === null ? [] : REVIEW_TOOLS,
    runTool: async (toolCall) => {
      // Nothing is run for a model that asks for a tool it was not given: it is told so.
      if (io.reader === null) return NO_TOOLS_ANSWER;
      const answer = await runReviewTool(io.reader, toolCall, io.policy);
      io.onToolRedactions?.(answer.redactions);
      if (answer.read !== undefined) io.onToolRead?.(answer.read);
      return answer.text;
    },
    limits: {
      maxTurns: CONVERSATION_LIMITS.maxTurns,
      maxCallsPerTurn: CONVERSATION_LIMITS.maxCallsPerTurn,
      tokenBudget: call.tokenBudget,
      maxOutputTokens: REVIEW_OUTPUT_TOKENS[call.role] + REASONING_ALLOWANCE_TOKENS.conversation,
    },
    send: io.send,
    shouldStop: io.shouldStop,
    signal: io.signal,
    accept: call.accept,
  });
}
