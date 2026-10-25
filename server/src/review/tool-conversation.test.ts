import { REDACTED } from '@qualor/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { memorySnapshot } from '../../test/review';
import { LlmError, type LlmConversation, type LlmToolCall, type LlmTurn } from '../llm/providers';
import { CONVERSATION_LIMITS, CONVERSATION_TEXTS } from './conversation';
import { newNonce } from './envelope';
import { MaskedFiles } from './masked-files';
import { Masker } from './masker';
import { REVIEW_OUTPUT_TOKENS } from './pipeline';
import { SYSTEM_PROMPTS } from './prompts';
import { converseOverTools, newToolPolicy, type RoleCall } from './tool-conversation';
import { REVIEW_TOOLS, TOOL_LIMITS } from './tools';

/** The masker of the tests: one worker for all of them, stopped when they are done. */
const masker = new Masker();
afterAll(() => masker.close());

/** The AWS documentation's example key: the redaction takes it out of a file. */
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

const turn = (over: Partial<LlmTurn>): LlmTurn => ({
  text: '',
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 10 },
  model: null,
  toolCalls: [],
  ...over,
});

const callOf = (role: RoleCall['role'], over: Partial<RoleCall> = {}): RoleCall => ({
  role,
  user: 'The data',
  nonce: newNonce(),
  tokenBudget: 1_000_000,
  accept: () => true,
  ...over,
});

describe('newToolPolicy', () => {
  it('gives a review the whole of its budget, and the files, masker and exclusions it is given', () => {
    const reader = memorySnapshot();
    const masked = new MaskedFiles(reader, { masker });
    const policy = newToolPolicy({ excludePaths: ['vendor/**'], masked, masker });
    expect(policy).toEqual({
      excludePaths: ['vendor/**'],
      budget: {
        calls: TOOL_LIMITS.callsPerReview,
        greps: TOOL_LIMITS.grepsPerReview,
        maskedBytes: TOOL_LIMITS.maskedBytesPerReview,
      },
      masked,
      masker,
    });
    expect(policy.masked).toBe(masked);
    expect(policy.masker).toBe(masker);
    // Each review has a budget of its own: spending one's calls leaves the next one's.
    policy.budget.calls = 0;
    expect(newToolPolicy({ excludePaths: [], masked, masker }).budget.calls).toBe(
      TOOL_LIMITS.callsPerReview,
    );
  });
});

describe('converseOverTools', () => {
  it("sends the role's prompt and limit with the review tools, and returns the answer", async () => {
    const reader = memorySnapshot();
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    const roles = ['security', 'quality', 'judge', 'verify'] as const;
    for (const role of roles) {
      const sent: LlmConversation[] = [];
      const result = await converseOverTools(callOf(role, { user: `data of ${role}` }), {
        reader,
        policy,
        send: (conversation) => {
          sent.push(conversation);
          return Promise.resolve(turn({ text: '{"ok":true}' }));
        },
        shouldStop: () => Promise.resolve(false),
      });
      expect(result).toMatchObject({ kind: 'answer', text: '{"ok":true}', toolCalls: 0 });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        system: SYSTEM_PROMPTS[role],
        tools: REVIEW_TOOLS,
        maxOutputTokens: REVIEW_OUTPUT_TOKENS[role],
        messages: [{ role: 'user', text: `data of ${role}` }],
      });
    }
  });

  it('runs the tool calls over the reader under the policy, and tells the secrets it masked', async () => {
    const reader = memorySnapshot({
      files: { 'src/config.ts': `const region = 'eu';\nconst key = "${AWS_KEY}";\n` },
    });
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    const nonce = newNonce();
    const sent: LlmConversation[] = [];
    const redactions: number[] = [];
    const replies = [
      turn({
        finishReason: 'tool',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/config.ts' } }],
      }),
      turn({ text: '{"findings":[]}' }),
    ];
    const result = await converseOverTools(callOf('quality', { nonce }), {
      reader,
      policy,
      send: (conversation) => {
        sent.push(conversation);
        return Promise.resolve(replies.shift() ?? turn({ text: 'unexpected' }));
      },
      shouldStop: () => Promise.resolve(false),
      onToolRedactions: (count) => redactions.push(count),
    });
    expect(result).toMatchObject({
      kind: 'answer',
      text: '{"findings":[]}',
      toolCalls: 1,
      turns: 2,
    });
    // The tool ran over this reader: the model was given the masked file, in the review's envelope.
    const answered = sent[1]?.messages.find((message) => message.role === 'tool');
    expect(answered?.text).toContain(REDACTED);
    expect(answered?.text).not.toContain(AWS_KEY);
    expect(answered?.text).toContain(nonce);
    expect(redactions).toEqual([1]);
    // And it spent the policy's budget, which the next conversation of the review shares.
    expect(policy.budget.calls).toBe(TOOL_LIMITS.callsPerReview - 1);
  });

  it('runs as many calls of a turn as the loop allows, and asks again for an answer the pipeline refuses', async () => {
    const reader = memorySnapshot();
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    const tooMany = Array.from({ length: CONVERSATION_LIMITS.maxCallsPerTurn + 2 }, (_, i) => ({
      id: `call-${i}`,
      name: 'list_files',
      arguments: {},
    }));
    const asked: string[] = [];
    const replies = [
      turn({ finishReason: 'tool', toolCalls: tooMany }),
      turn({ text: 'not json' }),
      turn({ text: '{"ok":true}' }),
    ];
    const result = await converseOverTools(
      callOf('tests', {
        accept: (text) => {
          asked.push(text);
          return text.startsWith('{');
        },
      }),
      {
        reader,
        policy,
        send: () => Promise.resolve(replies.shift() ?? turn({ text: 'unexpected' })),
        shouldStop: () => Promise.resolve(false),
      },
    );
    expect(result).toMatchObject({
      kind: 'answer',
      text: '{"ok":true}',
      toolCalls: CONVERSATION_LIMITS.maxCallsPerTurn,
    });
    expect(asked).toEqual(['not json', '{"ok":true}']);
  });

  it('wraps up when the token budget it is given is reached', async () => {
    const reader = memorySnapshot();
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    const sent: LlmConversation[] = [];
    const replies = [
      turn({
        finishReason: 'tool',
        toolCalls: [{ id: 'call-1', name: 'list_files', arguments: {} }],
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      turn({ text: '{"ok":true}' }),
    ];
    const result = await converseOverTools(callOf('security', { tokenBudget: 100 }), {
      reader,
      policy,
      send: (conversation) => {
        sent.push(conversation);
        return Promise.resolve(replies.shift() ?? turn({ text: 'unexpected' }));
      },
      shouldStop: () => Promise.resolve(false),
    });
    expect(result).toMatchObject({ kind: 'answer', budgetReached: true });
    expect(sent[1]?.messages.at(-1)).toEqual({ role: 'user', text: CONVERSATION_TEXTS.wrapUp });
  });

  it('serves the reply role with its own prompt and output limit over the review tools', async () => {
    const reader = memorySnapshot();
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    const sent: LlmConversation[] = [];
    const result = await converseOverTools(callOf('reply', { user: 'The thread' }), {
      reader,
      policy,
      send: (conversation) => {
        sent.push(conversation);
        return Promise.resolve(turn({ text: '{"ok":true}' }));
      },
      shouldStop: () => Promise.resolve(false),
    });
    expect(result).toMatchObject({ kind: 'answer', text: '{"ok":true}' });
    expect(sent[0]).toMatchObject({
      system: SYSTEM_PROMPTS.reply,
      tools: REVIEW_TOOLS,
      maxOutputTokens: REVIEW_OUTPUT_TOKENS.reply,
      messages: [{ role: 'user', text: 'The thread' }],
    });
  });

  it("sends the prompt a call is given instead of its role's", async () => {
    const reader = memorySnapshot();
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    const sent: LlmConversation[] = [];
    const system = 'Qualor review: reply\nThis thread allows one verdict: "keep".';
    await converseOverTools(callOf('reply', { system }), {
      reader,
      policy,
      send: (conversation) => {
        sent.push(conversation);
        return Promise.resolve(turn({ text: '{"ok":true}' }));
      },
      shouldStop: () => Promise.resolve(false),
    });
    expect(sent[0]?.system).toBe(system);
    expect(sent[0]?.system).not.toBe(SYSTEM_PROMPTS.reply);
  });

  it('gives the model no tools without a snapshot, and answers a call it makes anyway with a fixed text that reads nothing', async () => {
    const nonce = newNonce();
    const sent: LlmConversation[] = [];
    const replies = [
      turn({
        finishReason: 'tool',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/config.ts' } }],
      }),
      turn({ text: '{"ok":true}' }),
    ];
    const result = await converseOverTools(callOf('reply', { nonce }), {
      reader: null,
      send: (conversation) => {
        sent.push(conversation);
        return Promise.resolve(replies.shift() ?? turn({ text: 'unexpected' }));
      },
      shouldStop: () => Promise.resolve(false),
    });
    expect(result).toMatchObject({ kind: 'answer', text: '{"ok":true}' });
    expect(sent).toHaveLength(2);
    expect(sent.map((conversation) => conversation.tools)).toEqual([[], []]);
    const answered = sent[1]?.messages.find((message) => message.role === 'tool');
    expect(answered?.text).toContain('no tools are available');
    // Still between the conversation's markers, like every tool answer.
    expect(answered?.text).toContain(nonce);
  });

  it('does not read a refusal as a lack of tool calling when no tools were sent', async () => {
    const refused = new LlmError('rejected', 'The provider refused the request', 400, null, true);
    for (const tools of [true, false]) {
      const reader = memorySnapshot();
      const policy = newToolPolicy({
        excludePaths: [],
        masked: new MaskedFiles(reader, { masker }),
        masker,
      });
      const send = () => Promise.reject(refused);
      const result = await converseOverTools(
        callOf('reply'),
        tools
          ? { reader, policy, send, shouldStop: () => Promise.resolve(false) }
          : { reader: null, send, shouldStop: () => Promise.resolve(false) },
      );
      expect(result).toMatchObject({
        kind: 'failed',
        reason: tools ? 'provider_no_tools' : 'provider_error',
      });
    }
  });

  it('tells the caller each tool call it runs, and none it refuses to run', async () => {
    const reader = memorySnapshot({ files: { 'a.ts': 'const a = 1;\n' } });
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    const told: LlmToolCall[] = [];
    const calls: LlmToolCall[] = [
      { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: 'c2', name: 'grep', arguments: { pattern: 'const' } },
      // Not an object: the arguments are refused before the call is run.
      { id: 'c3', name: 'read_file', arguments: 'a.ts' },
      ...Array.from({ length: CONVERSATION_LIMITS.maxCallsPerTurn }, (_, i) => ({
        id: `list-${i}`,
        name: 'list_files',
        arguments: {},
      })),
    ];
    const replies = [
      turn({ finishReason: 'tool', toolCalls: calls }),
      turn({ text: '{"ok":true}' }),
    ];
    await converseOverTools(callOf('reply'), {
      reader,
      policy,
      send: () => Promise.resolve(replies.shift() ?? turn({ text: 'unexpected' })),
      shouldStop: () => Promise.resolve(false),
      onToolCall: (call) => told.push(call),
    });
    // Of the first eight calls of the turn, the one with unusable arguments is not run; the calls
    // after the eighth are told there were too many.
    expect(told.map((call) => call.id)).toEqual([
      'c1',
      'c2',
      ...Array.from({ length: CONVERSATION_LIMITS.maxCallsPerTurn - 3 }, (_, i) => `list-${i}`),
    ]);
  });

  it('stops where the caller says so', async () => {
    const reader = memorySnapshot();
    const policy = newToolPolicy({
      excludePaths: [],
      masked: new MaskedFiles(reader, { masker }),
      masker,
    });
    let sends = 0;
    const result = await converseOverTools(callOf('judge'), {
      reader,
      policy,
      send: () => {
        sends += 1;
        return Promise.resolve(turn({ text: '{}' }));
      },
      shouldStop: () => Promise.resolve(true),
    });
    expect(result.kind).toBe('stopped');
    expect(sends).toBe(0);
  });
});
