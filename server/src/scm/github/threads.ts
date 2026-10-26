import type { Quality, Severity } from '@qualor/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { issues, rules } from '../../db/schema';
import { githubRounds, type Round } from '../../review/reply-detect';
import type { ReplyWindow } from '../../review/reply-queue';
import { AI_THREAD_SEVERITIES } from '../../review/rules';
import { AI_ENGINE } from '../../rules/server-engines';
import { closingRevisions, desiredInlineIssues, type DesiredAiIssue } from '../decoration-data';
import {
  addedLineTexts,
  aiFindingNote,
  aiThreads,
  liveSuggestion,
  MAX_AI_THREADS,
  MAX_FIXED_NOTES,
  MAX_INLINE_THREADS,
  postsAiThread,
  type InlineResult,
} from '../inline';
import { markerOf, notedFixes } from '../markdown';
import { ScmError } from '../provider';
import { fixedNote, inlineBody } from '../render';
import {
  MAX_THREAD_PAGES,
  type GitHubClient,
  type GitHubFile,
  type GitHubReviewComment,
  type GitHubReviewThread,
} from './client';
import { reviewBody } from './render';

/**
 * github.md §5.3: pages of issue comments one job reads, and of the pull request's review
 * comments (the same bound: both are lists of comments, read page by page).
 */
export const MAX_COMMENT_PAGES = 50;
/**
 * Ruling T6: at most this many threads are resolved or reopened by one job; the rest wait for the
 * branch's next decoration. With the pages a job may read, its creations
 * ({@link MAX_CREATION_REQUESTS}) and its notes of fixed issues ({@link MAX_FIXED_NOTES}) this
 * keeps it within its request budget (ruling R7), so the check run and the summary are always
 * written.
 */
export const MAX_GITHUB_THREAD_UPDATES = 100;
/**
 * Requests that create one job's threads (ruling R7): the one review that holds them all, and,
 * when GitHub refuses a position of it, each of the (at most {@link MAX_INLINE_THREADS} of the
 * analyzers' and {@link MAX_AI_THREADS} of the AI review's) comments alone.
 */
export const MAX_CREATION_REQUESTS = 1 + MAX_INLINE_THREADS + MAX_AI_THREADS;

/** A thread of Qualor's to resolve (`resolve`) or to reopen. */
export interface ThreadUpdate {
  threadId: string;
  resolve: boolean;
  /** Its issue is an analyzer's and open: the issue counts as commented while the thread is there. */
  counted: boolean;
}

/**
 * A new thread: Qualor's review comment on an added line, its body the issue's (marker first). A
 * comment over several lines (a suggestion replaces them all) has `startLine` too, and `line` is
 * the last of them.
 */
export interface ThreadCreation {
  path: string;
  line: number;
  startLine?: number;
  body: string;
  /** The AI review's finding the thread is for; none for an analyzer's issue. */
  finding?: DesiredAiIssue;
}

/**
 * Qualor's note in the open thread of a fixed issue that someone replied in, which stays open for
 * them: a reply to the thread's first comment, "Fixed in" the revision that found the issue fixed.
 */
export interface FixedNote {
  /** The REST id of the thread's first comment, which the note replies to. */
  firstCommentId: number;
  issueId: string;
  /** The full revision the issue was found fixed at. */
  sha: string;
}

/**
 * What a decoration does to Qualor's threads (github.md §6.4), worked out from the listings and
 * the database before anything is written, so the check run, which comes first (github.md §6.1),
 * can say how many issues are commented.
 */
export interface ThreadPlan {
  /** Resolutions and reopenings, the oldest thread first, at most the job's bound. */
  updates: readonly ThreadUpdate[];
  /**
   * The notes of fixed issues in the open threads that someone replied in and that do not hold
   * theirs yet, the oldest thread first, at most {@link MAX_FIXED_NOTES}. None when the review
   * comments were cut by their page bound: a thread's note may be there unseen.
   */
  fixedNotes: readonly FixedNote[];
  /**
   * New threads, posted together as one review: the most severe analyzer issues first, then the
   * most severe findings of the AI review.
   */
  creations: readonly ThreadCreation[];
  /** The analyzers' open issues with a thread once every update and creation is made. */
  commented: number;
  /** Desired analyzer issues the diff has no place for. */
  unplaced: number;
  /**
   * The AI findings that have no thread and get none this time, most severe first: the pull
   * request moved on from the head the review read, they are past {@link MAX_AI_THREADS}, or the
   * diff has no place for them. Only findings of the severities that get a thread for themselves: a
   * low one is counted in the summary, never listed. Empty when a listing was cut by its page
   * bound: a thread of any of them may exist unseen.
   */
  aiNotPosted: readonly DesiredAiIssue[];
  /**
   * The people's new replies in Qualor's threads (6I-4), whose answers the decoration queues;
   * empty without `ReviewThreadContext.replies`. Found in the listings the plan reads, cut by a
   * page bound or not: a reply it saw is a reply. A thread of another project's issue is among
   * them: the queue keeps the project's own. Nothing is written for them here.
   */
  rounds: readonly Round[];
}

/** What applying the plan came to: the counts it gives, and the AI findings still without a thread. */
export interface AppliedThreads extends InlineResult {
  /**
   * The resolutions and reopenings the App may not make (it lacks Contents: write), whose threads
   * stay as GitHub holds them.
   */
  unresolved: number;
  /** {@link ThreadPlan.aiNotPosted}, and then those GitHub refused. */
  aiNotPosted: readonly DesiredAiIssue[];
}

export interface ReviewThreadContext {
  db: Db;
  client: GitHubClient;
  /** The pull request's number. */
  number: string;
  /** The Qualor project: only threads of its own issues are touched (a monorepo, github.md §6.4). */
  projectId: string;
  branchId: string;
  /** The pull request's head: new comments are made on it. */
  headSha: string;
  /** The pull request's files with their patches; a file the page bound cut is simply not there. */
  files: readonly GitHubFile[];
  /**
   * Whether the analyzers' threads are reconciled: only when the report's line numbers are the
   * pull request's (the workflow checked out its head, and it is the analysed revision). The AI
   * review's threads are in every decoration: their lines are those of the head the review read,
   * and they are created only while the pull request is at it.
   */
  analyzers: boolean;
  /**
   * The App's `<slug>[bot]` (github.md §6.3): a comment is Qualor's only when it is by this login,
   * and a resolution is Qualor's own only when GitHub names this login as its resolver (ruling R6).
   */
  botLogin: string;
  /**
   * Where to look for the people's replies Qualor answers (6I-4); null when AI review is not
   * active for the project, which answers none.
   */
  replies: ReplyWindow | null;
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
  /** The REST id of the App's first comment, which a reply in the thread names. */
  firstCommentId: number;
  /** Someone but the App wrote in the thread after the App's first comment. */
  humanReplied: boolean;
  /** The revisions the App's replies in the thread say its issue was fixed at (`fixedMarker`). */
  notedFixes: ReadonlySet<string>;
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
  // not Qualor's, and the App's own are its notes.
  const repliedIn = new Set<number>();
  const appReplies = new Map<number, string[]>();
  for (const comment of comments) {
    const first = repliesTo(comment);
    if (first === null) continue;
    if (!byApp(comment, botLogin)) repliedIn.add(first);
    else appReplies.set(first, [...(appReplies.get(first) ?? []), comment.body]);
  }
  const own = new Map<string, OwnThread>();
  for (const comment of comments) {
    if (repliesTo(comment) !== null || !byApp(comment, botLogin)) continue;
    const marker = markerOf(comment.body);
    if (marker?.kind !== 'issue' || own.has(marker.issueId)) continue;
    own.set(marker.issueId, {
      thread: byFirstComment.get(comment.node_id) ?? null,
      firstCommentId: comment.id,
      humanReplied: repliedIn.has(comment.id),
      notedFixes: notedFixes(appReplies.get(comment.id) ?? [], marker.issueId),
    });
  }
  return own;
}

/** The issues of this project that Qualor's threads are for, by id (another project's are left out). */
async function threadIssues(ctx: ReviewThreadContext, ids: string[]) {
  const rows =
    ids.length === 0
      ? []
      : await ctx.db
          .select({
            id: issues.id,
            branchId: issues.branchId,
            status: issues.status,
            duplicateOf: issues.duplicateOfIssueId,
            engineId: rules.engineId,
          })
          .from(issues)
          .innerJoin(rules, eq(rules.id, issues.ruleId))
          .where(and(inArray(issues.id, ids), eq(issues.projectId, ctx.projectId)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * What a thread of Qualor's needs: resolving (true), reopening (false), or nothing (null). Only a
 * resolution GitHub names the App for is Qualor's own to undo (ruling R6); a reply by anyone else
 * keeps a fixed issue's thread open, but never stops Qualor from reopening what it resolved.
 */
function change(
  thread: GitHubReviewThread,
  open: boolean,
  humanReplied: boolean,
  botLogin: string,
): boolean | null {
  if (open && thread.isResolved && thread.resolvedByLogin === botLogin) return false;
  if (!open && !thread.isResolved && !humanReplied) return true;
  return null;
}

/**
 * The resolutions and reopenings the threads need, how many of the analyzers' issues are open, and
 * the fixed issues whose open threads someone replied in (`fixed`, the oldest thread first), which
 * are told so ({@link planFixedNotes}). The AI review's threads are updated in every decoration:
 * whether their findings are open comes from the review, not from the analysis' line numbers.
 */
async function planUpdates(
  ctx: ReviewThreadContext,
  own: ReadonlyMap<string, OwnThread>,
): Promise<{ updates: ThreadUpdate[]; commented: number; fixed: string[] }> {
  const known = await threadIssues(ctx, [...own.keys()]);
  const maxUpdates = ctx.maxThreadUpdates ?? MAX_GITHUB_THREAD_UPDATES;
  const updates: ThreadUpdate[] = [];
  const fixed: string[] = [];
  let commented = 0;
  // In the order of the comments, the oldest first: what the bound leaves for the next job is the
  // same on every run, and newer threads never keep the older ones waiting.
  for (const [issueId, { thread, humanReplied }] of own) {
    const issue = known.get(issueId);
    if (!issue) continue;
    const reviewed = issue.engineId === AI_ENGINE;
    if (!reviewed && !ctx.analyzers) continue;
    const open =
      issue.branchId === ctx.branchId && issue.status === 'open' && issue.duplicateOf === null;
    // The summary counts the analyzers' threads; its AI section speaks for the review's own.
    const counted = open && !reviewed;
    if (counted) commented += 1;
    const resolve = thread === null ? null : change(thread, open, humanReplied, ctx.botLogin);
    if (thread !== null && resolve !== null && updates.length < maxUpdates) {
      updates.push({ threadId: thread.id, resolve, counted });
    }
    const closed = issue.branchId === ctx.branchId && issue.status === 'closed';
    if (closed && thread !== null && !thread.isResolved && humanReplied) fixed.push(issueId);
  }
  return { updates, commented, fixed };
}

/**
 * The notes of the fixed issues `fixed` (the oldest thread first), whose open threads someone
 * replied in: "Fixed in" the revision that found each issue fixed, for a thread that does not hold
 * that note yet, at most {@link MAX_FIXED_NOTES}.
 */
async function planFixedNotes(
  ctx: ReviewThreadContext,
  own: ReadonlyMap<string, OwnThread>,
  fixed: readonly string[],
): Promise<FixedNote[]> {
  if (fixed.length === 0) return [];
  const revisions = await closingRevisions(ctx.db, fixed);
  const notes: FixedNote[] = [];
  for (const issueId of fixed) {
    const thread = own.get(issueId);
    const sha = revisions.get(issueId);
    if (thread === undefined || sha === undefined || thread.notedFixes.has(sha)) continue;
    if (notes.length === MAX_FIXED_NOTES) break;
    notes.push({ firstCommentId: thread.firstCommentId, issueId, sha });
  }
  return notes;
}

/**
 * The added lines of each file that can hold a comment (ruling T1), by line number in the new file
 * with their text: not removed, with a patch.
 */
function addedLinesByPath(files: readonly GitHubFile[]): Map<string, ReadonlyMap<number, string>> {
  const added = new Map<string, ReadonlyMap<number, string>>();
  for (const file of files) {
    if (file.status !== 'removed' && file.patch !== undefined) {
      added.set(file.filename, addedLineTexts(file.patch));
    }
  }
  return added;
}

type AddedLines = ReadonlyMap<string, ReadonlyMap<number, string>>;

/** The new threads of the most severe open new issues without one, and the issues with no place. */
async function planCreations(
  ctx: ReviewThreadContext,
  own: ReadonlyMap<string, OwnThread>,
  added: AddedLines,
): Promise<{ creations: ThreadCreation[]; unplaced: number }> {
  const desired = await desiredInlineIssues(ctx.db, ctx.branchId, MAX_INLINE_THREADS);
  const creations: ThreadCreation[] = [];
  let unplaced = 0;
  for (const issue of desired) {
    if (own.has(issue.id)) continue;
    const { path, line } = issue;
    if (path === null || line === null || !added.get(path)?.has(line)) {
      unplaced += 1;
      continue;
    }
    creations.push({
      path,
      line,
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
    });
  }
  return { creations, unplaced };
}

/**
 * The new threads of the AI review's findings, and the findings that get none. The findings are
 * those of the branch's newest finished review that have no thread, the most severe first; they get
 * one only while the pull request is at the head that review read, up to {@link MAX_AI_THREADS}. A
 * thread sits on its finding's anchor, an added line of the diff. When its note carries a
 * suggestion, which is written only while it still applies to the diff, the comment spans the lines
 * the suggestion replaces: GitHub applies the suggestion to the whole range of the comment. A low
 * finding is commented for its suggestion only.
 */
async function planAiCreations(
  ctx: ReviewThreadContext,
  own: ReadonlyMap<string, OwnThread>,
  added: AddedLines,
): Promise<{ creations: ThreadCreation[]; notPosted: DesiredAiIssue[] }> {
  const ai = await aiThreads(ctx.db, ctx.branchId, ctx.headSha, (id) => own.has(id));
  if (ai === null) return { creations: [], notPosted: [] };
  const creations: ThreadCreation[] = [];
  for (const issue of ai.create) {
    const place = added.get(issue.path);
    if (place === undefined || !place.has(issue.anchorLine)) continue;
    const suggestion = await liveSuggestion(ctx.db, ctx.branchId, ai.head, issue, place);
    const note = aiFindingNote('github', issue, suggestion, ctx.issueUrl(issue.id));
    if (!postsAiThread(issue, note)) continue;
    // A note that left the suggestion out (none to offer, or the note would be too long) is on its
    // anchor alone, with no range to show.
    const block = note.suggestion;
    creations.push({
      path: issue.path,
      line: block?.endLine ?? issue.anchorLine,
      ...(block !== null && block.endLine > block.startLine ? { startLine: block.startLine } : {}),
      body: note.body,
      finding: issue,
    });
  }
  // A low finding is posted for its suggestion only: one that is not is counted, never listed.
  const posted = new Set(creations.map((creation) => creation.finding));
  const notPosted = ai.waiting.filter(
    (issue) => !posted.has(issue) && AI_THREAD_SEVERITIES.has(issue.severity),
  );
  return { creations, notPosted };
}

/**
 * The people's new replies in Qualor's threads, which Qualor answers (6I-4). None without a
 * window: AI review is not active for the project.
 */
function plannedRounds(
  ctx: ReviewThreadContext,
  comments: readonly GitHubReviewComment[],
  threads: readonly GitHubReviewThread[],
): Round[] {
  if (ctx.replies === null) return [];
  const options = { qualor: { githubLogin: ctx.botLogin }, ...ctx.replies };
  return githubRounds(comments, threads, options);
}

/**
 * github.md §6.4 (the counterpart of scm.md §5.4's `reconcileInline`), its first half: reads the
 * pull request's review comments and threads and the issues, and works out what to change,
 * writing nothing, so the check run, written first (github.md §6.1), carries the counts. Called
 * for an open pull request. The new replies of people in Qualor's threads are part of the plan
 * (`rounds`), for the decoration to queue their answers. For the threads of this project's issues
 * (the analyzers' only when `analyzers`, the AI review's always):
 * - an open issue whose thread Qualor resolved gets it reopened. A resolution is Qualor's when
 *   GitHub names the App's `<slug>[bot]` as its resolver (ruling R6); one a person or another App
 *   made, or one GitHub names nobody for, stays as it is, and the issue still counts (ruling G3);
 * - an issue that is no longer open gets its thread resolved, unless someone but the App replied in
 *   it (a person, or another App);
 * - an issue that was found fixed (`closed`) whose open thread someone else replied in gets one
 *   note in it that says so, with the revision that found it fixed ({@link MAX_FIXED_NOTES} a job,
 *   the oldest threads first): never one a person decided on (won't fix, false positive,
 *   resolved), nor one whose resolution the App may not make (the summary counts those);
 * - a thread of an issue this project does not have (another Qualor project of a monorepo, or an
 *   issue since deleted) is left alone.
 * Then each of the (at most {@link MAX_INLINE_THREADS}) most severe open new issues without a
 * thread is to get one on an added line of the pull request's files (ruling T1), and so, beside
 * them, is each of the (at most {@link MAX_AI_THREADS}) findings of the AI review that the pull
 * request's head allows, unless a listing was cut by its page bound. A thread is never deleted and
 * its comment never edited (ruling T2), and a comment by anyone else is never touched.
 */
export async function planReviewThreads(ctx: ReviewThreadContext): Promise<ThreadPlan> {
  const comments = await ctx.client.reviewComments(
    ctx.number,
    ctx.maxCommentPages ?? MAX_COMMENT_PAGES,
  );
  const listed = await ctx.client.reviewThreads(ctx.number, ctx.maxThreadPages ?? MAX_THREAD_PAGES);
  const own = ownThreads(comments.items, listed.items, ctx.botLogin);
  const { updates, commented, fixed } = await planUpdates(ctx, own);
  const rounds = plannedRounds(ctx, comments.items, listed.items);
  // A thread's note may be beyond the review comments' page bound: none is written then.
  const fixedNotes = comments.complete ? await planFixedNotes(ctx, own, fixed) : [];
  // Beyond a page bound a thread may exist unseen: never create a second one (github.md §6.4).
  if (!comments.complete || !listed.complete) {
    return { updates, fixedNotes, creations: [], rounds, commented, unplaced: 0, aiNotPosted: [] };
  }
  const added = addedLinesByPath(ctx.files);
  const analyzers = ctx.analyzers
    ? await planCreations(ctx, own, added)
    : { creations: [], unplaced: 0 };
  const ai = await planAiCreations(ctx, own, added);
  return {
    updates,
    fixedNotes,
    creations: [...analyzers.creations, ...ai.creations],
    rounds,
    commented: commented + analyzers.creations.length,
    unplaced: analyzers.unplaced,
    aiNotPosted: ai.notPosted,
  };
}

/** What the client posts of a creation: its place and its body, not the finding it is for. */
const commentOf = ({ path, line, startLine, body }: ThreadCreation) => ({
  path,
  line,
  startLine,
  body,
});

/**
 * The new threads as one pull request review (`event: COMMENT`), its body a marker and their
 * count: one request, one notification and one timeline entry for them all. When GitHub refuses a
 * position of it (a 422, which makes none of them), each is posted alone, with its lines as before.
 * Returns the ones GitHub would not place.
 */
async function createThreads(
  ctx: ReviewThreadContext,
  creations: readonly ThreadCreation[],
): Promise<ThreadCreation[]> {
  if (creations.length === 0) return [];
  const review = await ctx.client.createReview(ctx.number, {
    commitId: ctx.headSha,
    body: reviewBody(ctx.projectId, creations.length),
    comments: creations.map(commentOf),
  });
  if (review !== 'position_rejected') return [];
  const refused: ThreadCreation[] = [];
  for (const creation of creations) {
    const created = await ctx.client.createReviewComment(ctx.number, {
      ...commentOf(creation),
      commitId: ctx.headSha,
    });
    if (created === 'position_rejected') refused.push(creation);
  }
  return refused;
}

/**
 * What the plan comes to, which the check run says before anything is applied (github.md §6.1):
 * the plan's own counts, unless the App may not resolve or reopen threads (its installation lacks
 * Contents: write). Then every update is refused with no request, as applying the plan finds: its
 * thread stays as it is and counts as unresolved, and an open issue it was to reopen does not
 * count. So the check run need not be written again for what was known before.
 */
export function plannedCounts(
  plan: ThreadPlan,
  mayResolveThreads: boolean,
): Omit<AppliedThreads, 'aiNotPosted'> {
  if (mayResolveThreads) {
    return { commented: plan.commented, unplaced: plan.unplaced, unresolved: 0 };
  }
  const reopened = plan.updates.filter((update) => update.counted).length;
  return {
    commented: plan.commented - reopened,
    unplaced: plan.unplaced,
    unresolved: plan.updates.length,
  };
}

/**
 * github.md §6.4, the second half: makes the plan's resolutions and reopenings, then its notes of
 * fixed issues, each a reply in its thread, then its new threads as one review, and gives the
 * counts as they are now. A thread GitHub no longer has (`NOT_FOUND`: a person deleted it after the
 * listing) is skipped, like a refused position, and its open issue no longer counts; so is one the
 * App may not resolve or reopen (it lacks Contents: write), which stays as GitHub holds it and
 * counts as unresolved. A position GitHub refuses counts as not placed (an analyzer's issue) or
 * joins the AI findings that got no thread (a finding of the AI review). Any error (a rate limit,
 * the request budget) stops it where it is: the next decoration plans again from what GitHub then
 * holds.
 */
export async function applyReviewThreads(
  ctx: ReviewThreadContext,
  plan: ThreadPlan,
): Promise<AppliedThreads> {
  let commented = plan.commented;
  let unresolved = 0;
  for (const update of plan.updates) {
    const result = await ctx.client.setThreadResolved(update.threadId, update.resolve);
    if (result === 'refused') unresolved += 1;
    if (result !== 'done' && update.counted) commented -= 1;
  }
  for (const note of plan.fixedNotes) {
    try {
      await ctx.client.replyToReviewComment(
        ctx.number,
        note.firstCommentId,
        fixedNote(note.issueId, note.sha),
      );
    } catch (err) {
      if (!(err instanceof ScmError && err.kind === 'not_found')) throw err;
    }
  }
  const refused = await createThreads(ctx, plan.creations);
  const refusedAi = refused.flatMap(({ finding }) =>
    finding !== undefined && AI_THREAD_SEVERITIES.has(finding.severity) ? [finding] : [],
  );
  const refusedAnalyzers = refused.filter(({ finding }) => finding === undefined).length;
  return {
    commented: commented - refusedAnalyzers,
    unplaced: plan.unplaced + refusedAnalyzers,
    unresolved,
    aiNotPosted: [...plan.aiNotPosted, ...refusedAi],
  };
}
