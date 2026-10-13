import { describe, expect, it } from 'vitest';
import { analysisFailedKey } from './analysis';

const PROJECT = '0190a6c2-0000-7000-8000-0000000000b1';

describe('analysisFailedKey (mail E3 N7)', () => {
  it('names the project and the branch, or ? when the branch is unknown', () => {
    expect(analysisFailedKey(PROJECT, 'main')).toBe(`analysis.failed:${PROJECT}:main`);
    expect(analysisFailedKey(PROJECT, null)).toBe(`analysis.failed:${PROJECT}:?`);
  });

  it('stays within the outbox limit of 200 characters for any branch name, distinct per name', () => {
    const long = 'feature/'.padEnd(255, 'x');
    const other = 'feature/'.padEnd(255, 'y');
    expect(analysisFailedKey(PROJECT, long).length).toBeLessThanOrEqual(200);
    expect(analysisFailedKey(PROJECT, long)).not.toBe(analysisFailedKey(PROJECT, other));
    expect(analysisFailedKey(PROJECT, long)).toBe(analysisFailedKey(PROJECT, long));
  });
});
