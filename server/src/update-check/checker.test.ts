import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUpdateChecker,
  updateCheckerFor,
  UPDATE_CHECK_FIRST_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
} from './checker';
import type { FetchOutcome } from './fetch-latest';

function setup(outcomes: FetchOutcome[], currentVersion = '0.7.1') {
  const fetchLatest = vi.fn<(url: string) => Promise<FetchOutcome>>(
    async () => outcomes.shift() ?? { ok: false, reason: 'none' },
  );
  const logger = { info: vi.fn(), debug: vi.fn() };
  const checker = createUpdateChecker({
    url: 'http://hub.test/tags',
    currentVersion,
    logger,
    fetchLatest,
  });
  return { checker, fetchLatest, logger };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createUpdateChecker', () => {
  it('first checks after 60 s, then every 24 h, and stops', async () => {
    const { checker, fetchLatest } = setup([]);
    checker.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_FIRST_DELAY_MS - 1);
    expect(fetchLatest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchLatest).toHaveBeenCalledWith('http://hub.test/tags');
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    checker.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('reports a newer version and logs each new one once', async () => {
    const { checker, logger } = setup([
      { ok: true, latest: '0.8.0' },
      { ok: true, latest: '0.8.0' },
      { ok: true, latest: '0.9.0' },
    ]);
    expect(checker.latest()).toBeNull();
    await checker.checkNow();
    expect(checker.latest()).toBe('0.8.0');
    await checker.checkNow();
    await checker.checkNow();
    expect(checker.latest()).toBe('0.9.0');
    expect(logger.info.mock.calls.map((c) => c[1])).toEqual([
      'Qualor 0.8.0 is available (this server runs 0.7.1): https://github.com/qualor-dev/qualor/releases/tag/v0.8.0',
      'Qualor 0.9.0 is available (this server runs 0.7.1): https://github.com/qualor-dev/qualor/releases/tag/v0.9.0',
    ]);
  });

  it.each([
    ['the same version', '0.7.1'],
    ['an older version', '0.6.0'],
  ])('says nothing for %s', async (_what, latest) => {
    const { checker, logger } = setup([{ ok: true, latest }]);
    await checker.checkNow();
    expect(checker.latest()).toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('says nothing to a dev build newer than every tag', async () => {
    const { checker, logger } = setup([{ ok: true, latest: '0.8.0' }], '0.9.0-dev');
    await checker.checkNow();
    expect(checker.latest()).toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('keeps the last result after a failure and logs it at debug level only', async () => {
    const { checker, logger } = setup([
      { ok: true, latest: '0.8.0' },
      { ok: false, reason: 'HTTP 429' },
    ]);
    await checker.checkNow();
    await checker.checkNow();
    expect(checker.latest()).toBe('0.8.0');
    expect(logger.debug).toHaveBeenCalledWith(
      { component: 'update-check', reason: 'HTTP 429' },
      'update check failed',
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('survives a fetch that throws', async () => {
    const logger = { info: vi.fn(), debug: vi.fn() };
    const checker = createUpdateChecker({
      url: 'http://hub.test/tags',
      currentVersion: '0.7.1',
      logger,
      fetchLatest: () => Promise.reject(new TypeError('boom')),
    });
    await expect(checker.checkNow()).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      { component: 'update-check', reason: 'TypeError' },
      'update check failed',
    );
  });
});

describe('updateCheckerFor (telemetry.md "Update check")', () => {
  const logger = { info: () => undefined, debug: () => undefined };
  const config = (enabled: boolean) => ({
    telemetry: { enabled, url: 'http://127.0.0.1:9/t' },
    updateCheck: { url: 'http://hub.test/tags' },
  });

  it('creates no checker while telemetry is off, so Docker Hub is never asked', () => {
    expect(updateCheckerFor(config(false), { currentVersion: '0.7.1', logger })).toBeUndefined();
  });

  it('creates a checker for the configured URL while telemetry is on', async () => {
    const fetchLatest = vi.fn<(url: string) => Promise<FetchOutcome>>(async () => ({
      ok: true,
      latest: '0.8.0',
    }));
    const checker = updateCheckerFor(config(true), {
      currentVersion: '0.7.1',
      logger,
      fetchLatest,
    });
    await checker?.checkNow();
    expect(fetchLatest).toHaveBeenCalledWith('http://hub.test/tags');
    expect(checker?.latest()).toBe('0.8.0');
  });
});
