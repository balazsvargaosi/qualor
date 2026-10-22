import { describe, expect, it } from 'vitest';
import { MAX_INLINE_THREADS } from '../inline';
import { MAX_GITHUB_REQUESTS, MAX_THREAD_PAGES } from './client';
import { MAX_COMMENT_PAGES, MAX_FILE_PAGES, REQUESTS_OUTSIDE_THREADS } from './decorate';
import { MAX_CREATION_REQUESTS, MAX_GITHUB_THREAD_UPDATES } from './threads';

describe('the request budget (github.md §5.3, ruling R7)', () => {
  it('is 320 requests a job', () => {
    expect(MAX_GITHUB_REQUESTS).toBe(320);
  });

  it('leaves room for every request of a job that reads and writes as much as it may', () => {
    // The App, the installation, its token, the repository and the pull request.
    const setup = 5;
    // The check run's listing and its one write, written before the threads with the counts the
    // plan gives, and the PATCH that corrects them when applying the plan changed them.
    const checkRun = 3;
    // The summary's one write.
    const summary = 1;
    // A 401 on an installation token: the new token, and the request made again.
    const tokenRefresh = 2;
    // The new threads: one review holds them all; after a 422 each is posted alone.
    const creations = 1 + MAX_INLINE_THREADS;
    const sum =
      setup +
      MAX_FILE_PAGES +
      MAX_COMMENT_PAGES + // the pull request's review comments
      MAX_THREAD_PAGES +
      creations +
      MAX_GITHUB_THREAD_UPDATES + // resolutions and reopenings
      checkRun +
      MAX_COMMENT_PAGES + // the issue comments that hold the summary
      summary +
      tokenRefresh;
    // Pinned apart from the constants, so a bound raised on its own fails here.
    expect([
      MAX_FILE_PAGES,
      MAX_COMMENT_PAGES,
      MAX_THREAD_PAGES,
      MAX_INLINE_THREADS,
      MAX_GITHUB_THREAD_UPDATES,
    ]).toEqual([30, 50, 10, 50, 100]);
    expect(MAX_CREATION_REQUESTS).toBe(creations);
    expect(REQUESTS_OUTSIDE_THREADS + MAX_CREATION_REQUESTS + MAX_GITHUB_THREAD_UPDATES).toBe(sum);
    expect(sum).toBe(302);
    // Below the budget, so the check run and the summary are written whatever else the job did.
    expect(sum).toBeLessThan(MAX_GITHUB_REQUESTS);
  });
});
