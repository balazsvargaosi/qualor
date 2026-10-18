// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProject,
  createUser,
  login,
  organizationId,
  type TestContext,
} from '../../server/test/app';
import { mainBranchId, seedIssue, seedRule } from '../../server/test/issues';
import { callTool } from '../../server/test/mcp';
import { oauthTokens } from '../../server/test/oauth';
import { rbacContext } from '../../server/test/rbac';
import { auditEvents } from '../../server/src/db/schema';

// An agent's status change is attributed to the user, carries the OAuth client, and records the
// MCP request's address and user agent (Phase 6N, ruling R8). `rbacContext` activates audit-log.
describe('MCP audit (Phase 6N, ruling R8)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await rbacContext({
      now: () => new Date('2027-01-01T00:00:00Z'),
      config: { publicUrl: 'https://q.example' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('records the client id on issue.status_changed and the grant', async () => {
    const admin = await login(ctx, 'admin', 'correct horse battery staple');
    const org = await organizationId(ctx, 'default');
    const user = await createUser(ctx, { username: 'agent-owner' });
    await addMember(ctx, org, user.id, 'member');
    const projectId = (await createProject(ctx, admin, { organizationId: org, key: 'shop' })).id;
    const ruleId = await seedRule(ctx.db, { key: 'eslint:no-eval' });
    const issueId = await seedIssue(ctx.db, {
      projectId,
      branchId: await mainBranchId(ctx.db, projectId),
      ruleId,
    });
    const session = await login(ctx, user.username, user.password);
    const { clientId, accessToken } = await oauthTokens(ctx, session, ['mcp:read', 'mcp:write']);

    const r = await callTool(ctx, accessToken, 'qualor_transition_issue', {
      issueId,
      to: 'wont_fix',
      comment: 'Accepted risk',
    });
    expect(r.isError).toBe(false);

    const [changed] = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'issue.status_changed'))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    expect(changed?.details).toMatchObject({ to: 'wont_fix', mcpClientId: clientId });
    expect(changed?.actorUsername).toBe('agent-owner');
    expect(changed?.userAgent).toBe('qualor-mcp (Test agent)');
    expect(changed?.ip).toBeTruthy();

    const grants = await ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'oauth.grant_created'));
    expect(grants.length).toBeGreaterThan(0);
  });
});
