import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUIET_AUDIT_LOG } from '../../test/audit-log';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { seedIssue, seedRule } from '../../test/issues';
import { createAuditRecorder, SYSTEM_ACTOR } from '../audit/recorder';
import { first } from '../db/rows';
import {
  auditEvents,
  branches,
  issueChanges,
  issues,
  jobs,
  organizations,
  projects,
} from '../db/schema';
import { GATE_QUEUE } from '../gates/reevaluate';
import { transitionAsSystem } from './transitions';

/*
 * A status change the system makes (6I-4): a person replied in Qualor's thread of an AI finding,
 * and the reply decided it. No user is named or checked: the changelog says who replied, and the
 * audit event names the system.
 */

const WONT_FIX = "Won't fix after `jane` replied in the merge request.";
const FALSE_POSITIVE = 'False positive after `jane` replied in the merge request.';

describe('a status change of the system (6I-4)', () => {
  let t: TestDatabase;
  let organizationId: string;
  let projectId: string;
  let branchId: string;
  let ruleId: string;
  const recorder = createAuditRecorder({ log: QUIET_AUDIT_LOG, isActive: () => true });
  const audit = { recorder, context: SYSTEM_ACTOR };

  /** An issue of the merge request in new code, on a line: one a thread may be about. */
  const issue = (status: 'open' | 'resolved' | 'wont_fix' | 'false_positive' | 'closed' = 'open') =>
    seedIssue(t.db, {
      projectId,
      branchId,
      ruleId,
      status,
      inNewCode: true,
      path: 'src/cart.ts',
      startLine: 3,
    });
  const stored = async (id: string) =>
    first(await t.db.select().from(issues).where(eq(issues.id, id)));
  const changesOf = (id: string) =>
    t.db.select().from(issueChanges).where(eq(issueChanges.issueId, id)).orderBy(issueChanges.id);
  const eventsOf = (id: string) =>
    t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, id))
      .orderBy(asc(auditEvents.seq));
  const reevaluations = () =>
    t.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.queue, GATE_QUEUE), sql`${jobs.payload} ->> 'branchId' = ${branchId}`));
  const change = (
    id: string,
    to: 'wont_fix' | 'false_positive',
    comment: string,
    recorded: boolean = true,
  ) =>
    t.db.transaction((tx) => transitionAsSystem(tx, id, to, comment, recorded ? audit : undefined));

  beforeAll(async () => {
    t = await createTestDatabase();
    organizationId = first(
      await t.db.insert(organizations).values({ key: 'replies', name: 'Replies' }).returning(),
    ).id;
    projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'replies/api', name: 'Api' })
        .returning(),
    ).id;
    branchId = first(
      await t.db
        .insert(branches)
        .values({ projectId, kind: 'merge_request', name: '7' })
        .returning(),
    ).id;
    ruleId = await seedRule(t.db, { key: 'ai:logic', engineId: 'ai' });
  });
  afterAll(async () => {
    await t.close();
  });

  it("marks an open issue as the system: nobody resolved it, the changelog says why, the gate is evaluated again and the system's event is recorded", async () => {
    await t.db.delete(jobs);
    const id = await issue();
    expect(await change(id, 'wont_fix', WONT_FIX)).toBe(true);
    const after = await stored(id);
    expect(after).toMatchObject({ status: 'wont_fix', resolvedBy: null });
    expect(after.resolvedAt).toBeInstanceOf(Date);
    // One changelog row, of no user, with the comment that names who replied.
    expect(await changesOf(id)).toMatchObject([
      {
        userId: null,
        analysisId: null,
        field: 'status',
        oldValue: 'open',
        newValue: 'wont_fix',
        comment: WONT_FIX,
      },
    ]);
    // The branch's gate is evaluated again, and the merge request decorated (a thread may follow).
    expect(await reevaluations()).toEqual([{ payload: { branchId, redecorate: true } }]);
    // One event, the system's, in the shape a person's transition has.
    expect(await eventsOf(id)).toMatchObject([
      {
        action: 'issue.status_changed',
        outcome: 'success',
        actorType: 'system',
        actorUserId: null,
        actorUsername: null,
        organizationId,
        projectId,
        targetType: 'issue',
        targetId: id,
        details: {
          from: 'open',
          to: 'wont_fix',
          bulk: false,
          mirrored: false,
          commented: true,
          suggestionId: null,
        },
      },
    ]);
  });

  it('marks a false positive alike, and records no event without a recorder', async () => {
    const id = await issue();
    expect(await change(id, 'false_positive', FALSE_POSITIVE, false)).toBe(true);
    expect(await stored(id)).toMatchObject({ status: 'false_positive', resolvedBy: null });
    expect((await changesOf(id)).map((row) => [row.oldValue, row.newValue, row.comment])).toEqual([
      ['open', 'false_positive', FALSE_POSITIVE],
    ]);
    expect(await eventsOf(id)).toEqual([]);
  });

  it('changes nothing but an open issue, and writes nothing for one it leaves', async () => {
    for (const status of ['resolved', 'wont_fix', 'false_positive', 'closed'] as const) {
      await t.db.delete(jobs);
      const id = await issue(status);
      const before = await stored(id);
      expect(await change(id, 'wont_fix', WONT_FIX), status).toBe(false);
      expect(await stored(id), status).toEqual(before);
      expect(await changesOf(id), status).toEqual([]);
      expect(await eventsOf(id), status).toEqual([]);
      expect(await reevaluations(), status).toEqual([]);
    }
  });

  it('changes an issue once, however often it is asked, and two at once wait on its lock', async () => {
    const again = await issue();
    expect(await change(again, 'wont_fix', WONT_FIX)).toBe(true);
    expect(await change(again, 'wont_fix', WONT_FIX)).toBe(false);
    expect(await change(again, 'false_positive', FALSE_POSITIVE)).toBe(false);
    expect(await changesOf(again)).toHaveLength(1);
    expect(await eventsOf(again)).toHaveLength(1);

    const raced = await issue();
    const results = await Promise.all([
      change(raced, 'wont_fix', WONT_FIX),
      change(raced, 'false_positive', FALSE_POSITIVE),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [only] = await changesOf(raced);
    expect((await stored(raced)).status).toBe(only?.newValue);
    expect(await changesOf(raced)).toHaveLength(1);
    expect(await eventsOf(raced)).toHaveLength(1);
  });
});
