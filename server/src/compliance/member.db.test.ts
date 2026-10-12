import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  addMember,
  createProject,
  createTestContext,
  createUser,
  login,
  type TestContext,
} from '../../test/app';
import { grantProject } from '../../test/rbac';
import { requireOrganizationMember } from '../auth/access';
import type { UserPrincipal } from '../auth/principal';
import { users } from '../db/schema';

describe('requireOrganizationMember (4E-1 §3)', () => {
  let ctx: TestContext;
  let org: string;
  const principalOf = async (username: string): Promise<UserPrincipal> => {
    const [user] = await ctx.db.select().from(users).where(eq(users.username, username));
    return { kind: 'session', user: user!, sessionSecret: 'unused' };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    const admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/organizations',
      headers: admin.headers,
      payload: { key: 'acme', name: 'Acme' },
    });
    org = (res.json() as { id: string }).id;
    const project = await createProject(ctx, admin, { organizationId: org, key: 'alpha' });
    const viewer = await createUser(ctx, { username: 'org-viewer' });
    await addMember(ctx, org, viewer.id, 'viewer');
    const granted = await createUser(ctx, { username: 'granted' });
    await grantProject(ctx, project.id, granted.id, 'viewer');
    await createUser(ctx, { username: 'outsider' });
  });
  afterAll(() => ctx.close());

  it('lets any organisation-level role through', async () => {
    const a = await requireOrganizationMember({ db: ctx.db }, await principalOf('org-viewer'), org);
    expect(a.role).toBe('viewer');
  });
  it('answers 403 to a user with project grants only', async () => {
    await expect(
      requireOrganizationMember({ db: ctx.db }, await principalOf('granted'), org),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
  it('answers 404 to an outsider', async () => {
    await expect(
      requireOrganizationMember({ db: ctx.db }, await principalOf('outsider'), org),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('lets an instance admin through', async () => {
    await expect(
      requireOrganizationMember({ db: ctx.db }, await principalOf('admin'), org),
    ).resolves.toBeDefined();
  });
});
