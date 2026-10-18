import { describe, expect, it } from 'vitest';
import type { CallResult, McpCaller, Query } from '../inject';
import { MAX_BRANCH_PAGES, branchOf } from '../resolve';
import { ToolError, type ToolContext } from '../tool';
import { MAX_ANALYSIS_PAGES, gateStatusTool } from './gate-status';

const ok = <T>(body: T): CallResult<T> => ({ ok: true, status: 200, body });

const PROJECT = {
  id: 'p1',
  key: 'shop',
  name: 'Shop',
  organizationId: 'o1',
};
const MAIN = {
  id: 'b1',
  kind: 'branch',
  name: 'main',
  isMain: true,
  lastAnalysisId: null,
  gateStatus: null,
  mrUrl: null,
  mrSourceBranch: null,
};

const sha = (c: string) => c.repeat(40);

function analysis(n: number, revision: string | null, status = 'succeeded', gateResult?: unknown) {
  return {
    id: `a${n}`,
    status,
    revision,
    analysisDate: '2026-10-01T00:00:00.000Z',
    gateStatus: status === 'succeeded' ? 'passed' : null,
    gateResult: gateResult ?? null,
    error: null,
    queuedAt: '2026-10-01T00:00:00.000Z',
  };
}

/** A caller that serves project, main branch and the given pages of analyses (newest first). */
function callerWith(pages: unknown[][], seen: Query[] = []): McpCaller {
  return {
    async get<T>(path: string, query?: Query) {
      if (path === '/api/v0/projects/by-key') return ok(PROJECT as T);
      if (path.endsWith('/branches')) return ok({ items: [MAIN], nextCursor: null } as T);
      seen.push(query ?? {});
      const index = query?.cursor ? Number(query.cursor) : 0;
      const items = pages[index] ?? [];
      return ok({ items, nextCursor: index + 1 < pages.length ? String(index + 1) : null } as T);
    },
    post() {
      throw new Error('unexpected POST');
    },
  };
}

const run = (call: McpCaller, commit: string) =>
  gateStatusTool.run({ project: 'shop', commit }, { call } as ToolContext);

describe('branchOf paging', () => {
  it('says the search ended early, never that CI has not run, when branches remain', async () => {
    let pages = 0;
    const call: McpCaller = {
      async get<T>() {
        pages += 1;
        return ok({ items: [], nextCursor: `c${pages}` } as T);
      },
      post() {
        throw new Error('unexpected POST');
      },
    };
    const err = await branchOf(call, PROJECT, { branch: 'feature/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(pages).toBe(MAX_BRANCH_PAGES);
    expect((err as ToolError).code).toBe('SEARCH_INCOMPLETE');
    expect((err as ToolError).message).toContain('Searched the first 10000 branches');
    expect((err as ToolError).message).toContain('feature/x');
    expect((err as ToolError).message).not.toContain('CI runs');
  });

  it('says CI has not run when the branches really end', async () => {
    const call = callerWith([[]]);
    // callerWith serves branches itself with nextCursor null
    const err = await branchOf(call, PROJECT, { branch: 'nope' }).catch((e: unknown) => e);
    expect((err as ToolError).code).toBe('NOT_FOUND');
    expect((err as ToolError).message).toContain('CI runs');
  });
});

describe('qualor_gate_status commit search', () => {
  it('pages past the first 100 analyses to find an older commit', async () => {
    const newer = Array.from({ length: 100 }, (_, i) => analysis(i, sha('1')));
    const seen: Query[] = [];
    const out = await run(
      callerWith([newer, [analysis(200, sha('2'))]], seen),
      'ab'.repeat(2) + '2222',
    );
    expect(out.structured).toMatchObject({ commit: { state: 'not_yet' } });
    const old = await run(callerWith([newer, [analysis(200, sha('2'))]], seen), sha('2'));
    expect(old.structured).toMatchObject({ commit: { state: 'analyzed' } });
    expect(seen.every((q) => q.limit === 100)).toBe(true);
  });

  it('says only the newest analyses were searched when the budget runs out', async () => {
    const page = Array.from({ length: 100 }, (_, i) => analysis(i, sha('1')));
    const pages = Array.from({ length: MAX_ANALYSIS_PAGES + 5 }, () => page);
    const out = await run(callerWith(pages), sha('9'));
    expect(out.structured).toMatchObject({
      commit: { state: 'not_yet', searched: MAX_ANALYSIS_PAGES * 100, complete: false },
    });
    expect(out.text).toContain(`newest ${MAX_ANALYSIS_PAGES * 100} analyses`);
    expect(out.text).not.toContain('is not analysed yet');
  });

  it('reports a complete search as complete', async () => {
    const out = await run(callerWith([[analysis(1, sha('1'))]]), sha('9'));
    expect(out.structured).toMatchObject({ commit: { state: 'not_yet', complete: true } });
    expect(out.text).toContain('is not analysed yet');
  });

  it('answers with the latest analysis when a commit was analysed more than once', async () => {
    const pages = [
      [analysis(3, sha('3'), 'processing'), analysis(2, sha('3'), 'failed'), analysis(1, sha('3'))],
    ];
    const out = await run(callerWith(pages), sha('3').slice(0, 10));
    expect(out.structured).toMatchObject({ commit: { state: 'in_progress' } });
    const done = await run(
      callerWith([[analysis(2, sha('3')), analysis(1, sha('3'), 'failed')]]),
      sha('3').slice(0, 10),
    );
    expect(done.structured).toMatchObject({ commit: { state: 'analyzed' } });
  });

  it('refuses a short SHA that matches two commits and lists them', async () => {
    const a = `abc1${'0'.repeat(36)}`;
    const b = `abc2${'0'.repeat(36)}`;
    const err = await run(callerWith([[analysis(2, a), analysis(1, b)]]), 'abc').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('AMBIGUOUS_COMMIT');
    expect((err as ToolError).message).toContain('matches 2 commits');
    expect((err as ToolError).message).toContain(a.slice(0, 12));
    expect((err as ToolError).message).toContain(b.slice(0, 12));
  });
});

describe('qualor_gate_status gate result', () => {
  it('skips malformed condition entries', async () => {
    const gateResult = {
      conditions: [
        null,
        'x',
        { metric: 5 },
        { metric: 'new_violations', operator: 'gt', threshold: 0, value: 2, status: 'failed' },
        { metric: 'new_coverage', operator: 'lt', threshold: 80, value: 90, status: 'passed' },
      ],
    };
    const out = await run(callerWith([[analysis(1, sha('4'), 'succeeded', gateResult)]]), sha('4'));
    expect(out.structured?.failedConditions).toEqual([
      { metric: 'new_violations', operator: 'gt', threshold: 0, value: 2 },
    ]);
  });
});
