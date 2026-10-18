import { describe, expect, it } from 'vitest';
import { digestDue, digestWindow, isoWeekOf, localClock } from './week';

describe('isoWeekOf', () => {
  it.each([
    [2026, 10, 19, '2026-W43'],
    [2026, 12, 28, '2026-W53'],
    [2027, 1, 1, '2026-W53'],
    [2027, 1, 4, '2027-W01'],
    [2025, 12, 29, '2026-W01'],
  ])('%i-%i-%i is %s', (y, m, d, week) => {
    expect(isoWeekOf(y, m, d)).toBe(week);
  });
});

describe('localClock', () => {
  it('reads the weekday, hour and ISO week in the zone', () => {
    expect(localClock(new Date('2026-10-18T23:30:00Z'), 'Asia/Tokyo')).toEqual({
      weekday: 1,
      hour: 8,
      isoWeek: '2026-W43',
    });
    expect(localClock(new Date('2026-10-18T23:30:00Z'), 'UTC')).toEqual({
      weekday: 7,
      hour: 23,
      isoWeek: '2026-W42',
    });
  });

  it('reads midnight as hour 0', () => {
    expect(localClock(new Date('2026-10-19T00:00:00Z'), 'UTC')).toEqual({
      weekday: 1,
      hour: 0,
      isoWeek: '2026-W43',
    });
  });
});

describe('digestDue (6G spec D3)', () => {
  it.each([
    // Europe/Berlin before the DST change (CEST, UTC+2) …
    ['2026-10-19T06:59:00Z', 'Europe/Berlin', null, null],
    ['2026-10-19T07:00:00Z', 'Europe/Berlin', null, '2026-W43'],
    // … and after it (CET, UTC+1, 2026-10-25): 09:00 local is 08:00 UTC.
    ['2026-10-26T07:30:00Z', 'Europe/Berlin', '2026-W43', null],
    ['2026-10-26T08:00:00Z', 'Europe/Berlin', '2026-W43', '2026-W44'],
    // America/New_York after its DST change (2026-11-01): 09:00 EST is 14:00 UTC.
    ['2026-11-02T13:59:00Z', 'America/New_York', '2026-W44', null],
    ['2026-11-02T14:00:00Z', 'America/New_York', '2026-W44', '2026-W45'],
    // Once a week: the same week already marked.
    ['2026-10-19T15:00:00Z', 'UTC', '2026-W43', null],
    // Late on Monday still counts; Tuesday does not (a missed Monday is skipped, R8).
    ['2026-10-19T23:00:00Z', 'UTC', '2026-W42', '2026-W43'],
    ['2026-10-20T09:00:00Z', 'UTC', '2026-W42', null],
    // Sunday evening UTC is already Monday 09:00 in Tokyo.
    ['2026-10-19T00:00:00Z', 'Asia/Tokyo', '2026-W42', '2026-W43'],
    // The year boundary.
    ['2026-12-28T09:00:00Z', 'UTC', '2026-W52', '2026-W53'],
    ['2027-01-04T09:00:00Z', 'UTC', '2026-W53', '2027-W01'],
  ])('at %s in %s after %s → %s', (now, zone, last, due) => {
    expect(digestDue(new Date(now), zone, last)).toBe(due);
  });

  it('treats a zone the runtime no longer knows as UTC', () => {
    expect(digestDue(new Date('2026-10-19T09:00:00Z'), 'Mars/Olympus', null)).toBe('2026-W43');
    expect(digestDue(new Date('2026-10-19T08:59:00Z'), 'Mars/Olympus', null)).toBeNull();
  });
});

describe('digestWindow (6G spec §4: the 7 local days before this Monday 09:00)', () => {
  const iso = (w: { since: Date; until: Date }) => ({
    since: w.since.toISOString(),
    until: w.until.toISOString(),
  });

  it('is the same window for a late run on the same Monday', () => {
    const window = {
      since: '2026-10-12T07:00:00.000Z',
      until: '2026-10-19T07:00:00.000Z',
    };
    expect(iso(digestWindow(new Date('2026-10-19T07:00:00Z'), 'Europe/Berlin'))).toEqual(window);
    expect(iso(digestWindow(new Date('2026-10-19T07:30:00Z'), 'Europe/Berlin'))).toEqual(window);
    expect(iso(digestWindow(new Date('2026-10-19T21:59:00Z'), 'Europe/Berlin'))).toEqual(window);
  });

  it.each([
    // The week Berlin leaves CEST (2026-10-25): 7 local days are 169 hours.
    [
      '2026-10-26T08:30:00Z',
      'Europe/Berlin',
      '2026-10-19T07:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ],
    // New York leaves EDT on 2026-11-01.
    [
      '2026-11-02T15:00:00Z',
      'America/New_York',
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ],
    // Berlin enters CEST on 2027-03-28: 167 hours.
    [
      '2027-03-29T07:00:00Z',
      'Europe/Berlin',
      '2027-03-22T08:00:00.000Z',
      '2027-03-29T07:00:00.000Z',
    ],
    // Sunday in UTC is already Monday in Tokyo.
    ['2026-10-19T00:30:00Z', 'Asia/Tokyo', '2026-10-12T00:00:00.000Z', '2026-10-19T00:00:00.000Z'],
    // Across the year boundary.
    ['2027-01-04T12:00:00Z', 'UTC', '2026-12-28T09:00:00.000Z', '2027-01-04T09:00:00.000Z'],
    // A zone the runtime no longer knows is read as UTC.
    [
      '2026-10-19T10:00:00Z',
      'Mars/Olympus',
      '2026-10-12T09:00:00.000Z',
      '2026-10-19T09:00:00.000Z',
    ],
  ])('at %s in %s: [%s, %s)', (now, zone, since, until) => {
    expect(iso(digestWindow(new Date(now), zone))).toEqual({ since, until });
  });
});
