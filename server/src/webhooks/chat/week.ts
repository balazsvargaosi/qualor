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
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
  } catch {
    // A zone the runtime dropped since it was saved: UTC rather than no digest at all.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
}

/** The weekday, hour and ISO week of `now` on the wall clock of `zone` (UTC if unknown). */
export function localClock(now: Date, zone: string): LocalClock {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
    hour: Number(parts.hour),
    isoWeek: isoWeekOf(Number(parts.year), Number(parts.month), Number(parts.day)),
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
