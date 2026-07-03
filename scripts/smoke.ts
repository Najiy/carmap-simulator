// quick physics/grading smoke test — run with: npx tsx scripts/smoke.ts
(globalThis as any).window = { location: { search: "" } };

const { buildAxes } = await import("../src/engine/axes");
const { ENGINES } = await import("../src/engine/engines");
const { baseMaps, optimalMaps } = await import("../src/engine/defaults");
const { aiEnv, computeShiftRpm, simulateGhost, STAGE_S } = await import(
  "../src/engine/race"
);
const { EXERCISES, evaluateExercise } = await import("../src/engine/exercises");
const { runDyno } = await import("../src/engine/dyno");
const { expertMaps } = await import("../src/engine/defaults");

console.log("=== beginner path: realistic fixes should pass ===");
for (const [id, mkFix] of [
  // b1: correct the fuel (what AFR-correction converges to), leave base ign
  ["b1-rich", (spec: any, axes: any) => {
    const m = baseMaps(spec, axes);
    m.fuel = expertMaps(spec, axes).fuel;
    return m;
  }],
  // b2: same — proper fueling everywhere
  ["b2-lean", (spec: any, axes: any) => {
    const m = baseMaps(spec, axes);
    m.fuel = expertMaps(spec, axes).fuel;
    return m;
  }],
  // b3: fixed fuel AND restored/base timing
  ["b3-spark", (spec: any, axes: any) => {
    const m = baseMaps(spec, axes);
    m.fuel = expertMaps(spec, axes).fuel;
    return m;
  }],
] as const) {
  const ex = EXERCISES.find((e) => e.id === id)!;
  const spec = ENGINES.find((e) => e.id === ex.engineId)!;
  const axes = buildAxes(spec);
  const ev = evaluateExercise(ex, (mkFix as any)(spec, axes));
  console.log(`${id}: realistic fix passes = ${ev.passed}`);
  if (!ev.passed)
    for (const g of ev.goals.filter((g) => !g.pass))
      console.log(`  FAIL ${g.label} -> ${g.actual}`);
}

console.log("=== drag race ETs (same engine, three AI tunes) ===");
for (const spec of ENGINES) {
  const axes = buildAxes(spec);
  const line: string[] = [`${spec.id.padEnd(8)}`];
  for (const level of ["street", "tuner", "pro"] as const) {
    const { env, throttleFrom } = aiEnv(level, spec, axes);
    const g = simulateGhost(env, throttleFrom);
    line.push(
      `${level}: ${g.et !== null ? g.et.toFixed(2) + "s @" + g.trapKph.toFixed(0) + "km/h" : g.blown ? "BLEW UP" : "DNF"}`,
    );
  }
  console.log(line.join("  |  "));
}

console.log("\n=== player on base maps, stock boost, auto-shift ===");
{
  const spec = ENGINES[0];
  const axes = buildAxes(spec);
  const maps = baseMaps(spec, axes);
  const wg = spec.stock.boostKpa;
  const env = { spec, axes, maps, wastegateKpa: wg, shiftRpm: computeShiftRpm(spec, axes, maps, wg) };
  const g = simulateGhost(env, -STAGE_S);
  console.log(`st2006 base: ET ${g.et?.toFixed(2)}s, trap ${g.trapKph.toFixed(0)} km/h, 60ft ${g.sixtyFt?.toFixed(2)}s, blown=${g.blown}`);
}

console.log("\n=== exercise sanity: start maps should FAIL, a clean pro tune should PASS ===");
let ok = true;
for (const ex of EXERCISES) {
  const spec = ENGINES.find((e) => e.id === ex.engineId)!;
  const axes = buildAxes(spec);
  const startEval = evaluateExercise(ex, ex.start(spec, axes));
  // emulate a very good player: cleanest aggressive margin
  let proEval = evaluateExercise(ex, optimalMaps(spec, axes, 1));
  for (const m of [1.5, 2, 2.5, 3, 4]) {
    if (proEval.passed) break;
    proEval = evaluateExercise(ex, optimalMaps(spec, axes, m));
  }
  const startState = startEval.passed ? "PASSES(!!)" : "fails";
  const proState = proEval.passed ? "passes" : "FAILS(!!)";
  if (startEval.passed || !proEval.passed) ok = false;
  console.log(
    `${ex.id.padEnd(10)} start:${startState.padEnd(10)} pro:${proState.padEnd(10)}` +
      (proEval.passed ? "" : "  -> " + proEval.goals.filter((g) => !g.pass).map((g) => `${g.label} [${g.actual}]`).join("; ")),
  );
}

console.log("\n=== reference peak power per exercise ===");
for (const ex of EXERCISES) {
  const spec = ENGINES.find((e) => e.id === ex.engineId)!;
  const axes = buildAxes(spec);
  const ref = runDyno(spec, axes, optimalMaps(spec, axes), ex.wastegateKpa, 0);
  console.log(`${ex.id.padEnd(10)} ${ex.engineId.padEnd(8)} @${ex.wastegateKpa}kPa -> ${ref.peakHp.v.toFixed(0)} whp, duty ${ref.maxDuty.toFixed(0)}%, knock ${ref.knockEvents}`);
}

console.log(ok ? "\nSMOKE OK" : "\nSMOKE FAILED");
