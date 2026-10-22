import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeGitHub, githubShape, type FakeGitHub } from '../../../test/fake-github';
import { ScmError } from '../provider';
import {
  credentialsId,
  InstallationTokenCache,
  MutationPacer,
  parseAppPrivateKey,
} from './app-auth';
import {
  GitHubClient,
  githubRateLimit,
  GITHUB_SHAPES,
  GITHUB_TEXT,
  hasNextPage,
  MAX_THREAD_PAGES,
  RESOLVE_THREAD_MUTATION,
  REVIEW_THREADS_QUERY,
  UNRESOLVE_THREAD_MUTATION,
  type GitHubClientOptions,
} from './client';
import { githubGraphqlUrl } from './url';

const REPO = { owner: 'acme', repo: 'api' };
const SHA = '1'.repeat(40);

/** A pacer that records the keys it is asked to wait for; the waiting itself is the fake clock's. */
class SpyPacer extends MutationPacer {
  readonly waits: string[] = [];
  override async wait(key: string): Promise<void> {
    this.waits.push(key);
    await super.wait(key);
  }
}

describe('GitHub REST client (github.md §4–§6)', () => {
  let fake: FakeGitHub;
  let clock = Date.now();
  const clientFor = (options: GitHubClientOptions = {}, appId = String(fake.appId)) => {
    const parsed = parseAppPrivateKey(fake.privateKeyPem);
    if (!('key' in parsed)) throw new Error('key');
    return new GitHubClient(
      {
        connectionId: 'c1',
        baseUrl: fake.url,
        appId,
        privateKey: parsed.key,
        credentials: credentialsId(appId, parsed.pkcs8),
        allowInternalHosts: true,
      },
      {
        timeoutMs: 2_000,
        tokens: new InstallationTokenCache(() => clock),
        pacer: new MutationPacer(
          () => clock,
          async (ms) => void (clock += ms),
        ),
        now: () => clock,
        ...options,
      },
    );
  };
  const failure = async (p: Promise<unknown>): Promise<ScmError> => {
    try {
      await p;
    } catch (err) {
      if (err instanceof ScmError) return err;
      throw err;
    }
    throw new Error('expected a failure');
  };

  beforeAll(async () => {
    fake = await createFakeGitHub({ now: () => clock });
    fake.addRepository({ id: 424242, owner: 'acme', name: 'api', installationId: 777 });
    fake.addRepository({ id: 5, owner: 'acme', name: 'other', installationId: 777 });
    fake.addRepository({ id: 6, owner: 'acme', name: 'bare', installationId: null });
    fake.addRepository({
      id: 7,
      owner: 'acme',
      name: 'nochecks',
      installationId: 778,
      permissions: { metadata: 'read', pull_requests: 'write' },
    });
    fake.addRepository({
      id: 9,
      owner: 'acme',
      name: 'paused',
      installationId: 779,
      suspended: true,
    });
    fake.addRepository({
      id: 8,
      owner: 'acme',
      name: 'old',
      installationId: 777,
      movedTo: 'acme/new',
    });
    fake.addPull(424242, {
      number: 7,
      title: 'Refund limits',
      state: 'open',
      headSha: SHA,
      baseSha: 'b'.repeat(40),
      files: Array.from({ length: 250 }, (_, i) => ({
        filename: `f${i}.ts`,
        patch: '@@ -0,0 +1 @@\n+x',
      })),
    });
  });
  afterAll(() => fake.close());
  beforeEach(() => fake.clearRequests());

  it('signs a JWT the fake verifies, with GitHub’s headers', async () => {
    const app = await clientFor().app();
    expect(app.slug).toBe(fake.slug);
    const [request] = fake.requests;
    expect(request?.auth).toBe('jwt');
    expect(request?.headers.accept).toBe('application/vnd.github+json');
    expect(request?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(String(request?.headers['user-agent'])).toMatch(/^Qualor\//);
  });

  it('gets a token scoped to the mapped repository and three permissions, and reuses it', async () => {
    const tokens = new InstallationTokenCache(() => clock);
    const repo = await clientFor({ tokens }).useRepository(REPO);
    expect(repo.id).toBe(424242);
    const [grant] = [...fake.tokens.values()].slice(-1);
    expect(grant).toMatchObject({
      repositories: ['api'],
      permissions: { checks: 'write', pull_requests: 'write', metadata: 'read' },
    });
    fake.clearRequests();
    await clientFor({ tokens }).useRepository(REPO);
    expect(fake.requests.map((r) => r.method + ' ' + r.path)).toEqual([
      'GET /repos/acme/api/installation',
      'GET /repos/acme/api',
    ]);
  });

  it('says the App is not installed, and that it lacks a permission', async () => {
    const notInstalled = await failure(clientFor().useRepository({ owner: 'acme', repo: 'bare' }));
    expect([notInstalled.kind, notInstalled.reason, notInstalled.message]).toEqual([
      'not_found',
      'not_installed',
      GITHUB_TEXT.notInstalled,
    ]);
    const missing = await failure(clientFor().useRepository({ owner: 'acme', repo: 'nochecks' }));
    expect([missing.kind, missing.reason, missing.message]).toEqual([
      'auth',
      'permission_missing',
      GITHUB_TEXT.permission,
    ]);
    const suspended = await failure(clientFor().useRepository({ owner: 'acme', repo: 'paused' }));
    expect([suspended.kind, suspended.reason, suspended.message]).toEqual([
      'auth',
      'permission_missing',
      GITHUB_TEXT.permissionOrSuspended,
    ]);
  });

  it('stops without retry, naming the clock, when GitHub refuses the JWT', async () => {
    const saved = clock;
    const client = clientFor({ now: () => saved + 5 * 60_000 }); // Qualor's clock 5 minutes ahead
    const err = await failure(client.app());
    expect([err.kind, err.status, err.message]).toEqual(['auth', 401, GITHUB_TEXT.appRefused]);
    expect(err.message).toContain("server's clock");
  });

  it('requests a fresh installation token once after a 401, then gives up', async () => {
    const tokens = new InstallationTokenCache(() => clock);
    const issued = () => fake.requests.filter((r) => r.path.endsWith('/access_tokens')).length;
    await clientFor({ tokens }).useRepository(REPO); // a token, now cached
    fake.revokeTokens(); // uninstalled and installed again: the cached token is dead
    fake.clearRequests();
    const client = clientFor({ tokens });
    await client.useRepository(REPO); // 401 with the cached token, one fresh token, success
    expect(issued()).toBe(1);
    fake.revokeTokens();
    const err = await failure(client.pullRequest('7')); // a second 401 in the same job: give up
    expect([err.kind, err.message]).toEqual(['auth', GITHUB_TEXT.tokenRefused]);
    expect(issued()).toBe(1);
  });

  it('never follows a redirect of a renamed repository', async () => {
    const err = await failure(clientFor().useRepository({ owner: 'acme', repo: 'old' }));
    expect([err.kind, err.message]).toEqual(['not_found', GITHUB_TEXT.notFound]);
    expect(fake.requests.map((r) => r.path)).toEqual(['/repos/acme/old/installation']);
  });

  it('reads pages by number and never requests the URL of a Link header', async () => {
    const hosts: string[] = [];
    const client = clientFor({
      resolve: async (host) => {
        hosts.push(host);
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    await client.useRepository(REPO);
    fake.inject('GET', /^\/repos\/acme\/api\/pulls\/7\/files/, {
      status: 200,
      body: [{ filename: 'a.ts', status: 'modified' }],
      headers: { link: '<http://evil.example/steal?page=2>; rel="next"' },
    });
    const files = await client.pullRequestFiles('7', 30);
    expect(hosts).not.toContain('evil.example');
    expect(fake.requests.map((r) => r.path)).toContain(
      '/repos/acme/api/pulls/7/files?per_page=100&page=2',
    );
    // Page 1 (injected: one file), then the fake's pages 2 (100 files) and 3 (50 files).
    expect(files.complete).toBe(true);
    expect(files.items).toHaveLength(1 + 100 + 50);
    const cut = await client.pullRequestFiles('7', 2);
    expect([cut.items.length, cut.complete]).toEqual([200, false]);
  });

  it('does not understand a Link header too long to read, rather than taking the list as complete', async () => {
    const client = clientFor();
    await client.useRepository(REPO);
    fake.inject('GET', /^\/repos\/acme\/api\/issues\/7\/comments/, {
      status: 200,
      body: [],
      headers: {
        link: `<https://x/?page=2>; rel="next", ${'<https://x/>; rel="x", '.repeat(200)}`,
      },
    });
    const err = await failure(client.issueComments('7', 50));
    expect([err.kind, err.message]).toEqual(['bad_answer', GITHUB_TEXT.badAnswer]);
  });

  it('refuses a pull request id and a revision it would not put into a path, before any request', async () => {
    const client = clientFor();
    await client.useRepository(REPO);
    fake.clearRequests();
    expect((await failure(client.pullRequest('pr-12'))).reason).toBe('invalid_input');
    expect((await failure(client.checkRuns('abc', 'qualor/x'))).reason).toBe('invalid_input');
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a repository that is not owner/repo, or a dot segment, before any request', async () => {
    for (const ref of [
      { owner: 'acme', repo: '..' },
      { owner: 'acme', repo: '.' },
      { owner: '..', repo: 'api' },
      { owner: '.', repo: 'api' },
      { owner: 'acme/..', repo: 'api' },
      { owner: 'acme', repo: '../app' },
      { owner: 'acme', repo: 'api/x' },
      { owner: '', repo: 'api' },
      { owner: 'acme', repo: '' },
    ]) {
      fake.clearRequests();
      const err = await failure(clientFor().useRepository(ref));
      expect([err.kind, err.reason, err.message]).toEqual([
        'refused',
        'invalid_input',
        GITHUB_TEXT.repo,
      ]);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it('refuses an App id that is not a positive safe integer without leading zeros', () => {
    for (const appId of [
      '',
      '0',
      '007',
      '12a',
      '-1',
      '1'.repeat(17),
      '9'.repeat(16),
      ' 1',
      '1\n',
    ]) {
      let caught: unknown;
      try {
        clientFor({}, appId);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ScmError);
      expect([(caught as ScmError).reason, (caught as ScmError).message]).toEqual([
        'invalid_input',
        GITHUB_TEXT.appId,
      ]);
    }
    expect(() => clientFor({}, '1')).not.toThrow();
    expect(() => clientFor({}, String(Number.MAX_SAFE_INTEGER))).not.toThrow();
  });

  it('stops at its request budget, 320 a job by default', async () => {
    const client = clientFor({ maxRequests: 2 });
    await client.app();
    await client.app();
    const err = await failure(client.app());
    expect([err.kind, err.message]).toEqual(['budget', GITHUB_TEXT.budget]);
    expect(GITHUB_TEXT.budget).toBe('More than 320 GitHub requests in one job');
  });

  it('spaces its mutations at least a second apart', async () => {
    const start = clock;
    const client = clientFor();
    await client.useRepository(REPO);
    const t0 = clock;
    await client.createComment('7', 'a');
    await client.createComment('7', 'b');
    expect(clock - t0).toBeGreaterThanOrEqual(1_000);
    expect(t0).toBeGreaterThanOrEqual(start);
  });

  it('creates and lists review comments on RIGHT-side lines (llm.md §8.4)', async () => {
    const client = clientFor();
    await client.useRepository(REPO);
    const one = await client.createReviewComment('7', {
      body: 'one line',
      commitId: SHA,
      path: 'f0.ts',
      line: 1,
      startLine: 1,
    });
    expect(one).toMatchObject({ body: 'one line', user: { login: `${fake.slug}[bot]` } });
    const sent = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/comments'));
    // One line: no start_line (GitHub refuses start_line equal to line).
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({
      body: 'one line',
      commit_id: SHA,
      path: 'f0.ts',
      side: 'RIGHT',
      line: 1,
    });
    // A line the patch does not show: GitHub's 422, as position_rejected.
    expect(
      await client.createReviewComment('7', { body: 'x', commitId: SHA, path: 'f1.ts', line: 5 }),
    ).toBe('position_rejected');
    const listed = await client.reviewComments('7', 30);
    expect(listed.complete).toBe(true);
    expect(listed.items.map((c) => c.body)).toEqual(['one line']);
    // Nothing reaches GitHub with a line that is no line number.
    fake.clearRequests();
    const bad = await failure(
      client.createReviewComment('7', {
        body: 'x',
        commitId: SHA,
        path: 'f0.ts',
        line: 2,
        startLine: 3,
      }),
    );
    expect([bad.kind, bad.reason]).toEqual(['refused', 'invalid_input']);
    expect(fake.requests).toHaveLength(0);
  });

  it('creates a check run whose output is a title and a summary, never annotations', async () => {
    const client = clientFor();
    await client.useRepository(REPO);
    fake.clearRequests();
    const created = await client.createCheckRun({
      name: 'qualor/k',
      headSha: SHA,
      conclusion: 'success',
      title: 't',
      summary: 's',
      detailsUrl: null,
      externalId: 'qualor:v1:x',
    });
    expect(created).toMatchObject({ name: 'qualor/k', conclusion: 'success' });
    expect(created.output.annotations_count).toBe(0);
    const sent = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/check-runs'));
    expect((JSON.parse(sent?.body ?? '{}') as { output: unknown }).output).toEqual({
      title: 't',
      summary: 's',
    });
  });

  it('refuses a check run GitHub answers 422 to, with no second attempt of any kind', async () => {
    const client = clientFor();
    await client.useRepository(REPO);
    fake.inject('POST', /check-runs$/, { status: 422, body: { message: 'Invalid request.' } });
    fake.clearRequests();
    const refused = await failure(
      client.createCheckRun({
        name: 'qualor/k',
        headSha: SHA,
        conclusion: 'success',
        title: 't',
        summary: 's',
        detailsUrl: null,
        externalId: 'qualor:v1:x',
      }),
    );
    expect([refused.kind, refused.status]).toEqual(['refused', 422]);
    expect(fake.requests.filter((r) => r.path.endsWith('/check-runs'))).toHaveLength(1);
  });

  it('lists only this App’s check runs of the name', async () => {
    const client = clientFor();
    await client.useRepository(REPO);
    await client.createCheckRun({
      name: 'qualor/k',
      headSha: SHA,
      conclusion: 'success',
      title: 't',
      summary: 's',
      detailsUrl: null,
      externalId: 'qualor:v1:x',
    });
    fake.checkRuns.push({ ...fake.checkRuns.at(-1)!, id: 9999, appId: 1 });
    const runs = await client.checkRuns(SHA, 'qualor/k');
    expect(runs).toHaveLength(1);
    expect(runs.every((r) => r.app?.id === fake.appId)).toBe(true);
    expect(fake.requests.at(-1)?.path).toContain(`app_id=${fake.appId}`);
  });

  it('is served by a fake that refuses a body GitHub would refuse', async () => {
    await clientFor().useRepository(REPO);
    const [token] = [...fake.tokens.keys()].slice(-1);
    const post = (body: string) =>
      fetch(`${fake.url}/repos/acme/api/check-runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token!}`, 'user-agent': 'test' },
        body,
      });
    expect((await post('{not json')).status).toBe(400);
    const run = { name: 'qualor/k', head_sha: SHA, status: 'completed', conclusion: 'success' };
    expect((await post(JSON.stringify({ ...run, output: { summary: 's' } }))).status).toBe(422);
    expect((await post(JSON.stringify({ ...run, output: { title: 't' } }))).status).toBe(422);
    expect(
      (await post(JSON.stringify({ ...run, output: { title: 't', summary: 's' } }))).status,
    ).toBe(201);
  });

  it('keeps every secret out of its errors and its serialisation', async () => {
    const client = clientFor();
    await client.useRepository(REPO);
    const [token] = [...fake.tokens.keys()].slice(-1);
    fake.inject('GET', /^\/repos\/acme\/api\/pulls\/7$/, {
      status: 500,
      body: { message: `boom ${token}` },
    });
    const err = await failure(client.pullRequest('7'));
    const everything = JSON.stringify({
      err,
      client,
      message: err.message,
      stack: err.stack,
      provider: err.providerMessage,
    });
    expect(everything).not.toContain(token!);
    expect(everything).not.toContain('PRIVATE KEY');
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
  });

  describe('review threads over GraphQL (github.md §6.4, ruling R6)', () => {
    const GRAPHQL = /^\/api\/graphql$/;
    let nextPull = 100;

    /**
     * A pull request of its own (no test reads another's threads) with `count` review comments by
     * the App, each the first comment of a thread, in the order they were made.
     */
    const pullWithThreads = async (count: number) => {
      const number = nextPull++;
      fake.addPull(424242, {
        number,
        title: `Threads ${number}`,
        state: 'open',
        headSha: SHA,
        baseSha: 'b'.repeat(40),
        files: [{ filename: 'f.ts', patch: '@@ -0,0 +1 @@\n+x' }],
      });
      const author = clientFor({ maxRequests: count + 10 });
      await author.useRepository(REPO);
      const commentIds: number[] = [];
      for (let i = 0; i < count; i++) {
        const created = await author.createReviewComment(String(number), {
          body: `<!-- qualor:issue ${i} -->\nissue ${i}`,
          commitId: SHA,
          path: 'f.ts',
          line: 1,
        });
        if (created === 'position_rejected') throw new Error('the fake refused the position');
        commentIds.push(created.id);
      }
      const threadIds = commentIds.map(
        (id) => fake.reviewThreads.find((t) => t.commentIds[0] === id)!.id,
      );
      return { number: String(number), commentIds, threadIds };
    };
    let many: Awaited<ReturnType<typeof pullWithThreads>>;
    beforeAll(async () => {
      many = await pullWithThreads(150);
    }, 60_000);

    /** A client on the repository, its requests so far forgotten. */
    const reader = async (options: GitHubClientOptions = {}) => {
      const client = clientFor(options);
      await client.useRepository(REPO);
      fake.clearRequests();
      return client;
    };
    /** The next GraphQL request is answered with this (HTTP 200 unless said otherwise). */
    const answer = (body: unknown, status = 200, headers?: Record<string, string>) =>
      fake.inject('POST', GRAPHQL, { status, body, ...(headers ? { headers } : {}) });
    const node = (id: string, resolvedBy: string | null, databaseId: number) => ({
      id,
      isResolved: resolvedBy !== null,
      resolvedBy: resolvedBy === null ? null : { login: resolvedBy },
      comments: { nodes: [{ databaseId }] },
    });
    const threadsData = (nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null }) => ({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } },
    });
    const sent = (index: number) =>
      JSON.parse(fake.requests[index]?.body ?? '{}') as {
        query: string;
        variables: Record<string, unknown>;
      };

    it('reads every page and the resolver’s login', async () => {
      // A person, another App, and the fake's own App (a resolve through the API with an
      // installation token): GitHub names each by its login, an App as `<slug>[bot]` (R6).
      fake.resolveThreadAs(many.threadIds[3]!, 'octocat');
      fake.resolveThreadAs(many.threadIds[60]!, 'other-app[bot]');
      const client = await reader();
      expect(await client.setThreadResolved(many.threadIds[120]!, true)).toBe('done');
      fake.clearRequests();
      const threads = await client.reviewThreads(many.number, MAX_THREAD_PAGES);
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /api/graphql',
        'POST /api/graphql',
      ]);
      expect(threads.complete).toBe(true);
      expect(threads.items).toHaveLength(150);
      expect(threads.items.filter((t) => t.isResolved)).toEqual([
        {
          id: many.threadIds[3],
          isResolved: true,
          resolvedByLogin: 'octocat',
          firstCommentId: many.commentIds[3],
        },
        {
          id: many.threadIds[60],
          isResolved: true,
          resolvedByLogin: 'other-app[bot]',
          firstCommentId: many.commentIds[60],
        },
        {
          id: many.threadIds[120],
          isResolved: true,
          resolvedByLogin: `${fake.slug}[bot]`,
          firstCommentId: many.commentIds[120],
        },
      ]);
      // An open thread names nobody.
      const open = threads.items.filter((t) => !t.isResolved);
      expect(open).toHaveLength(147);
      expect(open.every((t) => t.resolvedByLogin === null)).toBe(true);
      expect(threads.items.map((t) => t.id)).toEqual(many.threadIds);
      expect(threads.items.map((t) => t.firstCommentId)).toEqual(many.commentIds);
    });

    it('stops at maxPages and says the list is not complete', async () => {
      const client = await reader();
      const threads = await client.reviewThreads(many.number, 1);
      expect([threads.items.length, threads.complete]).toEqual([100, false]);
      expect(fake.requests).toHaveLength(1);
    });

    it('posts the document with the variables GraphQL types, to the endpoint beside /api/v3', async () => {
      const client = await reader();
      await client.reviewThreads(many.number, MAX_THREAD_PAGES);
      const [first, second] = fake.requests;
      expect([first?.method, first?.path, first?.auth]).toEqual(['POST', '/api/graphql', 'token']);
      expect(first?.headers['content-type']).toBe('application/json');
      expect(first?.headers.accept).toBe('application/vnd.github+json');
      expect(String(first?.headers['user-agent'])).toMatch(/^Qualor\//);
      // `number` is an Int!, and the first page has no cursor.
      expect(sent(0)).toEqual({
        query: REVIEW_THREADS_QUERY,
        variables: { owner: 'acme', name: 'api', number: Number(many.number), after: null },
      });
      // The second page continues after the first one's end cursor.
      expect(second?.path).toBe('/api/graphql');
      expect(sent(1).variables).toEqual({
        owner: 'acme',
        name: 'api',
        number: Number(many.number),
        after: expect.stringMatching(/^.+$/),
      });
    });

    it.each([
      ['NOT_FOUND', 'not_found', 'http', GITHUB_TEXT.notFound, null],
      ['FORBIDDEN', 'auth', 'permission_missing', GITHUB_TEXT.permission, null],
      ['RATE_LIMITED', 'rate_limited', 'http', GITHUB_TEXT.graphqlRateLimit, 60],
      ['MAX_NODE_LIMIT_EXCEEDED', 'bad_answer', 'bad_answer', GITHUB_TEXT.badAnswer, null],
    ])(
      'a GraphQL %s error is an ScmError of kind %s, never an empty list',
      async (type, kind, reason, text, retryAfterSeconds) => {
        const client = await reader();
        answer({ data: null, errors: [{ type, message: 'x' }] });
        const err = await failure(client.reviewThreads(many.number, 1));
        expect([err.kind, err.reason, err.message, err.retryAfterSeconds, err.status]).toEqual([
          kind,
          reason,
          text,
          retryAfterSeconds,
          200,
        ]);
      },
    );

    it('is never fooled by data next to an error, or by an answer without data', async () => {
      const client = await reader();
      // An empty list beside a FORBIDDEN error is a failure, not "no threads".
      answer({ ...threadsData([]), errors: [{ type: 'FORBIDDEN', message: 'x' }] });
      expect((await failure(client.reviewThreads(many.number, 1))).kind).toBe('auth');
      for (const body of [
        { data: null },
        {},
        [],
        null,
        { data: {} },
        { data: { repository: 5 } },
      ]) {
        answer(body);
        const err = await failure(client.reviewThreads(many.number, 1));
        expect([err.kind, err.message]).toEqual(['bad_answer', GITHUB_TEXT.badAnswer]);
      }
      // `errors: []` is no error.
      answer({ ...threadsData([node('PRRT_a', null, 5)]), errors: [] });
      expect((await client.reviewThreads(many.number, 1)).items).toHaveLength(1);
    });

    it('says not_found for a pull request that is not there, never an empty list', async () => {
      const client = await reader();
      const err = await failure(client.reviewThreads('2147483647', 1)); // the fake: a NOT_FOUND error
      expect([err.kind, err.message]).toEqual(['not_found', GITHUB_TEXT.notFound]);
      for (const data of [{ repository: { pullRequest: null } }, { repository: null }]) {
        answer({ data });
        const gone = await failure(client.reviewThreads(many.number, 1));
        expect([gone.kind, gone.message]).toEqual(['not_found', GITHUB_TEXT.notFound]);
      }
    });

    it('does not read a missing resolvedBy as "nobody resolved it"', async () => {
      const client = await reader();
      answer(
        threadsData([{ id: 'PRRT_a', isResolved: true, comments: { nodes: [{ databaseId: 5 }] } }]),
      );
      expect((await failure(client.reviewThreads(many.number, 1))).kind).toBe('bad_answer');
      // A next page without a cursor to ask for it is not the last page either.
      answer(threadsData([node('PRRT_a', null, 5)], { hasNextPage: true, endCursor: null }));
      expect((await failure(client.reviewThreads(many.number, 5))).kind).toBe('bad_answer');
    });

    it('leaves out a null node, and has no first comment id for a thread without a readable comment', async () => {
      const client = await reader();
      answer(
        threadsData([
          null,
          { ...node('PRRT_a', null, 5), comments: { nodes: [] } },
          { ...node('PRRT_b', 'octocat', 6), comments: { nodes: [{ databaseId: null }] } },
          { ...node('PRRT_c', null, 7), comments: { nodes: [null] } },
        ]),
      );
      const threads = await client.reviewThreads(many.number, 1);
      expect(threads.items).toEqual([
        { id: 'PRRT_a', isResolved: false, resolvedByLogin: null, firstCommentId: null },
        { id: 'PRRT_b', isResolved: true, resolvedByLogin: 'octocat', firstCommentId: null },
        { id: 'PRRT_c', isResolved: false, resolvedByLogin: null, firstCommentId: null },
      ]);
    });

    it('reads the recorded answer: an open thread, a person’s resolution and an App’s', async () => {
      const client = await reader();
      answer(githubShape('graphql_review_threads'));
      const threads = await client.reviewThreads(many.number, 1);
      expect(threads.complete).toBe(false); // the recorded page has a next one
      expect(threads.items.map((t) => [t.isResolved, t.resolvedByLogin, t.firstCommentId])).toEqual(
        [
          [false, null, 10],
          [true, 'octocat', 11],
          [true, 'qualor-acme[bot]', 12],
        ],
      );
    });

    it('keeps a resolved thread GitHub names nobody for resolved, with no login', async () => {
      const client = await reader();
      // E.g. the resolver's account is gone: the caller can tell it is not Qualor's own.
      answer(threadsData([{ ...node('PRRT_d', null, 8), isResolved: true }]));
      expect((await client.reviewThreads(many.number, 1)).items).toEqual([
        { id: 'PRRT_d', isResolved: true, resolvedByLogin: null, firstCommentId: 8 },
      ]);
    });

    it('keeps GitHub’s own words and the installation token out of the error text', async () => {
      const client = await reader();
      const [token] = [...fake.tokens.keys()].slice(-1);
      answer({ data: null, errors: [{ type: 'FORBIDDEN', message: `denied for ${token}` }] });
      const err = await failure(client.reviewThreads(many.number, 1));
      expect(err.message).toBe(GITHUB_TEXT.permission);
      expect(err.providerMessage).toBe('denied for [secret]');
      expect(JSON.stringify({ err, client, message: err.message, stack: err.stack })).not.toContain(
        token!,
      );
    });

    it('maps the HTTP errors of the endpoint as REST’s are mapped', async () => {
      const client = await reader();
      answer({ message: 'You have exceeded a secondary rate limit.' }, 403, {
        'retry-after': '30',
      });
      const limited = await failure(client.reviewThreads(many.number, 1));
      expect([limited.kind, limited.status, limited.retryAfterSeconds]).toEqual([
        'rate_limited',
        403,
        30,
      ]);
      answer({ message: 'Resource not accessible by integration' }, 403);
      const forbidden = await failure(client.reviewThreads(many.number, 1));
      expect([forbidden.kind, forbidden.reason]).toEqual(['auth', 'permission_missing']);
      answer({ message: 'Server Error' }, 502);
      expect((await failure(client.reviewThreads(many.number, 1))).kind).toBe('transient');
    });

    it('asks for one fresh installation token after a 401, as every repository call does', async () => {
      const client = await reader();
      fake.revokeTokens();
      const threads = await client.reviewThreads(many.number, 1);
      expect(threads.items).toHaveLength(100);
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /api/graphql',
        'POST /app/installations/777/access_tokens',
        'POST /api/graphql',
      ]);
    });

    it('refuses a pull request number GraphQL’s Int cannot hold, and an id it would not send, before any request', async () => {
      const client = await reader();
      for (const bad of ['2147483648', '9999999999', 'pr-12', '']) {
        expect((await failure(client.reviewThreads(bad, 1))).reason).toBe('invalid_input');
      }
      for (const bad of ['', 'two words', 'x'.repeat(256), 'PRRT\n1']) {
        expect((await failure(client.setThreadResolved(bad, true))).reason).toBe('invalid_input');
      }
      expect(fake.requests).toHaveLength(0);
    });

    it('setThreadResolved resolves and reopens a thread, as an App', async () => {
      const { number, threadIds } = await pullWithThreads(1);
      const id = threadIds[0]!;
      const client = await reader();
      expect(await client.setThreadResolved(id, true)).toBe('done');
      const thread = fake.reviewThreads.find((t) => t.id === id)!;
      const app = `${fake.slug}[bot]`;
      expect([thread.resolved, thread.resolvedBy]).toEqual([true, app]);
      expect(sent(0)).toEqual({ query: RESOLVE_THREAD_MUTATION, variables: { id } });
      // Read back, GitHub names the App like any other resolver, `<slug>[bot]` (R6).
      expect((await client.reviewThreads(number, 1)).items).toEqual([
        expect.objectContaining({ id, isResolved: true, resolvedByLogin: app }),
      ]);
      expect(await client.setThreadResolved(id, false)).toBe('done');
      expect([thread.resolved, thread.resolvedBy]).toEqual([false, null]);
      expect(sent(2)).toEqual({ query: UNRESOLVE_THREAD_MUTATION, variables: { id } });
      // Reopened, it names nobody.
      expect((await client.reviewThreads(number, 1)).items).toEqual([
        expect.objectContaining({ id, isResolved: false, resolvedByLogin: null }),
      ]);
    });

    it('says not_found for a thread GitHub does not know, and lets every other error through', async () => {
      const client = await reader();
      expect(await client.setThreadResolved('PRRT_kwDOgone', true)).toBe('not_found');
      expect(await client.setThreadResolved('PRRT_kwDOgone', false)).toBe('not_found');
      answer({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'x' }] });
      const limited = await failure(client.setThreadResolved(many.threadIds[0]!, true));
      expect([limited.kind, limited.retryAfterSeconds]).toEqual(['rate_limited', 60]);
      // GitHub does not report the state asked for: not "done".
      answer({ data: { resolveReviewThread: { thread: { id: 'PRRT_a', isResolved: false } } } });
      expect((await failure(client.setThreadResolved(many.threadIds[0]!, true))).kind).toBe(
        'bad_answer',
      );
      answer({ data: { unresolveReviewThread: { thread: { id: 'PRRT_a', isResolved: false } } } });
      expect(await client.setThreadResolved(many.threadIds[0]!, false)).toBe('done');
      answer({ data: { unresolveReviewThread: null } });
      expect((await failure(client.setThreadResolved(many.threadIds[0]!, false))).kind).toBe(
        'bad_answer',
      );
    });

    it('counts GraphQL calls against the request budget', async () => {
      const { number, threadIds } = await pullWithThreads(1);
      const tokens = new InstallationTokenCache(() => clock);
      await clientFor({ tokens }).useRepository(REPO); // a token, now cached
      const client = clientFor({ tokens, maxRequests: 3 });
      await client.useRepository(REPO); // the installation and the repository: two requests
      await client.reviewThreads(number, 1); // the third
      expect(client.requests).toBe(3);
      const query = await failure(client.reviewThreads(number, 1));
      const mutation = await failure(client.setThreadResolved(threadIds[0]!, true));
      expect([query.kind, query.message, mutation.kind]).toEqual([
        'budget',
        GITHUB_TEXT.budget,
        'budget',
      ]);
      expect(client.requests).toBe(3);
      expect(fake.reviewThreads.find((t) => t.id === threadIds[0])?.resolved).toBe(false);
    });

    it('paces its mutations with the REST ones, and its queries not at all', async () => {
      const { number, threadIds } = await pullWithThreads(1);
      const tokens = new InstallationTokenCache(() => clock);
      await clientFor({ tokens }).useRepository(REPO); // a token, now cached
      const pacer = new SpyPacer(
        () => clock,
        async (ms) => void (clock += ms),
      );
      const client = clientFor({ tokens, pacer });
      await client.useRepository(REPO); // reads only
      await client.reviewThreads(number, 1); // a query is a POST, but no mutation
      expect(pacer.waits).toEqual([]);
      const t0 = clock;
      await client.setThreadResolved(threadIds[0]!, true);
      await client.setThreadResolved(threadIds[0]!, false);
      expect(pacer.waits).toHaveLength(2);
      expect(clock - t0).toBeGreaterThanOrEqual(1_000);
      await client.createComment(number, 'a REST mutation');
      expect(pacer.waits).toHaveLength(3);
      expect(new Set(pacer.waits).size).toBe(1); // one key: the installation's
    });

    it('lists a reply with its in_reply_to_id and its path, and a reply starts no thread', async () => {
      const { number, commentIds, threadIds } = await pullWithThreads(2);
      const reply = fake.replyToReviewComment(424242, Number(number), commentIds[0]!, {
        body: 'On it',
        login: 'octocat',
      });
      expect(() =>
        fake.replyToReviewComment(424242, Number(number), reply.id, { body: 'x', login: 'a' }),
      ).toThrow(); // GitHub takes no reply to a reply
      const client = await reader();
      const listed = await client.reviewComments(number, 5);
      expect(listed.items.map((c) => [c.id, c.in_reply_to_id, c.path, c.user?.login])).toEqual([
        [commentIds[0], undefined, 'f.ts', `${fake.slug}[bot]`],
        [commentIds[1], undefined, 'f.ts', `${fake.slug}[bot]`],
        [reply.id, commentIds[0], 'f.ts', 'octocat'],
      ]);
      expect(listed.items[2]?.user?.type).toBe('User');
      const threads = await client.reviewThreads(number, 1);
      expect(threads.items.map((t) => [t.id, t.firstCommentId])).toEqual([
        [threadIds[0], commentIds[0]],
        [threadIds[1], commentIds[1]],
      ]);
      expect(fake.reviewThreads.find((t) => t.id === threadIds[0])?.commentIds).toEqual([
        commentIds[0],
        reply.id,
      ]);
      expect(() => fake.resolveThreadAs('PRRT_nope', 'octocat')).toThrow();
    });

    it('is served by a fake that refuses what GitHub’s GraphQL endpoint refuses', async () => {
      const client = await reader();
      const [token] = [...fake.tokens.keys()].slice(-1);
      const post = (headers: Record<string, string>, body: unknown) =>
        fetch(githubGraphqlUrl(fake.url), {
          method: 'POST',
          headers: { 'user-agent': 'test', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
      const auth = { authorization: `Bearer ${token!}` };
      const variables = { owner: 'acme', name: 'api', number: Number(many.number), after: null };
      expect((await post({}, { query: REVIEW_THREADS_QUERY, variables })).status).toBe(401);
      expect((await post(auth, '{not json')).status).toBe(400);
      // A string where the document says Int!: HTTP 200, errors and no data.
      const wrong = await post(auth, {
        query: REVIEW_THREADS_QUERY,
        variables: { ...variables, number: many.number },
      });
      const body = (await wrong.json()) as { data?: unknown; errors?: { message: string }[] };
      expect([wrong.status, body.data, body.errors?.[0]?.message]).toEqual([
        200,
        undefined,
        expect.stringContaining('$number'),
      ]);
      // Only the repositories the token is for, and only with the permission the operation needs.
      const grant = fake.tokens.get(token!)!;
      grant.permissions = { metadata: 'read', checks: 'write', pull_requests: 'read' };
      expect((await client.reviewThreads(many.number, 1)).items).toHaveLength(100);
      const write = await failure(client.setThreadResolved(many.threadIds[0]!, true));
      expect([write.kind, write.reason, write.message]).toEqual([
        'auth',
        'permission_missing',
        GITHUB_TEXT.permission,
      ]);
      grant.permissions = { metadata: 'read', checks: 'write' };
      const read = await failure(client.reviewThreads(many.number, 1));
      expect([read.kind, read.reason]).toEqual(['auth', 'permission_missing']);
      grant.permissions = { metadata: 'read', checks: 'write', pull_requests: 'write' };
      grant.repositories = ['other'];
      expect((await failure(client.reviewThreads(many.number, 1))).kind).toBe('not_found');
      expect(await client.setThreadResolved(many.threadIds[0]!, true)).toBe('not_found');
      expect(fake.reviewThreads.find((t) => t.id === many.threadIds[0])?.resolved).toBe(false);
    });
  });
});

describe('githubRateLimit (github.md §5.3)', () => {
  const now = 1_800_000_000_000;
  it.each([
    [403, { 'retry-after': '30' }, null, 30],
    [429, { 'retry-after': '5000' }, null, 900],
    [
      403,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120) },
      null,
      120,
    ],
    [403, {}, 'You have exceeded a secondary rate limit.', 60],
    [429, {}, null, null],
  ])('%i %j %s → %s', (status, headers, message, seconds) => {
    expect(githubRateLimit(status, headers, message, now)).toEqual({ retryAfterSeconds: seconds });
  });
  it('is no rate limit for a plain 403 or another status', () => {
    expect(githubRateLimit(403, {}, 'Resource not accessible by integration', now)).toBeNull();
    expect(githubRateLimit(500, { 'retry-after': '1' }, null, now)).toBeNull();
  });
});

describe('hasNextPage', () => {
  it('reads rel="next" only, and nothing out of a header too long to read', () => {
    expect(hasNextPage('<https://x/?page=2>; rel="next", <https://x/?page=9>; rel="last"')).toBe(
      true,
    );
    expect(hasNextPage('<https://x/?page=1>; rel="prev", <https://x/?page=1>; rel="first"')).toBe(
      false,
    );
    expect(hasNextPage(undefined)).toBe(false);
    // Too long to read: neither a next page nor the last one (the client does not understand it).
    expect(hasNextPage('x'.repeat(5_000) + '; rel="next"')).toBeNull();
  });
});

describe('recorded shapes', () => {
  it.each(
    Object.entries({
      app: 'app',
      installation: 'installation',
      installationToken: 'installation_token',
      repository: 'repository',
      checkRun: 'check_run',
      checkRuns: 'check_runs',
      pullRequest: 'pull_request',
      pullRequestFiles: 'pull_request_files',
      issueComment: 'issue_comment',
      issueComments: 'issue_comments',
      reviewComment: 'pull_request_review_comment',
      reviewThreads: 'graphql_review_threads',
      resolveThread: 'graphql_resolve_thread',
    }),
  )('%s parses', (key, file) => {
    expect(
      GITHUB_SHAPES[key as keyof typeof GITHUB_SHAPES].safeParse(githubShape(file)).success,
    ).toBe(true);
  });
});
