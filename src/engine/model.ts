import { clamp, interp1 } from "./axes";
import type { EngineSpec } from "./engines";

/**
 * The "real engine" the player tunes against. The ECU side (the maps the
 * player edits) never sees these functions directly; it only commands
 * injector pulse width and spark advance. The gap between the ECU's
 * assumptions and this physical truth is exactly what tuning closes.
 */

export const STOICH_AFR = 14.7;

/** grams of air per cylinder fill per kPa of MAP at VE = 1.0 (speed-density).
 *  m[g] = P[Pa] · V[m³] / (R·T) · 1000 — with P in kPa that's ×1000 twice. */
export const airGPerKpa = (spec: EngineSpec) =>
  (1000 * 1000 * (spec.dispL / 1000 / spec.ncyl)) / (287 * 320);

export function trueVE(spec: EngineSpec, rpm: number, mapKpa: number): number {
  const base = interp1(spec.veCurve, rpm);
  // mild throttling losses at low load, mild backpressure losses in boost
  const loadFac =
    0.88 +
    0.12 * clamp(mapKpa / 100, 0, 1) -
    0.04 * clamp((mapKpa - 100) / 100, 0, 1);
  return base * loadFac;
}

/** Torque multiplier vs AFR — peaks slightly rich of stoich (~12.8). */
const MIX_FACTOR: [number, number][] = [
  [8, 0.35],
  [9, 0.6],
  [10, 0.85],
  [11, 0.95],
  [12, 1.0],
  [12.8, 1.02],
  [13.4, 1.01],
  [14.0, 0.995],
  [14.7, 0.98],
  [15.5, 0.9],
  [16.5, 0.72],
  [17.5, 0.4],
  [20, 0.12],
];

/** MBT spark (deg BTDC) — the advance that makes peak torque. */
export function mbtSpark(rpm: number, mapKpa: number): number {
  const byLoad = interp1(
    [
      [20, 38],
      [40, 34],
      [60, 30],
      [80, 26],
      [100, 22],
      [120, 19],
      [140, 16],
      [160, 14],
      [180, 12],
      [200, 10],
    ],
    mapKpa,
  );
  const byRpm = clamp((rpm - 1000) / 5800, 0, 1) * 6;
  return byLoad + byRpm;
}

/**
 * Knock threshold. At low load it sits far above MBT (you can't knock at
 * cruise). Under boost it drops BELOW MBT — you must retard timing and/or
 * add fuel. Rich mixtures cool the chamber and buy back margin. Some blocks
 * (2JZ…) tolerate more; high-compression NA engines tolerate less.
 */
export function knockLimit(
  spec: EngineSpec,
  rpm: number,
  mapKpa: number,
  afr: number,
): number {
  const margin = interp1(
    [
      [20, 15],
      [60, 12],
      [80, 8],
      [100, 3],
      [120, 0],
      [140, -3],
      [160, -5],
      [180, -7],
      [200, -9],
    ],
    mapKpa,
  );
  const afrAdj = clamp((13.2 - afr) * 1.5, -6, 5);
  return mbtSpark(rpm, mapKpa) + margin + afrAdj + spec.knockMargin;
}

function frictionTorque(spec: EngineSpec, rpm: number): number {
  const [a, b, c] = spec.friction;
  return a + b * rpm + c * (rpm / 1000) ** 2;
}

export interface PointResult {
  airG: number; // grams of air per cylinder fill
  fuelG: number; // grams of fuel per injection
  afr: number;
  duty: number; // injector duty cycle %
  torque: number; // brake torque, Nm
  powerHp: number;
  mbt: number;
  knockLimit: number;
  knockSeverity: number; // degrees past the knock threshold (0 = safe)
  misfire: boolean;
  egtTarget: number; // °C the exhaust is heading toward at this point
}

/**
 * Steady-state engine output for one operating point given what the ECU
 * commanded. Pure — used by both the live loop and the dyno sweep.
 */
export function simulatePoint(
  spec: EngineSpec,
  rpm: number,
  mapKpa: number,
  fuelPwMs: number,
  sparkAdv: number,
): PointResult {
  const ve = trueVE(spec, rpm, mapKpa);
  const airG = mapKpa * ve * airGPerKpa(spec);
  const fuelG =
    Math.max(0, fuelPwMs - spec.injDeadtimeMs) * spec.injGramsPerMs;
  const afr = fuelG > 1e-6 ? clamp(airG / fuelG, 5, 25) : 25;

  const cycleMs = 120000 / Math.max(rpm, 100); // one 4-stroke cycle = 2 revs
  const duty = clamp((fuelPwMs / cycleMs) * 100, 0, 100);

  const mbt = mbtSpark(rpm, mapKpa);
  const kl = knockLimit(spec, rpm, mapKpa, afr);
  const knockSeverity = mapKpa > 55 ? Math.max(0, sparkAdv - kl) : 0;

  const delta = sparkAdv - mbt;
  const timingFac =
    delta <= 0
      ? Math.max(0.5, 1 - 0.0015 * delta * delta)
      : Math.max(0.85, 1 - 0.0008 * delta * delta);

  const mixFac = interp1(MIX_FACTOR, afr);
  const misfire = afr >= 17 || afr <= 9 || delta < -25 || fuelG <= 1e-6;

  const ePerGAir = (43000 / STOICH_AFR) * spec.thermalEff;
  const perEventJ = airG * ePerGAir * mixFac * timingFac;
  // combustion efficiency falls at part load (small charges lose
  // proportionally more heat); calibrated to 1.0 at WOT so dyno figures
  // and the factory-rating fits are untouched
  const loadEff = 0.55 + 0.45 * clamp((mapKpa - 20) / 75, 0, 1);
  // pumping loss: the pistons work against a throttled intake — this is
  // what makes a closed-throttle engine decelerate instead of run away
  const pumpTq =
    (Math.max(0, 100 - mapKpa) * 1000 * (spec.dispL / 1000)) / (4 * Math.PI);
  let torque =
    (perEventJ * spec.ncyl * loadEff) / (4 * Math.PI) -
    frictionTorque(spec, rpm) -
    pumpTq;
  if (misfire) torque = Math.min(torque, torque * 0.15);

  const retard = Math.max(0, mbt - sparkAdv);
  const egtTarget = clamp(
    480 + mapKpa * 1.4 + (afr - 12) * 35 + retard * 7 + rpm * 0.015,
    400,
    1150,
  );

  return {
    airG,
    fuelG,
    afr,
    duty,
    torque,
    powerHp: (torque * rpm) / 7127,
    mbt,
    knockLimit: kl,
    knockSeverity,
    misfire,
    egtTarget,
  };
}

/** WOT manifold pressure the induction system supplies at this rpm (kPa). */
export function boostCeiling(
  spec: EngineSpec,
  rpm: number,
  wastegateKpa: number,
): number {
  if (!spec.turbo) return 98;
  const cap = Math.min(wastegateKpa, spec.turbo.maxKpa);
  const spool = clamp((rpm - spec.turbo.spoolStart) / spec.turbo.spoolSpan, 0, 1);
  return 98 + spool * Math.max(0, cap - 98);
}
