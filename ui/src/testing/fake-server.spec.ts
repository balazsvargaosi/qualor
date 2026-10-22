import { FakeAiReview, FakeServer, FakeUserDirectory, userMatches } from './fake-server';

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
    FakeUserDirectory.install(server, { users: [ALICE] });
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
    FakeUserDirectory.install(server, {
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

/** The fake AI review routes keep the server's consent rules (6I-2, R10 amended). */
describe('FakeAiReview', () => {
  const ORG = '0190a6c2-0000-7000-8000-000000000001';
  const URL = `http://localhost/api/v0/organizations/${ORG}/ai/review`;
  const A = { host: 'llm.example.com', model: 'gpt-review' };
  const B = { host: 'llm2.example.com', model: 'gpt-next' };
  const BUDGETS = {
    tokensPerDay: 1,
    costPerDayUsd: null,
    perProjectTokensPerDay: null,
    maxTokensPerReview: 1,
  };

  async function put(server: FakeServer, enabled: boolean, ack?: { host: string; model: string }) {
    const res = await server.fetch(URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled,
        scope: 'all',
        projectIds: [],
        budgets: BUDGETS,
        ...(ack ? { acknowledgeDataSharing: ack } : {}),
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('answers the defaults with the notice, and no consent', async () => {
    const server = new FakeServer();
    FakeAiReview.install(server);
    const body = (await (await server.fetch(URL)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      unavailableReason: null,
      provider: A,
      enabled: false,
      scope: 'selected',
      projectIds: [],
      consent: null,
      consentCurrent: false,
      instanceCeiling: { tokensPerDay: null },
    });
    expect(body['notice']).toContain('to llm.example.com (gpt-review).');
  });

  it('needs the acknowledgement of the provider now to switch on, and nothing to switch off', async () => {
    const server = new FakeServer();
    const fake = FakeAiReview.install(server);
    expect((await put(server, true)).body['code']).toBe('AI_REVIEW_CONSENT_REQUIRED');
    expect((await put(server, true, B)).body['code']).toBe('AI_REVIEW_PROVIDER_CHANGED');
    expect(fake.of(ORG).enabled).toBe(false);
    const saved = await put(server, true, A);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, consentCurrent: true });
    // Already on with a current consent: no acknowledgement needed to save again, or to switch off.
    expect((await put(server, true)).status).toBe(200);
    expect((await put(server, false)).status).toBe(200);
  });

  it('makes the consent outdated when the provider changes, until it is acknowledged again', async () => {
    const server = new FakeServer();
    const fake = FakeAiReview.install(server);
    await put(server, true, A);
    fake.changeProvider(B);
    const outdated = (await (await server.fetch(URL)).json()) as Record<string, unknown>;
    expect(outdated).toMatchObject({ enabled: true, consentCurrent: false, provider: B });
    expect((await put(server, true)).body['code']).toBe('AI_REVIEW_CONSENT_REQUIRED');
    expect((await put(server, true, B)).body).toMatchObject({ consentCurrent: true });
  });

  it('refuses to switch on without a provider or an enabled organisation (AI_DISABLED)', async () => {
    const server = new FakeServer();
    const fake = FakeAiReview.install(server, { organizationEnabled: false });
    expect((await put(server, true, A)).body['code']).toBe('AI_DISABLED');
    fake.organizationEnabled = true;
    fake.changeProvider(null);
    expect((await put(server, true, A)).body['code']).toBe('AI_DISABLED');
    const body = (await (await server.fetch(URL)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      available: false,
      unavailableReason: 'no_provider',
      notice: null,
    });
  });

  it('refuses the projects of another organisation (PROJECT_NOT_IN_ORGANIZATION)', async () => {
    const server = new FakeServer();
    const fake = FakeAiReview.install(server);
    fake.foreignProjects.add('p-foreign');
    const res = await server.fetch(URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        scope: 'selected',
        projectIds: ['p-own', 'p-foreign'],
        budgets: BUDGETS,
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'PROJECT_NOT_IN_ORGANIZATION',
      errors: [{ path: 'body.projectIds.1' }],
    });
  });
});
