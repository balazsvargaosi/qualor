import type { Quality, Severity } from '@qualor/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues, rules } from '../db/schema';
import { aiThreadBody } from '../review/render';
import { AI_THREAD_SEVERITIES } from '../review/rules';
import { suggestionApplies, type ReviewSuggestion } from '../review/suggestion';
import { AI_ENGINE } from '../rules/server-engines';
import {
  desiredAiIssues,
  desiredInlineIssues,
  newestReviewedHead,
  reviewedLines,
  type DesiredAiIssue,
} from './decoration-data';
import {
  GitLabError,
  type GitLabClient,
  type GitLabDiff,
  type GitLabDiscussion,
  type GitLabMergeRequest,
} from './gitlab/client';
import { markerOf } from './markdown';
import { inlineBody } from './render';

/** scm.md §4.3: pages of discussions one job reads at most ... */
export const MAX_DISCUSSION_PAGES = 50;
/** ... and pages of the merge request's diffs. */
export const MAX_DIFF_PAGES = 30;
/** scm.md §5.4: at most this many issues are commented inline per merge request ... */
export const MAX_INLINE_THREADS = 50;
/** ... and, beside them, at most this many findings of the AI review (R18) ... */
export const MAX_AI_THREADS = 20;
/**
 * ... and at most this many threads are resolved or reopened by one job; the rest wait for the
 * branch's next decoration. With {@link REQUESTS_OUTSIDE_INLINE} and the creations this keeps a
 * job within its 400 requests (scm.md §4.3), so the summary is always written.
 */
export const MAX_THREAD_UPDATES = 200;
/**
 * The AI findings one job reads: the ones its threads may be for, and past them the ones the summary
 * lists and counts instead. A review stores at most 40 findings, and the findings placed on a head
 * are its reviews' (a head is reviewed again only when its merge base moved): this is more than a
 * head's findings come to.
 */
const AI_FINDINGS_READ = 200;
/**
 * The most requests a job makes besides creating, resolving and reopening threads: the project,
 * the user, the merge request, the commit status (a read, a post and its retry without the
 * pipeline), the summary, and every page of discussions and diffs it may read.
 */
export const REQUESTS_OUTSIDE_INLINE = 7 + MAX_DISCUSSION_PAGES + MAX_DIFF_PAGES;

export interface InlineContext {
  db: Db;
  client: GitLabClient;
  /** The GitLab project id. */
  ref: string;
  iid: string;
  /** The Qualor project: only threads of its own issues are touched (a monorepo, §5.3). */
  projectId: string;
  branchId: string;
  mr: GitLabMergeRequest;
  discussions: readonly GitLabDiscussion[];
  /** False when the page bound cut the discussions: a thread may exist unseen (§4.3). */
  discussionsComplete: boolean;
  botId: number;
  issueUrl: (issueId: string) => string | null;
  /**
   * Whether the analyzers' threads are reconciled: only when the report's line numbers are the
   * merge request's (§5.4: not for a merged-results pipeline, nor for a revision the merge request
   * has moved past). The AI review's threads are in every decoration: their lines are those of the
   * head the review read, and they are created only while the merge request is at it.
   */
  analyzers: boolean;
  /** {@link MAX_THREAD_UPDATES} unless a test sets a smaller one. */
  maxThreadUpdates?: number;
}

export interface InlineResult {
  /** Open issues with a Qualor discussion after this run. */
  commented: number;
  /** Desired issues the diff has no place for. */
  unplaced: number;
}

/**
 * What a GitLab reconciliation did of the analyzers' threads (`commented` and `unplaced` count
 * theirs only) and of the AI review's.
 */
export interface InlineReconciled extends InlineResult {
  /**
   * The AI findings with no thread that got none this time, most severe first, which the summary
   * lists instead: the merge request moved on from the head the review read, they were past
   * {@link MAX_AI_THREADS}, or the diff or GitLab had no place for them. Only findings of the
   * severities that get a thread for themselves: a low one is counted, never listed. Empty when
   * the discussions were cut by the page bound: a thread of any of them may exist unseen.
   */
  aiNotPosted: DesiredAiIssue[];
}

/** The added lines of a unified diff (`+` lines of its hunks), by line number in the new file. */
export function addedLines(diff: string): Set<number> {
  return new Set(addedLineTexts(diff).keys());
}

/**
 * The added lines of a unified diff (GitLab's `diff`, GitHub's `patch`): new line number → text
 * without the `+` (and without a `\r` the diff kept). Context lines (a space, or an empty line)
 * count in the new file; removed lines and `\ No newline at end of file` do not.
 */
export function addedLineTexts(diff: string): Map<number, string> {
  const added = new Map<number, string>();
  let line = 0;
  for (const raw of diff.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (line === 0 || text.startsWith('\\')) continue;
    if (text.startsWith('+')) {
      added.set(line, text.slice(1));
      line += 1;
    } else if (text.startsWith(' ') || text === '') {
      line += 1;
    }
  }
  return added;
}

interface OwnThread {
  id: string;
  /** Every resolvable note is resolved (GitLab's `resolved` of the discussion). */
  resolved: boolean;
  /** Resolved, and every resolvable note by Qualor's own user (ruling G3). */
  resolvedByQualor: boolean;
  /** A person (not Qualor's user, not GitLab) wrote in the thread after Qualor's note. */
  humanReplied: boolean;
}

/**
 * Qualor's inline discussions by issue id (scm.md §5.3): the first note is by the token's user and
 * starts with an issue marker. A second thread of one issue (never created by Qualor) is ignored.
 */
function ownThreads(discussions: readonly GitLabDiscussion[], botId: number) {
  const threads = new Map<string, OwnThread>();
  for (const discussion of discussions) {
    const [first, ...replies] = discussion.notes;
    if (!first || first.author.id !== botId || first.system) continue;
    const marker = markerOf(first.body);
    if (marker?.kind !== 'issue' || threads.has(marker.issueId)) continue;
    const resolvable = discussion.notes.filter((n) => n.resolvable === true);
    const resolved = resolvable.length > 0 && resolvable.every((n) => n.resolved === true);
    threads.set(marker.issueId, {
      id: discussion.id,
      resolved,
      resolvedByQualor: resolved && resolvable.every((n) => n.resolved_by?.id === botId),
      humanReplied: replies.some((n) => !n.system && n.author.id !== botId),
    });
  }
  return threads;
}

/**
 * Resolves or reopens one thread; false when GitLab no longer has it (a person deleted it after
 * the listing): like a rejected position, that thread is skipped and the job goes on.
 */
async function setResolved(ctx: InlineContext, id: string, resolved: boolean): Promise<boolean> {
  try {
    await ctx.client.resolveDiscussion(ctx.ref, ctx.iid, id, resolved);
    return true;
  } catch (err) {
    if (err instanceof GitLabError && err.kind === 'not_found') return false;
    throw err;
  }
}

interface AiThreads {
  /** The head commit of the branch's newest finished review: the line numbers are its. */
  head: string;
  /** Its findings that have no thread, in their order. */
  waiting: DesiredAiIssue[];
  /** The ones of them a thread is created for now. */
  create: DesiredAiIssue[];
}

/**
 * The findings of the branch's newest finished AI review that have no thread (null without such a
 * review), and the ones a thread is created for now: the {@link MAX_AI_THREADS} most severe, only
 * while the merge request is at the head that review read. A merge request that moved on gets none:
 * their lines are the numbers of the reviewed head.
 */
async function aiThreads(
  ctx: InlineContext,
  threads: ReadonlyMap<string, OwnThread>,
): Promise<AiThreads | null> {
  const head = await newestReviewedHead(ctx.db, ctx.branchId);
  if (head === null) return null;
  const desired = await desiredAiIssues(ctx.db, ctx.branchId, head, AI_FINDINGS_READ);
  const waiting = desired.filter((issue) => !threads.has(issue.id));
  const live = ctx.mr.diff_refs?.head_sha ?? null;
  if (live === null || live.toLowerCase() !== head.toLowerCase()) {
    return { head, waiting, create: [] };
  }
  const top = new Set(desired.slice(0, MAX_AI_THREADS));
  return { head, waiting, create: waiting.filter((issue) => top.has(issue)) };
}

/**
 * The finding's suggestion when it still applies to GitLab's diff (`added`, of its file): its block
 * starts on the line the thread sits on, and it replaces added lines whose text is the one the
 * review read. Else null, and the thread is posted without it.
 */
async function liveSuggestion(
  ctx: InlineContext,
  head: string,
  issue: DesiredAiIssue,
  added: ReadonlyMap<number, string>,
): Promise<ReviewSuggestion | null> {
  const s = issue.suggestion;
  if (s === null || s.startLine !== issue.anchorLine) return null;
  const reviewed = await reviewedLines(
    ctx.db,
    ctx.branchId,
    head,
    issue.path,
    s.startLine,
    s.endLine,
  );
  return suggestionApplies(s, added, reviewed) ? s : null;
}

/**
 * scm.md §5.4: reconciles Qualor's inline discussions with the branch's open new issues and the
 * findings of its AI review. For the threads of this project's issues (the analyzers' only when
 * `analyzers`, the AI review's always):
 * - an open issue whose thread Qualor resolved gets it reopened; one a person resolved stays so;
 * - an issue that is no longer open gets its thread resolved, unless a person replied in it;
 * - a thread of an issue this project does not have (another Qualor project of a monorepo, or an
 *   issue since deleted) is left alone.
 * Then, unless the discussions were cut by the page bound, each of the (at most
 * {@link MAX_INLINE_THREADS}) most severe open new issues without a thread gets one when the diff
 * has a place for it, and so, beside them, does each of the (at most {@link MAX_AI_THREADS}) AI
 * findings the newest finished review placed on the head the merge request is at: a thread on its
 * anchor, with its suggestion while that still applies to the diff. A low finding is commented for
 * its suggestion only. Threads are never deleted, and notes written by anyone else are never
 * touched.
 */
export async function reconcileInline(ctx: InlineContext): Promise<InlineReconciled> {
  const threads = ownThreads(ctx.discussions, ctx.botId);
  const threadIssues = [...threads.keys()];
  const known =
    threadIssues.length === 0
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
          .where(and(inArray(issues.id, threadIssues), eq(issues.projectId, ctx.projectId)));
  const maxUpdates = ctx.maxThreadUpdates ?? MAX_THREAD_UPDATES;
  let commented = 0;
  let updates = 0;
  for (const issue of known) {
    const thread = threads.get(issue.id);
    if (!thread) continue;
    // An analyzer's thread follows the report's line numbers, an AI finding's the reviewed head.
    const reviewed = issue.engineId === AI_ENGINE;
    if (!reviewed && !ctx.analyzers) continue;
    const open =
      issue.branchId === ctx.branchId && issue.status === 'open' && issue.duplicateOf === null;
    let resolve: boolean | null = null;
    if (open && thread.resolvedByQualor) resolve = false;
    else if (!open && !thread.resolved && !thread.humanReplied) resolve = true;
    let exists = true;
    if (resolve !== null && updates < maxUpdates) {
      updates += 1;
      exists = await setResolved(ctx, thread.id, resolve);
    }
    // The summary counts the analyzers' threads; its AI section speaks for the review's own.
    if (open && exists && !reviewed) commented += 1;
  }

  // Beyond the page bound a thread may exist unseen: never create a second one (scm.md §4.3).
  if (!ctx.discussionsComplete) return { commented, unplaced: 0, aiNotPosted: [] };
  const missing = ctx.analyzers
    ? (await desiredInlineIssues(ctx.db, ctx.branchId, MAX_INLINE_THREADS)).filter(
        (issue) => !threads.has(issue.id),
      )
    : [];
  const ai = await aiThreads(ctx, threads);
  const toCreate = new Set(ai?.create ?? []);
  const notPosted = new Set((ai?.waiting ?? []).filter((issue) => !toCreate.has(issue)));
  // A low finding is posted for its suggestion only: one that is not is counted, never listed.
  const result = (unplaced: number): InlineReconciled => ({
    commented,
    unplaced,
    aiNotPosted: (ai?.waiting ?? []).filter(
      (issue) => notPosted.has(issue) && AI_THREAD_SEVERITIES.has(issue.severity),
    ),
  });
  if (missing.length === 0 && toCreate.size === 0) return result(0);
  // The position's SHAs are the merge request's own: a stale diff never gets a thread.
  const refs = ctx.mr.diff_refs;
  if (!refs?.base_sha || !refs.head_sha || !refs.start_sha) {
    for (const issue of toCreate) notPosted.add(issue);
    return result(missing.length);
  }
  const shas = { baseSha: refs.base_sha, startSha: refs.start_sha, headSha: refs.head_sha };
  // The diffs are read after the merge request: a push in between can make them newer than
  // `diff_refs`. GitLab then refuses the position (usually a 400), counted as not placed.
  const diffs = await ctx.client.mergeRequestDiffs(ctx.ref, ctx.iid, MAX_DIFF_PAGES);
  const byPath = new Map<string, { diff: GitLabDiff; added: Map<number, string> }>();
  for (const diff of diffs.items) {
    if (diff.deleted_file) continue;
    byPath.set(diff.new_path, { diff, added: addedLineTexts(diff.diff) });
  }
  const position = (diff: GitLabDiff, newLine: number) => ({
    ...shas,
    oldPath: diff.old_path,
    newPath: diff.new_path,
    newLine,
  });
  let unplaced = 0;
  for (const issue of missing) {
    const place = byPath.get(issue.path ?? '');
    if (!place || issue.line === null || !place.added.has(issue.line)) {
      unplaced += 1;
      continue;
    }
    const created = await ctx.client.createDiscussion(
      ctx.ref,
      ctx.iid,
      inlineBody({
        issueId: issue.id,
        severity: issue.severity as Severity,
        quality: issue.quality as Quality,
        ruleKey: issue.ruleKey,
        helpUri: issue.helpUri,
        message: issue.message,
        confidence: issue.confidence,
        url: ctx.issueUrl(issue.id),
      }),
      position(place.diff, issue.line),
    );
    if (created === 'position_rejected') unplaced += 1;
    else commented += 1;
  }
  for (const issue of toCreate) {
    const place = byPath.get(issue.path);
    const onDiff = place !== undefined && place.added.has(issue.anchorLine);
    const suggestion =
      place !== undefined && onDiff && ai !== null
        ? await liveSuggestion(ctx, ai.head, issue, place.added)
        : null;
    // Without a suggestion, a low finding is counted in the summary, as one that never had one is.
    if (suggestion === null && !AI_THREAD_SEVERITIES.has(issue.severity)) continue;
    if (place === undefined || !onDiff) {
      notPosted.add(issue);
      continue;
    }
    const created = await ctx.client.createDiscussion(
      ctx.ref,
      ctx.iid,
      aiThreadBody({
        provider: 'gitlab',
        issueId: issue.id,
        severity: issue.severity,
        category: issue.category,
        confidence: issue.confidence,
        ruleKey: issue.ruleKey,
        title: issue.title,
        body: issue.body,
        assumption: issue.assumption,
        verification: issue.verification,
        suggestion,
        issueUrl: ctx.issueUrl(issue.id),
      }),
      position(place.diff, issue.anchorLine),
    );
    if (created === 'position_rejected') notPosted.add(issue);
  }
  return result(unplaced);
}
