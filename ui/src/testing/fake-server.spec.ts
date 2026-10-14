import { FakeServer, FakeUserDirectory, userMatches } from './fake-server';

/** The fake user directory answers as the server's user-picker routes do (review M-7). */
describe('FakeUserDirectory', () => {
  const ALICE = { id: 'u-alice', username: 'alice', displayName: 'Alice Smith' };
  const JL = { id: 'u-jl', username: 'jl', displayName: 'Jean-Luc Picard' };

  async function search(server: FakeServer, query: string) {
    const res = await server.fetch(`http://localhost/api/v0/users/search?${query}`);
    return { status: res.status, body: (await res.json()) as { users?: { username: string }[] } };
  }

  it('matches the start of the username, of the display name or of a word in it', () => {
    expect(userMatches(ALICE, 'ali')).toBe(true);
    expect(userMatches(ALICE, 'SMI')).toBe(true);
    // a q over several words, from the start of the display name.
    expect(userMatches(ALICE, 'alice sm')).toBe(true);
    expect(userMatches(JL, 'luc pic')).toBe(true);
    expect(userMatches(ALICE, 'mith')).toBe(false);
    expect(userMatches(ALICE, 'ice')).toBe(false);
  });

  it('counts the maximum in UTF-16 units, the minimum in characters of q trimmed', async () => {
    const server = new FakeServer();
    new FakeUserDirectory(server, { users: [ALICE] });
    // 33 emoji are 33 characters but 66 UTF-16 units: over 64.
    const emoji = encodeURIComponent(String.fromCodePoint(0x1f600).repeat(33));
    expect((await search(server, `q=${emoji}`)).status).toBe(422);
    expect((await search(server, `q=${'a'.repeat(64)}`)).status).toBe(200);
    expect((await search(server, 'q=%20a%20')).status).toBe(422);
    expect((await search(server, 'q=%20al%20')).body.users?.map((u) => u.username)).toEqual([
      'alice',
    ]);
  });

  it('leaves out the members of excludeOrganization and the grantees of excludeProject', async () => {
    const server = new FakeServer();
    new FakeUserDirectory(server, {
      users: [ALICE, { id: 'u-alan', username: 'alan', displayName: null }],
      memberships: [{ organizationId: 'org', userId: 'u-alice', role: 'member' }],
      grants: [{ projectId: 'p', userId: 'u-alan' }],
    });
    const names = async (query: string) =>
      (await search(server, query)).body.users?.map((u) => u.username);
    expect(await names('q=al')).toEqual(['alan', 'alice']);
    expect(await names('q=al&excludeOrganization=org')).toEqual(['alan']);
    expect(await names('q=al&excludeProject=p')).toEqual(['alice']);
  });
});
