import { interp1, makeGrid, type Axes, type Grid } from "./axes";
import type { EngineSpec } from "./engines";
import { airGPerKpa, knockLimit, mbtSpark, trueVE } from "./model";

export interface Maps {
  fuel: Grid; // injector pulse width, ms
  ign: Grid; // spark advance, deg BTDC
  afrTarget: Grid; // desired AFR (reference for logging/correction)
}

/** Sensible AFR targets: stoich at cruise, progressively richer under load. */
function defaultAfrTarget(loadKpa: number): number {
  return interp1(
    [
      [20, 14.7],
      [60, 14.7],
      [80, 13.8],
      [100, 13.0],
      [120, 12.5],
      [140, 12.2],
      [160, 12.0],
      [180, 11.8],
      [200, 11.6],
    ],
    loadKpa,
  );
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** PW that would hit `afr` if the engine really had volumetric efficiency `ve`. */
function pwFor(
  spec: EngineSpec,
  loadKpa: number,
  ve: number,
  afr: number,
): number {
  const airG = loadKpa * ve * airGPerKpa(spec);
  return airG / afr / spec.injGramsPerMs + spec.injDeadtimeMs;
}

/**
 * The "base calibration": fuel computed assuming one flat VE number. Close
 * in the midrange, rich down low, lean where the real engine breathes
 * hardest — the classic starting point that makes tuning necessary.
 */
export function baseMaps(spec: EngineSpec, axes: Axes): Maps {
  const flatVE = 0.82 * Math.max(...spec.veCurve.map(([, v]) => v));
  return {
    fuel: makeGrid(axes, (l) =>
      round2(pwFor(spec, l, flatVE, defaultAfrTarget(l))),
    ),
    ign: makeGrid(axes, (l, r) => {
      const safe = Math.min(
        mbtSpark(r, l) - 4,
        knockLimit(spec, r, l, defaultAfrTarget(l)) - 6,
      );
      return round1(Math.max(4, safe));
    }),
    afrTarget: makeGrid(axes, (l) => round1(defaultAfrTarget(l))),
  };
}

/** Correct VE but 12% extra fuel everywhere — safe, sooty, slow. */
export function richSafeMaps(spec: EngineSpec, axes: Axes): Maps {
  const m = baseMaps(spec, axes);
  m.fuel = makeGrid(axes, (l, r) =>
    round2(
      (pwFor(spec, l, trueVE(spec, r, l), defaultAfrTarget(l)) -
        spec.injDeadtimeMs) *
        1.12 +
        spec.injDeadtimeMs,
    ),
  );
  m.ign = makeGrid(axes, (l, r) => {
    const safe = Math.min(
      mbtSpark(r, l) - 6,
      knockLimit(spec, r, l, 11.5) - 8,
    );
    return round1(Math.max(4, safe));
  });
  return m;
}

/** A professional calibration — what a finished tune looks like. */
export function expertMaps(spec: EngineSpec, axes: Axes): Maps {
  return {
    fuel: makeGrid(axes, (l, r) =>
      round2(pwFor(spec, l, trueVE(spec, r, l), defaultAfrTarget(l))),
    ),
    ign: makeGrid(axes, (l, r) => {
      const mbt = mbtSpark(r, l);
      const kl = knockLimit(spec, r, l, defaultAfrTarget(l));
      return round1(Math.max(4, Math.min(mbt, kl - 2)));
    }),
    afrTarget: makeGrid(axes, (l) => round1(defaultAfrTarget(l))),
  };
}

/**
 * Near-perfect calibration: exact-VE fueling at power AFRs and timing
 * hugging the knock limit. Used to grade tuning-school exercises and as
 * the "pro" drag-race rival — not offered as a player preset.
 */
export function optimalMaps(spec: EngineSpec, axes: Axes, margin = 0.6): Maps {
  const afrFor = (l: number) =>
    interp1(
      [
        [20, 14.7],
        [60, 14.5],
        [80, 13.6],
        [100, 12.9],
        [120, 12.6],
        [140, 12.5],
        [160, 12.4],
        [180, 12.3],
        [200, 12.2],
        [260, 12.0],
      ],
      l,
    );
  return {
    fuel: makeGrid(axes, (l, r) =>
      round2(pwFor(spec, l, trueVE(spec, r, l), afrFor(l))),
    ),
    ign: makeGrid(axes, (l, r) =>
      round1(
        Math.max(
          4,
          Math.min(mbtSpark(r, l), knockLimit(spec, r, l, afrFor(l)) - margin),
        ),
      ),
    ),
    afrTarget: makeGrid(axes, (l) => round1(afrFor(l))),
  };
}

/**
 * The party tune: exact-VE fueling at power AFRs under boost, and the
 * overrun rows (what the ECU reads on a closed throttle at revs) fuelled
 * deep-rich with retarded spark — the unburnt mixture lights off in the
 * pipe. Pops, crackles, bangs: the map IS the soundtrack.
 */
export function popsBangsMaps(spec: EngineSpec, axes: Axes): Maps {
  const overrun = (l: number, r: number) => l <= 48 && r >= 2200;
  const afrFor = (l: number, r: number) =>
    overrun(l, r)
      ? 10.8
      : interp1(
          [
            [20, 13.8],
            [48, 13.8],
            [64, 13.2],
            [80, 12.9],
            [100, 12.6],
            [140, 12.3],
            [180, 12.1],
            [220, 12.0],
            [260, 11.9],
          ],
          l,
        );
  return {
    fuel: makeGrid(axes, (l, r) =>
      round2(pwFor(spec, l, trueVE(spec, r, l), afrFor(l, r))),
    ),
    ign: makeGrid(axes, (l, r) => {
      if (overrun(l, r)) return 12; // burn it in the pipe, not the cylinder
      const afr = afrFor(l, r);
      return round1(
        Math.max(
          4,
          Math.min(mbtSpark(r, l), knockLimit(spec, r, l, afr) - 1.2),
        ),
      );
    }),
    afrTarget: makeGrid(axes, (l, r) => round1(afrFor(l, r))),
  };
}

/** Pro-tune reference maps are hidden unless the URL carries ?unlocked=true */
export const isUnlocked = () =>
  new URLSearchParams(window.location.search).get("unlocked") === "true";

export const PRESETS: {
  id: string;
  label: string;
  make: (spec: EngineSpec, axes: Axes) => Maps;
  /** only offered on this engine */
  engineId?: string;
  /** wastegate pressure applied when the preset loads */
  wastegateKpa?: number;
}[] = [
  { id: "base", label: "Base calibration (needs tuning)", make: baseMaps },
  { id: "rich", label: "Rich & safe (slow)", make: richSafeMaps },
  {
    id: "popsbangs450",
    label: "Mk4.5 450 — pops & bangs (the party tune)",
    make: popsBangsMaps,
    engineId: "stmk45bt",
    wastegateKpa: 256,
  },
  ...(isUnlocked()
    ? [{ id: "expert", label: "Pro tune (reference)", make: expertMaps }]
    : []),
];
