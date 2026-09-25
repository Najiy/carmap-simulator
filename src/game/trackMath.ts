/**
 * Plain geometry on a track centreline. Kept apart from the scene builders
 * so the physics can ask "how far off the line am I?" without pulling any
 * of three.js in with it.
 */

export interface Pt {
  x: number;
  z: number;
}

/** shortest distance from a point to a polyline, squared */
export function dist2ToLine(line: Pt[], x: number, z: number, closed: boolean) {
  let best = Infinity;
  const n = line.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = line[i];
    const b = line[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / d2));
    const ex = x - (a.x + dx * t);
    const ez = z - (a.z + dz * t);
    const e = ex * ex + ez * ez;
    if (e < best) best = e;
  }
  return best;
}

/**
 * The barriers either side of a closed circuit, as a distance from the
 * centreline rather than as geometry. A curved rail built from boxes either
 * snags or leaks; "no further than this from the line" does neither, and it
 * stays right where the track doubles back on itself.
 *
 * `pos` / `neg` hold the limit for each segment on its left (+normal) and
 * right side, so a tyre wall can stand a little proud of the armco.
 */
export interface Fence {
  line: Pt[];
  pos: Float32Array;
  neg: Float32Array;
}

export interface FenceContact {
  /** nearest point on the centreline */
  px: number;
  pz: number;
  /** how far the query point is from it */
  d: number;
  /** how far it is allowed to be */
  limit: number;
}

export function fenceContact(f: Fence, x: number, z: number): FenceContact {
  const line = f.line;
  const n = line.length;
  let best = Infinity;
  let px = 0;
  let pz = 0;
  let seg = 0;
  let side = 1;
  for (let i = 0; i < n; i++) {
    const a = line[i];
    const b = line[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / d2));
    const cx = a.x + dx * t;
    const cz = a.z + dz * t;
    const e = (x - cx) ** 2 + (z - cz) ** 2;
    if (e < best) {
      best = e;
      px = cx;
      pz = cz;
      seg = i;
      // left of the segment is +normal, which is (-dz, dx)
      side = (x - a.x) * -dz + (z - a.z) * dx >= 0 ? 1 : -1;
    }
  }
  return {
    px,
    pz,
    d: Math.sqrt(best),
    limit: side > 0 ? f.pos[seg] : f.neg[seg],
  };
}
