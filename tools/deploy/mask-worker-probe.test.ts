import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReviewMaskWorker } from '../../server/scripts/bundle';
import { MASK_WORKER_PROBE } from './checks';

/** The probe the smoke test runs in the server image, run here against a worker built as the image's. */
const dir = mkdtempSync(path.join(os.tmpdir(), 'qualor-mask-probe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function probe(file: string): { code: number | null; problems: string[] } {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', MASK_WORKER_PROBE, file], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, problems: JSON.parse(r.stdout || '["no output"]') as string[] };
}

describe('the review mask worker probe of the smoke test (6I-3)', () => {
  it('passes the worker the server build makes: it masks a token', async () => {
    // Built under server/, where the dependencies the bundle leaves external are found.
    const worker = fileURLToPath(
      new URL('../../server/.tmp/mask-worker-probe/review-mask-worker.js', import.meta.url),
    );
    await buildReviewMaskWorker({ outfile: worker });
    expect(probe(worker)).toEqual({ code: 0, problems: [] });
  }, 60_000);

  it('fails a worker that answers with the text as it was, or does not answer, or is not there', () => {
    const unmasked = path.join(dir, 'unmasked.mjs');
    writeFileSync(
      unmasked,
      `import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ ready: true });
parentPort.on('message', (job) => parentPort.postMessage({ id: job.id, text: job.text, count: 0 }));
`,
    );
    const result = probe(unmasked);
    expect(result.code).toBe(1);
    expect(result.problems).toEqual(['the secret was not masked', 'the count is 0, not 1']);

    const exits = path.join(dir, 'exits.mjs');
    writeFileSync(exits, 'process.exit(0);\n');
    expect(probe(exits)).toEqual({ code: 1, problems: ['the worker exited with code 0'] });

    const missing = probe(path.join(dir, 'missing.js'));
    expect(missing.code).toBe(1);
    expect(missing.problems).toHaveLength(1);
  });
});
