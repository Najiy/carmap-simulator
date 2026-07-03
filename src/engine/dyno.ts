import { lookup, nearestCell, type Axes } from "./axes";
import type { EngineSpec } from "./engines";
import { boostCeiling, simulatePoint } from "./model";
import type { Maps } from "./defaults";

export interface DynoPoint {
  rpm: number;
  mapKpa: number;
  torque: number; // wheel Nm
  hp: number; // wheel hp
  afr: number;
  afrTarget: number;
  spark: number;
  knock: boolean;
  knockSeverity: number;
  duty: number;
  egt: number;
  /** health lost crossing this point — lets the pull play back in real time */
  damage: number;
}

export interface DynoRun {
  id: number;
  label: string;
  engineName: string;
  points: DynoPoint[];
  peakTq: { v: number; rpm: number };
  peakHp: { v: number; rpm: number };
  knockEvents: number;
  minAfr: number;
  maxAfr: number;
  maxDuty: number;
  damage: number; // health lost during the pull
  afrSamples: { li: number; ri: number; afr: number }[];
}

/** crank → wheel losses through the driveline — what the rollers actually see */
export const DRIVELINE = 0.85;

/** how long the on-screen pull takes: chart reveal + live telemetry playback */
export const PULL_MS = 2400;

/**
 * A WOT dyno pull: sweep from 1600 rpm to just past redline against the
 * brake, manifold pressure following the spool curve, reading the player's
 * maps exactly like the ECU would. Knock during the pull damages the engine.
 */
export function runDyno(
  spec: EngineSpec,
  axes: Axes,
  maps: Maps,
  wastegateKpa: number,
  id: number,
): DynoRun {
  const points: DynoPoint[] = [];
  const afrSamples: DynoRun["afrSamples"] = [];
  let knockEvents = 0;
  let damage = 0;

  const rpmStart = 1600;
  const rpmEnd = Math.min(spec.redline + 100, spec.revLimit);
  const nPts = 71;
  const step = (rpmEnd - rpmStart) / (nPts - 1);
  const secPerPoint = 9 / nPts; // ~9 second pull

  for (let i = 0; i < nPts; i++) {
    const rpm = Math.round(rpmStart + step * i);
    const mapKpa = boostCeiling(spec, rpm, wastegateKpa);
    const pw = lookup(maps.fuel, axes, rpm, mapKpa);
    const spark = lookup(maps.ign, axes, rpm, mapKpa);
    const target = lookup(maps.afrTarget, axes, rpm, mapKpa);
    const r = simulatePoint(spec, rpm, mapKpa, pw, spark);

    const knock = r.knockSeverity > 0;
    let pointDamage = 0;
    if (knock) {
      knockEvents += Math.max(1, Math.round(r.knockSeverity * 2));
      pointDamage += r.knockSeverity ** 1.5 * 0.9 * secPerPoint;
    }
    if (r.afr > 15.2 && mapKpa > 120 && !r.misfire) {
      pointDamage += (r.afr - 15.2) * ((mapKpa - 120) / 80) * 0.5 * secPerPoint;
    }
    damage += pointDamage;

    const cell = nearestCell(axes, rpm, mapKpa);
    afrSamples.push({ li: cell.li, ri: cell.ri, afr: r.afr });

    points.push({
      rpm,
      mapKpa,
      torque: Math.max(0, r.torque * DRIVELINE),
      hp: Math.max(0, r.powerHp * DRIVELINE),
      afr: r.afr,
      afrTarget: target,
      spark,
      knock,
      knockSeverity: r.knockSeverity,
      duty: r.duty,
      egt: r.egtTarget,
      damage: pointDamage,
    });
  }

  const peakTq = points.reduce((a, p) => (p.torque > a.torque ? p : a));
  const peakHp = points.reduce((a, p) => (p.hp > a.hp ? p : a));
  const wotAfrs = points.filter((p) => p.mapKpa > 92).map((p) => p.afr);

  return {
    id,
    label: `Run ${id}`,
    engineName: spec.name,
    points,
    peakTq: { v: peakTq.torque, rpm: peakTq.rpm },
    peakHp: { v: peakHp.hp, rpm: peakHp.rpm },
    knockEvents,
    minAfr: Math.min(...wotAfrs),
    maxAfr: Math.max(...wotAfrs),
    maxDuty: Math.max(...points.map((p) => p.duty)),
    damage,
    afrSamples,
  };
}
