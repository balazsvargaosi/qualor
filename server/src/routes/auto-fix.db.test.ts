import { asc, eq, sql } from 'drizzle-orm';
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
import { grantProject, rbacContext } from '../../test/rbac';
import { auditEvents } from '../db/schema';
import {
  DEFAULT_AUTO_FIX,
  DEFAULT_LLM_SETTINGS,
  readLlmSettings,
  writeLlmSettings,
  type OrgLlmSettings,
  type StoredProvider,
} from '../llm/settings';
import { defaultReview } from '../review/settings';

const NOW = new Date('2027-01-01T00:00:00Z');

const PROVIDER: StoredProvider = {
  kind: 'openai',
  baseUrl: 'https://llm.example/v1',
  model: 'fake-model',
  auth: 'bearer',
  jsonMode: 'json_object',
  maxTokensField: 'max_tokens',
  temperature: null,
  timeoutSeconds: 5,
  apiKeyEnc: null,
};

const ORG_ON: OrgLlmSettings = {
  enabled: true,
  features: { explain: true, triage: false, fix: true },
  excludedProjectIds: [],
  autoFix: { ...DEFAULT_AUTO_FIX },
  autoFixDisabledProjectIds: [],
  review: defaultReview(),
};

type Event = typeof auditEvents.$inferSelect;

describe('automatic fix suggestion settings (4E-3a §2)', () => {
  let ctx: TestContext;
  /** What `limits.llm.automaticFixSuggestions` answers (the plugin's seam). */
  let licensed = true;
  let admin: Session;
  let orgAdmin: Session;
  let projectAdmin: Session;
  let member: Session;
  let viewer: Session;
  let granted: Session;
  let outsider: Session;
  let org: string;
  let otherOrg: string;
  let project: { id: string; key: string };
  let otherProject: { id: string; key: string };
  let writeToken: string;
  let adminToken: string;

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) =>
    ctx.app.inject({
      method,
      url: `/api/v0${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  /** A signed-in session, or the headers of a token. */
  type Caller = Session | Record<string, string>;
  const headersOf = (caller: Caller): Record<string, string> =>
    typeof (caller as Session).csrf === 'string'
      ? (caller as Session).headers
      : (caller as Record<string, string>);
  const getOrg = (caller: Caller = orgAdmin, id = org) =>
    call('GET', `/organizations/${id}/ai/auto-fix`, headersOf(caller));
  const putOrg = (payload: object, caller: Caller = orgAdmin, id = org) =>
    call('PUT', `/organizations/${id}/ai/auto-fix`, headersOf(caller), payload);
  const putProject = (enabled: unknown, caller: Caller = orgAdmin, id = project.id) =>
    call('PUT', `/projects/${id}/ai/auto-fix`, headersOf(caller), { enabled });
  const on = { enabled: true, minSeverity: 'medium' as const, maxPerAnalysis: 5 };
  const events = (action: string): Promise<Event[]> =>
    ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, action))
      .orderBy(asc(auditEvents.seq));
  const configure = (
    over: Partial<OrgLlmSettings> = {},
    provider: StoredProvider | null = PROVIDER,
  ) =>
    writeLlmSettings(ctx.db, {
      ...DEFAULT_LLM_SETTINGS,
      provider,
      organizations: { [org]: { ...ORG_ON, ...over } },
    });
  const tokenOf = async (scopes: string[]): Promise<string> => {
    const res = await call('POST', '/tokens', orgAdmin.headers, { name: 'ops', scopes });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { token: string }).token;
  };

  beforeAll(async () => {
    ctx = await rbacContext({
      now: () => NOW,
      edition: (edition) => ({
        ...edition,
        limits: () => {
          const limits = edition.limits();
          return { ...limits, llm: { ...limits.llm, automaticFixSuggestions: licensed } };
        },
      }),
    });
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    org = await organizationId(ctx, 'default');
    const session = async (
      name: string,
      role?: 'admin' | 'project_admin' | 'member' | 'viewer',
    ) => {
      const u = await createUser(ctx, { username: name });
      if (role) await addMember(ctx, org, u.id, role);
      return { user: u, session: await login(ctx, u.username, u.password) };
    };
    orgAdmin = (await session('af-admin', 'admin')).session;
    projectAdmin = (await session('af-project-admin', 'project_admin')).session;
    member = (await session('af-member', 'member')).session;
    viewer = (await session('af-viewer', 'viewer')).session;
    outsider = (await session('af-outsider')).session;
    const grantee = await session('af-granted');
    granted = grantee.session;
    project = await createProject(ctx, admin, { organizationId: org, key: 'af/one' });
    await grantProject(ctx, project.id, grantee.user.id, 'project_admin');
    const created = await call('POST', '/organizations', admin.headers, {
      key: 'af-other',
      name: 'Other',
    });
    expect(created.statusCode, created.body).toBe(201);
    otherOrg = (created.json() as { id: string }).id;
    otherProject = await createProject(ctx, admin, { organizationId: otherOrg, key: 'af/other' });
    writeToken = await tokenOf(['write']);
    adminToken = await tokenOf(['admin']);
  });
  afterAll(async () => ctx.close());
  beforeEach(async () => {
    licensed = true;
    await configure();
  });

  describe('GET and PUT /organizations/{id}/ai/auto-fix', () => {
    it('answers the defaults, for organisation and instance admins only', async () => {
      for (const s of [orgAdmin, admin]) {
        const res = await getOrg(s);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({
          available: true,
          enabled: false,
          minSeverity: 'high',
          maxPerAnalysis: 10,
        });
      }
      for (const s of [projectAdmin, member, viewer, granted]) {
        const res = await getOrg(s);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect((await getOrg(outsider)).statusCode).toBe(404);
      expect((await getOrg(orgAdmin, '00000000-0000-7000-8000-00000000dead')).statusCode).toBe(404);
      expect((await call('GET', `/organizations/${org}/ai/auto-fix`, {})).statusCode).toBe(401);
    });

    it('lets an organisation admin switch it on, changing nothing else', async () => {
      await configure({ excludedProjectIds: [project.id] });
      const res = await putOrg(on);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ available: true, ...on });
      expect((await getOrg()).json()).toEqual({ available: true, ...on });
      const stored = await readLlmSettings(ctx.db);
      expect(stored.provider).toEqual(PROVIDER);
      expect(stored.organizations[org]).toEqual({
        ...ORG_ON,
        excludedProjectIds: [project.id],
        autoFix: on,
      });
    });

    it('refuses the roles without org.ai.manage, and a token without the admin scope', async () => {
      for (const s of [projectAdmin, member, viewer, granted]) {
        const res = await putOrg(on, s);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect((await putOrg(on, outsider)).statusCode).toBe(404);
      const scoped = await putOrg(on, bearer(writeToken));
      expect(scoped.statusCode).toBe(403);
      expect(scoped.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      expect((await getOrg(bearer(writeToken))).json()).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
      });
      expect((await readLlmSettings(ctx.db)).organizations[org]!.autoFix.enabled).toBe(false);
      expect((await putOrg(on, bearer(adminToken))).statusCode).toBe(200);
    });

    it('answers 403 FEATURE_NOT_LICENSED for switching it on without the seam, and keeps the values', async () => {
      licensed = false;
      const refused = await putOrg(on);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
      expect((await getOrg()).json()).toEqual({ available: false, ...DEFAULT_AUTO_FIX });
      licensed = true;
      expect((await putOrg(on)).statusCode).toBe(200);
      licensed = false;
      // The stored values are kept and shown as unavailable.
      expect((await getOrg()).json()).toEqual({ available: false, ...on });
      // A stored switch-on keeps its threshold editable without the licence.
      const tuned = await putOrg({ ...on, maxPerAnalysis: 7 });
      expect(tuned.statusCode, tuned.body).toBe(200);
      expect(tuned.json()).toEqual({ available: false, ...on, maxPerAnalysis: 7 });
      // Switching it off needs no licence; switching it back on does.
      const off = await putOrg({ ...on, enabled: false });
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json()).toEqual({ available: false, ...on, enabled: false });
      expect((await putOrg(on)).json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
    });

    it('checks the fix suggestions only when switching it on, not for a stored switch-on', async () => {
      await configure({
        features: { explain: true, triage: true, fix: false },
        autoFix: { ...on },
      });
      const tuned = await putOrg({ ...on, minSeverity: 'blocker' });
      expect(tuned.statusCode, tuned.body).toBe(200);
      expect((await putOrg({ ...on, enabled: false })).statusCode).toBe(200);
      expect((await putOrg(on)).json()).toMatchObject({ code: 'AI_DISABLED' });
    });

    it.each<[string, Partial<OrgLlmSettings>, StoredProvider | null]>([
      ['the organisation is AI-disabled', { enabled: false }, PROVIDER],
      [
        'the fix feature is off',
        { features: { explain: true, triage: true, fix: false } },
        PROVIDER,
      ],
      ['no provider is configured', {}, null],
    ])('answers 409 AI_DISABLED for switching it on when %s', async (_name, over, provider) => {
      await configure(over, provider);
      const res = await putOrg(on);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'AI_DISABLED' });
      expect((await putOrg({ ...on, enabled: false })).statusCode).toBe(200);
    });

    it('answers 409 AI_DISABLED for an organisation absent from the map, and stores a switch-off', async () => {
      await writeLlmSettings(ctx.db, { ...DEFAULT_LLM_SETTINGS, provider: PROVIDER });
      expect((await putOrg(on)).json()).toMatchObject({ code: 'AI_DISABLED' });
      const off = { enabled: false, minSeverity: 'low', maxPerAnalysis: 3 };
      expect((await putOrg(off)).statusCode).toBe(200);
      expect((await getOrg()).json()).toEqual({ available: true, ...off });
      expect((await readLlmSettings(ctx.db)).organizations[org]).toMatchObject({
        enabled: false,
        features: { explain: false, triage: false, fix: false },
      });
    });

    it.each([
      ['minSeverity', { ...on, minSeverity: 'critical' }],
      ['maxPerAnalysis', { ...on, maxPerAnalysis: 0 }],
      ['maxPerAnalysis', { ...on, maxPerAnalysis: 26 }],
      ['maxPerAnalysis', { ...on, maxPerAnalysis: 2.5 }],
      ['maxPerAnalysis', { enabled: true, minSeverity: 'high' }],
    ])('answers 422 on body.%s', async (field, payload) => {
      const res = await putOrg(payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors.map((e: { path: string }) => e.path)).toContain(`body.${field}`);
    });

    it('accepts the bounds 1 and 25 and every severity', async () => {
      for (const minSeverity of ['blocker', 'high', 'medium', 'low', 'info']) {
        expect((await putOrg({ ...on, minSeverity, maxPerAnalysis: 1 })).statusCode).toBe(200);
      }
      expect((await putOrg({ ...on, maxPerAnalysis: 25 })).json()).toMatchObject({
        maxPerAnalysis: 25,
      });
      expect((await putOrg({ ...on, extra: 1 })).statusCode).toBe(422);
    });

    it('records organization.auto_fix_changed on a change, and nothing for the same values', async () => {
      const before = (await events('organization.auto_fix_changed')).length;
      expect((await putOrg(on)).statusCode).toBe(200);
      const [event] = (await events('organization.auto_fix_changed')).slice(before);
      expect(event).toMatchObject({
        organizationId: org,
        organizationKey: 'default',
        targetType: 'organization',
        targetId: org,
        details: on,
      });
      expect((await putOrg(on)).statusCode).toBe(200);
      expect(await events('organization.auto_fix_changed')).toHaveLength(before + 1);
    });
  });

  describe('PUT /projects/{id}/ai/auto-fix and the project DTO', () => {
    const dto = async (session: Session = orgAdmin) =>
      (await call('GET', `/projects/${project.id}`, session.headers)).json().autoFix;

    it('opts a project out and back in, for project.settings', async () => {
      expect(await dto()).toEqual({
        available: true,
        enabled: true,
        organizationEnabled: false,
        excludedFromAi: false,
      });
      for (const s of [orgAdmin, projectAdmin, granted, admin]) {
        const out = await putProject(false, s);
        expect(out.statusCode, out.body).toBe(200);
        expect(out.json()).toEqual({ available: true, enabled: false });
        expect(await dto()).toEqual({
          available: true,
          enabled: false,
          organizationEnabled: false,
          excludedFromAi: false,
        });
        expect(
          (await readLlmSettings(ctx.db)).organizations[org]!.autoFixDisabledProjectIds,
        ).toEqual([project.id]);
        expect((await putProject(true, s)).json()).toEqual({ available: true, enabled: true });
        expect(await dto()).toEqual({
          available: true,
          enabled: true,
          organizationEnabled: false,
          excludedFromAi: false,
        });
      }
      const list = await call('GET', '/projects', orgAdmin.headers);
      expect(
        (list.json().items as { id: string; autoFix: unknown }[]).find((p) => p.id === project.id)
          ?.autoFix,
      ).toEqual({
        available: true,
        enabled: true,
        organizationEnabled: false,
        excludedFromAi: false,
      });
    });

    it('says whether the organisation has them on: the assistant, its fix suggestions and the switch', async () => {
      const autoFix = { ...DEFAULT_AUTO_FIX, enabled: true };
      await configure({ autoFix });
      expect(await dto()).toMatchObject({ organizationEnabled: true });
      // A project opted out still sees its organisation's switch.
      await putProject(false);
      expect(await dto()).toEqual({
        available: true,
        enabled: false,
        organizationEnabled: true,
        excludedFromAi: false,
      });
      await configure({ autoFix, features: { ...ORG_ON.features, fix: false } });
      expect(await dto()).toMatchObject({ organizationEnabled: false });
      await configure({ autoFix, enabled: false });
      expect(await dto()).toMatchObject({ organizationEnabled: false });
      await configure({ autoFix }, null);
      expect(await dto()).toMatchObject({ organizationEnabled: false });
    });

    it('says whether the organisation excludes the project from AI', async () => {
      const autoFix = { ...DEFAULT_AUTO_FIX, enabled: true };
      await configure({ autoFix, excludedProjectIds: [project.id] });
      expect(await dto()).toEqual({
        available: true,
        enabled: true,
        organizationEnabled: true,
        excludedFromAi: true,
      });
      await configure({ autoFix, excludedProjectIds: [otherProject.id] });
      expect(await dto()).toMatchObject({ excludedFromAi: false });
    });

    it('refuses a member, a viewer, an outsider and a token without the admin scope', async () => {
      for (const s of [member, viewer]) {
        const res = await putProject(false, s);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect((await putProject(false, outsider)).statusCode).toBe(404);
      expect((await putProject(false, bearer(writeToken))).json()).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
      });
      expect((await putProject('no')).statusCode).toBe(422);
      expect((await readLlmSettings(ctx.db)).organizations[org]!.autoFixDisabledProjectIds).toEqual(
        [],
      );
    });

    it('answers 403 FEATURE_NOT_LICENSED without the seam, and shows it unavailable', async () => {
      licensed = false;
      for (const enabled of [false, true]) {
        const res = await putProject(enabled);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_LICENSED' });
      }
      expect(await dto()).toEqual({
        available: false,
        enabled: true,
        organizationEnabled: false,
        excludedFromAi: false,
      });
    });

    it('records project.auto_fix_changed on a change, and nothing for the same value', async () => {
      const before = (await events('project.auto_fix_changed')).length;
      await putProject(false);
      await putProject(false);
      await putProject(true);
      const added = (await events('project.auto_fix_changed')).slice(before);
      expect(added.map((e) => e.details)).toEqual([{ enabled: false }, { enabled: true }]);
      expect(added[0]).toMatchObject({
        organizationId: org,
        projectId: project.id,
        projectKey: project.key,
        targetType: 'project',
        targetId: project.id,
      });
    });

    it('drops the id of a deleted project silently', async () => {
      const gone = await createProject(ctx, admin, { organizationId: org, key: 'af/gone' });
      expect((await putProject(false, orgAdmin, gone.id)).statusCode).toBe(200);
      expect(
        (
          await call(
            'DELETE',
            `/projects/${gone.id}?confirm=${encodeURIComponent(gone.key)}`,
            admin.headers,
          )
        ).statusCode,
      ).toBe(204);
      // The instance admin's settings leave it out, and a save that still sends it drops it.
      const read = await call('GET', '/system/llm', admin.headers);
      expect(read.json().organizations[org].autoFixDisabledProjectIds).toEqual([]);
      const body = {
        ...read.json(),
        provider: null,
        organizations: {
          [org]: { ...read.json().organizations[org], autoFixDisabledProjectIds: [gone.id] },
        },
      };
      const saved = await call('PUT', '/system/llm', admin.headers, body);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().organizations[org].autoFixDisabledProjectIds).toEqual([]);
      // The project route's own write drops it too.
      await configure({ autoFixDisabledProjectIds: [gone.id] });
      expect((await putProject(false)).statusCode).toBe(200);
      expect((await readLlmSettings(ctx.db)).organizations[org]!.autoFixDisabledProjectIds).toEqual(
        [project.id],
      );
    });

    it('answers 409 AUTO_FIX_OPT_OUT_LIMIT_REACHED past 1 000 opted-out projects', async () => {
      const filled = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO projects (id, organization_id, key, name)
        SELECT gen_random_uuid(), ${org}, 'af-fill/' || i, 'fill ' || i
          FROM generate_series(1, 1000) AS i
        RETURNING id`);
      const ids = filled.rows.map((r) => r.id);
      await configure({ autoFixDisabledProjectIds: ids });
      const res = await putProject(false);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'AUTO_FIX_OPT_OUT_LIMIT_REACHED' });
      // Opting one back in still works.
      expect((await putProject(true, orgAdmin, ids[0])).statusCode).toBe(200);
      expect((await putProject(false)).statusCode).toBe(200);
      await ctx.db.execute(sql`DELETE FROM projects WHERE key LIKE 'af-fill/%'`);
    });
  });

  describe('/system/llm and autoFix (llm.md §3.3)', () => {
    const settingsBody = async () => {
      const read = (await call('GET', '/system/llm', admin.headers)).json();
      return { ...read, provider: null };
    };

    it('returns and accepts autoFix and the opt-outs', async () => {
      const body = await settingsBody();
      expect(body.organizations[org]).toMatchObject({
        autoFix: DEFAULT_AUTO_FIX,
        autoFixDisabledProjectIds: [],
      });
      body.organizations[org] = {
        ...body.organizations[org],
        autoFix: on,
        autoFixDisabledProjectIds: [project.id],
      };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().organizations[org]).toMatchObject({
        autoFix: on,
        autoFixDisabledProjectIds: [project.id],
      });
      const [event] = (await events('ai.settings_updated')).slice(-1);
      expect((event!.details as { changed: string[] }).changed).toEqual(
        expect.arrayContaining(['provider', 'autoFix']),
      );
      expect((event!.details as { changed: string[] }).changed).not.toContain('organizations');
    });

    it('keeps the stored autoFix and opt-outs when a save leaves them out', async () => {
      await configure({ autoFix: on, autoFixDisabledProjectIds: [project.id] });
      const body = await settingsBody();
      // A form that does not know the auto-fix fields sends only the others.
      body.organizations[org] = {
        enabled: body.organizations[org].enabled,
        features: { explain: true, triage: true, fix: true },
        excludedProjectIds: body.organizations[org].excludedProjectIds,
      };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().organizations[org]).toMatchObject({
        features: { explain: true, triage: true, fix: true },
        autoFix: on,
        autoFixDisabledProjectIds: [project.id],
      });
      const [event] = (await events('ai.settings_updated')).slice(-1);
      expect((event!.details as { changed: string[] }).changed).toContain('organizations');
      expect((event!.details as { changed: string[] }).changed).not.toContain('autoFix');
    });

    it('keeps what the organisation and project routes set when a save leaves the fields out', async () => {
      expect((await putOrg(on)).statusCode).toBe(200);
      expect((await putProject(false)).statusCode).toBe(200);
      const body = await settingsBody();
      // The instance admin's form sends only the fields it edits.
      body.organizations[org] = {
        enabled: body.organizations[org].enabled,
        features: body.organizations[org].features,
        excludedProjectIds: body.organizations[org].excludedProjectIds,
      };
      body.budgets = { ...body.budgets, explainPerDay: 99 };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(200);
      expect((await getOrg()).json()).toEqual({ available: true, ...on });
      expect((await readLlmSettings(ctx.db)).organizations[org]).toMatchObject({
        autoFix: on,
        autoFixDisabledProjectIds: [project.id],
      });
    });

    it('keeps the auto-fix choice of an organisation a stale form leaves out', async () => {
      await writeLlmSettings(ctx.db, {
        ...DEFAULT_LLM_SETTINGS,
        provider: PROVIDER,
        organizations: { [org]: ORG_ON, [otherOrg]: ORG_ON },
      });
      // The instance admin's form, loaded with only `org`.
      const body = await settingsBody();
      body.organizations = { [org]: body.organizations[org] };
      // Meanwhile the other organisation's admin switches it on and opts a project out.
      expect((await putOrg(on, admin, otherOrg)).statusCode).toBe(200);
      expect((await putProject(false, admin, otherProject.id)).statusCode).toBe(200);
      // And an organisation deleted since keeps nothing.
      const gone = (
        await ctx.db.execute<{ id: string }>(sql`
          INSERT INTO organizations (id, key, name) VALUES (gen_random_uuid(), 'af-gone', 'Gone')
          RETURNING id`)
      ).rows[0]!.id;
      const stored = await readLlmSettings(ctx.db);
      await writeLlmSettings(ctx.db, {
        ...stored,
        organizations: { ...stored.organizations, [gone]: { ...ORG_ON, autoFix: on } },
      });
      await ctx.db.execute(sql`DELETE FROM organizations WHERE id = ${gone}`);

      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(200);
      const saved = (await readLlmSettings(ctx.db)).organizations;
      // Its switches go, as for any organisation a save leaves out; its auto-fix choice stays.
      expect(saved[otherOrg]).toEqual({
        enabled: false,
        features: { explain: false, triage: false, fix: false },
        excludedProjectIds: [],
        autoFix: on,
        autoFixDisabledProjectIds: [otherProject.id],
        review: defaultReview(),
      });
      expect(Object.keys(saved).sort()).toEqual([org, otherOrg].sort());
      expect((await getOrg(admin, otherOrg)).json()).toMatchObject(on);
    });

    it('stores each opted-out project once', async () => {
      const body = await settingsBody();
      body.organizations[org] = {
        ...body.organizations[org],
        autoFixDisabledProjectIds: [project.id, project.id],
      };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().organizations[org].autoFixDisabledProjectIds).toEqual([project.id]);
      expect((await readLlmSettings(ctx.db)).organizations[org]!.autoFixDisabledProjectIds).toEqual(
        [project.id],
      );
    });

    it('does not count disabled default entries towards the 1 000 organisations', async () => {
      const filled = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO organizations (id, key, name)
        SELECT gen_random_uuid(), 'af-fill-' || i, 'fill ' || i FROM generate_series(1, 1000) AS i
        RETURNING id`);
      const ids = filled.rows.map((r) => r.id);
      try {
        const body = await settingsBody();
        const enabled = {
          enabled: true,
          features: { explain: true, triage: false, fix: false },
          excludedProjectIds: [],
        };
        const disabled = {
          enabled: false,
          features: { explain: false, triage: false, fix: false },
          excludedProjectIds: [],
        };
        // 999 fill organisations and `org` enabled: 1 000; one more, and `otherOrg`, as the
        // organisation and project routes leave them (disabled, the defaults).
        body.organizations = {
          [org]: body.organizations[org],
          ...Object.fromEntries(ids.slice(0, 999).map((id) => [id, enabled])),
          [ids[999]!]: disabled,
          [otherOrg]: {
            ...disabled,
            autoFix: { ...DEFAULT_AUTO_FIX },
            autoFixDisabledProjectIds: [],
          },
        };
        const ok = await call('PUT', '/system/llm', admin.headers, body);
        expect(ok.statusCode, ok.body).toBe(200);
        body.organizations[ids[999]!] = enabled;
        const over = await call('PUT', '/system/llm', admin.headers, body);
        expect(over.statusCode).toBe(422);
        expect(over.json().errors.map((e: { path: string }) => e.path)).toEqual([
          'body.organizations',
        ]);
        // An entry that differs from the defaults in its auto-fix values counts.
        body.organizations[ids[999]!] = {
          ...disabled,
          autoFix: { ...DEFAULT_AUTO_FIX, minSeverity: 'low' },
        };
        expect((await call('PUT', '/system/llm', admin.headers, body)).statusCode).toBe(422);
      } finally {
        await configure();
        await ctx.db.execute(sql`DELETE FROM organizations WHERE key LIKE 'af-fill-%'`);
      }
    });

    it('refuses switching it on without the seam, and keeps a stored switch-on', async () => {
      licensed = false;
      const body = await settingsBody();
      body.organizations[org] = { ...body.organizations[org], autoFix: on };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors.map((e: { path: string }) => e.path)).toEqual([
        `body.organizations.${org}.autoFix.enabled`,
      ]);
      await configure({ autoFix: on });
      const kept = await call('PUT', '/system/llm', admin.headers, await settingsBody());
      expect(kept.statusCode, kept.body).toBe(200);
      expect(kept.json().organizations[org].autoFix).toEqual(on);
    });

    it('refuses an opt-out of a project of another organisation, and bad values', async () => {
      const body = await settingsBody();
      body.organizations[org] = {
        ...body.organizations[org],
        autoFixDisabledProjectIds: [project.id, otherProject.id],
      };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().errors.map((e: { path: string }) => e.path)).toEqual([
        `body.organizations.${org}.autoFixDisabledProjectIds.1`,
      ]);
      body.organizations[org] = {
        ...body.organizations[org],
        autoFixDisabledProjectIds: [],
        autoFix: { ...on, maxPerAnalysis: 30 },
      };
      expect((await call('PUT', '/system/llm', admin.headers, body)).statusCode).toBe(422);
    });
  });
});
