import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../../test/ingest';
import { finding, reportWith } from '../../../test/reports';
import { branches, issues, webhookDeliveries, webhookSubscriptions } from '../../db/schema';
import { reevaluateBranch } from '../../gates/reevaluate';

describe('chat gate events from ingestion and re-evaluation (6G spec §4)', () => {
  let h: IngestHarness;
  let project: IngestProject;
  let slack: string;
  let generic: string;
  let day = 1;
  let line = 3;

  const call = (method: 'POST' | 'PATCH', url: string, payload?: unknown) =>
    h.ctx.app.inject({
      method,
      url: `/api/v0${url}`,
      headers: h.orgAdmin.headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const analyse = (
    failing: boolean,
    scm: {
      branch?: string | null;
      mergeRequest?: { id: string; sourceBranch: string; targetBranch: string };
    } = {},
  ) => {
    day += 1;
    return project.ingestOk(
      reportWith({
        projectKey: project.key,
        analysisDate: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`,
        findings: failing ? [finding({ line })] : [],
        ...(scm as object),
      }),
    );
  };
  const chatDeliveries = async () =>
    (
      await h.ctx.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.subscriptionId, slack))
    )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((d) => ({
        event: d.event,
        payload: d.payload as { cause: string; branch: { name: string } } & Record<string, unknown>,
      }));

  beforeAll(async () => {
    h = await createIngestHarness();
    project = await h.project('acme/chatty');
    const gate = (
      await call('POST', '/quality-gates', { organizationId: h.organizationId, name: 'No issues' })
    ).json() as { id: string };
    await call('POST', `/quality-gates/${gate.id}/conditions`, {
      metric: 'issues',
      operator: 'gt',
      threshold: 0,
    });
    // Non-main branches are judged on new code only: the same rule, for them.
    await call('POST', `/quality-gates/${gate.id}/conditions`, {
      metric: 'new_issues',
      operator: 'gt',
      threshold: 0,
    });
    await call('PATCH', `/projects/${project.id}`, { qualityGateId: gate.id });
    const s = await call('POST', '/webhooks', {
      organizationId: h.organizationId,
      kind: 'slack',
      url: 'https://hooks.slack.com/services/T0001/B0001/abcdefghijkl',
      events: ['gate.failed', 'gate.recovered'],
    });
    expect(s.statusCode, s.body).toBe(201);
    slack = (s.json() as { id: string }).id;
    const g = await call('POST', '/webhooks', {
      organizationId: h.organizationId,
      url: 'https://hooks.example.com/qualor',
      events: ['analysis.completed', 'gate.status_changed'],
    });
    expect(g.statusCode, g.body).toBe(201);
    generic = (g.json() as { id: string }).id;
  });
  afterAll(async () => {
    await h.close();
  });

  it('main branch: failed, failed again (nothing), passed (recovered)', async () => {
    await analyse(true);
    await analyse(true);
    await analyse(false);
    const sent = await chatDeliveries();
    expect(sent.map((d) => d.event)).toEqual(['gate.failed', 'gate.recovered']);
    expect(sent[0]?.payload).toMatchObject({
      type: 'gate',
      cause: 'analysis',
      branch: { name: 'main' },
      gate: { name: 'No issues', status: 'failed' },
      failed: [
        { metric: 'issues', operator: 'gt', threshold: 0, value: 1 },
        { metric: 'new_issues', operator: 'gt', threshold: 0, value: 1 },
      ],
      failedCount: 2,
      newIssues: {
        security: expect.any(Number),
        reliability: expect.any(Number),
        maintainability: expect.any(Number),
      },
    });
    expect(sent[1]?.payload).toMatchObject({
      gate: { status: 'passed' },
      failed: [],
      failedCount: 0,
    });
    // The generic webhook gets no chat event.
    const genericEvents = (
      await h.ctx.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.subscriptionId, generic))
    ).map((d) => d.event);
    expect(genericEvents.filter((e) => e === 'gate.failed' || e === 'gate.recovered')).toEqual([]);
    expect(genericEvents).toContain('gate.status_changed');
  });

  it('never for another branch or a merge request, though their gate did change', async () => {
    const before = (await chatDeliveries()).length;
    const onBranch = await analyse(true, { branch: 'feature/x' });
    const onMergeRequest = await analyse(true, {
      branch: null,
      mergeRequest: { id: '7', sourceBranch: 'feature/x', targetBranch: 'main' },
    });
    // Each was its branch's first analysis and failed: a gate transition the generic webhook saw.
    const changes = (
      await h.ctx.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.subscriptionId, generic))
    ).filter((d) => d.event === 'gate.status_changed');
    for (const id of [onBranch, onMergeRequest]) {
      const change = changes.find((d) => (d.payload as { id: string }).id === id);
      expect(change?.payload).toMatchObject({ gateStatus: 'failed', previousGateStatus: null });
    }
    expect(await chatDeliveries()).toHaveLength(before);
  });

  it('a re-evaluation after an issue change sends through the same path', async () => {
    await analyse(true);
    const before = (await chatDeliveries()).length; // gate.failed of this analysis included
    const [main] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.isMain, true)));
    // The failing issue becomes a false positive: the gate passes again on re-evaluation.
    const [issue] = await h.ctx.db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.projectId, project.id),
          eq(issues.branchId, main?.id ?? ''),
          eq(issues.status, 'open'),
        ),
      );
    const res = await call('POST', `/issues/${issue?.id}/transition`, {
      to: 'false_positive',
      comment: 'not a real problem',
    });
    expect(res.statusCode, res.body).toBe(200);
    await reevaluateBranch(h.ctx.db, main?.id ?? '');
    const all = await chatDeliveries();
    expect(all.slice(before).map((d) => [d.event, d.payload.cause])).toEqual([
      ['gate.recovered', 'reevaluation'],
    ]);
  });

  it('a chat webhook never gets the generic events, even if its row lists them', async () => {
    await h.ctx.db
      .update(webhookSubscriptions)
      .set({
        events: ['analysis.completed', 'gate.status_changed', 'gate.failed', 'gate.recovered'],
      })
      .where(eq(webhookSubscriptions.id, slack));
    line = 99; // a finding the earlier false positive does not cover
    const seen = new Set((await h.ctx.db.select().from(webhookDeliveries)).map((d) => d.id));
    await analyse(false);
    await analyse(true);
    const [main] = await h.ctx.db
      .select()
      .from(branches)
      .where(and(eq(branches.projectId, project.id), eq(branches.isMain, true)));
    const [issue] = await h.ctx.db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.projectId, project.id),
          eq(issues.branchId, main?.id ?? ''),
          eq(issues.status, 'open'),
        ),
      );
    await call('POST', `/issues/${issue?.id}/transition`, {
      to: 'false_positive',
      comment: 'not a real problem',
    });
    await reevaluateBranch(h.ctx.db, main?.id ?? '');
    const mine = (await h.ctx.db.select().from(webhookDeliveries)).filter(
      (d) => !seen.has(d.id) && d.subscriptionId === slack,
    );
    expect(mine.map((d) => d.event).sort()).toEqual(['gate.failed', 'gate.recovered']);
  });
});
