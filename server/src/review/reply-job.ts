import { and, desc, eq, lt, max } from 'drizzle-orm';
import { SYSTEM_ACTOR } from '../audit/recorder';
import type { Db } from '../db/client';
import { pgErrorCode } from '../db/errors';
import {
  branches,
  issues,
  projects,
  reviewFindings,
  reviewReplies,
  reviewSnapshots,
  rules,
  scmConnections,
  type ReplyOutcome,
} from '../db/schema';
import { transitionAsSystem } from '../issues/transitions';
import { readLlmSettings, type StoredLlmSettings } from '../llm/settings';
import type { JobHandlers } from '../queue/worker';
import { AI_ENGINE } from '../rules/server-engines';
import { gitlabClientFor, type ScmConnectionRow } from '../scm/connections';
import { GITHUB_PR_NUMBER, MAX_THREAD_PAGES, type GitHubClient } from '../scm/github/client';
import { githubClientFor } from '../scm/github/connections';
import { MAX_COMMENT_PAGES } from '../scm/github/threads';
import { parseRepoRef, type GitHubRepoRef } from '../scm/github/url';
import { discussionResolved, GITLAB_MR_IID, type GitLabClient } from '../scm/gitlab/client';
import { MAX_DISCUSSION_PAGES } from '../scm/inline';
import { markerOf, replyMarker } from '../scm/markdown';
import { readMergeRequestState } from '../scm/mr-state';
import { ScmError } from '../scm/provider';
import type { IssueStatus } from '../tracking/plan';
import type { ReviewJobDeps } from './job';
import { ofBranch } from './lifecycle';
import { replyNote } from './render';
import {
  claimReply,
  endReply,
  recordAnswerNote,
  recordDecision,
  recordStatusChange,
  type ReplyDecision,
  type ReplyEnd,
  type ReplyRow,
} from './replies';
import { decideReply, replyTokensLeft, type ReplyDeps, type ReplyIssue } from './reply-engine';
import {
  AI_REPLY_QUEUE,
  queueAfterCircuit,
  queueAfterStop,
  REPLY_CIRCUIT_WAIT_SECONDS,
  replyPayload,
} from './reply-queue';
import { errorClass } from './run-ends';
import { reviewActive } from './settings';
import { openSnapshotReader, type SnapshotReader } from './snapshot-reader';

/*
 * The `ai-reply` jobs (6I-4): Qualor's answer to a round of people's replies in one of its
 * threads, which decoration (or a webhook's scan) wrote as a row of the replies ledger with its job
 * (reply-queue.ts). The job takes the row and then, in this order, each step written on the row, or
 * found again where it was done, so that a retry resumes after the last one:
 * 1. AI review no longer active for the project ends the row `skipped: inactive`, and a merge
 *    request that is merged or closed `skipped: closed`;
 * 2. with no decision yet, a day with no tokens left for it ends it `skipped: budget_spent`, before
 *    anything is read or sent;
 * 3. the thread is read again through the job's own client: one that is gone, or that someone
 *    resolved, ends it `skipped: thread_gone`;
 * 4. with no decision yet, the model decides (reply-engine.ts) over the people's notes of the round,
 *    with the rights in the SCM of those who wrote them, and the decision is stored: the model is
 *    never asked twice for one row;
 * 5. a verdict that is not `keep` changes the status of the thread's open AI finding, as the
 *    system's change (transitions.ts), recorded on the row with it, so that it is made once,
 *    before the thread is resolved: decoration reopens a thread Qualor resolved while its finding
 *    is open;
 * 6. the answer is posted once: a note of Qualor's in the thread whose first line names the row is
 *    the answer a post stored though its outcome was lost, and is not posted again;
 * 7. a verdict that is not `keep` resolves the thread;
 * 8. the row ends `done`, with what came of it.
 * The row's issue must be its project's, before the decision and before the thread is acted on (a
 * monorepo's thread of another project's issue never is): otherwise the row ends `failed: internal`.
 *
 * The job's own requests pass the connection's circuit as the `scm` worker's jobs do (scm.md
 * §4.2), in two goes, so that no probe of it waits on the model: the thread and the round's rights
 * (3 and 4) before the model is asked, and the status change, the post and the resolution (5 to 7)
 * after it. A circuit that is open, or half-open with another job's probe in flight, puts the row
 * back in the queue for when it lets a job through, with no try spent and nothing changed by that
 * go; the circuit hears what came of the requests it let through. The organisation's slots are the
 * decorations': the job takes none.
 *
 * A stop of the server while the model decides puts the row back in the queue for the next server;
 * AI review switched off meanwhile ends it `skipped: inactive`. Any other error fails the job into
 * its second try, which resumes; a row left running after both is the sweep's (reply-queue.ts). A
 * command row is not this job's: it stays queued, as it was. Nothing the people or the model wrote
 * is ever logged: the row's id, codes and counts only.
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
 * admin or write. Nobody else may: the read role, none, or no permission at all (null).
 */
function githubMayTriage(found: { permission: string; roleName: string } | null): boolean {
  if (found === null) return false;
  if (GITHUB_TRIAGE_ROLES.has(found.roleName)) return true;
  if (GITHUB_OTHER_ROLES.has(found.roleName)) return false;
  return GITHUB_TRIAGE_PERMISSIONS.has(found.permission);
}

/** A row of a reply: in a thread, about an issue. */
type ReplyInThread = ReplyRow & { threadId: string; issueId: string };

/** A person's note in the thread, as the model is given it. */
interface ThreadNote {
  id: number;
  author: string;
  body: string;
}

/** The thread as the job reads it again. */
interface ReadThread {
  /** Qualor's first note, as it was posted. */
  firstNote: string;
  /** The people's notes after it, oldest first. */
  notes: ThreadNote[];
  /** The note of Qualor's whose first line names the row: its answer, posted already. */
  answered: number | null;
  resolved: boolean;
}

/** The thread on its provider, through the job's own client and its request budget. */
interface ThreadSide {
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

/** What the model decided on a row: its verdict, and the answer it wrote. */
type Decided = Pick<ReplyDecision, 'verdict' | 'answer'>;

/** The round of a row with no decision yet: the people's notes it answers, and their rights. */
interface PendingRound {
  notes: ThreadNote[];
  /** Whether every author of the notes may change the finding's status. */
  mayChangeStatus: boolean;
}

/**
 * What the job reads before the model is asked: the thread, the answer posted already (on the row,
 * or found in the thread), and the row's decision or, with none yet, its round.
 */
type Seen = { thread: ReadThread; posted: number | null } & (
  { decided: Decided } | { round: PendingRound }
);

/** What the provider says when it has no such thing: the thread is gone, however it says it. */
const GONE = Symbol('gone');

/** What a go through the circuit answers when the circuit did not let it through: the row waits. */
const WAITING = Symbol('waiting');

/** What `step` answers, or GONE when the provider says it has nothing of the kind (`not_found`). */
async function orGone<T>(step: () => Promise<T>): Promise<T | typeof GONE> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof ScmError && err.kind === 'not_found') return GONE;
    throw err;
  }
}

const firstLineOf = (body: string): string => (body.split('\n', 1)[0] ?? '').replace(/\r$/, '');
/** Whether a note opens with the issue marker of `issueId`: the first note of the issue's thread. */
const marksIssue = (body: string, issueId: string): boolean => {
  const marker = markerOf(body);
  return marker?.kind === 'issue' && marker.issueId === issueId;
};

/** The thread on GitLab: the merge request's discussion of the row. */
function gitlabSide(
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

/** The thread on GitHub: the review thread whose first comment is the row's thread id. */
function githubSide(
  connectionId: string,
  client: GitHubClient,
  repo: GitHubRepoRef,
  number: string,
  row: ReplyInThread,
): ThreadSide {
  const firstId = Number(row.threadId);
  /** The login of each person's comment the last read found. */
  const loginOf = new Map<number, string>();
  /** The thread's GraphQL node id, which it is resolved by. */
  let threadNode: string | null = null;
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
        if (!githubMayTriage(await client.repositoryPermission(login))) return false;
      }
      return true;
    },
    post: async (body) => (await client.replyToReviewComment(number, firstId, body)).id,
    resolve: async () =>
      threadNode !== null && (await client.setThreadResolved(threadNode, true)) === 'done',
  };
}

/** The merge request of a row, its project and the connection the project is mapped to now. */
interface Target {
  branch: { id: string; name: string; lastAnalysisId: string | null };
  project: {
    id: string;
    organizationId: string;
    scmConnectionId: string | null;
    scmProjectRef: string | null;
  };
  connection: ScmConnectionRow | null;
}

async function targetOf(db: Db, row: ReplyRow): Promise<Target | null> {
  const [found] = await db
    .select({
      branch: { id: branches.id, name: branches.name, lastAnalysisId: branches.lastAnalysisId },
      project: {
        id: projects.id,
        organizationId: projects.organizationId,
        scmConnectionId: projects.scmConnectionId,
        scmProjectRef: projects.scmProjectRef,
      },
      connection: scmConnections,
    })
    .from(branches)
    .innerJoin(projects, eq(projects.id, branches.projectId))
    .leftJoin(scmConnections, eq(scmConnections.id, projects.scmConnectionId))
    .where(and(eq(branches.id, row.branchId), eq(projects.id, row.projectId)));
  return found ?? null;
}

/**
 * The row's issue as the reply conversation is told of it, when it is an issue of the row's
 * project; null when it is not, or is gone. Its lines and line hash are the issue row's, and an AI
 * finding's body, suggestion and reviewed head are its finding row's.
 */
async function issueOf(db: Db, row: ReplyInThread): Promise<ReplyIssue | null> {
  const [found] = await db
    .select({
      projectId: issues.projectId,
      status: issues.status,
      message: issues.message,
      path: issues.path,
      line: issues.startLine,
      endLine: issues.endLine,
      lineHash: issues.lineHash,
      engine: rules.engineId,
      ruleKey: rules.key,
      aiBody: reviewFindings.body,
      suggestion: reviewFindings.suggestion,
      reviewedHeadSha: reviewFindings.reviewedHeadSha,
    })
    .from(issues)
    .innerJoin(rules, eq(rules.id, issues.ruleId))
    .leftJoin(reviewFindings, eq(reviewFindings.issueId, issues.id))
    .where(eq(issues.id, row.issueId));
  if (found === undefined || found.projectId !== row.projectId) return null;
  return {
    engine: found.engine,
    ruleKey: found.ruleKey,
    message: found.message,
    path: found.path,
    line: found.line,
    endLine: found.endLine,
    reviewedHeadSha: found.reviewedHeadSha ?? null,
    lineHash: found.lineHash,
    status: found.status as IssueStatus,
    aiBody: found.aiBody ?? null,
    suggestion: found.suggestion ?? null,
  };
}

/**
 * The newest note of the thread whose round was answered (its row ended `done`) before the row's,
 * or 0: the round's notes are the ones after it. A note whose row was skipped or failed is read
 * again by the next round.
 */
async function lastAnsweredNote(db: Db, row: ReplyInThread): Promise<number> {
  const [found] = await db
    .select({ noteId: max(reviewReplies.noteId) })
    .from(reviewReplies)
    .where(
      and(
        eq(reviewReplies.branchId, row.branchId),
        eq(reviewReplies.threadId, row.threadId),
        eq(reviewReplies.kind, 'reply'),
        eq(reviewReplies.status, 'done'),
        lt(reviewReplies.noteId, row.noteId),
      ),
    );
  return found?.noteId ?? 0;
}

/**
 * The snapshot the reply's tools read: the ready one of the branch's newest analysis, else the
 * branch's newest ready one; null when the branch has none, and the model then reads no code.
 */
async function snapshotOf(db: Db, branch: Target['branch']): Promise<SnapshotReader | null> {
  const ready = eq(reviewSnapshots.status, 'ready');
  const [newest] =
    branch.lastAnalysisId === null
      ? []
      : await db
          .select({ id: reviewSnapshots.id })
          .from(reviewSnapshots)
          .where(and(eq(reviewSnapshots.analysisId, branch.lastAnalysisId), ready));
  const [found] =
    newest === undefined
      ? await db
          .select({ id: reviewSnapshots.id })
          .from(reviewSnapshots)
          .where(and(ofBranch(db, branch.id), ready))
          .orderBy(desc(reviewSnapshots.createdAt), desc(reviewSnapshots.id))
          .limit(1)
      : [newest];
  return found === undefined ? null : openSnapshotReader(db, found.id);
}

/** The changelog's comment on a status a reply changed: whose reply decided it. */
const statusComment = (verdict: 'wont_fix' | 'false_positive', author: string): string =>
  `${verdict === 'wont_fix' ? "Won't fix" : 'False positive'} after \`${author}\` replied in the merge request.`;

const THREAD_GONE: ReplyEnd = { status: 'skipped', reason: 'thread_gone' };

class ReplyJob {
  constructor(
    private readonly deps: ReviewJobDeps,
    private readonly replyId: string,
    /** Whether an earlier try of this job ran: one that took the row and left it running. */
    private readonly retry: boolean,
    /** Whether this is the job's last try (its attempts are spent with it). */
    private readonly lastTry: boolean,
  ) {}

  async run(): Promise<void> {
    try {
      await this.answer();
    } catch (err) {
      const fields = {
        replyId: this.replyId,
        errorClass: errorClass(err),
        code: pgErrorCode(err) ?? null,
        // What the SCM said, never its message.
        ...(err instanceof ScmError ? { errorKind: err.kind, httpStatus: err.status } : {}),
      };
      if (this.lastTry) this.deps.logger.error(fields, 'AI reply failed on its last try');
      else this.deps.logger.warn(fields, 'AI reply not answered; its job is tried again');
      throw err;
    }
  }

  /**
   * The row to answer: a queued reply, taken now; or, on a retry, the one the first try took and
   * left running. Null for anything else: a command (not this job's: it stays queued), a row taken
   * by another job, ended, or gone.
   */
  private async take(): Promise<ReplyRow | null> {
    const { db } = this.deps;
    const [found] = await db
      .select({ kind: reviewReplies.kind })
      .from(reviewReplies)
      .where(eq(reviewReplies.id, this.replyId));
    if (found === undefined) return null;
    if (found.kind !== 'reply') {
      this.deps.logger.debug?.({ replyId: this.replyId }, 'AI reply job left a command queued');
      return null;
    }
    const claimed = await claimReply(db, this.replyId);
    if (claimed !== null || !this.retry) return claimed;
    const [running] = await db
      .select()
      .from(reviewReplies)
      .where(and(eq(reviewReplies.id, this.replyId), eq(reviewReplies.status, 'running')));
    return running ?? null;
  }

  private async answer(): Promise<void> {
    const { db } = this.deps;
    const taken = await this.take();
    if (taken === null) return;
    const target = await targetOf(db, taken);
    if (taken.threadId === null || taken.issueId === null || target === null) {
      return this.failInternal(taken, 'the row has no thread, no issue or no merge request');
    }
    const row: ReplyInThread = { ...taken, threadId: taken.threadId, issueId: taken.issueId };
    const settings = await readLlmSettings(db);
    const provider = settings.provider;
    if (provider === null || !reviewActive(settings, target.project).active) {
      return this.end(row, { status: 'skipped', reason: 'inactive' });
    }
    const state = await readMergeRequestState(
      { db, scm: this.deps.scm, runtime: this.deps.scmRuntime },
      row.projectId,
      target.branch.name,
    );
    if (state !== null && state.state !== 'open') {
      return this.end(row, { status: 'skipped', reason: 'closed' });
    }
    const replyDeps = this.replyDeps(row, settings, target);
    if (row.verdict === null && (await replyTokensLeft(replyDeps, provider)) <= 0) {
      return this.end(row, { status: 'skipped', reason: 'budget_spent' });
    }
    const issue = await issueOf(db, row);
    if (issue === null) return this.failInternal(row, 'the issue is not of the project of the row');

    const side = this.sideOf(row, target);
    if (side === 'gone') return this.end(row, THREAD_GONE);
    if (side === 'unusable') {
      return this.failInternal(row, 'the SCM connection of the project cannot be used');
    }
    const seen = await this.throughCircuit(row, side, () => this.read(row, issue, side));
    if (seen === WAITING) return;
    if (seen === null) return this.end(row, THREAD_GONE);
    const decision =
      'decided' in seen
        ? seen.decided
        : await this.decide(row, target, issue, seen.thread, seen.round, replyDeps);
    if (decision === null) return;

    // The rest posts the answer and resolves the thread, as far as either is left to do. When
    // anything is, the rest goes through the circuit as one go, the status change with it, once the
    // issue is found the project's again: a row that waits for the circuit has changed nothing.
    const asks =
      decision.verdict === 'keep'
        ? seen.posted === null && decision.answer !== ''
        : !seen.thread.resolved;
    if (!asks) return this.finish(row, issue, side, seen, decision);
    if ((await issueOf(db, row)) === null) {
      return this.failInternal(row, 'the issue is not of the project of the row');
    }
    await this.throughCircuit(row, side, () => this.finish(row, issue, side, seen, decision));
  }

  /**
   * The thread read again, through the job's own requests; null when it is gone, is not read whole,
   * or someone resolved it before Qualor answered (it is closed for the round). With no decision on
   * the row yet, also the round: the people's notes after the thread's last answered round, up to
   * the row's own (null when none is left: they were deleted), and whether every author of them may
   * change the status, asked only in an open AI finding's thread (no other can change).
   */
  private async read(
    row: ReplyInThread,
    issue: ReplyIssue,
    side: ThreadSide,
  ): Promise<Seen | null> {
    const thread = await orGone(() => side.read());
    if (thread === GONE || thread === null) return null;
    const posted = row.answerNoteId ?? thread.answered;
    // A thread resolved before Qualor answered is closed for the round; one resolved after the
    // answer was posted is this job's own resolution, or a person's: the rest goes on.
    if (thread.resolved && posted === null) return null;
    if (row.verdict !== null && row.answer !== null) {
      return { thread, posted, decided: { verdict: row.verdict, answer: row.answer } };
    }
    const after = await lastAnsweredNote(this.deps.db, row);
    const notes = thread.notes.filter((note) => note.id > after && note.id <= row.noteId);
    if (notes.length === 0) return null;
    const changeable = issue.engine === AI_ENGINE && issue.status === 'open';
    const mayChangeStatus = changeable && (await side.mayChangeStatus(notes.map((n) => n.id)));
    return { thread, posted, round: { notes, mayChangeStatus } };
  }

  /**
   * The model's decision on the round, stored on the row; null when the row ended instead, or went
   * back to the queue.
   */
  private async decide(
    row: ReplyInThread,
    target: Target,
    issue: ReplyIssue,
    thread: ReadThread,
    round: PendingRound,
    replyDeps: ReplyDeps,
  ): Promise<Decided | null> {
    const { db } = this.deps;
    const snapshot = await snapshotOf(db, target.branch);
    const decided = await decideReply(
      {
        issue,
        firstNote: thread.firstNote,
        notes: round.notes.map(({ author, body }) => ({ author, body })),
        mayChangeStatus: round.mayChangeStatus,
        snapshot,
        snapshotHead: snapshot?.meta.headSha ?? null,
      },
      replyDeps,
    );
    if ('stopped' in decided) {
      if (this.deps.shutdown.aborted) {
        // Nothing was decided: the next server answers it.
        if (await queueAfterStop(db, row)) {
          this.deps.logger.info({ replyId: row.id }, 'AI reply left for the next server');
        }
      } else {
        await this.end(row, { status: 'skipped', reason: 'inactive' });
      }
      return null;
    }
    if ('failed' in decided) {
      // A day without room for it skips it: a later day's decoration offers it again.
      await this.end(
        row,
        decided.failed === 'budget_spent'
          ? { status: 'skipped', reason: 'budget_spent' }
          : { status: 'failed', reason: decided.failed },
      );
      return null;
    }
    await recordDecision(db, row.id, {
      verdict: decided.verdict,
      answer: decided.answer,
      ...decided.usage,
    });
    return { verdict: decided.verdict, answer: decided.answer };
  }

  /**
   * The rest of the answer, in this order: the verdict's status change, the answer posted once, and
   * the thread resolved for a verdict that is not `keep`; then the row ends with what came of it.
   */
  private async finish(
    row: ReplyInThread,
    issue: ReplyIssue,
    side: ThreadSide,
    { thread, posted }: Seen,
    { verdict, answer }: Decided,
  ): Promise<void> {
    const { db } = this.deps;
    const changed = verdict === 'keep' ? null : await this.changeStatus(row, verdict);
    let noteId = posted;
    if (noteId === null && (answer !== '' || changed !== null)) {
      const note = await orGone(() => side.post(replyNote(row.id, answer, changed)));
      if (note === GONE) return this.end(row, THREAD_GONE);
      noteId = note;
    }
    if (noteId !== null && row.answerNoteId === null) await recordAnswerNote(db, row.id, noteId);
    // A thread gone once the answer is posted has nothing left to resolve.
    if (verdict !== 'keep' && !thread.resolved) await orGone(() => side.resolve());

    const outcome: ReplyOutcome =
      changed ??
      (noteId === null ? 'acknowledged' : issue.engine === AI_ENGINE ? 'answered' : 'explained');
    return this.end(row, { status: 'done', outcome });
  }

  /**
   * The verdict's status on the row's issue while it is an open finding of the AI review of the
   * row's project, as the system's change, recorded on the row in the same transaction. Answers the
   * verdict when the reply changed the status, now or in an earlier try (which the row records),
   * else null. A status is changed once for a row, whatever became of it since: a person's change
   * after the reply's stands.
   */
  private async changeStatus(
    row: ReplyInThread,
    verdict: 'wont_fix' | 'false_positive',
  ): Promise<'wont_fix' | 'false_positive' | null> {
    if (row.outcome === verdict) return verdict;
    const { db, audit } = this.deps;
    const issue = await issueOf(db, row);
    if (issue?.engine !== AI_ENGINE || issue.status !== 'open') return null;
    const changed = await db.transaction(async (tx) => {
      const done = await transitionAsSystem(
        tx,
        row.issueId,
        verdict,
        statusComment(verdict, row.author),
        audit === undefined ? undefined : { recorder: audit, context: SYSTEM_ACTOR },
      );
      if (done) await recordStatusChange(tx, row.id, verdict);
      return done;
    });
    return changed ? verdict : null;
  }

  /**
   * `step`, a go of the job's own requests, through the connection's circuit as the `scm` worker's
   * jobs pass it (scm.md §4.2). A circuit that is open, or half-open with another job's probe in
   * flight, does not let it through: the row goes back to the queue for when the circuit reopens,
   * or {@link REPLY_CIRCUIT_WAIT_SECONDS} on when that is not known, no try of the job is spent, and
   * the answer is WAITING. The circuit hears what came of a go it let through: a request that came
   * back, whatever it says, is an answer (the provider is up), and one that failed is reported by
   * its error ({@link CircuitBreaker.reportError}); an error of Qualor's own hands a probe on.
   */
  private async throughCircuit<T>(
    row: ReplyRow,
    side: ThreadSide,
    step: () => Promise<T>,
  ): Promise<T | typeof WAITING> {
    const { circuit } = this.deps.scmRuntime;
    const { connectionId } = side;
    if (!circuit.tryPass(connectionId)) {
      const until = circuit.openUntil(connectionId);
      const waitSeconds =
        until === null
          ? REPLY_CIRCUIT_WAIT_SECONDS
          : Math.max(1, Math.ceil((until - Date.now()) / 1000));
      if (await queueAfterCircuit(this.deps.db, row, waitSeconds)) {
        this.deps.logger.info(
          { replyId: row.id, connectionId, retryInSeconds: waitSeconds },
          'AI reply waits for the circuit of its SCM connection',
        );
      }
      return WAITING;
    }
    try {
      const done = await step();
      circuit.success(connectionId);
      return done;
    } catch (err) {
      if (err instanceof ScmError) circuit.reportError(connectionId, err);
      else circuit.release(connectionId);
      throw err;
    }
  }

  /**
   * The thread's side on the provider the project is mapped to now: `gone` when that is no longer
   * the row's provider, `unusable` when its client cannot be made (a key that no longer decrypts,
   * an address the rules no longer allow) or the ids are none of the provider's.
   */
  private sideOf(row: ReplyInThread, target: Target): ThreadSide | 'gone' | 'unusable' {
    const { connection, project, branch } = target;
    if (connection === null || connection.provider !== row.provider) return 'gone';
    if (project.scmProjectRef === null) return 'unusable';
    if (connection.provider === 'github') {
      const repo = parseRepoRef(project.scmProjectRef);
      const found = githubClientFor(connection, this.deps.scm, this.deps.scmRuntime);
      if (repo === null || 'problem' in found || !GITHUB_PR_NUMBER.test(branch.name)) {
        return 'unusable';
      }
      return githubSide(connection.id, found.client, repo, branch.name, row);
    }
    const found = gitlabClientFor(connection, this.deps.scm);
    if ('problem' in found || !GITLAB_MR_IID.test(branch.name)) return 'unusable';
    return gitlabSide(connection.id, found.client, project.scmProjectRef, branch.name, row);
  }

  /**
   * What the reply conversation needs: the settings read at the start, the organisation's day, and
   * a stop of its own when AI review is no longer active for the project (the settings read again).
   * The merge request's state is not asked again: the start did.
   */
  private replyDeps(row: ReplyRow, settings: StoredLlmSettings, target: Target): ReplyDeps {
    const { db } = this.deps;
    return {
      db,
      runtime: { circuit: this.deps.llmCircuit },
      config: this.deps.config,
      settings,
      organizationId: target.project.organizationId,
      reply: { id: row.id, projectId: row.projectId },
      shouldStop: async () => {
        const now = await readLlmSettings(db);
        const [project] = await db
          .select({
            id: projects.id,
            organizationId: projects.organizationId,
            scmConnectionId: projects.scmConnectionId,
          })
          .from(projects)
          .where(eq(projects.id, row.projectId));
        return project === undefined || !reviewActive(now, project).active;
      },
      signal: this.deps.shutdown,
      logger: this.deps.logger,
    };
  }

  /** Ends the row, and says so once: its id and how it ended. */
  private async end(row: Pick<ReplyRow, 'id'>, end: ReplyEnd): Promise<void> {
    await endReply(this.deps.db, row.id, end);
    this.deps.logger.info(
      {
        replyId: row.id,
        status: end.status,
        outcome: end.outcome ?? null,
        reason: end.reason ?? null,
      },
      'AI reply ended',
    );
  }

  /** Ends the row `failed: internal`, with why, in Qualor's words. */
  private async failInternal(row: Pick<ReplyRow, 'id'>, why: string): Promise<void> {
    this.deps.logger.warn({ replyId: row.id }, `AI reply not answered: ${why}`);
    await this.end(row, { status: 'failed', reason: 'internal' });
  }
}

/**
 * The `ai-reply` queue's handler (6I-4), run by the review worker before the reviews' (main.ts),
 * with the review worker's deps: an `answer` job answers its row (`ReplyJob`); a `scan` job is a
 * webhook's, which this server does not make yet, and completes. A payload that does not parse
 * never will: the job completes. An error fails the job into its second try (`AI_REPLY_MAX_ATTEMPTS`),
 * which resumes the row where the first left it.
 */
export function replyHandlers(deps: ReviewJobDeps): JobHandlers {
  return {
    [AI_REPLY_QUEUE]: async (job) => {
      const parsed = replyPayload.safeParse(job.payload);
      if (!parsed.success) {
        deps.logger.warn(
          { jobId: job.id, queue: job.queue },
          'malformed AI reply job payload; completing without retry',
        );
        return;
      }
      if (parsed.data.kind === 'scan') {
        deps.logger.debug?.({ jobId: job.id }, 'AI reply scan job completed: no scan is made');
        return;
      }
      await new ReplyJob(
        deps,
        parsed.data.replyId,
        job.attempts > 1,
        job.attempts >= job.maxAttempts,
      ).run();
    },
  };
}
