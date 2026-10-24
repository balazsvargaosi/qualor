import { describe, expect, it } from 'vitest';
import { formatCents } from './format';

describe('formatCents', () => {
  it('writes whole and fractional euros with two decimals', () => {
    expect(formatCents(1999)).toBe('19.99');
    expect(formatCents(500)).toBe('5.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(0)).toBe('0.00');
  });
});
