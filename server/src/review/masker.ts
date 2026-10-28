import { Worker } from 'node:worker_threads';
import type { MaskAnswer, MaskJob, MaskReady } from './mask-worker';

/*
 * The server's masking of text for a review. The shared redaction (redactLongText) is synchronous
 * work whose time depends on the text: a hostile file of 1 MiB takes it seconds to minutes, and
 * running it on the thread that serves requests would stop the server for that long. So a Masker
 * runs it in a worker thread (mask-worker.ts), one text at a time, and the server only waits for
 * the answer. A text that takes longer than MASK_TIMEOUT_MS is given up: the worker is stopped,
 * a fresh one takes the next text, and the text is not shown (fail closed). A review has a budget
 * of wall time to spend masking, MASK_BUDGET_MS, all its texts together; once it is spent no text
 * is masked. One Masker is made for a review and closed at its end.
 */

/** The longest one text may take to mask. */
export const MASK_TIMEOUT_MS = 5_000;
/** The wall time one review may spend masking, all its texts together. */
export const MASK_BUDGET_MS = 90_000;
/** How long a worker may be idle before it is stopped; the next text starts a new one. */
const IDLE_MS = 10_000;
/** The longest a worker may take to load its code. */
const START_MS = 30_000;
/** The heap a worker may use: one that needs more is given up like one that takes too long. */
const WORKER_HEAP_MB = 512;

export type MaskResult =
  | { kind: 'masked'; text: string; count: number }
  /**
   * The text could not be masked: it took longer than MASK_TIMEOUT_MS, or the worker gave out on it
   * (out of memory, a crash). It is not to be shown.
   */
  | { kind: 'timeout' }
  /** The review has spent the wall time it may spend masking, or this text would have passed it. */
  | { kind: 'budget' };

export interface MaskerOptions {
  /** The longest one text may take (MASK_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The wall time the texts may take together (MASK_BUDGET_MS). */
  budgetMs?: number;
  /** A signal that ends the review's run: the texts waiting are given up and the one running stops. */
  signal?: AbortSignal;
  /** How long a worker may be idle before it is stopped (IDLE_MS). */
  idleMs?: number;
  /** The heap a worker may use, in MiB (WORKER_HEAP_MB). */
  workerHeapMb?: number;
  /** The code of the worker, for a test of how the masker deals with a worker that fails. */
  workerUrl?: URL;
}

/** What came of a job on a worker. */
type Outcome =
  | { kind: 'done'; text: string; count: number }
  | { kind: 'timeout' }
  | { kind: 'failed' }
  | { kind: 'interrupted'; reason: unknown };

interface Live {
  worker: Worker;
  /** Settles when the worker has loaded its code, or when it cannot. */
  ready: Promise<void>;
  /** Gives up waiting for the worker to load its code (nothing, once it has). */
  abandon: (reason: unknown) => void;
  /** The job the worker is running, when it has one: its id, and what is given its outcome. */
  running: { id: number; settle: (outcome: Outcome) => void } | null;
  /** The worker is stopped or has failed: it takes no more jobs. */
  ended: boolean;
}

interface Waiting {
  text: string;
  resolve: (result: MaskResult) => void;
  reject: (reason: unknown) => void;
}

/**
 * Where the worker's code is, and the options of node it starts with. The server runs from its
 * bundle (`dist/main.js`), next to which the build puts the worker's own
 * (`dist/review-mask-worker.js`); from source (tests, `tsx`) the worker is the TypeScript file,
 * which the worker thread loads through tsx. The worker does not take the options of the process
 * that starts it (a process run with `--eval` has options a worker cannot start with), only the
 * one that maps the stack traces of the bundle.
 */
function workerEntry(): { url: URL; execArgv: string[] } {
  if (import.meta.url.endsWith('.ts')) {
    return { url: new URL('./mask-worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
  }
  return {
    url: new URL('./review-mask-worker.js', import.meta.url),
    execArgv: process.execArgv.filter((option) => option === '--enable-source-maps'),
  };
}

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
};

/**
 * What a masker rejects with once it is closed: no text is masked after it. A masker whose signal
 * aborted rejects with the reason of the signal instead.
 */
export class MaskerClosed extends Error {
  constructor() {
    super('the masker is closed');
    this.name = 'MaskerClosed';
  }
}

export class Masker {
  private readonly timeoutMs: number;
  private readonly budgetMs: number;
  private readonly idleMs: number;
  private readonly heapMb: number;
  private readonly workerUrl: URL | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly queue: Waiting[] = [];
  private live: Live | null = null;
  private pumping = false;
  private closed = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private nextId = 0;
  private spent = 0;
  private started = 0;
  private exited = 0;
  private readonly onAbort = () => {
    void this.stop(this.signal?.reason ?? new Error('aborted'));
  };

  constructor(options: MaskerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? MASK_TIMEOUT_MS;
    this.budgetMs = options.budgetMs ?? MASK_BUDGET_MS;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.heapMb = options.workerHeapMb ?? WORKER_HEAP_MB;
    this.workerUrl = options.workerUrl;
    this.signal = options.signal;
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  /** Milliseconds of wall time the masking has taken so far, the texts that timed out included. */
  get spentMs(): number {
    return this.spent;
  }

  /** How many workers have been started: one, and another for each one given up on or idle. */
  get workersStarted(): number {
    return this.started;
  }

  /** How many workers are running now: those started, and not yet stopped. */
  get workersRunning(): number {
    return this.started - this.exited;
  }

  /** The review has spent the wall time it may spend masking: no text is masked now. */
  get exhausted(): boolean {
    return this.budgetMs - this.spent <= 0;
  }

  /**
   * Masks `text` with the shared redaction (redactLongText). The texts are masked one after the
   * other, in the order they are asked for; the time one waits for its turn is nobody's. Rejects
   * when the masker is closed or its signal aborts, and when the worker cannot be started.
   */
  mask(text: string): Promise<MaskResult> {
    if (this.closed || this.signal?.aborted === true) return Promise.reject(this.closedReason());
    return new Promise<MaskResult>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      void this.pump();
    });
  }

  /** Stops the worker and gives up the texts waiting: nothing is masked after this. */
  async close(): Promise<void> {
    await this.stop(new MaskerClosed());
  }

  private closedReason(): unknown {
    if (this.signal?.aborted === true) return this.signal.reason ?? new Error('aborted');
    return new MaskerClosed();
  }

  private async stop(reason: unknown): Promise<void> {
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    clearTimeout(this.idleTimer);
    for (const waiting of this.queue.splice(0)) waiting.reject(reason);
    const live = this.live;
    this.live = null;
    if (live === null) return;
    live.ended = true;
    live.abandon(reason);
    live.running?.settle({ kind: 'interrupted', reason });
    await live.worker.terminate();
  }

  /** The texts in the queue, masked one at a time; a pump runs whenever the queue is not empty. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let waiting = this.queue.shift(); waiting !== undefined; waiting = this.queue.shift()) {
        clearTimeout(this.idleTimer);
        const left = this.budgetMs - this.spent;
        if (left <= 0) {
          waiting.resolve({ kind: 'budget' });
          continue;
        }
        try {
          waiting.resolve(await this.maskOne(waiting.text, left));
        } catch (error) {
          waiting.reject(error);
        }
      }
    } finally {
      this.pumping = false;
      if (!this.closed) this.idleTimer = this.idleTimerOfWorker();
    }
  }

  /** Stops the worker if no text comes for IDLE_MS; the next text starts a new one. */
  private idleTimerOfWorker(): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const live = this.live;
      this.live = null;
      if (live !== null) this.end(live);
    }, this.idleMs);
    timer.unref();
    return timer;
  }

  /**
   * Masks one text on a worker, within the time it has: `left` of the budget, and the timeout. The
   * start of a worker after the first is charged to the budget. A
   * worker that failed after it loaded its code and before it was sent the text did nothing with
   * the text: the text is given to another, once, before it is blamed.
   */
  private async maskOne(text: string, left: number): Promise<MaskResult> {
    let timeLeft = left;
    for (let attempt = 0; ; attempt += 1) {
      // A worker started after the first (one given up on, or one that stood idle) loads its code
      // before it masks: that wall time is the review's, as the masking is.
      const restart = this.started > 0 && (this.live === null || this.live.ended);
      const began = performance.now();
      const live = await this.liveWorker();
      if (this.closed) throw this.closedReason();
      if (restart) {
        this.spent += performance.now() - began;
        timeLeft = this.budgetMs - this.spent;
        if (timeLeft <= 0) return { kind: 'budget' };
      }
      if (!live.ended) return this.maskOn(live, text, timeLeft);
      if (attempt > 0) return { kind: 'timeout' };
    }
  }

  /** Sends the text to the worker, and waits for its answer, for the time `left` and the timeout. */
  private async maskOn(live: Live, text: string, left: number): Promise<MaskResult> {
    const limit = Math.min(this.timeoutMs, left);
    const started = performance.now();
    const outcome = await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => settle({ kind: 'timeout' }), limit);
      const settle = (result: Outcome) => {
        clearTimeout(timer);
        live.running = null;
        resolve(result);
      };
      this.nextId += 1;
      const job: MaskJob = { id: this.nextId, text };
      live.running = { id: job.id, settle };
      live.worker.postMessage(job);
    });
    // A text given up has taken the whole of its time, whatever a clock that fires early says.
    const took = performance.now() - started;
    this.spent += outcome.kind === 'timeout' ? Math.max(took, limit) : took;
    switch (outcome.kind) {
      case 'done':
        return { kind: 'masked', text: outcome.text, count: outcome.count };
      case 'interrupted':
        throw outcome.reason;
      case 'timeout':
      case 'failed':
        // The worker may be in the middle of the text: it is given up, and the next text gets a new one.
        if (this.live === live) this.live = null;
        this.end(live);
        // A text that passed the time the review had left is a spent budget, not a slow text.
        return {
          kind: outcome.kind === 'timeout' && left <= this.timeoutMs ? 'budget' : 'timeout',
        };
    }
  }

  private end(live: Live): void {
    live.ended = true;
    void live.worker.terminate();
  }

  /** The worker that takes the next text: the live one, or a new one that has loaded its code. */
  private async liveWorker(): Promise<Live> {
    let live = this.live;
    if (live === null || live.ended) {
      live = this.startWorker();
      this.live = live;
    }
    try {
      await live.ready;
    } catch (error) {
      if (this.live === live) this.live = null;
      this.end(live);
      throw error;
    }
    return live;
  }

  private startWorker(): Live {
    const { url, execArgv } =
      this.workerUrl === undefined ? workerEntry() : { url: this.workerUrl, execArgv: [] };
    const worker = new Worker(url, {
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb: this.heapMb },
    });
    this.started += 1;
    const { promise: ready, resolve: loaded, reject: failed } = Promise.withResolvers<void>();
    // Awaited by whoever needs the worker; if nobody does, a failure is not an unhandled rejection.
    ready.catch(() => undefined);
    const startTimer = setTimeout(
      () => failed(new Error('the mask worker did not start in time')),
      START_MS,
    );
    const live: Live = {
      worker,
      ready,
      abandon: (reason) => {
        clearTimeout(startTimer);
        failed(reason);
      },
      running: null,
      ended: false,
    };
    let isReady = false;
    worker.on('message', (message: MaskAnswer | MaskReady) => {
      if ('ready' in message) {
        isReady = true;
        clearTimeout(startTimer);
        loaded();
        return;
      }
      // An answer is for the job the worker is running, and for no other.
      if (live.running?.id !== message.id) return;
      live.running.settle({ kind: 'done', text: message.text, count: message.count });
    });
    const gone = (error: Error) => {
      clearTimeout(startTimer);
      live.ended = true;
      if (!isReady) failed(new Error(`the mask worker could not start: ${messageOf(error)}`));
      live.running?.settle({ kind: 'failed' });
    };
    worker.on('error', gone);
    worker.on('exit', (code) => {
      this.exited += 1;
      clearTimeout(startTimer);
      if (!live.ended) gone(new Error(`the mask worker exited with code ${code}`));
    });
    // A worker left over (a review that never closed its masker) must not keep the process alive.
    // After the listeners: a listener for messages takes hold of the event loop again.
    worker.unref();
    return live;
  }
}
