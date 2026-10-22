import type { Quality, Severity } from '@qualor/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { issues } from '../../db/schema';
import { desiredInlineIssues } from '../decoration-data';
import { addedLines, MAX_INLINE_THREADS, type InlineResult } from '../inline';
import { markerOf } from '../markdown';
import { inlineBody } from '../render';
import {
  MAX_THREAD_PAGES,
  type GitHubClient,
  type GitHubFile,
  type GitHubReviewComment,
  type GitHubReviewThread,
} from './client';

/**
 * github.md §5.3: pages of issue comments one job reads, and of the pull request's review
 * comments (the same bound: both are lists of comments, read page by page).
 */
export const MAX_COMMENT_PAGES = 50;
/**
 * Ruling T6: at most this many threads are resolved or reopened by one job; the rest wait for the
 * branch's next decoration. With the pages a job may read and its (at most
 * {@link MAX_INLINE_THREADS}) creations this keeps it within its request budget (ruling R7), so the
 * check run and the summary are always written.
 */
export const MAX_GITHUB_THREAD_UPDATES = 100;

export interface ReviewThreadContext {
  db: Db;
  client: GitHubClient;
  /** The pull request's number. */
  number: string;
  /** The Qualor project: only threads of its own issues are touched (a monorepo, github.md §6.4). */
  projectId: string;
  branchId: string;
  /** The pull request's head, which is the analysed revision: new comments are made on it. */
  headSha: string;
  /** The pull request's files with their patches; a file the page bound cut is simply not there. */
  files: readonly GitHubFile[];
  /**
   * The App's `<slug>[bot]` (github.md §6.3): a comment is Qualor's only when it is by this login,
   * and a resolution is Qualor's own only when GitHub names this login as its resolver (ruling R6).
   */
  botLogin: string;
  issueUrl: (issueId: string) => string | null;
  /** {@link MAX_GITHUB_THREAD_UPDATES} unless a test sets a smaller one. */
  maxThreadUpdates?: number;
  /** {@link MAX_COMMENT_PAGES} unless a test sets a smaller one. */
  maxCommentPages?: number;
  /** {@link MAX_THREAD_PAGES} unless a test sets a smaller one. */
  maxThreadPages?: number;
}

interface OwnThread {
  /**
   * The thread, or null when the thread listing does not show one for the comment's node id (it
   * was cut by its page bound, or names the comment otherwise): then nothing is created or
   * changed for it.
   */
  thread: GitHubReviewThread | null;
  /** Someone but the App wrote in the thread after the App's first comment. */
  humanReplied: boolean;
}

/** A comment is the App's only when its author is a bot of the App's login (github.md §6.3). */
function byApp(comment: GitHubReviewComment, botLogin: string): boolean {
  return comment.user?.type === 'Bot' && comment.user.login === botLogin;
}

/** The first comment a reply answers; null for a first comment (GitHub sends no id, or null). */
function repliesTo(comment: GitHubReviewComment): number | null {
  return typeof comment.in_reply_to_id === 'number' ? comment.in_reply_to_id : null;
}

/**
 * Qualor's review threads by issue id (github.md §6.3): a top-level review comment by the App
 * whose first line is an issue marker, with the thread GraphQL lists for it: the one whose first
 * comment has the comment's node id (REST's `node_id`, GraphQL's `id`; github.com's REST ids no
 * longer fit GraphQL's deprecated 32-bit `databaseId`). A marker in anyone else's comment, or in a
 * reply, is ignored; of two comments for one issue (never made by Qualor) the first, which is the
 * older, is the issue's. The map is in the order of the comments.
 */
function ownThreads(
  comments: readonly GitHubReviewComment[],
  threads: readonly GitHubReviewThread[],
  botLogin: string,
): Map<string, OwnThread> {
  const byFirstComment = new Map<string, GitHubReviewThread>();
  for (const thread of threads) {
    if (thread.firstCommentNodeId !== null && !byFirstComment.has(thread.firstCommentNodeId)) {
      byFirstComment.set(thread.firstCommentNodeId, thread);
    }
  }
  // A reply names the thread's first comment by its REST id; a reply by anyone but the App is
  // not Qualor's.
  const repliedIn = new Set<number>();
  for (const comment of comments) {
    const first = repliesTo(comment);
    if (first !== null && !byApp(comment, botLogin)) repliedIn.add(first);
  }
  const own = new Map<string, OwnThread>();
  for (const comment of comments) {
    if (repliesTo(comment) !== null || !byApp(comment, botLogin)) continue;
    const marker = markerOf(comment.body);
    if (marker?.kind !== 'issue' || own.has(marker.issueId)) continue;
    own.set(marker.issueId, {
      thread: byFirstComment.get(comment.node_id) ?? null,
      humanReplied: repliedIn.has(comment.id),
    });
  }
  return own;
}

/**
 * github.md §6.4 (the counterpart of scm.md §5.4's `reconcileInline`): reconciles Qualor's review
 * threads with the branch's open new issues. Called only when the pull request's head is the
 * analysed revision and the workflow checked out that head. For the threads of this project's
 * issues:
 * - an open issue whose thread Qualor resolved gets it reopened. A resolution is Qualor's when
 *   GitHub names the App's `<slug>[bot]` as its resolver (ruling R6); one a person or another App
 *   made, or one GitHub names nobody for, stays as it is, and the issue still counts (ruling G3);
 * - an issue that is no longer open gets its thread resolved, unless someone but the App replied in
 *   it (a person, or another App);
 * - a thread of an issue this project does not have (another Qualor project of a monorepo, or an
 *   issue since deleted) is left alone.
 * Then each of the (at most {@link MAX_INLINE_THREADS}) most severe open new issues without a
 * thread gets one on an added line of the pull request's files (ruling T1), unless a listing was
 * cut by its page bound. A thread is never deleted and its comment never edited (ruling T2), and a
 * comment by anyone else is never touched.
 */
export async function reconcileReviewThreads(ctx: ReviewThreadContext): Promise<InlineResult> {
  const comments = await ctx.client.reviewComments(
    ctx.number,
    ctx.maxCommentPages ?? MAX_COMMENT_PAGES,
  );
  const listed = await ctx.client.reviewThreads(ctx.number, ctx.maxThreadPages ?? MAX_THREAD_PAGES);
  const own = ownThreads(comments.items, listed.items, ctx.botLogin);
  const ownIssueIds = [...own.keys()];
  const rows =
    ownIssueIds.length === 0
      ? []
      : await ctx.db
          .select({
            id: issues.id,
            branchId: issues.branchId,
            status: issues.status,
            duplicateOf: issues.duplicateOfIssueId,
          })
          .from(issues)
          .where(and(inArray(issues.id, ownIssueIds), eq(issues.projectId, ctx.projectId)));
  const known = new Map(rows.map((row) => [row.id, row]));
  const maxUpdates = ctx.maxThreadUpdates ?? MAX_GITHUB_THREAD_UPDATES;
  let commented = 0;
  let updates = 0;
  // In the order of the comments, the oldest first: what the bound leaves for the next job is the
  // same on every run, and newer threads never keep the older ones waiting.
  for (const [issueId, { thread, humanReplied }] of own) {
    const issue = known.get(issueId);
    if (!issue) continue;
    const open =
      issue.branchId === ctx.branchId && issue.status === 'open' && issue.duplicateOf === null;
    let resolve: boolean | null = null;
    if (thread !== null) {
      if (open && thread.isResolved && thread.resolvedByLogin === ctx.botLogin) resolve = false;
      else if (!open && !thread.isResolved && !humanReplied) resolve = true;
    }
    let exists = true;
    if (thread !== null && resolve !== null && updates < maxUpdates) {
      updates += 1;
      // 'not_found': a person deleted the thread after the listing; skipped, like a refused position.
      exists = (await ctx.client.setThreadResolved(thread.id, resolve)) === 'done';
    }
    if (open && exists) commented += 1;
  }

  // Beyond a page bound a thread may exist unseen: never create a second one (github.md §6.4).
  if (!comments.complete || !listed.complete) return { commented, unplaced: 0 };
  const desired = await desiredInlineIssues(ctx.db, ctx.branchId, MAX_INLINE_THREADS);
  const missing = desired.filter((issue) => !own.has(issue.id));
  if (missing.length === 0) return { commented, unplaced: 0 };
  const added = new Map<string, ReadonlySet<number>>();
  for (const file of ctx.files) {
    if (file.status !== 'removed' && file.patch !== undefined) {
      added.set(file.filename, addedLines(file.patch));
    }
  }
  let unplaced = 0;
  for (const issue of missing) {
    const { path, line } = issue;
    if (path === null || line === null || !added.get(path)?.has(line)) {
      unplaced += 1;
      continue;
    }
    const created = await ctx.client.createReviewComment(ctx.number, {
      body: inlineBody({
        issueId: issue.id,
        severity: issue.severity as Severity,
        quality: issue.quality as Quality,
        ruleKey: issue.ruleKey,
        helpUri: issue.helpUri,
        message: issue.message,
        confidence: issue.confidence,
        url: ctx.issueUrl(issue.id),
      }),
      commitId: ctx.headSha,
      path,
      line,
    });
    if (created === 'position_rejected') unplaced += 1;
    else commented += 1;
  }
  return { commented, unplaced };
}
