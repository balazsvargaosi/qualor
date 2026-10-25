import type { KeyObject } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { outboundRequest, type OutboundResult, type Resolver } from '../../http/outbound';
import { VERSION } from '../../index';
import { MAX_RETRY_AFTER_SECONDS } from '../gitlab/client';
import { ScmError, type Paged } from '../provider';
import { scmRefusedAddress } from '../url';
import {
  appJwt,
  InstallationTokenCache,
  isGitHubAppId,
  MutationPacer,
  tokenCacheKey,
} from './app-auth';
import { githubGraphqlUrl, GITHUB_REPO_PATTERN, type GitHubRepoRef } from './url';

/** github.md §5.3. */
export const GITHUB_TIMEOUT_MS = 10_000;
export const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
export const GITHUB_PAGE_SIZE = 100;
/**
 * Requests one job (one client) may make (ruling R7). The most a decoration asks for besides its
 * thread work is `REQUESTS_OUTSIDE_THREADS` (decorate.ts); with the creations (one review, and
 * each comment alone after a 422, the analyzers' and the AI review's) and the updates of threads
 * the sum is 322, a token refreshed after a 401 included, so the check run and the summary are
 * always written.
 */
export const MAX_GITHUB_REQUESTS = 350;
/** Ruling T6: pages of 100 review threads one job reads at most. */
export const MAX_THREAD_PAGES = 10;
/** GraphQL's `Int` is a signed 32-bit integer: the largest pull request number a query can carry. */
const GRAPHQL_MAX_INT = 2_147_483_647;
/** A node id as GitHub makes them (`PRRT_kwDO…`): printable ASCII, no space. */
const NODE_ID = /^[\x21-\x7e]{1,255}$/;
/** GitHub's advice for a secondary rate limit without `Retry-After`: wait at least a minute. */
export const SECONDARY_LIMIT_SECONDS = 60;
export const GITHUB_API_VERSION = '2022-11-28';
/** A pull request number, 1–10 digits (the only form sent in a path). */
export const GITHUB_PR_NUMBER = /^[0-9]{1,10}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** github.md §4: what an installation token may do, and nothing more. */
export const INSTALLATION_PERMISSIONS = {
  checks: 'write',
  pull_requests: 'write',
  metadata: 'read',
} as const;

/** github.md §5.4: the fixed texts; GitHub's own words are never shown or logged. */
export const GITHUB_TEXT = {
  appRefused:
    "GitHub refused the App's credentials (HTTP 401); check the App id, the private key and the server's clock",
  tokenRefused: 'GitHub refused the installation token (HTTP 401)',
  notInstalled: 'The GitHub App is not installed on the repository',
  permission:
    'The GitHub App lacks a permission Qualor needs (checks: write, pull requests: write)',
  /** A 403 on the token request: GitHub answers so for a suspended installation too. */
  permissionOrSuspended:
    'The GitHub App lacks a permission Qualor needs (checks: write, pull requests: write), or its installation is suspended',
  notFound: 'The GitHub repository was not found, or the App cannot see it',
  badAnswer: "GitHub's answer was not understood",
  budget: `More than ${MAX_GITHUB_REQUESTS} GitHub requests in one job`,
  prNumber: 'The pull request id is not a GitHub pull request number',
  revision: 'The revision is not a full commit SHA',
  id: 'The id is not a GitHub id',
  line: 'The line is not a line number of the file',
  appId: 'The App id is not a GitHub App id (a positive integer)',
  repo: 'The repository is not a GitHub owner/repo',
  notPublic:
    'The GitHub host resolves to a private, loopback or otherwise non-public address; list it in QUALOR_SCM_INTERNAL_HOSTS',
  refusedAddress: 'The GitHub host resolves to a link-local, cloud metadata or loopback address',
  unresolved: 'The GitHub host could not be resolved',
  timeout: 'GitHub did not answer within 10 s',
  /** A GraphQL `RATE_LIMITED` error comes with HTTP 200: there is no status to quote. */
  graphqlRateLimit: "GitHub's GraphQL API rate limit was reached",
} as const;

/**
 * The GraphQL documents (github.md §6.4, ruling R6): a pull request's review threads, 100 to a
 * page, with who resolved each and the node id of its first comment (REST's `node_id` of that
 * comment); and the two mutations that resolve and reopen a thread (REST cannot). Never the
 * comment's `databaseId`, which GitHub deprecated because it cannot hold its 64-bit ids, nor
 * `fullDatabaseId`, which an older GitHub Enterprise Server does not have: a field the server
 * lacks fails the whole query. The operation names are what the fake picks by.
 */
export const REVIEW_THREADS_QUERY = `query QualorReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved resolvedBy { login } comments(first: 1) { nodes { id } } }
      }
    }
  }
}`;
export const RESOLVE_THREAD_MUTATION =
  'mutation QualorResolveThread($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';
export const UNRESOLVE_THREAD_MUTATION =
  'mutation QualorUnresolveThread($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';

// ─── Response shapes (the fields Qualor reads; server/test/github-shapes/ holds recorded ones) ──

const sha = z.string().regex(SHA);
const app = z.looseObject({ id: z.number().int(), slug: z.string().min(1).max(100) });
export type GitHubApp = z.infer<typeof app>;
const installation = z.looseObject({ id: z.number().int(), app_id: z.number().int() });
const installationToken = z.looseObject({
  token: z.string().regex(/^[\x21-\x7e]{1,512}$/),
  expires_at: z.iso.datetime(),
});
const repository = z.looseObject({
  id: z.number().int(),
  full_name: z.string(),
  html_url: z.string(),
});
export type GitHubRepository = z.infer<typeof repository>;
const checkRun = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  head_sha: sha,
  status: z.string(),
  conclusion: z.string().nullable(),
  external_id: z.string().nullable(),
  details_url: z.string().nullable(),
  output: z.looseObject({
    title: z.string().nullable(),
    summary: z.string().nullable(),
    annotations_count: z.number().int(),
  }),
  app: z.looseObject({ id: z.number().int() }).nullable(),
});
export type GitHubCheckRun = z.infer<typeof checkRun>;
const checkRuns = z.looseObject({ total_count: z.number().int(), check_runs: z.array(checkRun) });
const pullRequest = z.looseObject({
  number: z.number().int(),
  state: z.string(),
  title: z.string(),
  html_url: z.string(),
  head: z.looseObject({ sha, ref: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  /** A draft pull request, which AI review skips. */
  draft: z.boolean().default(false),
  /** A `closed` pull request that was merged. */
  merged: z.boolean().default(false),
});
export type GitHubPullRequest = z.infer<typeof pullRequest>;
const file = z.looseObject({
  filename: z.string(),
  status: z.string(),
  patch: z.string().optional(),
});
export type GitHubFile = z.infer<typeof file>;
const comment = z.looseObject({
  id: z.number().int(),
  body: z.string().nullable(),
  user: z.looseObject({ login: z.string(), type: z.string() }).nullable(),
  /** When GitHub made the comment (ISO 8601): commands count by their age. */
  created_at: z.string(),
});
export type GitHubComment = z.infer<typeof comment>;
/**
 * A pull request review comment (llm.md §8.4): a comment on lines of the diff. `node_id` is the
 * comment's GraphQL id, which ties it to its thread (github.md §6.4); `in_reply_to_id` (the
 * thread's first comment) is a number on a reply only, and absent or null on a first comment
 * (ruling R6). `created_at` (ISO 8601) is what replies count by their age. `author_association`
 * says what the author is to the repository (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, …),
 * which decides whether their reply may change a finding's status (6I-4); GitHub always sends it.
 */
const reviewComment = z.looseObject({
  id: z.number().int(),
  node_id: z.string(),
  body: z.string(),
  user: z.looseObject({ login: z.string(), type: z.string() }).nullable(),
  html_url: z.string().optional(),
  in_reply_to_id: z.number().int().nullish(),
  path: z.string().optional(),
  created_at: z.string(),
  author_association: z.string().max(64).optional(),
});
export type GitHubReviewComment = z.infer<typeof reviewComment>;
/** A pull request review (github.md §6.4): only that GitHub made one is read. */
const review = z.looseObject({ id: z.number().int(), state: z.string() });
export type GitHubReview = z.infer<typeof review>;
const errorBody = z.looseObject({ message: z.unknown().optional() });

// GraphQL answers (github.md §5.3): `data` and, when it fails, `errors` around it. Each document
// above asks for exactly the fields its schema reads.
const graphqlAnswer = z.looseObject({
  data: z.unknown().optional(),
  errors: z
    .array(z.looseObject({ type: z.string().optional(), message: z.unknown().optional() }))
    .optional(),
});
const reviewThreadNode = z.looseObject({
  id: z.string().min(1),
  isResolved: z.boolean(),
  /** Whoever resolved it, an App as `<slug>[bot]` (ruling R6); null while the thread is open. */
  resolvedBy: z.looseObject({ login: z.string() }).nullable(),
  /** Its first comment's node id (GraphQL's `ID!`): a comment without one is not understood. */
  comments: z.looseObject({
    nodes: z.array(z.looseObject({ id: z.string().min(1) }).nullable()),
  }),
});
const reviewThreadsData = z.looseObject({
  repository: z
    .looseObject({
      pullRequest: z
        .looseObject({
          reviewThreads: z.looseObject({
            pageInfo: z.looseObject({
              hasNextPage: z.boolean(),
              endCursor: z.string().nullable(),
            }),
            nodes: z.array(reviewThreadNode.nullable()),
          }),
        })
        .nullable(),
    })
    .nullable(),
});
const threadPayload = z.looseObject({
  thread: z.looseObject({ id: z.string().min(1), isResolved: z.boolean() }),
});
const resolveThreadData = z.looseObject({ resolveReviewThread: threadPayload });
const unresolveThreadData = z.looseObject({ unresolveReviewThread: threadPayload });

/** Every recorded shape the client parses, for the shape tests (server/test/github-shapes/). */
export const GITHUB_SHAPES = {
  app,
  installation,
  installationToken,
  repository,
  checkRun,
  checkRuns,
  pullRequest,
  pullRequestFiles: z.array(file),
  issueComment: comment,
  issueComments: z.array(comment),
  reviewComment,
  /** What a reply answers with: a review comment, naming the first comment of its thread. */
  reviewCommentReply: reviewComment,
  reviewComments: z.array(reviewComment),
  review,
  reviewThreads: z.looseObject({ data: reviewThreadsData }),
  resolveThread: z.looseObject({ data: resolveThreadData }),
} as const;

/** A pull request's review thread as Qualor reads it (ruling R6). */
export interface GitHubReviewThread {
  /** The GraphQL node id (`PRRT_…`), what {@link GitHubClient.setThreadResolved} takes. */
  id: string;
  isResolved: boolean;
  /**
   * The login GitHub names as the thread's resolver; null while it is open. An App is named like
   * any other user, as `<slug>[bot]` (ruling R6), so a resolution is Qualor's own when this equals
   * its App's `<slug>[bot]` (github.md §6.3), which the caller compares. Anyone else's, a person's
   * or another App's, is never reopened (ruling G3), and neither is a resolved thread that GitHub
   * names nobody for.
   */
  resolvedByLogin: string | null;
  /**
   * The node id of the thread's first comment, which `reviewComments` lists as its `node_id`;
   * null when GitHub shows the thread without a comment.
   */
  firstCommentNodeId: string | null;
}

export interface CheckRunUpdate {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  detailsUrl: string | null;
  externalId: string;
}
export interface CheckRunInput extends CheckRunUpdate {
  name: string;
  headSha: string;
}

export interface GitHubConnectionInput {
  connectionId: string;
  /** Normalised, without a trailing slash (scm/url.ts), allowed by github/url.ts. */
  baseUrl: string;
  appId: string;
  privateKey: KeyObject;
  /** `credentialsId(appId, pkcs8)`: keys the token cache. */
  credentials: string;
  /** The host is in `QUALOR_SCM_INTERNAL_HOSTS` (scm.md §2.1). */
  allowInternalHosts: boolean;
}

export interface GitHubClientOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  resolve?: Resolver;
  maxRequests?: number;
  now?: () => number;
  /** The worker's per-process cache and pacer (scm/runtime.ts); fresh ones otherwise. */
  tokens?: InstallationTokenCache;
  pacer?: MutationPacer;
}

/**
 * When an answer's headers say to try again, in seconds (clamped to 1 s – 15 min): `Retry-After`
 * wins, then an exhausted primary limit's `x-ratelimit-reset`. Null for an exhausted primary limit
 * whose reset is unreadable; undefined when the headers name no wait.
 */
function headerWait(headers: IncomingHttpHeaders, nowMs: number): number | null | undefined {
  const clamp = (s: number) => Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(s)));
  const retryAfter = headers['retry-after'];
  if (typeof retryAfter === 'string' && /^\d{1,9}$/.test(retryAfter.trim())) {
    return clamp(Number(retryAfter));
  }
  if (headers['x-ratelimit-remaining'] !== '0') return undefined;
  const reset = headers['x-ratelimit-reset'];
  return typeof reset === 'string' && /^\d{1,12}$/.test(reset)
    ? clamp(Number(reset) - nowMs / 1000)
    : null;
}

/**
 * github.md §5.3: whether a 403 or 429 is a rate limit, and when to try again (`null`: the
 * backoff). `Retry-After` wins, then an exhausted primary limit's reset, then a secondary limit
 * named only in the message (60 s); a 429 is always a rate limit; any other 403 is not.
 */
export function githubRateLimit(
  status: number,
  headers: IncomingHttpHeaders,
  message: string | null,
  nowMs: number = Date.now(),
): { retryAfterSeconds: number | null } | null {
  if (status !== 403 && status !== 429) return null;
  const wait = headerWait(headers, nowMs);
  if (wait !== undefined) return { retryAfterSeconds: wait };
  if (message !== null && /secondary rate limit/i.test(message)) {
    return { retryAfterSeconds: SECONDARY_LIMIT_SECONDS };
  }
  return status === 429 ? { retryAfterSeconds: null } : null;
}

/** Longer than any `Link` header GitHub sends (at most four relations of one URL each). */
const MAX_LINK_HEADER_CHARS = 4_096;

/** A line number of a file, as a review comment's `line` or `start_line` takes it. */
const lineNumber = (n: number) => Number.isSafeInteger(n) && n > 0;

/**
 * The lines of a review comment on the RIGHT side as GitHub takes them: its `line`, which is the
 * last line of a comment over several, and for those `start_line` too. A range of one line is that
 * line: GitHub refuses a `start_line` equal to `line`. Null when they are no lines of a file.
 */
function commentLines(c: { line: number; startLine?: number }): Record<string, unknown> | null {
  if (!lineNumber(c.line)) return null;
  const { line, startLine } = c;
  if (startLine === undefined || startLine === line) return { line, side: 'RIGHT' };
  if (!lineNumber(startLine) || startLine > line) return null;
  return { line, side: 'RIGHT', start_line: startLine, start_side: 'RIGHT' };
}

/** github.md §5.3: a 422 on a review comment or review is a position GitHub will not place. */
function positionRefused(err: unknown): boolean {
  return err instanceof ScmError && err.kind === 'refused' && err.status === 422;
}

/**
 * Whether a `Link` header has a `rel="next"` entry; null when it is too long to read, which the
 * caller must not take for the last page. Its URL is never used (github.md §5.3).
 */
export function hasNextPage(link: string | string[] | undefined): boolean | null {
  if (typeof link !== 'string') return false;
  if (link.length > MAX_LINK_HEADER_CHARS) return null;
  return link.split(',').some((part) => /;\s*rel="?next"?\s*$/.test(part.trim()));
}

/** A message of GitHub's, cut to 1 000 characters, with every credential cut out should it echo one. */
function scrubbed(message: unknown, secrets: readonly string[]): string | null {
  if (typeof message !== 'string') return null;
  let text = message;
  for (const secret of secrets) if (secret !== '') text = text.split(secret).join('[secret]');
  return text.slice(0, 1_000);
}

/** GitHub's `message`, for decisions only, with every credential cut out should it echo one. */
function githubMessage(body: Buffer, secrets: readonly string[]): string | null {
  try {
    const parsed = errorBody.safeParse(JSON.parse(body.toString('utf8')));
    return parsed.success ? scrubbed(parsed.data.message, secrets) : null;
  } catch {
    return null;
  }
}

/**
 * github.md §5.3: GraphQL answers a failed operation with HTTP 200 and an `errors` array, whose
 * first entry's `type` (GitHub's own: `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, …) says which. The
 * status is 200 as GitHub did answer: the circuit breaker (scm.md §4.2) counts that as GitHub
 * being up. A rate limit waits as long as the answer's headers say, as a REST one does
 * (`Retry-After`, then an exhausted limit's `x-ratelimit-reset`), and GitHub's advice of a minute
 * when they say nothing. The provider's words are kept for decisions only, as everywhere
 * (`providerMessage`).
 */
function graphqlFailure(
  error: { type?: string | undefined; message?: unknown },
  secrets: readonly string[],
  headers: IncomingHttpHeaders,
  nowMs: number,
): ScmError {
  const providerMessage = scrubbed(error.message, secrets);
  switch (error.type) {
    case 'NOT_FOUND':
      return new ScmError('not_found', GITHUB_TEXT.notFound, {
        status: 200,
        reason: 'http',
        providerMessage,
      });
    case 'FORBIDDEN':
      return new ScmError('auth', GITHUB_TEXT.permission, {
        status: 200,
        reason: 'permission_missing',
        providerMessage,
      });
    case 'RATE_LIMITED':
      return new ScmError('rate_limited', GITHUB_TEXT.graphqlRateLimit, {
        status: 200,
        reason: 'http',
        retryAfterSeconds: headerWait(headers, nowMs) ?? SECONDARY_LIMIT_SECONDS,
        providerMessage,
      });
    default:
      return new ScmError('bad_answer', GITHUB_TEXT.badAnswer, { status: 200, providerMessage });
  }
}

function transportError(result: Extract<OutboundResult, { kind: 'failed' }>): ScmError {
  switch (result.cause) {
    case 'not_public':
      return new ScmError('refused', GITHUB_TEXT.notPublic, { reason: 'not_public' });
    case 'refused_address':
      return new ScmError('refused', GITHUB_TEXT.refusedAddress, { reason: 'not_public' });
    case 'unresolved':
      return new ScmError('transient', GITHUB_TEXT.unresolved, { reason: 'unresolved' });
    case 'too_large':
      return new ScmError('bad_answer', GITHUB_TEXT.badAnswer);
    case 'timeout':
    case 'connect_timeout':
      return new ScmError('transient', GITHUB_TEXT.timeout, { reason: 'timeout' });
    default:
      return new ScmError(
        'transient',
        result.code
          ? `GitHub could not be reached (${result.code})`
          : 'GitHub could not be reached',
        { reason: 'unreachable' },
      );
  }
}

type Auth = 'app' | 'installation';
type Method = 'GET' | 'POST' | 'PATCH';
/** A path under the connection's base URL (REST), or an absolute URL beside it (GraphQL). */
type Target = string | URL;
interface CallOptions {
  /**
   * Paced as a mutation. By default every method but GET is one; a GraphQL query is a POST that
   * is not.
   */
  mutation?: boolean;
}

/**
 * The GitHub REST API (github.md §4–§6), through {@link outboundRequest}: the connection's base
 * URL only, no redirect, 10 s per request, bounded answers, pages built by number, a budget of
 * {@link MAX_GITHUB_REQUESTS} per client (one client per job), mutations paced per installation.
 * Review threads, which REST cannot list with their state or resolve, go through the GraphQL
 * endpoint beside the base URL, under the same rules and the same budget (ruling R6). The private
 * key, the JWT and the installation token live in `#private` fields; no error, return value or log
 * line carries them.
 */
export class GitHubClient {
  private requestCount = 0;
  private readonly maxRequests: number;
  private readonly now: () => number;
  private readonly tokens: InstallationTokenCache;
  private readonly pacer: MutationPacer;
  readonly #connection: GitHubConnectionInput;
  #token: string | null = null;
  #jwt: string | null = null;
  #tokenKey: string | null = null;
  #installationId: number | null = null;
  #repo: GitHubRepoRef | null = null;
  #refreshed = false;

  constructor(
    connection: GitHubConnectionInput,
    private readonly options: GitHubClientOptions = {},
  ) {
    if (!isGitHubAppId(connection.appId)) {
      throw new ScmError('refused', GITHUB_TEXT.appId, { reason: 'invalid_input' });
    }
    this.#connection = connection;
    this.maxRequests = options.maxRequests ?? MAX_GITHUB_REQUESTS;
    this.now = options.now ?? Date.now;
    this.tokens = options.tokens ?? new InstallationTokenCache(this.now);
    this.pacer = options.pacer ?? new MutationPacer(this.now);
  }

  get requests(): number {
    return this.requestCount;
  }

  toJSON(): { baseUrl: string; requests: number } {
    return { baseUrl: this.#connection.baseUrl, requests: this.requestCount };
  }

  private invalid(text: string): ScmError {
    return new ScmError('refused', text, { reason: 'invalid_input' });
  }

  private repoRef(): GitHubRepoRef {
    if (!this.#repo) throw new Error('useRepository first');
    return this.#repo;
  }

  private repoPath(): string {
    const { owner, repo } = this.repoRef();
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private number(value: string): string {
    if (!GITHUB_PR_NUMBER.test(value)) throw this.invalid(GITHUB_TEXT.prNumber);
    return value;
  }

  private sha(value: string): string {
    if (!SHA.test(value)) throw this.invalid(GITHUB_TEXT.revision);
    return value;
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer);
    return parsed.data;
  }

  private async call(
    method: Method,
    target: Target,
    auth: Auth,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<{ headers: IncomingHttpHeaders; json: unknown }> {
    if (this.requestCount >= this.maxRequests) {
      throw new ScmError('budget', GITHUB_TEXT.budget, { reason: 'budget' });
    }
    this.requestCount += 1;
    const credential =
      auth === 'app'
        ? appJwt(this.#connection.appId, this.#connection.privateKey, Math.floor(this.now() / 1000))
        : this.#token;
    if (credential === null) throw new Error('no installation token');
    if (auth === 'app') this.#jwt = credential;
    if (options.mutation ?? method !== 'GET') {
      await this.pacer.wait(`${this.#connection.baseUrl}|${this.#installationId ?? 'app'}`);
    }
    const result = await outboundRequest(
      {
        url: typeof target === 'string' ? `${this.#connection.baseUrl}${target}` : target.href,
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': `Qualor/${VERSION}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      {
        allowInternalHosts: this.#connection.allowInternalHosts,
        refuseAddress: scmRefusedAddress(new URL(this.#connection.baseUrl)),
        timeoutMs: this.options.timeoutMs ?? GITHUB_TIMEOUT_MS,
        ...(this.options.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: this.options.connectTimeoutMs }),
        ...(this.options.resolve ? { resolve: this.options.resolve } : {}),
        maxResponseBytes: MAX_GITHUB_RESPONSE_BYTES,
        overflow: 'fail',
        names: { noun: 'GitHub', target: 'GitHub' },
      },
    );
    if (result.kind === 'failed') throw transportError(result);
    const { status, headers } = result;
    if (status >= 200 && status < 300) {
      if (result.body.length === 0) return { headers, json: null };
      try {
        return { headers, json: JSON.parse(result.body.toString('utf8')) };
      } catch {
        throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer, { status });
      }
    }
    const message = githubMessage(result.body, [credential, this.#token ?? '', this.#jwt ?? '']);
    if (status >= 300 && status < 400) {
      throw new ScmError('not_found', GITHUB_TEXT.notFound, { status, reason: 'http' });
    }
    const limit = githubRateLimit(status, headers, message, this.now());
    if (limit) {
      throw new ScmError('rate_limited', `GitHub answered HTTP ${status}`, {
        status,
        reason: 'http',
        retryAfterSeconds: limit.retryAfterSeconds,
        providerMessage: message,
      });
    }
    if (status === 401) {
      throw new ScmError(
        'auth',
        auth === 'app' ? GITHUB_TEXT.appRefused : GITHUB_TEXT.tokenRefused,
        {
          status,
          reason: 'http',
        },
      );
    }
    if (status === 403) {
      throw new ScmError('auth', GITHUB_TEXT.permission, { status, reason: 'permission_missing' });
    }
    if (status === 404) {
      throw new ScmError('not_found', GITHUB_TEXT.notFound, {
        status,
        reason: 'http',
        providerMessage: message,
      });
    }
    throw new ScmError(status >= 500 ? 'transient' : 'refused', `GitHub answered HTTP ${status}`, {
      status,
      reason: 'http',
      providerMessage: message,
    });
  }

  /** A repository call; after a 401, one fresh installation token and one more try (§4). */
  private async repoCall(
    method: Method,
    target: Target,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<{ headers: IncomingHttpHeaders; json: unknown }> {
    try {
      return await this.call(method, target, 'installation', body, options);
    } catch (err) {
      if (!(err instanceof ScmError) || err.status !== 401 || this.#refreshed) throw err;
      this.#refreshed = true;
      if (this.#tokenKey !== null) this.tokens.drop(this.#tokenKey);
      await this.issueToken();
      return this.call(method, target, 'installation', body, options);
    }
  }

  /**
   * One GraphQL operation on the endpoint beside the base URL (ruling T5), as a repository call:
   * the budget, the pacing (a mutation only), the headers, the outbound rules, the HTTP errors and
   * the one token refresh are `call`'s and `repoCall`'s. A failed operation is HTTP 200 with
   * `errors` (`graphqlFailure`); `data` next to an error is never used, so a failure is never
   * read as an empty result.
   */
  private async graphql<T>(
    document: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    mutation: boolean,
  ): Promise<T> {
    const { headers, json } = await this.repoCall(
      'POST',
      new URL(githubGraphqlUrl(this.#connection.baseUrl)),
      { query: document, variables },
      { mutation },
    );
    const answer = this.parse(graphqlAnswer, json);
    const [failure] = answer.errors ?? [];
    if (failure !== undefined) {
      throw graphqlFailure(failure, [this.#token ?? '', this.#jwt ?? ''], headers, this.now());
    }
    if (answer.data === null || answer.data === undefined) {
      throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer, { status: 200 });
    }
    return this.parse(schema, answer.data);
  }

  private async pages<T>(path: string, schema: z.ZodType<T>, maxPages: number): Promise<Paged<T>> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const { headers, json } = await this.repoCall(
        'GET',
        `${path}${separator}per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      );
      items.push(...this.parse(z.array(schema), json));
      const next = hasNextPage(headers.link);
      // An unreadable Link header is not understood, never "the last page": a list taken as
      // complete would let the caller post a second summary comment (github.md §6.3).
      if (next === null) throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer);
      if (!next) return { items, complete: true };
    }
    return { items, complete: false };
  }

  /** `GET /app` with the JWT: the App's id (checked) and slug (github.md §6.3). */
  async app(): Promise<GitHubApp> {
    const { json } = await this.call('GET', '/app', 'app');
    const found = this.parse(app, json);
    if (String(found.id) !== this.#connection.appId) {
      throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer);
    }
    return found;
  }

  /**
   * github.md §4: the repository's installation (JWT), a token scoped to it (cached), then
   * `GET /repos/{owner}/{repo}`. Every later call of this client is on this repository.
   */
  async useRepository(ref: GitHubRepoRef): Promise<GitHubRepository> {
    // Checked here too, not only where the mapping is saved: no dot segment or slash reaches a path.
    const dotSegment = (part: string) => part === '.' || part === '..';
    if (
      dotSegment(ref.owner) ||
      dotSegment(ref.repo) ||
      !GITHUB_REPO_PATTERN.test(`${ref.owner}/${ref.repo}`)
    ) {
      throw this.invalid(GITHUB_TEXT.repo);
    }
    this.#repo = { owner: ref.owner, repo: ref.repo };
    let found: z.infer<typeof installation>;
    try {
      const { json } = await this.call('GET', `${this.repoPath()}/installation`, 'app');
      found = this.parse(installation, json);
    } catch (err) {
      if (err instanceof ScmError && err.status === 404) {
        throw new ScmError('not_found', GITHUB_TEXT.notInstalled, {
          status: 404,
          reason: 'not_installed',
        });
      }
      throw err;
    }
    if (String(found.app_id) !== this.#connection.appId) {
      throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer);
    }
    this.#installationId = found.id;
    this.#tokenKey = tokenCacheKey({
      connectionId: this.#connection.connectionId,
      credentials: this.#connection.credentials,
      installationId: found.id,
      repo: `${ref.owner}/${ref.repo}`,
    });
    this.#token = this.tokens.get(this.#tokenKey);
    if (this.#token === null) await this.issueToken();
    const { json } = await this.repoCall('GET', this.repoPath());
    return this.parse(repository, json);
  }

  private async issueToken(): Promise<void> {
    if (this.#installationId === null || this.#repo === null || this.#tokenKey === null) {
      throw new Error('useRepository first');
    }
    let json: unknown;
    try {
      ({ json } = await this.call(
        'POST',
        `/app/installations/${this.#installationId}/access_tokens`,
        'app',
        { repositories: [this.#repo.repo], permissions: INSTALLATION_PERMISSIONS },
      ));
    } catch (err) {
      if (
        err instanceof ScmError &&
        err.kind !== 'rate_limited' &&
        (err.status === 422 || err.status === 403)
      ) {
        // 422: a permission or the repository is not granted to the installation; 403: the same,
        // or the installation is suspended (GitHub's message tells them apart; it is never shown).
        throw new ScmError(
          'auth',
          err.status === 403 ? GITHUB_TEXT.permissionOrSuspended : GITHUB_TEXT.permission,
          {
            status: err.status,
            reason: 'permission_missing',
          },
        );
      }
      throw err;
    }
    const issued = this.parse(installationToken, json);
    this.#token = issued.token;
    this.tokens.set(this.#tokenKey, issued.token, Date.parse(issued.expires_at));
  }

  /** Qualor's current check runs of `name` on `sha`: this App's only, the newest per name. */
  async checkRuns(revision: string, name: string): Promise<GitHubCheckRun[]> {
    const path = `${this.repoPath()}/commits/${this.sha(revision)}/check-runs?check_name=${encodeURIComponent(name)}&app_id=${this.#connection.appId}&filter=latest&per_page=${GITHUB_PAGE_SIZE}`;
    const { json } = await this.repoCall('GET', path);
    const appId = Number(this.#connection.appId);
    return this.parse(checkRuns, json).check_runs.filter(
      (r) => r.name === name && r.app?.id === appId,
    );
  }

  private checkRunBody(input: CheckRunUpdate) {
    return {
      status: 'completed',
      conclusion: input.conclusion,
      completed_at: new Date(this.now()).toISOString(),
      external_id: input.externalId,
      ...(input.detailsUrl === null ? {} : { details_url: input.detailsUrl }),
    };
  }

  /** A new check run; its output is a title and a summary, never annotations (github.md §6.1). */
  async createCheckRun(input: CheckRunInput): Promise<GitHubCheckRun> {
    const { json } = await this.repoCall('POST', `${this.repoPath()}/check-runs`, {
      name: input.name,
      head_sha: this.sha(input.headSha),
      ...this.checkRunBody(input),
      output: { title: input.title, summary: input.summary },
    });
    return this.parse(checkRun, json);
  }

  /** Updates the conclusion and the output (title and summary) of a check run. */
  async updateCheckRun(id: number, input: CheckRunUpdate): Promise<GitHubCheckRun> {
    if (!Number.isSafeInteger(id) || id <= 0) throw this.invalid(GITHUB_TEXT.id);
    const { json } = await this.repoCall('PATCH', `${this.repoPath()}/check-runs/${id}`, {
      ...this.checkRunBody(input),
      output: { title: input.title, summary: input.summary },
    });
    return this.parse(checkRun, json);
  }

  async pullRequest(number: string): Promise<GitHubPullRequest> {
    const { json } = await this.repoCall('GET', `${this.repoPath()}/pulls/${this.number(number)}`);
    return this.parse(pullRequest, json);
  }

  pullRequestFiles(number: string, maxPages: number): Promise<Paged<GitHubFile>> {
    return this.pages(`${this.repoPath()}/pulls/${this.number(number)}/files`, file, maxPages);
  }

  issueComments(number: string, maxPages: number): Promise<Paged<GitHubComment>> {
    return this.pages(
      `${this.repoPath()}/issues/${this.number(number)}/comments`,
      comment,
      maxPages,
    );
  }

  async createComment(number: string, body: string): Promise<GitHubComment> {
    const { json } = await this.repoCall(
      'POST',
      `${this.repoPath()}/issues/${this.number(number)}/comments`,
      { body },
    );
    return this.parse(comment, json);
  }

  /** The pull request's review comments (comments on lines of its diff), oldest first. */
  reviewComments(number: string, maxPages: number): Promise<Paged<GitHubReviewComment>> {
    return this.pages(
      `${this.repoPath()}/pulls/${this.number(number)}/comments`,
      reviewComment,
      maxPages,
    );
  }

  /**
   * llm.md §8.4: a review comment on RIGHT-side lines `startLine..line` of `path` at `commitId`
   * (one line without `startLine`); `position_rejected` on a 422 (lines GitHub will not place).
   */
  async createReviewComment(
    number: string,
    input: { body: string; commitId: string; path: string; line: number; startLine?: number },
  ): Promise<GitHubReviewComment | 'position_rejected'> {
    const lines = commentLines(input);
    if (lines === null) throw this.invalid(GITHUB_TEXT.line);
    try {
      const { json } = await this.repoCall(
        'POST',
        `${this.repoPath()}/pulls/${this.number(number)}/comments`,
        {
          body: input.body,
          commit_id: this.sha(input.commitId),
          path: input.path,
          ...lines,
        },
      );
      return this.parse(reviewComment, json);
    } catch (err) {
      if (positionRefused(err)) return 'position_rejected';
      throw err;
    }
  }

  /**
   * A reply in the review thread whose first comment is `firstCommentId`: the new review comment,
   * which names that comment in `in_reply_to_id`. GitHub takes a reply to a thread's first comment
   * only, never to a reply; it answers a comment it has no such first comment for with 404, which
   * is `not_found`.
   */
  async replyToReviewComment(
    number: string,
    firstCommentId: number,
    body: string,
  ): Promise<GitHubReviewComment> {
    if (!Number.isSafeInteger(firstCommentId) || firstCommentId <= 0) {
      throw this.invalid(GITHUB_TEXT.id);
    }
    const { json } = await this.repoCall(
      'POST',
      `${this.repoPath()}/pulls/${this.number(number)}/comments/${firstCommentId}/replies`,
      { body },
    );
    return this.parse(reviewComment, json);
  }

  /**
   * github.md §6.4: one pull request review (`event: COMMENT`) at `commitId` that holds a review
   * comment on the RIGHT side of `line` of `path` (the lines `startLine..line` when it has a
   * `startLine`) for each of `comments`, each the first of a thread: one request, one notification
   * and one timeline entry for them all. `body` is the review's own text, which GitHub requires
   * with `COMMENT`; it is no review comment. `position_rejected` on a 422: GitHub will not place a
   * position of the batch (or refused the request as spam), and made none of the comments.
   */
  async createReview(
    number: string,
    input: {
      body: string;
      commitId: string;
      comments: readonly { path: string; line: number; startLine?: number; body: string }[];
    },
  ): Promise<GitHubReview | 'position_rejected'> {
    if (input.comments.length === 0) throw new Error('a review of no comments');
    const lines = input.comments.map(commentLines);
    if (lines.includes(null)) throw this.invalid(GITHUB_TEXT.line);
    try {
      const { json } = await this.repoCall(
        'POST',
        `${this.repoPath()}/pulls/${this.number(number)}/reviews`,
        {
          commit_id: this.sha(input.commitId),
          event: 'COMMENT',
          body: input.body,
          comments: input.comments.map((c, i) => ({ path: c.path, ...lines[i], body: c.body })),
        },
      );
      return this.parse(review, json);
    } catch (err) {
      if (positionRefused(err)) return 'position_rejected';
      throw err;
    }
  }

  /** One page of a pull request's review threads, after the cursor `after`. */
  private async threadsPage(pull: number, after: string | null) {
    const { owner, repo } = this.repoRef();
    const data = await this.graphql(
      REVIEW_THREADS_QUERY,
      { owner, name: repo, number: pull, after },
      reviewThreadsData,
      false,
    );
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (threads === undefined) {
      throw new ScmError('not_found', GITHUB_TEXT.notFound, { status: 200, reason: 'http' });
    }
    return threads;
  }

  /**
   * github.md §6.4 (ruling R6): the pull request's review threads, 100 to a page by cursor, at
   * most `maxPages` pages (`complete: false` when more remain). Only a thread's node id, its
   * resolution with the resolver's login, and its first comment's node id are read here; who
   * wrote the comments is read from {@link reviewComments}. A pull request that is not there is
   * `not_found`, never an empty list.
   */
  async reviewThreads(number: string, maxPages: number): Promise<Paged<GitHubReviewThread>> {
    const pull = Number(this.number(number));
    // GraphQL's Int! refuses anything larger; GitHub has no such pull request anyway.
    if (pull > GRAPHQL_MAX_INT) throw this.invalid(GITHUB_TEXT.prNumber);
    const items: GitHubReviewThread[] = [];
    let after: string | null = null;
    for (let page = 1; page <= maxPages; page++) {
      const threads = await this.threadsPage(pull, after);
      for (const thread of threads.nodes) {
        if (thread === null) continue;
        items.push({
          id: thread.id,
          isResolved: thread.isResolved,
          resolvedByLogin: thread.resolvedBy?.login ?? null,
          firstCommentNodeId: thread.comments.nodes[0]?.id ?? null,
        });
      }
      if (!threads.pageInfo.hasNextPage) return { items, complete: true };
      // A next page without a cursor to ask for it is not understood, never "the last page".
      if (threads.pageInfo.endCursor === null) {
        throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer);
      }
      after = threads.pageInfo.endCursor;
    }
    return { items, complete: false };
  }

  /**
   * Resolves (`resolved`) or reopens a review thread. `not_found` when GitHub no longer knows the
   * thread (its comments were deleted): the caller skips it. Done means GitHub reports the state
   * asked for. Through an installation token the resolver GitHub names is the App's own
   * `<slug>[bot]` (ruling R6); a reopened thread names none.
   */
  async setThreadResolved(threadId: string, resolved: boolean): Promise<'done' | 'not_found'> {
    if (!NODE_ID.test(threadId)) throw this.invalid(GITHUB_TEXT.id);
    const variables = { id: threadId };
    try {
      let state: boolean;
      if (resolved) {
        const data = await this.graphql(
          RESOLVE_THREAD_MUTATION,
          variables,
          resolveThreadData,
          true,
        );
        state = data.resolveReviewThread.thread.isResolved;
      } else {
        const data = await this.graphql(
          UNRESOLVE_THREAD_MUTATION,
          variables,
          unresolveThreadData,
          true,
        );
        state = data.unresolveReviewThread.thread.isResolved;
      }
      if (state !== resolved)
        throw new ScmError('bad_answer', GITHUB_TEXT.badAnswer, { status: 200 });
      return 'done';
    } catch (err) {
      if (err instanceof ScmError && err.kind === 'not_found') return 'not_found';
      throw err;
    }
  }

  async updateComment(id: number, body: string): Promise<GitHubComment> {
    if (!Number.isSafeInteger(id) || id <= 0) throw this.invalid(GITHUB_TEXT.id);
    const { json } = await this.repoCall('PATCH', `${this.repoPath()}/issues/comments/${id}`, {
      body,
    });
    return this.parse(comment, json);
  }
}
