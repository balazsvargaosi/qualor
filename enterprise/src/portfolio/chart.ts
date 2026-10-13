// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * The SVG path (for pdfkit's `doc.path`) of a line chart of `points` inside `box`, one point per
 * equal step from left to right, and a dot per value. A null breaks the line, so an isolated value
 * has only its dot. `range` maps to the bottom and top of the box; without it, the values' own
 * minimum and maximum do, and a flat series runs across the middle. Values outside the range are
 * kept on the box's edge. Coordinates are rounded to two decimals.
 */
export function lineChartPaths(
  points: readonly (number | null)[],
  box: Box,
  range?: readonly [number, number],
): { path: string; dots: Point[] } {
  const values = points.filter((p): p is number => p !== null);
  if (values.length === 0) return { path: '', dots: [] };
  const [min, max] = range ?? [Math.min(...values), Math.max(...values)];
  const step = points.length > 1 ? box.w / (points.length - 1) : 0;
  const x = (i: number): number => round(points.length > 1 ? box.x + i * step : box.x + box.w / 2);
  const y = (v: number): number => {
    const share = max === min ? 0.5 : Math.min(1, Math.max(0, (v - min) / (max - min)));
    return round(box.y + box.h - share * box.h);
  };
  const parts: string[] = [];
  const dots: Point[] = [];
  let drawing = false;
  for (const [i, value] of points.entries()) {
    if (value === null) {
      drawing = false;
      continue;
    }
    const dot = { x: x(i), y: y(value) };
    parts.push(`${drawing ? 'L' : 'M'}${dot.x} ${dot.y}`);
    dots.push(dot);
    drawing = true;
  }
  return { path: parts.join(' '), dots };
}
