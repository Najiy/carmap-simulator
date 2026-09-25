import * as THREE from "three";
import { dist2ToLine, type Fence } from "./trackMath";
import { dressCircuit } from "./circuitScene";

/**
 * Procedural driving scenes.
 *
 * Everything here is generated from a seed at load time — no meshes to ship,
 * no textures to download. Each scene hands back the geometry to render, the
 * boxes the car cannot drive through, and where to put it on the grid.
 */

import { SCENES, type SceneDef, type SceneId } from "./scenes";

export { RACE_SCENES, SCENES, type SceneDef, type SceneId } from "./scenes";

/** axis-aligned footprint the car collides with */
export interface Wall {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Cone {
  x: number;
  z: number;
  /** index into the cone instance mesh, so a hit can lay it flat */
  i: number;
  down: boolean;
}

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * What makes a scene raceable. `line` is the centreline: closed for a lap
 * race, just start-and-finish for a point-to-point. Progress along it is the
 * single number that orders the field, counts laps and decides the winner.
 */
export interface RaceLayout {
  kind: "lap" | "dash";
  line: Vec2[];
  /** grid slots, staggered back from the line — index 0 is pole */
  grid: { x: number; z: number; heading: number }[];
  /** metres of centreline, for lap-distance readouts */
  lengthM: number;
}

export interface World {
  def: SceneDef;
  group: THREE.Group;
  walls: Wall[];
  cones: Cone[];
  coneMesh: THREE.InstancedMesh | null;
  /** where the car starts, and which way it points (radians, 0 = -Z) */
  spawn: { x: number; z: number; heading: number };
  /** the car is teleported back to spawn if it leaves this radius */
  radius: number;
  /** sky/fog colour */
  sky: number;
  /** present only on scenes you can hold a race on */
  race: RaceLayout | null;
  /**
   * Is this point on the black stuff? Everything else is grass, and the car
   * is scrubbed hard for being on it — cutting a corner has to cost more
   * than it gains, or a race is just a contest of who ignores the track.
   */
  onTarmac: (x: number, z: number) => boolean;
  /** armco either side of a circuit — null where there is none */
  fence: Fence | null;
  /** the start gantry: how many reds are lit (0 = lights out) */
  startLights: ((red: number) => void) | null;
  /** fog near/far, when the scene wants something other than the default */
  fog: [number, number] | null;
}

/** small deterministic PRNG so a seed always gives the same scene */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

// The UI is a dark tuner panel; a scene you have to drive in is not. These
// are dusk-overcast values — muted enough to sit next to the rest of the app,
// bright enough that you can see a kerb coming.
const TARMAC = 0x55554f;
const LINE = 0xe8e6dc;
const GRASS = 0x3c4a33;
const KERB_A = 0xc4402f;

/** flat-shaded material, so the low-poly scenery reads as deliberate */
const flat = (color: number) => new THREE.MeshLambertMaterial({ color });

export function buildWorld(id: SceneId, seed = 1): World {
  const def = SCENES.find((s) => s.id === id) ?? SCENES[0];
  const group = new THREE.Group();
  const walls: Wall[] = [];
  const cones: Cone[] = [];
  const rand = rng(seed);

  const world: World = {
    def,
    group,
    walls,
    cones,
    coneMesh: null,
    spawn: { x: 0, z: 0, heading: 0 },
    radius: 900,
    sky: 0x39424e,
    race: null,
    onTarmac: () => true,
    fence: null,
    startLights: null,
    fog: null,
  };

  if (id === "airfield") buildAirfield(world, rand);
  else if (id === "circuit") buildCircuit(world, rand);
  else if (id === "city") buildCity(world, rand);
  else buildMile(world, rand);

  if (cones.length) world.coneMesh = makeCones(group, cones);
  return world;
}

// ---------------------------------------------------------------------------

function ground(group: THREE.Group, size: number, color: number) {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(size, size), flat(color));
  g.rotation.x = -Math.PI / 2;
  g.receiveShadow = true;
  group.add(g);
  return g;
}

/** a flat painted strip lying just above the tarmac */
function paint(
  group: THREE.Group,
  x: number,
  z: number,
  w: number,
  l: number,
  rot = 0,
  color = LINE,
) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), flat(color));
  m.rotation.set(-Math.PI / 2, 0, rot);
  m.position.set(x, 0.012, z);
  group.add(m);
  return m;
}

function ring(
  group: THREE.Group,
  x: number,
  z: number,
  radius: number,
  width = 0.15,
  color = LINE,
) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(radius - width, radius + width, 96),
    flat(color),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.012, z);
  group.add(m);
}

/** a solid box that also becomes a collider */
function block(
  world: World,
  x: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: number,
) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flat(color));
  m.position.set(x, h / 2, z);
  m.castShadow = true;
  world.group.add(m);
  world.walls.push({
    minX: x - w / 2,
    maxX: x + w / 2,
    minZ: z - d / 2,
    maxZ: z + d / 2,
  });
  return m;
}

function makeCones(group: THREE.Group, cones: Cone[]) {
  const geo = new THREE.ConeGeometry(0.22, 0.7, 8);
  geo.translate(0, 0.35, 0);
  const mesh = new THREE.InstancedMesh(geo, flat(0xe2762f), cones.length);
  const m = new THREE.Matrix4();
  cones.forEach((c, i) => {
    c.i = i;
    mesh.setMatrixAt(i, m.makeTranslation(c.x, 0, c.z));
  });
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return mesh;
}

/** lay a cone flat where it stood — cheap, and very satisfying */
export function knockCone(world: World, cone: Cone, dirX: number, dirZ: number) {
  if (cone.down || !world.coneMesh) return;
  cone.down = true;
  const m = new THREE.Matrix4()
    .makeRotationAxis(new THREE.Vector3(-dirZ, 0, dirX).normalize(), Math.PI / 2)
    .setPosition(cone.x + dirX * 0.6, 0.18, cone.z + dirZ * 0.6);
  world.coneMesh.setMatrixAt(cone.i, m);
  world.coneMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------

function buildAirfield(w: World, rand: () => number) {
  w.sky = 0x3d4652;
  w.radius = 460;
  ground(w.group, 1400, GRASS);

  // the pad itself
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(560, 560), flat(TARMAC));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.005;
  w.group.add(pad);

  // skidpad: two circles to hold a drift around
  ring(w.group, 90, -60, 42);
  ring(w.group, 90, -60, 24, 0.1, 0x8e8c83);

  // slalom down the middle, then a braking box
  for (let i = 0; i < 12; i++) {
    w.cones.push({ x: (i % 2 ? 3.5 : -3.5), z: -40 - i * 22, i: 0, down: false });
  }
  paint(w.group, 0, -340, 14, 0.4);
  paint(w.group, 0, -300, 14, 0.4);

  // a loose scatter of cones to bowl through
  for (let i = 0; i < 40; i++) {
    w.cones.push({
      x: -180 + rand() * 90,
      z: -140 + rand() * 260,
      i: 0,
      down: false,
    });
  }

  // hangars along one edge — the only solid things out here
  for (let i = 0; i < 4; i++) {
    block(w, -150 + i * 90, 200, 60, 14, 34, 0x5a5c52);
  }

  // runway centreline to give a sense of speed
  for (let i = -12; i < 12; i++) paint(w.group, 0, i * 40, 0.5, 20);

  w.spawn = { x: 0, z: 60, heading: 0 };
  w.onTarmac = (x, z) => Math.abs(x) <= 280 && Math.abs(z) <= 280;
}

function buildCircuit(w: World, rand: () => number) {
  w.sky = 0x36404c;
  w.radius = 700;

  // a closed loop from a handful of harmonics — always smooth, never a
  // circle, and different for every seed
  const a1 = 0.22 + rand() * 0.16;
  const a2 = 0.12 + rand() * 0.14;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const R = 300;
  const centre = (t: number) => {
    const r = R * (1 + a1 * Math.sin(2 * t + p1) + a2 * Math.sin(3 * t + p2));
    return new THREE.Vector2(Math.cos(t) * r, Math.sin(t) * r * 0.72);
  };

  const N = 260;
  const HALF = 6.5;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < N; i++) pts.push(centre((i / N) * Math.PI * 2));
  const s = pts[0];
  const s1 = pts[1];

  // heading 0 faces -Z, so a course of (dx, dz) is atan2(dx, -dz)
  const heading = Math.atan2(s1.x - s.x, -(s1.y - s.y));
  w.spawn = { x: s.x, z: s.y, heading };

  const line: Vec2[] = pts.map((p) => ({ x: p.x, z: p.y }));
  // the kerbs are part of the track; a wheel past them is on the grass
  const edge = (HALF + 1.2) ** 2;
  w.onTarmac = (x, z) => dist2ToLine(line, x, z, true) <= edge;
  w.race = {
    kind: "lap",
    line,
    grid: gridSlots(line, 0, heading, HALF),
    lengthM: lineLength(line, true),
  };

  // everything you see: tarmac, kerbs, run-off, armco, the start and the
  // scenery beyond — built off the same analytic curve at a finer step
  const dressed = dressCircuit(w.group, {
    centre: (t) => {
      const v = centre(t);
      return { x: v.x, z: v.y };
    },
    line,
    segments: N,
    half: HALF,
    grid: w.race.grid,
    rand,
  });
  w.fence = dressed.fence;
  w.startLights = dressed.startLights;
  w.fog = [170, 1500];
}

function buildCity(w: World, rand: () => number) {
  w.sky = 0x2b323c;
  w.radius = 420;
  ground(w.group, 1400, 0x30343a);

  const BLOCK = 74;
  const ROAD = 16;
  const N = 6;
  const span = N * (BLOCK + ROAD);

  // asphalt everywhere, then buildings sitting in the middle of each block
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(span, span), flat(TARMAC));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.005;
  w.group.add(pad);

  const half = span / 2;
  for (let i = 0; i <= N; i++) {
    const p = -half + i * (BLOCK + ROAD) + ROAD / 2;
    paint(w.group, p, 0, 0.25, span, 0, 0x8e8c83);
    paint(w.group, 0, p, span, 0.25, 0, 0x8e8c83);
  }

  const palette = [0x4d515a, 0x585d68, 0x43474f, 0x646a76];
  for (let gx = 0; gx < N; gx++) {
    for (let gz = 0; gz < N; gz++) {
      const cx = -half + ROAD + gx * (BLOCK + ROAD) + BLOCK / 2;
      const cz = -half + ROAD + gz * (BLOCK + ROAD) + BLOCK / 2;
      // leave one block open as a car park, so there is somewhere to play
      if (gx === 2 && gz === 2) {
        for (let i = 0; i < 14; i++)
          w.cones.push({
            x: cx - 26 + rand() * 52,
            z: cz - 26 + rand() * 52,
            i: 0,
            down: false,
          });
        continue;
      }
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const bw = 18 + rand() * 34;
        const bd = 18 + rand() * 34;
        block(
          w,
          cx + (rand() - 0.5) * (BLOCK - bw - 6),
          cz + (rand() - 0.5) * (BLOCK - bd - 6),
          bw,
          10 + rand() * 55,
          bd,
          palette[Math.floor(rand() * palette.length)],
        );
      }
    }
  }

  // a wall around the outside so you cannot drive off into the void
  const t = 4;
  block(w, 0, -half - t / 2, span + t * 2, 6, t, 0x3f434b);
  block(w, 0, half + t / 2, span + t * 2, 6, t, 0x3f434b);
  block(w, -half - t / 2, 0, t, 6, span + t * 2, 0x3f434b);
  block(w, half + t / 2, 0, t, 6, span + t * 2, 0x3f434b);

  w.spawn = { x: -half + ROAD / 2, z: half - 40, heading: 0 };
  w.onTarmac = (x, z) => Math.abs(x) <= half && Math.abs(z) <= half;
}

function buildMile(w: World, rand: () => number) {
  w.sky = 0x3d4652;
  w.radius = 1500;
  ground(w.group, 4000, GRASS);

  const L = 2000;
  const W = 26;
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(W, L), flat(TARMAC));
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(0, 0.005, -L / 2 + 80);
  w.group.add(pad);

  // centreline dashes and a board every 200 m
  for (let i = 0; i < 90; i++) paint(w.group, 0, 60 - i * 22, 0.4, 11);
  paint(w.group, 0, 40, W, 0.7);
  for (let d = 200; d <= 1800; d += 200) {
    const z = 40 - d;
    paint(w.group, 0, z, W, 0.4, 0, 0x8e8c83);
    block(w, W / 2 + 5, z, 1.2, 3.2, 0.4, 0x5a5c52);
    block(w, -W / 2 - 5, z, 1.2, 3.2, 0.4, 0x5a5c52);
  }

  // marker posts down both sides — the only real cue that you are moving
  for (let i = 0; i < 100; i++) {
    const z = 60 - i * 20;
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 1.1, 0.18),
        flat(i % 5 === 0 ? KERB_A : 0x9a988e),
      );
      m.position.set(s * (W / 2 + 1.6), 0.55, z);
      w.group.add(m);
    }
  }

  // something on the horizon so the eye has a reference
  for (let i = 0; i < 26; i++) {
    block(
      w,
      (rand() < 0.5 ? -1 : 1) * (60 + rand() * 220),
      60 - rand() * L,
      14 + rand() * 24,
      6 + rand() * 22,
      14 + rand() * 24,
      0x474b53,
    );
  }

  w.spawn = { x: 0, z: 60, heading: 0 };
  w.onTarmac = (x, z) => Math.abs(x) <= W / 2 && z <= 80 && z >= 80 - L;

  // a dash: the line runs from the start stripe to the far distance board
  const line: Vec2[] = [
    { x: 0, z: 40 },
    { x: 0, z: 40 - 1800 },
  ];
  w.race = {
    kind: "dash",
    line,
    grid: gridSlots(line, 0, 0, W / 2 - 3),
    lengthM: 1800,
  };
}

/**
 * Start slots staggered back from the line, alternating sides — pole on the
 * inside, then a car length and a half between rows.
 */
function gridSlots(line: Vec2[], at: number, heading: number, half: number) {
  const a = line[at];
  const b = line[(at + 1) % line.length];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  // back down the track, and across it
  const bx = -dx / len;
  const bz = -dz / len;
  const nx = -bz;
  const nz = bx;
  const off = Math.min(3.2, Math.max(1.8, half * 0.45));
  return Array.from({ length: 8 }, (_, i) => {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    const back = 6 + row * 7;
    return {
      x: a.x + bx * back + nx * off * side,
      z: a.z + bz * back + nz * off * side,
      heading,
    };
  });
}

function lineLength(line: Vec2[], closed: boolean) {
  let total = 0;
  const n = line.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = line[i];
    const b = line[(i + 1) % n];
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

/**
 * How far round the lap a point is, as a fraction of the whole. Used to
 * order the field, count laps and tell you who is ahead.
 */
export function progressAt(layout: RaceLayout, x: number, z: number): number {
  const line = layout.line;
  if (layout.kind === "dash") {
    const a = line[0];
    const b = line[1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d2 = dx * dx + dz * dz || 1;
    const t = ((x - a.x) * dx + (z - a.z) * dz) / d2;
    return Math.min(1, Math.max(0, t));
  }
  // nearest centreline segment, refined by projecting onto it
  let best = 0;
  let bestD = Infinity;
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const a = line[i];
    const b = line[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / d2));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const dist = (x - px) ** 2 + (z - pz) ** 2;
    if (dist < bestD) {
      bestD = dist;
      best = (i + t) / n;
    }
  }
  return best;
}

/** everything a scene allocated, released */
export function disposeWorld(w: World) {
  w.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of [m.material].flat()) {
      (mat as THREE.MeshLambertMaterial).map?.dispose();
      mat.dispose();
    }
  });
}
