import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, login } from '../../test/app';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import { configureLlm, llmJobDeps, runLlmJobs } from '../../test/llm';
import { callTool } from '../../test/mcp';
import { oauthTokens } from '../../test/oauth';
import { engine, file, finding, reportWith } from '../../test/reports';
import { issues, llmRequests, rules } from '../db/schema';
import { DEFAULT_AUTO_FIX } from '../llm/settings';
import { defaultReview } from '../review/settings';
import { parseInternalHosts } from '../scm/url';
import { aiWait } from './tools/ai';

const LINES = ['const a = 1;', 'if (a == 1) {}', 'export {};'];

describe('MCP AI tools (ruling R1)', () => {
  let fake: FakeLlm;
  let h: IngestHarness;
  let token: string;
  let eqIssue: string;
  let otherIssue: string;
  const saved = { ...aiWait };

  const ask = (name: string, args: Record<string, unknown>) =>
    callTool(h.ctx, token, name, { issueId: eqIssue, ...args });
  const configure = (over: Parameters<typeof configureLlm>[4] = {}) =>
    configureLlm(h.ctx.db, h.ctx.config.secretKey, fake, h.organizationId, over);

  beforeAll(async () => {
    fake = await createFakeLlm();
    h = await createIngestHarness({
      config: {
        publicUrl: 'https://q.example',
        llmInternalHosts: parseInternalHosts(fake.host),
      },
    });
    const p = await h.project('acme/ai');
    const snippet = { startLine: 1, lines: LINES };
    await p.ingestOk(
      reportWith({
        projectKey: 'acme/ai',
        engines: [engine('eslint')],
        files: [file('src/a.ts', { lines: 3 })],
        findings: [
          finding({ ruleId: 'eqeqeq', line: 2, snippet }),
          finding({ ruleId: 'no-undef', line: 1, snippet }),
        ],
      }),
    );
    const rows = await h.ctx.db
      .select({ id: issues.id, key: rules.key })
      .from(issues)
      .innerJoin(rules, eq(rules.id, issues.ruleId));
    eqIssue = rows.find((r) => r.key === 'eslint:eqeqeq')!.id;
    otherIssue = rows.find((r) => r.key === 'eslint:no-undef')!.id;
    const a = await createUser(h.ctx, { username: 'alice' });
    await addMember(h.ctx, h.organizationId, a.id, 'member');
    const alice = await login(h.ctx, a.username, a.password);
    token = (await oauthTokens(h.ctx, alice, ['mcp:read'])).accessToken;
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });
  beforeEach(async () => {
    await h.ctx.db.delete(llmRequests);
    await configure();
    aiWait.ms = 0;
  });
  afterEach(() => {
    Object.assign(aiWait, saved);
  });

  it('explains with only mcp:read: pending first, then the answer by requestId', async () => {
    const first = await ask('qualor_explain', {});
    expect(first.isError, first.text).toBe(false);
    expect(first.structured).toMatchObject({ status: 'pending' });
    const requestId = first.structured?.requestId as string;
    expect(first.text).toContain(requestId);

    await runLlmJobs(h, llmJobDeps(h));
    const second = await ask('qualor_explain', { requestId });
    expect(second.isError, second.text).toBe(false);
    expect(second.structured).toMatchObject({ status: 'succeeded', requestId });
    expect(second.text).toContain('Loose equality compares after type coercion.');
    expect(second.text).toContain('Use === and convert the value explicitly');

    // Asking again answers from the cache, with no wait.
    const cached = await ask('qualor_explain', {});
    expect(cached.structured).toMatchObject({ status: 'succeeded', requestId });
  });

  it('suggests a fix: pending first, then the replacement lines', async () => {
    const first = await ask('qualor_suggest_fix', {});
    expect(first.structured).toMatchObject({ status: 'pending' });
    const requestId = first.structured?.requestId as string;

    await runLlmJobs(h, llmJobDeps(h));
    const second = await ask('qualor_suggest_fix', { requestId });
    expect(second.isError, second.text).toBe(false);
    expect(second.structured).toMatchObject({ status: 'succeeded', requestId });
    expect(second.text).toContain('Use strict equality.');
    expect(second.text).toContain('Replace lines 2–2');
    expect(second.text).toContain('- if (a == 1) {}');
    expect(second.text).toContain('+ if (a === 1) {}');
  });

  it('polls within the wait until the request finishes', async () => {
    aiWait.ms = 5_000;
    aiWait.pollMs = 20;
    const worker = (async () => {
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        if ((await runLlmJobs(h, llmJobDeps(h))) > 0) return;
      }
    })();
    const r = await ask('qualor_explain', {});
    await worker;
    expect(r.structured).toMatchObject({ status: 'succeeded' });
  });

  it('returns the failure of a failed request', async () => {
    const first = await ask('qualor_explain', {});
    const requestId = first.structured?.requestId as string;
    await h.ctx.db
      .update(llmRequests)
      .set({ status: 'failed', errorCode: 'PROVIDER_TIMEOUT' })
      .where(eq(llmRequests.id, requestId));
    const r = await ask('qualor_explain', { requestId });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ status: 'failed', requestId });
    expect(r.text).toContain('PROVIDER_TIMEOUT');
    expect(r.text).toContain('The model did not answer in time');
  });

  it('returns the failure of a request refused for a key that is not scoped to a workspace, in words that point at the settings', async () => {
    const first = await ask('qualor_explain', {});
    const requestId = first.structured?.requestId as string;
    await h.ctx.db
      .update(llmRequests)
      .set({ status: 'failed', errorCode: 'PROVIDER_WORKSPACE_REQUIRED' })
      .where(eq(llmRequests.id, requestId));
    const r = await ask('qualor_explain', { requestId });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ status: 'failed', requestId });
    expect(r.text).toContain('PROVIDER_WORKSPACE_REQUIRED');
    expect(r.text).toContain(
      'This key is not scoped to a workspace: give its workspace ID in the AI provider settings.',
    );
  });

  it('refuses a requestId of another issue or of the other feature', async () => {
    const explain = await ask('qualor_explain', {});
    const requestId = explain.structured?.requestId as string;
    const wrongTool = await ask('qualor_suggest_fix', { requestId });
    expect(wrongTool.isError).toBe(true);
    expect(wrongTool.text).toContain('REQUEST_MISMATCH');
    const wrongIssue = await callTool(h.ctx, token, 'qualor_explain', {
      issueId: otherIssue,
      requestId,
    });
    expect(wrongIssue.isError).toBe(true);
    expect(wrongIssue.text).toContain('REQUEST_MISMATCH');
  });

  it('answers a clear error when the AI assistant is off for the organisation', async () => {
    await configure({
      organizations: {
        [h.organizationId]: {
          enabled: false,
          features: { explain: false, triage: false, fix: false },
          excludedProjectIds: [],
          autoFix: { ...DEFAULT_AUTO_FIX },
          autoFixDisabledProjectIds: [],
          review: defaultReview(),
        },
      },
    });
    const r = await ask('qualor_explain', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('AI_DISABLED');
  });
});
