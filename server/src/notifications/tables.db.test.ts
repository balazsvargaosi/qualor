import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProject,
  createTestContext,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { expectPgError } from '../../test/db';
import { notificationPreferences, projects, projectWatches, users } from '../db/schema';

describe('project_watches and notification_preferences (0010_notifications)', () => {
  let ctx: TestContext;
  let org: string;
  let session: Session;

  beforeAll(async () => {
    ctx = await createTestContext();
    org = await organizationId(ctx, 'default');
    const owner = await createUser(ctx, { username: 'tables-owner' });
    await addMember(ctx, org, owner.id, 'admin');
    session = await login(ctx, owner.username, owner.password);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('defaults a watch to the main branch and every event, once per user and project, and refuses another scope', async () => {
    const project = await createProject(ctx, session, {
      organizationId: org,
      key: 'tables/defaults',
    });
    const user = await createUser(ctx, { username: 'tables-watcher' });
    await ctx.db.insert(projectWatches).values({ userId: user.id, projectId: project.id });
    const [row] = await ctx.db
      .select()
      .from(projectWatches)
      .where(eq(projectWatches.userId, user.id));
    expect(row).toMatchObject({
      branches: 'main',
      gateFailed: true,
      gateRecovered: true,
      analysisFailed: true,
    });
    await expectPgError(
      ctx.db.execute(sql`UPDATE project_watches SET branches = 'some' WHERE user_id = ${user.id}`),
      '23514',
    );
    await expectPgError(
      ctx.db.insert(projectWatches).values({ userId: user.id, projectId: project.id }),
      '23505',
    );
  });

  it('defaults preferences to on, and both tables go with their user or their project', async () => {
    const project = await createProject(ctx, session, {
      organizationId: org,
      key: 'tables/cascade',
    });
    const leaving = await createUser(ctx, { username: 'tables-leaving' });
    const staying = await createUser(ctx, { username: 'tables-staying' });
    await ctx.db.insert(notificationPreferences).values({ userId: leaving.id });
    const [prefs] = await ctx.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, leaving.id));
    expect(prefs).toMatchObject({ email: true, orgWebhookFailures: true });
    await ctx.db.insert(projectWatches).values([
      { userId: leaving.id, projectId: project.id },
      { userId: staying.id, projectId: project.id },
    ]);
    await ctx.db.delete(users).where(eq(users.id, leaving.id));
    expect(
      await ctx.db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, leaving.id)),
    ).toEqual([]);
    const left = await ctx.db
      .select()
      .from(projectWatches)
      .where(eq(projectWatches.projectId, project.id));
    expect(left.map((w) => w.userId)).toEqual([staying.id]);
    await ctx.db.delete(projects).where(eq(projects.id, project.id));
    expect(
      await ctx.db.select().from(projectWatches).where(eq(projectWatches.userId, staying.id)),
    ).toEqual([]);
  });
});
