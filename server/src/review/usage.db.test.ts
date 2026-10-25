import { createHash, randomUUID } from 'node:crypto';
import { REDACTED } from '@qualor/shared';
import { asc, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../test/config';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import {
  anthropicAnswer,
  anthropicRedactedThinking,
  anthropicThinking,
  anthropicToolUse,
  createFakeLlm,
  llmShape,
  openAiAnswer,
  openAiToolCalls,
  responsesAnswer,
  responsesReasoning,
  responsesToolCalls,
  type FakeLlm,
  type LlmReply,
} from '../../test/fake-llm';
import { configuredProvider } from '../../test/llm';
import { memorySnapshot } from '../../test/review';
import type { Config } from '../config';
import { first } from '../db/rows';
import {
  analyses,
  branches,
  llmRequests,
  organizations,
  projects,
  reviewRuns,
  type ReviewFailureReason,
  type ReviewSkipReason,
} from '../db/schema';
import { createLlmRuntime, type LlmRuntime } from '../llm/job';
import type { LlmConversation, LlmMessage, LlmTurn, ProviderKind } from '../llm/providers';
import { todayUsage } from '../llm/service';
import { DEFAULT_LLM_SETTINGS, pricingFor, type StoredLlmSettings } from '../llm/settings';
import type { WorkerLogger } from '../queue/worker';
import { SCM_CIRCUIT_FAILURES } from '../scm/runtime';
import { parseInternalHosts } from '../scm/url';
import {
  CircuitOpenError,
  CONVERSATION_TEXTS,
  runConversation,
  type ConversationInput,
} from './conversation';
import { newNonce } from './envelope';
import { Masker } from './masker';
import { modelFor, type ModelTier } from './model-tiers';
import { CHARS_PER_TOKEN, REVIEW_OUTPUT_TOKENS } from './pipeline';
import { REPLY_PROMPT_VERSION } from './prompts';
import { REPLY_TOKEN_BUDGET } from './replies';
import { decideReply, type ReplyDeps, type ReplyInput } from './reply-engine';
import {
  defaultReview,
  DEFAULT_REVIEW_BUDGETS,
  effectiveReviewBudgets,
  withOrganizationReview,
} from './settings';
import { runReviewTool, TOOL_LIMITS } from './tools';
import {
  recordReviewCall,
  RedactionTally,
  remainingReviewTokens,
  REVIEW_FEATURE,
  REVIEW_REPLY_FEATURE,
  reviewSender,
  reviewUsageToday,
  type ReviewCallRecord,
} from './usage';

const KINDS = ['openai', 'anthropic'] as const;
type Kind = (typeof KINDS)[number];

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
];
const PROMPT_VERSION = 'review-1';
// Characters of two, three and four bytes: a size in bytes is not a size in characters.
const USER_TEXT = 'The change under review: café € 😀';
const PRICING = { inputUsdPerMTok: 3, outputUsdPerMTok: 15, strong: null, fast: null };
/** A provider with no tier models: all its calls go to its model, at the standard prices. */
const SINGLE_MODEL = { model: 'fake-model', strongModel: null, fastModel: null };
/** A fake password and the line that sets it, built at run time so no scanner takes it for real. */
const PASSWORD_VALUE = ['"hunter2', '-very-secret"'].join('');
const PASSWORD_LINE = `const password = ${PASSWORD_VALUE};`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The model asks for one call to read a file. `tokens` null: the provider counts none. */
function toolTurn(kind: Kind, tokens: [number, number] | null): LlmReply {
  const [input = 0, output = 0] = tokens ?? [];
  const call = { id: 'c1', name: 'read_file' };
  return {
    status: 200,
    body:
      kind === 'openai'
        ? openAiToolCalls([{ ...call, arguments: { path: 'a.ts' } }], {
            usage: tokens === null ? null : { prompt_tokens: input, completion_tokens: output },
          })
        : anthropicToolUse([{ ...call, input: { path: 'a.ts' } }], {
            usage: tokens === null ? null : { input_tokens: input, output_tokens: output },
          }),
  };
}

function textTurn(kind: Kind, text: string, tokens: [number, number] | null): LlmReply {
  const [input = 0, output = 0] = tokens ?? [];
  return {
    status: 200,
    body:
      kind === 'openai'
        ? openAiAnswer(text, {
            usage: tokens === null ? null : { prompt_tokens: input, completion_tokens: output },
          })
        : anthropicAnswer(text, {
            usage: tokens === null ? null : { input_tokens: input, output_tokens: output },
          }),
  };
}

const failure = (kind: Kind, status: number): LlmReply => ({
  status,
  body: llmShape(kind === 'anthropic' ? 'anthropic-error' : 'openai-error'),
});

describe('the review’s own usage (6I-3)', () => {
  let t: TestDatabase;
  let orgA: string;
  let orgB: string;
  let projectA1: string;
  let projectA2: string;
  let projectB: string;
  let fake: FakeLlm;
  let config: Config;
  let runtime: LlmRuntime;
  let branchCount = 0;

  const newProject = async (organizationId: string, key: string) =>
    first(await t.db.insert(projects).values({ organizationId, key, name: key }).returning()).id;
  /** A run of a fresh merge request branch of the project, started `startedAt` (or never). */
  const newRun = async (
    projectId: string,
    status: 'waiting' | 'running' | 'done' | 'failed' | 'superseded' | 'skipped',
    startedAt: Date | null,
  ) => {
    branchCount += 1;
    const branchId = first(
      await t.db
        .insert(branches)
        .values({ projectId, kind: 'merge_request', name: String(branchCount) })
        .returning(),
    ).id;
    const analysisId = first(await t.db.insert(analyses).values({ projectId }).returning()).id;
    const reason: { reason?: ReviewSkipReason | ReviewFailureReason } =
      status === 'skipped'
        ? { reason: 'draft' }
        : status === 'failed'
          ? { reason: 'internal' }
          : {};
    return first(
      await t.db
        .insert(reviewRuns)
        .values({
          projectId,
          branchId,
          analysisId,
          status,
          startedAt,
          deadlineAt: new Date(),
          ...reason,
        })
        .returning(),
    );
  };
  /** A row of `llm_requests` for the usage tests; the values given replace these. */
  const insertRow = (over: Partial<typeof llmRequests.$inferInsert>) =>
    t.db.insert(llmRequests).values({
      organizationId: orgA,
      projectId: projectA1,
      feature: REVIEW_FEATURE,
      cacheKey: 'a'.repeat(64),
      provider: 'openai',
      providerHost: 'api.example.com',
      model: 'm',
      promptVersion: PROMPT_VERSION,
      status: 'succeeded',
      inputSha256: 'b'.repeat(64),
      inputBytes: 10,
      fields: ['review'],
      ...over,
    });
  const rows = () => t.db.select().from(llmRequests).orderBy(asc(llmRequests.id));

  /** Settings with the fake as the provider, its key encrypted for this test's secret. */
  const settingsFor = (kind: Kind, over: Partial<StoredLlmSettings> = {}): StoredLlmSettings => ({
    ...DEFAULT_LLM_SETTINGS,
    provider: configuredProvider(config.secretKey, fake, kind),
    ...over,
  });
  /**
   * What a conversation of a tier is sent with, as the job makes it: the tier's model and its
   * prices. The standard tier unless a tier is given.
   */
  const callOf = (settings: StoredLlmSettings, tier: ModelTier = 'standard') => {
    const { provider } = settings;
    if (provider === null) return { model: '', pricing: null };
    return {
      model: modelFor(provider, tier),
      pricing: pricingFor(settings.pricing, provider, tier),
    };
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    orgA = first(
      await t.db.insert(organizations).values({ key: 'org-a', name: 'A' }).returning(),
    ).id;
    orgB = first(
      await t.db.insert(organizations).values({ key: 'org-b', name: 'B' }).returning(),
    ).id;
    projectA1 = await newProject(orgA, 'a/one');
    projectA2 = await newProject(orgA, 'a/two');
    projectB = await newProject(orgB, 'b/one');
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    fake = await createFakeLlm();
    config = testConfig({ llmInternalHosts: parseInternalHosts(fake.host) });
    runtime = createLlmRuntime();
  });
  afterEach(async () => {
    await fake.close();
    await t.db.delete(llmRequests);
    await t.db.delete(reviewRuns);
  });

  describe('the row of a provider call', () => {
    /**
     * A conversation over the fake, made through the sender. `redactions` is what the context
     * masked in the first message; the tool adds 2 to what the next call carries.
     */
    async function converseThrough(
      kind: Kind,
      replies: LlmReply[],
      settings: StoredLlmSettings,
      over: { redactions?: number; runId?: string; user?: string; tier?: ModelTier } = {},
    ) {
      const tally = new RedactionTally();
      tally.add(over.redactions ?? 0);
      const sender = reviewSender({
        db: t.db,
        runtime,
        config,
        settings,
        ...callOf(settings, over.tier),
        feature: REVIEW_FEATURE,
        source: { projectId: projectA1, promptKey: over.runId ?? randomUUID() },
        promptVersion: PROMPT_VERSION,
        redactions: tally,
      });
      const sent: LlmConversation[] = [];
      const input: ConversationInput = {
        system: 'Qualor review: quality',
        user: over.user ?? USER_TEXT,
        nonce: newNonce(),
        tools: TOOLS,
        runTool: () => {
          tally.add(2);
          return Promise.resolve('file text');
        },
        limits: { maxTurns: 16, maxCallsPerTurn: 8, tokenBudget: 1_000_000, maxOutputTokens: 50 },
        send: (conversation) => {
          sent.push(conversation);
          return sender(conversation);
        },
        shouldStop: () => Promise.resolve(false),
        sleep: () => Promise.resolve(),
      };
      fake.enqueue(...replies);
      return { result: await runConversation(input), sent };
    }

    it.each(KINDS)(
      'every provider call writes one review row with tokens and cost (%s)',
      async (kind) => {
        const settings = settingsFor(kind, { pricing: PRICING });
        // A call with a tool, a failed one, its retry, and the answer.
        const { result, sent } = await converseThrough(
          kind,
          [
            toolTurn(kind, [1_000, 100]),
            failure(kind, 503),
            textTurn(kind, '{"findings":[]}', [2_000, 200]),
          ],
          settings,
          { redactions: 3 },
        );
        expect(result).toMatchObject({ kind: 'answer', turns: 2, toolCalls: 1 });
        expect(sent).toHaveLength(3);

        const stored = await rows();
        expect(stored).toHaveLength(3);
        for (const [i, row] of stored.entries()) {
          const body = JSON.stringify(sent[i]);
          expect(row).toMatchObject({
            organizationId: orgA,
            projectId: projectA1,
            issueId: null,
            userId: null,
            feature: 'review',
            provider: kind,
            providerHost: fake.host,
            model: 'fake-model',
            promptVersion: PROMPT_VERSION,
            attempts: 1,
            fields: ['review'],
            // The hash of the request body: the same one for the cache key, and a retry sends again.
            cacheKey: sha256(body),
            inputSha256: sha256(body),
            inputBytes: Buffer.byteLength(body),
            prompt: null,
            result: null,
          });
          // Bytes, not characters: the user text has characters of two to four bytes.
          expect(row.inputBytes).toBeGreaterThan(body.length);
          expect(row.durationMs).toBeGreaterThanOrEqual(0);
          // Finished when written: never queued or running, which the `llm` sweep would fail.
          expect(row.finishedAt).toBeInstanceOf(Date);
        }
        expect(stored[1]!.inputSha256).toBe(stored[2]!.inputSha256);
        expect(stored[0]!.inputSha256).not.toBe(stored[1]!.inputSha256);

        // 1 000 × $3 + 100 × $15 per million tokens, in micro-USD.
        expect(stored[0]).toMatchObject({
          status: 'succeeded',
          errorCode: null,
          inputTokens: 1_000,
          outputTokens: 100,
          costMicroUsd: 4_500,
        });
        // A call the provider failed has no tokens, and so no cost.
        expect(stored[1]).toMatchObject({
          status: 'failed',
          errorCode: 'PROVIDER_UNAVAILABLE',
          inputTokens: null,
          outputTokens: null,
          costMicroUsd: null,
        });
        expect(stored[2]).toMatchObject({
          status: 'succeeded',
          inputTokens: 2_000,
          outputTokens: 200,
          costMicroUsd: 9_000,
        });
        // What each call added: the first message, then the result of the tool; a retry adds nothing.
        expect(stored.map((row) => row.redactions)).toEqual([3, 2, 0]);
      },
    );

    it('puts the redactions of what the tools masked on the call that carries their results', async () => {
      const masker = new Masker();
      try {
        const reader = memorySnapshot({
          files: {
            'src/config.ts': `const user = "admin";
${PASSWORD_LINE}
const port = 8080;
`,
          },
        });
        const policy = {
          excludePaths: [],
          budget: {
            calls: TOOL_LIMITS.callsPerReview,
            greps: TOOL_LIMITS.grepsPerReview,
            maskedBytes: TOOL_LIMITS.maskedBytesPerReview,
          },
          masker,
        };
        const tally = new RedactionTally();
        // What the context masked in the first message, and what each tool masks in its result.
        tally.add(2);
        const masked: number[] = [];
        const settings = settingsFor('openai');
        const sender = reviewSender({
          db: t.db,
          runtime,
          config,
          settings,
          ...callOf(settings),
          feature: REVIEW_FEATURE,
          source: { projectId: projectA1, promptKey: randomUUID() },
          promptVersion: PROMPT_VERSION,
          redactions: tally,
        });
        fake.enqueue(
          {
            status: 200,
            body: openAiToolCalls([
              { id: 'c1', name: 'read_file', arguments: { path: 'src/config.ts' } },
              { id: 'c2', name: 'grep', arguments: { pattern: 'port' } },
            ]),
          },
          textTurn('openai', '{"findings":[]}', [20, 5]),
        );
        const result = await runConversation({
          system: 'S',
          user: USER_TEXT,
          nonce: newNonce(),
          tools: TOOLS,
          runTool: async (call) => {
            const answer = await runReviewTool(reader, call, policy);
            tally.add(answer.redactions);
            masked.push(answer.redactions);
            return answer.text;
          },
          limits: { maxTurns: 16, maxCallsPerTurn: 8, tokenBudget: 1_000_000, maxOutputTokens: 50 },
          send: sender,
          shouldStop: () => Promise.resolve(false),
          sleep: () => Promise.resolve(),
        });
        expect(result).toMatchObject({ kind: 'answer', turns: 2, toolCalls: 2 });

        // The password line was masked in the file the calls read.
        expect(masked.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
        const [callOne, callTwo] = await rows();
        expect(callOne!.redactions).toBe(2);
        expect(callTwo!.redactions).toBe(masked.reduce((a, b) => a + b, 0));
        // What the model read: the mask, not the password.
        const request = JSON.stringify(fake.requests[1]!.json);
        expect(request).toContain('«redacted»');
        expect(request).not.toContain('very-secret');
      } finally {
        await masker.close();
      }
    });

    it.each(KINDS)(
      'charges a provider that counts nothing the same input in the result of the loop and in the day (%s)',
      async (kind) => {
        const { result } = await converseThrough(
          kind,
          [toolTurn(kind, null), textTurn(kind, 'done', null)],
          settingsFor(kind, { pricing: PRICING }),
        );
        const stored = await rows();
        // The rows say what the provider said, which is nothing, and so is their cost.
        expect(stored).toHaveLength(2);
        for (const row of stored) {
          expect(row).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
        }
        const guessedInput = stored.reduce((sum, row) => sum + Math.ceil(row.inputBytes / 4), 0);
        // The loop charged a quarter of the bytes sent, and the most each call could write; the
        // day counts the same input and cannot know the output limit.
        expect(result).toMatchObject({
          kind: 'answer',
          turns: 2,
          inputTokens: guessedInput,
          outputTokens: 2 * 50,
        });
        expect((await reviewUsageToday(t.db, orgA)).tokens).toBe(guessedInput);
      },
    );

    it.each(KINDS)(
      'charges a call that timed out, and one answered unreadably, the same input in the result of the loop and in the day (%s)',
      async (kind) => {
        // The shortest time the provider is given is a second; the fake keeps the first call waiting longer.
        const settings = settingsFor(kind, {
          provider: { ...configuredProvider(config.secretKey, fake, kind), timeoutSeconds: 1 },
        });
        const late = { ...textTurn(kind, 'late', [1, 1]), delayMs: 1_500 };
        const timedOut = await converseThrough(
          kind,
          [late, textTurn(kind, 'done', [10, 5])],
          settings,
        );
        const [lost, answered] = await rows();
        expect(lost).toMatchObject({
          status: 'failed',
          errorCode: 'PROVIDER_TIMEOUT',
          inputTokens: null,
          outputTokens: null,
        });
        expect(answered).toMatchObject({ status: 'succeeded', inputTokens: 10, outputTokens: 5 });
        // The call that was lost is charged a quarter of the bytes it sent, by the loop and by the day.
        const lostInput = Math.ceil(lost!.inputBytes / 4);
        expect(timedOut.result).toMatchObject({
          kind: 'answer',
          inputTokens: lostInput + 10,
          outputTokens: 5,
        });
        expect((await reviewUsageToday(t.db, orgA)).tokens).toBe(lostInput + 15);
        await t.db.delete(llmRequests);

        const unreadable = await converseThrough(
          kind,
          [{ status: 200, body: 'this is not JSON' }],
          settings,
        );
        const [row] = await rows();
        expect(row).toMatchObject({
          status: 'failed',
          errorCode: 'PROVIDER_BAD_ANSWER',
          inputTokens: null,
          outputTokens: null,
        });
        const unreadableInput = Math.ceil(row!.inputBytes / 4);
        expect(unreadable.result).toEqual({
          kind: 'failed',
          reason: 'provider_error',
          inputTokens: unreadableInput,
          outputTokens: 0,
          turns: 0,
          toolCalls: 0,
        });
        expect((await reviewUsageToday(t.db, orgA)).tokens).toBe(unreadableInput);
      },
    );

    it('has no cost without prices', async () => {
      await converseThrough('openai', [textTurn('openai', 'done', [10, 5])], settingsFor('openai'));
      expect(first(await rows())).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        costMicroUsd: null,
      });
    });

    it.each(KINDS)(
      "every llm_requests row names the model it called, and its cost uses that model's prices (%s)",
      async (kind) => {
        const settings = settingsFor(kind, {
          provider: {
            ...configuredProvider(config.secretKey, fake, kind),
            strongModel: 'big-model',
            fastModel: 'small-model',
          },
          pricing: {
            ...PRICING,
            strong: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
            fast: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
          },
        });
        for (const tier of ['strong', 'standard', 'fast'] as const) {
          await converseThrough(kind, [textTurn(kind, 'done', [1_000, 100])], settings, { tier });
        }

        // Each call went to the model of its tier, and its row says so.
        const sentTo = fake.requests.map((request) => (request.json as { model: string }).model);
        expect(sentTo).toEqual(['big-model', 'fake-model', 'small-model']);
        const stored = await rows();
        expect(stored.map((row) => row.model)).toEqual(sentTo);
        // 1 000 input and 100 output tokens, at the prices of the call's model, in micro-USD.
        expect(stored.map((row) => row.costMicroUsd)).toEqual([
          1_000 * 15 + 100 * 75,
          1_000 * 3 + 100 * 15,
          1_000 * 1 + 100 * 5,
        ]);
      },
    );

    it('stores the prompt and the result only when the administrator keeps prompts', async () => {
      await converseThrough('openai', [textTurn('openai', 'done', [10, 5])], settingsFor('openai'));
      expect(first(await rows())).toMatchObject({ prompt: null, result: null });
      await t.db.delete(llmRequests);

      const runId = randomUUID();
      await converseThrough(
        'openai',
        [toolTurn('openai', [10, 5]), textTurn('openai', '{"findings":[]}', [20, 5])],
        settingsFor('openai', { storePrompts: true }),
        { runId },
      );
      const [callOne, callTwo] = await rows();
      expect(callOne!.prompt).toMatchObject({
        runId,
        system: 'Qualor review: quality',
        omitted: 0,
        messages: [{ role: 'user', text: USER_TEXT }],
      });
      expect(callOne!.result).toMatchObject({
        finishReason: 'tool',
        text: '',
        callCount: 1,
        calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
      });
      // The second call carries the first turn and its tool result, in the envelope.
      expect(
        (callTwo!.prompt as { messages: { role: string }[] }).messages.map((m) => m.role),
      ).toEqual(['user', 'assistant', 'tool']);
      expect(callTwo!.result).toMatchObject({ finishReason: 'stop', text: '{"findings":[]}' });
    });

    it('sends the thinking of a turn back unchanged, counts it in the input, and keeps it out of the stored prompt and result', async () => {
      const thinking = [
        anthropicThinking('SIGNATURE-ONE'),
        anthropicRedactedThinking('ENCRYPTED-ONE'),
      ];
      const { result, sent } = await converseThrough(
        'anthropic',
        [
          {
            status: 200,
            body: anthropicToolUse([{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }], {
              thinking,
              text: 'Reading.',
              usage: { input_tokens: 10, output_tokens: 900 },
            }),
          },
          textTurn('anthropic', '{"findings":[]}', [20, 5]),
        ],
        settingsFor('anthropic', { storePrompts: true }),
      );
      expect(result).toMatchObject({ kind: 'answer', turns: 2 });
      // The provider gets the blocks back as it sent them, ahead of the text and the call.
      const assistant = (fake.requests[1]!.json as { messages: { content: unknown[] }[] })
        .messages[1]!;
      expect(assistant.content.slice(0, 2)).toEqual(thinking);
      // The row's input is what was sent, the replay with it.
      const [callOne, callTwo] = await rows();
      const body = JSON.stringify(sent[1]);
      expect(body).toContain('SIGNATURE-ONE');
      expect(callTwo).toMatchObject({
        inputSha256: sha256(body),
        inputBytes: Buffer.byteLength(body),
      });
      // But nothing of it is stored where a person reads it back.
      for (const row of [callOne!, callTwo!]) {
        const shown = JSON.stringify([row.prompt, row.result]);
        expect(shown).not.toContain('SIGNATURE-ONE');
        expect(shown).not.toContain('ENCRYPTED-ONE');
        expect(shown).not.toContain('replay');
      }
      expect(callTwo!.prompt).not.toBeNull();
      expect(callOne!.result).toMatchObject({ finishReason: 'tool', text: 'Reading.' });
    });

    it('sends the reasoning of a Responses turn back unchanged, counts it in the input, and keeps it out of the stored prompt and result', async () => {
      const reasoning = [responsesReasoning('ENCRYPTED-ONE'), responsesReasoning('ENCRYPTED-TWO')];
      const answer = responsesToolCalls(
        [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }],
        { reasoning, text: 'Reading.', usage: { input_tokens: 10, output_tokens: 900 } },
      );
      const provider = {
        ...configuredProvider(config.secretKey, fake, 'openai'),
        api: 'responses' as const,
      };
      const { result, sent } = await converseThrough(
        'openai',
        [
          { status: 200, body: answer },
          {
            status: 200,
            body: responsesAnswer('{"findings":[]}', {
              usage: { input_tokens: 20, output_tokens: 5 },
            }),
          },
        ],
        settingsFor('openai', { storePrompts: true, provider }),
      );
      expect(result).toMatchObject({ kind: 'answer', turns: 2 });
      expect(fake.requests.map((r) => r.path)).toEqual(['/v1/responses', '/v1/responses']);
      // The provider gets the items back as it sent them, ahead of the result of the call.
      const items = (answer as { output: unknown[] }).output;
      const input = (fake.requests[1]!.json as { input: unknown[] }).input;
      expect(input.slice(1, 1 + items.length)).toEqual(items);
      expect(input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
      // The row's input is what was sent, the replay with it.
      const [callOne, callTwo] = await rows();
      const body = JSON.stringify(sent[1]);
      expect(body).toContain('ENCRYPTED-ONE');
      expect(callTwo).toMatchObject({
        provider: 'openai',
        model: 'fake-model',
        inputSha256: sha256(body),
        inputBytes: Buffer.byteLength(body),
      });
      // But nothing of it is stored where a person reads it back.
      for (const row of [callOne!, callTwo!]) {
        const shown = JSON.stringify([row.prompt, row.result]);
        expect(shown).not.toContain('ENCRYPTED');
        expect(shown).not.toContain('replay');
      }
      expect(callTwo!.prompt).not.toBeNull();
      expect(callOne!.result).toMatchObject({ finishReason: 'tool', text: 'Reading.' });
    });

    it('stores the prompt of a call that failed, and no result', async () => {
      await converseThrough(
        'anthropic',
        [failure('anthropic', 401)],
        settingsFor('anthropic', { storePrompts: true }),
      );
      const row = first(await rows());
      expect(row).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_REFUSED_KEY',
        result: null,
      });
      expect(row.prompt).not.toBeNull();
    });

    it('ends a conversation whose turn holds a block that cannot be written out again as a bad answer, with its row, and no RangeError in the sender', async () => {
      // A block of no kind the loop reads, nested past what JSON.stringify follows: kept in the
      // history it would make the sender's next JSON.stringify of the conversation throw.
      const deep = `${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`;
      const turn = `{"id":"msg_1","type":"message","role":"assistant","model":"m","stop_reason":"tool_use","content":[{"type":"thinking","thinking":"","signature":"sig-deep"},{"type":"tool_use","id":"c1","name":"read_file","input":{"path":"a.ts"}},{"type":"text","text":"Reading.","citations":${deep}}],"usage":{"input_tokens":10,"output_tokens":9}}`;
      const { result, sent } = await converseThrough(
        'anthropic',
        [{ status: 200, body: turn }, textTurn('anthropic', '{"findings":[]}', [20, 5])],
        settingsFor('anthropic', { storePrompts: true }),
      );
      // The provider's answer was not understood, and the conversation goes no further.
      expect(result).toMatchObject({ kind: 'failed', reason: 'provider_error' });
      expect(sent).toHaveLength(1);
      expect(fake.requests).toHaveLength(1);
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_BAD_ANSWER',
        result: null,
      });
    });

    it('does not join the two halves of a key that a NUL splits, in the stored prompt or in the stored result', async () => {
      const key = fake.apiKey;
      // The scrub does not see this as the key, and the store must not make it one.
      const split = `${key.slice(0, 8)}${String.fromCharCode(0)}${key.slice(8)}`;
      const stored = `${key.slice(0, 8)}${String.fromCodePoint(0xfffd)}${key.slice(8)}`;
      await converseThrough(
        'openai',
        [
          {
            status: 200,
            body: openAiToolCalls([{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }], {
              text: split,
            }),
          },
          textTurn('openai', split, [20, 5]),
        ],
        settingsFor('openai', { storePrompts: true }),
      );
      const [callOne, callTwo] = await rows();
      // The first call's result and the second call's prompt (it carries the first answer back).
      expect((callOne!.result as { text: string }).text).toBe(stored);
      expect((callTwo!.result as { text: string }).text).toBe(stored);
      const promptTexts = (callTwo!.prompt as { messages: { role: string; text: string }[] })
        .messages;
      expect(promptTexts.find((message) => message.role === 'assistant')!.text).toBe(stored);
      for (const row of [callOne!, callTwo!]) {
        expect(JSON.stringify(row.prompt)).not.toContain(key);
        expect(JSON.stringify(row.result)).not.toContain(key);
      }
    });

    it('keeps the stored prompt and result within the bounds of their columns, whatever was said', async () => {
      // Large texts, a NUL, a lone surrogate and control characters: nothing PostgreSQL refuses.
      const awkward = `\u0000a\ud800b\u0001"\\${'é€😀'.repeat(60_000)}`;
      await converseThrough(
        'openai',
        [toolTurn('openai', [10, 5]), textTurn('openai', awkward, [20, 5])],
        settingsFor('openai', { storePrompts: true }),
        { user: awkward },
      );
      // The user message and the answer are each far over the bound of their column.
      const sizes = await t.db.execute<{ prompt: number; result: number | null }>(sql`
        SELECT octet_length(prompt::text) AS prompt, octet_length(result::text) AS result
          FROM llm_requests ORDER BY id`);
      expect(sizes.rows).toHaveLength(2);
      for (const size of sizes.rows) {
        expect(size.prompt).toBeGreaterThan(0);
        expect(size.prompt).toBeLessThanOrEqual(65_536);
        expect(size.result).toBeLessThanOrEqual(16_384);
      }
      const [row] = await rows();
      const prompt = row!.prompt as { messages: { text: string }[] };
      expect(prompt.messages).toHaveLength(1);
      expect(prompt.messages[0]!.text.endsWith('…')).toBe(true);
    });

    it('keeps the newest messages of a long conversation, and says how many came before', async () => {
      const messages: LlmMessage[] = [{ role: 'user', text: 'U'.repeat(30_000) }];
      for (let i = 0; i < 40; i += 1) {
        messages.push({
          role: 'assistant',
          text: `turn ${i}`,
          toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }],
        });
        messages.push({
          role: 'tool',
          callId: `c${i}`,
          name: 'read_file',
          text: `result ${i} ${'x'.repeat(2_000)}`,
        });
      }
      await recordReviewCall(t.db, {
        ...baseRecord(),
        stored: {
          conversation: { system: 'S', messages, tools: TOOLS, maxOutputTokens: 50 },
          turn: null,
        },
      });
      const prompt = first(await rows()).prompt as {
        omitted: number;
        messages: { role: string; callId?: string }[];
      };
      const size = first(
        (
          await t.db.execute<{ bytes: number }>(
            sql`SELECT octet_length(prompt::text) AS bytes FROM llm_requests`,
          )
        ).rows,
      );
      expect(size.bytes).toBeLessThanOrEqual(65_536);
      // The last message is the newest of the conversation, and what is left is the ones before it.
      expect(prompt.messages.at(-1)).toMatchObject({ role: 'tool', callId: 'c39' });
      expect(prompt.messages.length + prompt.omitted).toBe(messages.length);
      expect(prompt.omitted).toBeGreaterThan(0);
    });

    it('stores no result for a call that failed, even when it is given one', async () => {
      const turn: LlmTurn = {
        text: 'x',
        finishReason: 'stop',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        model: null,
      };
      await recordReviewCall(t.db, {
        ...baseRecord(),
        status: 'failed',
        errorCode: 'PROVIDER_TIMEOUT',
        stored: {
          conversation: { system: 'S', messages: [], tools: [], maxOutputTokens: 1 },
          turn,
        },
      });
      expect(first(await rows())).toMatchObject({ result: null });
      expect(first(await rows()).prompt).toMatchObject({ messages: [] });
    });

    it('keeps the count of redactions in an integer column', async () => {
      await recordReviewCall(t.db, { ...baseRecord(), redactions: 5_000_000_000 });
      expect(first(await rows()).redactions).toBe(2_147_483_647);
    });

    /** A record with no tokens or storage, for the rows the tests write by hand. */
    function baseRecord(): ReviewCallRecord {
      return {
        organizationId: orgA,
        projectId: projectA1,
        feature: REVIEW_FEATURE,
        promptKey: randomUUID(),
        provider: 'openai' as ProviderKind,
        providerHost: 'api.example.com',
        model: 'm',
        promptVersion: PROMPT_VERSION,
        inputSha256: sha256('x'),
        inputBytes: 1,
        redactions: 0,
        status: 'succeeded',
        errorCode: null,
        inputTokens: null,
        outputTokens: null,
        costMicroUsd: null,
        durationMs: 1,
      };
    }
  });

  describe('the sender', () => {
    const converse1 = (sender: ReturnType<typeof reviewSender>) =>
      sender({
        system: 'S',
        messages: [{ role: 'user', text: 'U' }],
        tools: TOOLS,
        maxOutputTokens: 50,
      });
    const senderFor = (kind: Kind, over: Partial<Parameters<typeof reviewSender>[0]> = {}) => {
      const settings = over.settings ?? settingsFor(kind);
      return reviewSender({
        db: t.db,
        runtime,
        config,
        settings,
        ...callOf(settings),
        feature: REVIEW_FEATURE,
        source: { projectId: projectA2, promptKey: randomUUID() },
        promptVersion: PROMPT_VERSION,
        ...over,
      });
    };
    /** `times` calls the provider answers with `status`, each recorded. */
    const failing = async (
      sender: ReturnType<typeof reviewSender>,
      status: number,
      times: number,
    ) => {
      for (let i = 0; i < times; i += 1) {
        fake.enqueue(failure('openai', status));
        await converse1(sender).catch(() => undefined);
      }
    };

    it('records one row for a call that was asked again without the room, with the tokens of its answer', async () => {
      const settings = settingsFor('anthropic', { storePrompts: true });
      const sender = senderFor('anthropic', { settings, model: 'refuses-the-room' });
      fake.enqueue(
        {
          status: 400,
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                'max_tokens: 20384 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet-20241022',
            },
          },
        },
        textTurn('anthropic', 'done', [20, 5]),
      );
      const turn = await sender({
        system: 'S',
        messages: [{ role: 'user', text: 'U' }],
        tools: TOOLS,
        maxOutputTokens: 1_200,
        reasoningAllowance: 4_000,
      });
      expect(turn.text).toBe('done');
      expect(fake.requests.map((r) => (r.json as { max_tokens: number }).max_tokens)).toEqual([
        5_200, 1_200,
      ]);
      // One call of the sender's: one row, of the call that answered; the refusal leaves none.
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        status: 'succeeded',
        errorCode: null,
        model: 'refuses-the-room',
        inputTokens: 20,
        outputTokens: 5,
      });
      expect(JSON.stringify(stored)).not.toMatch(/maximum allowed number/);
    });

    it('writes the organisation of the run’s project on the row', async () => {
      fake.say('done');
      await converse1(senderFor('openai'));
      expect(first(await rows())).toMatchObject({ organizationId: orgA, projectId: projectA2 });
    });

    it('sends the model it is given and costs at the prices it is given, whatever the settings hold', async () => {
      // The settings hold the standard model and its prices; these calls are of other models.
      const settings = settingsFor('openai', { pricing: PRICING });
      fake.enqueue(
        textTurn('openai', 'done', [1_000, 100]),
        textTurn('openai', 'done', [1_000, 100]),
      );
      const prices = { inputUsdPerMTok: 2, outputUsdPerMTok: 8 };
      await converse1(senderFor('openai', { settings, model: 'given-model', pricing: prices }));
      // No prices for this call: the settings' are another model's, and make no cost of it.
      await converse1(senderFor('openai', { settings, model: 'unpriced-model', pricing: null }));

      expect(fake.requests.map((request) => (request.json as { model: string }).model)).toEqual([
        'given-model',
        'unpriced-model',
      ]);
      const [priced, unpriced] = await rows();
      expect(priced).toMatchObject({ model: 'given-model', costMicroUsd: 1_000 * 2 + 100 * 8 });
      expect(unpriced).toMatchObject({ model: 'unpriced-model', costMicroUsd: null });
    });

    it('takes no slot of the organisation’s llm requests, and is not held behind one', async () => {
      // An explain request of the same organisation holds its only slot.
      expect(runtime.slots.tryTake(orgA)).toBe(true);
      fake.say('done');
      const turn = await converse1(senderFor('openai'));
      expect(turn.text).toBe('done');
      // The slot is still the request's: the review neither took it nor gave it back.
      expect(runtime.slots.tryTake(orgA)).toBe(false);
      runtime.slots.release(orgA);
      expect(runtime.slots.tryTake(orgA)).toBe(true);
    });

    it('asks the circuit of the provider’s base URL, and sends nothing while it is open', async () => {
      const sender = senderFor('openai');
      for (let i = 0; i < SCM_CIRCUIT_FAILURES; i += 1) {
        runtime.circuit.failure(fake.openAiBaseUrl);
      }
      const err = await converse1(sender).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect(fake.requests).toHaveLength(0);
      // No call, no row.
      expect(await rows()).toHaveLength(0);
    });

    it('counts transient failures against the circuit it shares, and opens it', async () => {
      const sender = senderFor('openai');
      await failing(sender, 503, SCM_CIRCUIT_FAILURES);
      expect(runtime.circuit.openUntil(fake.openAiBaseUrl)).not.toBeNull();
      expect(await converse1(sender).catch((e: unknown) => e)).toBeInstanceOf(CircuitOpenError);
      expect(await rows()).toHaveLength(SCM_CIRCUIT_FAILURES);
    });

    it('counts an answer as the provider working: its failures start again', async () => {
      const sender = senderFor('openai');
      await failing(sender, 503, SCM_CIRCUIT_FAILURES - 1);
      fake.say('done');
      expect((await converse1(sender)).text).toBe('done');
      await failing(sender, 503, SCM_CIRCUIT_FAILURES - 1);
      expect(runtime.circuit.openUntil(fake.openAiBaseUrl)).toBeNull();
    });

    it('counts a provider that refuses as one that answers: its failures start again', async () => {
      const sender = senderFor('openai');
      // Four failures, a refusal of the key, four more: eight in all, never five in a row.
      await failing(sender, 503, SCM_CIRCUIT_FAILURES - 1);
      await failing(sender, 401, 1);
      await failing(sender, 503, SCM_CIRCUIT_FAILURES - 1);
      expect(runtime.circuit.openUntil(fake.openAiBaseUrl)).toBeNull();
      fake.say('done');
      expect((await converse1(sender)).text).toBe('done');
    });

    it('fails as a refused key, without a request or a row, when the key cannot be read', async () => {
      const rotated = { ...config, secretKey: 'another-secret-key-that-is-at-least-32-chars' };
      const err = await converse1(senderFor('openai', { config: rotated })).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ failure: 'refused_key' });
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
    });

    it('needs a provider', () => {
      expect(() => senderFor('openai', { settings: { ...DEFAULT_LLM_SETTINGS } })).toThrow(
        /needs a model provider/,
      );
    });

    it('takes the provider key out of what the model says: the turn the loop gets and the stored result', async () => {
      const key = fake.apiKey;
      // The key as it is, and with every character of it spelled as a JSON escape.
      const escaped = [...key]
        .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join('');
      const sender = senderFor('openai', {
        settings: settingsFor('openai', { storePrompts: true }),
      });
      fake.enqueue({
        status: 200,
        body: openAiToolCalls([{ id: 'c1', name: 'read_file', arguments: { path: key } }], {
          text: `{"summary":"the key is ${key} or ${escaped}"}`,
        }),
      });
      const turn = await converse1(sender);
      const summary = (JSON.parse(turn.text) as { summary: string }).summary;
      expect(turn.text).not.toContain(key);
      expect(summary).not.toContain(key);
      expect(summary).toBe(`the key is ${REDACTED} or ${REDACTED}`);
      expect(turn.toolCalls).toEqual([
        { id: 'c1', name: 'read_file', arguments: { path: REDACTED } },
      ]);
      const stored = JSON.stringify(first(await rows()).result);
      expect(stored).not.toContain(key);
      expect(stored).toContain(REDACTED);
    });

    it('takes a key with slashes out of the answer however the answer writes them, also in the stored result', async () => {
      // The kind of key base64 makes. A `/` can be written as it is, as `\/`, or as the escape of
      // its code; the answer below does all three, and splits the key across escapes.
      const slashed = 'sk-proj/AbCdEf+0123/GhIjKl==';
      const other = await createFakeLlm({ apiKey: slashed });
      try {
        const otherConfig = testConfig({ llmInternalHosts: parseInternalHosts(other.host) });
        const sender = senderFor('openai', {
          config: otherConfig,
          settings: {
            ...DEFAULT_LLM_SETTINGS,
            provider: configuredProvider(otherConfig.secretKey, other, 'openai'),
            storePrompts: true,
          },
        });
        const written = [
          slashed,
          'sk-proj\\/AbCdEf+0123\\/GhIjKl==',
          'sk-pro\\u006a\\/AbC\\u0064Ef\\u002B0123\\u002fGhIjKl\\u003d=',
        ];
        const rest = '"rest":"caf\\u00e9 \\/ ok"';
        other.enqueue({
          status: 200,
          body: openAiToolCalls([{ id: 'c1', name: 'read_file', arguments: { path: slashed } }], {
            text: `{"summary":"${written.join(' and ')}",${rest}}`,
          }),
        });
        const turn = await converse1(sender);
        // The text as it was written, but for the key; and the same once it is parsed.
        const scrubbed = `{"summary":"${[REDACTED, REDACTED, REDACTED].join(' and ')}",${rest}}`;
        expect(turn.text).toBe(scrubbed);
        expect((JSON.parse(turn.text) as { summary: string }).summary).not.toContain(slashed);
        expect(turn.toolCalls).toEqual([
          { id: 'c1', name: 'read_file', arguments: { path: REDACTED } },
        ]);
        const stored = first(await rows()).result as { text: string };
        expect(stored.text).toBe(scrubbed);
        expect(JSON.stringify(stored)).not.toContain(slashed);
        // A backslash is written twice in JSON text: the key as the answer wrote it is not there.
        expect(JSON.stringify(stored)).not.toContain('sk-proj\\\\/AbCdEf');
      } finally {
        await other.close();
      }
    });

    it('keeps null on the row of a call the provider did not count, which fills the day by the bytes it was sent', async () => {
      fake.enqueue({ status: 200, body: openAiAnswer('done', { usage: null }) });
      await converse1(
        senderFor('openai', { settings: settingsFor('openai', { pricing: PRICING }) }),
      );
      const row = first(await rows());
      expect(row).toMatchObject({
        status: 'succeeded',
        inputTokens: null,
        outputTokens: null,
        costMicroUsd: null,
      });
      expect((await reviewUsageToday(t.db, orgA)).tokens).toBe(Math.ceil(row.inputBytes / 4));
    });

    it('logs one line for each call with the run, the outcome and the counts, and nothing that was said', async () => {
      const lines: { data: Record<string, unknown>; message: string }[] = [];
      const logger = {
        info: (data: Record<string, unknown>, message: string) =>
          void lines.push({ data, message }),
        warn: () => undefined,
        error: () => undefined,
      } as unknown as WorkerLogger;
      const runId = randomUUID();
      const tally = new RedactionTally();
      tally.add(7);
      const sender = senderFor('openai', {
        logger,
        source: { projectId: projectA1, promptKey: runId },
        redactions: tally,
        settings: settingsFor('openai', { storePrompts: true }),
      });
      fake.say('A secret answer the log must not repeat');
      await converse1(sender);
      fake.enqueue(failure('openai', 401));
      await converse1(sender).catch(() => undefined);

      expect(lines.map((l) => l.message)).toEqual([
        'AI review call finished',
        'AI review call finished',
      ]);
      expect(lines[0]!.data).toMatchObject({
        runId,
        status: 'succeeded',
        errorCode: null,
        providerStatus: null,
        inputTokens: 412,
        outputTokens: 96,
      });
      expect(Object.keys(lines[0]!.data).sort()).toEqual([
        'durationMs',
        'errorCode',
        'inputTokens',
        'outputTokens',
        'providerStatus',
        'runId',
        'status',
      ]);
      expect(lines[1]!.data).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_REFUSED_KEY',
        providerStatus: 401,
      });
      const logged = JSON.stringify(lines);
      expect(logged).not.toContain('secret answer');
      expect(logged).not.toContain(fake.apiKey);
      // The count of redactions lives on the row only.
      expect(logged).not.toContain('redactions');
      expect(first(await rows())).toMatchObject({ redactions: 7 });
    });

    it('writes the rows of the calls of a reply with their own feature, and names the reply, not a run', async () => {
      const lines: { data: Record<string, unknown>; message: string }[] = [];
      const logger = {
        info: (data: Record<string, unknown>, message: string) =>
          void lines.push({ data, message }),
        warn: () => undefined,
        error: () => undefined,
      } as unknown as WorkerLogger;
      const replyId = randomUUID();
      const tally = new RedactionTally();
      tally.add(4);
      const settings = settingsFor('openai', { storePrompts: true, pricing: PRICING });
      const sender = senderFor('openai', {
        settings,
        feature: REVIEW_REPLY_FEATURE,
        source: { projectId: projectA1, promptKey: replyId },
        promptVersion: 'reply-1',
        redactions: tally,
        logger,
      });
      fake.say('An answer');
      await converse1(sender);
      fake.enqueue(failure('openai', 503));
      await converse1(sender).catch(() => undefined);

      const [done, refused] = await rows();
      expect(done).toMatchObject({
        organizationId: orgA,
        projectId: projectA1,
        issueId: null,
        userId: null,
        feature: 'review-reply',
        fields: ['review-reply'],
        promptVersion: 'reply-1',
        status: 'succeeded',
        redactions: 4,
        // 412 × $3 + 96 × $15 per million tokens.
        costMicroUsd: 412 * 3 + 96 * 15,
        prompt: { replyId, system: 'S', omitted: 0, messages: [{ role: 'user', text: 'U' }] },
      });
      expect(done!.prompt).not.toHaveProperty('runId');
      expect(done!.finishedAt).toBeInstanceOf(Date);
      expect(refused).toMatchObject({ feature: 'review-reply', status: 'failed' });
      expect(refused!.finishedAt).toBeInstanceOf(Date);
      // The log line is the review's, with the reply in the place of the run.
      expect(lines.map((line) => line.message)).toEqual([
        'AI review reply call finished',
        'AI review reply call finished',
      ]);
      expect(Object.keys(lines[0]!.data).sort()).toEqual([
        'durationMs',
        'errorCode',
        'inputTokens',
        'outputTokens',
        'providerStatus',
        'replyId',
        'status',
      ]);
      expect(lines[0]!.data).toMatchObject({ replyId, status: 'succeeded' });
      expect(await reviewUsageToday(t.db, orgA)).toMatchObject({ tokens: 508 });
    });

    it('writes the organisation of the project it is given, for a review or for a reply alike', async () => {
      for (const feature of [REVIEW_FEATURE, REVIEW_REPLY_FEATURE] as const) {
        await t.db.delete(llmRequests);
        for (const [projectId, organizationId] of [
          [projectA2, orgA],
          [projectB, orgB],
        ] as const) {
          fake.say('done');
          await converse1(
            senderFor('openai', { feature, source: { projectId, promptKey: randomUUID() } }),
          );
          expect((await rows()).at(-1)).toMatchObject({ feature, projectId, organizationId });
        }
      }
    });
  });

  describe('usage of the day', () => {
    it('counts the rows of the answers to replies with the reviews’, and the reviews of the day stay the runs', async () => {
      // A review's call, and replies' calls of the organisation's two projects.
      await insertRow({ inputTokens: 5_000, outputTokens: 500, costMicroUsd: 7_000 });
      await insertRow({
        feature: REVIEW_REPLY_FEATURE,
        inputTokens: 2_000,
        outputTokens: 200,
        costMicroUsd: 3_000,
      });
      await insertRow({
        feature: REVIEW_REPLY_FEATURE,
        projectId: projectA2,
        inputTokens: 400,
        outputTokens: 40,
        costMicroUsd: 600,
      });
      // One whose provider did not count: a quarter of the bytes sent, as for a review's.
      await insertRow({
        feature: REVIEW_REPLY_FEATURE,
        inputTokens: null,
        outputTokens: null,
        inputBytes: 4_000,
      });
      // Not the organisation's, not today's, and not a review's or a reply's.
      await insertRow({
        feature: REVIEW_REPLY_FEATURE,
        organizationId: orgB,
        projectId: projectB,
        inputTokens: 9_999,
        outputTokens: 1,
      });
      await insertRow({
        feature: REVIEW_REPLY_FEATURE,
        inputTokens: 80_000,
        outputTokens: 8_000,
        createdAt: new Date(Date.now() - 24 * 3_600_000 - 60_000),
      });
      await insertRow({
        feature: 'explain',
        inputTokens: 100,
        outputTokens: 10,
        costMicroUsd: 500,
      });

      expect(await reviewUsageToday(t.db, orgA)).toEqual({
        tokens: 5_500 + 2_200 + 440 + 1_000,
        costMicroUsd: 10_600,
        reviews: 0,
      });
      expect(await reviewUsageToday(t.db, orgA, projectA1)).toMatchObject({
        tokens: 5_500 + 2_200 + 1_000,
        costMicroUsd: 10_000,
      });
      expect(await reviewUsageToday(t.db, orgA, projectA2)).toMatchObject({
        tokens: 440,
        costMicroUsd: 600,
      });
      expect(await reviewUsageToday(t.db, orgB)).toMatchObject({ tokens: 10_000 });
      // Nothing of it is the explain, triage and fix day's, and a run is what counts a review.
      expect(await todayUsage(t.db, orgA)).toEqual({
        explain: 1,
        triage: 0,
        fix: 0,
        tokens: 110,
        costMicroUsd: 500,
      });
      await newRun(projectA1, 'done', new Date());
      expect((await reviewUsageToday(t.db, orgA)).reviews).toBe(1);
    });

    const DAY = 24 * 3_600_000;
    const yesterday = () => new Date(Date.now() - DAY - 60_000);

    it('todayUsage ignores review rows and reviewUsageToday ignores explain rows', async () => {
      await insertRow({
        feature: 'explain',
        inputTokens: 100,
        outputTokens: 10,
        costMicroUsd: 500,
      });
      await insertRow({ feature: 'triage', inputTokens: 200, outputTokens: 20, costMicroUsd: 600 });
      await insertRow({ feature: 'fix', inputTokens: 300, outputTokens: 30, costMicroUsd: 700 });
      await insertRow({ inputTokens: 5_000, outputTokens: 500, costMicroUsd: 7_000 });
      await insertRow({
        projectId: projectA2,
        inputTokens: 1_000,
        outputTokens: 100,
        costMicroUsd: 1_000,
      });
      // Another organisation's, and yesterday's.
      await insertRow({
        organizationId: orgB,
        projectId: projectB,
        inputTokens: 9_999,
        outputTokens: 1,
      });
      await insertRow({
        inputTokens: 80_000,
        outputTokens: 8_000,
        createdAt: yesterday(),
      });

      expect(await todayUsage(t.db, orgA)).toEqual({
        explain: 1,
        triage: 1,
        fix: 1,
        tokens: 110 + 220 + 330,
        costMicroUsd: 500 + 600 + 700,
      });
      expect(await reviewUsageToday(t.db, orgA)).toEqual({
        tokens: 5_500 + 1_100,
        costMicroUsd: 8_000,
        reviews: 0,
      });
      expect(await reviewUsageToday(t.db, orgA, projectA1)).toMatchObject({
        tokens: 5_500,
        costMicroUsd: 7_000,
      });
      expect(await reviewUsageToday(t.db, orgA, projectA2)).toMatchObject({ tokens: 1_100 });
      expect(await reviewUsageToday(t.db, orgB)).toMatchObject({
        tokens: 10_000,
        costMicroUsd: 0,
      });
      expect(await reviewUsageToday(t.db, randomUUID())).toEqual({
        tokens: 0,
        costMicroUsd: 0,
        reviews: 0,
      });
    });

    it('a review row takes nothing from the explain, triage and fix budgets', async () => {
      const before = await todayUsage(t.db, orgA);
      await insertRow({ inputTokens: 900_000, outputTokens: 90_000, costMicroUsd: 9_000_000 });
      await insertRow({ status: 'failed', errorCode: 'PROVIDER_TIMEOUT' });
      expect(await todayUsage(t.db, orgA)).toEqual(before);
    });

    it('counts the reviews that started today and were not skipped', async () => {
      const now = new Date();
      await newRun(projectA1, 'running', now);
      await newRun(projectA1, 'done', now);
      await newRun(projectA2, 'failed', now);
      await newRun(projectA2, 'superseded', now);
      // Not a review that spent: waiting, skipped (also after it started), or of another day.
      await newRun(projectA1, 'waiting', null);
      await newRun(projectA1, 'skipped', now);
      await newRun(projectA1, 'done', yesterday());
      await newRun(projectB, 'done', now);

      expect((await reviewUsageToday(t.db, orgA)).reviews).toBe(4);
      expect((await reviewUsageToday(t.db, orgA, projectA1)).reviews).toBe(2);
      expect((await reviewUsageToday(t.db, orgA, projectA2)).reviews).toBe(2);
      expect((await reviewUsageToday(t.db, orgB)).reviews).toBe(1);
    });

    it('counts the day from midnight UTC', async () => {
      // Midnight UTC as the database has it, in milliseconds.
      const midnight = first(
        (
          await t.db.execute<{ ms: number }>(
            sql`SELECT (extract(epoch FROM date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') * 1000)::float8 AS ms`,
          )
        ).rows,
      ).ms;
      await insertRow({ inputTokens: 1, outputTokens: 0, createdAt: new Date(midnight - 1_000) });
      await insertRow({ inputTokens: 10, outputTokens: 0, createdAt: new Date(midnight + 1_000) });
      expect((await reviewUsageToday(t.db, orgA)).tokens).toBe(10);
    });

    it('counts the input of a call whose tokens are unknown as a quarter of its bytes, when it succeeded, timed out or was answered unreadably', async () => {
      // The provider answered and did not count: a quarter of the bytes sent, and the output it did count.
      await insertRow({ inputTokens: null, outputTokens: null, inputBytes: 4_000 });
      await insertRow({ inputTokens: null, outputTokens: 7, inputBytes: 401 });
      // A call that timed out may have been worked on all the same.
      await insertRow({
        status: 'failed',
        errorCode: 'PROVIDER_TIMEOUT',
        inputTokens: null,
        outputTokens: null,
        inputBytes: 2_000,
      });
      // So may a call that was answered, with an answer that could not be read: the provider took it.
      await insertRow({
        status: 'failed',
        errorCode: 'PROVIDER_BAD_ANSWER',
        inputTokens: null,
        outputTokens: null,
        inputBytes: 6_000,
      });
      // A call the provider refused, would not take or could not be reached for cost nothing.
      for (const errorCode of [
        'PROVIDER_REFUSED_KEY',
        'PROVIDER_WORKSPACE_REQUIRED',
        'PROVIDER_RATE_LIMITED',
        'PROVIDER_UNAVAILABLE',
        'PROVIDER_REJECTED_REQUEST',
      ]) {
        await insertRow({
          status: 'failed',
          errorCode,
          inputTokens: null,
          outputTokens: null,
          inputBytes: 8_000,
        });
      }
      // A call it counted is what it said, whatever the bytes.
      await insertRow({ inputTokens: 50, outputTokens: 10, inputBytes: 99_999 });

      expect((await reviewUsageToday(t.db, orgA)).tokens).toBe(
        1_000 + (101 + 7) + 500 + 1_500 + 60,
      );
      // The rows keep what the provider said: nothing.
      expect((await rows()).filter((row) => row.inputTokens === null)).toHaveLength(9);
    });

    it('lets a provider whose answers are never readable fill the day, one call to a review at a time', async () => {
      // Three reviews, each one call of 400 000 bytes that came back unreadable: 100 000 tokens each.
      for (let review = 0; review < 3; review += 1) {
        await insertRow({
          status: 'failed',
          errorCode: 'PROVIDER_BAD_ANSWER',
          inputTokens: null,
          outputTokens: null,
          inputBytes: 400_000,
        });
      }
      const usage = await reviewUsageToday(t.db, orgA);
      expect(usage).toMatchObject({ tokens: 300_000, costMicroUsd: 0 });
      const budgets = {
        ...DEFAULT_REVIEW_BUDGETS,
        tokensPerDay: 300_000,
        maxTokensPerReview: 50_000,
      };
      expect(
        remainingReviewTokens(budgets, { organization: usage, project: null }, null, null),
      ).toBe(0);
    });

    it('does not guess a cost: the cost of the day is that of the calls whose cost is known', async () => {
      await insertRow({
        inputTokens: null,
        outputTokens: null,
        inputBytes: 4_000,
        costMicroUsd: null,
      });
      await insertRow({ inputTokens: 10, outputTokens: 10, costMicroUsd: 300 });
      expect(await reviewUsageToday(t.db, orgA)).toMatchObject({
        tokens: 1_020,
        costMicroUsd: 300,
      });
    });
  });

  describe('remainingReviewTokens', () => {
    const budgets = {
      ...DEFAULT_REVIEW_BUDGETS,
      tokensPerDay: 1_000_000,
      perProjectTokensPerDay: 400_000,
      maxTokensPerReview: 300_000,
    };
    /** The day so far: the organisation's tokens and cost, and the project's tokens (null: not asked). */
    const day = (organization: number, project: number | null = 0, costMicroUsd = 0) => ({
      organization: { tokens: organization, costMicroUsd },
      project: project === null ? null : { tokens: project },
    });

    it('takes the smallest of the review ceiling, the org and the project remainder', () => {
      // The ceiling of one review.
      expect(remainingReviewTokens(budgets, day(0), null, null)).toBe(300_000);
      // The organisation's day: 1 000 000 − 900 000.
      expect(remainingReviewTokens(budgets, day(900_000), null, null)).toBe(100_000);
      // The project's day: 400 000 − 250 000.
      expect(remainingReviewTokens(budgets, day(500_000, 250_000), null, null)).toBe(150_000);
      // The organisation's day is the smaller of the two.
      expect(remainingReviewTokens(budgets, day(950_000, 250_000), null, null)).toBe(50_000);
    });

    it('leaves a project without a budget out of it', () => {
      const noProjectBudget = { ...budgets, perProjectTokensPerDay: null };
      expect(remainingReviewTokens(noProjectBudget, day(0, 9_999_999), null, null)).toBe(300_000);
      expect(remainingReviewTokens(budgets, day(0, null), null, null)).toBe(300_000);
    });

    it('never goes below 0', () => {
      expect(remainingReviewTokens(budgets, day(1_000_000), null, null)).toBe(0);
      expect(remainingReviewTokens(budgets, day(1_200_000), null, null)).toBe(0);
      expect(remainingReviewTokens(budgets, day(0, 400_000), null, null)).toBe(0);
      expect(remainingReviewTokens(budgets, day(0, 500_000), null, null)).toBe(0);
      expect(remainingReviewTokens({ ...budgets, tokensPerDay: 0 }, day(0, null), null, null)).toBe(
        0,
      );
    });

    describe('with a cost budget of the review', () => {
      // $5 a day is 5 000 000 micro-USD.
      const priced = { ...budgets, costPerDayUsd: 5 };

      it('a cost budget at or past its limit leaves 0', () => {
        // A micro-USD left buys no whole token at 15 micro-USD a token.
        expect(remainingReviewTokens(priced, day(0, 0, 5_000_000 - 1), PRICING, SINGLE_MODEL)).toBe(
          0,
        );
        expect(remainingReviewTokens(priced, day(0, 0, 5_000_000), PRICING, SINGLE_MODEL)).toBe(0);
        expect(remainingReviewTokens(priced, day(0, 0, 5_000_001), PRICING, SINGLE_MODEL)).toBe(0);
        // Without prices nothing turns the cost into tokens, but a limit that is reached is reached.
        expect(remainingReviewTokens(priced, day(0, 0, 5_000_000), null, SINGLE_MODEL)).toBe(0);
        expect(remainingReviewTokens(priced, day(0, 0, 5_000_000), PRICING, null)).toBe(0);
        // A limit of 0 is spent before anything is.
        expect(
          remainingReviewTokens(
            { ...budgets, costPerDayUsd: 0 },
            day(0, 0, 0),
            PRICING,
            SINGLE_MODEL,
          ),
        ).toBe(0);
      });

      it('turns the cost that is left into tokens at the dearer of the two prices', () => {
        // $3 left at the output price of 15 micro-USD a token (the dearer): 200 000 tokens.
        expect(remainingReviewTokens(priced, day(0, 0, 2_000_000), PRICING, SINGLE_MODEL)).toBe(
          200_000,
        );
        // 500 000 / 15 is 33 333.3, and a token not bought is not counted.
        expect(remainingReviewTokens(priced, day(0, 0, 4_500_000), PRICING, SINGLE_MODEL)).toBe(
          33_333,
        );
        // Here the input price is the dearer: 1 000 000 / 20.
        expect(
          remainingReviewTokens(
            priced,
            day(0, 0, 4_000_000),
            { ...PRICING, inputUsdPerMTok: 20, outputUsdPerMTok: 5 },
            SINGLE_MODEL,
          ),
        ).toBe(50_000);
      });

      it('is the smallest of what the tokens and the cost leave', () => {
        // The cost leaves 200 000 tokens, the review ceiling 300 000, the organisation's day 1 000 000.
        expect(remainingReviewTokens(priced, day(0, 0, 2_000_000), PRICING, SINGLE_MODEL)).toBe(
          200_000,
        );
        // The organisation's day leaves 100 000, the cost 200 000.
        expect(
          remainingReviewTokens(priced, day(900_000, 0, 2_000_000), PRICING, SINGLE_MODEL),
        ).toBe(100_000);
      });

      it("the day's cost budget converts at the dearest price in use", () => {
        const tiers = { model: 'fake-model', strongModel: 'big-model', fastModel: 'small-model' };
        const pricing = {
          ...PRICING,
          strong: { inputUsdPerMTok: 60, outputUsdPerMTok: 300 },
          fast: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
        };
        // $3 left. The standard model alone, 15 micro-USD a token, would buy 200 000 tokens; the
        // strong model's 300 buys 10 000, and the cost of a call is not known before it is made.
        expect(remainingReviewTokens(priced, day(0, 0, 2_000_000), pricing, tiers)).toBe(10_000);
        // The strong and fast prices count only for models that are set: with the standard model
        // alone, nothing is costed at them.
        expect(remainingReviewTokens(priced, day(0, 0, 2_000_000), pricing, SINGLE_MODEL)).toBe(
          200_000,
        );
        // The dearest input price may be another tier's than the dearest output price.
        const inputDear = { ...pricing, strong: { inputUsdPerMTok: 500, outputUsdPerMTok: 5 } };
        expect(remainingReviewTokens(priced, day(0, 0, 2_000_000), inputDear, tiers)).toBe(6_000);
      });

      it('leaves the cost out when the review has no cost budget, or the prices are free or unset', () => {
        // The explain, triage and fix budget has no say here: only the review's own `costPerDayUsd`.
        expect(remainingReviewTokens(budgets, day(0, 0, 99_000_000), PRICING, SINGLE_MODEL)).toBe(
          300_000,
        );
        expect(
          remainingReviewTokens(
            priced,
            day(0, 0, 4_000_000),
            { ...PRICING, inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
            SINGLE_MODEL,
          ),
        ).toBe(300_000);
        expect(remainingReviewTokens(priced, day(0, 0, 4_000_000), null, SINGLE_MODEL)).toBe(
          300_000,
        );
        // Without a provider no call is priced either.
        expect(remainingReviewTokens(priced, day(0, 0, 4_000_000), PRICING, null)).toBe(300_000);
      });
    });

    it('goes through effectiveReviewBudgets: the instance ceiling caps the organisation’s own day', async () => {
      const ceiling = {
        ...DEFAULT_LLM_SETTINGS,
        budgets: { ...DEFAULT_LLM_SETTINGS.budgets, reviewTokensPerOrganizationPerDay: 500_000 },
      };
      const own = {
        ...defaultReview(),
        enabled: true,
        budgets: {
          ...DEFAULT_REVIEW_BUDGETS,
          tokensPerDay: 2_000_000,
          maxTokensPerReview: 300_000,
        },
      };
      const settings = withOrganizationReview(ceiling, orgA, own);
      // Today's use: 350 000 tokens.
      await insertRow({ inputTokens: 300_000, outputTokens: 50_000 });
      const organization = await reviewUsageToday(t.db, orgA);

      const effective = effectiveReviewBudgets(settings, orgA);
      expect(effective.tokensPerDay).toBe(500_000);
      // The ceiling leaves 150 000 of the day; the 2 000 000 of the organisation's own budget would
      // have left more than the 300 000 of one review.
      expect(
        remainingReviewTokens(
          effective,
          { organization, project: null },
          settings.pricing,
          settings.provider,
        ),
      ).toBe(150_000);
      const uncapped = effectiveReviewBudgets(
        withOrganizationReview(DEFAULT_LLM_SETTINGS, orgA, own),
        orgA,
      );
      expect(remainingReviewTokens(uncapped, { organization, project: null }, null, null)).toBe(
        300_000,
      );
    });
  });

  describe('the calls of the answers to replies (6I-4)', () => {
    /** The AWS documentation's example key: the redaction takes it out of a text. */
    const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
    const DECISION = JSON.stringify({
      intent: 'factual',
      verdict: 'false_positive',
      answer: 'The loop covers the last item.',
    });
    /** What the model says when it has no code to read: the thread stays as it is. */
    const KEEP = JSON.stringify({
      intent: 'question',
      verdict: 'keep',
      answer: 'The loop runs to n.',
    });
    const inputOf = (over: Partial<ReplyInput> = {}): ReplyInput => ({
      issue: {
        engine: 'ai',
        ruleKey: 'ai:logic',
        message: 'The total skips the last item',
        path: 'src/cart.ts',
        // The one line of the files these tests read.
        line: 1,
        endLine: null,
        // Reviewed at the head of the snapshot below (memorySnapshot's own): the same code.
        reviewedHeadSha: 'a'.repeat(40),
        lineHash: null,
        status: 'open',
        aiBody: 'The loop bound is one short.',
        suggestion: null,
      },
      firstNote: '**AI review** · major · The total skips the last item',
      notes: [{ author: 'alice', body: 'The loop runs to n, so it is fine.' }],
      mayChangeStatus: true,
      snapshot: memorySnapshot({ files: { 'src/cart.ts': 'for (i = 0; i < n; i += 1) {}\n' } }),
      snapshotHead: 'a'.repeat(40),
      ...over,
    });
    const depsOf = (settings: StoredLlmSettings, over: Partial<ReplyDeps> = {}): ReplyDeps => ({
      db: t.db,
      runtime,
      config,
      settings,
      organizationId: orgA,
      reply: { id: randomUUID(), projectId: projectA1 },
      ...over,
    });
    /** The model reads a file; `tokens` are what the provider counts for the call. */
    const readTurn = (tokens: [number, number], path = 'src/cart.ts'): LlmReply => ({
      status: 200,
      body: openAiToolCalls([{ id: 'c1', name: 'read_file', arguments: { path } }], {
        usage: { prompt_tokens: tokens[0], completion_tokens: tokens[1] },
      }),
    });
    /** The settings of an organisation whose review budgets are the defaults over `budgets`. */
    const withBudgets = (
      settings: StoredLlmSettings,
      budgets: Partial<typeof DEFAULT_REVIEW_BUDGETS>,
    ): StoredLlmSettings =>
      withOrganizationReview(settings, orgA, {
        ...defaultReview(),
        enabled: true,
        budgets: { ...DEFAULT_REVIEW_BUDGETS, ...budgets },
      });
    /** Whether a request to the provider was the wrap-up: the loop's message is the last one. */
    const wrapUp = (index: number) =>
      fake.requests[index]?.body.includes(CONVERSATION_TEXTS.wrapUp) ?? false;

    it('every call is a review-reply row and counts in the review day', async () => {
      // A provider with a model for each tier, each with its own prices: the reply uses the standard one.
      const settings: StoredLlmSettings = {
        ...settingsFor('openai', { storePrompts: true }),
        provider: {
          ...configuredProvider(config.secretKey, fake),
          strongModel: 'strong-model',
          fastModel: 'fast-model',
        },
        pricing: {
          ...PRICING,
          strong: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
          fast: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
        },
      };
      const lines: { data: Record<string, unknown>; message: string }[] = [];
      const logger = {
        info: (data: Record<string, unknown>, message: string) =>
          void lines.push({ data, message }),
        warn: () => undefined,
        error: () => undefined,
      } as unknown as WorkerLogger;
      const deps = depsOf(settings, { logger });
      fake.enqueue(readTurn([1_000, 100]), textTurn('openai', DECISION, [2_000, 200]));
      const decision = await decideReply(
        inputOf({
          notes: [{ author: 'alice', body: `A fixture key, not a real one: ${AWS_KEY}.` }],
          snapshot: memorySnapshot({ files: { 'src/cart.ts': `const key = '${AWS_KEY}';\n` } }),
        }),
        deps,
      );
      // 1 000 × $3 + 100 × $15 and 2 000 × $3 + 200 × $15 per million tokens, in micro-USD.
      expect(decision).toEqual({
        verdict: 'false_positive',
        answer: 'The loop covers the last item.',
        readCode: true,
        usage: { model: 'fake-model', inputTokens: 3_000, outputTokens: 300, costMicroUsd: 13_500 },
      });

      const stored = await rows();
      expect(stored).toHaveLength(2);
      for (const row of stored) {
        expect(row).toMatchObject({
          organizationId: orgA,
          projectId: projectA1,
          issueId: null,
          userId: null,
          feature: 'review-reply',
          provider: 'openai',
          providerHost: fake.host,
          model: 'fake-model',
          promptVersion: REPLY_PROMPT_VERSION,
          attempts: 1,
          fields: ['review-reply'],
          status: 'succeeded',
          errorCode: null,
        });
        // Finished when written: never queued or running, which the `llm` sweep would fail.
        expect(row.finishedAt).toBeInstanceOf(Date);
      }
      expect(stored.map((row) => [row.inputTokens, row.outputTokens, row.costMicroUsd])).toEqual([
        [1_000, 100, 4_500],
        [2_000, 200, 9_000],
      ]);
      // The key in the note is masked in the first message, the one in the file in what the tool
      // answered: each on the row of the call that carried it.
      expect(stored.map((row) => row.redactions)).toEqual([1, 1]);
      // Every call went to the standard model, whatever the strong and the fast tier are.
      expect(fake.requests.map((request) => (request.json as { model: string }).model)).toEqual([
        'fake-model',
        'fake-model',
      ]);
      expect(fake.requests.map((request) => request.body).join('')).not.toContain(AWS_KEY);
      // The stored prompt and the log lines name the reply, not a run.
      expect(stored[0]!.prompt).toMatchObject({ replyId: deps.reply.id, omitted: 0 });
      expect(stored[0]!.prompt).not.toHaveProperty('runId');
      expect(lines.map((line) => line.message)).toEqual([
        'AI review reply call finished',
        'AI review reply call finished',
      ]);
      expect(lines.map((line) => line.data.replyId)).toEqual([deps.reply.id, deps.reply.id]);

      // The calls of the answer are the review day's: they take from its budgets, and from nobody
      // else's. A reply is no review, so no review is counted.
      expect(await reviewUsageToday(t.db, orgA)).toEqual({
        tokens: 3_300,
        costMicroUsd: 13_500,
        reviews: 0,
      });
      expect(await reviewUsageToday(t.db, orgA, projectA1)).toMatchObject({ tokens: 3_300 });
      expect(await reviewUsageToday(t.db, orgA, projectA2)).toMatchObject({ tokens: 0 });
      expect(await reviewUsageToday(t.db, orgB)).toMatchObject({ tokens: 0 });
      expect(await todayUsage(t.db, orgA)).toEqual({
        explain: 0,
        triage: 0,
        fix: 0,
        tokens: 0,
        costMicroUsd: 0,
      });
    });

    it('a day without room skips the reply before any call, and what replies spend is what the day loses', async () => {
      const settings = withBudgets(settingsFor('openai'), { tokensPerDay: 20_000 });
      // A review spent some of the day: 17 800 tokens are left, more than a reply's first call needs.
      await insertRow({ inputTokens: 2_000, outputTokens: 200 });
      fake.enqueue(textTurn('openai', KEEP, [17_700, 100]));
      expect(await decideReply(inputOf({ snapshot: null }), depsOf(settings))).toMatchObject({
        verdict: 'keep',
      });
      expect(fake.requests).toHaveLength(1);
      // Its call took the rest of the day: the next reply finds none, and makes no call.
      fake.requests.length = 0;
      expect(await decideReply(inputOf({ snapshot: null }), depsOf(settings))).toEqual({
        failed: 'budget_spent',
      });
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toHaveLength(2);
    });

    it('skips the reply when the day leaves less than its first call needs, and runs it with just enough', async () => {
      // What the first call takes: its prompt and first message at the review's characters to a
      // token, and the most its answer may write. A reply made on a roomy day shows what to count.
      fake.say(KEEP);
      await decideReply(inputOf({ snapshot: null }), depsOf(settingsFor('openai')));
      const wire = JSON.parse(fake.requests[0]?.body ?? '{}') as {
        messages: { content: string }[];
      };
      const chars =
        (wire.messages[0]?.content.length ?? 0) + (wire.messages[1]?.content.length ?? 0);
      const needed = Math.ceil(chars / CHARS_PER_TOKEN) + REVIEW_OUTPUT_TOKENS.reply;
      expect(needed).toBeGreaterThan(REVIEW_OUTPUT_TOKENS.reply + 1_000);
      await t.db.delete(llmRequests);
      fake.requests.length = 0;

      // One token short: no call, no row, whatever the model would have said.
      const short = withBudgets(settingsFor('openai'), { tokensPerDay: needed - 1 });
      expect(await decideReply(inputOf({ snapshot: null }), depsOf(short))).toEqual({
        failed: 'budget_spent',
      });
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toHaveLength(0);

      // Just enough: it is made.
      const enough = withBudgets(settingsFor('openai'), { tokensPerDay: needed });
      fake.say(KEEP);
      expect(await decideReply(inputOf({ snapshot: null }), depsOf(enough))).toMatchObject({
        verdict: 'keep',
      });
      expect(fake.requests).toHaveLength(1);
      expect(await rows()).toHaveLength(1);

      // The project's day is a day too: the same floor under what it leaves.
      await t.db.delete(llmRequests);
      fake.requests.length = 0;
      const project = withBudgets(settingsFor('openai'), { perProjectTokensPerDay: needed - 1 });
      expect(await decideReply(inputOf({ snapshot: null }), depsOf(project))).toEqual({
        failed: 'budget_spent',
      });
      expect(fake.requests).toHaveLength(0);
    });

    it('draws on the project’s day as well as the organisation’s', async () => {
      const settings = withBudgets(settingsFor('openai'), { perProjectTokensPerDay: 20_000 });
      await insertRow({ inputTokens: 20_000, outputTokens: 0, projectId: projectA1 });
      expect(await decideReply(inputOf(), depsOf(settings))).toEqual({ failed: 'budget_spent' });
      expect(fake.requests).toHaveLength(0);
      // Another project of the organisation has its own day.
      fake.say(KEEP);
      expect(
        await decideReply(
          inputOf({ snapshot: null }),
          depsOf(settings, { reply: { id: randomUUID(), projectId: projectA2 } }),
        ),
      ).toMatchObject({ verdict: 'keep' });
    });

    it('keeps to the least of REPLY_TOKEN_BUDGET and what the day leaves, not to a review’s ceiling', async () => {
      /** One tool turn that uses 10 500 tokens, and the answer; whether the model was told to wrap up. */
      const wrapsUp = async (settings: StoredLlmSettings): Promise<boolean> => {
        await t.db.delete(llmRequests);
        fake.requests.length = 0;
        fake.enqueue(readTurn([10_000, 500]), textTurn('openai', DECISION, [10, 5]));
        await decideReply(inputOf(), depsOf(settings));
        expect(fake.requests).toHaveLength(2);
        return wrapUp(1);
      };
      expect(REPLY_TOKEN_BUDGET).toBe(60_000);
      // Of 60 000 tokens, 10 500 leave room for another turn and the wrap-up after it: the model
      // goes on. A review's ceiling of 1 000 tokens is not a reply's.
      expect(await wrapsUp(withBudgets(settingsFor('openai'), { maxTokensPerReview: 1_000 }))).toBe(
        false,
      );
      // A day with 30 000 tokens left: it does not, and the next request is the wrap-up.
      expect(await wrapsUp(withBudgets(settingsFor('openai'), { tokensPerDay: 30_000 }))).toBe(
        true,
      );
    });

    it('makes no call and writes no row when there is no provider to call', async () => {
      const none = { ...settingsFor('openai'), provider: null };
      expect(await decideReply(inputOf(), depsOf(none))).toEqual({ failed: 'provider_error' });
      // A key that no longer decrypts (the secret key of the server changed).
      const stale = depsOf(settingsFor('openai'), {
        config: { ...config, secretKey: `${config.secretKey}-changed` },
      });
      expect(await decideReply(inputOf(), stale)).toEqual({ failed: 'provider_error' });
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
    });

    it('a call the provider refuses is a provider error, and its row is a failed review-reply row', async () => {
      fake.enqueue(failure('openai', 401));
      expect(await decideReply(inputOf(), depsOf(settingsFor('openai')))).toEqual({
        failed: 'provider_error',
      });
      expect(first(await rows())).toMatchObject({
        feature: 'review-reply',
        status: 'failed',
        errorCode: 'PROVIDER_REFUSED_KEY',
        inputTokens: null,
        costMicroUsd: null,
      });
    });

    it('gives the tools the paths the administrator excluded, and the answer never holds the provider’s key', async () => {
      const settings = {
        ...settingsFor('openai', { storePrompts: true }),
        excludePaths: ['src/cart.ts'],
      };
      // The model reads the excluded file, and writes the provider's key in its answer.
      const echo = JSON.stringify({
        intent: 'question',
        verdict: 'keep',
        answer: `The key is ${fake.apiKey}.`,
      });
      fake.enqueue(readTurn([100, 10]), textTurn('openai', echo, [100, 10]));
      const decision = await decideReply(inputOf(), depsOf(settings));
      expect(decision).toMatchObject({ verdict: 'keep', answer: `The key is ${REDACTED}.` });
      // The file is not shown, and the call that asked for it says why.
      expect(fake.requests[1]?.body).toContain('excluded by the administrator');
      expect(fake.requests[1]?.body).not.toContain('i += 1');
      // The key the model echoed is in no row, the stored result included.
      expect(JSON.stringify(await rows())).not.toContain(fake.apiKey);
    });

    it('is stopped by the server stopping, or by the caller, before a call is made', async () => {
      const controller = new AbortController();
      controller.abort();
      expect(
        await decideReply(inputOf(), depsOf(settingsFor('openai'), { signal: controller.signal })),
      ).toEqual({ stopped: true });
      expect(
        await decideReply(
          inputOf(),
          depsOf(settingsFor('openai'), { shouldStop: () => Promise.resolve(true) }),
        ),
      ).toEqual({ stopped: true });
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
    });

    it('gives up a call in flight when the server stops, and writes no row for it', async () => {
      const controller = new AbortController();
      fake.enqueue({ ...textTurn('openai', KEEP, [10, 5]), delayMs: 4_000 });
      const deciding = decideReply(
        inputOf({ snapshot: null }),
        depsOf(settingsFor('openai'), { signal: controller.signal }),
      );
      await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
      controller.abort();
      expect(await deciding).toEqual({ stopped: true });
      // The call was cut at once: the provider saw it hang up, and nothing was charged for it.
      await vi.waitFor(() => expect(fake.abandoned).toHaveLength(1));
      expect(await rows()).toHaveLength(0);
    });

    it('lets a call wait for its answer for five minutes, not the assistant’s five seconds', async () => {
      // The fake's provider times out after 5 s (configuredProvider): a reply is not a person waiting.
      fake.enqueue({ ...textTurn('openai', KEEP, [10, 5]), delayMs: 5_500 });
      expect(
        await decideReply(inputOf({ snapshot: null }), depsOf(settingsFor('openai'))),
      ).toMatchObject({ verdict: 'keep' });
    });
  });
});
