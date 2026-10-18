import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../../test/ingest';
import { finding, reportWith } from '../../../test/reports';
import { branches, issues, webhookDeliveries } from '../../db/schema';
import { reevaluateBranch } from '../../gates/reevaluate';

describe('chat gate events from ingestion and re-evaluation (6G spec §4)', () => {
  let h: IngestHarness;
  let project: IngestProject;
  let slack: string;
  let generic: string;
  let day = 1;

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
        findings: failing ? [finding({ line: 3 })] : [],
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
        payload: d.payload as { cause: string; branch: { name: string } },
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
    expect((await chatDeliveries()).map((d) => d.event)).toEqual(['gate.failed', 'gate.recovered']);
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

  it('never for another branch or a merge request', async () => {
    const before = (await chatDeliveries()).length;
    await analyse(true, { branch: 'feature/x' });
    await analyse(true, {
      branch: null,
      mergeRequest: { id: '7', sourceBranch: 'feature/x', targetBranch: 'main' },
    });
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
});
