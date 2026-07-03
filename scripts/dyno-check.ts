// What do the calibrations actually make per engine? wheel + crank estimates.
(globalThis as any).window = { location: { search: "" } };

const { buildAxes } = await import("../src/engine/axes");
const { ENGINES } = await import("../src/engine/engines");
const { baseMaps, expertMaps, optimalMaps } = await import("../src/engine/defaults");
const { runDyno } = await import("../src/engine/dyno");

const DRIVELINE = 0.85;

console.log("=== base calibration vs factory rating (crank) ===");
for (const spec of ENGINES) {
  const axes = buildAxes(spec);
  const wg = spec.turbo ? spec.stock.boostKpa : 100;
  const run = runDyno(spec, axes, baseMaps(spec, axes), wg, 0);
  const crankHp = run.peakHp.v / DRIVELINE;
  const crankNm = run.peakTq.v / DRIVELINE;
  const dHp = crankHp - spec.stock.hp;
  const dNm = crankNm - spec.stock.nm;
  console.log(
    `${spec.id.padEnd(8)} hp ${crankHp.toFixed(0).padStart(3)} vs ${String(spec.stock.hp).padStart(3)} (${dHp >= 0 ? "+" : ""}${dHp.toFixed(0)})` +
      `  |  Nm ${crankNm.toFixed(0).padStart(3)} @ ${run.peakTq.rpm} vs ${String(spec.stock.nm).padStart(3)} (${dNm >= 0 ? "+" : ""}${dNm.toFixed(0)})`,
  );
}

console.log("\n=== tunes per engine ===");
for (const spec of ENGINES) {
  const axes = buildAxes(spec);
  const wg = spec.turbo ? spec.stock.boostKpa : 100;
  const line = [spec.id.padEnd(8)];
  for (const [label, mk] of [
    ["base", baseMaps],
    ["expert", expertMaps],
    ["optimal", optimalMaps],
  ] as const) {
    const run = runDyno(spec, axes, (mk as any)(spec, axes), wg, 0);
    const whp = run.peakHp.v;
    line.push(
      `${label}: ${whp.toFixed(0)}whp/${(whp / DRIVELINE).toFixed(0)}crank`,
    );
  }
  line.push(`stock: ${spec.stock.hp}hp @ ${wg}kPa`);
  console.log(line.join("  |  "));
}
