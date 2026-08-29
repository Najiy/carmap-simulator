/**
 * Three orthogonal density projections of a scan, so you can see what the
 * photogrammetry actually captured before choosing a crop box.
 *
 *   node scripts/glb-projections.cjs in.glb
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

const lo = acc.min;
const hi = acc.max;
const ramp = " .:-=+*#%@";

function project(aName, ai, bName, bi, W, H) {
  const g = new Float64Array(W * H);
  const sa = (W - 1e-6) / (hi[ai] - lo[ai]);
  const sb = (H - 1e-6) / (hi[bi] - lo[bi]);
  for (let i = 0; i < acc.count; i++) {
    const x = ((pos[i * 3 + ai] - lo[ai]) * sa) | 0;
    const y = ((pos[i * 3 + bi] - lo[bi]) * sb) | 0;
    g[y * W + x]++;
  }
  const peak = Math.max(...g);
  console.log(
    `\n${aName}${bName}  ${aName} ${lo[ai].toFixed(1)}..${hi[ai].toFixed(1)}  ` +
      `${bName} ${lo[bi].toFixed(1)}..${hi[bi].toFixed(1)}  peak ${peak | 0}`,
  );
  // column ruler in whole metres of the horizontal axis
  let ruler = "";
  for (let x = 0; x < W; x++) {
    const v = Math.round(lo[ai] + ((x + 0.5) / W) * (hi[ai] - lo[ai]));
    ruler += v % 5 === 0 ? "|" : " ";
  }
  for (let y = H - 1; y >= 0; y--) {
    let row = "";
    for (let x = 0; x < W; x++) {
      const v = g[y * W + x] / peak;
      row += ramp[Math.min(9, (Math.sqrt(v) * 10) | 0)];
    }
    console.log(row + "  " + (lo[bi] + ((y + 0.5) / H) * (hi[bi] - lo[bi])).toFixed(1));
  }
  console.log(ruler);
}

project("x", 0, "y", 1, 78, 44);
project("x", 0, "z", 2, 78, 22);
project("y", 1, "z", 2, 78, 22);
