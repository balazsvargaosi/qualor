import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createUser } from '../../test/app';
import { createIngestHarness, type IngestHarness } from '../../test/ingest';
import { MAIL_ON, payloadOf, queued, watch } from '../../test/notify';
import { sampleReport } from '../../test/reports';
import { issues } from '../db/schema';
import { gateHandlers } from '../gates/reevaluate';
import { runUntilIdle } from '../queue/worker';
import { notifyDeps } from './deps';

describe('gate notifications from re-evaluations (mail E3, scm.md §7)', () => {
  let h: IngestHarness;
  let wanda: string;

  const runGates = () =>
    runUntilIdle(
      h.ctx.db,
      gateHandlers({ db: h.ctx.db, notify: notifyDeps(h.ctx.config) }),
      h.ctx.app.log,
    );
  const transition = (ids: string[], to: string, comment?: string) =>
    h.ctx.app.inject({
      method: 'POST',
      url: '/api/v0/issues/bulk-transition',
      headers: h.orgAdmin.headers,
      payload: { ids, to, ...(comment ? { comment } : {}) },
    });
  const sent = async (kind: string) =>
    (await queued(h.ctx.db, kind)).filter((m) => m.subject.startsWith('reeval/main:'));
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  beforeAll(async () => {
    h = await createIngestHarness({ config: MAIL_ON, notify: true });
    const user = await createUser(h.ctx, { username: 'wanda', email: 'wanda@example.com' });
    await addMember(h.ctx, h.organizationId, user.id, 'viewer');
    wanda = user.id;
  });
  afterAll(async () => {
    await h.close();
  });

  it('mails "passes again" when a transition clears the gate, and "failed" when it fails again', async () => {
    const p = await h.project('reeval/main');
    await watch(h.ctx.db, wanda, p.id);
    await p.ingestOk(sampleReport({ projectKey: p.key }));
    expect(await sent('notify.gate-failed')).toHaveLength(1);

    const open = await h.ctx.db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, p.id), eq(issues.status, 'open')));
    const ids = open.map((i) => i.id);
    const cleared = await transition(ids, 'false_positive', 'not a problem here');
    expect(cleared.statusCode, cleared.body).toBeLessThan(300);
    await runGates();
    const recovered = await sent('notify.gate-recovered');
    expect(recovered).toHaveLength(1);
    expect(flat(payloadOf(recovered[0]!, h.ctx.config.secretKey).text)).toContain(
      'after issues were changed',
    );

    const reopened = await transition(ids, 'open');
    expect(reopened.statusCode, reopened.body).toBeLessThan(300);
    await runGates();
    const failed = await sent('notify.gate-failed');
    expect(failed).toHaveLength(2);
    expect(flat(payloadOf(failed[1]!, h.ctx.config.secretKey).text)).toContain(
      'after issues were changed',
    );
  });
});
