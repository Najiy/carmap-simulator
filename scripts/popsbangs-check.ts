// Calibrate the Mk4.5 pops & bangs preset to ~450 crank hp.
(globalThis as any).window = { location: { search: "" } };

const { buildAxes } = await import("../src/engine/axes");
const { ENGINES } = await import("../src/engine/engines");
const { popsBangsMaps } = await import("../src/engine/defaults");
const { runDyno, DRIVELINE } = await import("../src/engine/dyno");
const { lookup } = await import("../src/engine/axes");

const spec = ENGINES.find((e) => e.id === "stmk45bt")!;
const axes = buildAxes(spec);
const maps = popsBangsMaps(spec, axes);

for (const wg of [240, 250, 256, 260]) {
  const run = runDyno(spec, axes, maps, wg, 0);
  console.log(
    `wg ${wg} kPa -> ${(run.peakHp.v / DRIVELINE).toFixed(0)} crank hp (${run.peakHp.v.toFixed(0)} whp), ` +
      `${(run.peakTq.v / DRIVELINE).toFixed(0)} Nm crank, knock ${run.knockEvents}, duty ${run.maxDuty.toFixed(0)}%, dmg ${run.damage.toFixed(2)}`,
  );
}

// overrun cells: what the crackle logic sees on a lift at 4000 rpm
const overrunAfr = lookup(maps.fuel, axes, 4000, 30);
const r = (await import("../src/engine/model")).simulatePoint(
  spec,
  4000,
  30,
  lookup(maps.fuel, axes, 4000, 30),
  lookup(maps.ign, axes, 4000, 30),
);
console.log(
  `overrun @4000rpm/30kPa: pw ${overrunAfr.toFixed(2)} ms -> AFR ${r.afr.toFixed(1)} (pops need < 13.4, bangs love < 11.5), spark ${lookup(maps.ign, axes, 4000, 30)}°`,
);
