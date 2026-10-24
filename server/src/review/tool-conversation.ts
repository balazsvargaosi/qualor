import {
  CONVERSATION_LIMITS,
  runConversation,
  type ConversationInput,
  type ConversationResult,
} from './conversation';
import type { MaskedFiles } from './masked-files';
import type { Masker } from './masker';
import { REVIEW_OUTPUT_TOKENS, type ReviewRole } from './pipeline';
import { SYSTEM_PROMPTS } from './prompts';
import type { SnapshotReader } from './snapshot-reader';
import { REVIEW_TOOLS, runReviewTool, TOOL_LIMITS, type ToolPolicy } from './tools';

/*
 * The parts of a review's conversations that are the same wherever the review runs: the `ai-review`
 * job (job.ts) records every call in the database, the evaluation set (tools/review) calls the
 * provider and records nothing. Each supplies where a call goes (`send`) and when to stop
 * (`shouldStop`); the role's prompt, the tools, their budget and the caps of the loop are these.
 */

/** One conversation the pipeline asks for (`PipelineDeps.converse`). */
export interface RoleCall {
  role: ReviewRole;
  /** The first message: the data under review, in its envelope. */
  user: string;
  /** The nonce of that envelope, which the tools' answers are put in too. */
  nonce: string;
  tokenBudget: number;
  /** The pipeline's check of an answer. */
  accept: (text: string) => boolean;
}

/** Where a conversation reads, calls and stops. */
export interface ConversationIo {
  /** The snapshot the tools read. */
  reader: SnapshotReader;
  policy: ToolPolicy;
  send: ConversationInput['send'];
  shouldStop: ConversationInput['shouldStop'];
  /** Told the secrets masked in each tool answer. */
  onToolRedactions?: (count: number) => void;
}

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
 * One conversation of a review role over the read-only tools: the role's system prompt, the three
 * tools run over the review's reader under its policy, the loop's caps, and the role's output
 * limit. The pipeline's contract for `converse` (pipeline.ts).
 */
export function converseOverTools(call: RoleCall, io: ConversationIo): Promise<ConversationResult> {
  return runConversation({
    system: SYSTEM_PROMPTS[call.role],
    user: call.user,
    nonce: call.nonce,
    tools: REVIEW_TOOLS,
    runTool: async (toolCall) => {
      const answer = await runReviewTool(io.reader, toolCall, io.policy);
      io.onToolRedactions?.(answer.redactions);
      return answer.text;
    },
    limits: {
      maxTurns: CONVERSATION_LIMITS.maxTurns,
      maxCallsPerTurn: CONVERSATION_LIMITS.maxCallsPerTurn,
      tokenBudget: call.tokenBudget,
      maxOutputTokens: REVIEW_OUTPUT_TOKENS[call.role],
    },
    send: io.send,
    shouldStop: io.shouldStop,
    accept: call.accept,
  });
}
