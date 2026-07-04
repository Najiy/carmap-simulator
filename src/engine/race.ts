import { clamp, lookup, type Axes } from "./axes";
import { GEARBOX, type EngineSpec } from "./engines";
import { baseMaps, optimalMaps, richSafeMaps, type Maps } from "./defaults";
import { boostCeiling, simulatePoint } from "./model";
import { runDyno } from "./dyno";

export const QUARTER_MILE_M = 402.336;
export const SIXTY_FEET_M = 18.288;
/** fixed physics step — keeps ghost runs and live runs identical */
export const RACE_STEP = 1 / 120;
/** seconds of staging (amber lights) before the green */
export const STAGE_S = 1.5;
/** hard cap on a run — the clock stops at 30 s, whatever's happened */
export const RACE_TIMEOUT = 30;

/** clutch-slip rev ceiling while stationary / launching */
export const launchRpm = (spec: EngineSpec) =>
  Math.min(spec.idle + 2400, Math.round(spec.redline * 0.72));

export interface RaceEnv {
  spec: EngineSpec;
  axes: Axes;
  maps: Maps;
  wastegateKpa: number;
  /** rpm to grab the next gear at (auto-shift + shift light) */
  shiftRpm: number;
}

export interface RaceCar {
  /** race clock, s — negative while staged, 0 = green light */
  t: number;
  d: number; // m from the start line
  v: number; // m/s
  rpm: number;
  mapKpa: number;
  gear: number;
  shiftT: number;
  throttle: number;
  afr: number;
  /** display telemetry — mirrored onto the gauges, never fed back into physics */
  torqueNm: number;
  egt: number;
  duty: number;
  spark: number;
  health: number;
  blown: boolean;
  knocking: boolean;
  sixtyFt: number | null;
  finished: boolean;
  et: number | null;
  trapKph: number;
}

export function createRaceCar(spec: EngineSpec, health = 100): RaceCar {
  return {
    t: -STAGE_S,
    d: 0,
    v: 0,
    rpm: spec.idle,
    mapKpa: 100,
    gear: 0,
    shiftT: 0,
    throttle: 0,
    afr: 14.7,
    torqueNm: 0,
    egt: 550, // warmed up and staged
    duty: 0,
    spark: 10,
    health,
    blown: false,
    knocking: false,
    sixtyFt: null,
    finished: false,
    et: null,
    trapKph: 0,
  };
}

export interface StepOpts {
  /** brakes held — overrides throttle */
  brake?: boolean;
  /** finish-line distance; circuit mode passes Infinity and times itself */
  finishD?: number;
  /** aero-drag multiplier (slipstream) */
  dragScale?: number;
  /** grip multiplier for the traction cap (weather) */
  tractionScale?: number;
  /** braking decel in g (weather-scaled) */
  brakeG?: number;
}

/**
 * One fixed physics step. Before t=0 the car is staged (clutch in): revving
 * spools the turbo but the car stays put. Deterministic — no randomness —
 * so both multiplayer clients and ghost replays agree exactly.
 * `gearSelect` is an H-pattern grab: a 0-based gear, -1 for neutral, or
 * null for none this step. Selecting a low gear at speed over-revs the
 * engine mechanically — the money shift.
 */
export function stepRaceCar(
  car: RaceCar,
  env: RaceEnv,
  throttleHeld: boolean,
  shiftUp: boolean,
  gearSelect: number | null = null,
  dt = RACE_STEP,
  opts: StepOpts = {},
): void {
  const { spec, axes, maps, wastegateKpa } = env;
  car.t += dt;
  const green = car.t >= 0;
  const running = !car.blown;
  const braking = (opts.brake ?? false) && green;
  const thr = running && throttleHeld && !braking ? 1 : 0;
  car.throttle = thr;
  const dragScale = opts.dragScale ?? 1;
  const brakeForce = braking
    ? GEARBOX.massKg * 9.81 * (opts.brakeG ?? 1.1)
    : 0;

  // throttle → manifold pressure with turbo spool lag (same as live sim)
  const naPortion = 24 + thr * (98 - 24);
  const boostAvail = boostCeiling(spec, car.rpm, wastegateKpa) - 98;
  const boostPortion =
    Math.max(0, boostAvail) * clamp((thr - 0.55) / 0.45, 0, 1);
  const mapTarget = running ? naPortion + boostPortion : 100;
  const tau = mapTarget > car.mapKpa && car.mapKpa > 95 ? 0.3 : 0.09;
  car.mapKpa += (mapTarget - car.mapKpa) * clamp(dt / tau, 0, 1);

  // gear changes (torque cut while the box swaps cogs)
  const wantGear =
    gearSelect !== null && gearSelect !== car.gear
      ? clamp(Math.round(gearSelect), -1, GEARBOX.ratios.length - 1)
      : shiftUp && car.gear < GEARBOX.ratios.length - 1
        ? car.gear + 1
        : null;
  if (wantGear !== null && wantGear !== car.gear && green && running && car.shiftT <= 0) {
    car.gear = wantGear;
    car.shiftT = 0.22;
  }
  if (car.shiftT > 0) car.shiftT -= dt;

  // the ECU reads the player's maps exactly like the live sim does
  const pw = running ? lookup(maps.fuel, axes, car.rpm, car.mapKpa) : 0;
  const spark = lookup(maps.ign, axes, car.rpm, car.mapKpa);
  const r = simulatePoint(spec, Math.max(car.rpm, 500), car.mapKpa, pw, spark);
  car.afr = running ? r.afr : 14.7;
  car.duty = running ? r.duty : 0;
  car.spark = spark;
  car.egt += ((running ? r.egtTarget : 20) - car.egt) * clamp(dt / 1.8, 0, 1);

  let torque = running ? r.torque : 0;
  if (running && car.rpm > spec.revLimit) torque = -25; // fuel-cut limiter
  if (car.shiftT > 0) torque = Math.min(torque, 0);
  if (car.health < 50) torque *= 0.4 + 0.012 * car.health; // losing compression
  car.torqueNm = Math.max(0, torque);

  const neutral = car.gear < 0;
  const ratio = neutral ? 0 : GEARBOX.ratios[car.gear] * GEARBOX.final;
  const launch = launchRpm(spec);

  if (!green) {
    // staged: clutch in — revs build boost, wheels don't turn
    const target = running ? spec.idle + thr * (launch - spec.idle) : 0;
    car.rpm += (target - car.rpm) * clamp(dt * 6, 0, 1);
    car.v = 0;
    car.d = 0;
  } else if (neutral) {
    // nothing drives the wheels — coast and free-rev
    const drag = (0.42 * car.v ** 2 + 165) * dragScale + brakeForce;
    car.v = Math.max(0, car.v - (drag / GEARBOX.massKg) * dt);
    car.d += car.v * dt;
    const target = running
      ? spec.idle + thr * (Math.min(spec.revLimit, spec.redline + 200) - spec.idle)
      : 0;
    car.rpm += (target - car.rpm) * clamp(dt * 6, 0, 1);
  } else {
    const force =
      torque > 0 ? (torque * ratio * GEARBOX.driveline) / GEARBOX.wheelRadiusM : 0;
    const traction =
      1.12 * GEARBOX.massKg * 9.81 * (opts.tractionScale ?? 1); // grip cap
    const drive = Math.min(force, traction);
    const drag = (0.42 * car.v ** 2 + 165) * dragScale + brakeForce;
    const accel = (drive - (car.v > 0 ? drag : Math.min(drag, drive))) / GEARBOX.massKg;
    car.v = Math.max(0, car.v + accel * dt);
    car.d += car.v * dt;

    const rpmWheels = (car.v / GEARBOX.wheelRadiusM) * ratio * 9.549;
    if (running) {
      // clutch slips up to the launch target so you can leave the line
      const slipCeil = spec.idle + thr * (launch - spec.idle);
      car.rpm = Math.max(rpmWheels, Math.min(slipCeil, spec.revLimit));
    } else {
      car.rpm = rpmWheels;
    }
    // grabbing a low gear at speed spins the crank past the limiter —
    // mechanical over-rev, and no fuel cut can save you
    if (rpmWheels > spec.revLimit + 300) {
      car.rpm = rpmWheels;
      const dmg = (rpmWheels - spec.revLimit) * 0.25 * dt;
      car.health = clamp(car.health - dmg, 0, 100);
      if (car.health <= 0) car.blown = true;
    }
    car.rpm = Math.min(car.rpm, spec.revLimit + 1200);
  }

  // deterministic damage: knock and lean-under-boost hurt, just like the dyno
  car.knocking = running && r.knockSeverity > 0;
  if (running) {
    let dmg = 0;
    if (r.knockSeverity > 0) dmg += r.knockSeverity ** 1.5 * 2.4 * dt;
    if (r.afr > 15.2 && car.mapKpa > 120 && !r.misfire) {
      dmg += (r.afr - 15.2) * ((car.mapKpa - 120) / 80) * 1.3 * dt;
    }
    if (dmg > 0) {
      car.health = clamp(car.health - dmg, 0, 100);
      if (car.health <= 0) car.blown = true;
    }
  }

  // timing milestones
  const finishD = opts.finishD ?? QUARTER_MILE_M;
  if (car.sixtyFt === null && car.d >= SIXTY_FEET_M) car.sixtyFt = car.t;
  if (!car.finished && car.d >= finishD) {
    car.finished = true;
    const overshoot = car.d - finishD;
    car.et = car.t - (car.v > 0 ? overshoot / car.v : 0);
    car.trapKph = car.v * 3.6;
  }
}

/**
 * Pick the shift point from an instant dyno run of these exact maps: rev a
 * little past peak power, never into the limiter.
 */
export function computeShiftRpm(
  spec: EngineSpec,
  axes: Axes,
  maps: Maps,
  wastegateKpa: number,
): number {
  const run = runDyno(spec, axes, maps, wastegateKpa, 0);
  const peak = run.peakHp;
  const fade = run.points.find(
    (p) => p.rpm > peak.rpm && p.hp < peak.v * 0.955,
  );
  return Math.round(
    clamp(fade ? fade.rpm : spec.revLimit - 80, peak.rpm + 150, spec.revLimit - 60),
  );
}

// ---- ghost / AI opposition -------------------------------------------------

export interface GhostFrame {
  t: number;
  d: number;
  v: number;
  rpm: number;
  gear: number;
}

export interface GhostResult {
  frames: GhostFrame[]; // 30 Hz samples, t relative to green
  et: number | null;
  trapKph: number;
  sixtyFt: number | null;
  blown: boolean;
}

/**
 * Pre-run an AI car deterministically. `throttleFrom` is the race-clock time
 * the AI floors it (negative = pre-staged and spooling before the green).
 */
export function simulateGhost(env: RaceEnv, throttleFrom: number): GhostResult {
  const car = createRaceCar(env.spec, 100);
  const frames: GhostFrame[] = [];
  let i = 0;
  while (car.t < RACE_TIMEOUT) {
    const throttle = car.t >= throttleFrom;
    const shiftUp =
      car.t >= 0 &&
      car.shiftT <= 0 &&
      car.v > 2 &&
      car.rpm >= env.shiftRpm &&
      car.gear < GEARBOX.ratios.length - 1;
    stepRaceCar(car, env, throttle, shiftUp);
    if (i++ % 4 === 0) {
      frames.push({ t: car.t, d: car.d, v: car.v, rpm: car.rpm, gear: car.gear });
    }
    if (car.finished && car.t > (car.et ?? 0) + 1.5) break;
    if (car.blown && car.v < 2) break;
  }
  return {
    frames,
    et: car.et,
    trapKph: car.trapKph,
    sixtyFt: car.sixtyFt,
    blown: car.blown,
  };
}

export type AiLevel = "street" | "tuner" | "pro";

export const AI_LEVELS: {
  id: AiLevel;
  label: string;
  desc: string;
}[] = [
  {
    id: "street",
    label: "Street car",
    desc: "Factory base calibration, sleepy launch, short-shifts",
  },
  {
    id: "tuner",
    label: "Backyard tuner",
    desc: "Rich-and-safe tune with a mild boost bump",
  },
  {
    id: "pro",
    label: "Shop build",
    desc: "Pro calibration at max boost, pre-staged and ruthless",
  },
];

/** Same engine as the player — the difference is purely the tune. */
export function aiEnv(
  level: AiLevel,
  spec: EngineSpec,
  axes: Axes,
): { env: RaceEnv; throttleFrom: number } {
  const maxKpa = spec.turbo?.maxKpa ?? 100;
  const stockKpa = spec.turbo ? spec.stock.boostKpa : 100;
  let maps: Maps;
  let wg: number;
  let throttleFrom: number;
  let shiftBias = 1;
  if (level === "street") {
    maps = baseMaps(spec, axes);
    wg = stockKpa;
    throttleFrom = 0.45;
    shiftBias = 0.94; // lifts early
  } else if (level === "tuner") {
    maps = richSafeMaps(spec, axes);
    wg = Math.round(stockKpa + (maxKpa - stockKpa) * 0.55);
    throttleFrom = 0.22;
  } else {
    // margin 2° under the knock limit: fast AND survives a full pull clean
    maps = optimalMaps(spec, axes, 2);
    wg = maxKpa;
    throttleFrom = -STAGE_S; // staged, boost ready, perfect light
  }
  const shiftRpm = Math.round(
    computeShiftRpm(spec, axes, maps, wg) * shiftBias,
  );
  return { env: { spec, axes, maps, wastegateKpa: wg, shiftRpm }, throttleFrom };
}
