import { clamp } from "./axes";
import {
  createRaceCar,
  RACE_STEP,
  stepRaceCar,
  type AiLevel,
  type GhostFrame,
  type GhostResult,
  type RaceEnv,
} from "./race";
import { GEARBOX } from "./engines";

/**
 * Random-circuit race mode. A circuit is a 1-D lap: straights punctuated by
 * corners, each corner a speed ceiling. Carry too much speed in and you run
 * wide; nail the entry and you get a perfect-exit. Everything derives from
 * one integer seed so multiplayer clients build the identical track.
 */

export type RaceMode = "drag" | "circuit";
export type Weather = "dry" | "damp" | "wet";

export interface Corner {
  n: number; // T1, T2, …
  at: number; // lap-metres where it starts
  len: number;
  vMax: number; // m/s ceiling through the corner (grip already applied)
  kind: "hairpin" | "chicane" | "corner" | "sweeper";
}

export interface Circuit {
  seed: number;
  name: string;
  weather: Weather;
  /** grip multiplier — scales corner speed, traction and brakes */
  grip: number;
  lapM: number;
  laps: number;
  corners: Corner[];
}

/** a circuit race can't run forever — clock caps at 6 minutes */
export const CIRCUIT_TIMEOUT = 360;
export const CIRCUIT_LAPS = 2;

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME_A = [
  "Arai", "Blackwood", "Cedar", "Dunmore", "Eagle", "Fujimi", "Granite",
  "Hollow", "Ivora", "Kestrel", "Lunar", "Maple", "Nordvik", "Okami",
  "Pinehurst", "Quarry", "Ravenna", "Sakura", "Thistle", "Vantage",
];
const NAME_B = [
  "Park", "Ring", "Raceway", "Circuit", "GP", "Speedpark", "Sprint",
  "International", "Club", "Hillside",
];

export function generateCircuit(seed: number, laps = CIRCUIT_LAPS): Circuit {
  const rnd = mulberry32(seed || 1);

  const wRoll = rnd();
  const weather: Weather = wRoll < 0.62 ? "dry" : wRoll < 0.88 ? "damp" : "wet";
  const grip = weather === "dry" ? 1 : weather === "damp" ? 0.87 : 0.75;

  const nCorners = 5 + Math.floor(rnd() * 5); // 5–9 turns
  const corners: Corner[] = [];
  let d = 150 + rnd() * 250; // opening straight off the grid

  for (let i = 0; i < nCorners; i++) {
    const roll = rnd();
    let kind: Corner["kind"];
    let vBase: number;
    let len: number;
    if (roll < 0.2) {
      kind = "hairpin";
      vBase = 16 + rnd() * 6; // ~36–49 mph
      len = 60 + rnd() * 40;
    } else if (roll < 0.42) {
      kind = "chicane";
      vBase = 26 + rnd() * 8;
      len = 90 + rnd() * 60;
    } else if (roll < 0.78) {
      kind = "corner";
      vBase = 33 + rnd() * 12;
      len = 80 + rnd() * 70;
    } else {
      kind = "sweeper";
      vBase = 48 + rnd() * 15; // ~107–140 mph
      len = 150 + rnd() * 120;
    }
    corners.push({
      n: i + 1,
      at: Math.round(d),
      len: Math.round(len),
      vMax: vBase * grip,
      kind,
    });
    d += len + 160 + rnd() * 430; // straight to the next one
  }

  return {
    seed,
    name: `${NAME_A[Math.floor(rnd() * NAME_A.length)]} ${NAME_B[Math.floor(rnd() * NAME_B.length)]}`,
    weather,
    grip,
    lapM: Math.round(d + 60),
    laps,
    corners,
  };
}

export interface CircuitEvent {
  kind: "wide" | "perfect" | "lap";
  t: number;
  text: string;
}

export interface CircuitState {
  lap: number; // completed laps
  lapStartT: number;
  lastLap: number | null;
  bestLap: number | null;
  offT: number; // seconds left bouncing across the grass
  cornerN: number; // corner currently occupied (-1 = straight)
  entryClean: boolean; // carried ≥96% of vMax in without running wide
  wideCount: number;
  perfect: number;
  event: CircuitEvent | null;
  finished: boolean;
}

export function createCircuitState(): CircuitState {
  return {
    lap: 0,
    lapStartT: 0,
    lastLap: null,
    bestLap: null,
    offT: 0,
    cornerN: -1,
    entryClean: false,
    wideCount: 0,
    perfect: 0,
    event: null,
    finished: false,
  };
}

export const cornerAt = (cir: Circuit, pos: number): Corner | null =>
  cir.corners.find((c) => pos >= c.at && pos < c.at + c.len) ?? null;

/** the next corner ahead of lap-position `pos` (wrapping) + distance to it */
export function nextCorner(cir: Circuit, pos: number): { c: Corner; dist: number } {
  for (const c of cir.corners) {
    if (c.at + c.len > pos) {
      return { c, dist: Math.max(0, c.at - pos) };
    }
  }
  return { c: cir.corners[0], dist: cir.lapM - pos + cir.corners[0].at };
}

/** metres needed to brake from v to vt at this grip level (+ margin) */
export const brakeDistance = (v: number, vt: number, grip: number) =>
  v <= vt ? 0 : (v * v - vt * vt) / (2 * 9.4 * grip) + 8;

/**
 * Corner / lap bookkeeping, applied after every physics step. Mutates both
 * the car (speed clamps, finish) and the circuit state. Deterministic.
 */
export function stepCircuit(
  car: import("./race").RaceCar,
  cs: CircuitState,
  cir: Circuit,
  dt = RACE_STEP,
): void {
  if (cs.finished || car.t < 0) return;
  const pos = car.d % cir.lapM;
  const c = cornerAt(cir, pos);

  // running wide: dumped onto the grass, crawling back on line
  if (cs.offT > 0) {
    cs.offT -= dt;
    car.v = Math.min(car.v, (c?.vMax ?? 28) * 0.7);
  }

  if (c) {
    if (cs.cornerN !== c.n) {
      // corner entry
      cs.cornerN = c.n;
      if (car.v > c.vMax * 1.12) {
        // way too hot — run wide, big time loss
        cs.offT = 1.1;
        cs.wideCount++;
        cs.entryClean = false;
        car.v = c.vMax * 0.55;
        cs.event = {
          kind: "wide",
          t: car.t,
          text: `WIDE at T${c.n} — braked too late`,
        };
      } else {
        cs.entryClean = car.v >= c.vMax * 0.96;
      }
    }
    // tyres scrub any leftover excess down to the ceiling
    if (car.v > c.vMax) car.v = Math.max(c.vMax, car.v - 16 * dt);
  } else if (cs.cornerN !== -1) {
    // corner exit
    if (cs.entryClean && cs.offT <= 0) {
      cs.perfect++;
      cs.event = {
        kind: "perfect",
        t: car.t,
        text: `Perfect exit — T${cs.cornerN} ✓`,
      };
    }
    cs.cornerN = -1;
  }

  // lap line
  const lapNow = Math.floor(car.d / cir.lapM);
  if (lapNow > cs.lap) {
    const lapTime = car.t - cs.lapStartT;
    cs.lastLap = lapTime;
    if (cs.bestLap === null || lapTime < cs.bestLap) cs.bestLap = lapTime;
    cs.lap = lapNow;
    cs.lapStartT = car.t;
    if (cs.lap >= cir.laps) {
      cs.finished = true;
      car.finished = true;
      car.et = car.t; // total race time
      car.trapKph = car.v * 3.6;
    } else {
      cs.event = {
        kind: "lap",
        t: car.t,
        text: `Lap ${cs.lap}: ${lapTime.toFixed(2)}s`,
      };
    }
  }
}

/** step options shared by the player and the AI on a given circuit */
export function circuitOpts(cir: Circuit, slipstream: boolean) {
  return {
    finishD: Infinity,
    tractionScale: cir.grip,
    brakeG: 1.15 * cir.grip,
    dragScale: slipstream ? 0.62 : 1,
  };
}

/** how close to the corner ceiling each AI level dares to run */
const AI_AGGR: Record<AiLevel, number> = {
  street: 0.86,
  tuner: 0.94,
  pro: 1.0,
};

export interface CircuitGhostResult extends GhostResult {
  bestLap: number | null;
}

/** Pre-run an AI lap set deterministically on the same circuit. */
export function simulateCircuitGhost(
  env: RaceEnv,
  cir: Circuit,
  level: AiLevel,
  throttleFrom: number,
): CircuitGhostResult {
  const aggr = AI_AGGR[level];
  const car = createRaceCar(env.spec, 100);
  const cs = createCircuitState();
  const frames: GhostFrame[] = [];
  const opts = circuitOpts(cir, false);
  let i = 0;

  while (car.t < CIRCUIT_TIMEOUT) {
    let throttle = car.t >= throttleFrom;
    let brake = false;
    if (car.t >= 0 && !cs.finished) {
      const pos = car.d % cir.lapM;
      const inC = cornerAt(cir, pos);
      const { c, dist } = nextCorner(cir, pos);
      const target = c.vMax * aggr;
      if (inC && car.v > inC.vMax * aggr) {
        brake = true;
        throttle = false;
      } else if (!inC && car.v > target && dist <= brakeDistance(car.v, target, cir.grip)) {
        brake = true;
        throttle = false;
      }
    }
    const shiftUp =
      car.t >= 0 &&
      car.shiftT <= 0 &&
      car.v > 2 &&
      !brake &&
      car.rpm >= env.shiftRpm &&
      car.gear < GEARBOX.ratios.length - 1;
    // grab a lower gear out of slow corners when it won't over-rev
    let gearSel: number | null = null;
    if (
      !shiftUp &&
      car.t >= 0 &&
      car.shiftT <= 0 &&
      car.gear > 0 &&
      car.v > 3 &&
      car.rpm < env.shiftRpm * 0.45
    ) {
      const rpmAfter =
        (car.v / GEARBOX.wheelRadiusM) *
        GEARBOX.ratios[car.gear - 1] *
        GEARBOX.final *
        9.549;
      if (rpmAfter < env.spec.revLimit * 0.9) gearSel = car.gear - 1;
    }
    stepRaceCar(car, env, throttle, shiftUp, gearSel, RACE_STEP, {
      ...opts,
      brake,
    });
    stepCircuit(car, cs, cir);
    if (i++ % 4 === 0) {
      frames.push({ t: car.t, d: car.d, v: car.v, rpm: car.rpm, gear: car.gear });
    }
    if (cs.finished && car.t > (car.et ?? 0) + 1.5) break;
    if (car.blown && car.v < 2) break;
  }

  return {
    frames,
    et: car.et,
    trapKph: car.trapKph,
    sixtyFt: car.sixtyFt,
    blown: car.blown,
    bestLap: cs.bestLap,
  };
}

export const weatherLabel = (w: Weather) =>
  w === "dry" ? "☀️ Dry" : w === "damp" ? "🌦 Damp" : "🌧 Wet";

/** corner band color by how slow it forces you — red = big stop */
export function cornerColor(c: Corner, grip: number): string {
  const t = clamp((c.vMax / grip - 16) / 47, 0, 1); // 0 hairpin → 1 sweeper
  return `hsl(${Math.round(8 + t * 130)} 65% 45%)`;
}
