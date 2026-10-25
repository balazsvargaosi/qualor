import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A local fake of the GitHub REST endpoints Qualor uses (github.md §4–§6, §13), served under
 * `/api/v3` as GitHub Enterprise Server serves them, and of the GraphQL endpoint beside them
 * (`/api/graphql`, the same layout) for review threads and their resolution, for tests: nothing in
 * `pnpm test` contacts a real GitHub. Answers are built from `github-shapes/`, written from
 * GitHub's REST and GraphQL documentation (API version 2022-11-28), NOT captured from a live
 * GitHub: a behaviour listed here is what the documentation says, and plan 2C lists the ones no
 * real answer confirmed (6I-1 adds one: that a thread resolved with an installation token names
 * the App's own `<slug>[bot]` as `resolvedBy`, as github.com does for other Apps, ruling R6).
 *
 * What it checks where Qualor depends on it: the App JWT (RS256 with the App's public key, `iss`
 * the App id, `iat` not in the fake's future, at most 10 minutes); installation tokens (issued
 * only for repositories and permissions the installation has, expiring after an hour, revocable);
 * each endpoint's permission; at most 50 annotations per request (appended on PATCH, as GitHub
 * does: Qualor sends none now, but a check run of 0.11 carries some, and GitHub never removes
 * them); `filter=latest` and `app_id` of the check-run listing; `Link` headers with `rel="next"`.
 *
 * A pull request review (`POST /pulls/{n}/reviews`) is all or nothing, as GitHub's: one comment
 * GitHub would not place refuses it (422) and makes none of its comments. GitHub requires a body
 * with `event: COMMENT`; a review without an event would stay pending, which Qualor never makes
 * and the fake does not model (a 422 too). A review's body is no review comment.
 *
 * A review comment over several lines (`start_line` and `line`, both on the RIGHT side with
 * `start_side: 'RIGHT'`) is placed only when the patch shows each of its lines, in a review or
 * posted alone, and keeps its range (`start_line`, `original_start_line`, `start_side`) in the
 * listing, as GitHub lists it; a comment on one line lists them as `null`.
 *
 * Review comment ids are past 2^31, as github.com's are (from 3 000 000 001), and each comment has
 * a node id of its own (`PRRC_` and its id in base 62, {@link reviewCommentNodeId}), which REST
 * lists as `node_id` and GraphQL as the comment's `id`. GraphQL offers neither `databaseId`
 * (deprecated by GitHub: it cannot hold such ids) nor `fullDatabaseId` (an older GitHub Enterprise
 * Server has none): a query asking for either fails as a query of an unknown field does.
 *
 * A reply to a review comment (`POST /pulls/{n}/comments/{id}/replies`) is taken for the first
 * comment of a thread only: GitHub documents no reply to a reply, and the fake answers one, like a
 * comment it has none of, with the 404 that endpoint lists. Every issue comment and review comment
 * carries `created_at` and `updated_at` read from the fake's clock (`now`) when it was made.
 *
 * A user's permission on a repository (`GET /repos/{owner}/{repo}/collaborators/{user}/permission`,
 * under the Metadata (read) permission) is what a test set with `setPermission`; anyone else has
 * none, which GitHub answers with a 404.
 */

const SHAPES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'github-shapes');

export function githubShape(name: string): Record<string, unknown>;
export function githubShape<T>(name: string): T;
export function githubShape(name: string): unknown {
  return JSON.parse(readFileSync(path.join(SHAPES, `${name}.json`), 'utf8'));
}

type Access = 'read' | 'write';
export interface FakeRepository {
  id: number;
  owner: string;
  name: string;
  /** Null: the App is not installed on it. */
  installationId: number | null;
  /** What the installation was granted (default: checks, pull_requests write, metadata read). */
  permissions?: Record<string, Access>;
  /**
   * Renamed or transferred to this `owner/name`: a 301 which, as GitHub's, points to
   * `/repositories/{id}` rather than to the new name.
   */
  movedTo?: string;
  /** The installation is suspended: a 403 on the token request. */
  suspended?: boolean;
}
export interface FakeFile {
  filename: string;
  status?: string;
  /** Absent for a binary or too-large file. */
  patch?: string;
}
export interface FakePull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  /** A draft pull request; false when left out. */
  draft?: boolean;
  /** A closed pull request that was merged; false when left out. */
  merged?: boolean;
  headSha: string;
  baseSha: string;
  files: FakeFile[];
}
export interface FakeComment {
  id: number;
  repoId: number;
  issue: number;
  body: string;
  user: { login: string; id: number; type: 'Bot' | 'User' };
  /**
   * When the comment was made, as GitHub writes it (ISO 8601, UTC, to the second): the fake's
   * clock when it made it. A comment built by hand says when, so that no test depends on a date it
   * never chose.
   */
  createdAt: string;
}
/** A pull request review comment: a comment on RIGHT-side lines of one file's diff. */
export interface FakeReviewComment {
  /** The REST id, past 2^31 as github.com's are; its node id is {@link reviewCommentNodeId}. */
  id: number;
  repoId: number;
  pull: number;
  body: string;
  path: string;
  line: number;
  startLine: number | null;
  side: string;
  commitId: string;
  user: { login: string; id: number; type: 'Bot' | 'User' };
  /** The thread's first comment, for a reply (REST's `in_reply_to_id`); null for a first comment. */
  inReplyToId: number | null;
  /** As {@link FakeComment.createdAt}. */
  createdAt: string;
}
/** A review thread: a first review comment and the replies to it (GraphQL's `PullRequestReviewThread`). */
export interface FakeReviewThread {
  /** The GraphQL node id (`PRRT_…`). */
  id: string;
  repoId: number;
  pull: number;
  /** The REST ids of its comments, the first comment's first. */
  commentIds: number[];
  resolved: boolean;
  /**
   * The login of whoever resolved it, which GraphQL's `resolvedBy` names: a person's, or an App's
   * `<slug>[bot]` (ruling R6), this fake App's own when the thread was resolved through the API
   * with an installation token. Null while the thread is open.
   */
  resolvedBy: string | null;
}
/**
 * A pull request review (`POST /pulls/{n}/reviews`): a body of its own, which is no review
 * comment and starts no thread, and the review comments it made, each the first of a thread.
 */
export interface FakeReview {
  id: number;
  repoId: number;
  pull: number;
  body: string;
  /** `COMMENT`, `APPROVE` or `REQUEST_CHANGES`: a pending review (no event) is not modelled. */
  event: string;
  commitId: string;
  /** The REST ids of the review comments it made. */
  commentIds: number[];
}
export interface FakeCheckRun {
  id: number;
  repoId: number;
  appId: number;
  name: string;
  headSha: string;
  conclusion: string | null;
  externalId: string | null;
  detailsUrl: string | null;
  title: string | null;
  summary: string | null;
  annotations: Record<string, unknown>[];
}
export interface RecordedRequest {
  method: string;
  /** Without the `/api/v3` prefix, with the query (GraphQL: `/api/graphql`). */
  path: string;
  auth: 'jwt' | 'token' | 'none';
  body: string;
  headers: Record<string, string | string[] | undefined>;
}
export interface InjectedAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Runs before the answer, once the request is in `requests`: a test's change in the middle of a
   * job, such as storing what a request sent whose answer then never arrives.
   */
  before?: () => void;
  /** After `before`, answer as the fake normally would (`status` is then ignored). */
  passThrough?: boolean;
}
export interface FakeGitHub {
  /** The API base URL (`http://127.0.0.1:<port>/api/v3`); GraphQL is beside it, at `/api/graphql`. */
  url: string;
  appId: number;
  slug: string;
  privateKeyPem: string;
  requests: RecordedRequest[];
  comments: FakeComment[];
  /** Pull request review comments (`/pulls/{n}/comments`). */
  reviewComments: FakeReviewComment[];
  /**
   * One thread per first review comment, which `POST /pulls/{n}/comments` starts, and each
   * comment of a `POST /pulls/{n}/reviews`.
   */
  reviewThreads: FakeReviewThread[];
  /** Pull request reviews (`POST /pulls/{n}/reviews`), with their own bodies. */
  reviews: FakeReview[];
  checkRuns: FakeCheckRun[];
  /** Issued installation tokens and their scope. */
  tokens: Map<
    string,
    {
      installationId: number;
      repositories: string[];
      permissions: Record<string, Access>;
      expiresAt: number;
    }
  >;
  addRepository(repo: FakeRepository): void;
  addPull(repoId: number, pull: FakePull): void;
  updatePull(repoId: number, number: number, changes: Partial<FakePull>): void;
  addComment(
    repoId: number,
    issue: number,
    comment: { body: string; login: string; type?: 'Bot' | 'User' },
  ): FakeComment;
  /**
   * A check run of this App as an earlier request made it (a version of Qualor before this one,
   * say), with the next id: older than any check run made after it, as GitHub's ids grow.
   */
  addCheckRun(
    repoId: number,
    run: Pick<FakeCheckRun, 'name' | 'headSha' | 'externalId'> &
      Partial<
        Pick<FakeCheckRun, 'conclusion' | 'detailsUrl' | 'title' | 'summary' | 'annotations'>
      >,
  ): FakeCheckRun;
  /**
   * A reply to the thread's first review comment `commentId` (GitHub takes no reply to a reply),
   * by `login`; the thread keeps its first comment and gains the reply.
   */
  replyToReviewComment(
    repoId: number,
    pull: number,
    commentId: number,
    reply: { body: string; login: string; type?: 'Bot' | 'User' },
  ): FakeReviewComment;
  /**
   * The user's permission on the repository, as GitHub's permission endpoint answers it: its legacy
   * `permission` (`admin`, `write`, `read` or `none`) and its `roleName` (`admin`, `maintain`,
   * `write`, `triage`, `read` or a custom role's name; null: no `role_name` at all, as an older
   * GitHub Enterprise Server answers). Null: none (a 404). Logins are compared without case, as
   * GitHub's are.
   */
  setPermission(
    repoId: number,
    login: string,
    permission: { permission: string; roleName: string | null } | null,
  ): void;
  /** The thread is resolved by someone else: a person's `login`, or another App's `<slug>[bot]`. */
  resolveThreadAs(threadId: string, login: string): void;
  /** Every issued token stops working (an uninstall, a revocation). */
  revokeTokens(): void;
  inject(method: string, path: RegExp, ...answers: InjectedAnswer[]): void;
  clearRequests(): void;
  close(): Promise<void>;
}

/** A check run's request body as a client may send it (types unchecked until validated). */
interface CheckRunBody {
  name?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  external_id?: string;
  details_url?: string;
  output?: { title?: string; summary?: string; annotations?: Record<string, unknown>[] };
}
/** A review comment as a client may send it, alone or in a review (types unchecked). */
interface ReviewCommentBody {
  body?: unknown;
  path?: unknown;
  side?: unknown;
  line?: unknown;
  start_line?: unknown;
  start_side?: unknown;
}
/** A pull request review as a client may send it (types unchecked). */
interface ReviewBody {
  commit_id?: unknown;
  event?: unknown;
  body?: unknown;
  comments?: unknown;
}
/** What a review's `event` makes of it; without one it would stay pending (not modelled). */
const REVIEW_STATES: Readonly<Record<string, string>> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
};

const DEFAULT_PERMISSIONS: Record<string, Access> = {
  checks: 'write',
  pull_requests: 'write',
  metadata: 'read',
};
const PREFIX = '/api/v3';
/** Where GitHub Enterprise Server serves GraphQL: beside `/api/v3`, not under it. */
const GRAPHQL_PATH = '/api/graphql';
/** GraphQL's `Int`: a signed 32-bit integer. */
const GRAPHQL_MAX_INT = 2_147_483_647;
/** The first review comment id: past GraphQL's `Int`, as github.com's ids are. */
const FIRST_REVIEW_COMMENT_ID = 3_000_000_001;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Comment fields GitHub's GraphQL schema lacks here (`fullDatabaseId`: an older GHES). */
const UNKNOWN_COMMENT_FIELD = /\b(fullDatabaseId|databaseId)\b/;

/**
 * The node id of the review comment `id`, as the fake makes them: `PRRC_` and the id in base 62.
 * REST lists it as `node_id`, GraphQL as the comment's `id`.
 */
export function reviewCommentNodeId(id: number): string {
  let rest = id;
  let digits = '';
  do {
    digits = BASE62.charAt(rest % 62) + digits;
    rest = Math.floor(rest / 62);
  } while (rest > 0);
  return `PRRC_${digits}`;
}
const LEVELS = new Set(['notice', 'warning', 'failure']);
const CONCLUSIONS = new Set([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
]);

/**
 * The new-file lines a patch shows (added and context lines of its hunks): where GitHub places a
 * RIGHT-side review comment. Written apart from the server's diff reader, so the two check each
 * other.
 */
function rightSideLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) next = Number(hunk[1]);
    else if (next > 0 && (text.startsWith('+') || text.startsWith(' '))) lines.add(next++);
  }
  return lines;
}

/**
 * What a list of requests changed on GitHub, as `METHOD path` in the order sent: every request but
 * a GET, an installation token request (it changes nothing) and a GraphQL query (a POST that only
 * reads). A GraphQL mutation is listed with its operation, `POST /api/graphql QualorResolveThread`;
 * one this function cannot read counts as a change, so a test never passes on what it did not see.
 */
export function githubWrites(requests: readonly RecordedRequest[]): string[] {
  const writes: string[] = [];
  for (const r of requests) {
    if (r.method === 'GET' || r.path.endsWith('/access_tokens')) continue;
    if (r.path !== GRAPHQL_PATH) {
      writes.push(`${r.method} ${r.path}`);
      continue;
    }
    let document = '';
    try {
      const sent = JSON.parse(r.body) as { query?: unknown };
      if (typeof sent.query === 'string') document = sent.query;
    } catch {
      // Not JSON: left unread, so it is listed below.
    }
    const operation = /^\s*(query|mutation)\s+(\w+)/.exec(document);
    if (operation?.[1] !== 'query')
      writes.push(`${r.method} ${r.path} ${operation?.[2] ?? ''}`.trim());
  }
  return writes;
}

let sharedKey: { privateKey: KeyObject; pem: string } | null = null;
/** One 2048-bit key per test process (generating one takes ~100 ms). */
function appKey(): { privateKey: KeyObject; pem: string } {
  if (!sharedKey) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    sharedKey = { privateKey, pem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };
  }
  return sharedKey;
}

export async function createFakeGitHub(
  options: { appId?: number; slug?: string; now?: () => number } = {},
): Promise<FakeGitHub> {
  const appId = options.appId ?? 123456;
  const slug = options.slug ?? 'qualor-acme';
  const now = options.now ?? Date.now;
  /** The fake's clock as GitHub writes it in `created_at`: ISO 8601 in UTC, to the second. */
  const stamp = () => new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const key = appKey();
  const publicKey = createPublicKey(key.privateKey);
  const repos = new Map<string, FakeRepository>();
  const pulls = new Map<string, FakePull>();
  /** The users' permissions on repositories (`setPermission`), by repository id and login. */
  const permissions = new Map<string, { permission: string; roleName: string | null }>();
  const permissionKey = (repoId: number, login: string) => `${repoId}|${login.toLowerCase()}`;
  const permissionShape = githubShape('collaborator_permission');
  const injections: { method: string; path: RegExp; answers: InjectedAnswer[] }[] = [];
  let nextId = 1;
  let nextThread = 1;
  let nextReviewComment = FIRST_REVIEW_COMMENT_ID;

  /**
   * The reply `body` by `user` to `first`, the first comment of `thread`: the thread keeps its first
   * comment and gains the reply. The reply is on the lines of the first comment, with a date and an
   * id of its own.
   */
  const addReply = (
    first: FakeReviewComment,
    thread: FakeReviewThread,
    user: FakeReviewComment['user'],
    body: string,
  ): FakeReviewComment => {
    const reply: FakeReviewComment = {
      ...first,
      id: nextReviewComment++,
      body,
      user,
      inReplyToId: first.id,
      createdAt: stamp(),
    };
    fake.reviewComments.push(reply);
    thread.commentIds.push(reply.id);
    return reply;
  };

  const fake: FakeGitHub = {
    url: '',
    appId,
    slug,
    privateKeyPem: key.pem,
    requests: [],
    comments: [],
    reviewComments: [],
    reviewThreads: [],
    reviews: [],
    checkRuns: [],
    tokens: new Map(),
    addRepository: (repo) => repos.set(`${repo.owner}/${repo.name}`.toLowerCase(), repo),
    addPull: (repoId, pull) => pulls.set(`${repoId}#${pull.number}`, structuredClone(pull)),
    updatePull: (repoId, number, changes) => {
      const pull = pulls.get(`${repoId}#${number}`);
      if (pull) Object.assign(pull, changes);
    },
    addComment: (repoId, issue, c) => {
      const comment: FakeComment = {
        id: nextId++,
        repoId,
        issue,
        body: c.body,
        user: { login: c.login, id: c.type === 'Bot' ? 41898282 : 5, type: c.type ?? 'User' },
        createdAt: stamp(),
      };
      fake.comments.push(comment);
      return comment;
    },
    addCheckRun: (repoId, run) => {
      const created: FakeCheckRun = {
        conclusion: null,
        detailsUrl: null,
        title: null,
        summary: null,
        annotations: [],
        ...run,
        id: nextId++,
        repoId,
        appId,
      };
      fake.checkRuns.push(created);
      return created;
    },
    replyToReviewComment: (repoId, pull, commentId, reply) => {
      const first = fake.reviewComments.find(
        (c) => c.id === commentId && c.repoId === repoId && c.pull === pull,
      );
      const thread = fake.reviewThreads.find((t) => t.commentIds[0] === commentId);
      if (!first || !thread || first.inReplyToId !== null) {
        throw new Error(`no first review comment ${commentId} on pull request ${pull}`);
      }
      return addReply(
        first,
        thread,
        { login: reply.login, id: reply.type === 'Bot' ? 41898282 : 5, type: reply.type ?? 'User' },
        reply.body,
      );
    },
    setPermission: (repoId, login, permission) => {
      const key = permissionKey(repoId, login);
      if (permission === null) permissions.delete(key);
      else permissions.set(key, permission);
    },
    resolveThreadAs: (threadId, login) => {
      const thread = fake.reviewThreads.find((t) => t.id === threadId);
      if (!thread) throw new Error(`no review thread ${threadId}`);
      thread.resolved = true;
      thread.resolvedBy = login;
    },
    revokeTokens: () => fake.tokens.clear(),
    inject: (method, p, ...answers) => injections.push({ method, path: p, answers }),
    clearRequests: () => {
      fake.requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const send = (
    res: ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res
      .writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      .end(text);
  };
  const deny = (res: ServerResponse, status: number, message: string) =>
    send(res, status, {
      message,
      documentation_url: 'https://docs.github.com/rest',
      status: String(status),
    });

  const jwtOk = (token: string): boolean => {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return false;
    if (!verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')))
      return false;
    try {
      const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string };
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
        iat: number;
        exp: number;
        iss: unknown;
      };
      const t = Math.floor(now() / 1000);
      return (
        header.alg === 'RS256' &&
        String(claims.iss) === String(appId) &&
        claims.iat <= t &&
        claims.exp > t &&
        claims.exp - claims.iat <= 600
      );
    } catch {
      return false;
    }
  };

  const page = <T>(req: URL, res: ServerResponse, items: T[]) => {
    const per = Math.min(Number(req.searchParams.get('per_page') ?? '30'), 100);
    const n = Number(req.searchParams.get('page') ?? '1');
    const slice = items.slice((n - 1) * per, n * per);
    const headers: Record<string, string> = {};
    if (n * per < items.length) {
      const next = new URL(req.href);
      next.searchParams.set('page', String(n + 1));
      headers.link = `<${next.href}>; rel="next", <${next.href}>; rel="last"`;
    }
    send(res, 200, slice, headers);
  };

  /** Where the fake's own links live, as GitHub Enterprise Server's are: the API URL without `/api/v3`. */
  const webBase = () => fake.url.slice(0, -PREFIX.length);

  const checkRunJson = (run: FakeCheckRun) => ({
    ...githubShape('check_run'),
    id: run.id,
    name: run.name,
    head_sha: run.headSha,
    status: 'completed',
    conclusion: run.conclusion,
    external_id: run.externalId,
    details_url: run.detailsUrl,
    output: {
      title: run.title,
      summary: run.summary,
      text: null,
      annotations_count: run.annotations.length,
      annotations_url: '',
    },
    app: { id: run.appId, slug, name: 'Qualor' },
  });

  const commentJson = (c: FakeComment) => ({
    ...githubShape('issue_comment'),
    id: c.id,
    body: c.body,
    user: c.user,
    created_at: c.createdAt,
    // A comment not edited since it was made: `updated_at` is `created_at`, as GitHub has it.
    updated_at: c.createdAt,
    performed_via_github_app: c.user.type === 'Bot' ? { id: appId, slug } : null,
  });

  const reviewCommentJson = (repo: FakeRepository) => (c: FakeReviewComment) => {
    const shape = githubShape(
      c.inReplyToId === null ? 'pull_request_review_comment' : 'pull_request_review_comment_reply',
    );
    return {
      ...shape,
      id: c.id,
      node_id: reviewCommentNodeId(c.id),
      body: c.body,
      path: c.path,
      commit_id: c.commitId,
      original_commit_id: c.commitId,
      line: c.line,
      original_line: c.line,
      start_line: c.startLine,
      original_start_line: c.startLine,
      start_side: c.startLine === null ? null : 'RIGHT',
      side: c.side,
      user: c.user,
      created_at: c.createdAt,
      updated_at: c.createdAt,
      html_url: `${webBase()}/${repo.owner}/${repo.name}/pull/${c.pull}#discussion_r${c.id}`,
      performed_via_github_app: c.user.type === 'Bot' ? { id: appId, slug } : null,
      // GitHub names the thread's first comment on a reply, and has no such field on a first one.
      ...(c.inReplyToId === null ? {} : { in_reply_to_id: c.inReplyToId }),
    };
  };

  /** GitHub requires `title` and `summary` in a check run's `output`, when it is sent. */
  const badCheckRunOutput = (output: CheckRunBody['output']): string | null => {
    if (output === undefined) return null;
    if (typeof output.title !== 'string' || typeof output.summary !== 'string')
      return 'Invalid request.\n\n"title" and "summary" are required keys of "output".';
    return null;
  };

  /** Validates a check run's output annotations as GitHub documents them; null when valid. */
  const badAnnotations = (annotations: unknown): string | null => {
    if (annotations === undefined) return null;
    if (!Array.isArray(annotations) || annotations.length > 50)
      return 'Invalid request.\n\nOnly 50 annotations are allowed per request.';
    for (const a of annotations as Record<string, unknown>[]) {
      if (typeof a.path !== 'string' || a.path === '') return 'Invalid request.';
      if (!Number.isInteger(a.start_line) || (a.start_line as number) < 1)
        return 'Invalid request.';
      if (!Number.isInteger(a.end_line) || (a.end_line as number) < (a.start_line as number))
        return 'Invalid request.';
      if (!LEVELS.has(String(a.annotation_level))) return 'Invalid request.';
      if (
        typeof a.message !== 'string' ||
        a.message === '' ||
        Buffer.byteLength(a.message) > 64 * 1024
      )
        return 'Invalid request.';
      if (a.title !== undefined && (typeof a.title !== 'string' || a.title.length > 255))
        return 'Invalid request.';
    }
    return null;
  };

  /**
   * Whether GitHub places a review comment as its body asks: a body of at most 65 536 characters
   * on RIGHT-side lines (one, or `start_line`..`line`) that the file's patch shows.
   */
  const placeable = (pull: FakePull, b: ReviewCommentBody): boolean => {
    const line = Number(b.line);
    const start = b.start_line === undefined ? line : Number(b.start_line);
    const patch = pull.files.find((f) => f.filename === b.path)?.patch;
    const lines = patch === undefined ? new Set<number>() : rightSideLines(patch);
    const placed = Array.from({ length: Math.max(0, line - start + 1) }, (_, i) => start + i);
    return (
      typeof b.body === 'string' &&
      b.body !== '' &&
      b.body.length <= 65_536 &&
      b.side === 'RIGHT' &&
      Number.isInteger(line) &&
      Number.isInteger(start) &&
      start <= line &&
      (b.start_line === undefined || b.start_side === 'RIGHT') &&
      placed.length > 0 &&
      placed.every((n) => lines.has(n))
    );
  };

  /** A review comment of the App at the pull request's head, the first of a new thread. */
  const startThread = (
    repo: FakeRepository,
    pull: FakePull,
    b: ReviewCommentBody,
  ): FakeReviewComment => {
    const created: FakeReviewComment = {
      id: nextReviewComment++,
      repoId: repo.id,
      pull: pull.number,
      body: String(b.body),
      path: String(b.path),
      line: Number(b.line),
      startLine: b.start_line === undefined ? null : Number(b.start_line),
      side: 'RIGHT',
      commitId: pull.headSha,
      user: { login: `${slug}[bot]`, id: 41898282, type: 'Bot' },
      inReplyToId: null,
      createdAt: stamp(),
    };
    fake.reviewComments.push(created);
    fake.reviewThreads.push({
      id: `PRRT_kwDOFake${nextThread++}`,
      repoId: repo.id,
      pull: pull.number,
      commentIds: [created.id],
      resolved: false,
      resolvedBy: null,
    });
    return created;
  };

  /**
   * Whether GitHub refuses a review (a 422), which then makes none of its comments: an event that
   * is not one of the three (none would leave it pending, which the fake does not model), no body
   * with `COMMENT` or `REQUEST_CHANGES` (GitHub requires one), a commit other than the head, or a
   * comment GitHub would not place.
   */
  const reviewRefused = (pull: FakePull, b: ReviewBody): boolean => {
    const event = typeof b.event === 'string' ? b.event : '';
    const bodyNeeded = event !== 'APPROVE';
    const body = typeof b.body === 'string' ? b.body : undefined;
    const comments: unknown[] = Array.isArray(b.comments) ? b.comments : [];
    return (
      !Object.hasOwn(REVIEW_STATES, event) ||
      (bodyNeeded && (body === undefined || body === '')) ||
      (body !== undefined && body.length > 65_536) ||
      (b.body !== undefined && body === undefined) ||
      (b.commit_id !== undefined && b.commit_id !== pull.headSha) ||
      (b.comments !== undefined && !Array.isArray(b.comments)) ||
      !comments.every(
        (c) => typeof c === 'object' && c !== null && placeable(pull, c as ReviewCommentBody),
      )
    );
  };

  const reviewJson = (repo: FakeRepository, r: FakeReview) => ({
    ...githubShape('pull_request_review'),
    id: r.id,
    node_id: `PRR_kwDOFake${r.id}`,
    user: { login: `${slug}[bot]`, id: 41898282, type: 'Bot' },
    body: r.body,
    state: REVIEW_STATES[r.event],
    html_url: `${webBase()}/${repo.owner}/${repo.name}/pull/${r.pull}#pullrequestreview-${r.id}`,
    pull_request_url: `${fake.url}/repos/${repo.owner}/${repo.name}/pulls/${r.pull}`,
    commit_id: r.commitId,
    submitted_at: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });

  /**
   * GraphQL (the operations 6I-1 sends, picked by the name in the document): review threads and
   * their resolution. As GitHub's, it answers a failed operation with HTTP 200 and `errors` (typed:
   * `NOT_FOUND` for a repository, pull request or thread the token cannot see, `FORBIDDEN` for a
   * missing permission), a variable of the wrong type with errors and no `data`, and a bad
   * credential or request body with an HTTP status. The token must belong to an installation that
   * has the repository, with `pull_requests` read (a query) or write (a mutation).
   */
  const graphql = (
    req: IncomingMessage,
    res: ServerResponse,
    auth: RecordedRequest['auth'],
    bearer: string,
    body: string,
  ) => {
    const refuse = (status: number, message: string) =>
      send(res, status, {
        message,
        documentation_url: 'https://docs.github.com/graphql',
        status: String(status),
      });
    const answer = (data: unknown, ...errors: Record<string, unknown>[]) =>
      send(res, 200, {
        ...(data === undefined ? {} : { data }),
        ...(errors.length > 0 ? { errors } : {}),
      });
    if (typeof req.headers['user-agent'] !== 'string')
      return refuse(
        403,
        'Request forbidden by administrative rules. Please make sure your request has a User-Agent header',
      );
    const grant = fake.tokens.get(bearer);
    if (auth !== 'token' || !grant || grant.expiresAt <= now())
      return refuse(401, 'Bad credentials');
    let request: { query?: unknown; variables?: unknown } | null;
    try {
      request = JSON.parse(body) as typeof request;
    } catch {
      return refuse(400, 'Problems parsing JSON');
    }
    if (typeof request !== 'object' || request === null || typeof request.query !== 'string')
      return answer(undefined, {
        message: 'A query attribute must be specified and must be a string.',
      });
    const query = request.query;
    const variables =
      typeof request.variables === 'object' && request.variables !== null
        ? (request.variables as Record<string, unknown>)
        : {};
    const invalid = (name: string, type: string, value: unknown) =>
      answer(undefined, {
        message: `Variable $${name} of type ${type} was provided invalid value`,
        extensions: {
          value,
          problems: [
            {
              path: [],
              explanation: `Could not coerce value ${JSON.stringify(value)} to ${type.replace('!', '')}`,
            },
          ],
        },
      });
    const isText = (value: unknown): value is string => typeof value === 'string';
    const isInt = (value: unknown): value is number =>
      Number.isInteger(value) && Math.abs(value as number) <= GRAPHQL_MAX_INT;
    const visible = (repo: FakeRepository | undefined): repo is FakeRepository =>
      repo !== undefined &&
      repo.installationId === grant.installationId &&
      grant.repositories.includes(repo.name.toLowerCase());
    const may = (access: Access) => {
      const has = grant.permissions.pull_requests;
      return has !== undefined && (access === 'read' || has === 'write');
    };
    const forbidden = (path: string[]) => ({
      type: 'FORBIDDEN',
      path,
      message: 'Resource not accessible by integration',
    });

    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    // GitHub validates the whole document first: a field the schema lacks fails it, with no data.
    const unknownField = UNKNOWN_COMMENT_FIELD.exec(query)?.[1];
    if (unknownField !== undefined)
      return answer(undefined, {
        message: `Field '${unknownField}' doesn't exist on type 'PullRequestReviewComment'`,
        extensions: {
          code: 'undefinedField',
          typeName: 'PullRequestReviewComment',
          fieldName: unknownField,
        },
      });
    if (operation === 'QualorReviewThreads') {
      const { owner, name, number, after } = variables;
      if (!isText(owner)) return invalid('owner', 'String!', owner);
      if (!isText(name)) return invalid('name', 'String!', name);
      if (!isInt(number)) return invalid('number', 'Int!', number);
      if (after !== undefined && after !== null && !isText(after))
        return invalid('after', 'String', after);
      const repo = repos.get(`${owner}/${name}`.toLowerCase());
      if (!visible(repo))
        return answer(
          { repository: null },
          {
            type: 'NOT_FOUND',
            path: ['repository'],
            message: `Could not resolve to a Repository with the name '${owner}/${name}'.`,
          },
        );
      if (!may('read')) return answer({ repository: null }, forbidden(['repository']));
      const pull = pulls.get(`${repo.id}#${number}`);
      if (!pull)
        return answer(
          { repository: { pullRequest: null } },
          {
            type: 'NOT_FOUND',
            path: ['repository', 'pullRequest'],
            message: `Could not resolve to a PullRequest with the number of ${number}.`,
          },
        );
      const first = Number(/reviewThreads\(first:\s*(\d+)/.exec(query)?.[1] ?? '0');
      if (first < 1 || first > 100)
        return answer(undefined, {
          message:
            first === 0
              ? 'You must provide a `first` or `last` value to properly paginate the `reviewThreads` connection.'
              : `Requesting ${first} records on the \`reviewThreads\` connection exceeds the \`first\` limit of 100 records.`,
        });
      const threads = fake.reviewThreads.filter(
        (t) => t.repoId === repo.id && t.pull === pull.number,
      );
      // A cursor is the number of threads before it, as an opaque string.
      const offset =
        after === undefined || after === null
          ? 0
          : Number(/^cursor:(\d{1,9})$/.exec(Buffer.from(after, 'base64').toString())?.[1] ?? NaN);
      if (!Number.isInteger(offset) || offset > threads.length)
        return answer(undefined, { message: '`after` is not a cursor of this connection' });
      const page = threads.slice(offset, offset + first);
      return answer({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: {
                hasNextPage: offset + first < threads.length,
                endCursor:
                  page.length === 0
                    ? null
                    : Buffer.from(`cursor:${offset + page.length}`).toString('base64'),
              },
              nodes: page.map((t) => ({
                id: t.id,
                isResolved: t.resolved,
                resolvedBy: t.resolvedBy === null ? null : { login: t.resolvedBy },
                comments: { nodes: [{ id: reviewCommentNodeId(t.commentIds[0]!) }] },
              })),
            },
          },
        },
      });
    }
    if (operation === 'QualorResolveThread' || operation === 'QualorUnresolveThread') {
      const field =
        operation === 'QualorResolveThread' ? 'resolveReviewThread' : 'unresolveReviewThread';
      const { id } = variables;
      if (!isText(id)) return invalid('id', 'ID!', id);
      const thread = fake.reviewThreads.find((t) => t.id === id);
      const repo = [...repos.values()].find((r) => r.id === thread?.repoId);
      if (!thread || !visible(repo))
        return answer(
          { [field]: null },
          {
            type: 'NOT_FOUND',
            path: [field],
            message: `Could not resolve to a node with the global id of '${id}'.`,
          },
        );
      if (!may('write')) return answer({ [field]: null }, forbidden([field]));
      thread.resolved = field === 'resolveReviewThread';
      // An installation token is this App's: GitHub names its `<slug>[bot]` as the resolver, and
      // nobody once the thread is open again (ruling R6).
      thread.resolvedBy = thread.resolved ? `${slug}[bot]` : null;
      return answer({ [field]: { thread: { id: thread.id, isResolved: thread.resolved } } });
    }
    return answer(undefined, { message: `Unknown operation ${operation ?? '(none)'}` });
  };

  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    const authorization = req.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const auth: RecordedRequest['auth'] =
      bearer.split('.').length === 3 ? 'jwt' : bearer ? 'token' : 'none';
    const p = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    fake.requests.push({ method, path: p + url.search, auth, body, headers: { ...req.headers } });
    for (const injection of injections) {
      if (injection.method === method && injection.path.test(p) && injection.answers.length > 0) {
        const answer = injection.answers.shift()!;
        answer.before?.();
        if (answer.passThrough !== true)
          return send(res, answer.status, answer.body, answer.headers);
        break;
      }
    }
    if (url.pathname === GRAPHQL_PATH && method === 'POST') {
      return graphql(req, res, auth, bearer, body);
    }
    if (!url.pathname.startsWith(PREFIX)) return deny(res, 404, 'Not Found');
    if (typeof req.headers['user-agent'] !== 'string')
      return deny(
        res,
        403,
        'Request forbidden by administrative rules. Please make sure your request has a User-Agent header',
      );
    let parsedBody: Record<string, unknown> = {};
    if (body !== '') {
      try {
        parsedBody = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return deny(res, 400, 'Problems parsing JSON');
      }
    }
    const json = (): Record<string, unknown> => parsedBody;

    // App-level endpoints (JWT).
    if (auth === 'jwt' && !jwtOk(bearer))
      return deny(
        res,
        401,
        "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued",
      );
    if (method === 'GET' && p === '/app') {
      if (auth !== 'jwt') return deny(res, 401, 'A JSON web token could not be decoded');
      return send(res, 200, { ...githubShape('app'), id: appId, slug });
    }
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p);
    if (method === 'POST' && tokenMatch) {
      if (auth !== 'jwt') return deny(res, 401, 'A JSON web token could not be decoded');
      const installationId = Number(tokenMatch[1]);
      const installed = [...repos.values()].filter((r) => r.installationId === installationId);
      const request = json() as { repositories?: string[]; permissions?: Record<string, Access> };
      const names = request.repositories ?? installed.map((r) => r.name);
      if (!names.every((n) => installed.some((r) => r.name.toLowerCase() === n.toLowerCase()))) {
        return deny(
          res,
          422,
          'There is at least one repository that does not exist or is not accessible to the parent installation.',
        );
      }
      if (installed.some((r) => r.suspended))
        return deny(res, 403, 'This installation has been suspended');
      const granted = installed[0]?.permissions ?? DEFAULT_PERMISSIONS;
      const wanted = request.permissions ?? granted;
      for (const [name, access] of Object.entries(wanted)) {
        const has = granted[name];
        if (!has || (access === 'write' && has !== 'write'))
          return deny(res, 422, 'The permissions requested are not granted to this installation.');
      }
      const token = `ghs_${randomBytes(18).toString('hex')}`;
      const expiresAt = now() + 60 * 60_000;
      fake.tokens.set(token, {
        installationId,
        repositories: names.map((n) => n.toLowerCase()),
        permissions: wanted,
        expiresAt,
      });
      return send(res, 201, {
        ...githubShape('installation_token'),
        token,
        expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        permissions: wanted,
      });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!repoMatch) return deny(res, 404, 'Not Found');
    const repo = repos.get(
      `${decodeURIComponent(repoMatch[1]!)}/${decodeURIComponent(repoMatch[2]!)}`.toLowerCase(),
    );
    const rest = repoMatch[3] ?? '';
    if (repo?.movedTo) {
      return send(
        res,
        301,
        {
          message: 'Moved Permanently',
          url: `${fake.url}/repositories/${repo.id}${rest}`,
          documentation_url:
            'https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api#follow-redirects',
        },
        { location: `${fake.url}/repositories/${repo.id}${rest}` },
      );
    }
    if (method === 'GET' && rest === '/installation') {
      if (auth !== 'jwt') return deny(res, 401, 'A JSON web token could not be decoded');
      if (!repo || repo.installationId === null) return deny(res, 404, 'Not Found');
      return send(res, 200, {
        ...githubShape('installation'),
        id: repo.installationId,
        app_id: appId,
        app_slug: slug,
      });
    }
    // Repository endpoints (installation token).
    const grant = fake.tokens.get(bearer);
    if (auth !== 'token' || !grant || grant.expiresAt <= now())
      return deny(res, 401, 'Bad credentials');
    if (
      !repo ||
      repo.installationId !== grant.installationId ||
      !grant.repositories.includes(repo.name.toLowerCase())
    )
      return deny(res, 404, 'Not Found');
    const need = (permission: string, access: Access) => {
      const has = grant.permissions[permission];
      return has !== undefined && (access === 'read' || has === 'write');
    };
    const forbidden = () => deny(res, 403, 'Resource not accessible by integration');

    if (method === 'GET' && rest === '') {
      if (!need('metadata', 'read')) return forbidden();
      return send(res, 200, {
        ...githubShape('repository'),
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        html_url: `${webBase()}/${repo.owner}/${repo.name}`,
      });
    }
    const permissionOf = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
    if (method === 'GET' && permissionOf) {
      if (!need('metadata', 'read')) return forbidden();
      const login = decodeURIComponent(permissionOf[1]!);
      const found = permissions.get(permissionKey(repo.id, login));
      if (found === undefined) return deny(res, 404, 'Not Found');
      // No role name: the answer has no `role_name`, nor has its user.
      const withRole = (o: Record<string, unknown>) =>
        found.roleName === null
          ? Object.fromEntries(Object.entries(o).filter(([key]) => key !== 'role_name'))
          : { ...o, role_name: found.roleName };
      const user = permissionShape['user'] as Record<string, unknown>;
      return send(res, 200, {
        ...withRole(permissionShape),
        permission: found.permission,
        user: withRole({ ...user, login }),
      });
    }
    const listRuns = /^\/commits\/([0-9a-f]{40,64})\/check-runs$/.exec(rest);
    if (method === 'GET' && listRuns) {
      if (!need('checks', 'read')) return forbidden();
      const name = url.searchParams.get('check_name');
      const app = url.searchParams.get('app_id');
      let runs = fake.checkRuns.filter(
        (r) =>
          r.repoId === repo.id &&
          r.headSha === listRuns[1] &&
          (name === null || r.name === name) &&
          (app === null || String(r.appId) === app),
      );
      if (url.searchParams.get('filter') !== 'all') {
        const newest = new Map<string, FakeCheckRun>();
        for (const r of runs) if ((newest.get(r.name)?.id ?? -1) < r.id) newest.set(r.name, r);
        runs = [...newest.values()];
      }
      return send(res, 200, { total_count: runs.length, check_runs: runs.map(checkRunJson) });
    }
    if (method === 'POST' && rest === '/check-runs') {
      if (!need('checks', 'write')) return forbidden();
      const b = json() as CheckRunBody;
      if (
        typeof b.name !== 'string' ||
        b.name === '' ||
        !/^[0-9a-f]{40,64}$/.test(String(b.head_sha))
      )
        return deny(res, 422, 'Invalid request.');
      if (b.status === 'completed' && !CONCLUSIONS.has(String(b.conclusion)))
        return deny(res, 422, 'Invalid request.');
      const badOutput = badCheckRunOutput(b.output);
      if (badOutput) return deny(res, 422, badOutput);
      const bad = badAnnotations(b.output?.annotations);
      if (bad) return deny(res, 422, bad);
      const run: FakeCheckRun = {
        id: nextId++,
        repoId: repo.id,
        appId,
        name: b.name,
        headSha: String(b.head_sha),
        conclusion: b.conclusion ?? null,
        externalId: b.external_id ?? null,
        detailsUrl: b.details_url ?? null,
        title: b.output?.title ?? null,
        summary: b.output?.summary ?? null,
        annotations: b.output?.annotations ?? [],
      };
      fake.checkRuns.push(run);
      return send(res, 201, checkRunJson(run));
    }
    const patchRun = /^\/check-runs\/(\d+)$/.exec(rest);
    if (method === 'PATCH' && patchRun) {
      if (!need('checks', 'write')) return forbidden();
      const run = fake.checkRuns.find((r) => r.id === Number(patchRun[1]) && r.repoId === repo.id);
      if (!run) return deny(res, 404, 'Not Found');
      if (run.appId !== appId) return forbidden();
      const b = json() as CheckRunBody;
      const badOutput = badCheckRunOutput(b.output);
      if (badOutput) return deny(res, 422, badOutput);
      const bad = badAnnotations(b.output?.annotations);
      if (bad) return deny(res, 422, bad);
      if (b.conclusion !== undefined) run.conclusion = b.conclusion;
      if (b.external_id !== undefined) run.externalId = b.external_id;
      if (b.details_url !== undefined) run.detailsUrl = b.details_url;
      if (b.output?.title !== undefined) run.title = b.output.title;
      if (b.output?.summary !== undefined) run.summary = b.output.summary;
      // GitHub appends annotations on an update; it never removes one.
      if (Array.isArray(b.output?.annotations)) run.annotations.push(...b.output.annotations);
      return send(res, 200, checkRunJson(run));
    }
    const pullMatch = /^\/pulls\/(\d+)(\/files)?$/.exec(rest);
    if (method === 'GET' && pullMatch) {
      if (!need('pull_requests', 'read')) return forbidden();
      const pull = pulls.get(`${repo.id}#${pullMatch[1]}`);
      if (!pull) return deny(res, 404, 'Not Found');
      if (pullMatch[2]) {
        return page(
          url,
          res,
          pull.files.map((f) => ({
            ...(githubShape<unknown[]>('pull_request_files')[0] as object),
            filename: f.filename,
            status: f.status ?? 'modified',
            ...(f.patch === undefined ? { patch: undefined } : { patch: f.patch }),
          })),
        );
      }
      return send(res, 200, {
        ...githubShape('pull_request'),
        number: pull.number,
        title: pull.title,
        state: pull.state,
        draft: pull.draft ?? false,
        merged: pull.merged ?? false,
        html_url: `${webBase()}/${repo.owner}/${repo.name}/pull/${pull.number}`,
        head: { ref: 'feature/x', sha: pull.headSha, label: 'x' },
        base: { ref: 'main', sha: pull.baseSha, label: 'y' },
      });
    }
    const reviewComments = /^\/pulls\/(\d+)\/comments$/.exec(rest);
    if (reviewComments && method === 'GET') {
      if (!need('pull_requests', 'read')) return forbidden();
      return page(
        url,
        res,
        fake.reviewComments
          .filter((c) => c.repoId === repo.id && c.pull === Number(reviewComments[1]))
          .map(reviewCommentJson(repo)),
      );
    }
    if (reviewComments && method === 'POST') {
      if (!need('pull_requests', 'write')) return forbidden();
      const pull = pulls.get(`${repo.id}#${reviewComments[1]}`);
      if (!pull) return deny(res, 404, 'Not Found');
      const b = json() as ReviewCommentBody & { commit_id?: unknown };
      if (b.commit_id !== pull.headSha || !placeable(pull, b)) {
        return deny(res, 422, 'Validation Failed');
      }
      return send(res, 201, reviewCommentJson(repo)(startThread(repo, pull, b)));
    }
    const reviewReplies = /^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(rest);
    if (reviewReplies && method === 'POST') {
      if (!need('pull_requests', 'write')) return forbidden();
      const first = fake.reviewComments.find(
        (c) =>
          c.id === Number(reviewReplies[2]) &&
          c.repoId === repo.id &&
          c.pull === Number(reviewReplies[1]),
      );
      const thread = fake.reviewThreads.find((t) => t.commentIds[0] === first?.id);
      // A reply is no first comment: a thread takes no reply to it, as for a comment GitHub lacks.
      if (!first || !thread || first.inReplyToId !== null) return deny(res, 404, 'Not Found');
      const b = json() as { body?: unknown };
      if (typeof b.body !== 'string' || b.body === '' || b.body.length > 65_536)
        return deny(res, 422, 'Validation Failed');
      const bot = { login: `${slug}[bot]`, id: 41898282, type: 'Bot' } as const;
      return send(res, 201, reviewCommentJson(repo)(addReply(first, thread, bot, b.body)));
    }
    const pullReviews = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (pullReviews && method === 'POST') {
      if (!need('pull_requests', 'write')) return forbidden();
      const pull = pulls.get(`${repo.id}#${pullReviews[1]}`);
      if (!pull) return deny(res, 404, 'Not Found');
      const b = json() as ReviewBody;
      // All or nothing: a comment GitHub would not place refuses the review and makes none.
      if (reviewRefused(pull, b)) return deny(res, 422, 'Unprocessable Entity');
      const comments = (Array.isArray(b.comments) ? b.comments : []) as ReviewCommentBody[];
      const made = comments.map((c) => startThread(repo, pull, c));
      const review: FakeReview = {
        id: nextId++,
        repoId: repo.id,
        pull: pull.number,
        body: typeof b.body === 'string' ? b.body : '',
        event: String(b.event),
        commitId: pull.headSha,
        commentIds: made.map((c) => c.id),
      };
      fake.reviews.push(review);
      return send(res, 200, reviewJson(repo, review));
    }
    const issueComments = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (issueComments && method === 'GET') {
      if (!need('pull_requests', 'read')) return forbidden();
      return page(
        url,
        res,
        fake.comments
          .filter((c) => c.repoId === repo.id && c.issue === Number(issueComments[1]))
          .map(commentJson),
      );
    }
    if (issueComments && method === 'POST') {
      if (!need('pull_requests', 'write')) return forbidden();
      const b = json() as { body?: unknown };
      if (typeof b.body !== 'string' || b.body.length > 65_536)
        return deny(res, 422, 'Validation Failed');
      const created = fake.addComment(repo.id, Number(issueComments[1]), {
        body: b.body,
        login: `${slug}[bot]`,
        type: 'Bot',
      });
      return send(res, 201, commentJson(created));
    }
    const editComment = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (editComment && method === 'PATCH') {
      if (!need('pull_requests', 'write')) return forbidden();
      const comment = fake.comments.find(
        (c) => c.id === Number(editComment[1]) && c.repoId === repo.id,
      );
      if (!comment) return deny(res, 404, 'Not Found');
      if (comment.user.login !== `${slug}[bot]`) return forbidden();
      const b = json() as { body?: unknown };
      if (typeof b.body !== 'string') return deny(res, 422, 'Validation Failed');
      comment.body = b.body;
      return send(res, 200, commentJson(comment));
    }
    return deny(res, 404, 'Not Found');
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PREFIX}`;
  return fake;
}
