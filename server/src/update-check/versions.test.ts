import { describe, expect, it } from 'vitest';
import { compareVersions, latestStable, parseStable } from './versions';

describe('parseStable', () => {
  it.each([
    ['0.7.1', [0, 7, 1]],
    ['12.40.7', [12, 40, 7]],
    ['0.7', null],
    ['latest', null],
    ['staging-0.7.1', null],
    ['0.8.0-rc.1', null],
    ['v0.8.0', null],
  ])('%s → %j', (tag, parsed) => {
    expect(parseStable(tag)).toEqual(parsed);
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.10.0', '0.9.9', 1],
    ['0.8.0', '0.8.0', 0],
    ['0.7.1', '0.8.0', -1],
    ['0.8.0-rc.1', '0.8.0', -1],
    ['0.8.0', '0.8.0-rc.1', 1],
    ['0.9.0-dev', '0.8.0', 1],
    ['dev', '0.0.1', -1],
  ])('%s vs %s → sign %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe('latestStable', () => {
  it('picks the highest stable tag and ignores the rest', () => {
    expect(
      latestStable(['0.7', '0.7.1', 'staging-0.9.0', '0.10.0', '0.9.9', 'latest', '0.11.0-rc.1']),
    ).toBe('0.10.0');
  });

  it('is null without a stable tag', () => {
    expect(latestStable(['latest', '0.7'])).toBeNull();
  });
});
