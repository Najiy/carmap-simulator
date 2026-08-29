/**
 * Work out which way a scanned car faces, in the file's own coordinates.
 *
 * A scan has no idea it is a car — it arrives axis-agnostic, usually a few
 * degrees off whatever axis you assume. This takes the vertices sitting above
 * the ground inside the crop box and:
 *
 *   1. runs a 2D PCA on the footprint, giving the long axis of the body;
 *   2. profiles roof height along that axis to pick the front from the back —
 *      a car's cabin sits toward the rear and the bonnet is long and low.
 *
 *   node scripts/glb-heading.cjs in.glb x0 x1 y0 y1 zGround zTop
 */
const fs = require("fs");

const [, , file, ...nums] = process.argv;
const [x0, x1, y0, y1, zGround, zTop] = nums.map(Number);
if (nums.length < 6) {
  console.error(
    "usage: glb-heading.cjs <in.glb> <x0> <x1> <y0> <y1> <zGround> <zTop>",
  );
  process.exit(1);
}

const b = fs.readFileSync(file);
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

// pass 1: centroid of the body (everything above the ground, inside the box)
let n = 0;
let cx = 0;
let cy = 0;
for (let i = 0; i < acc.count; i++) {
  const x = pos[i * 3];
  const y = pos[i * 3 + 1];
  const z = pos[i * 3 + 2];
  if (x < x0 || x > x1 || y < y0 || y > y1 || z < zGround || z > zTop) continue;
  cx += x;
  cy += y;
  n++;
}
cx /= n;
cy /= n;

// pass 2: covariance of the footprint → the body's long axis
let sxx = 0;
let sxy = 0;
let syy = 0;
for (let i = 0; i < acc.count; i++) {
  const x = pos[i * 3];
  const y = pos[i * 3 + 1];
  const z = pos[i * 3 + 2];
  if (x < x0 || x > x1 || y < y0 || y > y1 || z < zGround || z > zTop) continue;
  const dx = x - cx;
  const dy = y - cy;
  sxx += dx * dx;
  sxy += dx * dy;
  syy += dy * dy;
}
sxx /= n;
sxy /= n;
syy /= n;

// principal eigenvector of a symmetric 2x2
const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
let ax = Math.cos(theta);
let ay = Math.sin(theta);

// pass 3: profile along that axis — length, width, and the height envelope
const BINS = 24;
let tMin = Infinity;
let tMax = -Infinity;
let uMin = Infinity;
let uMax = -Infinity;
for (let i = 0; i < acc.count; i++) {
  const x = pos[i * 3];
  const y = pos[i * 3 + 1];
  const z = pos[i * 3 + 2];
  if (x < x0 || x > x1 || y < y0 || y > y1 || z < zGround || z > zTop) continue;
  const t = (x - cx) * ax + (y - cy) * ay;
  const u = -(x - cx) * ay + (y - cy) * ax;
  if (t < tMin) tMin = t;
  if (t > tMax) tMax = t;
  if (u < uMin) uMin = u;
  if (u > uMax) uMax = u;
}

const hi = new Float64Array(BINS).fill(-Infinity);
const sum = new Float64Array(BINS);
const cnt = new Float64Array(BINS);
for (let i = 0; i < acc.count; i++) {
  const x = pos[i * 3];
  const y = pos[i * 3 + 1];
  const z = pos[i * 3 + 2];
  if (x < x0 || x > x1 || y < y0 || y > y1 || z < zGround || z > zTop) continue;
  const t = (x - cx) * ax + (y - cy) * ay;
  const k = Math.min(
    BINS - 1,
    Math.max(0, Math.floor(((t - tMin) / (tMax - tMin)) * BINS)),
  );
  if (z > hi[k]) hi[k] = z;
  sum[k] += z;
  cnt[k]++;
}

const len = tMax - tMin;
const wide = uMax - uMin;
console.log(`body: ${len.toFixed(2)} long x ${wide.toFixed(2)} wide (file units)`);
console.log(`centre (${cx.toFixed(2)}, ${cy.toFixed(2)}), axis (${ax.toFixed(4)}, ${ay.toFixed(4)}) = ${((theta * 180) / Math.PI).toFixed(1)}°`);
console.log(`\nroof height along the long axis (+t is axis direction):`);
const top = Math.max(...hi);
for (let k = BINS - 1; k >= 0; k--) {
  const t = tMin + ((k + 0.5) / BINS) * len;
  const h = hi[k] - zGround;
  const bar = "#".repeat(Math.max(0, Math.round((hi[k] / top) * 50)));
  console.log(`t ${t.toFixed(2).padStart(7)}  h ${h.toFixed(2).padStart(5)}  ${bar}`);
}

// the tall half is the cabin, which sits toward the rear
const half = Math.floor(BINS / 2);
const meanHi = (a, b) => {
  let s = 0;
  let c = 0;
  for (let k = a; k < b; k++)
    if (Number.isFinite(hi[k])) {
      s += hi[k];
      c++;
    }
  return s / Math.max(1, c);
};
const lowEnd = meanHi(0, half);
const highEnd = meanHi(half, BINS);
console.log(`\nmean roof: -t half ${lowEnd.toFixed(2)}, +t half ${highEnd.toFixed(2)}`);
if (highEnd > lowEnd) {
  ax = -ax;
  ay = -ay;
}
console.log(`nose points ${highEnd > lowEnd ? "-t" : "+t"}\n`);
console.log("paste into the car's model entry in src/engine/cars.ts:\n");
console.log(`      align: {
        forward: [${ax.toFixed(4)}, ${ay.toFixed(4)}, 0],
        origin: [${cx.toFixed(2)}, ${cy.toFixed(2)}, ${zGround.toFixed(2)}],
        lengthUnits: ${len.toFixed(2)},
      },`);
