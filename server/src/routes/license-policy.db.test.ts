import { LICENSE_GROUPS, type LicensePolicy } from '@qualor/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  ADMIN_PASSWORD,
  bearer,
  createProject,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { AFTER_GRACE, grantProject, rbacContext } from '../../test/rbac';
import { auditEvents, instanceSettings } from '../db/schema';
import {
  LICENSE_POLICY_SETTINGS_KEY,
  readLicensePolicies,
  storedPolicyFor,
  writeLicensePolicy,
} from '../licenses/settings';

const NOW = new Date('2027-01-01T00:00:00Z');

type Event = typeof auditEvents.$inferSelect;

const POLICY: LicensePolicy = {
  mode: 'denylist',
  forbiddenGroups: ['strong-copyleft'],
  forbidden: ['SSPL-1.0'],
  allowed: ['LGPL-2.1-only'],
  warnUnknown: false,
};

/** 6M §5: the organisation licence policy, `GET`/`PUT /organizations/{id}/license-policy`. */
describe('the organisation licence policy routes (6M §5)', () => {
  let ctx: TestContext;
  /** What `limits.licenses.policy` answers (the plugin's seam, license-policy). */
  let licensed = true;
  let now = NOW;
  let admin: Session;
  let orgAdmin: Session;
  let projectAdmin: Session;
  let member: Session;
  let viewer: Session;
  let granted: Session;
  let outsider: Session;
  let otherAdmin: Session;
  let org: string;
  let otherOrg: string;
  let writeToken: string;
  let adminToken: string;

  type Caller = Session | Record<string, string>;
  const headersOf = (caller: Caller): Record<string, string> =>
    typeof (caller as Session).csrf === 'string'
      ? (caller as Session).headers
      : (caller as Record<string, string>);
  const call = (method: 'GET' | 'PUT', url: string, caller: Caller | null, payload?: object) =>
    ctx.app.inject({
      method,
      url: `/api/v0${url}`,
      headers: caller === null ? {} : headersOf(caller),
      ...(payload === undefined ? {} : { payload }),
    });
  const getPolicy = (caller: Caller | null = orgAdmin, id = org) =>
    call('GET', `/organizations/${id}/license-policy`, caller);
  const putPolicy = (policy: unknown, caller: Caller = orgAdmin, id = org) =>
    call('PUT', `/organizations/${id}/license-policy`, caller, { policy });
  const stored = async (id = org): Promise<LicensePolicy | null> =>
    (await readLicensePolicies(ctx.db)).organizations[id] ?? null;
  /** The licence policy row as it is stored, and a way to store one bypassing the write. */
  const storedRow = async (): Promise<unknown> =>
    (
      await ctx.db
        .select({ value: instanceSettings.value })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, LICENSE_POLICY_SETTINGS_KEY))
    )[0]?.value;
  const storeRow = (value: unknown) =>
    ctx.db
      .insert(instanceSettings)
      .values({ key: LICENSE_POLICY_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value } });
  const events = (): Promise<Event[]> =>
    ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'organization.license_policy_changed'))
      .orderBy(asc(auditEvents.seq));
  const tokenOf = async (scopes: string[]): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/tokens',
      headers: orgAdmin.headers,
      payload: { name: 'ops', scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { token: string }).token;
  };

  beforeAll(async () => {
    ctx = await rbacContext({
      now: () => now,
      edition: (edition) => ({
        ...edition,
        limits: () => ({ ...edition.limits(), licenses: { policy: licensed } }),
      }),
    });
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    org = await organizationId(ctx, 'default');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/organizations',
      headers: admin.headers,
      payload: { key: 'lp-other', name: 'Other' },
    });
    expect(created.statusCode, created.body).toBe(201);
    otherOrg = (created.json() as { id: string }).id;
    const session = async (
      name: string,
      role?: 'admin' | 'project_admin' | 'member' | 'viewer',
      organization = org,
    ) => {
      const u = await createUser(ctx, { username: name });
      if (role) await addMember(ctx, organization, u.id, role);
      return { user: u, session: await login(ctx, u.username, u.password) };
    };
    orgAdmin = (await session('lp-admin', 'admin')).session;
    projectAdmin = (await session('lp-project-admin', 'project_admin')).session;
    member = (await session('lp-member', 'member')).session;
    viewer = (await session('lp-viewer', 'viewer')).session;
    outsider = (await session('lp-outsider')).session;
    otherAdmin = (await session('lp-other-admin', 'admin', otherOrg)).session;
    const grantee = await session('lp-granted');
    granted = grantee.session;
    const project = await createProject(ctx, admin, { organizationId: org, key: 'lp/one' });
    await grantProject(ctx, project.id, grantee.user.id, 'project_admin');
    writeToken = await tokenOf(['write']);
    adminToken = await tokenOf(['admin']);
  });
  afterAll(async () => ctx.close());
  beforeEach(async () => {
    licensed = true;
    now = NOW;
    await ctx.db
      .delete(instanceSettings)
      .where(eq(instanceSettings.key, LICENSE_POLICY_SETTINGS_KEY));
  });

  describe('GET', () => {
    it('answers no policy, the groups and the SPDX ids to anyone with org.read', async () => {
      for (const caller of [orgAdmin, admin, projectAdmin, member, viewer, granted]) {
        const res = await getPolicy(caller);
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({ available: true, policy: null });
        expect(body.groups).toEqual(LICENSE_GROUPS);
      }
      const { spdxIds } = (await getPolicy()).json() as {
        spdxIds: { licenses: string[]; exceptions: string[] };
      };
      expect(spdxIds.licenses).toContain('MIT');
      expect(spdxIds.licenses).toContain('GPL-3.0-only');
      expect(spdxIds.licenses).toContain('Commons-Clause');
      // Only canonical spellings: a deprecated id is offered in its current form.
      expect(spdxIds.licenses).not.toContain('GPL-3.0');
      expect(spdxIds.licenses).not.toContain('GPL-2.0+');
      expect(spdxIds.exceptions).toContain('Classpath-exception-2.0');
      expect(spdxIds.exceptions).not.toContain('MIT');
      expect(spdxIds.licenses.length).toBeGreaterThan(500);
      // A read-scoped token reads it.
      expect((await getPolicy(bearer(writeToken))).statusCode).toBe(200);
    });

    it('answers 404 outside the organisation and 401 without a session', async () => {
      expect((await getPolicy(outsider)).statusCode).toBe(404);
      expect((await getPolicy(orgAdmin, '00000000-0000-7000-8000-00000000dead')).statusCode).toBe(
        404,
      );
      expect((await getPolicy(null)).statusCode).toBe(401);
    });
  });

  describe('PUT', () => {
    it('lets an organisation admin set the policy, canonicalised, sorted and deduped', async () => {
      const res = await putPolicy({
        mode: 'denylist',
        forbiddenGroups: ['strong-copyleft', 'network-copyleft', 'strong-copyleft'],
        forbidden: ['gpl-3.0', 'SSPL-1.0', 'GPL-3.0-only', ' agpl-3.0+ '],
        allowed: ['lgpl-2.1', 'gpl-2.0-with-classpath-exception'],
        warnUnknown: true,
      });
      expect(res.statusCode, res.body).toBe(200);
      const expected: LicensePolicy = {
        mode: 'denylist',
        forbiddenGroups: ['network-copyleft', 'strong-copyleft'],
        forbidden: ['AGPL-3.0-or-later', 'GPL-3.0-only', 'SSPL-1.0'],
        allowed: ['GPL-2.0-only WITH Classpath-exception-2.0', 'LGPL-2.1-only'],
        warnUnknown: true,
      };
      expect(res.json()).toEqual({ available: true, policy: expected });
      expect(await stored()).toEqual(expected);
      expect((await getPolicy(viewer)).json()).toMatchObject({ available: true, policy: expected });
    });

    it('lets an instance admin and an admin-scoped token set it', async () => {
      expect((await putPolicy(POLICY, admin)).statusCode).toBe(200);
      const res = await putPolicy({ ...POLICY, warnUnknown: true }, bearer(adminToken));
      expect(res.statusCode, res.body).toBe(200);
      expect(await stored()).toEqual({ ...POLICY, warnUnknown: true });
    });

    it('refuses a maintainer, a viewer, a project admin and a write-scoped token (403)', async () => {
      for (const caller of [projectAdmin, member, viewer, granted]) {
        const res = await putPolicy(POLICY, caller);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      const scoped = await putPolicy(POLICY, bearer(writeToken));
      expect(scoped.statusCode).toBe(403);
      expect(scoped.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      expect((await putPolicy(POLICY, outsider)).statusCode).toBe(404);
      expect(await stored()).toBeNull();
    });

    it("keeps an organisation admin out of another organisation's policy (404)", async () => {
      expect((await putPolicy(POLICY, otherAdmin, otherOrg)).statusCode).toBe(200);
      // The admin of `default` can neither read nor change `lp-other`'s policy, and the other
      // way round.
      expect((await getPolicy(orgAdmin, otherOrg)).statusCode).toBe(404);
      expect((await putPolicy(null, orgAdmin, otherOrg)).statusCode).toBe(404);
      expect((await getPolicy(otherAdmin, org)).statusCode).toBe(404);
      expect((await putPolicy(POLICY, otherAdmin, org)).statusCode).toBe(404);
      expect(await stored(otherOrg)).toEqual(POLICY);
      expect(await stored(org)).toBeNull();
      expect((await getPolicy(otherAdmin, otherOrg)).json()).toMatchObject({ policy: POLICY });
      expect((await getPolicy(orgAdmin)).json()).toMatchObject({ policy: null });
    });

    it('answers 403 FEATURE_NOT_LICENSED without the seam, and keeps the stored policy', async () => {
      expect((await putPolicy(POLICY)).statusCode).toBe(200);
      licensed = false;
      for (const policy of [{ ...POLICY, warnUnknown: true }, null]) {
        const refused = await putPolicy(policy);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
      }
      // The permission is checked first: a viewer is FORBIDDEN, licence or not.
      expect((await putPolicy(POLICY, viewer)).json()).toMatchObject({ code: 'FORBIDDEN' });
      expect((await getPolicy()).json()).toMatchObject({ available: false, policy: POLICY });
      expect(await stored()).toEqual(POLICY);
    });

    it('answers 400 INVALID_LICENSE_ID naming exactly the unknown entries', async () => {
      const recorded = (await events()).length;
      const res = await putPolicy({
        ...POLICY,
        forbidden: ['GPL-3.0-only', 'Not-A-Licence', 'MIT WITH Nope-exception'],
        allowed: ['mit', 'GPLv3-ish', 'Commons-Clause'],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'INVALID_LICENSE_ID',
        details: { invalid: ['Not-A-Licence', 'MIT WITH Nope-exception', 'GPLv3-ish'] },
      });
      expect(await stored()).toBeNull();
      expect(await events()).toHaveLength(recorded);
    });

    it.each([
      ['body.policy.mode', { ...POLICY, mode: 'open' }],
      ['body.policy.forbiddenGroups.0', { ...POLICY, forbiddenGroups: ['permissive'] }],
      ['body.policy.forbidden', { ...POLICY, forbidden: Array(501).fill('MIT') }],
      ['body.policy.allowed.0', { ...POLICY, allowed: [''] }],
      ['body.policy.warnUnknown', { ...POLICY, warnUnknown: 'yes' }],
    ])('answers 422 VALIDATION_FAILED on %s', async (path, policy) => {
      const res = await putPolicy(policy);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors.map((e: { path: string }) => e.path)).toContain(path);
    });

    it('answers 422 for a body without policy or with an extra member', async () => {
      const bare = await call('PUT', `/organizations/${org}/license-policy`, orgAdmin, {});
      expect(bare.statusCode).toBe(422);
      const extra = await call('PUT', `/organizations/${org}/license-policy`, orgAdmin, {
        policy: null,
        extra: 1,
      });
      expect(extra.statusCode).toBe(422);
    });

    it('removes the policy with null', async () => {
      expect((await putPolicy(POLICY)).statusCode).toBe(200);
      const res = await putPolicy(null);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ available: true, policy: null });
      expect(await stored()).toBeNull();
      expect((await getPolicy()).json()).toMatchObject({ policy: null });
      // Removing no policy is a no-op.
      expect((await putPolicy(null)).statusCode).toBe(200);
    });

    it("drops a deleted organisation's entry on the next write, and keeps the others", async () => {
      const deleted = '0190a6c2-0000-7000-8000-00000000dead';
      await ctx.db.transaction(async (tx) => {
        await writeLicensePolicy(tx, otherOrg, POLICY);
      });
      // An entry left behind by an organisation deleted since (written as the row was then).
      const row = await readLicensePolicies(ctx.db);
      await ctx.db
        .update(instanceSettings)
        .set({ value: { organizations: { ...row.organizations, [deleted]: POLICY } } })
        .where(eq(instanceSettings.key, LICENSE_POLICY_SETTINGS_KEY));
      expect(Object.keys((await readLicensePolicies(ctx.db)).organizations).sort()).toEqual(
        [otherOrg, deleted].sort(),
      );
      expect((await putPolicy(POLICY)).statusCode).toBe(200);
      expect((await readLicensePolicies(ctx.db)).organizations).toEqual({
        [org]: POLICY,
        [otherOrg]: POLICY,
      });
    });
  });

  describe('an unreadable stored policy (final review)', () => {
    /** A group id a newer version wrote: this version cannot read the entry. */
    const UNREADABLE = { ...POLICY, forbiddenGroups: ['future-group'] };

    it("carries another organisation's unreadable entry over as it is, and still drops a deleted one's", async () => {
      const deleted = '0190a6c2-0000-7000-8000-00000000dead';
      await storeRow({
        organizations: { [otherOrg]: UNREADABLE, [deleted]: UNREADABLE, 'not-an-id': POLICY },
        later: { kept: true },
      });
      expect((await putPolicy(POLICY)).statusCode).toBe(200);
      expect(await storedRow()).toEqual({
        organizations: { [org]: POLICY, [otherOrg]: UNREADABLE },
        later: { kept: true },
      });
      // The other organisation's analyses still warn LICENSE_POLICY_INVALID, rather than judge
      // against no policy.
      expect(await storedPolicyFor(ctx.db, otherOrg)).toEqual({ state: 'invalid' });
      expect((await putPolicy(null)).statusCode).toBe(200);
      expect(await storedRow()).toEqual({
        organizations: { [otherOrg]: UNREADABLE },
        later: { kept: true },
      });
    });

    it('removes its own unreadable entry with null, and records the removal', async () => {
      for (const unreadable of [UNREADABLE, 'not a policy']) {
        await storeRow({ organizations: { [org]: unreadable, [otherOrg]: POLICY } });
        expect(await storedPolicyFor(ctx.db, org)).toEqual({ state: 'invalid' });
        const recorded = (await events()).length;
        const res = await putPolicy(null);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({ available: true, policy: null });
        expect(await storedRow()).toEqual({ organizations: { [otherOrg]: POLICY } });
        // The next analysis runs as with no policy.
        expect(await storedPolicyFor(ctx.db, org)).toEqual({ state: 'none' });
        const removal = (await events()).slice(recorded);
        expect(removal).toHaveLength(1);
        expect(removal[0]).toMatchObject({ details: { before: null, after: null } });
        // Removing it again is a no-op.
        expect((await putPolicy(null)).statusCode).toBe(200);
        expect(await events()).toHaveLength(recorded + 1);
      }
    });

    it('replaces its own unreadable entry with a policy', async () => {
      await storeRow({ organizations: { [org]: UNREADABLE } });
      const recorded = (await events()).length;
      expect((await putPolicy(POLICY)).statusCode).toBe(200);
      expect(await storedRow()).toEqual({ organizations: { [org]: POLICY } });
      expect((await events()).slice(recorded)).toMatchObject([
        { details: { before: null, after: POLICY } },
      ]);
    });

    it.each([
      ['organizations is a list', { organizations: [POLICY] }],
      ['organizations is a string', { organizations: 'x' }],
      ['the row is a list', [{ organizations: {} }]],
      ['the row is a string', 'x'],
    ])(
      'refuses to write over a row it cannot read (%s): 409 LICENSE_POLICIES_UNREADABLE, the row unchanged',
      async (_, broken) => {
        await storeRow(broken);
        const recorded = (await events()).length;
        for (const policy of [POLICY, null]) {
          const res = await putPolicy(policy);
          expect(res.statusCode, res.body).toBe(409);
          expect(res.json()).toMatchObject({ code: 'LICENSE_POLICIES_UNREADABLE' });
        }
        await expect(
          ctx.db.transaction((tx) => writeLicensePolicy(tx, otherOrg, POLICY)),
        ).rejects.toMatchObject({ code: 'LICENSE_POLICIES_UNREADABLE' });
        expect(await storedRow()).toEqual(broken);
        expect(await events()).toHaveLength(recorded);
      },
    );
  });

  describe('the audit event organization.license_policy_changed', () => {
    it('records the old and the new policy, and nothing for the same policy', async () => {
      const before = (await events()).length;
      expect((await putPolicy(POLICY)).statusCode).toBe(200);
      const changed = { ...POLICY, forbidden: ['GPL-3.0-only', 'SSPL-1.0'] };
      expect((await putPolicy({ ...POLICY, forbidden: ['SSPL-1.0', 'gpl-3.0'] })).statusCode).toBe(
        200,
      );
      // The same policy, spelt differently, changes nothing.
      expect((await putPolicy({ ...changed, forbidden: ['gpl-3.0', 'sspl-1.0'] })).statusCode).toBe(
        200,
      );
      expect((await putPolicy(null)).statusCode).toBe(200);
      const recorded = (await events()).slice(before);
      expect(recorded).toHaveLength(3);
      const target = {
        organizationId: org,
        organizationKey: 'default',
        targetType: 'organization',
        targetId: org,
        targetLabel: 'Default',
      };
      expect(recorded[0]).toMatchObject({ ...target, details: { before: null, after: POLICY } });
      expect(recorded[1]).toMatchObject({ ...target, details: { before: POLICY, after: changed } });
      expect(recorded[2]).toMatchObject({ ...target, details: { before: changed, after: null } });
    });

    it('records nothing while audit-log is not active', async () => {
      // Past the grace period the licence (and its audit-log) lapses; the seam stays on here.
      now = AFTER_GRACE;
      const before = (await events()).length;
      const res = await putPolicy(POLICY);
      expect(res.statusCode, res.body).toBe(200);
      expect(await stored()).toEqual(POLICY);
      expect(await events()).toHaveLength(before);
    });
  });
});
