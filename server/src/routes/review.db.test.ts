import { MAX_SNAPSHOT_FILE_BYTES, MAX_SNAPSHOT_FILES } from '@qualor/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  ADMIN_PASSWORD,
  bearer,
  createProject,
  createProjectToken,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';
import { grantProject, rbacContext } from '../../test/rbac';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import { auditEvents, instanceSettings, projects, scmConnections } from '../db/schema';
import {
  DEFAULT_AUTO_FIX,
  DEFAULT_BUDGETS,
  DEFAULT_LLM_SETTINGS,
  readLlmSettings,
  writeLlmSettings,
  type OrgLlmSettings,
  type StoredProvider,
} from '../llm/settings';
import { SCM_TOKEN_AAD } from '../scm/connections';
import {
  dataSharingNotice,
  DEFAULT_REVIEW,
  reviewSettingsOf,
  type ReviewSettings,
} from '../review/settings';

const NOW = new Date('2027-01-01T00:00:00Z');
const MiB = 1024 * 1024;

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
  features: { explain: true, triage: false, fix: false },
  excludedProjectIds: [],
  autoFix: { ...DEFAULT_AUTO_FIX },
  autoFixDisabledProjectIds: [],
  review: { ...DEFAULT_REVIEW, projectIds: [] },
};

type Event = typeof auditEvents.$inferSelect;
type Caller = Session | Record<string, string>;

describe('AI review settings, consent and the review context (6I-2, R10)', () => {
  let ctx: TestContext;
  let admin: Session;
  let orgAdmin: Session;
  let orgAdminId: string;
  let member: Session;
  let viewer: Session;
  let outsider: Session;
  let grantee: Session;
  let org: string;
  let otherOrg: string;
  /** Mapped to an SCM connection. */
  let project: { id: string; key: string };
  let second: { id: string; key: string };
  /** Not mapped. */
  let unmapped: { id: string; key: string };
  let otherProject: { id: string; key: string };
  let projectToken: string;
  let unmappedToken: string;
  let otherToken: string;
  let adminToken: string;
  let writeToken: string;
  let uploadToken: string;
  let readToken: string;

  const headersOf = (caller: Caller): Record<string, string> =>
    typeof (caller as Session).csrf === 'string'
      ? (caller as Session).headers
      : (caller as Record<string, string>);
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
  const getReview = (caller: Caller = orgAdmin, id = org) =>
    call('GET', `/organizations/${id}/ai/review`, headersOf(caller));
  const putReview = (payload: object, caller: Caller = orgAdmin, id = org) =>
    call('PUT', `/organizations/${id}/ai/review`, headersOf(caller), payload);
  const contextOf = (
    projectKey: string,
    caller: Caller,
    mergeRequest = '7',
  ): ReturnType<typeof call> =>
    call(
      'GET',
      `/projects/review-context?projectKey=${encodeURIComponent(projectKey)}&mergeRequest=${mergeRequest}`,
      headersOf(caller),
    );
  /** What the notice names while the provider is the one of `configure()`: its host and model. */
  const SHOWN = { host: 'llm.example', model: 'fake-model' };
  /** The body of a switch-on that selects `project`, acknowledging the provider of `configure()`. */
  const onBody = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    scope: 'selected',
    projectIds: [project.id],
    budgets: { ...DEFAULT_REVIEW.budgets },
    acknowledgeDataSharing: SHOWN,
    ...over,
  });
  /** The acknowledgement the settings page sends: the provider the GET answer shows now (R10). */
  const shownProvider = async (): Promise<{ host: string; model: string }> =>
    (await getReview()).json().provider;
  const events = (action: string): Promise<Event[]> =>
    ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, action))
      .orderBy(asc(auditEvents.seq));
  /** The stored settings: the organisation enabled for the AI assistant (the instance admin's), review at its defaults. */
  const configure = (
    over: Partial<OrgLlmSettings> = {},
    provider: StoredProvider | null = PROVIDER,
    budgetOver: Partial<typeof DEFAULT_BUDGETS> = {},
  ) =>
    writeLlmSettings(ctx.db, {
      ...DEFAULT_LLM_SETTINGS,
      provider,
      organizations: {
        [org]: { ...ORG_ON, review: { ...DEFAULT_REVIEW, projectIds: [] }, ...over },
      },
      budgets: { ...DEFAULT_BUDGETS, ...budgetOver },
    });
  const storedReview = async (): Promise<ReviewSettings> =>
    reviewSettingsOf(await readLlmSettings(ctx.db), org);
  /**
   * The instance admin's form: the stored settings as `GET /system/llm` shows them, the provider
   * as a body (the key stays as stored), `providerOver` changing it.
   */
  const settingsBody = async (providerOver: Record<string, unknown> = {}) => {
    const read = (await call('GET', '/system/llm', admin.headers)).json();
    const p = read.provider;
    return {
      ...read,
      provider: {
        kind: p.kind,
        baseUrl: p.baseUrl,
        model: p.model,
        auth: p.auth,
        jsonMode: p.jsonMode,
        maxTokensField: p.maxTokensField,
        temperature: p.temperature,
        timeoutSeconds: p.timeoutSeconds,
        ...providerOver,
      },
    };
  };
  const changeProvider = async (over: Record<string, unknown>) =>
    call('PUT', '/system/llm', admin.headers, await settingsBody(over));
  const tokenOf = async (scopes: string[]): Promise<string> => {
    const res = await call('POST', '/tokens', orgAdmin.headers, { name: 'ops', scopes });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { token: string }).token;
  };
  const paths = (res: { json: () => unknown }): string[] =>
    ((res.json() as { errors?: { path: string }[] }).errors ?? []).map((e) => e.path);

  beforeAll(async () => {
    ctx = await rbacContext({ now: () => NOW });
    admin = await login(ctx, 'admin', ADMIN_PASSWORD);
    org = await organizationId(ctx, 'default');
    const session = async (name: string, role?: 'admin' | 'member' | 'viewer') => {
      const u = await createUser(ctx, { username: name });
      if (role) await addMember(ctx, org, u.id, role);
      return { user: u, session: await login(ctx, u.username, u.password) };
    };
    const orgAdminUser = await session('rv-admin', 'admin');
    orgAdmin = orgAdminUser.session;
    orgAdminId = orgAdminUser.user.id;
    member = (await session('rv-member', 'member')).session;
    viewer = (await session('rv-viewer', 'viewer')).session;
    outsider = (await session('rv-outsider')).session;
    const granted = await session('rv-granted');
    grantee = granted.session;
    project = await createProject(ctx, admin, { organizationId: org, key: 'rv/one' });
    second = await createProject(ctx, admin, { organizationId: org, key: 'rv/two' });
    unmapped = await createProject(ctx, admin, { organizationId: org, key: 'rv/unmapped' });
    await grantProject(ctx, project.id, granted.user.id, 'viewer');
    const created = await call('POST', '/organizations', admin.headers, {
      key: 'rv-other',
      name: 'Other',
    });
    expect(created.statusCode, created.body).toBe(201);
    otherOrg = (created.json() as { id: string }).id;
    otherProject = await createProject(ctx, admin, { organizationId: otherOrg, key: 'rv/other' });
    // `project` and `second` are mapped to a GitLab connection of the organisation.
    const [connection] = await ctx.db
      .insert(scmConnections)
      .values({
        organizationId: org,
        provider: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        tokenEnc: encryptSecret(encryptionKey(ctx.config.secretKey), 'x', SCM_TOKEN_AAD),
      })
      .returning();
    for (const p of [project, second]) {
      await ctx.db
        .update(projects)
        .set({ scmConnectionId: connection!.id, scmProjectRef: p === project ? '7' : '8' })
        .where(eq(projects.id, p.id));
    }
    projectToken = await createProjectToken(ctx, admin, project.id);
    unmappedToken = await createProjectToken(ctx, admin, unmapped.id);
    otherToken = await createProjectToken(ctx, admin, otherProject.id);
    adminToken = await tokenOf(['admin']);
    writeToken = await tokenOf(['write']);
    readToken = await tokenOf(['read']);
    uploadToken = await tokenOf(['analysis:write']);
  });
  afterAll(async () => ctx.close());
  beforeEach(async () => {
    await configure();
  });

  describe('GET /organizations/{id}/ai/review', () => {
    it('answers the defaults and the notice, for organisation and instance admins only', async () => {
      for (const s of [orgAdmin, admin]) {
        const res = await getReview(s);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({
          available: true,
          unavailableReason: null,
          provider: { host: 'llm.example', model: 'fake-model' },
          notice: dataSharingNotice('llm.example', 'fake-model', 14),
          enabled: false,
          scope: 'selected',
          projectIds: [],
          budgets: {
            tokensPerDay: 2_000_000,
            costPerDayUsd: null,
            perProjectTokensPerDay: null,
            maxTokensPerReview: 300_000,
          },
          consent: null,
          consentCurrent: false,
          instanceCeiling: { tokensPerDay: null },
        });
      }
      for (const s of [member, viewer, grantee]) {
        const res = await getReview(s);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect((await getReview(outsider)).statusCode).toBe(404);
      expect((await getReview(orgAdmin, '00000000-0000-7000-8000-00000000dead')).statusCode).toBe(
        404,
      );
      expect((await call('GET', `/organizations/${org}/ai/review`, {})).statusCode).toBe(401);
      expect((await getReview(orgAdmin, 'not-a-uuid')).statusCode).toBe(422);
    });

    it('needs a token of the admin scope', async () => {
      expect((await getReview(bearer(adminToken))).statusCode).toBe(200);
      for (const token of [writeToken, readToken, uploadToken]) {
        const res = await getReview(bearer(token));
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      }
      expect((await getReview(bearer(projectToken))).json()).toMatchObject({
        code: 'TOKEN_NOT_ALLOWED',
      });
    });

    it('says why it is not available, and what the provider is', async () => {
      await configure({}, null);
      expect((await getReview()).json()).toMatchObject({
        available: false,
        unavailableReason: 'no_provider',
        provider: null,
        notice: null,
      });
      await configure({ enabled: false });
      expect((await getReview()).json()).toMatchObject({
        available: false,
        unavailableReason: 'organization_disabled',
        provider: { host: 'llm.example', model: 'fake-model' },
        notice: dataSharingNotice('llm.example', 'fake-model', 14),
      });
      // An organisation absent from the map is disabled too.
      await writeLlmSettings(ctx.db, { ...DEFAULT_LLM_SETTINGS, provider: PROVIDER });
      expect((await getReview()).json()).toMatchObject({
        available: false,
        unavailableReason: 'organization_disabled',
      });
      await writeLlmSettings(ctx.db, DEFAULT_LLM_SETTINGS);
      expect((await getReview()).json()).toMatchObject({
        available: false,
        unavailableReason: 'no_provider',
      });
    });

    it('names the provider by the host of its address, with the port', async () => {
      await configure({}, { ...PROVIDER, baseUrl: 'https://llm.example:8443/v1' });
      expect((await getReview()).json()).toMatchObject({
        provider: { host: 'llm.example:8443', model: 'fake-model' },
        notice: dataSharingNotice('llm.example:8443', 'fake-model', 14),
      });
    });

    it('shows the instance ceiling next to the organisation’s own budget', async () => {
      await configure({}, PROVIDER, { reviewTokensPerOrganizationPerDay: 500_000 });
      expect((await getReview()).json()).toMatchObject({
        instanceCeiling: { tokensPerDay: 500_000 },
        // The budget stored is the organisation's own; the ceiling caps it when a review runs.
        budgets: { tokensPerDay: 2_000_000 },
      });
    });

    it('names the days the server keeps a snapshot, as the retention setting has them', async () => {
      try {
        await ctx.db
          .insert(instanceSettings)
          .values({ key: 'retention', value: { reviewSnapshotsDays: 30 } });
        const res = await getReview();
        expect(res.json().notice).toBe(dataSharingNotice('llm.example', 'fake-model', 30));
        expect(res.json().notice).toContain('(at most 30 days)');
        // A switch-on answers the same notice.
        expect((await putReview(onBody())).json().notice).toContain('(at most 30 days)');
      } finally {
        await ctx.db.delete(instanceSettings).where(eq(instanceSettings.key, 'retention'));
      }
      expect((await getReview()).json().notice).toContain('(at most 14 days)');
    });
  });

  describe('PUT /organizations/{id}/ai/review', () => {
    it('answers 409 AI_DISABLED for switching it on without a provider, or an enabled organisation', async () => {
      for (const [over, provider] of [
        [{}, null],
        [{ enabled: false }, PROVIDER],
      ] as const) {
        await configure(over, provider);
        const res = await putReview(onBody());
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json()).toMatchObject({ code: 'AI_DISABLED' });
        expect(await storedReview()).toEqual(DEFAULT_REVIEW);
      }
      // The organisation absent from the map.
      await writeLlmSettings(ctx.db, { ...DEFAULT_LLM_SETTINGS, provider: PROVIDER });
      expect((await putReview(onBody())).json()).toMatchObject({ code: 'AI_DISABLED' });
    });

    it('answers AI_DISABLED before it asks for the acknowledgement', async () => {
      await configure({}, null);
      const res = await putReview(onBody({ acknowledgeDataSharing: undefined }));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'AI_DISABLED' });
    });

    it('answers 409 AI_REVIEW_CONSENT_REQUIRED for switching it on without the acknowledgement', async () => {
      const before = (await events('organization.ai_review_changed')).length;
      const res = await putReview(onBody({ acknowledgeDataSharing: undefined }));
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: 'AI_REVIEW_CONSENT_REQUIRED' });
      expect(await storedReview()).toEqual(DEFAULT_REVIEW);
      expect(await events('organization.ai_review_changed')).toHaveLength(before);
    });

    it('switches it on with the acknowledgement and records the consent', async () => {
      const before = Date.now();
      const res = await putReview(onBody());
      const after = Date.now();
      expect(res.statusCode, res.body).toBe(200);
      const answer = res.json();
      expect(answer).toMatchObject({
        available: true,
        enabled: true,
        scope: 'selected',
        projectIds: [project.id],
        consentCurrent: true,
        consent: {
          providerUrl: 'https://llm.example/v1',
          providerHost: 'llm.example',
          model: 'fake-model',
          userId: orgAdminId,
        },
        notice: dataSharingNotice('llm.example', 'fake-model', 14),
      });
      const at = Date.parse(answer.consent.at);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
      expect(answer.consent.at).toBe(new Date(at).toISOString());
      // The same answer on a read, and the same in the stored settings.
      expect((await getReview()).json()).toEqual(answer);
      const stored = await readLlmSettings(ctx.db);
      expect(stored.organizations[org]!.review).toEqual({
        enabled: true,
        scope: 'selected',
        projectIds: [project.id],
        budgets: DEFAULT_REVIEW.budgets,
        consent: answer.consent,
      });
      // Nothing else of the settings changed.
      expect(stored.provider).toEqual(PROVIDER);
      expect({ ...stored.organizations[org]!, review: null }).toEqual({ ...ORG_ON, review: null });
    });

    it('has an instance admin acknowledge it as that admin', async () => {
      const res = await putReview(onBody(), admin);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().consent.userId).toBe(ctx.adminId);
    });

    it('refuses the roles without org.ai.manage, an invisible organisation and a token of the wrong scope', async () => {
      for (const s of [member, viewer, grantee]) {
        const res = await putReview(onBody(), s);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect((await putReview(onBody(), outsider)).statusCode).toBe(404);
      expect((await putReview(onBody(), orgAdmin, otherOrg)).statusCode).toBe(404);
      expect((await call('PUT', `/organizations/${org}/ai/review`, {}, onBody())).statusCode).toBe(
        401,
      );
      const scoped = await putReview(onBody(), bearer(writeToken));
      expect(scoped.statusCode).toBe(403);
      expect(scoped.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      expect(await storedReview()).toEqual(DEFAULT_REVIEW);
      expect((await putReview(onBody(), bearer(adminToken))).statusCode).toBe(200);
    });

    it('asks for no acknowledgement to change anything else while the consent is current', async () => {
      const first = (await putReview(onBody())).json();
      const edit = {
        enabled: true,
        scope: 'all',
        projectIds: [project.id, second.id],
        budgets: {
          tokensPerDay: 1_000,
          costPerDayUsd: 2.5,
          perProjectTokensPerDay: 500,
          maxTokensPerReview: 100,
        },
      };
      const res = await putReview(edit);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        scope: 'all',
        projectIds: [project.id, second.id].sort(),
        budgets: edit.budgets,
        // Neither the person nor the time of the acknowledgement changes.
        consent: first.consent,
        consentCurrent: true,
      });
      // Sending the acknowledgement again does not renew it either.
      const again = await putReview({ ...edit, acknowledgeDataSharing: SHOWN });
      expect(again.json().consent).toEqual(first.consent);
    });

    it('ignores an acknowledgement that no consent needs, even one naming another provider', async () => {
      const first = (await putReview(onBody())).json();
      const other = { host: 'llm.elsewhere.example', model: 'another-model' };
      // Review is on and the consent is current: the acknowledgement is not looked at.
      const res = await putReview(onBody({ scope: 'all', acknowledgeDataSharing: other }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ scope: 'all', consent: first.consent });
      // Nor is it when review is switched off.
      const off = await putReview(onBody({ enabled: false, acknowledgeDataSharing: other }));
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json()).toMatchObject({ enabled: false, consent: first.consent });
    });

    it('switches it off without a provider or an acknowledgement, and asks again to switch it on', async () => {
      const first = (await putReview(onBody())).json();
      await configure({ review: await storedReview() }, null);
      const off = await putReview({
        ...onBody({ enabled: false }),
        acknowledgeDataSharing: undefined,
      });
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json()).toMatchObject({
        available: false,
        unavailableReason: 'no_provider',
        enabled: false,
        // The consent stays on record, but nothing runs.
        consent: first.consent,
        consentCurrent: false,
      });
      await configure({ review: await storedReview() });
      const again = await putReview(onBody({ acknowledgeDataSharing: undefined }));
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'AI_REVIEW_CONSENT_REQUIRED' });
      const renewed = await putReview(onBody());
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(renewed.json().enabled).toBe(true);
    });

    it('review consent follows the provider (Review Focus 3, R10)', async () => {
      await configure({}, { ...PROVIDER, apiKeyEnc: null });
      expect((await putReview(onBody())).statusCode).toBe(200);
      expect((await contextOf(project.key, bearer(projectToken))).json()).toMatchObject({
        review: true,
        reason: null,
      });
      // The instance admin changes the model: the warning named the old one.
      const changed = await changeProvider({ model: 'other-model' });
      expect(changed.statusCode, changed.body).toBe(200);
      const read = (await getReview()).json();
      expect(read).toMatchObject({
        enabled: true,
        consentCurrent: false,
        provider: { host: 'llm.example', model: 'other-model' },
        // The record of what was acknowledged stays as it was given.
        consent: {
          providerUrl: 'https://llm.example/v1',
          providerHost: 'llm.example',
          model: 'fake-model',
          userId: orgAdminId,
        },
      });
      expect(read.notice).toBe(dataSharingNotice('llm.example', 'other-model', 14));
      const context = await contextOf(project.key, bearer(projectToken));
      expect(context.statusCode, context.body).toBe(200);
      expect(context.json()).toMatchObject({ review: false, reason: 'consent_outdated' });
      // Saving the settings again does not renew it: only the organisation's admin can.
      const kept = await changeProvider({});
      expect(kept.statusCode, kept.body).toBe(200);
      expect((await getReview()).json()).toMatchObject({ enabled: true, consentCurrent: false });
      // Confirming again needs the acknowledgement of the new model, and gives it.
      const refused = await putReview(onBody({ acknowledgeDataSharing: undefined }));
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'AI_REVIEW_CONSENT_REQUIRED' });
      const stale = await putReview(onBody({ acknowledgeDataSharing: SHOWN }));
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'AI_REVIEW_PROVIDER_CHANGED' });
      const confirmed = await putReview(onBody({ acknowledgeDataSharing: await shownProvider() }));
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({
        consentCurrent: true,
        consent: {
          providerUrl: 'https://llm.example/v1',
          providerHost: 'llm.example',
          model: 'other-model',
        },
      });
      expect((await contextOf(project.key, bearer(projectToken))).json()).toMatchObject({
        review: true,
        reason: null,
      });
    });

    it('a new host makes the consent outdated too, and a warning given for one host never covers another', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      const moved = await changeProvider({
        baseUrl: 'https://llm.elsewhere.example/v1',
        apiKey: null,
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await getReview()).json()).toMatchObject({
        consentCurrent: false,
        provider: { host: 'llm.elsewhere.example', model: 'fake-model' },
      });
      expect((await contextOf(project.key, bearer(projectToken))).json()).toMatchObject({
        review: false,
        reason: 'consent_outdated',
      });
      // Back to the first host: the first warning covers it again.
      const back = await changeProvider({ baseUrl: PROVIDER.baseUrl, apiKey: null });
      expect(back.statusCode, back.body).toBe(200);
      expect((await getReview()).json()).toMatchObject({ consentCurrent: true });
    });

    it('a changed base path outdates the consent', async () => {
      const first = (await putReview(onBody())).json();
      expect(first.consent.providerUrl).toBe('https://llm.example/v1');
      // The same host and model, another path: a gateway that puts the tenant there (R10).
      const moved = await changeProvider({
        baseUrl: 'https://llm.example/tenant-b/v1',
        apiKey: null,
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const read = (await getReview()).json();
      expect(read).toMatchObject({
        enabled: true,
        consentCurrent: false,
        provider: { host: 'llm.example', model: 'fake-model' },
        consent: { providerUrl: 'https://llm.example/v1' },
      });
      const context = await contextOf(project.key, bearer(projectToken));
      expect(context.json()).toMatchObject({ review: false, reason: 'consent_outdated' });
      const projectAnswer = await call('GET', `/projects/${project.id}`, orgAdmin.headers);
      expect(projectAnswer.json().aiReview).toEqual({ enabled: false, organizationEnabled: false });
      // The notice names the host and the model, which did not change: confirming gives the new address.
      const confirmed = await putReview(onBody({ acknowledgeDataSharing: read.provider }));
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({
        consentCurrent: true,
        consent: { providerUrl: 'https://llm.example/tenant-b/v1', providerHost: 'llm.example' },
      });
      expect((await contextOf(project.key, bearer(projectToken))).json()).toMatchObject({
        review: true,
        reason: null,
      });
      // Back to the first path: the consent now names the second, so it is outdated again.
      expect((await changeProvider({ baseUrl: PROVIDER.baseUrl, apiKey: null })).statusCode).toBe(
        200,
      );
      expect((await getReview()).json()).toMatchObject({ consentCurrent: false });
    });

    it('the provider changed between the GET and the PUT: the acknowledgement of the old provider stores nothing (R10)', async () => {
      // The admin's GET shows host A and its notice.
      const shown = await shownProvider();
      expect(shown).toEqual({ host: 'llm.example', model: 'fake-model' });
      const before = (await events('organization.ai_review_changed')).length;
      // The instance admin switches to host B before the admin's PUT arrives.
      const switched = await changeProvider({
        baseUrl: 'https://llm.elsewhere.example/v1',
        apiKey: null,
      });
      expect(switched.statusCode, switched.body).toBe(200);
      const refused = await putReview(onBody({ acknowledgeDataSharing: shown }));
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'AI_REVIEW_PROVIDER_CHANGED' });
      // Nothing is stored: review is still off and no consent was recorded, nor an audit event.
      expect(await storedReview()).toEqual(DEFAULT_REVIEW);
      expect(await events('organization.ai_review_changed')).toHaveLength(before);
      expect((await contextOf(project.key, bearer(projectToken))).json()).toMatchObject({
        review: false,
        reason: 'review_disabled',
      });
      // Acknowledging host B, which the GET now shows, is accepted.
      const nowShown = await shownProvider();
      expect(nowShown).toEqual({ host: 'llm.elsewhere.example', model: 'fake-model' });
      const accepted = await putReview(onBody({ acknowledgeDataSharing: nowShown }));
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toMatchObject({
        enabled: true,
        consentCurrent: true,
        consent: {
          providerUrl: 'https://llm.elsewhere.example/v1',
          providerHost: 'llm.elsewhere.example',
          model: 'fake-model',
        },
      });
      expect(await events('organization.ai_review_changed')).toHaveLength(before + 1);
    });

    it('a model changed between the GET and the PUT is refused the same way', async () => {
      const shown = await shownProvider();
      expect((await changeProvider({ model: 'another-model' })).statusCode).toBe(200);
      const refused = await putReview(onBody({ acknowledgeDataSharing: shown }));
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'AI_REVIEW_PROVIDER_CHANGED' });
      expect(await storedReview()).toEqual(DEFAULT_REVIEW);
      const accepted = await putReview(
        onBody({ acknowledgeDataSharing: { host: 'llm.example', model: 'another-model' } }),
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().consent).toMatchObject({ model: 'another-model' });
    });

    it('confirming again after a provider change is refused when the provider changed once more', async () => {
      const firstConsent = (await putReview(onBody())).json().consent;
      expect((await changeProvider({ model: 'second-model' })).statusCode).toBe(200);
      // The admin's GET shows the second model (consentCurrent is false) ...
      const shown = await shownProvider();
      expect(shown).toEqual({ host: 'llm.example', model: 'second-model' });
      // ... and the instance admin changes it again before the PUT.
      expect((await changeProvider({ model: 'third-model' })).statusCode).toBe(200);
      const refused = await putReview(onBody({ acknowledgeDataSharing: shown }));
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'AI_REVIEW_PROVIDER_CHANGED' });
      // The consent on record is still the first one, and reviews stay stopped.
      expect(await storedReview()).toMatchObject({ enabled: true, consent: firstConsent });
      expect((await contextOf(project.key, bearer(projectToken))).json()).toMatchObject({
        review: false,
        reason: 'consent_outdated',
      });
      const accepted = await putReview(onBody({ acknowledgeDataSharing: await shownProvider() }));
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().consent).toMatchObject({ model: 'third-model' });
    });

    it('takes the host of the acknowledgement in any case, and the model as it is', async () => {
      const shouted = await putReview(
        onBody({ acknowledgeDataSharing: { host: 'LLM.Example', model: 'fake-model' } }),
      );
      expect(shouted.statusCode, shouted.body).toBe(200);
      // The consent records the provider's host as it is, not as it was typed.
      expect(shouted.json().consent).toMatchObject({ providerHost: 'llm.example' });
      await putReview(onBody({ enabled: false }));
      const other = await putReview(
        onBody({ acknowledgeDataSharing: { host: 'llm.example', model: 'Fake-Model' } }),
      );
      expect(other.statusCode).toBe(409);
      expect(other.json()).toMatchObject({ code: 'AI_REVIEW_PROVIDER_CHANGED' });
    });

    it('records the provider’s normalised address in the consent, however it was stored', async () => {
      await configure({}, { ...PROVIDER, baseUrl: 'HTTPS://LLM.Example:443/v1/' });
      expect((await getReview()).json().provider).toEqual({
        host: 'llm.example',
        model: 'fake-model',
      });
      const res = await putReview(onBody());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        consentCurrent: true,
        consent: { providerUrl: 'https://llm.example/v1', providerHost: 'llm.example' },
      });
    });

    it('reads a consent stored without its base URL as none and keeps the provider (fail closed)', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      // The row as an earlier version wrote it: the consent does not name the address yet.
      const [row] = await ctx.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, 'llm'));
      const value = JSON.parse(JSON.stringify(row!.value)) as {
        organizations: Record<string, { review: { consent: Record<string, unknown> } }>;
      };
      delete value.organizations[org]!.review.consent.providerUrl;
      await ctx.db.update(instanceSettings).set({ value }).where(eq(instanceSettings.key, 'llm'));
      expect((await getReview()).json()).toMatchObject({
        available: true,
        provider: { host: 'llm.example', model: 'fake-model' },
        enabled: true,
        consent: null,
        consentCurrent: false,
      });
      expect((await contextOf(project.key, bearer(projectToken))).json()).toMatchObject({
        review: false,
        reason: 'consent_outdated',
      });
      const refused = await putReview(onBody({ acknowledgeDataSharing: undefined }));
      expect(refused.json()).toMatchObject({ code: 'AI_REVIEW_CONSENT_REQUIRED' });
      const confirmed = await putReview(onBody());
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().consent).toMatchObject({ providerUrl: 'https://llm.example/v1' });
    });

    it('answers 422 PROJECT_NOT_IN_ORGANIZATION for the project of another organisation', async () => {
      const res = await putReview(onBody({ projectIds: [project.id, otherProject.id] }));
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: 'PROJECT_NOT_IN_ORGANIZATION' });
      expect(paths(res)).toEqual(['body.projectIds.1']);
      expect(await storedReview()).toEqual(DEFAULT_REVIEW);
      // The other organisation's admin cannot use it either: it is theirs.
      expect(
        (await putReview(onBody({ projectIds: [project.id] }), admin, otherOrg)).statusCode,
      ).toBe(422);
      // The refusal comes before the state is looked at.
      await configure({}, null);
      const first = await putReview(onBody({ projectIds: [otherProject.id] }));
      expect(first.statusCode).toBe(422);
    });

    it('drops the id of a deleted project silently', async () => {
      const gone = await createProject(ctx, admin, { organizationId: org, key: 'rv/gone' });
      const saved = await putReview(onBody({ projectIds: [project.id, gone.id] }));
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().projectIds).toEqual([project.id, gone.id].sort());
      expect(
        (
          await call(
            'DELETE',
            `/projects/${gone.id}?confirm=${encodeURIComponent(gone.key)}`,
            admin.headers,
          )
        ).statusCode,
      ).toBe(204);
      // A read leaves it out; a save that still sends it saves without it, and records no change:
      // the person sees the same list before and after.
      expect((await getReview()).json().projectIds).toEqual([project.id]);
      const recorded = (await events('organization.ai_review_changed')).length;
      const again = await putReview(onBody({ projectIds: [project.id, gone.id] }));
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().projectIds).toEqual([project.id]);
      expect((await storedReview()).projectIds).toEqual([project.id]);
      expect(await events('organization.ai_review_changed')).toHaveLength(recorded);
      // An id that never existed is a deleted project too.
      const never = await putReview(
        onBody({ projectIds: [project.id, '00000000-0000-7000-8000-00000000dead'] }),
      );
      expect(never.statusCode, never.body).toBe(200);
      expect(never.json().projectIds).toEqual([project.id]);
    });

    it('takes a project id in upper case for the project it names', async () => {
      const res = await putReview(onBody({ projectIds: [project.id.toUpperCase()] }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().projectIds).toEqual([project.id]);
      expect((await storedReview()).projectIds).toEqual([project.id]);
      // And another organisation's project is refused whatever the case.
      const foreign = await putReview(onBody({ projectIds: [otherProject.id.toUpperCase()] }));
      expect(foreign.statusCode).toBe(422);
      expect(foreign.json()).toMatchObject({ code: 'PROJECT_NOT_IN_ORGANIZATION' });
    });

    it('stores each project once, in order', async () => {
      const res = await putReview(onBody({ projectIds: [second.id, project.id, second.id] }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().projectIds).toEqual([project.id, second.id].sort());
      expect((await storedReview()).projectIds).toEqual([project.id, second.id].sort());
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['an unknown field', { extra: 1 }, 'body'],
      ['a scope that is neither', { scope: 'some' }, 'body.scope'],
      ['a project id that is not a UUID', { projectIds: ['p1'] }, 'body.projectIds.0'],
      ['enabled as text', { enabled: 'yes' }, 'body.enabled'],
      [
        'negative daily tokens',
        { budgets: { ...DEFAULT_REVIEW.budgets, tokensPerDay: -1 } },
        'body.budgets.tokensPerDay',
      ],
      [
        'fractional tokens per review',
        { budgets: { ...DEFAULT_REVIEW.budgets, maxTokensPerReview: 1.5 } },
        'body.budgets.maxTokensPerReview',
      ],
      [
        'no tokens per review',
        { budgets: { ...DEFAULT_REVIEW.budgets, maxTokensPerReview: 0 } },
        'body.budgets.maxTokensPerReview',
      ],
      [
        'a negative cost',
        { budgets: { ...DEFAULT_REVIEW.budgets, costPerDayUsd: -1 } },
        'body.budgets.costPerDayUsd',
      ],
      ['budgets missing', { budgets: undefined }, 'body.budgets'],
      ['acknowledgement as text', { acknowledgeDataSharing: 'yes' }, 'body.acknowledgeDataSharing'],
      [
        'acknowledgement as true (the form before it named the provider)',
        { acknowledgeDataSharing: true },
        'body.acknowledgeDataSharing',
      ],
      [
        'acknowledgement without the model',
        { acknowledgeDataSharing: { host: 'llm.example' } },
        'body.acknowledgeDataSharing.model',
      ],
      [
        'acknowledgement without the host',
        { acknowledgeDataSharing: { model: 'fake-model' } },
        'body.acknowledgeDataSharing.host',
      ],
      [
        'acknowledgement with an empty host',
        { acknowledgeDataSharing: { host: '', model: 'fake-model' } },
        'body.acknowledgeDataSharing.host',
      ],
      [
        'acknowledgement with a field of its own',
        { acknowledgeDataSharing: { ...SHOWN, extra: 1 } },
        'body.acknowledgeDataSharing',
      ],
      [
        'acknowledgement with a host that is not text',
        { acknowledgeDataSharing: { host: 1, model: 'fake-model' } },
        'body.acknowledgeDataSharing.host',
      ],
    ])('answers 422 for %s', async (_name, over, path) => {
      const res = await putReview(onBody(over));
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(paths(res)).toContain(path);
      expect(await storedReview()).toEqual(DEFAULT_REVIEW);
    });

    it('answers 422 for more than 1 000 projects, and accepts 1 000', async () => {
      const ids = Array.from(
        { length: 1_001 },
        (_, i) => `00000000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
      );
      const over = await putReview(onBody({ projectIds: ids }));
      expect(over.statusCode).toBe(422);
      expect(paths(over)).toContain('body.projectIds');
      // Ids of no project are dropped, so a full list is accepted (and stores none).
      expect((await putReview(onBody({ projectIds: ids.slice(0, 1_000) }))).statusCode).toBe(200);
    });

    it('accepts the bounds of the budgets', async () => {
      const low = {
        tokensPerDay: 0,
        costPerDayUsd: 0,
        perProjectTokensPerDay: 0,
        maxTokensPerReview: 1,
      };
      const high = {
        tokensPerDay: 1_000_000_000,
        costPerDayUsd: 1_000_000,
        perProjectTokensPerDay: 1_000_000_000,
        maxTokensPerReview: 10_000_000,
      };
      for (const budgets of [low, high]) {
        const res = await putReview(onBody({ budgets }));
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().budgets).toEqual(budgets);
      }
      for (const budgets of [
        { ...high, tokensPerDay: 1_000_000_001 },
        { ...high, maxTokensPerReview: 10_000_001 },
        { ...high, costPerDayUsd: 1_000_001 },
        { ...high, perProjectTokensPerDay: 1_000_000_001 },
      ]) {
        expect((await putReview(onBody({ budgets }))).statusCode).toBe(422);
      }
    });

    it('keeps a budget above the instance ceiling as it was set', async () => {
      await configure({}, PROVIDER, { reviewTokensPerOrganizationPerDay: 1_000 });
      const res = await putReview(
        onBody({ budgets: { ...DEFAULT_REVIEW.budgets, tokensPerDay: 5_000_000 } }),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        budgets: { tokensPerDay: 5_000_000 },
        instanceCeiling: { tokensPerDay: 1_000 },
      });
    });

    it('leaves the review settings of other organisations as they are', async () => {
      await writeLlmSettings(ctx.db, {
        ...DEFAULT_LLM_SETTINGS,
        provider: PROVIDER,
        organizations: {
          [org]: ORG_ON,
          [otherOrg]: {
            ...ORG_ON,
            review: { ...DEFAULT_REVIEW, projectIds: [], enabled: true, scope: 'all' },
          },
        },
      });
      expect((await putReview(onBody())).statusCode).toBe(200);
      const stored = await readLlmSettings(ctx.db);
      expect(reviewSettingsOf(stored, otherOrg)).toMatchObject({ enabled: true, scope: 'all' });
      expect(reviewSettingsOf(stored, org)).toMatchObject({ enabled: true, scope: 'selected' });
    });

    it('creates the entry of an organisation absent from the map, disabled for the AI assistant', async () => {
      // The review needs the organisation enabled to be switched on, but its settings can be
      // saved off: the entry holds the review block and nothing else.
      await writeLlmSettings(ctx.db, { ...DEFAULT_LLM_SETTINGS, provider: PROVIDER });
      const budgets = { ...DEFAULT_REVIEW.budgets, tokensPerDay: 123 };
      const res = await putReview(
        onBody({ enabled: false, budgets, acknowledgeDataSharing: undefined }),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect((await readLlmSettings(ctx.db)).organizations[org]).toEqual({
        enabled: false,
        features: { explain: false, triage: false, fix: false },
        excludedProjectIds: [],
        autoFix: { ...DEFAULT_AUTO_FIX },
        autoFixDisabledProjectIds: [],
        review: { ...DEFAULT_REVIEW, projectIds: [project.id], budgets, consent: null },
      });
    });
  });

  describe('the audit event organization.ai_review_changed', () => {
    it('is recorded once for a change, with the provider and the consent, and not for the same values', async () => {
      const before = (await events('organization.ai_review_changed')).length;
      expect((await putReview(onBody({ projectIds: [project.id, second.id] }))).statusCode).toBe(
        200,
      );
      const [event] = (await events('organization.ai_review_changed')).slice(before);
      expect(event).toMatchObject({
        organizationId: org,
        organizationKey: 'default',
        targetType: 'organization',
        targetId: org,
        actorUserId: orgAdminId,
        outcome: 'success',
        details: {
          enabled: true,
          scope: 'selected',
          projects: 2,
          consentGiven: true,
          providerHost: 'llm.example',
          model: 'fake-model',
        },
      });
      expect(Object.keys(event!.details as object).sort()).toEqual([
        'consentGiven',
        'enabled',
        'model',
        'projects',
        'providerHost',
        'scope',
      ]);
      // The same body again, with or without the acknowledgement: nothing changed.
      expect((await putReview(onBody({ projectIds: [project.id, second.id] }))).statusCode).toBe(
        200,
      );
      expect(
        (
          await putReview(
            onBody({ projectIds: [second.id, project.id], acknowledgeDataSharing: undefined }),
          )
        ).statusCode,
      ).toBe(200);
      expect(await events('organization.ai_review_changed')).toHaveLength(before + 1);
    });

    it('records a later change without a consent, and a switch-off without a provider', async () => {
      const before = (await events('organization.ai_review_changed')).length;
      await putReview(onBody());
      await putReview(onBody({ scope: 'all', acknowledgeDataSharing: undefined }));
      await configure({ review: await storedReview() }, null);
      await putReview(onBody({ enabled: false, acknowledgeDataSharing: undefined }));
      const added = (await events('organization.ai_review_changed')).slice(before);
      expect(added.map((e) => e.details)).toEqual([
        {
          enabled: true,
          scope: 'selected',
          projects: 1,
          consentGiven: true,
          providerHost: 'llm.example',
          model: 'fake-model',
        },
        {
          enabled: true,
          scope: 'all',
          projects: 1,
          consentGiven: false,
          providerHost: 'llm.example',
          model: 'fake-model',
        },
        {
          enabled: false,
          scope: 'selected',
          projects: 1,
          consentGiven: false,
          providerHost: null,
          model: null,
        },
      ]);
    });

    it('records nothing for a refused change', async () => {
      const before = (await events('organization.ai_review_changed')).length;
      await putReview(onBody({ acknowledgeDataSharing: undefined }));
      await putReview(
        onBody({ acknowledgeDataSharing: { host: 'llm.elsewhere.example', model: 'fake-model' } }),
      );
      await putReview(onBody({ projectIds: [otherProject.id] }));
      await putReview(onBody({ scope: 'some' }));
      expect(await events('organization.ai_review_changed')).toHaveLength(before);
    });
  });

  describe('/system/llm and the review settings', () => {
    it('neither shows nor accepts the review of an organisation', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      const body = await settingsBody();
      expect(body.organizations[org]).not.toHaveProperty('review');
      body.organizations[org] = { ...body.organizations[org], review: await storedReview() };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(422);
      expect(paths(res)).toContain(`body.organizations.${org}`);
    });

    it('keeps the review of an organisation when a save leaves it out', async () => {
      const first = (await putReview(onBody())).json();
      // The instance admin's form sends only the fields it edits.
      const body = await settingsBody();
      body.organizations[org] = {
        enabled: true,
        features: { explain: true, triage: true, fix: true },
        excludedProjectIds: [],
      };
      body.budgets = { ...body.budgets, explainPerDay: 99 };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().organizations[org]).not.toHaveProperty('review');
      expect(await storedReview()).toMatchObject({ enabled: true, consent: first.consent });
      expect((await getReview()).json()).toMatchObject({ enabled: true, consentCurrent: true });
      const [event] = (await events('ai.settings_updated')).slice(-1);
      expect((event!.details as { changed: string[] }).changed).not.toContain('review');
    });

    it('keeps the review of an organisation a stale form leaves out, and drops it with the organisation', async () => {
      await writeLlmSettings(ctx.db, {
        ...DEFAULT_LLM_SETTINGS,
        provider: PROVIDER,
        organizations: { [org]: ORG_ON, [otherOrg]: ORG_ON },
      });
      expect((await putReview(onBody(), admin)).statusCode).toBe(200);
      const first = await storedReview();
      expect(
        (await putReview(onBody({ projectIds: [otherProject.id] }), admin, otherOrg)).statusCode,
      ).toBe(200);
      // The form loaded before: only `org`.
      const body = await settingsBody();
      body.organizations = { [org]: body.organizations[org] };
      const res = await call('PUT', '/system/llm', admin.headers, body);
      expect(res.statusCode, res.body).toBe(200);
      const saved = await readLlmSettings(ctx.db);
      // Its switches go, as for any organisation a save leaves out; its review choice stays.
      expect(saved.organizations[otherOrg]).toMatchObject({
        enabled: false,
        review: { enabled: true, projectIds: [otherProject.id] },
      });
      expect(reviewSettingsOf(saved, org)).toEqual(first);
      expect((await getReview(admin, otherOrg)).json()).toMatchObject({
        available: false,
        unavailableReason: 'organization_disabled',
        enabled: true,
      });
    });

    it('sets and reads the instance ceiling, and a body without it clears it', async () => {
      const body = await settingsBody();
      expect(body.budgets.reviewTokensPerOrganizationPerDay).toBeNull();
      body.budgets = { ...body.budgets, reviewTokensPerOrganizationPerDay: 750_000 };
      const set = await call('PUT', '/system/llm', admin.headers, body);
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().budgets.reviewTokensPerOrganizationPerDay).toBe(750_000);
      expect((await getReview()).json()).toMatchObject({
        instanceCeiling: { tokensPerDay: 750_000 },
      });
      const without = { ...body.budgets };
      delete without.reviewTokensPerOrganizationPerDay;
      const cleared = await call('PUT', '/system/llm', admin.headers, {
        ...body,
        budgets: without,
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().budgets.reviewTokensPerOrganizationPerDay).toBeNull();
      for (const bad of [-1, 1.5, 1_000_000_001]) {
        const refused = await call('PUT', '/system/llm', admin.headers, {
          ...body,
          budgets: { ...body.budgets, reviewTokensPerOrganizationPerDay: bad },
        });
        expect(refused.statusCode, String(bad)).toBe(422);
        expect(paths(refused)).toContain('body.budgets.reviewTokensPerOrganizationPerDay');
      }
    });
  });

  describe('GET /projects/review-context', () => {
    const limits = {
      maxCompressedBytes: 50 * MiB,
      maxDecompressedBytes: 500 * MiB,
      maxFileBytes: MAX_SNAPSHOT_FILE_BYTES,
      maxFiles: MAX_SNAPSHOT_FILES,
    };

    it('answers true for a selected and mapped project with its token, and the limits', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      const res = await contextOf(project.key, bearer(projectToken));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        review: true,
        reason: null,
        lastReviewedCommit: null,
        limits,
      });
      expect(limits).toEqual({
        maxCompressedBytes: 52_428_800,
        maxDecompressedBytes: 524_288_000,
        maxFileBytes: 1_048_576,
        maxFiles: 50_000,
      });
    });

    it('answers not_mapped for a project without an SCM connection', async () => {
      expect((await putReview(onBody({ scope: 'all', projectIds: [] }))).statusCode).toBe(200);
      const res = await contextOf(unmapped.key, bearer(unmappedToken));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        review: false,
        reason: 'not_mapped',
        lastReviewedCommit: null,
        limits,
      });
    });

    it('answers 404 PROJECT_NOT_FOUND with the token of another project, and for an unknown one', async () => {
      expect((await putReview(onBody({ scope: 'all', projectIds: [] }))).statusCode).toBe(200);
      for (const [key, token] of [
        [project.key, otherToken],
        [project.key, unmappedToken],
        [otherProject.key, projectToken],
        ['rv/does-not-exist', projectToken],
      ] as const) {
        const res = await contextOf(key, bearer(token));
        expect([key, res.statusCode, res.json().code]).toEqual([key, 404, 'PROJECT_NOT_FOUND']);
      }
    });

    it('answers each reason a project is not reviewed for', async () => {
      const reasonOf = async (key = project.key, token = projectToken) => {
        const res = await contextOf(key, bearer(token));
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as { review: boolean; reason: string | null };
      };
      await configure({}, null);
      expect(await reasonOf()).toMatchObject({ review: false, reason: 'no_provider' });
      await configure({ enabled: false });
      expect(await reasonOf()).toMatchObject({ review: false, reason: 'organization_disabled' });
      await configure();
      expect(await reasonOf()).toMatchObject({ review: false, reason: 'review_disabled' });
      expect((await putReview(onBody({ projectIds: [second.id] }))).statusCode).toBe(200);
      expect(await reasonOf()).toMatchObject({ review: false, reason: 'project_not_selected' });
      expect(
        await reasonOf(second.key, await createProjectToken(ctx, admin, second.id)),
      ).toMatchObject({
        review: true,
        reason: null,
      });
      // The organisation excludes the project from the AI assistant.
      await configure({ excludedProjectIds: [second.id], review: await storedReview() }, PROVIDER);
      expect(
        await reasonOf(second.key, await createProjectToken(ctx, admin, second.id)),
      ).toMatchObject({
        review: false,
        reason: 'project_not_selected',
      });
    });

    it('answers a user with project.analyze and a token that may upload', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      const ok = (res: { statusCode: number; json: () => { review: boolean } }) => [
        res.statusCode,
        res.json().review,
      ];
      expect(ok(await contextOf(project.key, orgAdmin))).toEqual([200, true]);
      expect(ok(await contextOf(project.key, member))).toEqual([200, true]);
      expect(ok(await contextOf(project.key, bearer(uploadToken)))).toEqual([200, true]);
      // A viewer reads but does not upload; a personal token needs the scope analysis:write, which
      // no other scope includes.
      const viewing = await contextOf(project.key, viewer);
      expect([viewing.statusCode, viewing.json().code]).toEqual([403, 'FORBIDDEN']);
      for (const token of [readToken, writeToken, adminToken]) {
        const refused = await contextOf(project.key, bearer(token));
        expect([refused.statusCode, refused.json().code]).toEqual([403, 'INSUFFICIENT_SCOPE']);
      }
      // Not even visible: the same 404 as an unknown project.
      const hidden = await contextOf(project.key, outsider);
      expect([hidden.statusCode, hidden.json().code]).toEqual([404, 'PROJECT_NOT_FOUND']);
      const unauthenticated = await call(
        'GET',
        `/projects/review-context?projectKey=${project.key}&mergeRequest=7`,
        {},
      );
      expect(unauthenticated.statusCode).toBe(401);
    });

    it.each([
      ['a merge request that is not a number', 'abc'],
      ['a negative number', '-1'],
      ['more than ten digits', '12345678901'],
      ['an empty one', ''],
      ['a decimal', '1.5'],
    ])('answers 422 for %s', async (_name, mergeRequest) => {
      const res = await contextOf(project.key, bearer(projectToken), mergeRequest);
      expect(res.statusCode, res.body).toBe(422);
      expect(paths(res)).toContain('query.mergeRequest');
    });

    it('accepts ten digits and answers 422 for a query that is incomplete or has more', async () => {
      expect((await contextOf(project.key, bearer(projectToken), '1234567890')).statusCode).toBe(
        200,
      );
      expect((await contextOf(project.key, bearer(projectToken), '007')).statusCode).toBe(200);
      const headers = bearer(projectToken);
      for (const query of [
        `projectKey=${project.key}`,
        'mergeRequest=7',
        '',
        `projectKey=${project.key}&mergeRequest=7&extra=1`,
        `projectKey=${encodeURIComponent('bad key!')}&mergeRequest=7`,
      ]) {
        const res = await call('GET', `/projects/review-context?${query}`, headers);
        expect([query, res.statusCode]).toEqual([query, 422]);
      }
    });

    it('is not shadowed by the project routes', async () => {
      // `review-context` is not a project id: the route answers, not GET /projects/:id.
      const res = await call(
        'GET',
        `/projects/review-context?projectKey=${project.key}&mergeRequest=1`,
        orgAdmin.headers,
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toHaveProperty('limits');
    });
  });

  describe('the project DTO’s aiReview', () => {
    const dtoOf = async (p: { id: string } = project, caller: Caller = orgAdmin) =>
      (await call('GET', `/projects/${p.id}`, headersOf(caller))).json().aiReview;

    it('is off for everything by default', async () => {
      expect(await dtoOf()).toEqual({ enabled: false, organizationEnabled: false });
      expect(await dtoOf(otherProject, admin)).toEqual({
        enabled: false,
        organizationEnabled: false,
      });
    });

    it('says whether it is on for the project, and whether the organisation has it on', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      expect(await dtoOf()).toEqual({ enabled: true, organizationEnabled: true });
      // Another project of the organisation: the organisation has it on, the project is not selected.
      expect(await dtoOf(second)).toEqual({ enabled: false, organizationEnabled: true });
      // Every project with the scope all (a mapping does not matter to the settings).
      expect((await putReview(onBody({ scope: 'all', projectIds: [] }))).statusCode).toBe(200);
      for (const p of [project, second, unmapped]) {
        expect(await dtoOf(p), p.key).toEqual({ enabled: true, organizationEnabled: true });
      }
      // The other organisation is not affected.
      expect(await dtoOf(otherProject, admin)).toEqual({
        enabled: false,
        organizationEnabled: false,
      });
    });

    it('is off for every project while the organisation or the provider lacks something', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      const on = await storedReview();
      await configure({ enabled: false, review: on });
      expect(await dtoOf()).toEqual({ enabled: false, organizationEnabled: false });
      await configure({ review: on }, null);
      expect(await dtoOf()).toEqual({ enabled: false, organizationEnabled: false });
      await configure({ review: { ...on, enabled: false } });
      expect(await dtoOf()).toEqual({ enabled: false, organizationEnabled: false });
    });

    it('is off for everything while the consent is outdated', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      expect((await changeProvider({ model: 'another-model' })).statusCode).toBe(200);
      expect(await dtoOf()).toEqual({ enabled: false, organizationEnabled: false });
      const confirmed = await putReview(onBody({ acknowledgeDataSharing: await shownProvider() }));
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(await dtoOf()).toEqual({ enabled: true, organizationEnabled: true });
    });

    it('is off for a project the organisation excludes from the AI assistant', async () => {
      expect((await putReview(onBody({ scope: 'all', projectIds: [] }))).statusCode).toBe(200);
      await configure({ excludedProjectIds: [second.id], review: await storedReview() });
      expect(await dtoOf(second)).toEqual({ enabled: false, organizationEnabled: true });
      expect(await dtoOf(project)).toEqual({ enabled: true, organizationEnabled: true });
    });

    it('is in the project list too, for each project', async () => {
      expect((await putReview(onBody())).statusCode).toBe(200);
      const list = await call('GET', '/projects?limit=100', orgAdmin.headers);
      const items = list.json().items as { id: string; aiReview: unknown }[];
      expect(items.find((p) => p.id === project.id)?.aiReview).toEqual({
        enabled: true,
        organizationEnabled: true,
      });
      expect(items.find((p) => p.id === second.id)?.aiReview).toEqual({
        enabled: false,
        organizationEnabled: true,
      });
    });
  });
});
