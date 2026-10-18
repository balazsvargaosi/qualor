import { z } from 'zod';
import { ERROR_TEXTS } from '../../llm/errors';
import type { AiRequestDto } from '../../llm/dto';
import { truncate } from '../format';
import { unwrap, type McpCaller } from '../inject';
import { ToolError, type McpTool } from '../tool';

/**
 * Ruling R1: how long a tool call waits for the model before answering `pending`, and how often it
 * looks. Exported and mutable so tests can set the wait to 0.
 */
export const aiWait = { ms: 20_000, pollMs: 1_000 };

type AiFeature = 'explain' | 'fix';

export type AiOutcome =
  | { status: 'succeeded'; requestId: string; result: NonNullable<AiRequestDto['result']> }
  | { status: 'pending'; requestId: string }
  | { status: 'failed'; requestId: string; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `PROVIDER_TIMEOUT: The model did not answer in time` (`OUTPUT_REFUSED` adds the rule). */
function failureText(error: NonNullable<AiRequestDto['error']>): string {
  const rule = error.detail ? ` (${error.detail})` : '';
  return `${error.code}${rule}: ${ERROR_TEXTS[error.code]}`;
}

/**
 * Posts the request (or, with `requestId`, reads that one), then polls up to `aiWait.ms`. A
 * `requestId` must belong to `issueId` and `feature`, so a tool never reads another issue's or
 * another feature's request.
 */
export async function pollAi(
  call: McpCaller,
  issueId: string,
  feature: AiFeature,
  requestId?: string,
): Promise<AiOutcome> {
  let row: AiRequestDto;
  if (requestId) {
    row = unwrap(await call.get<AiRequestDto>(`/api/v0/ai-requests/${requestId}`));
    if (row.issueId !== issueId || row.feature !== feature) {
      throw new ToolError(
        `That request is not a ${feature} request for this issue`,
        'REQUEST_MISMATCH',
      );
    }
  } else {
    row = unwrap(
      await call.post<AiRequestDto>(`/api/v0/issues/${issueId}/ai/${feature}`, { refresh: false }),
    );
  }
  const deadline = Date.now() + aiWait.ms;
  while ((row.status === 'queued' || row.status === 'running') && Date.now() < deadline) {
    await sleep(aiWait.pollMs);
    row = unwrap(await call.get<AiRequestDto>(`/api/v0/ai-requests/${row.id}`));
  }
  if (row.status === 'succeeded' && row.result) {
    return { status: 'succeeded', requestId: row.id, result: row.result };
  }
  if (row.status === 'failed' || row.status === 'succeeded') {
    return {
      status: 'failed',
      requestId: row.id,
      error: row.error ? failureText(row.error) : 'The AI request produced no usable answer',
    };
  }
  return { status: 'pending', requestId: row.id };
}

const input = z.object({
  issueId: z.uuid().describe('From qualor_issues'),
  requestId: z.uuid().optional().describe('From a previous pending answer, to read it'),
});

function outcomeText(
  outcome: AiOutcome,
  render: (result: NonNullable<AiRequestDto['result']>) => string,
): string {
  if (outcome.status === 'pending') {
    return `The AI assistant is still working; call again with requestId "${outcome.requestId}".`;
  }
  if (outcome.status === 'failed') return `The AI assistant failed: ${outcome.error}`;
  return truncate(render(outcome.result));
}

function renderExplanation(result: NonNullable<AiRequestDto['result']>): string {
  if (result.kind !== 'explain') return 'The AI assistant answered with another kind of result.';
  return [
    result.summary,
    result.explanation,
    result.howToFix ? `How to fix:\n${result.howToFix}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderFix(result: NonNullable<AiRequestDto['result']>): string {
  if (result.kind !== 'fix') return 'The AI assistant answered with another kind of result.';
  if (result.status === 'not_applicable') {
    return `No fix applies: ${result.explanation}`;
  }
  const diff = [
    ...result.original.map((l) => `- ${l}`),
    ...result.replacement.map((l) => `+ ${l}`),
  ].join('\n');
  return [result.explanation, `Replace lines ${result.startLine}–${result.endLine}:\n${diff}`].join(
    '\n\n',
  );
}

export const explainTool: McpTool<typeof input> = {
  name: 'qualor_explain',
  title: 'Explain an issue',
  description:
    'Asks this server’s AI assistant (the organisation’s own model) to explain an issue. Needs the assistant to be on for the organisation. If it answers pending, call again with the requestId.',
  access: 'ai',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run({ issueId, requestId }, { call }) {
    const outcome = await pollAi(call, issueId, 'explain', requestId);
    return { text: outcomeText(outcome, renderExplanation), structured: outcome };
  },
};

export const suggestFixTool: McpTool<typeof input> = {
  name: 'qualor_suggest_fix',
  title: 'Suggest a fix',
  description:
    'Asks this server’s AI assistant for a fix suggestion (an explanation and the replacement lines). Nothing is posted anywhere; apply it yourself if it is right. If it answers pending, call again with the requestId.',
  access: 'ai',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run({ issueId, requestId }, { call }) {
    const outcome = await pollAi(call, issueId, 'fix', requestId);
    return { text: outcomeText(outcome, renderFix), structured: outcome };
  },
};
