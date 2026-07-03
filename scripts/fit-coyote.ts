// Fit the Coyote so the BASE calibration lands on the factory ratings
// (460 hp / 569 Nm crank), like every other engine in the catalog.
(globalThis as any).window = { location: { search: "" } };

const { buildAxes } = await import("../src/engine/axes");
const { ENGINES } = await import("../src/engine/engines");
const { baseMaps } = await import("../src/engine/defaults");
const { runDyno } = await import("../src/engine/dyno");

const DRIVELINE = 0.85;
const spec0 = ENGINES.find((e) => e.id === "coyote")!;

// scale VE points in the 2400–5600 band by m (torque knob), thermalEff by e
const candidates: { e: number; m: number; hp: number; nm: number; nmRpm: number; duty: number }[] = [];
for (let e = 0.54; e <= 0.64 + 1e-9; e += 0.005) {
  for (let m = 1.0; m <= 1.12 + 1e-9; m += 0.01) {
    const veCurve = spec0.veCurve.map(([rpm, v]) => [
      rpm,
      rpm >= 2400 && rpm <= 5600 ? Math.min(0.99, v * m) : v,
    ]) as [number, number][];
    const spec = { ...spec0, thermalEff: e, veCurve };
    const axes = buildAxes(spec);
    const run = runDyno(spec, axes, baseMaps(spec, axes), 100, 0);
    candidates.push({
      e: Math.round(e * 1000) / 1000,
      m: Math.round(m * 100) / 100,
      hp: run.peakHp.v / DRIVELINE,
      nm: run.peakTq.v / DRIVELINE,
      nmRpm: run.peakTq.rpm,
      duty: run.maxDuty,
    });
  }
}

candidates.sort(
  (a, b) =>
    Math.abs(a.hp - 460) / 460 + Math.abs(a.nm - 569) / 569 -
    (Math.abs(b.hp - 460) / 460 + Math.abs(b.nm - 569) / 569),
);
for (const c of candidates.slice(0, 8)) {
  console.log(
    `eff=${c.e.toFixed(3)} veMid×${c.m.toFixed(2)} -> ${c.hp.toFixed(0)} hp, ${c.nm.toFixed(0)} Nm @ ${c.nmRpm}, duty ${c.duty.toFixed(0)}%`,
  );
}
