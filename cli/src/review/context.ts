import { z } from 'zod';
import { REVISION } from '../git/baseline';
import type { Logger } from '../log';
import { isMissingEndpoint } from '../server/baseline-client';
import {
  describeFailure,
  parseJson,
  request,
  type HttpResponse,
  type ServerEndpoint,
} from '../server/http';
import type { SnapshotInput } from './snapshot';

/** What the server says of a merge request's AI review before the scanner builds a snapshot. */
export interface ReviewContext {
  /** AI review runs for the project: the scanner uploads the merge request's snapshot. */
  review: boolean;
  /** Why not, when `review` is false (a `ReviewInactiveReason`, or one a newer server knows). */
  reason: string | null;
  /** The commit of this merge request the last review covered (a full commit id), else null. */
  lastReviewedCommit: string | null;
  /** The snapshot limits the server accepts. */
  limits: SnapshotInput['limits'];
}

/** A small JSON object; a proxy gone wrong never makes the scanner buffer megabytes. */
const MAX_CONTEXT_RESPONSE_BYTES = 16 * 1024;
/**
 * The most a server accepts inflated, whatever it says (it caps
 * QUALOR_REVIEW_SNAPSHOT_MAX_DECOMPRESSED_BYTES there): the snapshot's patches are held in memory
 * up to this budget.
 */
const MAX_INFLATED_BYTES = 500 * 1024 * 1024;

const size = z.number().int().positive();

/**
 * The server's answer. A field this scanner does not read is ignored, and so is a reason of another
 * shape than a code (it is shown in the log) or a last reviewed commit that is no string: without
 * it the whole merge request counts as changed (ruling R4).
 */
const answer = z.looseObject({
  review: z.boolean(),
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .nullable()
    .catch(null),
  lastReviewedCommit: z.string().nullable().catch(null),
  limits: z.looseObject({
    maxCompressedBytes: size,
    maxDecompressedBytes: size,
    maxFileBytes: size,
    maxFiles: size,
  }),
});

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `GET /api/v0/projects/review-context` (6I-2): whether the scanner sends the merge request's
 * repository snapshot, the last reviewed commit (ruling R4) and the snapshot limits. Null when it
 * cannot say, logged once: at debug level for a server without the route (one older than AI
 * review answers 404, or reads the path as a project id and answers 422 on `params.id`), at warn
 * level for any other answer, an invalid one or an unreachable server. Never throws; the token
 * never appears in a message (`request` masks it).
 */
export async function fetchReviewContext(
  ep: ServerEndpoint,
  q: { projectKey: string; mergeRequest: string },
  log: Logger,
): Promise<ReviewContext | null> {
  const none = 'so no repository snapshot is sent';
  let res: HttpResponse;
  try {
    res = await request(ep, {
      method: 'GET',
      path: 'api/v0/projects/review-context',
      query: { projectKey: q.projectKey, mergeRequest: q.mergeRequest },
      maxResponseBytes: MAX_CONTEXT_RESPONSE_BYTES,
    });
  } catch (err) {
    log.warn(
      `AI review: the server could not be asked whether it reviews (${message(err)}), ${none}`,
    );
    return null;
  }
  if (res.status !== 200) {
    if (isMissingEndpoint(res)) {
      log.debug(`AI review: the server has no review context (an older server), ${none}`);
    } else {
      log.warn(
        `AI review: the server did not say whether it reviews (${describeFailure(res)}), ${none}`,
      );
    }
    return null;
  }
  try {
    const body = parseJson(res, answer, 'review context');
    const since = body.lastReviewedCommit;
    return {
      review: body.review,
      reason: body.review ? null : body.reason,
      lastReviewedCommit: since !== null && REVISION.test(since) ? since : null,
      limits: {
        maxCompressedBytes: body.limits.maxCompressedBytes,
        maxDecompressedBytes: Math.min(body.limits.maxDecompressedBytes, MAX_INFLATED_BYTES),
        maxFileBytes: body.limits.maxFileBytes,
        maxFiles: body.limits.maxFiles,
      },
    };
  } catch (err) {
    log.warn(`AI review: ${message(err)}, ${none}`);
    return null;
  }
}
