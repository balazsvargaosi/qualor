import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  ADMIN_PASSWORD,
  bearer,
  createTestContext,
  createUser,
  login,
  organizationId,
  type Session,
  type TestContext,
} from '../../test/app';

interface Found {
  id: string;
  username: string;
  displayName: string | null;
}

/** GET /users/search: the user picker's suggestions (an org admin adds a member by prefix). */
describe('GET /users/search', () => {
  let ctx: TestContext;
  let root: Session;
  let orgAdmin: Session;
  let maintainer: Session;
  let projectAdmin: Session;
  let viewer: Session;
  let outsider: Session;
  let defaultOrg: string;
  let viewedOrg: string;
  let hiddenOrg: string;

  const get = (headers: Record<string, string>, url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v0${url}`, headers });
  const names = (res: { json(): unknown }) =>
    (res.json() as { users: Found[] }).users.map((u) => u.username);
  const paths = (res: { json(): unknown }) =>
    ((res.json() as { errors?: { path: string }[] }).errors ?? []).map((e) => e.path);

  async function organization(key: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/organizations',
      headers: root.headers,
      payload: { key, name: key },
    });
    if (created.statusCode !== 201) throw new Error(`organization: ${created.body}`);
    return (created.json() as { id: string }).id;
  }

  async function personalToken(session: Session, scopes: string[]) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v0/tokens',
      headers: session.headers,
      payload: { name: `s-${scopes.join('-')}`, scopes },
    });
    if (res.statusCode !== 201) throw new Error(`token: ${res.statusCode} ${res.body}`);
    return bearer((res.json() as { token: string }).token);
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    root = await login(ctx, 'admin', ADMIN_PASSWORD);
    defaultOrg = await organizationId(ctx, 'default');
    viewedOrg = await organization('viewed');
    hiddenOrg = await organization('hidden');
    const session = async (username: string, role: Parameters<typeof addMember>[3] | null) => {
      const u = await createUser(ctx, { username });
      if (role) await addMember(ctx, defaultOrg, u.id, role);
      return { id: u.id, session: await login(ctx, username, u.password) };
    };
    const ada = await session('ada', 'admin');
    orgAdmin = ada.session;
    maintainer = (await session('max', 'member')).session;
    projectAdmin = (await session('pam', 'project_admin')).session;
    viewer = (await session('vic', 'viewer')).session;
    outsider = (await session('otto', null)).session;
    // ada sees `viewed` (a viewer there) but cannot manage its members; `hidden` is invisible.
    await addMember(ctx, viewedOrg, ada.id, 'viewer');

    const alice = await createUser(ctx, {
      username: 'alice',
      displayName: 'Alice Smith',
      email: 'alice@example.com',
    });
    await addMember(ctx, defaultOrg, alice.id, 'member');
    await createUser(ctx, { username: 'Albert', displayName: 'Bert', email: 'bert@example.com' });
    await createUser(ctx, { username: 'bob', displayName: 'Alfred Bob' });
    await createUser(ctx, { username: 'alvin', displayName: 'Alvin Gone', active: false });
    await createUser(ctx, { username: 'x_ray' });
    await createUser(ctx, { username: 'xoray' });
    await createUser(ctx, { username: 'pct-one', displayName: '50% off' });
    await createUser(ctx, { username: 'pct-two', displayName: '50 percent' });
    for (let n = 1; n <= 12; n += 1) {
      await createUser(ctx, { username: `lim${String(n).padStart(2, '0')}` });
    }
  });
  afterAll(async () => ctx.close());

  it('answers an org admin and an instance admin; refuses maintainers, project admins, viewers and outsiders', async () => {
    const found = await get(orgAdmin.headers, '/users/search?q=al');
    expect(found.statusCode).toBe(200);
    expect(names(found)).toEqual(['Albert', 'alice', 'bob']);
    expect((await get(root.headers, '/users/search?q=al')).statusCode).toBe(200);
    for (const s of [maintainer, projectAdmin, viewer, outsider]) {
      const refused = await get(s.headers, '/users/search?q=al');
      expect([refused.statusCode, (refused.json() as { code: string }).code]).toEqual([
        403,
        'FORBIDDEN',
      ]);
    }
    expect((await get({}, '/users/search?q=al')).statusCode).toBe(401);
  });

  it('needs a token of the admin scope', async () => {
    for (const scopes of [['read'], ['write']]) {
      const res = await get(await personalToken(orgAdmin, scopes), '/users/search?q=al');
      expect([res.statusCode, (res.json() as { code: string }).code]).toEqual([
        403,
        'INSUFFICIENT_SCOPE',
      ]);
    }
    const admin = await get(await personalToken(orgAdmin, ['admin']), '/users/search?q=al');
    expect(admin.statusCode).toBe(200);
  });

  it('matches a prefix of the username or the display name, ignoring case, ordered by username', async () => {
    expect(names(await get(orgAdmin.headers, '/users/search?q=AL'))).toEqual([
      'Albert',
      'alice',
      'bob',
    ]);
    // display name only: "Alfred Bob"; a word inside the name is not a prefix.
    expect(names(await get(orgAdmin.headers, '/users/search?q=alF'))).toEqual(['bob']);
    expect(names(await get(orgAdmin.headers, '/users/search?q=smith'))).toEqual([]);
    expect(names(await get(orgAdmin.headers, '/users/search?q=ALBE'))).toEqual(['Albert']);
    expect(names(await get(orgAdmin.headers, '/users/search?q=zz'))).toEqual([]);
  });

  it('leaves inactive users out', async () => {
    expect(names(await get(orgAdmin.headers, '/users/search?q=alv'))).toEqual([]);
    expect(names(await get(root.headers, '/users/search?q=alv'))).toEqual([]);
  });

  it('answers id, username and display name only, never the email', async () => {
    const res = await get(orgAdmin.headers, '/users/search?q=al');
    expect(Object.keys(res.json() as object)).toEqual(['users']);
    const users = (res.json() as { users: Found[] }).users;
    for (const u of users) expect(Object.keys(u).sort()).toEqual(['displayName', 'id', 'username']);
    expect(users.find((u) => u.username === 'alice')).toMatchObject({
      displayName: 'Alice Smith',
    });
    expect(res.body).not.toContain('@example.com');
  });

  it('wants 2 characters (1 for an instance admin), at most 64, and no NUL', async () => {
    expect(paths(await get(orgAdmin.headers, '/users/search?q=a'))).toEqual(['query.q']);
    const one = await get(root.headers, '/users/search?q=a');
    expect(one.statusCode).toBe(200);
    expect(names(one)).toContain('ada');
    expect(paths(await get(orgAdmin.headers, '/users/search'))).toEqual(['query.q']);
    expect(paths(await get(root.headers, '/users/search?q='))).toEqual(['query.q']);
    expect(paths(await get(orgAdmin.headers, `/users/search?q=${'a'.repeat(65)}`))).toEqual([
      'query.q',
    ]);
    expect((await get(orgAdmin.headers, `/users/search?q=${'a'.repeat(64)}`)).statusCode).toBe(200);
    expect(paths(await get(orgAdmin.headers, '/users/search?q=al%00'))).toEqual(['query.q']);
    expect(paths(await get(orgAdmin.headers, '/users/search?q=al&extra=1'))).not.toEqual([]);
  });

  it('answers at most 10 users, 10 by default', async () => {
    const all = names(await get(orgAdmin.headers, '/users/search?q=lim'));
    expect(all).toEqual(
      Array.from({ length: 10 }, (_, i) => `lim${String(i + 1).padStart(2, '0')}`),
    );
    expect(names(await get(orgAdmin.headers, '/users/search?q=lim&limit=3'))).toEqual([
      'lim01',
      'lim02',
      'lim03',
    ]);
    expect(paths(await get(orgAdmin.headers, '/users/search?q=lim&limit=11'))).toEqual([
      'query.limit',
    ]);
    expect(paths(await get(orgAdmin.headers, '/users/search?q=lim&limit=0'))).toEqual([
      'query.limit',
    ]);
  });

  it('treats % and _ in q as literal characters', async () => {
    expect(names(await get(orgAdmin.headers, '/users/search?q=x_'))).toEqual(['x_ray']);
    expect(names(await get(orgAdmin.headers, '/users/search?q=50%25'))).toEqual(['pct-one']);
    expect(names(await get(orgAdmin.headers, '/users/search?q=%25%25'))).toEqual([]);
    expect(names(await get(orgAdmin.headers, '/users/search?q=__'))).toEqual([]);
  });

  it('hides the members of excludeOrganization, which the caller must manage', async () => {
    expect(
      names(await get(orgAdmin.headers, `/users/search?q=al&excludeOrganization=${defaultOrg}`)),
    ).toEqual(['Albert', 'bob']);
    expect(
      names(await get(root.headers, `/users/search?q=al&excludeOrganization=${hiddenOrg}`)),
    ).toEqual(['Albert', 'alice', 'bob']);
    // visible but not managed: 403, as the members routes answer; invisible or unknown: 404.
    const viewed = await get(
      orgAdmin.headers,
      `/users/search?q=al&excludeOrganization=${viewedOrg}`,
    );
    expect([viewed.statusCode, (viewed.json() as { code: string }).code]).toEqual([
      403,
      'FORBIDDEN',
    ]);
    const hidden = await get(
      orgAdmin.headers,
      `/users/search?q=al&excludeOrganization=${hiddenOrg}`,
    );
    expect(hidden.statusCode).toBe(404);
    const unknown = await get(
      root.headers,
      '/users/search?q=al&excludeOrganization=00000000-0000-4000-8000-000000000000',
    );
    expect(unknown.statusCode).toBe(404);
    expect(paths(await get(root.headers, '/users/search?q=al&excludeOrganization=nope'))).toEqual([
      'query.excludeOrganization',
    ]);
  });

  it('limits the search to 60 a minute per caller, apart from the lookup', async () => {
    const m = await createUser(ctx, { username: 'mia' });
    await addMember(ctx, defaultOrg, m.id, 'admin');
    const mia = await login(ctx, 'mia', m.password);
    for (let n = 0; n < 60; n += 1) {
      expect((await get(mia.headers, '/users/search?q=al')).statusCode).toBe(200);
    }
    const limited = await get(mia.headers, '/users/search?q=al');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // Another caller from the same address keeps its budget, and the lookup keeps its own.
    expect((await get(orgAdmin.headers, '/users/search?q=al')).statusCode).toBe(200);
    expect((await get(mia.headers, '/users/lookup?username=ada')).statusCode).toBe(200);
  });
});
