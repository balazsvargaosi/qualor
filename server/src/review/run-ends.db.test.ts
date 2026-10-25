import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/db';
import { first } from '../db/rows';
import { analyses, branches, organizations, projects, reviewRuns } from '../db/schema';
import { endRun, writeRunSpend, type RunSpend } from './run-ends';

const SPENT: RunSpend = {
  providerHost: 'llm.test',
  model: 'fake-model',
  modelCalls: 2,
  toolCalls: 1,
  inputTokens: 2_000,
  outputTokens: 200,
  costMicroUsd: 42,
};
const FAILED = { status: 'failed', reason: 'internal' } as const;

describe('ending a run for the job that started it (R15)', () => {
  let t: TestDatabase;
  let projectId: string;
  let counter = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    const organizationId = first(
      await t.db.insert(organizations).values({ key: 'ends', name: 'Ends' }).returning(),
    ).id;
    projectId = first(
      await t.db
        .insert(projects)
        .values({ organizationId, key: 'ends/api', name: 'api' })
        .returning(),
    ).id;
  });
  afterAll(async () => {
    await t.close();
  });

  /** A run that is running, started at `startedAt`. */
  async function runningRun(startedAt: Date | null = new Date()) {
    counter += 1;
    const branchId = first(
      await t.db
        .insert(branches)
        .values({ projectId, kind: 'merge_request', name: `mr-${counter}` })
        .returning(),
    ).id;
    const analysisId = first(
      await t.db.insert(analyses).values({ projectId, branchId }).returning(),
    ).id;
    return first(
      await t.db
        .insert(reviewRuns)
        .values({
          projectId,
          branchId,
          analysisId,
          status: 'running',
          phase: 'judge',
          startedAt,
          deadlineAt: new Date(),
        })
        .returning(),
    );
  }
  const runRow = async (id: string) =>
    first(await t.db.select().from(reviewRuns).where(eq(reviewRuns.id, id)));
  /** The run ended and started again: the row holds the start of another job. */
  const startedAgain = async (id: string, startedAt: Date) => {
    await t.db.update(reviewRuns).set({ startedAt }).where(eq(reviewRuns.id, id));
    return startedAt;
  };

  describe('endRun', () => {
    it('ends a running run, whoever started it, when no start is named: the sweep knows no job', async () => {
      const run = await runningRun();
      expect(await endRun(t.db, run, ['running'], FAILED)).toBe(true);
      expect(await runRow(run.id)).toMatchObject({
        status: 'failed',
        reason: 'internal',
        phase: null,
        finishedAt: expect.any(Date),
      });
    });

    it('ends the run the named start made, with what it spent', async () => {
      const run = await runningRun();
      const ended = await endRun(t.db, run, ['running'], FAILED, {
        spend: SPENT,
        startedAt: run.startedAt,
      });
      expect(ended).toBe(true);
      expect(await runRow(run.id)).toMatchObject({ status: 'failed', ...SPENT });
    });

    it('ends nothing of a run that was started again, and writes nothing into it', async () => {
      const run = await runningRun();
      const again = await startedAgain(run.id, new Date((run.startedAt?.getTime() ?? 0) + 60_000));
      const before = await runRow(run.id);
      const ended = await endRun(t.db, run, ['running'], FAILED, {
        spend: SPENT,
        diffDigest: 'f'.repeat(64),
        startedAt: run.startedAt,
      });
      expect(ended).toBe(false);
      expect(await runRow(run.id)).toEqual(before);
      expect(before).toMatchObject({ status: 'running', phase: 'judge', startedAt: again });
    });

    it('ends nothing for a start that is none: a run no job started is nobody’s', async () => {
      const run = await runningRun(null);
      expect(await endRun(t.db, run, ['running'], FAILED, { startedAt: null })).toBe(false);
      expect(await runRow(run.id)).toMatchObject({ status: 'running', startedAt: null });
    });

    it('takes a start with microseconds for the Date its job read, which has milliseconds', async () => {
      const made = await runningRun();
      await t.db.execute(
        sql`UPDATE review_runs SET started_at = '2026-10-25 12:00:00.123456+00' WHERE id = ${made.id}`,
      );
      const run = await runRow(made.id);
      expect(run.startedAt?.toISOString()).toBe('2026-10-25T12:00:00.123Z');
      expect(await endRun(t.db, run, ['running'], FAILED, { startedAt: run.startedAt })).toBe(true);
    });

    it('still ends only a run whose status is one of those asked', async () => {
      const run = await runningRun();
      expect(await endRun(t.db, run, ['waiting'], FAILED, { startedAt: run.startedAt })).toBe(
        false,
      );
      expect(await runRow(run.id)).toMatchObject({ status: 'running' });
    });
  });

  describe('writeRunSpend', () => {
    it('writes what the job spent on the run its start made', async () => {
      const run = await runningRun();
      await writeRunSpend(t.db, run.id, SPENT, run.startedAt);
      expect(await runRow(run.id)).toMatchObject({ status: 'running', ...SPENT });
    });

    it('writes nothing on a run that was started again, or on one no job started', async () => {
      const run = await runningRun();
      await startedAgain(run.id, new Date((run.startedAt?.getTime() ?? 0) + 60_000));
      const before = await runRow(run.id);
      await writeRunSpend(t.db, run.id, SPENT, run.startedAt);
      expect(await runRow(run.id)).toEqual(before);

      const unstarted = await runningRun(null);
      await writeRunSpend(t.db, unstarted.id, SPENT, null);
      expect(await runRow(unstarted.id)).toMatchObject({ modelCalls: 0, providerHost: null });
    });

    it('takes a start with microseconds for the Date its job read, which has milliseconds', async () => {
      const made = await runningRun();
      await t.db.execute(
        sql`UPDATE review_runs SET started_at = '2026-10-25 12:00:00.123456+00' WHERE id = ${made.id}`,
      );
      const run = await runRow(made.id);
      await writeRunSpend(t.db, run.id, SPENT, run.startedAt);
      expect(await runRow(run.id)).toMatchObject({ modelCalls: 2 });
    });
  });
});
