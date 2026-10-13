// SPDX-License-Identifier: LicenseRef-Qualor-Enterprise
import { describe, expect, it } from 'vitest';
import { lineChartPaths } from './chart';

const box = { x: 0, y: 0, w: 100, h: 100 };

describe('lineChartPaths', () => {
  it('maps known points into the box, the top of the range at the top', () => {
    expect(lineChartPaths([0, 50, 100], box, [0, 100])).toEqual({
      path: 'M0 100 L50 50 L100 0',
      dots: [
        { x: 0, y: 100 },
        { x: 50, y: 50 },
        { x: 100, y: 0 },
      ],
    });
  });

  it('offsets by the box origin and scales to the range of the values by default', () => {
    expect(lineChartPaths([10, 20], { x: 10, y: 20, w: 50, h: 40 }).path).toBe('M10 60 L60 20');
  });

  it('breaks the line at a null and rounds to two decimals', () => {
    const { path, dots } = lineChartPaths([10, null, 30, 40], box, [0, 40]);
    expect(path).toBe('M0 75 M66.67 25 L100 0');
    expect(dots).toEqual([
      { x: 0, y: 75 },
      { x: 66.67, y: 25 },
      { x: 100, y: 0 },
    ]);
  });

  it('draws a flat series across the middle when no range is given', () => {
    expect(lineChartPaths([5, 5, 5], box).path).toBe('M0 50 L50 50 L100 50');
  });

  it('keeps values inside the box when they fall outside the range', () => {
    expect(lineChartPaths([-10, 110], box, [0, 100]).path).toBe('M0 100 L100 0');
  });

  it('centres a single point', () => {
    expect(lineChartPaths([3], box, [0, 6])).toEqual({ path: 'M50 50', dots: [{ x: 50, y: 50 }] });
  });

  it('gives nothing to draw for an empty or all-null series', () => {
    expect(lineChartPaths([], box)).toEqual({ path: '', dots: [] });
    expect(lineChartPaths([null, null], box)).toEqual({ path: '', dots: [] });
  });
});
