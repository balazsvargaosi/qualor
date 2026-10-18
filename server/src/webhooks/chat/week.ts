export interface LocalClock {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  hour: number;
  /** The ISO week of the local date, `2026-W43`. */
  isoWeek: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_MS = 86_400_000;

/** The local Monday hour from which the digest is due (6G spec D3). */
export const DIGEST_HOUR = 9;

/** ISO 8601 week of a calendar date: the week of its Thursday, numbered in that Thursday's year. */
export function isoWeekOf(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function formatter(zone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
  } catch {
    // A zone the runtime dropped since it was saved: UTC rather than no digest at all.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

/** The wall clock of `zone` (UTC if unknown) at `now`. */
function wallClock(now: Date, zone: string): WallClock {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** The weekday, hour and ISO week of `now` on the wall clock of `zone` (UTC if unknown). */
export function localClock(now: Date, zone: string): LocalClock {
  const wall = wallClock(now, zone);
  return {
    weekday: wall.weekday,
    hour: wall.hour,
    isoWeek: isoWeekOf(wall.year, wall.month, wall.day),
  };
}

/** How far the wall clock of `zone` is ahead of UTC at `instant`, in ms (whole minutes). */
function offsetAt(instant: number, zone: string): number {
  const wall = wallClock(new Date(instant), zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant the wall clock of `zone` reads `date` (a UTC midnight standing for a calendar day)
 * at `hour`:00. The offset is read twice, so an hour on the other side of a DST change than
 * the first guess still comes out right.
 */
function localInstant(date: number, hour: number, zone: string): Date {
  const wall = date + hour * 3_600_000;
  let instant = wall - offsetAt(wall, zone);
  instant = wall - offsetAt(instant, zone);
  return new Date(instant);
}

/**
 * 6G spec §4: the digest's window, `[since, until)`: until is this local week's Monday at
 * DIGEST_HOUR in `zone`, since the Monday before at the same local hour (7 local days, 167 or
 * 169 hours in a DST week). Anchored to the week, not to the run, so a late run (an outage, a
 * retry) covers the same days.
 */
export function digestWindow(now: Date, zone: string): { since: Date; until: Date } {
  const wall = wallClock(now, zone);
  const monday = Date.UTC(wall.year, wall.month - 1, wall.day) - (wall.weekday - 1) * DAY_MS;
  return {
    since: localInstant(monday - 7 * DAY_MS, DIGEST_HOUR, zone),
    until: localInstant(monday, DIGEST_HOUR, zone),
  };
}

/**
 * 6G spec §4, D3: due when it is Monday in the zone, the local hour is DIGEST_HOUR or later, and
 * this local ISO week was not marked yet (a Monday missed entirely is not sent late, R8). Returns
 * the week to mark, or null.
 */
export function digestDue(now: Date, zone: string, lastWeek: string | null): string | null {
  const clock = localClock(now, zone);
  if (clock.weekday !== 1 || clock.hour < DIGEST_HOUR) return null;
  return clock.isoWeek === lastWeek ? null : clock.isoWeek;
}
