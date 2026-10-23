import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Masker, type MaskerOptions } from './masker';

/*
 * What the masker does with a worker that does not behave: workers played by a script, in place of
 * the thread, so that the order of things that no real thread repeats on demand is the test's.
 */

interface FakeJob {
  id: number;
  text: string;
}
interface FakeWorker {
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): FakeWorker;
  /** The thread: given the worker when it is created, and the job when it is sent one. */
  behave: (worker: FakeWorker) => void;
  terminated: boolean;
}

const fakes = vi.hoisted(() => ({
  /** The behaviour of each worker the masker creates, in turn; a worker past the list is sound. */
  script: [] as ((worker: FakeWorker) => void)[],
  created: [] as FakeWorker[],
}));

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    terminated = false;
    behave: (worker: FakeWorker) => void;
    constructor() {
      super();
      this.behave = fakes.script.shift() ?? sound;
      fakes.created.push(this as unknown as FakeWorker);
      // The thread starts once the masker has its listeners on the worker.
      queueMicrotask(() => this.behave(this as unknown as FakeWorker));
    }
    postMessage(job: FakeJob): void {
      this.emit('job', job);
    }
    unref(): void {}
    terminate(): Promise<number> {
      this.terminated = true;
      return Promise.resolve().then(() => {
        this.emit('exit', 1);
        return 1;
      });
    }
  }
  /** A worker that loads, and answers each text with the text in capitals. */
  function sound(worker: FakeWorker): void {
    worker.emit('message', { ready: true });
    worker.on('job', (job) => {
      const { id, text } = job as FakeJob;
      worker.emit('message', { id, text: text.toUpperCase(), count: 1 });
    });
  }
  return { Worker };
});

const made: Masker[] = [];
const maskerOf = (options: MaskerOptions = {}): Masker => {
  const masker = new Masker(options);
  made.push(masker);
  return masker;
};

beforeEach(async () => {
  await Promise.all(made.splice(0).map((masker) => masker.close()));
  fakes.script.length = 0;
  fakes.created.length = 0;
});

/** A worker that loads and then does as `onJob` says with each text. */
const loads =
  (onJob: (worker: FakeWorker, job: FakeJob) => void) =>
  (worker: FakeWorker): void => {
    worker.emit('message', { ready: true });
    worker.on('job', (job) => onJob(worker, job as FakeJob));
  };
/** A worker that loads and is gone before the masker can send it a text. */
const diesAtOnce = (worker: FakeWorker): void => {
  worker.emit('message', { ready: true });
  worker.emit('exit', 1);
};

describe('an answer that is not for the text being masked', () => {
  it('is ignored: the answer is the one with the id of the text', async () => {
    fakes.script.push(
      loads((worker, { id, text }) => {
        worker.emit('message', { id: id + 1_000, text: 'AN ANSWER FOR NOTHING', count: 9 });
        worker.emit('message', { id: id - 1, text: 'AN ANSWER FOR THE LAST TEXT', count: 9 });
        worker.emit('message', { id, text: text.toUpperCase(), count: 1 });
      }),
    );
    const masker = maskerOf();
    expect(await masker.mask('abc')).toEqual({ kind: 'masked', text: 'ABC', count: 1 });
    expect(await masker.mask('def')).toEqual({ kind: 'masked', text: 'DEF', count: 1 });
    expect(masker.workersStarted).toBe(1);
  });

  it('is not an answer: a text that only gets answers for others times out', async () => {
    fakes.script.push(
      loads((worker, { id }) => {
        worker.emit('message', { id: id + 1, text: 'AN ANSWER FOR NOTHING', count: 9 });
      }),
    );
    const masker = maskerOf({ timeoutMs: 100 });
    expect(await masker.mask('abc')).toEqual({ kind: 'timeout' });
    expect(fakes.created[0]?.terminated).toBe(true);
  });

  it('is ignored when no text is being masked', async () => {
    fakes.script.push(
      loads((worker, { id, text }) => {
        worker.emit('message', { id, text: text.toUpperCase(), count: 1 });
        // The same answer again, after the text is done with.
        worker.emit('message', { id, text: 'A SECOND ANSWER', count: 2 });
      }),
    );
    const masker = maskerOf();
    expect(await masker.mask('abc')).toEqual({ kind: 'masked', text: 'ABC', count: 1 });
    expect(await masker.mask('def')).toEqual({ kind: 'masked', text: 'DEF', count: 1 });
  });
});

describe('a worker that failed before it was sent a text', () => {
  it('has the text given to another worker, once', async () => {
    fakes.script.push(diesAtOnce);
    const masker = maskerOf();
    expect(await masker.mask('abc')).toEqual({ kind: 'masked', text: 'ABC', count: 1 });
    expect(masker.workersStarted).toBe(2);
  });

  it('does not blame the text, or go on for ever, when the second worker fails too', async () => {
    fakes.script.push(diesAtOnce, diesAtOnce);
    const masker = maskerOf();
    expect(await masker.mask('abc')).toEqual({ kind: 'timeout' });
    expect(masker.workersStarted).toBe(2);
    // The next text has a worker of its own, which is sound.
    expect(await masker.mask('def')).toEqual({ kind: 'masked', text: 'DEF', count: 1 });
    expect(masker.workersStarted).toBe(3);
  });

  it('is not a retry for a worker that failed on the text: that text is given up', async () => {
    fakes.script.push(
      loads((worker) => {
        worker.emit('exit', 1);
      }),
    );
    const masker = maskerOf();
    expect(await masker.mask('abc')).toEqual({ kind: 'timeout' });
    expect(masker.workersStarted).toBe(1);
  });
});
