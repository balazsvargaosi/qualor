/** 4E-2 §1: the period math the portfolio trend and the "uploaded before t" rule share. */
export type Granularity = 'week' | 'month';

export const TREND_POINTS = 12;

const DAY_MS = 86_400_000;

/** The smallest uuid v7 whose time is t: every id created before t sorts below it. */
export function uuidv7Floor(t: Date): string {
  const hex = t.getTime().toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
}

/** Start of the period containing t (UTC; weeks start Monday). */
export function periodStart(t: Date, g: Granularity): Date {
  if (g === 'month') return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const day = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return new Date(day - ((t.getUTCDay() + 6) % 7) * DAY_MS);
}

function previous(start: Date, g: Granularity): Date {
  return g === 'month'
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1))
    : new Date(start.getTime() - 7 * DAY_MS);
}

/** The last `count` periods, oldest first; the last one ends at `now` (partial). */
export function periods(
  now: Date,
  g: Granularity,
  count: number = TREND_POINTS,
): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  let start = periodStart(now, g);
  let end = now;
  for (let i = 0; i < count; i++) {
    out.unshift({ start, end });
    end = start;
    start = previous(start, g);
  }
  return out;
}
