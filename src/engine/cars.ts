/**
 * The garage catalogue. Every car points at an engine from the dyno's engine
 * list, so picking one here is the same swap the header dropdown does.
 *
 * `model` is optional — a car without one still gets a card, it just shows a
 * placeholder instead of a viewer. GLBs live in public/models and are fetched
 * on demand, never bundled.
 */

import { ENGINES, getEngine, type EngineSpec } from "./engines";

export interface CarModel {
  /** path under public/ — meshopt-compressed GLB with an embedded texture */
  url: string;
  /** rough download size, shown before the fetch starts */
  sizeMb: number;
  /** bakes its lighting into the texture, so it renders unlit */
  scan?: boolean;
  /** glTF is Y-up; photogrammetry tools export Z-up and rotate nothing */
  upAxis?: "y" | "z";
  /**
   * Keep only what falls inside this box, in the file's own coordinates —
   * scans arrive with as much driveway and hedge as the photos caught.
   * See scripts/glb-density.cjs for finding one.
   */
  crop?: { min: [number, number, number]; max: [number, number, number] };
  credit?: string;
}

export interface Car {
  id: string;
  name: string;
  maker: string;
  years: string;
  layout: string;
  /** kerb weight, kg — flavour only; the sim races one reference chassis */
  weightKg: number;
  blurb: string;
  engineId: string;
  model?: CarModel;
}

export const CARS: Car[] = [
  {
    id: "focus-st-mk2",
    name: "Focus ST Mk2",
    maker: "Ford",
    years: "2005–2010",
    layout: "FWD · 6-speed manual",
    weightKg: 1392,
    blurb:
      "The five-cylinder hot hatch. Electric Orange, a Volvo-derived warble and more mid-range than the front axle really wants.",
    engineId: "st2006",
    model: {
      url: "models/focus_st.glb",
      sizeMb: 3.3,
      scan: true,
      upAxis: "z",
      // the car itself is x -14.5..2.25, y -3..5.25, z 1.05..6.5; this keeps
      // it plus five units of car park so it has something to stand on
      crop: { min: [-19.5, -8, 0.4], max: [7.25, 10.25, 6.6] },
      credit: "Photogrammetry scan — RS replica bodykit",
    },
  },
  {
    id: "supra-mk4",
    name: "Supra RZ (A80)",
    maker: "Toyota",
    years: "1993–2002",
    layout: "RWD · 6-speed manual",
    weightKg: 1570,
    blurb:
      "Cast-iron block, sequential twins, and a reputation built entirely on how much boost the bottom end will shrug off.",
    engineId: "2jz",
  },
  {
    id: "skyline-r34",
    name: "Skyline GT-R (R34)",
    maker: "Nissan",
    years: "1999–2002",
    layout: "AWD · 6-speed manual",
    weightKg: 1560,
    blurb:
      "ATTESA all-wheel drive and an engine that only wakes up past 5500. Built to homologate, sold as a legend.",
    engineId: "rb26",
  },
  {
    id: "nissan-z",
    name: "Z (RZ34)",
    maker: "Nissan",
    years: "2023–",
    layout: "RWD · 6-speed manual",
    weightKg: 1600,
    blurb:
      "Modern twin-turbo V6 in a deliberately retro shell. Spools early, pulls flat, asks very little of the driver.",
    engineId: "nissanz",
  },
  {
    id: "civic-type-r-ep3",
    name: "Civic Type R (EP3)",
    maker: "Honda",
    years: "2001–2005",
    layout: "FWD · 6-speed manual",
    weightKg: 1204,
    blurb:
      "No turbo, no torque, no excuses — just a second cam lobe at 5800 rpm and 8200 on the tacho.",
    engineId: "k20",
  },
  {
    id: "mustang-gt-s550",
    name: "Mustang GT (S550)",
    maker: "Ford",
    years: "2018–2023",
    layout: "RWD · 10-speed auto",
    weightKg: 1743,
    blurb:
      "Gen-3 Coyote: port and direct injection, a 7500 rpm ceiling and cross-plane thunder the whole way there.",
    engineId: "coyote",
  },
  {
    id: "focus-st-mk4",
    name: "Focus ST Mk4.5",
    maker: "Ford",
    years: "2022–2025",
    layout: "FWD · 6-speed manual",
    weightKg: 1508,
    blurb:
      "The last one. 2.3 EcoBoost, an eLSD, and a small turbo that is all done by 5500 — which is exactly why people tune it.",
    engineId: "stmk45",
  },
  {
    id: "focus-st-mk4-s2",
    name: "Focus ST Mk4.5 — Stage 2",
    maker: "Ford",
    years: "2022–2025",
    layout: "FWD · 6-speed manual",
    weightKg: 1495,
    blurb:
      "Intake, downpipe and a map that leans on the stock snail until injector duty starts telling you to stop.",
    engineId: "stmk45s2",
  },
  {
    id: "focus-st-mk4-bt",
    name: "Focus ST Mk4.5 — Big Turbo",
    maker: "Ford",
    years: "2022–2025",
    layout: "FWD · 6-speed manual",
    weightKg: 1500,
    blurb:
      "Hybrid turbo, 260 kPa on tap, and a hole under 3000 rpm you learn to drive around. 450 bhp through the front wheels.",
    engineId: "stmk45bt",
  },
  {
    id: "bmw-330i",
    name: "330i (G20)",
    maker: "BMW",
    years: "2019–",
    layout: "RWD · 8-speed auto",
    weightKg: 1545,
    blurb:
      "The sensible one. B48 modular four, unfussy about fuel, and a wastegate that stops well short of anything dramatic.",
    engineId: "b48",
  },
  {
    id: "amg-a45s",
    name: "A45 S 4MATIC+",
    maker: "Mercedes-AMG",
    years: "2019–",
    layout: "AWD · 8-speed DCT",
    weightKg: 1550,
    blurb:
      "421 PS from two litres, one engine per builder, and the highest specific output of any production four.",
    engineId: "a45",
  },
  {
    id: "gr-yaris",
    name: "GR Yaris",
    maker: "Toyota",
    years: "2020–",
    layout: "AWD · 6-speed manual",
    weightKg: 1280,
    blurb:
      "Homologation special with three cylinders, a carbon roof, and a rally programme's worth of boost.",
    engineId: "gryaris",
  },
  {
    id: "escort-rs-cosworth",
    name: "Escort RS Cosworth",
    maker: "Ford",
    years: "1992–1996",
    layout: "AWD · 5-speed manual",
    weightKg: 1275,
    blurb:
      "Group A hero with the whale tail. The big T34 does nothing, then does everything, and the wing keeps it pointed forwards.",
    engineId: "cosworth",
  },
  {
    id: "evo-vi",
    name: "Lancer Evolution VI",
    maker: "Mitsubishi",
    years: "1999–2001",
    layout: "AWD · 5-speed manual",
    weightKg: 1360,
    blurb:
      "Iron block, titanium turbine wheel, and Mäkinen's name on the good one. Tough enough to survive most tuning mistakes.",
    engineId: "4g63",
  },
  {
    id: "impreza-sti",
    name: "Impreza WRX STI (GDB)",
    maker: "Subaru",
    years: "2001–2007",
    layout: "AWD · 6-speed manual",
    weightKg: 1470,
    blurb:
      "Unequal-length headers, that rumble, and ringlands that will remind you why AFR targets exist.",
    engineId: "ej257",
  },
  {
    id: "rx7-fd",
    name: "RX-7 (FD3S)",
    maker: "Mazda",
    years: "1992–2002",
    layout: "RWD · 5-speed manual",
    weightKg: 1270,
    blurb:
      "Twin rotors, sequential turbos, 1270 kg. Detonation does not ruin pistons here — it eats apex seals instead.",
    engineId: "13b",
  },
  {
    id: "e46-m3",
    name: "M3 (E46)",
    maker: "BMW",
    years: "2000–2006",
    layout: "RWD · 6-speed manual",
    weightKg: 1495,
    blurb:
      "Six individual throttle bodies, 8000 rpm, and the last M3 that made its power without a turbo or a supercharger.",
    engineId: "s54",
  },
  {
    id: "ferrari-458",
    name: "458 Italia",
    maker: "Ferrari",
    years: "2009–2015",
    layout: "RWD · 7-speed DCT",
    weightKg: 1485,
    blurb:
      "Flat-plane crank, 9000 rpm, no turbos anywhere. Every bit of the power comes out of how well it breathes.",
    engineId: "f136",
  },
  {
    id: "corvette-z06",
    name: "Corvette Z06 (C6)",
    maker: "Chevrolet",
    years: "2006–2013",
    layout: "RWD · 6-speed manual",
    weightKg: 1420,
    blurb:
      "Seven litres, dry sump, titanium rods, and pushrods. Old technology executed better than it had any right to be.",
    engineId: "ls7",
  },
  {
    id: "falcon-xr6-turbo",
    name: "Falcon XR6 Turbo (FG)",
    maker: "Ford",
    years: "2008–2014",
    layout: "RWD · 6-speed auto",
    weightKg: 1750,
    blurb:
      "Australia's answer to the 2JZ, fitted to a family saloon. Lazy, enormous, and utterly unbothered by boost.",
    engineId: "barra",
  },
  {
    id: "f1-pu",
    name: "Formula 1 Power Unit",
    maker: "Grand Prix",
    years: "2014–",
    layout: "RWD · 8-speed sequential",
    weightKg: 798,
    blurb:
      "1.6 V6 turbo-hybrid at 12 500 rpm with exhaust hot enough to glow. Run it lean and there is nothing left to rebuild.",
    engineId: "f1v6",
  },
];

export const carById = (id: string) => CARS.find((c) => c.id === id);

/** the car that fronts a given engine, if any */
export const carForEngine = (engineId: string) =>
  CARS.find((c) => c.engineId === engineId);

export const carEngine = (car: Car): EngineSpec => getEngine(car.engineId);

// getEngine falls back rather than throwing, so a car pointing at an engine
// that has been renamed away would quietly show the wrong spec — say so
const orphans = CARS.filter((c) => !ENGINES.some((e) => e.id === c.engineId));
if (orphans.length)
  console.warn(
    "cars.ts: unknown engineId on",
    orphans.map((c) => c.id),
  );
