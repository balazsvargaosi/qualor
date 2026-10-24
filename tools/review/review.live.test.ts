import { describe, expect, it } from 'vitest';
import { liveEnabled, readLiveEnv, runLive } from './review-live';

/**
 * Plan 6I-3 Task 14 (spec §12): the opt-in evaluation of the AI review against a real provider.
 * Never collected by `pnpm test` or CI: vitest.config.ts defines its project (`review-live`) only
 * when `QUALOR_LIVE_REVIEW_URL` and `QUALOR_LIVE_REVIEW_MODEL` are set, and only `pnpm review:live`
 * runs it, by hand. It sends the synthetic cases of fixtures/review-eval to that provider, with the
 * key of `QUALOR_LIVE_REVIEW_API_KEY` if there is one, and prints aggregates only. It writes to
 * stdout itself: vitest's reporters leave out the console of a test that passes.
 */
describe.skipIf(!liveEnabled(process.env))(
  'live: the AI review of the evaluation set against a real provider',
  () => {
    it('reviews the cases and prints aggregates only', async () => {
      const { report, text } = await runLive(readLiveEnv(process.env), (done, total) => {
        process.stdout.write(`reviewed ${done} of ${total}\n`);
      });
      // runLive has already refused a text that holds the key; the report holds no model text.
      process.stdout.write(`\n${text}\n`);
      expect(report.reviews).toBeGreaterThan(0);
    });
  },
);
