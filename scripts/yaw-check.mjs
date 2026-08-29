// Which way does a heading become a rotation? Run: node scripts/yaw-check.mjs
//
// vehicle.ts travels along (sin h, -cos h). carModel.ts aligns every model so
// its nose is local -Z. A three.js object yawed by h maps -Z to
// R_y(h) * (0,0,-1) = (-sin h, -cos h) — mirrored. So the scene rotation for
// a heading is -h, and using +h points the car the wrong way the moment it
// turns, while still looking perfect at heading 0.
import * as THREE from "three";

const fmt = (v) => v.toArray().map((n) => n.toFixed(3)).join(", ");
const deg = (a, b) => ((a.angleTo(b) * 180) / Math.PI).toFixed(1) + " deg";
const nose = new THREE.Vector3(0, 0, -1);
let bad = false;

for (const h of [0, 0.3, 0.6, 1.2, -0.8]) {
  const physics = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  const plus = nose.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(h));
  const minus = nose.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(-h));
  console.log(`heading ${h.toFixed(2)} rad`);
  console.log(`  travel   ${fmt(physics)}`);
  console.log(`  y = +h   ${fmt(plus)}   off by ${deg(plus, physics)}`);
  console.log(`  y = -h   ${fmt(minus)}   off by ${deg(minus, physics)}`);
  if (minus.angleTo(physics) > 1e-6) bad = true;
}
console.log(bad ? "FAIL" : "\nOK — the scene rotation for a heading is -h");
process.exit(bad ? 1 : 0);
