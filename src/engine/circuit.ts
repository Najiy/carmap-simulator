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
 * Random-sprint race mode: a point-to-point course run once. Straights
 * punctuated by corners, each corner a speed ceiling — brake in time or run
 * wide. Everything derives from one integer seed so multiplayer clients
 * build the identical course.
 */

export type RaceMode = "drag" | "sprint";
export type Weather = "dry" | "damp" | "wet";

export interface Corner {
  n: number; // T1, T2, …
  at: number; // metres from the start where it begins
  len: number;
  vMax: number; // m/s ceiling through the corner (grip already applied)
  kind: "hairpin" | "chicane" | "corner" | "sweeper";
}

export interface Sprint {
  seed: number;
  name: string;
  weather: Weather;
  /** grip multiplier — scales corner speed, traction and brakes */
  grip: number;
  lengthM: number;
  corners: Corner[];
}

/** a sprint can't run forever — clock caps at 4 minutes */
export const SPRINT_TIMEOUT = 240;

/** full-braking decel on this surface, m/s² (must match brakeG below) */
export const brakeDecel = (grip: number) => 9.4 * grip;

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
  "Pass", "Run", "Stage", "Sprint", "Climb", "Descent", "Straights",
  "Backroad", "Coast Road", "Ridge",
];

export function generateSprint(seed: number): Sprint {
  const rnd = mulberry32(seed || 1);

  const wRoll = rnd();
  const weather: Weather = wRoll < 0.62 ? "dry" : wRoll < 0.88 ? "damp" : "wet";
  const grip = weather === "dry" ? 1 : weather === "damp" ? 0.87 : 0.75;

  const nCorners = 5 + Math.floor(rnd() * 5); // 5–9 turns
  const corners: Corner[] = [];
  let d = 250 + rnd() * 300; // opening straight off the line

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
    d += len + 170 + rnd() * 400; // straight to the next one
  }

  return {
    seed,
    name: `${NAME_A[Math.floor(rnd() * NAME_A.length)]} ${NAME_B[Math.floor(rnd() * NAME_B.length)]}`,
    weather,
    grip,
    lengthM: Math.round(d + 150), // flat-out run to the flag
    corners,
  };
}

export interface SprintEvent {
  kind: "wide" | "perfect";
  t: number;
  text: string;
}

export interface SprintState {
  offT: number; // seconds left bouncing across the grass
  cornerN: number; // corner currently occupied (-1 = straight)
  entryClean: boolean; // carried ≥96% of vMax in without running wide
  wideCount: number;
  perfect: number;
  event: SprintEvent | null;
}

export function createSprintState(): SprintState {
  return {
    offT: 0,
    cornerN: -1,
    entryClean: false,
    wideCount: 0,
    perfect: 0,
    event: null,
  };
}

export const cornerAt = (spr: Sprint, pos: number): Corner | null =>
  spr.corners.find((c) => pos >= c.at && pos < c.at + c.len) ?? null;

/** the next corner ahead of position `pos`, or null when it's flag-out */
export function nextCorner(
  spr: Sprint,
  pos: number,
): { c: Corner; dist: number } | null {
  for (const c of spr.corners) {
    if (c.at + c.len > pos) {
      return { c, dist: Math.max(0, c.at - pos) };
    }
  }
  return null;
}

/** metres needed to brake from v to vt at this grip level (+ margin) */
export const brakeDistance = (v: number, vt: number, grip: number) =>
  v <= vt ? 0 : (v * v - vt * vt) / (2 * brakeDecel(grip)) + 8;

/** entry speed if you brake flat-out from here to the corner, m/s */
export const projectedEntry = (v: number, dist: number, grip: number) =>
  Math.sqrt(Math.max(0, v * v - 2 * brakeDecel(grip) * Math.max(0, dist - 4)));

/**
 * Corner bookkeeping, applied after every physics step. The finish line
 * itself is handled by stepRaceCar via finishD. Deterministic.
 */
export function stepSprint(
  car: import("./race").RaceCar,
  ss: SprintState,
  spr: Sprint,
  dt = RACE_STEP,
): void {
  if (car.finished || car.t < 0) return;
  const pos = car.d;
  const c = cornerAt(spr, pos);

  // running wide: dumped onto the grass, crawling back on line
  if (ss.offT > 0) {
    ss.offT -= dt;
    car.v = Math.min(car.v, (c?.vMax ?? 28) * 0.7);
  }

  if (c) {
    if (ss.cornerN !== c.n) {
      // corner entry
      ss.cornerN = c.n;
      if (car.v > c.vMax * 1.12) {
        // way too hot — run wide, big time loss
        ss.offT = 1.1;
        ss.wideCount++;
        ss.entryClean = false;
        car.v = c.vMax * 0.55;
        ss.event = {
          kind: "wide",
          t: car.t,
          text: `WIDE at T${c.n} — braked too late`,
        };
      } else {
        ss.entryClean = car.v >= c.vMax * 0.96;
      }
    }
    // tyres scrub any leftover excess down to the ceiling
    if (car.v > c.vMax) car.v = Math.max(c.vMax, car.v - 16 * dt);
  } else if (ss.cornerN !== -1) {
    // corner exit
    if (ss.entryClean && ss.offT <= 0) {
      ss.perfect++;
      ss.event = {
        kind: "perfect",
        t: car.t,
        text: `Perfect exit — T${ss.cornerN} ✓`,
      };
    }
    ss.cornerN = -1;
  }
}

/** step options shared by the player and the AI on a given sprint */
export function sprintOpts(spr: Sprint, slipstream: boolean) {
  return {
    finishD: spr.lengthM,
    tractionScale: spr.grip,
    brakeG: (brakeDecel(spr.grip) / 9.81) * 1.2, // pedal has margin over the planner
    dragScale: slipstream ? 0.62 : 1,
  };
}

/** how close to the corner ceiling each AI level dares to run */
const AI_AGGR: Record<AiLevel, number> = {
  street: 0.86,
  tuner: 0.94,
  pro: 1.0,
};

/** Pre-run an AI sprint deterministically on the same course. */
export function simulateSprintGhost(
  env: RaceEnv,
  spr: Sprint,
  level: AiLevel,
  throttleFrom: number,
): GhostResult {
  const aggr = AI_AGGR[level];
  const car = createRaceCar(env.spec, 100);
  const ss = createSprintState();
  const frames: GhostFrame[] = [];
  const opts = sprintOpts(spr, false);
  let i = 0;

  while (car.t < SPRINT_TIMEOUT) {
    let throttle = car.t >= throttleFrom;
    let brake = false;
    if (car.t >= 0 && !car.finished) {
      const inC = cornerAt(spr, car.d);
      const nxt = nextCorner(spr, car.d);
      if (inC && car.v > inC.vMax * aggr) {
        brake = true;
        throttle = false;
      } else if (nxt) {
        const target = nxt.c.vMax * aggr;
        if (car.v > target && nxt.dist <= brakeDistance(car.v, target, spr.grip)) {
          brake = true;
          throttle = false;
        }
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
    stepSprint(car, ss, spr);
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

export const weatherLabel = (w: Weather) =>
  w === "dry" ? "☀️ Dry" : w === "damp" ? "🌦 Damp" : "🌧 Wet";

/** corner band color by how slow it forces you — red = big stop */
export function cornerColor(c: Corner, grip: number): string {
  const t = clamp((c.vMax / grip - 16) / 47, 0, 1); // 0 hairpin → 1 sweeper
  return `hsl(${Math.round(8 + t * 130)} 65% 45%)`;
}
