/**
 * Swap the embedded texture of a gltfpack-packed GLB for a smaller one.
 *
 * gltfpack's node build can't re-encode textures, so the raw photogrammetry
 * JPEG (8192², 7 MB) survives decimation untouched. This rewrites image
 * bufferView 0 with a downscaled JPEG and shifts every meshopt block that
 * follows it in the binary chunk.
 *
 *   node scripts/glb-retexture.cjs in.glb texture.jpg out.glb
 */
const fs = require("fs");

const [, , inPath, texPath, outPath] = process.argv;
if (!inPath || !texPath || !outPath) {
  console.error("usage: glb-retexture.cjs <in.glb> <texture.jpg> <out.glb>");
  process.exit(1);
}

const align4 = (n) => (n + 3) & ~3;

const glb = fs.readFileSync(inPath);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen));
const binOff = 20 + jsonLen + 8;
const binLen = glb.readUInt32LE(20 + jsonLen);
const bin = glb.subarray(binOff, binOff + binLen);

const imgView = json.bufferViews[json.images[0].bufferView];
if (imgView.byteOffset !== 0) throw new Error("expected the image first in the buffer");

const tex = fs.readFileSync(texPath);
const oldTail = align4(imgView.byteLength);
const newTail = align4(tex.length);
const delta = newTail - oldTail;

// everything after the image is meshopt-compressed and addressed through the
// extension, not the bufferView's own byteOffset
for (const v of json.bufferViews) {
  const mo = v.extensions?.EXT_meshopt_compression;
  if (mo && mo.buffer === imgView.buffer) mo.byteOffset += delta;
}
imgView.byteLength = tex.length;
json.buffers[imgView.buffer].byteLength = bin.length + delta;

const newBin = Buffer.concat([
  tex,
  Buffer.alloc(newTail - tex.length),
  bin.subarray(oldTail),
]);

let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(align4(jsonBuf.length) - jsonBuf.length, 0x20)]);

const header = Buffer.alloc(12);
header.write("glTF", 0, "ascii");
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + newBin.length, 8);

const chunk = (len, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(len, 0);
  h.write(type, 4, "ascii");
  return h;
};

fs.writeFileSync(
  outPath,
  Buffer.concat([header, chunk(jsonBuf.length, "JSON"), jsonBuf, chunk(newBin.length, "BIN\0"), newBin]),
);

const mb = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`${inPath} ${mb(glb.length)} -> ${outPath} ${mb(fs.statSync(outPath).size)}`);
