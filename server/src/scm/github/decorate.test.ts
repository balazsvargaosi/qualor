import { describe, expect, it } from 'vitest';
import { MAX_AI_THREADS, MAX_FIXED_NOTES, MAX_INLINE_THREADS } from '../inline';
import { MAX_GITHUB_REQUESTS, MAX_THREAD_PAGES } from './client';
import { MAX_COMMENT_PAGES, MAX_FILE_PAGES, REQUESTS_OUTSIDE_THREADS } from './decorate';
import { MAX_CREATION_REQUESTS, MAX_GITHUB_THREAD_UPDATES } from './threads';

describe('the request budget (github.md §5.3, ruling R7)', () => {
  it('is 350 requests a job', () => {
    expect(MAX_GITHUB_REQUESTS).toBe(350);
  });

  it('the GitHub request bounds sum to 342', () => {
    // The App, the installation, its token, the repository and the pull request.
    const setup = 5;
    // The check run's listing and its one write, written before the threads with the counts the
    // plan gives, and the PATCH that corrects them when applying the plan changed them.
    const checkRun = 3;
    // The summary's one write.
    const summary = 1;
    // A 401 on an installation token: the new token, and the request made again.
    const tokenRefresh = 2;
    // The new threads, the analyzers' and the AI review's beside them: one review holds them all;
    // after a 422 each is posted alone.
    const creations = 1 + MAX_INLINE_THREADS + MAX_AI_THREADS;
    const sum =
      setup +
      MAX_FILE_PAGES +
      MAX_COMMENT_PAGES + // the pull request's review comments
      MAX_THREAD_PAGES +
      creations +
      MAX_GITHUB_THREAD_UPDATES + // resolutions and reopenings
      MAX_FIXED_NOTES + // the notes of fixed issues in the threads people replied in
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
      MAX_AI_THREADS,
      MAX_GITHUB_THREAD_UPDATES,
      MAX_FIXED_NOTES,
    ]).toEqual([30, 50, 10, 50, 20, 100, 20]);
    expect(MAX_CREATION_REQUESTS).toBe(creations);
    expect([
      REQUESTS_OUTSIDE_THREADS,
      MAX_CREATION_REQUESTS,
      MAX_GITHUB_THREAD_UPDATES,
      MAX_FIXED_NOTES,
    ]).toEqual([151, 71, 100, 20]);
    expect(
      REQUESTS_OUTSIDE_THREADS +
        MAX_CREATION_REQUESTS +
        MAX_GITHUB_THREAD_UPDATES +
        MAX_FIXED_NOTES,
    ).toBe(sum);
    expect(sum).toBe(342);
    // Below the budget, so the check run and the summary are written whatever else the job did.
    expect(sum).toBeLessThanOrEqual(MAX_GITHUB_REQUESTS);
  });
});
