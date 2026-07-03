import { buildAxes, cloneGrid, type Axes } from "./axes";
import { baseMaps, optimalMaps, type Maps } from "./defaults";
import { getEngine, type EngineSpec } from "./engines";
import { runDyno, type DynoRun } from "./dyno";

export type ExerciseLevel = "beginner" | "intermediate" | "hard";

export interface GoalResult {
  label: string;
  pass: boolean;
  actual: string;
}

export interface Exercise {
  id: string;
  level: ExerciseLevel;
  title: string;
  engineId: string;
  /** validation dyno always runs at this manifold pressure */
  wastegateKpa: number;
  brief: string;
  hints: string[];
  /** builds the (usually sabotaged) starting maps */
  start: (spec: EngineSpec, axes: Axes) => Maps;
  /** graded against the player's run and the hidden pro reference run */
  goals: (run: DynoRun, ref: DynoRun, spec: EngineSpec) => GoalResult[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

// ---- shared goal builders ---------------------------------------------------

function goalPeakHp(run: DynoRun, ref: DynoRun, frac: number): GoalResult {
  const target = ref.peakHp.v * frac;
  return {
    label: `Peak power ≥ ${target.toFixed(0)} whp (${pct(frac)} of a pro tune)`,
    pass: run.peakHp.v >= target,
    actual: `${run.peakHp.v.toFixed(0)} whp @ ${run.peakHp.rpm} rpm`,
  };
}

function goalNoKnock(run: DynoRun): GoalResult {
  return {
    label: "Zero knock events on the pull",
    pass: run.knockEvents === 0,
    actual: run.knockEvents === 0 ? "clean" : `${run.knockEvents} knock events`,
  };
}

function goalNoDamage(run: DynoRun): GoalResult {
  return {
    label: "No engine damage during the pull",
    pass: run.damage < 0.05,
    actual: run.damage < 0.05 ? "healthy" : `-${run.damage.toFixed(1)}% health`,
  };
}

function goalAfrWindow(run: DynoRun, lo: number, hi: number): GoalResult {
  return {
    label: `WOT AFR stays between ${lo.toFixed(1)} and ${hi.toFixed(1)}`,
    pass: run.minAfr >= lo && run.maxAfr <= hi,
    actual: `${run.minAfr.toFixed(1)} – ${run.maxAfr.toFixed(1)}`,
  };
}

function goalMaxDuty(run: DynoRun, limit: number): GoalResult {
  return {
    label: `Injector duty ≤ ${limit}%`,
    pass: run.maxDuty <= limit,
    actual: `${run.maxDuty.toFixed(1)}%`,
  };
}

/** mean |AFR − target| over the boosted/WOT part of the pull */
function afrTracking(run: DynoRun): number {
  const pts = run.points.filter((p) => p.mapKpa > 92);
  if (!pts.length) return 99;
  return pts.reduce((a, p) => a + Math.abs(p.afr - p.afrTarget), 0) / pts.length;
}

// ---- the curriculum ---------------------------------------------------------

export const EXERCISES: Exercise[] = [
  // ---------------- beginner ----------------
  {
    id: "b1-rich",
    level: "beginner",
    title: "Drowning in fuel",
    engineId: "st2006",
    wastegateKpa: 155,
    brief:
      "The previous owner added 22% fuel everywhere \"for safety\". It's rich, sooty and slow down low. Get the wideband readings back into the power window without leaning it into danger.",
    hints: [
      "Run a dyno pull, then open the Fuel map with the AFR log overlay — rich cells read below target.",
      "Select the logged region and use the AFR correction tool: it rescales pulse width by measured ÷ target.",
      "Two or three log-correct cycles converge quickly. Watch the low-rpm boost cells — that's where it's richest.",
    ],
    start: (spec, axes) => {
      const m = baseMaps(spec, axes);
      m.fuel = m.fuel.map((row) => row.map((v) => Math.round(v * 1.22 * 100) / 100));
      return m;
    },
    goals: (run, ref) => [
      goalAfrWindow(run, 11.6, 13.4),
      goalPeakHp(run, ref, 0.87),
      goalNoKnock(run),
    ],
  },
  {
    id: "b2-lean",
    level: "beginner",
    title: "The lean patch",
    engineId: "b48",
    wastegateKpa: 175,
    brief:
      "Someone \"optimised\" the top-right of the fuel map and now it goes dangerously lean exactly where the engine breathes hardest. Lean under boost melts pistons — find it and feed it.",
    hints: [
      "The dyno AFR strip turns hot past 4000 rpm. That region needs more pulse width, not less.",
      "The base calibration is already lean at the VE peak — the sabotage made it worse. Correct against the log.",
      "The goal isn't max power — it's a pull that does zero damage.",
    ],
    start: (spec, axes) => {
      const m = baseMaps(spec, axes);
      m.fuel = m.fuel.map((row, li) =>
        row.map((v, ri) =>
          axes.rpm[ri] >= 4000 && axes.load[li] >= 120
            ? Math.round(v * 0.88 * 100) / 100
            : v,
        ),
      );
      return m;
    },
    goals: (run, ref) => [
      {
        label: "No WOT cell leaner than 13.2 AFR",
        pass: run.maxAfr <= 13.2,
        actual: `leanest ${run.maxAfr.toFixed(1)}`,
      },
      goalNoDamage(run),
      goalPeakHp(run, ref, 0.85),
    ],
  },
  {
    id: "b3-spark",
    level: "beginner",
    title: "Wake-up call",
    engineId: "k20",
    wastegateKpa: 100,
    brief:
      "This K20 arrived with 9° pulled out of the whole ignition map — it drives like a diesel. Put timing back in and chase MBT, but naturally aspirated ≠ knock-proof.",
    hints: [
      "More advance = more torque until MBT; past the knock limit = damage. Add timing in 2° passes and re-pull.",
      "High load + high rpm cells are the ones that knock first. The knock dots on the dyno trace show exactly where.",
      "Fueling matters too: the flat-VE base cal runs lean at high rpm, and lean mixtures knock earlier.",
    ],
    start: (spec, axes) => {
      const m = baseMaps(spec, axes);
      m.ign = m.ign.map((row) =>
        row.map((v) => Math.round(Math.max(4, v - 9) * 10) / 10),
      );
      return m;
    },
    goals: (run, ref) => [goalPeakHp(run, ref, 0.9), goalNoKnock(run)],
  },

  // ---------------- intermediate ----------------
  {
    id: "i1-power",
    level: "intermediate",
    title: "The customer wants power",
    engineId: "2jz",
    wastegateKpa: 200,
    brief:
      "A 2JZ shows up on the base calibration and the customer has paid for a 200 kPa tune. Build fuel and timing for real boost: hit the power target with zero knock and headroom on the injectors.",
    hints: [
      "Start with fuel: correct AFR against the log until the boost rows track target, then add timing carefully.",
      "Under boost the knock limit sits below MBT — richer mixtures buy back a few degrees.",
      "Injector duty climbs with boost. If you're near the duty ceiling, you can't just add fuel forever.",
    ],
    start: (spec, axes) => baseMaps(spec, axes),
    goals: (run, ref) => [
      goalPeakHp(run, ref, 0.93),
      goalNoKnock(run),
      goalMaxDuty(run, 96),
      goalNoDamage(run),
    ],
  },
  {
    id: "i2-torque",
    level: "intermediate",
    title: "Torque by 3200",
    engineId: "stmk45",
    wastegateKpa: 185,
    brief:
      "Daily-driver brief: the owner doesn't care about the top end, they want the shove NOW. Maximise torque in the 2000–3400 rpm window — spool, fueling and timing all matter down low.",
    hints: [
      "The small turbo is at full boost by ~3100 rpm. Everything below that is about how well you use partial boost rows.",
      "MBT timing at low rpm/high load is modest — but the base cal gives away 4–6° there.",
      "Check the torque curve, not the power number: peak torque should land early.",
    ],
    start: (spec, axes) => baseMaps(spec, axes),
    goals: (run, ref) => {
      const early = (r: DynoRun) =>
        Math.max(...r.points.filter((p) => p.rpm <= 3400).map((p) => p.torque));
      const target = early(ref) * 0.92;
      return [
        {
          label: `≥ ${target.toFixed(0)} wheel Nm at or before 3400 rpm`,
          pass: early(run) >= target,
          actual: `${early(run).toFixed(0)} Nm`,
        },
        goalNoKnock(run),
        goalNoDamage(run),
      ];
    },
  },
  {
    id: "i3-afr",
    level: "intermediate",
    title: "On target",
    engineId: "gryaris",
    wastegateKpa: 240,
    brief:
      "Precision drill on the angry three-pot: make the measured AFR track your target map within ±0.35 across the whole WOT pull. This is the discipline every fast, safe tune is built on.",
    hints: [
      "The AFR correction tool converges fastest when the log covers every column — do a full pull first.",
      "Cells between grid points interpolate: a big step between neighbours makes the line weave around target.",
      "Smooth maps track better than jagged ones. Blend cell edges by hand after correcting.",
    ],
    start: (spec, axes) => baseMaps(spec, axes),
    goals: (run, ref) => {
      const dev = afrTracking(run);
      return [
        {
          label: "Mean AFR error vs target ≤ 0.35 at WOT",
          pass: dev <= 0.35,
          actual: `±${dev.toFixed(2)}`,
        },
        goalNoKnock(run),
        goalPeakHp(run, ref, 0.9),
      ];
    },
  },

  // ---------------- hard ----------------
  {
    id: "h1-max",
    level: "hard",
    title: "King of the dyno",
    engineId: "2jz",
    wastegateKpa: 220,
    brief:
      "Full send: 220 kPa on the iron-block legend. Get within 2.5% of a professional calibration — that means exact-VE fueling AND timing parked a hair under the knock limit in every cell.",
    hints: [
      "Power AFR is ~12.6–12.9 under boost. Leaner makes more torque per gram but knocks sooner.",
      "Approach the knock limit from below, half a degree at a time, cell by cell. One knocking cell fails the run.",
      "Remember spark interpolates between cells — a safe cell next to an aggressive one can still knock mid-span.",
    ],
    start: (spec, axes) => baseMaps(spec, axes),
    goals: (run, ref) => [
      goalPeakHp(run, ref, 0.975),
      goalNoKnock(run),
      goalMaxDuty(run, 98),
      goalNoDamage(run),
    ],
  },
  {
    id: "h2-edge",
    level: "hard",
    title: "260 kPa knife-edge",
    engineId: "gryaris",
    wastegateKpa: 260,
    brief:
      "Max boost on the GR Yaris. The knock limit is deep below MBT, the injectors are nearly maxed, and one lean cell will torch a piston. Thread the needle.",
    hints: [
      "At 260 kPa the injectors run out near redline — you may have to accept a slightly leaner (but safe) top row target.",
      "Rich mixtures cool the chamber: at this boost, fuel IS your knock margin.",
      "Watch duty on every pull. Past ~99% the pulse width physically can't fit in the cycle.",
    ],
    start: (spec, axes) => baseMaps(spec, axes),
    goals: (run, ref) => [
      goalPeakHp(run, ref, 0.95),
      goalNoKnock(run),
      goalMaxDuty(run, 99),
      goalNoDamage(run),
    ],
  },
  {
    id: "h3-na",
    level: "hard",
    title: "MBT sniper",
    engineId: "k20",
    wastegateKpa: 100,
    brief:
      "No boost to hide behind: on the K20 every last percent comes from surgically exact fuel and spark. Land within 1.5% of the pro reference with a mixture that stays in the efficiency window.",
    hints: [
      "NA MBT is mostly reachable without knock — the game is hitting it exactly, everywhere the pull passes through.",
      "Best-torque AFR is about 12.8; the goals require you to stay between 12.3 and 13.6 at WOT.",
      "The VTEC VE step past 6000 rpm is where flat-VE fueling falls apart. Fix that region first.",
    ],
    start: (spec, axes) => baseMaps(spec, axes),
    goals: (run, ref) => [
      goalPeakHp(run, ref, 0.985),
      goalAfrWindow(run, 12.3, 13.6),
      goalNoKnock(run),
    ],
  },
];

export const LEVELS: { id: ExerciseLevel; label: string; blurb: string }[] = [
  {
    id: "beginner",
    label: "Beginner",
    blurb: "Learn the instruments: read the wideband, fix fuel, add timing safely.",
  },
  {
    id: "intermediate",
    label: "Intermediate",
    blurb: "Build real tunes to a brief: power targets, torque targets, AFR discipline.",
  },
  {
    id: "hard",
    label: "Hard",
    blurb: "Within a few percent of a pro calibration. One knocking cell fails you.",
  },
];

export const exerciseById = (id: string | null) =>
  EXERCISES.find((e) => e.id === id) ?? null;

export interface ExerciseEval {
  run: DynoRun;
  goals: GoalResult[];
  passed: boolean;
}

const refCache = new Map<string, DynoRun>();

/**
 * The hidden pro-reference run this exercise is graded against: the most
 * aggressive `optimalMaps` timing margin that still pulls completely clean.
 * (Cell values interpolate between grid points, so a fixed razor-thin margin
 * can knock mid-span on some engines/boost levels.)
 */
function referenceRun(ex: Exercise): DynoRun {
  let ref = refCache.get(ex.id);
  if (!ref) {
    const spec = getEngine(ex.engineId);
    const axes = buildAxes(spec);
    for (const margin of [1, 1.5, 2, 2.5, 3, 4]) {
      ref = runDyno(spec, axes, optimalMaps(spec, axes, margin), ex.wastegateKpa, -1);
      if (ref.knockEvents === 0 && ref.damage < 0.05) break;
    }
    refCache.set(ex.id, ref!);
  }
  return ref!;
}

/** Grade the player's current maps. Pure — no damage, no log side effects. */
export function evaluateExercise(ex: Exercise, maps: Maps): ExerciseEval {
  const spec = getEngine(ex.engineId);
  const axes = buildAxes(spec);
  const safeMaps: Maps = {
    fuel: cloneGrid(maps.fuel),
    ign: cloneGrid(maps.ign),
    afrTarget: cloneGrid(maps.afrTarget),
  };
  const run = runDyno(spec, axes, safeMaps, ex.wastegateKpa, Date.now() % 1e6);
  const goals = ex.goals(run, referenceRun(ex), spec);
  return { run, goals, passed: goals.every((g) => g.pass) };
}
