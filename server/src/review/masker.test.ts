import { redactLongText } from '@qualor/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { HOSTILE_TEXT as HOSTILE } from '../../test/review';
import { MASK_BUDGET_MS, MASK_TIMEOUT_MS, Masker, type MaskerOptions } from './masker';

const j = (...parts: string[]) => parts.join('');
/** Fakes the shared patterns know, built at run time so no scanner takes them for real ones. */
const GH = j('gh', 'p_', 'a1B2'.repeat(9));
const KEY_BEGIN = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
const KEY_END = j('-----END ', 'RSA PRIVATE KEY-----');
const keyLine = (i: number): string =>
  j('lQOYBF', String(i).padStart(4, '0'), 'Qm9ndXMga2V5IGJvZHk'.repeat(2));
const code = (n: number, tag: string): string[] =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const made: Masker[] = [];
function maskerOf(options: MaskerOptions = {}): Masker {
  const masker = new Masker(options);
  made.push(masker);
  return masker;
}
afterAll(async () => {
  await Promise.all(made.map((masker) => masker.close()));
});

/** The result of `work`, and how often a timer of the event loop fired while it ran. */
async function whileTicking<T>(
  work: Promise<T>,
): Promise<{ result: T; ticks: number; elapsed: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 10);
  const started = performance.now();
  try {
    const result = await work;
    return { result, ticks, elapsed: performance.now() - started };
  } finally {
    clearInterval(timer);
  }
}

/** A worker as a data: URL, to see what the masker does with one that does not do as it should. */
const dataWorker = (source: string) =>
  new URL(`data:text/javascript,${encodeURIComponent(source)}`);
const READY =
  "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ ready: true });";

describe('the masker masks as the shared redaction does, in a worker thread', () => {
  const corpus: Record<string, string> = {
    'plain code': `${code(50, 'a').join('\n')}\n`,
    'an empty text': '',
    'nothing but line ends': '\n\n\n',
    'carriage returns': 'one\r\ntwo\r\nthree',
    'characters outside the Basic Multilingual Plane': 'const smile = "😀";\n// 日本語\n',
    'a token in a line': `const t = "${GH}";\nother line\n`,
    'a YAML password': `name: app\n${j('password: ', 'hunter2', 'hunter2')}\nreplicas: 2\n`,
    'an environment token': `${j('API_TOKEN', '=', 'abcdefgh', '12345678')}\n`,
    'a private key': [
      'before',
      KEY_BEGIN,
      ...Array.from({ length: 30 }, (_, i) => keyLine(i)),
      KEY_END,
      'after',
      '',
    ].join('\n'),
    'a private key in a long file': [
      ...code(300, 'x'),
      KEY_BEGIN,
      ...Array.from({ length: 30 }, (_, i) => keyLine(i)),
      KEY_END,
      ...code(300, 'y'),
    ].join('\n'),
    'a private key with no end, at the end of the text': ['before', KEY_BEGIN, keyLine(1), ''].join(
      '\n',
    ),
    'a private key with no end, in a long file': [
      ...code(300, 'x'),
      KEY_BEGIN,
      keyLine(1),
      keyLine(2),
      '',
    ].join('\n'),
    'a token split over two lines': `const t = "${GH.slice(0, 16)}" +\n  "${GH.slice(16)}";\nok();\n`,
    'a token split over three lines': `t = [\n "${GH.slice(0, 10)}",\n "${GH.slice(10, 22)}",\n "${GH.slice(22)}",\n].join('');\n`,
    'a line too long to scan': `${'z'.repeat(70_000)}\nnext line\n`,
    'many lines with a token among them': (() => {
      const lines = code(6_000, 'line');
      lines[3_000] = `const token = "${GH}";`;
      return lines.join('\n');
    })(),
  };

  it('answers with the text and the count of redactLongText, for every kind of text', async () => {
    const masker = maskerOf();
    for (const [name, text] of Object.entries(corpus)) {
      const sync = redactLongText(text);
      expect(await masker.mask(text), name).toEqual({
        kind: 'masked',
        text: sync.text,
        count: sync.count,
      });
    }
    expect(masker.workersStarted).toBe(1);
  });

  it('masks the texts asked for together one after the other, each as it is', async () => {
    const masker = maskerOf();
    const texts = Object.values(corpus);
    const results = await Promise.all(texts.map((text) => masker.mask(text)));
    expect(results).toEqual(texts.map((text) => ({ kind: 'masked', ...redactLongText(text) })));
    expect(masker.workersStarted).toBe(1);
  });
});

describe('a text that takes too long', () => {
  it('is given up after its time, without stopping the thread that waits for it', async () => {
    const masker = maskerOf({ timeoutMs: 400 });
    // The worker has loaded its code before the clock of the text starts.
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    const { result, ticks, elapsed } = await whileTicking(masker.mask(HOSTILE));
    expect(result).toEqual({ kind: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(380);
    // Masking it takes the shared redaction seconds: the answer comes when the time is up.
    expect(elapsed).toBeLessThan(3_000);
    // A timer fired the whole time (every 10 ms, 40 times in 400 ms; stopped it would be once).
    expect(ticks).toBeGreaterThan(15);
  });

  it('is not masked again for the next text: a new worker takes it, and masks it as it should', async () => {
    const masker = maskerOf({ timeoutMs: 300 });
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    expect(masker.workersStarted).toBe(1);
    expect(await masker.mask(HOSTILE)).toEqual({ kind: 'timeout' });
    // The worker that was masking it is stopped, not left to go on for seconds.
    await expect.poll(() => masker.workersRunning).toBe(0);
    const text = `const t = "${GH}";\n`;
    const next = await masker.mask(text);
    expect(next).toEqual({ kind: 'masked', ...redactLongText(text) });
    expect(masker.workersStarted).toBe(2);
    expect(masker.workersRunning).toBe(1);
    // The worker that took the next text is the live one: it takes more.
    expect(await masker.mask('const b = 2;\n')).toMatchObject({ kind: 'masked' });
    expect(masker.workersStarted).toBe(2);
  });

  it('does not take the time a text waits for its turn from the text', async () => {
    const masker = maskerOf({ timeoutMs: 600 });
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    const [slow, quick] = await Promise.all([
      masker.mask(HOSTILE),
      // Waits for the hostile text for as long as its time, and is masked in its own.
      masker.mask(`const t = "${GH}";\n`),
    ]);
    expect(slow).toEqual({ kind: 'timeout' });
    expect(quick).toMatchObject({ kind: 'masked', count: 1 });
  });

  it('is given up when the worker dies on it, and the next text gets another worker', async () => {
    const crashing = dataWorker(`${READY} parentPort.on('message', () => process.exit(3));`);
    const masker = maskerOf({ workerUrl: crashing });
    expect(await masker.mask('anything')).toEqual({ kind: 'timeout' });
    expect(await masker.mask('anything else')).toEqual({ kind: 'timeout' });
    expect(masker.workersStarted).toBe(2);

    const throwing = dataWorker(
      `${READY} parentPort.on('message', () => { throw new Error('this text is the end of me'); });`,
    );
    const second = maskerOf({ workerUrl: throwing });
    expect(await second.mask('anything')).toEqual({ kind: 'timeout' });
    expect(await second.mask('anything else')).toEqual({ kind: 'timeout' });
    expect(second.workersStarted).toBe(2);
  });
});

describe('the time a review may spend masking', () => {
  it('is MASK_BUDGET_MS of wall time, and one text may take MASK_TIMEOUT_MS of it', () => {
    expect(MASK_TIMEOUT_MS).toBe(5_000);
    expect(MASK_BUDGET_MS).toBe(90_000);
  });

  it('is spent by the texts, the ones given up included, and nothing is masked once it is', async () => {
    const masker = maskerOf({ timeoutMs: 150, budgetMs: 400 });
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    // Each text that is too slow takes its 150 ms; the one that comes to the end of the budget is
    // not given 150 but what is left, and answers `budget`.
    const kinds: string[] = [];
    for (let i = 0; i < 10 && kinds.at(-1) !== 'budget'; i += 1) {
      kinds.push((await masker.mask(HOSTILE)).kind);
    }
    expect(kinds.at(-1)).toBe('budget');
    expect(kinds.slice(0, -1).length).toBeGreaterThanOrEqual(1);
    expect(kinds.slice(0, -1).every((kind) => kind === 'timeout')).toBe(true);
    expect(masker.spentMs).toBeGreaterThanOrEqual(400);
    // Once spent, no text is masked, and no worker is started for one.
    const workers = masker.workersStarted;
    for (const text of ['const a = 1;\n', '', HOSTILE]) {
      const answered = performance.now();
      expect(await masker.mask(text)).toEqual({ kind: 'budget' });
      expect(performance.now() - answered).toBeLessThan(200);
    }
    expect(masker.workersStarted).toBe(workers);
  });

  it('gives a text the time that is left of the budget, and not more', async () => {
    const masker = maskerOf({ timeoutMs: 5_000, budgetMs: 400 });
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    const started = performance.now();
    expect(await masker.mask(HOSTILE)).toEqual({ kind: 'budget' });
    const elapsed = performance.now() - started;
    // The 400 ms of the budget, not the 5 s one text may take: it needs 9 s.
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(2_500);
  });

  it('is not spent by a text that waits, nor by the loading of a worker', async () => {
    const masker = maskerOf({ budgetMs: 60_000 });
    await masker.mask('const a = 1;\n');
    // Texts that mask in a few milliseconds spend a few milliseconds of the budget.
    for (let i = 0; i < 20; i += 1) await masker.mask(`const t${i} = ${i};\n`);
    expect(masker.spentMs).toBeLessThan(2_000);
    const fresh = maskerOf({ budgetMs: 60_000 });
    await fresh.mask('const a = 1;\n');
    expect(fresh.spentMs).toBeLessThan(1_000);
  });
});

describe('a masker whose run is superseded', () => {
  it('masks nothing for a signal that is aborted already, and starts no worker', async () => {
    const controller = new AbortController();
    controller.abort(new Error('superseded'));
    const masker = maskerOf({ signal: controller.signal });
    await expect(masker.mask('const a = 1;\n')).rejects.toThrow('superseded');
    expect(masker.workersStarted).toBe(0);
  });

  it('masks no text after the signal aborts, and the ones before it were masked', async () => {
    const controller = new AbortController();
    const masker = maskerOf({ signal: controller.signal });
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    controller.abort(new Error('superseded'));
    await expect(masker.mask('const b = 2;\n')).rejects.toThrow('superseded');
    await expect(masker.mask('const c = 3;\n')).rejects.toThrow('superseded');
  });

  it('gives up the text it is masking and the ones waiting, as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const masker = maskerOf({ signal: controller.signal });
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    const running = masker.mask(HOSTILE);
    const waiting = [masker.mask('const b = 2;\n'), masker.mask('const c = 3;\n')];
    const outcomes = Promise.allSettled([running, ...waiting]);
    await sleep(100);
    const started = performance.now();
    controller.abort(new Error('superseded'));
    const settled = await outcomes;
    // The text that was running is not waited for, and none of them is masked.
    expect(performance.now() - started).toBeLessThan(1_500);
    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected');
      expect(outcome.status === 'rejected' && String(outcome.reason)).toContain('superseded');
    }
    // The worker is stopped, and the texts that waited did not start another.
    expect(masker.workersStarted).toBe(1);
    await expect.poll(() => masker.workersRunning).toBe(0);
  });

  it('gives up a text asked for while the worker is still loading its code', async () => {
    const controller = new AbortController();
    const masker = maskerOf({ signal: controller.signal });
    const pending = masker.mask('const a = 1;\n');
    controller.abort(new Error('superseded'));
    await expect(pending).rejects.toThrow('superseded');
  });
});

describe('closing a masker', () => {
  it('gives up the texts waiting and refuses the ones that come after', async () => {
    const masker = maskerOf();
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    const running = masker.mask(HOSTILE);
    const waiting = masker.mask('const b = 2;\n');
    const settled = Promise.allSettled([running, waiting]);
    await sleep(100);
    const started = performance.now();
    await masker.close();
    const outcomes = await settled;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    await expect(masker.mask('const c = 3;\n')).rejects.toThrow('closed');
    // The worker is stopped, and the text that waited did not start another.
    expect(masker.workersStarted).toBe(1);
    await expect.poll(() => masker.workersRunning).toBe(0);
    // Closing twice is closing.
    await masker.close();
  });
});

describe('the worker of a masker', () => {
  it('is stopped when it has been idle for the time allowed, and the next text starts another', async () => {
    const masker = maskerOf({ idleMs: 150 });
    expect(await masker.mask('const a = 1;\n')).toMatchObject({ kind: 'masked' });
    expect(masker.workersRunning).toBe(1);
    // It is stopped, not left to idle for good.
    await expect.poll(() => masker.workersRunning).toBe(0);
    const text = `const t = "${GH}";\n`;
    expect(await masker.mask(text)).toEqual({ kind: 'masked', ...redactLongText(text) });
    expect(masker.workersStarted).toBe(2);
    expect(masker.workersRunning).toBe(1);
    // Texts that follow one another keep it.
    for (let i = 0; i < 5; i += 1) await masker.mask(`const t${i} = ${i};\n`);
    expect(masker.workersStarted).toBe(2);
  });

  it('that cannot be started fails the text it was started for, and the next text tries again', async () => {
    const broken = dataWorker("throw new Error('no way');");
    const masker = maskerOf({ workerUrl: broken });
    await expect(masker.mask('const a = 1;\n')).rejects.toThrow(/could not start/);
    await expect(masker.mask('const b = 2;\n')).rejects.toThrow(/could not start/);
    expect(masker.workersStarted).toBe(2);
    // Texts asked for together each find the worker unable to start.
    const together = await Promise.allSettled([masker.mask('x'), masker.mask('y')]);
    expect(together.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);

    const silent = dataWorker('process.exit(0);');
    const exits = maskerOf({ workerUrl: silent });
    await expect(exits.mask('const a = 1;\n')).rejects.toThrow(/could not start/);
  });

  it('can be any worker that answers as this one does', async () => {
    const upper = dataWorker(
      `${READY} parentPort.on('message', (job) => parentPort.postMessage({ id: job.id, text: job.text.toUpperCase(), count: 7 }));`,
    );
    const masker = maskerOf({ workerUrl: upper });
    expect(await masker.mask('abc')).toEqual({ kind: 'masked', text: 'ABC', count: 7 });
  });
});
