/**
 * Locate the subject inside a photogrammetry scan.
 *
 * RealityScan exports the car together with whatever ground and scenery the
 * photos caught. Triangle density is far higher on the subject than on the
 * flat surroundings, so a coarse XY histogram of vertices finds it.
 *
 *   node scripts/glb-density.cjs in.glb [zMin] [zMax]
 *
 * Pass a z range to look at a slice: the subject separates from the ground
 * far more cleanly a few tens of centimetres up.
 */
const fs = require("fs");

const b = fs.readFileSync(process.argv[2]);
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString("utf8", 20, 20 + jsonLen));
const binOff = 20 + jsonLen + 8;

const acc = json.accessors[0];
const view = json.bufferViews[acc.bufferView];
const pos = new Float32Array(
  b.buffer,
  b.byteOffset + binOff + (view.byteOffset || 0),
  acc.count * 3,
);

const [minX, minY, minZ] = acc.min;
const [maxX, maxY, maxZ] = acc.max;
const zLo = process.argv[3] !== undefined ? +process.argv[3] : -Infinity;
const zHi = process.argv[4] !== undefined ? +process.argv[4] : Infinity;
const N = 40;
const cell = new Float64Array(N * N);
const sx = (N - 1e-6) / (maxX - minX);
const sy = (N - 1e-6) / (maxY - minY);

for (let i = 0; i < acc.count; i++) {
  const z = pos[i * 3 + 2];
  if (z < zLo || z > zHi) continue;
  const gx = ((pos[i * 3] - minX) * sx) | 0;
  const gy = ((pos[i * 3 + 1] - minY) * sy) | 0;
  cell[gy * N + gx]++;
}

const cw = (maxX - minX) / N;
const ch = (maxY - minY) / N;
const peak = Math.max(...cell);

console.log(`bbox x ${minX.toFixed(1)}..${maxX.toFixed(1)}  y ${minY.toFixed(1)}..${maxY.toFixed(1)}  z ${minZ.toFixed(1)}..${maxZ.toFixed(1)}`);
console.log(`cell ${cw.toFixed(2)} x ${ch.toFixed(2)} m, peak ${peak | 0} verts\n`);

const ramp = " .:-=+*#%@";
for (let gy = N - 1; gy >= 0; gy--) {
  let row = "";
  for (let gx = 0; gx < N; gx++) {
    const v = cell[gy * N + gx] / peak;
    row += ramp[Math.min(ramp.length - 1, (Math.sqrt(v) * ramp.length) | 0)];
  }
  console.log(row);
}

// bounding box of every cell carrying a meaningful share of the peak density
const cut = peak * 0.35;
let x0 = N, x1 = -1, y0 = N, y1 = -1;
for (let gy = 0; gy < N; gy++)
  for (let gx = 0; gx < N; gx++)
    if (cell[gy * N + gx] >= cut) {
      if (gx < x0) x0 = gx;
      if (gx > x1) x1 = gx;
      if (gy < y0) y0 = gy;
      if (gy > y1) y1 = gy;
    }

console.log(
  `\ndense region: x ${(minX + x0 * cw).toFixed(2)}..${(minX + (x1 + 1) * cw).toFixed(2)}` +
    `  y ${(minY + y0 * ch).toFixed(2)}..${(minY + (y1 + 1) * ch).toFixed(2)}`,
);
