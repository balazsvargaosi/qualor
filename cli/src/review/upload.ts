import { createReadStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { REVIEW_SNAPSHOT_CONTENT_TYPE } from '@qualor/shared';
import type { Logger } from '../log';
import { describeFailure, pathSegment, request, type ServerEndpoint } from '../server/http';
import { busyRetryDelay } from '../server/upload';

export interface ReviewSnapshotUpload {
  /** The analysis of the report just uploaded. */
  analysisId: string;
  projectKey: string;
  /** The gzip'd snapshot on disk (`buildReviewSnapshot`). */
  file: string;
  size: number;
}

/**
 * `POST /api/v0/analyses/{id}/review-snapshot?projectKey=` (6I-2): the merge request's repository
 * snapshot, streamed from disk as the report is (`Content-Length` and `Expect: 100-continue`, so a
 * refusal comes before a byte of the body is sent), and 503 `UPLOADS_BUSY` retried as the report's
 * upload retries it (ruling E5). `refused` for any other answer than 202 (AI review switched off
 * meanwhile, a snapshot already there, over the limits, …), said in one warning that names it.
 * Throws when the server cannot be reached; the token never appears in a message.
 */
export async function uploadReviewSnapshot(
  ep: ServerEndpoint,
  input: ReviewSnapshotUpload,
  o: { log: Logger; wait?: (ms: number) => Promise<unknown> },
): Promise<'uploaded' | 'refused'> {
  const wait = o.wait ?? ((ms: number) => sleep(ms));
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await request(ep, {
      method: 'POST',
      path: `api/v0/analyses/${pathSegment(input.analysisId)}/review-snapshot`,
      query: { projectKey: input.projectKey },
      headers: { 'content-type': REVIEW_SNAPSHOT_CONTENT_TYPE, 'content-encoding': 'gzip' },
      body: { stream: () => createReadStream(input.file), contentLength: input.size },
    });
    if (res.status === 202) return 'uploaded';
    const delay = busyRetryDelay(res, attempt, waited);
    if (delay !== null) {
      o.log.info(
        `AI review: the server is busy with other uploads; retrying the snapshot in ${delay / 1000} s`,
      );
      waited += delay;
      await wait(delay);
      continue;
    }
    o.log.warn(
      `AI review: no snapshot sent, the server refused it (${describeFailure(res)}; ${input.size} bytes gzipped)`,
    );
    return 'refused';
  }
}
