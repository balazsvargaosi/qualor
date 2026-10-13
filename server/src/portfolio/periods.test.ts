import { describe, expect, it } from 'vitest';
import { uuidv7, uuidv7Timestamp } from '../db/ids';
import { periodStart, periods, uuidv7Floor } from './periods';

describe('portfolio periods (4E-2 §1)', () => {
  it('floors a uuid v7 at a time: ids made before sort below, ids made at or after do not', () => {
    const t = new Date('2026-10-12T00:00:00.000Z');
    const floor = uuidv7Floor(t);
    expect(uuidv7Timestamp(floor)).toBe(t.getTime());
    expect(uuidv7(t.getTime() - 1) < floor).toBe(true);
    expect(uuidv7(t.getTime()) < floor).toBe(false);
  });
  it('starts weeks on Monday 00:00 UTC and months on the 1st', () => {
    expect(periodStart(new Date('2026-10-18T23:59:59.999Z'), 'week').toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
    expect(periodStart(new Date('2026-10-12T00:00:00.000Z'), 'week').toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
    expect(periodStart(new Date('2026-03-31T12:00:00Z'), 'month').toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });
  it('gives 12 contiguous periods, oldest first, the last ending now', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    const ps = periods(now, 'week');
    expect(ps).toHaveLength(12);
    expect(ps.at(-1)).toEqual({ start: new Date('2026-10-12T00:00:00.000Z'), end: now });
    expect(ps[0]!.start.toISOString()).toBe('2026-07-27T00:00:00.000Z');
    for (let i = 1; i < ps.length; i++) expect(ps[i]!.start).toEqual(ps[i - 1]!.end);
    const ms = periods(new Date('2026-01-15T00:00:00Z'), 'month');
    expect(ms[0]!.start.toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });
});
