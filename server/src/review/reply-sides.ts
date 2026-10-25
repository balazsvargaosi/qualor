import type { WorkerLogger } from '../queue/worker';
import { MAX_THREAD_PAGES, type GitHubClient } from '../scm/github/client';
import { MAX_COMMENT_PAGES } from '../scm/github/threads';
import type { GitHubRepoRef } from '../scm/github/url';
import { discussionResolved, type GitLabClient } from '../scm/gitlab/client';
import { MAX_DISCUSSION_PAGES } from '../scm/inline';
import { firstLineOf, markerOf, replyMarker } from '../scm/markdown';
import { ScmError } from '../scm/provider';
import type { ReplyRow } from './replies';

/*
 * The thread of a reply on its provider (6I-4), as the `ai-reply` job (reply-job.ts) reads it,
 * asks who may change a finding's status, posts its answer and resolves it: GitLab's discussion of
 * the merge request, or GitHub's review thread of the pull request, each through the job's own
 * client and its request budget.
 */

/** GitLab's Developer role: the least access level whose reply may change a finding's status. */
const GITLAB_DEVELOPER = 30;
/**
 * The most authors of a round whose rights are asked for, each once: a round of more changes no
 * status.
 */
const MAX_AUTHORS_LOOKED_UP = 5;
/** GitHub's roles of a repository whose people may change a finding's status through a reply. */
const GITHUB_TRIAGE_ROLES: ReadonlySet<string> = new Set(['admin', 'maintain', 'write', 'triage']);
/** GitHub's other built-in roles, which may not. */
const GITHUB_OTHER_ROLES: ReadonlySet<string> = new Set(['read', 'none']);
/** The base permissions of a custom role (any other role name) that may. */
const GITHUB_TRIAGE_PERMISSIONS: ReadonlySet<string> = new Set(['admin', 'write']);

/**
 * Whether a person with this permission on the repository may change a finding's status through a
 * reply: a role of admin, maintain, write or triage, or a custom role whose base permission is
 * admin or write. With no role named (an older GitHub Enterprise Server), the legacy permission
 * decides the same way: admin or write may. Nobody else may: the read role, none, or no permission
 * at all (null).
 */
function githubMayTriage(found: { permission: string; roleName: string | null } | null): boolean {
  if (found === null) return false;
  if (found.roleName !== null && GITHUB_TRIAGE_ROLES.has(found.roleName)) return true;
  if (found.roleName !== null && GITHUB_OTHER_ROLES.has(found.roleName)) return false;
  return GITHUB_TRIAGE_PERMISSIONS.has(found.permission);
}

/** A row of a reply: in a thread, about an issue. */
export type ReplyInThread = ReplyRow & { threadId: string; issueId: string };

/** A person's note in the thread, as the model is given it. */
export interface ThreadNote {
  id: number;
  author: string;
  body: string;
}

/** The thread as the job reads it again. */
export interface ReadThread {
  /** Qualor's first note, as it was posted. */
  firstNote: string;
  /** The people's notes after it, oldest first. */
  notes: ThreadNote[];
  /** The note of Qualor's whose first line names the row: its answer, posted already. */
  answered: number | null;
  resolved: boolean;
}

/** The thread on its provider, through the job's own client and its request budget. */
export interface ThreadSide {
  /** The SCM connection the requests are made through, whose circuit they pass. */
  connectionId: string;
  /** The thread again; null when it is not there, or cannot be read whole. */
  read(): Promise<ReadThread | null>;
  /** Whether every author of the notes `noteIds` (of the last read) may change a finding's status. */
  mayChangeStatus(noteIds: readonly number[]): Promise<boolean>;
  /** Posts `body` in the thread: answers the new note's id. */
  post(body: string): Promise<number>;
  /** Resolves the thread: false when the provider no longer has it. */
  resolve(): Promise<boolean>;
}

/** What the provider says when it has no such thing: the thread is gone, however it says it. */
export const GONE = Symbol('gone');

/** What `step` answers, or GONE when the provider says it has nothing of the kind (`not_found`). */
export async function orGone<T>(step: () => Promise<T>): Promise<T | typeof GONE> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof ScmError && err.kind === 'not_found') return GONE;
    throw err;
  }
}

/** Whether a note opens with the issue marker of `issueId`: the first note of the issue's thread. */
const marksIssue = (body: string, issueId: string): boolean => {
  const marker = markerOf(body);
  return marker?.kind === 'issue' && marker.issueId === issueId;
};

/** The thread on GitLab: the merge request's discussion of the row. */
export function gitlabSide(
  connectionId: string,
  client: GitLabClient,
  ref: string,
  iid: string,
  row: ReplyInThread,
): ThreadSide {
  /** The GitLab user of each person's note the last read found. */
  const authorOf = new Map<number, number>();
  return {
    connectionId,
    async read() {
      const me = await client.currentUser();
      const listed = await client.discussions(ref, iid, MAX_DISCUSSION_PAGES);
      // A discussion is listed with all its notes: one that is listed is whole.
      const discussion = listed.items.find((d) => d.id === row.threadId);
      const [first, ...later] = discussion?.notes ?? [];
      if (discussion === undefined || first === undefined) return null;
      if (first.system || first.author.id !== me.id || !marksIssue(first.body, row.issueId)) {
        return null;
      }
      const people = later.filter((note) => !note.system && note.author.id !== me.id);
      for (const note of people) authorOf.set(note.id, note.author.id);
      const marker = replyMarker(row.id);
      const answer = later.find(
        (note) => !note.system && note.author.id === me.id && firstLineOf(note.body) === marker,
      );
      return {
        firstNote: first.body,
        notes: people.map((note) => ({
          id: note.id,
          author: note.author.username,
          body: note.body,
        })),
        answered: answer?.id ?? null,
        resolved: discussionResolved(discussion),
      };
    },
    async mayChangeStatus(noteIds) {
      const authors = [...new Set(noteIds.map((id) => authorOf.get(id)))];
      if (authors.length > MAX_AUTHORS_LOOKED_UP) return false;
      for (const userId of authors) {
        if (userId === undefined) return false;
        const level = await client.memberAccessLevel(ref, userId);
        if (level === null || level < GITLAB_DEVELOPER) return false;
      }
      return true;
    },
    post: async (body) => (await client.replyToDiscussion(ref, iid, row.threadId, body)).id,
    async resolve() {
      const done = await orGone(() => client.resolveDiscussion(ref, iid, row.threadId, true));
      return done !== GONE;
    },
  };
}

/**
 * The thread on GitHub: the review thread whose first comment is the row's thread id. `logger` says
 * when a permission GitHub answered is not understood.
 */
export function githubSide(
  connectionId: string,
  client: GitHubClient,
  repo: GitHubRepoRef,
  number: string,
  row: ReplyInThread,
  logger: Pick<WorkerLogger, 'warn'>,
): ThreadSide {
  const firstId = Number(row.threadId);
  /** The login of each person's comment the last read found. */
  const loginOf = new Map<number, string>();
  /** The thread's GraphQL node id, which it is resolved by. */
  let threadNode: string | null = null;
  /**
   * The login's permission on the repository. An answer of GitHub's that does not parse is no
   * permission, said in one line without its text: one author's odd answer never fails the round.
   */
  const permissionOf = async (login: string) => {
    try {
      return await client.repositoryPermission(login);
    } catch (err) {
      if (!(err instanceof ScmError) || err.kind !== 'bad_answer') throw err;
      logger.warn(
        { replyId: row.id },
        'GitHub permission answer not understood; the reply changes no status',
      );
      return null;
    }
  };
  return {
    connectionId,
    async read() {
      const app = await client.app();
      await client.useRepository(repo);
      const bot = `${app.slug}[bot]`;
      const comments = await client.reviewComments(number, MAX_COMMENT_PAGES);
      // Beyond the page bound a reply, or the answer, may be unseen: the thread is not read whole.
      if (!comments.complete) return null;
      const byApp = (user: { login: string; type: string } | null) =>
        user?.type === 'Bot' && user.login === bot;
      const first = comments.items.find((c) => c.id === firstId);
      if (first === undefined || typeof first.in_reply_to_id === 'number') return null;
      if (!byApp(first.user) || !marksIssue(first.body, row.issueId)) return null;
      const threads = await client.reviewThreads(number, MAX_THREAD_PAGES);
      const thread = threads.items.find((t) => t.firstCommentNodeId === first.node_id);
      if (thread === undefined) return null;
      threadNode = thread.id;
      const replies = comments.items.filter((c) => c.in_reply_to_id === firstId);
      const people = replies.flatMap((c) =>
        c.user?.type === 'User' ? [{ id: c.id, author: c.user.login, body: c.body }] : [],
      );
      for (const note of people) loginOf.set(note.id, note.author);
      const marker = replyMarker(row.id);
      const answer = replies.find((c) => byApp(c.user) && firstLineOf(c.body) === marker);
      return {
        firstNote: first.body,
        notes: people,
        answered: answer?.id ?? null,
        resolved: thread.isResolved,
      };
    },
    async mayChangeStatus(noteIds) {
      const logins = [...new Set(noteIds.map((id) => loginOf.get(id)))];
      if (logins.length > MAX_AUTHORS_LOOKED_UP) return false;
      for (const login of logins) {
        if (login === undefined) return false;
        if (!githubMayTriage(await permissionOf(login))) return false;
      }
      return true;
    },
    post: async (body) => (await client.replyToReviewComment(number, firstId, body)).id,
    resolve: async () =>
      threadNode !== null && (await client.setThreadResolved(threadNode, true)) === 'done',
  };
}
