import { gzipSync } from 'node:zlib';
import {
  encodeSnapshotLine,
  hex32,
  type SnapshotEndLine,
  type SnapshotHeaderLine,
  type SnapshotLine,
} from '@qualor/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db, Executor } from '../src/db/client';
import { first } from '../src/db/rows';
import { analyses, branches, issues, reviewSnapshots, type AiCategory } from '../src/db/schema';
import {
  DEFAULT_AUTO_FIX,
  DEFAULT_LLM_SETTINGS,
  writeLlmSettings,
  type StoredLlmSettings,
} from '../src/llm/settings';
import type { ReviewRole } from '../src/review/prompts';
import { AI_RULES, ensureAiRules } from '../src/review/rules';
import {
  DEFAULT_REVIEW_BUDGETS,
  defaultReview,
  reviewProvider,
  type ReviewBudgets,
} from '../src/review/settings';
import {
  memorySnapshotReader,
  type SnapshotChange,
  type SnapshotFile,
  type SnapshotMeta,
  type SnapshotReader,
} from '../src/review/snapshot-reader';
import { storeSnapshotUpload, unpackSnapshot } from '../src/review/snapshot-store';
import {
  anthropicAnswer,
  openAiAnswer,
  type FakeLlm,
  type LlmResponder,
  type RecordedLlmRequest,
} from './fake-llm';
import { configuredProvider } from './llm';

export interface AiIssueSeed {
  branchId: string;
  category: AiCategory;
  path: string;
  line: number;
  /** The rule's default severity unless given. */
  severity?: 'blocker' | 'high' | 'medium' | 'low' | 'info';
  status?: 'open' | 'resolved' | 'wont_fix' | 'false_positive' | 'closed';
  snippet?: unknown;
}

let seedCounter = 0;

/**
 * Inserts one issue of engine `ai` on a branch, as a review run leaves it: the category's builtin
 * rule (created when missing), the rule's quality, in new code, no duplicate, `high` confidence.
 * The issue alone: no `review_findings` row and no run. Returns its id.
 */
export async function seedAiIssue(db: Executor, seed: AiIssueSeed): Promise<string> {
  seedCounter += 1;
  const branch = first(
    await db
      .select({ projectId: branches.projectId })
      .from(branches)
      .where(eq(branches.id, seed.branchId)),
  );
  const ruleId = (await ensureAiRules(db)).get(seed.category);
  const rule = AI_RULES.find((r) => r.category === seed.category);
  if (ruleId === undefined || rule === undefined) throw new Error(`no AI rule ${seed.category}`);
  const status = seed.status ?? 'open';
  const row = first(
    await db
      .insert(issues)
      .values({
        projectId: branch.projectId,
        branchId: seed.branchId,
        ruleId,
        fingerprint: hex32(`ai-fp:${seedCounter}`),
        lineHash: hex32(`ai-line:${seedCounter}`),
        contextHash: hex32(`ai-context:${seedCounter}`),
        path: seed.path,
        startLine: seed.line,
        endLine: seed.line,
        message: `AI finding ${seedCounter}`,
        severity: seed.severity ?? rule.defaultSeverity,
        quality: rule.quality,
        kind: 'issue',
        status,
        inNewCode: true,
        confidence: 'high',
        snippet: seed.snippet ?? null,
        firstSeenAt: sql`now()`,
        closedAt: status === 'closed' ? sql`now()` : null,
      })
      .returning({ id: issues.id }),
  );
  return row.id;
}

// ─── Repository snapshots ────────────────────────────────────────────────────

const TEST_HEAD_SHA = 'a'.repeat(40);
const TEST_BASE_SHA = 'b'.repeat(40);
const MiB = 1024 * 1024;

/**
 * Stores `lines` (what follows the header and precedes the end line) as the snapshot of
 * `analysisId` and unpacks it with the real unpacker: the snapshot comes back `ready`, as the
 * scanner's upload does after the job ran. The header is a fixed test one (head `aaaa…`, base
 * `bbbb…`, merge request `7`) unless `header` changes fields; the end line counts `lines`. A
 * snapshot the unpacker refuses throws with the reason it stored. Returns the snapshot's id.
 */
export async function storeTestSnapshot(
  db: Db,
  analysisId: string,
  lines: readonly SnapshotLine[],
  header: Partial<SnapshotHeaderLine> = {},
): Promise<string> {
  const analysis = first(
    await db
      .select({ projectId: analyses.projectId })
      .from(analyses)
      .where(eq(analyses.id, analysisId)),
  );
  const count = (type: SnapshotLine['type']) => lines.filter((line) => line.type === type).length;
  const head: SnapshotHeaderLine = {
    type: 'header',
    v: 1,
    headSha: TEST_HEAD_SHA,
    baseSha: TEST_BASE_SHA,
    sinceSha: null,
    targetBranch: 'main',
    mergeRequest: { id: '7', title: 'A change', description: 'It changes things.' },
    partial: false,
    generator: 'qualor-cli/test',
    ...header,
  };
  const end: SnapshotEndLine = {
    type: 'end',
    files: count('file'),
    changes: count('change'),
    omitted: count('omitted'),
  };
  const body = gzipSync([head, ...lines, end].map(encodeSnapshotLine).join(''));
  const snapshotId = await storeSnapshotUpload(db, {
    analysisId,
    projectId: analysis.projectId,
    body,
    compressedBytes: body.length,
  });
  const outcome = await unpackSnapshot(db, snapshotId, {
    maxCompressedBytes: 50 * MiB,
    maxDecompressedBytes: 500 * MiB,
  });
  if (outcome !== 'ready') {
    const stored = first(
      await db
        .select({ error: reviewSnapshots.error })
        .from(reviewSnapshots)
        .where(eq(reviewSnapshots.id, snapshotId)),
    );
    throw new Error(
      `the test snapshot did not unpack (${outcome}): ${stored.error ?? 'no reason'}`,
    );
  }
  return snapshotId;
}

export interface MemorySnapshotInput {
  /** The meta fields to set; the others read as a test default (see {@link storeTestSnapshot}). */
  meta?: Partial<SnapshotMeta>;
  /** A change needs its path; the rest reads as a modified file with no patch and no ranges. */
  changes?: readonly (Pick<SnapshotChange, 'path'> & Partial<SnapshotChange>)[];
  /** The files by path: a string is a text file, anything else is the file as the reader gives it. */
  files?: Readonly<Record<string, string | SnapshotFile>>;
}

/**
 * A snapshot reader in memory, from a short description. The same reader the evaluation set uses
 * (`memorySnapshotReader`), with the meta, the changes and the files filled in where a test leaves
 * them out.
 */
export function memorySnapshot(input: MemorySnapshotInput = {}): SnapshotReader {
  return memorySnapshotReader({
    meta: {
      snapshotId: null,
      headSha: TEST_HEAD_SHA,
      baseSha: TEST_BASE_SHA,
      sinceSha: null,
      targetBranch: 'main',
      mrTitle: null,
      mrDescription: null,
      instructions: [],
      partial: false,
      ...input.meta,
    },
    changes: (input.changes ?? []).map((change) => ({
      oldPath: null,
      status: 'modified',
      patch: null,
      since: null,
      ...change,
    })),
    files: Object.fromEntries(
      Object.entries(input.files ?? {}).map(([path, file]) => [
        path,
        typeof file === 'string' ? ({ kind: 'text', text: file } as const) : file,
      ]),
    ),
  });
}

/**
 * A text the shared redaction takes seconds to mask (about 9 s here): fifty lines of 4 000
 * characters that are nothing but the start of a JWT, over and over. For the tests of the time a
 * masking may take.
 */
export const HOSTILE_TEXT = Array.from({ length: 50 }, () => 'eyJ'.repeat(1_333)).join('\n');

// ─── AI review on, against the fake provider ─────────────────────────────────

/**
 * Turns the AI assistant and AI review on for one organisation against the fake provider: every
 * project in scope, a consent that names the provider configured (R10), and the review budgets as
 * given over the defaults. That organisation is the only one in the settings; the other instance
 * settings (prices, excluded paths, …) come from `over`.
 */
export async function switchReviewOn(
  db: Db,
  o: {
    secretKey: string;
    fake: FakeLlm;
    organizationId: string;
    /** Who gave the consent. */
    userId: string;
    budgets?: Partial<ReviewBudgets>;
    over?: Partial<StoredLlmSettings>;
  },
): Promise<void> {
  const base: StoredLlmSettings = {
    ...DEFAULT_LLM_SETTINGS,
    provider: configuredProvider(o.secretKey, o.fake),
    ...o.over,
  };
  const provider = reviewProvider(base);
  if (provider === null) throw new Error('the fake provider has no address');
  await writeLlmSettings(db, {
    ...base,
    organizations: {
      [o.organizationId]: {
        enabled: true,
        features: { explain: true, triage: true, fix: true },
        excludedProjectIds: [],
        autoFix: { ...DEFAULT_AUTO_FIX },
        autoFixDisabledProjectIds: [],
        review: {
          ...defaultReview(),
          enabled: true,
          scope: 'all',
          budgets: { ...DEFAULT_REVIEW_BUDGETS, ...o.budgets },
          consent: {
            providerUrl: provider.url,
            providerHost: provider.host,
            model: provider.model,
            models: provider.models,
            userId: o.userId,
            at: new Date().toISOString(),
          },
        },
      },
    },
  });
}

// ─── A scripted reviewer ─────────────────────────────────────────────────────

/** What a role answers: the model's text, or a function of the request that makes it. */
export type ReviewAnswer = string | ((request: RecordedLlmRequest) => string | Promise<string>);
/** The answer of each role; a role left out answers that it found nothing. */
export type ReviewScript = Partial<Record<ReviewRole, ReviewAnswer>>;

/** The tokens every scripted answer reports, so that a run has counts to add up. */
export const REVIEW_CALL_USAGE = { input: 1_000, output: 100 } as const;

const NOTHING_FOUND: Readonly<Record<ReviewRole, string>> = {
  quality: '{"findings":[]}',
  tests: '{"findings":[]}',
  security: '{"findings":[]}',
  performance: '{"findings":[]}',
  judge: JSON.stringify({
    findings: [],
    dropped: [],
    prior: [],
    summary: { verdict: 'Nothing to report.', walkthrough: [] },
  }),
  verify: JSON.stringify({ verdict: 'confirmed', reason: 'The code shows it.' }),
};

const ROLE_LINE = /^Qualor review: (quality|tests|security|performance|judge|verify)$/;

/**
 * The role a review call is made for: the first line of its system prompt, `Qualor review: <role>`
 * (prompts.ts), in either provider's shape. Null for any other call.
 */
export function reviewRoleOf(request: RecordedLlmRequest): ReviewRole | null {
  const json = request.json as {
    system?: unknown;
    messages?: { role?: unknown; content?: unknown }[];
  } | null;
  const system =
    request.path === '/v1/messages'
      ? json?.system
      : json?.messages?.find((message) => message.role === 'system')?.content;
  if (typeof system !== 'string') return null;
  const role = ROLE_LINE.exec(system.split('\n', 1)[0] ?? '')?.[1];
  return role === undefined ? null : (role as ReviewRole);
}

/**
 * A provider's answer to one review call, by the role its system prompt names: the script's text
 * for that role, or that it found nothing. Each answer reports REVIEW_CALL_USAGE. One responder
 * answers one call (the fake takes a reply per request): enqueue as many as the review makes.
 */
export function reviewResponder(script: ReviewScript = {}): LlmResponder {
  return async (request) => {
    const role = reviewRoleOf(request);
    if (role === null) return { status: 400, body: { error: 'not a review call' } };
    const answer = script[role];
    const text =
      typeof answer === 'function' ? await answer(request) : (answer ?? NOTHING_FOUND[role]);
    const { input, output } = REVIEW_CALL_USAGE;
    return {
      status: 200,
      body:
        request.path === '/v1/messages'
          ? anthropicAnswer(text, { usage: { input_tokens: input, output_tokens: output } })
          : openAiAnswer(text, { usage: { prompt_tokens: input, completion_tokens: output } }),
    };
  };
}
