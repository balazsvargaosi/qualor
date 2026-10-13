import { describe, expect, it } from 'vitest';
import { analysisFailedKey } from './analysis';

const PROJECT = '0190a6c2-0000-7000-8000-0000000000b1';
const branch = (name: string) => ({ name, kind: 'branch' as const });
const mr = (name: string) => ({ name, kind: 'merge_request' as const });

describe('analysisFailedKey (mail E3 N7)', () => {
  it('names the project and the branch, or ? when the branch is unknown', () => {
    expect(analysisFailedKey(PROJECT, branch('main'))).toBe(
      `analysis.failed:${PROJECT}:branch:main`,
    );
    expect(analysisFailedKey(PROJECT, null)).toBe(`analysis.failed:${PROJECT}:?`);
  });

  it('keeps a branch and a merge request of the same name apart (a merge request is named by its id)', () => {
    expect(analysisFailedKey(PROJECT, mr('42'))).toBe(`analysis.failed:${PROJECT}:mr:42`);
    expect(analysisFailedKey(PROJECT, mr('42'))).not.toBe(analysisFailedKey(PROJECT, branch('42')));
    // Both kinds are prefixed, so no branch name can pass for a merge request's key.
    expect(analysisFailedKey(PROJECT, branch('mr:42'))).not.toBe(
      analysisFailedKey(PROJECT, mr('42')),
    );
  });

  it('stays within the outbox limit of 200 characters for any branch name, distinct per name', () => {
    const long = branch('feature/'.padEnd(255, 'x'));
    const other = branch('feature/'.padEnd(255, 'y'));
    expect(analysisFailedKey(PROJECT, long).length).toBeLessThanOrEqual(200);
    expect(analysisFailedKey(PROJECT, mr(long.name)).length).toBeLessThanOrEqual(200);
    expect(analysisFailedKey(PROJECT, long)).not.toBe(analysisFailedKey(PROJECT, other));
    expect(analysisFailedKey(PROJECT, long)).toBe(analysisFailedKey(PROJECT, long));
  });
});
