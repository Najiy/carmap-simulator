/**
 * The engine catalog. Numbers are tuned for plausible dyno figures and
 * character, not certified specs — each engine gets its own breathing
 * (VE curve), turbo, injectors, friction, knock tolerance, and voice.
 */

export interface TurboSpec {
  maxKpa: number; // absolute manifold pressure ceiling
  spoolStart: number; // rpm where boost begins
  spoolSpan: number; // rpm span from first boost to full boost
}

export interface EngineSpec {
  id: string;
  name: string;
  desc: string;
  dispL: number;
  ncyl: number;
  idle: number;
  redline: number;
  revLimit: number;
  injGramsPerMs: number;
  injDeadtimeMs: number;
  /** true volumetric efficiency vs rpm — hidden from the ECU */
  veCurve: [number, number][];
  turbo: TurboSpec | null;
  thermalEff: number;
  /** friction Nm = a + b·rpm + c·(rpm/1000)² */
  friction: [number, number, number];
  /** degrees added to the knock threshold (block/head robustness) */
  knockMargin: number;
  inertia: number; // kg·m², crank + flywheel
  /** factory ratings (crank) — the base calibration is fitted to these */
  stock: { hp: number; nm: number; boostKpa: number };
  sound: {
    half: number; // 0..1 — half-order lumpiness (3/5-cyl character)
    bright: number; // 0..1 — high-harmonic content
  };
}

export const ENGINES: EngineSpec[] = [
  {
    id: "st2006",
    name: "Focus ST '06 — 2.5 I5 turbo",
    desc: "Volvo five-pot warble, torquey low-mid, soft top end",
    dispL: 2.5,
    ncyl: 5,
    idle: 850,
    redline: 6500,
    revLimit: 6700,
    injGramsPerMs: 0.0065,
    injDeadtimeMs: 1.0,
    veCurve: [
      [800, 0.66],
      [1600, 0.74],
      [2400, 0.82],
      [3200, 0.88],
      [4000, 0.92],
      [4800, 0.905],
      [5600, 0.86],
      [6200, 0.807],
      [6700, 0.755],
    ],
    turbo: { maxKpa: 200, spoolStart: 1900, spoolSpan: 1900 },
    thermalEff: 0.464,
    friction: [9, 0.0045, 0.75],
    knockMargin: 0,
    inertia: 0.5,
    stock: { hp: 225, nm: 320, boostKpa: 155 },
    sound: { half: 0.55, bright: 0.45 },
  },
  {
    id: "2jz",
    name: "2JZ-GTE — 3.0 I6 twin turbo",
    desc: "Iron-block legend: huge knock tolerance, takes big boost",
    dispL: 3.0,
    ncyl: 6,
    idle: 800,
    redline: 6800,
    revLimit: 7200,
    injGramsPerMs: 0.008,
    injDeadtimeMs: 1.0,
    veCurve: [
      [800, 0.6],
      [1600, 0.68],
      [2400, 0.77],
      [3200, 0.85],
      [4200, 0.9],
      [4800, 0.907],
      [5600, 0.861],
      [6400, 0.79],
      [7200, 0.707],
    ],
    turbo: { maxKpa: 220, spoolStart: 1800, spoolSpan: 2200 },
    thermalEff: 0.459,
    friction: [10, 0.005, 0.8],
    knockMargin: 2,
    inertia: 0.6,
    stock: { hp: 320, nm: 440, boostKpa: 180 },
    sound: { half: 0.15, bright: 0.5 },
  },
  {
    id: "rb26",
    name: "RB26DETT — 2.6 I6 twin turbo",
    desc: "Lives up top: revs to 8000, VE peaks past 5500",
    dispL: 2.6,
    ncyl: 6,
    idle: 950,
    redline: 8000,
    revLimit: 8200,
    injGramsPerMs: 0.0081,
    injDeadtimeMs: 1.0,
    veCurve: [
      [800, 0.58],
      [2000, 0.68],
      [3000, 0.78],
      [4000, 0.86],
      [5000, 0.911],
      [5600, 0.885],
      [6400, 0.795],
      [7200, 0.7],
      [8200, 0.574],
    ],
    turbo: { maxKpa: 220, spoolStart: 2600, spoolSpan: 1900 },
    thermalEff: 0.485,
    friction: [9, 0.0045, 0.72],
    knockMargin: 1,
    inertia: 0.45,
    stock: { hp: 280, nm: 370, boostKpa: 170 },
    sound: { half: 0.2, bright: 0.7 },
  },
  {
    id: "k20",
    name: "K20A — 2.0 I4 NA (VTEC)",
    desc: "No boost, 8600 rpm, VE jumps when the big cam engages",
    dispL: 2.0,
    ncyl: 4,
    idle: 900,
    redline: 8200,
    revLimit: 8600,
    injGramsPerMs: 0.0044,
    injDeadtimeMs: 0.9,
    veCurve: [
      [800, 0.6],
      [1600, 0.68],
      [2400, 0.76],
      [3200, 0.82],
      [4000, 0.86],
      [4800, 0.88],
      [5600, 0.894],
      [6000, 0.949],
      [6800, 0.988],
      [7600, 0.986],
      [8600, 0.935],
    ],
    turbo: null,
    thermalEff: 0.568,
    friction: [5, 0.0025, 0.38],
    knockMargin: -1,
    inertia: 0.35,
    stock: { hp: 220, nm: 215, boostKpa: 100 },
    sound: { half: 0.25, bright: 0.8 },
  },
  {
    id: "coyote",
    name: "Coyote 5.0 — 5.0 V8 NA (Gen 3)",
    desc: "Cross-plane Mustang V8: torque everywhere, pulls hard to 7500",
    dispL: 5.0,
    ncyl: 8,
    idle: 750,
    redline: 7400,
    revLimit: 7500,
    injGramsPerMs: 0.005,
    injDeadtimeMs: 1.0,
    veCurve: [
      [800, 0.62],
      [1600, 0.72],
      [2400, 0.864],
      [3200, 0.929],
      [4000, 0.961],
      [4600, 0.972],
      [5600, 0.956],
      [6400, 0.85],
      [7500, 0.77],
    ],
    turbo: null,
    thermalEff: 0.565,
    friction: [12, 0.005, 0.9],
    knockMargin: -1,
    inertia: 0.7,
    stock: { hp: 460, nm: 569, boostKpa: 100 },
    sound: { half: 0.5, bright: 0.35 },
  },
  {
    id: "stmk45",
    name: "Focus ST Mk4.5 — 2.3 EcoBoost",
    desc: "Small turbo, instant spool, falls off after 5500",
    dispL: 2.3,
    ncyl: 4,
    idle: 800,
    redline: 6500,
    revLimit: 6800,
    injGramsPerMs: 0.007,
    injDeadtimeMs: 1.0,
    veCurve: [
      [800, 0.68],
      [1600, 0.78],
      [2400, 0.86],
      [3200, 0.9],
      [4000, 0.91],
      [4800, 0.882],
      [5600, 0.824],
      [6200, 0.754],
      [6800, 0.695],
    ],
    turbo: { maxKpa: 200, spoolStart: 1600, spoolSpan: 1500 },
    thermalEff: 0.595,
    friction: [9, 0.0045, 0.7],
    knockMargin: 0,
    inertia: 0.45,
    stock: { hp: 280, nm: 420, boostKpa: 175 },
    sound: { half: 0.3, bright: 0.5 },
  },
  {
    id: "b48",
    name: "BMW B48 — 2.0 I4 turbo",
    desc: "Efficient and unfussy; modest wastegate ceiling",
    dispL: 2.0,
    ncyl: 4,
    idle: 750,
    redline: 6500,
    revLimit: 7000,
    injGramsPerMs: 0.0061,
    injDeadtimeMs: 1.0,
    veCurve: [
      [800, 0.67],
      [1600, 0.76],
      [2400, 0.84],
      [3200, 0.89],
      [4000, 0.91],
      [4800, 0.868],
      [5600, 0.8],
      [6400, 0.718],
      [7000, 0.659],
    ],
    turbo: { maxKpa: 200, spoolStart: 1600, spoolSpan: 1400 },
    thermalEff: 0.655,
    friction: [8, 0.004, 0.65],
    knockMargin: 0,
    inertia: 0.4,
    stock: { hp: 258, nm: 400, boostKpa: 175 },
    sound: { half: 0.2, bright: 0.4 },
  },
  {
    id: "gryaris",
    name: "GR Yaris G16E-GTS — 1.6 I3 turbo",
    desc: "Angry three-pot: lumpy idle, big boost from tiny displacement",
    dispL: 1.6,
    ncyl: 3,
    idle: 900,
    redline: 7000,
    revLimit: 7200,
    injGramsPerMs: 0.0073,
    injDeadtimeMs: 0.9,
    veCurve: [
      [800, 0.64],
      [1600, 0.72],
      [2400, 0.8],
      [3200, 0.87],
      [4000, 0.92],
      [4800, 0.942],
      [5600, 0.924],
      [6400, 0.887],
      [7200, 0.829],
    ],
    turbo: { maxKpa: 260, spoolStart: 2000, spoolSpan: 1600 },
    thermalEff: 0.513,
    friction: [7, 0.0038, 0.6],
    knockMargin: 0,
    inertia: 0.3,
    stock: { hp: 261, nm: 360, boostKpa: 240 },
    sound: { half: 0.7, bright: 0.65 },
  },
];

export const getEngine = (id: string): EngineSpec =>
  ENGINES.find((e) => e.id === id) ?? ENGINES[0];

/** One generic 6-speed + car for drive mode — the lesson is the engine. */
export const GEARBOX = {
  ratios: [3.17, 2.05, 1.48, 1.16, 0.92, 0.78],
  final: 3.9,
  wheelRadiusM: 0.31,
  massKg: 1420,
  driveline: 0.85,
};
