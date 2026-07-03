import type { EngineSpec } from "./engines";

/** Table axes — always 16 RPM columns × 14 MAP rows, scaled per engine. */
export interface Axes {
  rpm: number[];
  load: number[]; // manifold absolute pressure, kPa; 100 ≈ atmospheric
}

export type Grid = number[][]; // grid[loadIndex][rpmIndex]

export const RPM_COLS = 16;
export const LOAD_ROWS = 14;

export function buildAxes(spec: EngineSpec): Axes {
  const rpm = Array.from({ length: RPM_COLS }, (_, i) =>
    Math.round((800 + ((spec.revLimit - 800) * i) / (RPM_COLS - 1)) / 50) * 50,
  );
  let load: number[];
  if (spec.turbo) {
    const boostRows = 5;
    const max = spec.turbo.maxKpa;
    load = [
      20, 30, 40, 50, 60, 70, 80, 90, 100,
      ...Array.from({ length: boostRows }, (_, i) =>
        Math.round(100 + ((max - 100) * (i + 1)) / boostRows),
      ),
    ];
  } else {
    load = [20, 26, 32, 38, 44, 50, 56, 62, 68, 74, 80, 86, 93, 100];
  }
  return { rpm, load };
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Piecewise-linear interpolation over [x, y] points sorted by x. */
export function interp1(pts: [number, number][], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** Continuous (fractional) index of value v on an axis. */
export function axisPos(axis: number[], v: number): number {
  if (v <= axis[0]) return 0;
  if (v >= axis[axis.length - 1]) return axis.length - 1;
  for (let i = 1; i < axis.length; i++) {
    if (v <= axis[i]) {
      return i - 1 + (v - axis[i - 1]) / (axis[i] - axis[i - 1]);
    }
  }
  return axis.length - 1;
}

/** Bilinear table lookup — how a real speed-density ECU reads its maps. */
export function lookup(
  grid: Grid,
  axes: Axes,
  rpm: number,
  loadKpa: number,
): number {
  const x = axisPos(axes.rpm, rpm);
  const y = axisPos(axes.load, loadKpa);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, axes.rpm.length - 1);
  const y1 = Math.min(y0 + 1, axes.load.length - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = grid[y0][x0] * (1 - fx) + grid[y0][x1] * fx;
  const b = grid[y1][x0] * (1 - fx) + grid[y1][x1] * fx;
  return a * (1 - fy) + b * fy;
}

/** Nearest cell indices — used for the live cell trace and AFR logging. */
export function nearestCell(axes: Axes, rpm: number, loadKpa: number) {
  return {
    ri: Math.round(axisPos(axes.rpm, rpm)),
    li: Math.round(axisPos(axes.load, loadKpa)),
  };
}

export function makeGrid(
  axes: Axes,
  fn: (loadKpa: number, rpm: number) => number,
): Grid {
  return axes.load.map((l) => axes.rpm.map((r) => fn(l, r)));
}

export const cloneGrid = (g: Grid): Grid => g.map((row) => [...row]);
