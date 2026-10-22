import { parentPort } from 'node:worker_threads';
import { redactLongText } from '@qualor/shared';

/*
 * The entry of the worker thread of a Masker (masker.ts): it masks the texts it is sent, one at a
 * time, with the shared redaction, and sends each back. Masking a hostile text can take minutes, so
 * it is done here and not on the thread that serves requests; the Masker stops this thread when a
 * text takes too long. The server bundle builds this file as its own entry
 * (`dist/review-mask-worker.js`, server/scripts/bundle.ts).
 */

/** A text to mask, and the answer to it (`id` is the job's own). */
export interface MaskJob {
  id: number;
  text: string;
}
export interface MaskAnswer {
  id: number;
  text: string;
  count: number;
}
/** The first message of the worker: its code is loaded and it takes jobs. */
export interface MaskReady {
  ready: true;
}

if (parentPort === null) throw new Error('mask-worker is the entry of a worker thread');
const port = parentPort;
port.on('message', (job: MaskJob) => {
  const masked = redactLongText(job.text);
  const answer: MaskAnswer = { id: job.id, text: masked.text, count: masked.count };
  port.postMessage(answer);
});
const ready: MaskReady = { ready: true };
port.postMessage(ready);
