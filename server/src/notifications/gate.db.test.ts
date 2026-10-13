import { eq, sql } from 'drizzle-orm';
import type { Report } from '@qualor/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addMember, createUser } from '../../test/app';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { MAIL_ON, payloadOf, queued, watch } from '../../test/notify';
import { reportWith, sampleReport, type ReportOverrides } from '../../test/reports';
import { analyses, branches } from '../db/schema';
import { AnalysisFailure, type IngestionStage } from '../ingest/process';
import { DEFAULT_STAGES } from '../ingest/stages';
import { notifyDeps } from './deps';
import { notifyGateChange, notifyGateChangeSafely, type GateChange } from './gate';
import { unsubscribeToken } from './unsubscribe';

describe('gate notifications from ingestion (mail E3 N2, N3)', () => {
  let h: IngestHarness;
  let wanda: string;
  let walter: string;
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 9, 13, 8, minute++)).toISOString();
  /** One new issue on a changed line: the built-in gate fails (new_issues > 0). */
  const failing = (p: IngestProject, overrides: ReportOverrides = {}): Report =>
    sampleReport({ projectKey: p.key, analysisDate: at(), ...overrides });
  /** The same change without the issue: the gate passes. */
  const passing = (p: IngestProject, overrides: ReportOverrides = {}): Report =>
    reportWith({ projectKey: p.key, analysisDate: at(), findings: [], ...overrides });
  /** A project wanda watches on its main branch and walter on every branch. */
  const project = async (key: string) => {
    const p = await h.project(key);
    await watch(h.ctx.db, wanda, p.id);
    await watch(h.ctx.db, walter, p.id, { branches: 'all' });
    return p;
  };
  const sent = async (p: IngestProject, kind: string) =>
    (await queued(h.ctx.db, kind)).filter((m) => m.subject.startsWith(`${p.key}:`));
  /** `p`'s main branch going from passed to failed, as ingestion hands it over. */
  const failedOnMain = async (p: IngestProject): Promise<GateChange> => {
    const [main] = await h.ctx.db.select().from(branches).where(eq(branches.projectId, p.id));
    return {
      project: { id: p.id, name: p.key },
      branch: {
        id: main!.id,
        name: 'main',
        kind: 'branch',
        isMain: true,
        mrTitle: null,
        mrTargetBranch: null,
      },
      analysis: { id: 'a', revision: null },
      previous: 'passed',
      next: { status: 'failed', gate: null, conditions: [], ignoredConditions: [], warnings: [] },
      measures: {},
      cause: 'analysis',
    };
  };

  beforeAll(async () => {
    h = await createIngestHarness({ config: MAIL_ON, notify: true });
    for (const name of ['wanda', 'walter']) {
      const user = await createUser(h.ctx, { username: name, email: `${name}@example.com` });
      await addMember(h.ctx, h.organizationId, user.id, 'viewer');
      if (name === 'wanda') wanda = user.id;
      else walter = user.id;
    }
  });
  afterAll(async () => {
    await h.close();
  });

  it('mails once when the main gate starts failing, not while it keeps failing, and once when it passes again', async () => {
    const p = await project('notify/main');
    await p.ingestOk(failing(p));
    expect((await sent(p, 'notify.gate-failed')).map((m) => [m.toAddress, m.subject])).toEqual([
      ['walter@example.com', 'notify/main: quality gate failed on main'],
      ['wanda@example.com', 'notify/main: quality gate failed on main'],
    ]);
    await p.ingestOk(failing(p));
    expect(await sent(p, 'notify.gate-failed')).toHaveLength(2);
    await p.ingestOk(passing(p));
    expect((await sent(p, 'notify.gate-recovered')).map((m) => m.toAddress)).toEqual([
      'walter@example.com',
      'wanda@example.com',
    ]);
    await p.ingestOk(passing(p));
    expect(await sent(p, 'notify.gate-recovered')).toHaveLength(2);
  });

  it('mails other branches and merge requests only to "All branches" watchers', async () => {
    const p = await project('notify/branches');
    await p.ingestOk(failing(p, { branch: 'feature/x' }));
    await p.ingestOk(
      failing(p, {
        branch: 'feature/x',
        mergeRequest: { id: '7', sourceBranch: 'feature/x', targetBranch: 'main' },
      }),
    );
    const rows = await sent(p, 'notify.gate-failed');
    expect(rows.map((m) => [m.toAddress, m.subject])).toEqual([
      ['walter@example.com', 'notify/branches: quality gate failed on feature/x'],
      ['walter@example.com', 'notify/branches: quality gate failed on !7'],
    ]);
    expect(payloadOf(rows[1]!, h.ctx.config.secretKey).text).toContain('targets main');
  });

  it('carries the RFC 8058 headers and a stop link for that recipient and project', async () => {
    const p = await project('notify/headers');
    await p.ingestOk(failing(p));
    const row = (await sent(p, 'notify.gate-failed')).find(
      (m) => m.toAddress === 'wanda@example.com',
    )!;
    expect(row.userId).toBe(wanda);
    const payload = payloadOf(row, h.ctx.config.secretKey);
    const token = unsubscribeToken(h.ctx.config.secretKey, wanda, p.id);
    expect(payload.headers).toEqual({
      'List-Unsubscribe': `<https://qualor.example.com/api/v0/notifications/unsubscribe?t=${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(payload.html).toContain(`https://qualor.example.com/unsubscribe#t=${token}`);
  });

  it('does not let a watcher whose address mail refuses stop mail to the watchers after', async () => {
    const p = await project('notify/bad-address');
    // Sorts before walter and wanda, and queueMail skips it (no dot in the domain).
    const aaron = await createUser(h.ctx, { username: 'aaron', email: 'aaron@localhost' });
    await addMember(h.ctx, h.organizationId, aaron.id, 'viewer');
    await watch(h.ctx.db, aaron.id, p.id);
    await p.ingestOk(failing(p));
    expect((await sent(p, 'notify.gate-failed')).map((m) => m.toAddress)).toEqual([
      'walter@example.com',
      'wanda@example.com',
    ]);
  });

  it('queues nothing while email is not configured', async () => {
    const p = await project('notify/mail-off');
    await p.ingestOk(passing(p));
    const change = await failedOnMain(p);
    const count = await h.ctx.db.transaction((tx) =>
      notifyGateChange(tx, notifyDeps({ ...h.ctx.config, smtp: null }), change),
    );
    expect(count).toBe(0);
    expect(await sent(p, 'notify.gate-failed')).toEqual([]);
  });

  it('queues nothing when the ingestion rolls back after the notification stage', async () => {
    const p = await project('notify/rollback');
    const reject: IngestionStage = {
      name: 'reject',
      run: async () => {
        throw new AnalysisFailure('TEST_REJECTED', 'rejected after the notification stage');
      },
    };
    const id = await p.ingest(failing(p), [...DEFAULT_STAGES, reject]);
    const [row] = await h.ctx.db.select().from(analyses).where(eq(analyses.id, id));
    expect(row?.status).toBe('failed');
    expect(await sent(p, 'notify.gate-failed')).toEqual([]);
  });

  it('keeps the transaction usable when queueing fails: only its savepoint rolls back', async () => {
    const warn = vi.fn();
    const rows = await h.ctx.db.transaction(async (tx) => {
      await notifyGateChangeSafely(
        tx,
        notifyDeps(h.ctx.config),
        {
          project: { id: 'not-a-uuid', name: 'x' },
          branch: {
            id: 'b',
            name: 'main',
            kind: 'branch',
            isMain: true,
            mrTitle: null,
            mrTargetBranch: null,
          },
          analysis: { id: 'a', revision: null },
          previous: null,
          next: {
            status: 'failed',
            gate: null,
            conditions: [],
            ignoredConditions: [],
            warnings: [],
          },
          measures: {},
          cause: 'analysis',
        },
        { warn },
      );
      return (await tx.execute<{ one: number }>(sql`SELECT 1 AS one`)).rows;
    });
    expect(rows).toEqual([{ one: 1 }]);
    // E1's webhook-alert rule: the error's class only, never its message (a database error's
    // message carries the query's parameters, addresses among them).
    expect(warn).toHaveBeenCalledWith(
      { analysisId: 'a', errorClass: 'DrizzleQueryError' },
      'project notifications could not be queued',
    );
  });
});
