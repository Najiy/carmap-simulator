import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { dist2ToLine, type Fence, type Pt } from "./trackMath";

/**
 * Dressing for the test circuit.
 *
 * The layout itself — the centreline, the grid, where the track limits are —
 * lives in world.ts with the other scenes. This is what turns that line into
 * a place: asphalt with a rubbered-in racing line, kerbs where a corner
 * actually wants them, gravel on the outside of the tight ones, armco the car
 * can lean on, a start gantry that counts the race down, and enough scenery
 * past the fence that the horizon is not just fog.
 *
 * All of it is still procedural and seeded — no meshes or images to ship.
 * Textures are painted onto canvases at load, and anything there are many of
 * is instanced, so a phone draws the whole lap in a few dozen calls.
 */

// ---- palette ---------------------------------------------------------------
// Dusk-overcast, like the other scenes: muted enough to sit beside the tuner
// UI, but with enough separation that tarmac, kerb and grass read at speed.
const TARMAC = new THREE.Color(0x5b5b55);
const TARMAC_EDGE = new THREE.Color(0x66665f);
const RUBBER = new THREE.Color(0x3e3e3a);
const APRON = new THREE.Color(0x505049);
const LINE = new THREE.Color(0xe4e2d8);
const KERB_RED = new THREE.Color(0xc23b2b);
const KERB_WHITE = new THREE.Color(0xe8e6dc);
const GRAVEL = new THREE.Color(0x9a8e70);
const MOWN_A = new THREE.Color(0x4a5a3a);
const MOWN_B = new THREE.Color(0x42523a);
const GRASS_A = new THREE.Color(0x36452f);
const GRASS_B = new THREE.Color(0x44553a);

/** how far the armco stands from the edge of the tarmac */
const BARRIER_GAP = 13;
/** dense samples per physics segment */
const DENSE = 6;

interface Frame {
  x: number;
  z: number;
  /** unit tangent */
  tx: number;
  tz: number;
  /** unit left normal, (-tz, tx) */
  nx: number;
  nz: number;
  /** metres from the start line */
  s: number;
  /** signed curvature, smoothed — positive turns toward +normal */
  k: number;
}

export interface CircuitDress {
  fence: Fence;
  startLights: (red: number) => void;
}

export function dressCircuit(
  group: THREE.Group,
  o: {
    centre: (t: number) => Pt;
    /** the physics centreline — one point per segment */
    line: Pt[];
    segments: number;
    half: number;
    grid: { x: number; z: number; heading: number }[];
    rand: () => number;
  },
): CircuitDress {
  const H = o.half;
  const BARRIER = H + BARRIER_GAP;
  const F = frames(o.centre, o.segments * DENSE);
  const M = F.length;
  const total = F[M - 1].s + Math.hypot(F[0].x - F[M - 1].x, F[0].z - F[M - 1].z);
  const mats = materialCache();
  const tex = textures();

  // ---- where the corners are ---------------------------------------------
  // Radius under ~170 m wants an apex kerb; under ~90 m it wants one on the
  // exit too, and a gravel trap for when you get it wrong.
  const absK = F.map((f) => Math.abs(f.k));
  const sgnK = F.map((f) => Math.sign(f.k) || 1);
  const kerbIn = dilate(absK.map((k) => k > 1 / 170), 7);
  const kerbOut = dilate(absK.map((k) => k > 1 / 90), 9);
  const trap = soften(absK.map((k) => (k > 1 / 110 ? 1 : 0)), 14);
  // which side of the line the inside of the bend is, in normal units
  const inside = (j: number) => sgnK[j];

  // ---- ground --------------------------------------------------------------
  group.add(groundMesh(tex.grass));

  // ---- asphalt ---------------------------------------------------------------
  group.add(roadMesh(F, total, H, tex.asphalt));

  // painted edge lines, both sides, the whole way round
  for (const side of [1, -1]) {
    const g = strip(F, total, () => ({ a: side * (H - 0.45), b: side * (H - 0.22), c: LINE }), 0.014);
    group.add(new THREE.Mesh(g, mats.decal()));
  }

  // kerbs where a corner wants them, run-off tarmac everywhere else. Both
  // sit inside the track limits — a wheel on a kerb is still on the track.
  for (const side of [1, -1]) {
    const g = strip(
      F,
      total,
      (j) => {
        const isKerb =
          (kerbIn[j] && inside(j) === side) || (kerbOut[j] && inside(j) === -side);
        if (!isKerb) return { a: side * H, b: side * (H + 1.2), c: APRON };
        const stripe = Math.floor(F[j].s / 1.5) % 2 === 0;
        return {
          a: side * H,
          b: side * (H + 1.2),
          c: stripe ? KERB_RED : KERB_WHITE,
          ya: 0.016,
          // a shallow ramp up to the outer edge — it is what makes a kerb
          // look like a kerb rather than paint
          yb: 0.07,
        };
      },
      0.01,
    );
    group.add(new THREE.Mesh(g, mats.surface(tex.grain)));
  }

  // gravel on the outside of the tight corners, then a mown verge out to the
  // armco — stripes along the track, the way a circuit groundsman cuts it
  const trapW = (j: number) => trap[j] * 10;
  const hasTrap = (j: number, side: number) => inside(j) === -side && trap[j] >= 0.04;
  for (const side of [1, -1]) {
    const gravel = strip(
      F,
      total,
      (j) =>
        hasTrap(j, side)
          ? { a: side * (H + 1.2), b: side * (H + 1.2 + trapW(j)), c: GRAVEL }
          : null,
      0.006,
    );
    group.add(new THREE.Mesh(gravel, mats.surface(tex.gravel)));

    const verge = strip(
      F,
      total,
      (j) => {
        const inner = H + 1.2 + (hasTrap(j, side) ? trapW(j) : 0);
        const band = Math.floor(F[j].s / 9) % 2 === 0;
        return { a: side * inner, b: side * (BARRIER + 3), c: band ? MOWN_A : MOWN_B };
      },
      0.004,
    );
    group.add(new THREE.Mesh(verge, mats.surface(tex.grass)));
  }

  // ---- armco ---------------------------------------------------------------
  // A rail either side at a fixed distance. Where the offset curve folds back
  // on itself (the inside of a hairpin) or runs over another part of the
  // track, that stretch is left out — the fence limit below still holds.
  const tyres: { f: Frame; d: number; red: boolean }[] = [];
  const posts: THREE.Matrix4[] = [];
  for (const side of [1, -1]) {
    const ok = F.map((f) => {
      const x = f.x + f.nx * side * BARRIER;
      const z = f.z + f.nz * side * BARRIER;
      return dist2ToLine(o.line, x, z, true) > (BARRIER - 0.8) ** 2;
    });
    group.add(new THREE.Mesh(rail(F, side * BARRIER, ok), mats.metal()));
    F.forEach((f, j) => {
      if (!ok[j]) return;
      if (j % 3 === 0) posts.push(place(f, side * (BARRIER + 0.12)));
      // tyre walls ahead of the rail where the gravel says you will arrive
      if (inside(j) === -side && trap[j] > 0.5) {
        tyres.push({ f, d: side * (BARRIER - 0.42), red: Math.floor(f.s / 1.4) % 2 === 0 });
      }
    });
  }
  group.add(
    instanced(
      new THREE.BoxGeometry(0.12, 0.85, 0.12).translate(0, 0.42, 0),
      mats.flat(0x6f726e),
      posts,
    ),
  );
  if (tyres.length) {
    const tyreGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.9, 9).translate(0, 0.45, 0);
    const mesh = instanced(tyreGeo, mats.tint(), tyres.map((t) => place(t.f, t.d)));
    const red = new THREE.Color(0xb3392c);
    const white = new THREE.Color(0xd8d6ce);
    tyres.forEach((t, i) => mesh.setColorAt(i, t.red ? red : white));
    group.add(mesh);
  }

  // the physics fence, per physics segment: stop at the rail, or a little
  // sooner where there are tyres in front of it
  const pos = new Float32Array(o.segments).fill(BARRIER - 0.15);
  const neg = new Float32Array(o.segments).fill(BARRIER - 0.15);
  F.forEach((_, j) => {
    if (trap[j] <= 0.5) return;
    const seg = Math.floor(j / DENSE);
    (-inside(j) > 0 ? pos : neg)[seg] = BARRIER - 0.85;
  });

  // ---- the start -------------------------------------------------------------
  const f0 = F[0];
  // "out" is the side facing away from the middle of the circuit
  const out = f0.nx * f0.x + f0.nz * f0.z > 0 ? 1 : -1;

  const start = new THREE.Group();
  local(start, f0);
  group.add(start);

  // chequered line across the track
  const chq = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, H * 2).rotateX(-Math.PI / 2),
    mats.decal(tex.checker),
  );
  chq.position.y = 0.016;
  start.add(chq);

  // grid boxes: a bar across the front of each slot and two short legs
  for (const g of o.grid) {
    const slot = new THREE.Group();
    slot.position.set(g.x, 0, g.z);
    slot.rotation.y = start.rotation.y;
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 2.5).rotateX(-Math.PI / 2),
      mats.decal(),
    );
    bar.position.set(2.7, 0.015, 0);
    slot.add(bar);
    for (const z of [-1.2, 1.2]) {
      const leg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.3, 0.16).rotateX(-Math.PI / 2),
        mats.decal(),
      );
      leg.position.set(2.1, 0.015, z);
      slot.add(leg);
    }
    group.add(slot);
  }

  const lamps = gantry(start, H, mats, tex);
  grandstand(start, out, BARRIER, mats, tex);
  pitBuilding(start, -out, BARRIER, mats);

  // ---- boards ----------------------------------------------------------------
  // hoardings behind the rail on the pit straight and round the outside of
  // the corners, and braking boards counting you into the tight ones
  const ads: THREE.Matrix4[][] = tex.ads.map(() => []);
  let adN = 0;
  const facing = (side: number) =>
    new THREE.Quaternion().setFromAxisAngle(UP, side > 0 ? Math.PI : 0);
  for (let x = -54; x <= 54; x += 9) {
    for (const side of [1, -1]) {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, 1.45, side * (BARRIER + 0.5)),
        facing(side),
        ONE,
      );
      ads[adN++ % ads.length].push(new THREE.Matrix4().multiplyMatrices(start.matrix, m));
    }
  }
  let lastBoard = -Infinity;
  F.forEach((f, j) => {
    if (f.s < 80 || f.s > total - 80) return;
    if (trap[j] < 0.5 || f.s - lastBoard < 38) return;
    lastBoard = f.s;
    const side = -inside(j);
    const m = place(f, side * (BARRIER + 0.5));
    m.multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, 1.45, 0), facing(side), ONE));
    ads[adN++ % ads.length].push(m);
  });
  const adGeo = new THREE.PlaneGeometry(7.2, 1.1);
  tex.ads.forEach((t, i) => {
    if (ads[i].length) group.add(instanced(adGeo, mats.sign(t), ads[i]));
  });
  brakingBoards(group, F, absK, inside, H, mats, tex);

  // a bridge over the far side of the lap, if there is a straight there
  const far = findStraight(F, absK, Math.floor(M * 0.4), Math.floor(M * 0.7));
  if (far >= 0) bridge(group, F[far], BARRIER, mats, tex);

  // ---- beyond the fence --------------------------------------------------------
  trees(group, o, BARRIER, f0, out, mats);
  hills(group, o.rand, mats);

  // the lamps change colour, so they keep their own meshes
  mergeStatic(group, new Set(lamps));

  let lit = -1;
  return {
    fence: { line: o.line, pos, neg },
    startLights: (red: number) => {
      if (red === lit) return;
      lit = red;
      lamps.forEach((m, i) => {
        (m.material as THREE.MeshBasicMaterial).color.setHex(i < red ? 0xff2a18 : 0x2a1512);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// the centreline, densely

function frames(centre: (t: number) => Pt, m: number): Frame[] {
  const pts: Pt[] = [];
  for (let j = 0; j < m; j++) pts.push(centre((j / m) * Math.PI * 2));
  const F: Frame[] = pts.map((p, j) => {
    const a = pts[(j - 1 + m) % m];
    const b = pts[(j + 1) % m];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const tx = dx / l;
    const tz = dz / l;
    return { x: p.x, z: p.z, tx, tz, nx: -tz, nz: tx, s: 0, k: 0 };
  });
  let s = 0;
  const raw: number[] = [];
  for (let j = 0; j < m; j++) {
    const a = F[j];
    const b = F[(j + 1) % m];
    a.s = s;
    const ds = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    s += ds;
    const cross = a.tx * b.tz - a.tz * b.tx;
    const dot = a.tx * b.tx + a.tz * b.tz;
    raw.push(Math.atan2(cross, dot) / ds);
  }
  // smooth over ~20 m so one kinked sample cannot sprout a kerb
  const w = 8;
  for (let j = 0; j < m; j++) {
    let acc = 0;
    for (let i = -w; i <= w; i++) acc += raw[(j + i + m) % m];
    F[j].k = acc / (w * 2 + 1);
  }
  return F;
}

function dilate(flags: boolean[], r: number) {
  const m = flags.length;
  return flags.map((_, j) => {
    for (let i = -r; i <= r; i++) if (flags[(j + i + m) % m]) return true;
    return false;
  });
}

/** a 0/1 mask eased at its ends, so a trap widens and narrows gradually */
function soften(v: number[], r: number) {
  const m = v.length;
  return v.map((_, j) => {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += v[(j + i + m) % m];
    return Math.min(1, (acc / (r * 2 + 1)) * 1.6);
  });
}

function findStraight(F: Frame[], absK: number[], from: number, to: number) {
  let best = -1;
  let bestK = 1 / 400;
  const m = F.length;
  for (let j = from; j < to; j++) {
    let worst = 0;
    for (let i = -20; i <= 20; i++) worst = Math.max(worst, absK[(j + i + m) % m]);
    if (worst < bestK) {
      bestK = worst;
      best = j;
    }
  }
  return best;
}

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/** a transform onto the track frame: +X down the track, +Z to its left */
function place(f: Frame, lateral: number, along = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(
      f.x + f.nx * lateral + f.tx * along,
      0,
      f.z + f.nz * lateral + f.tz * along,
    ),
    new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-f.tz, f.tx)),
    ONE,
  );
}

function local(obj: THREE.Object3D, f: Frame) {
  obj.position.set(f.x, 0, f.z);
  obj.rotation.y = Math.atan2(-f.tz, f.tx);
  obj.updateMatrix();
}

// ---------------------------------------------------------------------------
// geometry

interface Band {
  a: number;
  b: number;
  c: THREE.Color;
  ya?: number;
  yb?: number;
}

/**
 * A ribbon alongside the centreline between two lateral offsets. Flat
 * colour per segment (non-indexed), so kerb stripes stay crisp; UVs are in
 * metres, for the grain textures.
 */
function strip(
  F: Frame[],
  total: number,
  band: (j: number) => Band | null,
  y: number,
) {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const m = F.length;
  for (let j = 0; j < m; j++) {
    const b0 = band(j);
    const b1 = band((j + 1) % m);
    if (!b0 || !b1) continue;
    const f0 = F[j];
    const f1 = F[(j + 1) % m];
    const s0 = f0.s;
    const s1 = j + 1 === m ? total : f1.s;
    const P = (f: Frame, d: number, yy: number) => [f.x + f.nx * d, yy, f.z + f.nz * d];
    const A = P(f0, b0.a, b0.ya ?? y);
    const B = P(f0, b0.b, b0.yb ?? y);
    const C = P(f1, b1.a, b1.ya ?? y);
    const D = P(f1, b1.b, b1.yb ?? y);
    const uA = [b0.a / 4, s0 / 4];
    const uB = [b0.b / 4, s0 / 4];
    const uC = [b1.a / 4, s1 / 4];
    const uD = [b1.b / 4, s1 / 4];
    // face up whichever side of the line this band is on
    const ux = B[0] - A[0];
    const uz = B[2] - A[2];
    const vx = D[0] - A[0];
    const vz = D[2] - A[2];
    const upward = uz * vx - ux * vz > 0;
    const tris = upward ? [A, B, D, A, D, C] : [A, D, B, A, C, D];
    const uvs = upward ? [uA, uB, uD, uA, uD, uC] : [uA, uD, uB, uA, uC, uD];
    for (let i = 0; i < 6; i++) {
      pos.push(...tris[i]);
      uv.push(...uvs[i]);
      col.push(b0.c.r, b0.c.g, b0.c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * The track surface. Nine vertices across, so the rubbered-in line can be
 * shaded in: dark down the middle on the straights, drifting to the inside
 * at each apex, with the dusty unused margins a shade lighter.
 */
function roadMesh(F: Frame[], total: number, H: number, map: THREE.Texture) {
  const LAT = 9;
  const m = F.length;
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  for (let r = 0; r <= m; r++) {
    const f = F[r % m];
    const s = r === m ? total : f.s;
    // where the line runs across the track: middle on a straight, near the
    // inside kerb at an apex
    const lineAt = Math.sign(f.k) * Math.min(1, Math.abs(f.k) * 110) * H * 0.55;
    for (let i = 0; i < LAT; i++) {
      const off = -H + (2 * H * i) / (LAT - 1);
      pos.push(f.x + f.nx * off, 0.01, f.z + f.nz * off);
      uv.push(off / 6, s / 6);
      const rub = Math.exp(-(((off - lineAt) / (H * 0.32)) ** 2));
      c.copy(Math.abs(off) > H * 0.8 ? TARMAC_EDGE : TARMAC).lerp(RUBBER, rub * 0.45);
      col.push(c.r, c.g, c.b);
    }
  }
  // winding depends on which way round the lap runs — face it upward
  const ux = pos[3] - pos[0];
  const uz = pos[5] - pos[2];
  const vx = pos[LAT * 3] - pos[0];
  const vz = pos[LAT * 3 + 2] - pos[2];
  const flip = uz * vx - ux * vz < 0;
  for (let r = 0; r < m; r++) {
    for (let i = 0; i < LAT - 1; i++) {
      const a = r * LAT + i;
      const b = (r + 1) * LAT + i;
      if (flip) idx.push(a, b, a + 1, a + 1, b, b + 1);
      else idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, map }));
}

/** a W-beam: a pale rail on a darker blade, standing on its own */
function rail(F: Frame[], d: number, ok: boolean[]) {
  const pos: number[] = [];
  const col: number[] = [];
  const hi = new THREE.Color(0xb4b7b2);
  const lo = new THREE.Color(0x7d807b);
  const m = F.length;
  for (let j = 0; j < m; j++) {
    if (!ok[j] || !ok[(j + 1) % m]) continue;
    const f0 = F[j];
    const f1 = F[(j + 1) % m];
    const x0 = f0.x + f0.nx * d;
    const z0 = f0.z + f0.nz * d;
    const x1 = f1.x + f1.nx * d;
    const z1 = f1.z + f1.nz * d;
    for (const [y0, y1, c] of [
      [0.42, 0.62, lo],
      [0.62, 0.86, hi],
    ] as const) {
      pos.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0);
      for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function groundMesh(map: THREE.Texture) {
  const SIZE = 3400;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, 90, 90).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  const col: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    // a couple of octaves of cheap wave noise: patches, not a flat sheet
    const n =
      Math.sin(x * 0.0071 + 1.3) * Math.sin(z * 0.0083 - 0.4) +
      0.5 * Math.sin(x * 0.019 + z * 0.015 + 2.1) +
      0.25 * Math.sin(x * 0.043 - z * 0.037);
    c.copy(GRASS_A).lerp(GRASS_B, 0.5 + n * 0.3);
    col.push(c.r, c.g, c.b);
    uv.setXY(i, x / 5, z / 5);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshLambertMaterial({ vertexColors: true, map }),
  );
  mesh.position.y = -0.01;
  return mesh;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, at: THREE.Matrix4[]) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, at.length));
  at.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.count = at.length;
  mesh.instanceMatrix.needsUpdate = true;
  // instances spread over the whole lap — bounds from the first one would
  // cull the lot whenever it is off-screen
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// materials and textures

type Mats = ReturnType<typeof materialCache>;

function materialCache() {
  const flats = new Map<number, THREE.MeshLambertMaterial>();
  // one material per (kind, texture), so like meshes can be merged later
  const made = new Map<string, THREE.Material>();
  const once = <M extends THREE.Material>(key: string, make: () => M): M => {
    let m = made.get(key) as M | undefined;
    if (!m) made.set(key, (m = make()));
    return m;
  };
  return {
    /** flat-shaded, one per colour */
    flat(color: number) {
      let m = flats.get(color);
      if (!m) {
        m = new THREE.MeshLambertMaterial({ color, flatShading: true });
        flats.set(color, m);
      }
      return m;
    },
    /** vertex-coloured ground cover with a grain map, drawn over the grass */
    surface(map: THREE.Texture) {
      return once(
        `surface:${map.uuid}`,
        () =>
          new THREE.MeshLambertMaterial({
            vertexColors: true,
            map,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          }),
      );
    },
    /** paint on the road — pulled forward so it never fights the tarmac */
    decal(map?: THREE.Texture) {
      return once(
        `decal:${map?.uuid ?? "paint"}`,
        () =>
          new THREE.MeshLambertMaterial({
            color: map ? 0xffffff : LINE,
            map: map ?? null,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          }),
      );
    },
    metal() {
      return once(
        "metal",
        () => new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      );
    },
    /** white, for per-instance colour */
    tint() {
      return new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    },
    /** signage — unlit, so it still reads at dusk */
    sign(map: THREE.Texture) {
      return once(`sign:${map.uuid}`, () => new THREE.MeshBasicMaterial({ map, color: 0xd0d0d0 }));
    },
  };
}

function canvasTex(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D) => void,
  repeat = true,
) {
  // headless (the physics checks build this scene in node) — the layout is
  // what matters there, not the paint
  if (typeof document === "undefined") return new THREE.Texture();
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  draw(cv.getContext("2d")!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** grey speckle around a light mid-tone, to multiply a vertex colour by */
function grain(size: number, base: number, spread: number, flecks: number, seed: number) {
  return canvasTex(size, size, (g) => {
    const img = g.createImageData(size, size);
    let s = seed;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < size * size; i++) {
      let v = base + (r() - 0.5) * spread;
      const f = r();
      if (f < flecks) v = Math.min(255, base + 24 + r() * 20);
      else if (f < flecks * 2) v = base - 40;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

function textures() {
  const checker = canvasTex(
    64,
    256,
    (g) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 4; x++) {
          g.fillStyle = (x + y) % 2 ? "#161616" : "#eeeeee";
          g.fillRect(x * 16, y * 16, 16, 16);
        }
    },
    false,
  );

  const ad = (bg: string, fg: string, text: string, stripe?: string) =>
    canvasTex(
      512,
      80,
      (g) => {
        g.fillStyle = bg;
        g.fillRect(0, 0, 512, 80);
        if (stripe) {
          g.fillStyle = stripe;
          g.fillRect(0, 68, 512, 12);
        }
        g.fillStyle = fg;
        g.font = `bold 44px ${FONT}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(text, 256, stripe ? 36 : 42, 480);
      },
      false,
    );

  const crowd = canvasTex(256, 32, (g) => {
    g.fillStyle = "#26282d";
    g.fillRect(0, 0, 256, 32);
    let s = 3;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const hues = ["#c4402f", "#e8e6dc", "#3b82c4", "#f2c230", "#5aa05a", "#8e8c83", "#d77a3a", "#44474f"];
    for (let i = 0; i < 260; i++) {
      const x = r() * 256;
      const y = 12 + r() * 12;
      g.fillStyle = hues[Math.floor(r() * hues.length)];
      g.fillRect(x, y, 3, 9);
      g.fillStyle = "#c9a888";
      g.fillRect(x + 0.5, y - 3, 2, 3);
    }
  });

  const board = (text: string) =>
    canvasTex(
      128,
      96,
      (g) => {
        g.fillStyle = "#f2f2ee";
        g.fillRect(0, 0, 128, 96);
        g.strokeStyle = "#1b1b1b";
        g.lineWidth = 6;
        g.strokeRect(3, 3, 122, 90);
        g.fillStyle = "#1b1b1b";
        g.font = `bold 52px ${FONT}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(text, 64, 50);
      },
      false,
    );

  const banner = canvasTex(
    1024,
    64,
    (g) => {
      g.fillStyle = "#151515";
      g.fillRect(0, 0, 1024, 64);
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 8; x++) {
          g.fillStyle = (x + y) % 2 ? "#151515" : "#eeeeee";
          g.fillRect(x * 16, y * 16, 16, 16);
          g.fillRect(1024 - 128 + x * 16, y * 16, 16, 16);
        }
      g.fillStyle = "#ffffff";
      g.font = `bold 40px ${FONT}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("START · FINISH", 512, 34);
    },
    false,
  );

  return {
    asphalt: grain(256, 222, 34, 0.02, 7),
    grain: grain(128, 226, 18, 0.01, 11),
    grass: grain(128, 220, 46, 0, 13),
    gravel: grain(128, 212, 70, 0.08, 17),
    checker,
    ads: [
      ad("#c4402f", "#ffffff", "BOB'S REAL DYNOS"),
      ad("#f2c230", "#1b1b1b", "TUNED ON THE ROLLERS"),
      ad("#1f3350", "#ffffff", "AFR 11.8 · STAY SAFE", "#3b82c4"),
      ad("#eeeeea", "#1b1b1b", "BOOST RESPONSIBLY", "#c4402f"),
    ],
    crowd,
    boards: ["150", "100", "50"].map(board),
    banner,
  };
}

type Tex = ReturnType<typeof textures>;

// ---------------------------------------------------------------------------
// set pieces, built in a local track frame: +X down the track, +Z left

function box(
  parent: THREE.Object3D,
  mat: THREE.Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** the lights over the line — returns the five lamps, left to right */
function gantry(start: THREE.Group, H: number, mats: Mats, tex: Tex) {
  const steel = mats.flat(0x2e3033);
  const span = H + 2.6;
  for (const z of [-span, span]) box(start, steel, 0.5, 7.2, 0.5, 0, 3.6, z);
  box(start, steel, 0.6, 0.9, span * 2 + 0.5, 0, 6.75, 0);

  // START · FINISH on the face the grid looks at
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(span * 2 - 1, 0.8), mats.sign(tex.banner));
  banner.rotation.y = -Math.PI / 2;
  banner.position.set(-0.32, 6.75, 0);
  start.add(banner);

  // the light pod hangs off the middle of the beam, facing the grid
  box(start, mats.flat(0x111214), 0.35, 0.9, 3.6, 0, 5.8, 0);
  const lamps: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const lamp = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 16),
      new THREE.MeshBasicMaterial({ color: 0x2a1512 }),
    );
    lamp.rotation.y = -Math.PI / 2;
    // facing -X, so +Z is the grid's right: light them left to right
    lamp.position.set(-0.19, 5.8, -1.3 + i * 0.65);
    start.add(lamp);
    lamps.push(lamp);
  }
  return lamps;
}

function grandstand(start: THREE.Group, side: number, barrier: number, mats: Mats, tex: Tex) {
  const L = 84;
  const x0 = -18;
  const d0 = barrier + 8;
  const concrete = mats.flat(0x6d6f69);
  const seats = mats.flat(0x5f6269);
  const steps = 9;
  const depth = 2.1;
  const rise = 0.85;
  tex.crowd.repeat.set(L / 10, 1);
  const crowdMat = new THREE.MeshLambertMaterial({ map: tex.crowd });
  for (let i = 0; i < steps; i++) {
    const h = 1.4 + i * rise;
    box(start, i % 2 ? concrete : seats, L, h, depth, x0, h / 2, side * (d0 + i * depth + depth / 2));
    // a row of people on each step, facing the track
    const row = new THREE.Mesh(new THREE.PlaneGeometry(L, 0.9), crowdMat);
    row.position.set(x0, h + 0.45, side * (d0 + i * depth + 0.7));
    row.rotation.y = side > 0 ? Math.PI : 0;
    start.add(row);
  }
  const top = 1.4 + steps * rise;
  const back = d0 + steps * depth;
  box(start, concrete, L, top + 5, 0.5, x0, (top + 5) / 2, side * (back + 0.25));
  // cantilevered roof, pale so it catches the sky
  const roof = box(
    start,
    mats.flat(0xc2c4bd),
    L + 4,
    0.35,
    steps * depth + 4,
    x0,
    top + 5.2,
    side * (d0 + (steps * depth) / 2 - 1),
  );
  roof.rotation.x = side * 0.06;
  for (let x = x0 - L / 2 + 4; x <= x0 + L / 2 - 4; x += 12) {
    box(start, mats.flat(0x3d403d), 0.4, 5.2, 0.4, x, top + 2.6, side * (back - 0.4));
  }
}

function pitBuilding(start: THREE.Group, side: number, barrier: number, mats: Mats) {
  const L = 130;
  const x0 = -10;
  const d0 = barrier + 10;
  const deep = 14;
  // pit lane and its white line, between the verge and the garages
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(L + 30, 6.8).rotateX(-Math.PI / 2),
    mats.flat(0x55554f),
  );
  lane.position.set(x0, 0.008, side * (barrier + 6.6));
  start.add(lane);
  const laneLine = new THREE.Mesh(
    new THREE.PlaneGeometry(L + 30, 0.18).rotateX(-Math.PI / 2),
    mats.decal(),
  );
  laneLine.position.set(x0, 0.012, side * (barrier + 3.8));
  start.add(laneLine);

  box(start, mats.flat(0x8b8d86), L, 6.5, deep, x0, 3.25, side * (d0 + deep / 2));
  // a roof slab that overhangs the garage doors
  box(start, mats.flat(0xd6d7d1), L + 2, 0.5, deep + 3, x0, 6.75, side * (d0 + deep / 2 - 1.5));
  // garage doors on the pit-lane face
  const door = mats.flat(0x2a2d31);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const x = x0 - L / 2 + (L / n) * (i + 0.5);
    const d = new THREE.Mesh(new THREE.PlaneGeometry(L / n - 2.4, 4.4), door);
    d.position.set(x, 2.2, side * (d0 - 0.02));
    d.rotation.y = side > 0 ? Math.PI : 0;
    start.add(d);
  }
  // race control, with a band of dark glass looking over the line
  const tx = x0 + L / 2 - 8;
  box(start, mats.flat(0x7e8079), 12, 15, 11, tx, 7.5, side * (d0 + 5.5));
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(11.6, 2.6),
    new THREE.MeshLambertMaterial({ color: 0x24303c, emissive: 0x0c141c }),
  );
  glass.position.set(tx, 12.4, side * (d0 - 0.03));
  glass.rotation.y = side > 0 ? Math.PI : 0;
  start.add(glass);
}

function bridge(group: THREE.Group, f: Frame, barrier: number, mats: Mats, tex: Tex) {
  const b = new THREE.Group();
  local(b, f);
  const pier = mats.flat(0x6a6c66);
  const span = barrier + 1.6;
  for (const z of [-span, span]) box(b, pier, 2.2, 7.6, 2.2, 0, 3.8, z);
  box(b, mats.flat(0x4c4f4c), 3.2, 1.3, span * 2 + 2.2, 0, 7.6, 0);
  // an advert on both faces
  for (const dir of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(span * 2 - 2, 1.1), mats.sign(tex.ads[0]));
    p.rotation.y = dir < 0 ? -Math.PI / 2 : Math.PI / 2;
    p.position.set(dir * 1.62, 7.6, 0);
    b.add(p);
  }
  group.add(b);
}

/** 150 / 100 / 50 before each corner worth braking for, on the outside */
function brakingBoards(
  group: THREE.Group,
  F: Frame[],
  absK: number[],
  inside: (j: number) => number,
  H: number,
  mats: Mats,
  tex: Tex,
) {
  const m = F.length;
  const post = mats.flat(0x2e3033);
  const boardGeo = new THREE.PlaneGeometry(1.1, 0.82);
  let lastCorner = -Infinity;
  for (let j = 0; j < m; j++) {
    const prev = (j - 1 + m) % m;
    const entering = absK[j] > 1 / 75 && absK[prev] <= 1 / 75;
    if (!entering || F[j].s - lastCorner < 250) continue;
    // only where there is a run at it worth braking from
    let straight = true;
    for (let i = 1; i < 60 && straight; i++) straight = absK[(j - i + m) % m] < 1 / 140;
    if (!straight) continue;
    lastCorner = F[j].s;
    const side = -inside(j);
    [150, 100, 50].forEach((dist, bi) => {
      // walk back along the line to the board's spot
      let at = j;
      let run = 0;
      while (run < dist) {
        const p = (at - 1 + m) % m;
        run += Math.hypot(F[at].x - F[p].x, F[at].z - F[p].z);
        at = p;
      }
      const g = new THREE.Group();
      local(g, F[at]);
      const d = side * (H + 3.2);
      box(g, post, 0.1, 1.6, 0.1, 0, 0.8, d);
      const face = new THREE.Mesh(boardGeo, mats.sign(tex.boards[bi]));
      // facing the cars coming at it
      face.rotation.y = -Math.PI / 2;
      face.position.set(-0.06, 1.75, d);
      g.add(face);
      group.add(g);
    });
  }
}

/** woodland in clumps past the fence, kept off the track and the buildings */
function trees(
  group: THREE.Group,
  o: { line: Pt[]; rand: () => number },
  barrier: number,
  f0: Frame,
  out: number,
  mats: Mats,
) {
  const r = o.rand;
  const keepOut = (barrier + 9) ** 2;
  // the grandstand and the pits, roughly
  const sx = f0.x + f0.nx * out * (barrier + 20);
  const sz = f0.z + f0.nz * out * (barrier + 20);
  const px = f0.x - f0.nx * out * (barrier + 16);
  const pz = f0.z - f0.nz * out * (barrier + 16);
  const pines: THREE.Matrix4[] = [];
  const oaks: THREE.Matrix4[] = [];
  const trunks: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  let tries = 0;
  while (pines.length + oaks.length < 620 && tries++ < 4000) {
    // a clump centre, then a handful of trees scattered round it
    const cx = (r() - 0.5) * 1900;
    const cz = (r() - 0.5) * 1500;
    const count = 3 + Math.floor(r() * 9);
    const pine = r() < 0.55;
    for (let i = 0; i < count; i++) {
      const x = cx + (r() - 0.5) * 60;
      const z = cz + (r() - 0.5) * 60;
      if ((x - sx) ** 2 + (z - sz) ** 2 < 70 ** 2) continue;
      if ((x - px) ** 2 + (z - pz) ** 2 < 85 ** 2) continue;
      if (dist2ToLine(o.line, x, z, true) < keepOut) continue;
      const h = 0.75 + r() * 0.6;
      q.setFromAxisAngle(UP, r() * Math.PI * 2);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z),
        q,
        new THREE.Vector3(h, h * (0.9 + r() * 0.3), h),
      );
      (pine ? pines : oaks).push(m);
      trunks.push(m);
    }
  }
  const pineGeo = new THREE.ConeGeometry(2.6, 8.5, 7).translate(0, 5.6, 0);
  const oakGeo = new THREE.IcosahedronGeometry(3.4, 0).translate(0, 5.2, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.36, 2.4, 5).translate(0, 1.2, 0);
  const pineMesh = instanced(pineGeo, mats.tint(), pines);
  const oakMesh = instanced(oakGeo, mats.tint(), oaks);
  const c = new THREE.Color();
  pines.forEach((_, i) => pineMesh.setColorAt(i, c.setHSL(0.33 + r() * 0.05, 0.28, 0.17 + r() * 0.06)));
  oaks.forEach((_, i) => oakMesh.setColorAt(i, c.setHSL(0.2 + r() * 0.1, 0.3, 0.22 + r() * 0.08)));
  group.add(pineMesh, oakMesh, instanced(trunkGeo, mats.flat(0x3b2f25), trunks));
}

/** a ring of low hills on the horizon, fogged into silhouettes */
function hills(group: THREE.Group, r: () => number, mats: Mats) {
  const at: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + r() * 0.12;
    const d = 1050 + r() * 180;
    const w = 150 + r() * 170;
    const h = 45 + r() * 95;
    q.setFromAxisAngle(UP, r() * Math.PI);
    at.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * d, -2, Math.sin(a) * d * 0.85),
        q,
        new THREE.Vector3(w, h, w * (0.7 + r() * 0.5)),
      ),
    );
  }
  const geo = new THREE.ConeGeometry(1, 1, 7, 1).translate(0, 0.5, 0);
  group.add(instanced(geo, mats.flat(0x2f3a34), at));
}

/**
 * Fold every static mesh that shares a material into one. The set pieces are
 * built from dozens of boxes and planes — grid boxes, grandstand tiers,
 * garage doors — and each would otherwise be its own draw call, which is
 * what a phone runs out of first.
 */
function mergeStatic(group: THREE.Group, keep: Set<THREE.Object3D>) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<string, { mat: THREE.Material; meshes: THREE.Mesh[] }>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || keep.has(m)) return;
    if (Array.isArray(m.material)) return;
    const g = m.geometry;
    // mergeGeometries needs the same attributes, and all indexed or none
    const key = `${m.material.uuid}|${Object.keys(g.attributes).sort().join(",")}|${g.index ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat: m.material, meshes: [] }));
    b.meshes.push(m);
  });
  for (const { mat, meshes } of buckets.values()) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) =>
      m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)),
    );
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    for (const m of meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    group.add(new THREE.Mesh(merged, mat));
  }
}
