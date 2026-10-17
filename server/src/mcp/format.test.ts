import { describe, expect, it } from 'vitest';
import { conditionLine, issueLine, lineRanges, truncate } from './format';

describe('format', () => {
  it('writes an issue as one line an agent can act on', () => {
    expect(
      issueLine({
        id: '11111111-1111-4111-8111-111111111111',
        severity: 'high',
        quality: 'security',
        rule: { key: 'qualor:js.sqli', name: 'SQL injection' },
        message: 'User input reaches a SQL query',
        path: 'src/db.ts',
        startLine: 42,
        inNewCode: true,
        status: 'open',
      }),
    ).toBe(
      'src/db.ts:42 [high security] qualor:js.sqli — User input reaches a SQL query (new code; id 11111111-1111-4111-8111-111111111111)',
    );
  });

  it('handles an issue without a location', () => {
    expect(
      issueLine({
        id: 'x',
        severity: 'low',
        quality: 'maintainability',
        rule: { key: 'r', name: 'R' },
        message: 'm',
        path: null,
        startLine: null,
        inNewCode: false,
        status: 'open',
      }),
    ).toBe('(project) [low maintainability] r — m (id x)');
  });

  it('writes a failed condition with its value and threshold', () => {
    expect(
      conditionLine({
        metric: 'new_coverage',
        operator: 'lt',
        threshold: 80,
        value: 61.5,
        status: 'failed',
      }),
    ).toBe('new_coverage is 61.5, must not be below 80');
    expect(
      conditionLine({
        metric: 'new_violations',
        operator: 'gt',
        threshold: 0,
        value: 3,
        status: 'failed',
      }),
    ).toBe('new_violations is 3, must not be above 0');
    expect(
      conditionLine({
        metric: 'new_coverage',
        operator: 'lt',
        threshold: 80,
        value: null,
        status: 'no_value',
      }),
    ).toBe('new_coverage has no value, must not be below 80');
  });

  it('truncates long text with a note', () => {
    expect(truncate('a'.repeat(20), 10)).toBe('aaaaaaaaaa\n… (truncated)');
    expect(truncate('short', 10)).toBe('short');
  });

  it('writes line ranges compactly', () => {
    expect(
      lineRanges([
        [3, 3],
        [7, 9],
      ]),
    ).toBe('3, 7–9');
    expect(lineRanges([])).toBe('');
  });
});
