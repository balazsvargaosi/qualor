import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createTestContext,
  createUser,
  organizationId,
  type TestContext,
} from '../../test/app';
import { organizations, projectMemberships, projects, users } from '../db/schema';
import { accessOf } from './access';
import { projectVisibleTo, visibleProjectsCondition } from './facts';

describe('projectVisibleTo (mail E3 N4) sees what visibleProjectsCondition sees', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('for an instance admin, a member, grant-only users, a mixed user and an outsider', async () => {
    const orgA = await organizationId(ctx, 'default');
    const [orgB] = await ctx.db
      .insert(organizations)
      .values({ key: 'vis-b', name: 'B' })
      .returning();
    const created = await ctx.db
      .insert(projects)
      .values([
        { organizationId: orgA, key: 'vis/a', name: 'A' },
        { organizationId: orgB!.id, key: 'vis/b', name: 'B' },
        { organizationId: orgB!.id, key: 'vis/c', name: 'C' },
      ])
      .returning();
    const all = created.map((p) => p.id);
    const [pa, pb, pc] = created;
    const inst = await createUser(ctx, { username: 'vis-inst', isInstanceAdmin: true });
    const member = await createUser(ctx, { username: 'vis-member' });
    await addMember(ctx, orgA, member.id, 'viewer');
    const granted = await createUser(ctx, { username: 'vis-granted' });
    await ctx.db
      .insert(projectMemberships)
      .values({ projectId: pb!.id, userId: granted.id, role: 'viewer' });
    const projectAdmin = await createUser(ctx, { username: 'vis-padmin' });
    await ctx.db
      .insert(projectMemberships)
      .values({ projectId: pc!.id, userId: projectAdmin.id, role: 'project_admin' });
    // A role in one organisation and a grant in the other.
    const mixed = await createUser(ctx, { username: 'vis-mixed' });
    await addMember(ctx, orgA, mixed.id, 'member');
    await ctx.db
      .insert(projectMemberships)
      .values({ projectId: pc!.id, userId: mixed.id, role: 'member' });
    const outsider = await createUser(ctx, { username: 'vis-outsider' });

    const expected: Record<string, string[]> = {
      'vis-inst': [...all].sort(),
      'vis-member': [pa!.id],
      'vis-granted': [pb!.id],
      'vis-padmin': [pc!.id],
      'vis-mixed': [pa!.id, pc!.id].sort(),
      'vis-outsider': [],
    };
    for (const u of [inst, member, granted, projectAdmin, mixed, outsider]) {
      const [row] = await ctx.db.select().from(users).where(eq(users.id, u.id));
      const listed = await ctx.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(inArray(projects.id, all), visibleProjectsCondition(accessOf({ db: ctx.db }), row!)),
        );
      const correlated = await ctx.db
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(users, eq(users.id, u.id))
        .where(and(inArray(projects.id, all), projectVisibleTo(users, projects)));
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
      expect(ids(correlated), u.username).toEqual(ids(listed));
      expect(ids(correlated), u.username).toEqual(expected[u.username]);
    }
  });
});
